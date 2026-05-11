// content/tiktok-injector.js
// Injects multi-window ROAS pills into TikTok Ads Manager rows.
//
// === FACEBOOK / TIKTOK ACCOUNT SAFETY ===
// Same read-only contract as content/meta-injector.js. Specifically:
//
//   READ-ONLY of TikTok DOM:
//     ✓ querySelector + textContent
//     ✗ NEVER reads cookies, localStorage, sessionStorage, IndexedDB
//     ✗ NEVER reads auth tokens or DOM input values
//
//   NO MUTATION of TikTok-owned elements:
//     ✓ Pills inserted as SIBLINGS via insertBefore — never inside a
//       TikTok-managed container, never as replacement of a TikTok node.
//     ✗ NEVER sets attributes (class, style, dataset, aria-*) on any element
//       TikTok rendered. Decoration tracking lives in a JS WeakMap so the
//       DOM observed by TikTok's React reconciler is unmodified.
//     ✗ NEVER calls .click(), .focus(), .dispatchEvent(), .submit().
//
//   NO NETWORK to tiktok.com:
//     ✗ NEVER calls fetch / XMLHttpRequest to any tiktok.com host. The
//       extension's manifest host_permissions only includes adjust.com.
//
// === HOW TIKTOK DIFFERS FROM META ===
// 1. No row DOM container: TikTok's `<ks-virtual-table>` renders cells
//    directly without a row wrapper. We cannot walk-up to a "row" node.
// 2. The cell's own React props carry the row's full id (campaign_id /
//    adgroup_id / ad_id), so id resolution is a single leaf-cell scan via
//    the page-world bridge — no row subtree walk, no Y-bucket join.
// 3. URL has no `?selected_campaign_ids=` parameter; the tab's URL pathname
//    is the only scope signal (`/manage/campaign` vs `/adgroup` vs
//    `/creative`).
// 4. No Meta-style preload tree to parse — we rely entirely on the bridge.
//
// === STRATEGIES (much simpler than Meta) ===
//   1. Direct match by name in the per-tab index. If unique → done.
//   2. Bridge id match: read the cell's id from the bridge's hit table and
//      resolve via byId index. Works regardless of column visibility.
//   3. Otherwise show ambiguous aggregate.

(function () {
  'use strict';

  const INJECTOR_VERSION = 'v0.3.5-tt-today-pill-width-cache-fix';
  // Styled prefix so it's findable in TikTok's verbose console — filter by
  // "AOX-TT" or "Adjust Overlay" to surface every log this injector emits.
  console.log(
    `%c[AOX-TT ${INJECTOR_VERSION}]%c tiktok-injector loaded`,
    'background:#0066ff;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
    'color:#0066ff;font-weight:bold'
  );

  // ---- Embedded matcher (kept in sync with src/matcher.js + meta-injector) ----
  const WHITESPACE_VARIANTS = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g;
  const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060]/g;
  const DASH_VARIANTS = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;

  function canonicalKey(raw) {
    if (typeof raw !== 'string') return '';
    return raw
      .normalize('NFC')
      .replace(ZERO_WIDTH, '')
      .replace(WHITESPACE_VARIANTS, ' ')
      .replace(DASH_VARIANTS, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // Primary selector matches the unstyled link wrapper TikTok renders for the
  // clickable row-name cell. Falls back to broader `KsLink` matches if the
  // primary returns nothing — TikTok library upgrades sometimes drop the
  // `--inherit` modifier and we'd rather match too much (filtered later by
  // text-length + index lookup) than miss legitimate rows entirely.
  const NAME_CANDIDATE_SELECTOR_PRIMARY = '[class*="KsLink--inherit"]';
  const NAME_CANDIDATE_SELECTOR_FALLBACK = '[class*="KsLink"]';
  function pickNameCandidates() {
    const primary = document.querySelectorAll(NAME_CANDIDATE_SELECTOR_PRIMARY);
    if (primary.length > 0) return primary;
    return document.querySelectorAll(NAME_CANDIDATE_SELECTOR_FALLBACK);
  }

  // Network filter — matches the `channel` field Adjust returns for TikTok
  // rows ("TikTok for Business"). Anything not matching this is a different
  // network's data and must be ignored on TikTok pages.
  const TIKTOK_NETWORK_PREFIX = 'TikTok';

  let campaignIndex = new Map();
  let adsetIndex = new Map();
  let adIndex = new Map();
  let adsetCompositeIndex = new Map();
  let adCompositeIndex = new Map();
  let adByIdIndex = new Map();
  let adsetByIdIndex = new Map();
  let campByIdIndex = new Map();
  let lastSyncAt = null;
  let sourceLabel = '';

  // Color thresholds — overridable per-platform from popup Settings. Defaults
  // mirror what the popup writes when the user hasn't customized yet.
  let colorThresholds = { pause: 0.30, red: 0.60, green: 1.00 };

  let bodyObserver = null;
  let decorateTimer = null;
  const decoratedKey = new WeakMap();
  // TikTok cells live inside `cl-w-full cl-overflow-hidden` ancestors that
  // clip any sibling content rendered next to the name. We render pills as
  // position:fixed children of <body> instead and reposition them on scroll
  // so they float above the row without being clipped. Map cell → pill so
  // we can update or remove each on virtualization / scroll.
  const cellToPill = new Map();

  let lastDecorateStats = {
    candidates: 0,
    matched: 0,
    resolvedByName: 0,
    resolvedByBridgeId: 0,
    stillAmbiguous: 0,
  };

  // Today-pill stats for the last decorate pass. Read by buildBannerText
  // (banner warn lines) and logDomDiagnostics (console). Reset at the top of
  // every decorate pass via createEmptyTodayStats so the shape stays in sync
  // between initial value and reset; adding a field in one place but not the
  // other previously caused `sampleRowCandidates` to silently disappear after
  // the first decorate pass.
  function createEmptyTodayStats() {
    return {
      columnFound: false, columnHeaderText: null, columnX: null,
      pillsRendered: 0, pillsRenderedOffDate: 0,
      skippedNoCostCell: 0, skippedCurrencyMismatch: 0,
      skippedAmbiguous: 0, skippedAbbreviated: 0, skippedOffDate: 0,
      sampleSpend: null, sampleRevToday: null,
      detectedTikTokCurrency: null, adjustCurrencyExample: null,
      sampleRowCandidates: null,
      ttDateIsToday: null, ttDateLabel: null, ttDateSource: null,
    };
  }
  let lastTodayStats = createEmptyTodayStats();

  // CSS class names for the three today-pill variants. Defined once so the
  // strings can't drift between the render branches and the dedup cleanup
  // sweep in decorateCandidate / maybeRenderTodayPill.
  const TODAY_PILL_CLASS_NORMAL   = 'adjust-pill adjust-pill-today';
  const TODAY_PILL_CLASS_OFFDATE  = 'adjust-pill adjust-pill-today-offdate';
  const TODAY_PILL_CLASS_MISMATCH = 'adjust-pill adjust-pill-today-mismatch';
  // Per-pass caches populated at the start of decorateAllVisibleRows.
  let currentCostColumn = null;
  let currentTikTokDate = null;
  let rowYBuckets = null;
  // Today pill is a SEPARATE position:fixed pill rendered to the right of the
  // main pill, tracked in its own Map so the rAF reposition loop can move
  // both together when the row scrolls. Lifecycle: created/refreshed by
  // maybeRenderTodayPill, removed when the main pill is removed (cell
  // disconnects or virtualizes).
  const cellToTodayPill = new Map();
  const decoratedTodayKey = new WeakMap();

  // ---- Bridge integration ----
  let bridgeScanToken = 0;
  let bridgeIndex = null;
  let bridgeIndexToken = -1;

  function dispatchBridgeKnownIds() {
    document.dispatchEvent(new CustomEvent('aox-tt-set-known-ids', {
      detail: {
        adIds: [...adByIdIndex.keys()],
        adsetIds: [...adsetByIdIndex.keys()],
        campIds: [...campByIdIndex.keys()],
      },
    }));
  }

  function dispatchBridgeScan() {
    document.dispatchEvent(new CustomEvent('aox-tt-scan-rows'));
    bridgeScanToken++;
  }

  function parseBridgeData() {
    const node = document.getElementById('aox-tt-bridge-data');
    if (!node) return null;
    let payload;
    try { payload = JSON.parse(node.textContent || '{}'); } catch { return null; }
    const out = new Map();
    const results = Array.isArray(payload?.results) ? payload.results : [];
    for (const r of results) {
      if (!r?.t) continue;
      out.set(`${r.t}|${r.y}`, r);
    }
    return out;
  }

  function lookupBridgeRowHit(nameEl) {
    if (bridgeIndexToken !== bridgeScanToken) {
      bridgeIndex = parseBridgeData();
      bridgeIndexToken = bridgeScanToken;
    }
    if (!bridgeIndex || bridgeIndex.size === 0) return null;
    const text = (nameEl.textContent || '').trim();
    if (!text) return null;
    const rect = nameEl.getBoundingClientRect();
    const y = Math.round((rect.top + rect.bottom) / 2);
    for (let dy = -1; dy <= 1; dy++) {
      const k = `${text}|${y + dy}`;
      const hit = bridgeIndex.get(k);
      if (hit) return hit;
    }
    return null;
  }

  // ---- Tab detection from URL pathname ----
  // /i18n/manage/campaign  → Campaigns tab → match against campaignIndex
  // /i18n/manage/adgroup   → Ad groups tab → match against adsetIndex
  // /i18n/manage/creative  → Ads tab       → match against adIndex
  function getCurrentTab() {
    const path = window.location.pathname;
    if (path.includes('/manage/creative')) return 'ad';
    if (path.includes('/manage/adgroup')) return 'adset';
    if (path.includes('/manage/campaign')) return 'campaign';
    return null;
  }

  // Thin wrapper: shared/fetchColorThresholds is pure (returns new object);
  // we own the local `colorThresholds` variable, so we assign the result here.
  async function loadColorThresholds() {
    colorThresholds = await fetchColorThresholds('tiktok', colorThresholds);
  }

  // ---- Sync data from background ----
  async function loadData() {
    try {
      const cached = await chrome.runtime.sendMessage({ type: 'GET_CACHED' });
      if (cached?.error) {
        showBanner(`Data load error: ${cached.error}`, 'error');
        return;
      }
      if (!cached) {
        showBanner('No Adjust data yet. Click extension icon → Sync.', 'warn');
        return;
      }

      // Filter to TikTok network rows only — Adjust returns Meta + TikTok in
      // one fetch, and we don't want Meta names polluting TikTok indexes.
      const allRows = (cached.campaigns || []);
      const tiktokRows = allRows.filter(r => (r.network || '').startsWith(TIKTOK_NETWORK_PREFIX));
      const campaignRows = tiktokRows.filter(r => r.level === 'campaign');
      const adRows = tiktokRows.filter(r => r.level === 'ad');

      campaignIndex = buildDirectIndex(campaignRows, r => r.campaignName);
      campByIdIndex = buildIdIndex(campaignRows, r => r.campaignId, r => r.campaignName);

      const adsetBuilt = buildAggregatedIndex(adRows, r => r.adsetName, r => r.adsetId);
      adsetIndex = adsetBuilt.byName;
      adsetCompositeIndex = adsetBuilt.byComposite;
      adsetByIdIndex = adsetBuilt.byId;

      const adBuilt = buildAdIndex(adRows);
      adIndex = adBuilt.byName;
      adCompositeIndex = adBuilt.byComposite;
      adByIdIndex = adBuilt.byAdId;

      lastSyncAt = cached.lastSyncAt;
      sourceLabel = cached.sourceLabel;

      // Post-build: attach revenueToday + adjustCurrency onto each index
      // entry by summing the per-row `revenueToday` field that data-source.js
      // merged in. Kept as a separate pass so we never modify the signatures
      // of the existing index builders — diff stays additive.
      attachTodayMetrics(campaignRows, adRows);

      dispatchBridgeKnownIds();

      showBanner(buildBannerText(), cached.isStale ? 'warn' : 'ok');
      removeAllPills();
      ensureObserving();
      decorateAllVisibleRows();
      logDomDiagnostics();
    } catch (err) {
      console.warn('[Adjust Overlay TT] loadData failed:', err.message);
    }
  }

  function buildDirectIndex(rows, getName) {
    const out = new Map();
    for (const row of rows) {
      const name = getName(row);
      if (!name) continue;
      out.set(canonicalKey(name), {
        campaignName: name,
        network: row.network,
        rowCount: 1,
        cost: row.cost,
        installs: row.installs,
        roas: row.roas,
      });
    }
    return out;
  }

  function buildIdIndex(rows, getId, getName) {
    const out = new Map();
    for (const row of rows) {
      const id = getId(row);
      if (!id) continue;
      out.set(String(id), {
        campaignName: getName(row),
        network: row.network,
        rowCount: 1,
        cost: row.cost,
        installs: row.installs,
        roas: row.roas,
      });
    }
    return out;
  }

  function buildAdIndex(adRows) {
    const byName = new Map();
    const byComposite = new Map();
    const byAdId = new Map();
    const collisions = new Set();
    const accums = new Map();

    for (const row of adRows) {
      if (!row.adName) continue;
      const k = canonicalKey(row.adName);
      const single = {
        campaignName: row.adName,
        network: row.network,
        rowCount: 1,
        cost: row.cost,
        installs: row.installs,
        roas: row.roas,
        parentCampaignName: row.campaignName,
        parentAdsetName: row.adsetName,
        campaignId: row.campaignId,
        adsetId: row.adsetId || null,
        adId: row.adId || null,
      };

      if (row.campaignId) byComposite.set(`${row.campaignId}::${k}`, single);
      if (row.adId) byAdId.set(String(row.adId), single);

      if (!byName.has(k)) {
        byName.set(k, single);
        accums.set(k, [row]);
      } else {
        collisions.add(k);
        accums.get(k).push(row);
      }
    }

    for (const k of collisions) {
      const rows = accums.get(k);
      const agg = aggregateRoas(rows);
      byName.set(k, {
        ambiguous: true,
        candidates: rows,
        campaignName: rows[0].adName,
        rowCount: rows.length,
        ...agg,
      });
    }

    return { byName, byComposite, byAdId };
  }

  function buildAggregatedIndex(rows, getName, getId) {
    const byName = new Map();
    const byComposite = new Map();
    const byId = new Map();
    const composites = new Map();
    const flats = new Map();
    const idGroups = new Map();

    for (const row of rows) {
      const name = getName(row);
      if (!name) continue;
      const k = canonicalKey(name);
      if (!flats.has(k)) flats.set(k, []);
      flats.get(k).push(row);
      if (row.campaignId) {
        const ck = `${row.campaignId}::${k}`;
        if (!composites.has(ck)) composites.set(ck, []);
        composites.get(ck).push(row);
      }
      if (getId) {
        const id = getId(row);
        if (id) {
          const sid = String(id);
          if (!idGroups.has(sid)) idGroups.set(sid, []);
          idGroups.get(sid).push(row);
        }
      }
    }

    for (const [ck, rs] of composites) {
      byComposite.set(ck, {
        campaignName: getName(rs[0]),
        network: rs[0].network,
        rowCount: rs.length,
        ...aggregateRoas(rs),
      });
    }

    for (const [sid, rs] of idGroups) {
      byId.set(sid, {
        campaignName: getName(rs[0]),
        network: rs[0].network,
        rowCount: rs.length,
        ...aggregateRoas(rs),
      });
    }

    for (const [k, rs] of flats) {
      const distinctCampaigns = new Set(rs.map(r => r.campaignId).filter(Boolean));
      const ambiguous = distinctCampaigns.size > 1;
      const entry = {
        campaignName: getName(rs[0]),
        network: rs[0].network,
        rowCount: rs.length,
        ...aggregateRoas(rs),
      };
      if (ambiguous) {
        entry.ambiguous = true;
        entry.candidates = rs;
      }
      byName.set(k, entry);
    }

    return { byName, byComposite, byId };
  }

  function aggregateRoas(rows) {
    let cost = 0, installs = 0, cohortAllRev = 0;
    let r0 = 0, c0 = 0, r3 = 0, c3 = 0, r7 = 0, c7 = 0;
    for (const row of rows) {
      const rc = row.cost || 0;
      cost += rc;
      installs += row.installs || 0;
      cohortAllRev += row.cohortAllRevenue || 0;
      const r = row.roas || {};
      if (r.d0 != null) { r0 += r.d0 * rc; c0 += rc; }
      if (r.d3 != null) { r3 += r.d3 * rc; c3 += rc; }
      if (r.d7 != null) { r7 += r.d7 * rc; c7 += rc; }
    }
    return {
      cost,
      installs,
      roas: {
        d0: c0 > 0 ? r0 / c0 : null,
        d3: c3 > 0 ? r3 / c3 : null,
        d7: c7 > 0 ? r7 / c7 : null,
        allTime: cost > 0 ? cohortAllRev / cost : null,
      },
    };
  }

  // ============================================================
  // Today pill — TikTok UI cost × Adjust today revenue
  // ============================================================
  //
  // Mirrors meta-injector.js's Today pill. Numerator: Adjust today event-date
  // revenue (`revenue + ad_revenue`). Denominator: the row's "Cost" cell read
  // directly from TikTok Ads Manager. The existing D0/3d/7d/All pill is
  // untouched.
  //
  // TikTok-specific quirks vs Meta:
  //   - TikTok renders inside <ks-virtual-table> which clips siblings, so the
  //     main pill is already position:fixed (cellToPill Map). The today pill
  //     must follow the same pattern with its own cellToTodayPill Map; the
  //     rAF reposition loop moves both together when the row scrolls.
  //   - Date filter URL format is `?st=YYYY-MM-DD&et=YYYY-MM-DD` with no
  //     preset keyword (unlike Meta's `date_preset=today` or `,today` suffix).

  // Header text TikTok uses for the Cost column across locales. Keys are
  // canonicalKey'd at construction. Failure is graceful (column-missing
  // banner) rather than silent miscoluming.
  const TIKTOK_COST_HEADER_KEYS = new Set([
    canonicalKey('Cost'),
    canonicalKey('Chi phí'),
    canonicalKey('Costo'),
    canonicalKey('Coût'),
    canonicalKey('Kosten'),
    canonicalKey('Custo'),
    canonicalKey('费用'),
    canonicalKey('費用'),
    canonicalKey('비용'),
  ]);

  // Currencies with no fractional unit. Symbol detection uses these to decide
  // whether trailing `.` / `,` is decimal or thousands grouping.
  const ZERO_DECIMAL_CURRENCIES = new Set(['VND', 'JPY', 'KRW', 'IDR', 'CLP']);

  // Currency symbol → ISO code. Used when the cell carries only a symbol.
  const SYMBOL_TO_ISO = {
    '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₫': 'VND',
    '₹': 'INR', '₩': 'KRW', '฿': 'THB', '₱': 'PHP', '₪': 'ILS',
    '₺': 'TRY', '₽': 'RUB',
  };

  // Skip-tag list for full-DOM leaf scans. SCRIPT/STYLE leaves carry source
  // text that never renders; SVG-internal nodes have rects but never display
  // row data.
  const HEADER_SCAN_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
    'META', 'LINK', 'TITLE', 'HEAD',
    'SVG', 'PATH', 'CIRCLE', 'RECT', 'POLYGON', 'G', 'DEFS', 'USE',
  ]);

  // Bucket index granularity for row Y-coordinate lookup. Small enough that a
  // typical row only spans 1–2 buckets, large enough that lookups stay O(1).
  const ROW_BUCKET_PX = 8;

  // Aggregate revenueToday + adjustCurrency from the merged rows onto each
  // index entry that decorate-time lookups will return. Mirrors how each
  // index keys its rows in buildDirectIndex / buildAdIndex /
  // buildAggregatedIndex, so the same rows route to the same entries — no
  // re-indexing.
  //
  // CRITICAL: buildAdIndex shares the SAME entry object across byName /
  // byComposite / byAdId for non-collision ads. Naive multi-index bumping
  // would triple-count the same row's revenue onto the same object. We guard
  // with a per-row `visited` WeakSet so each unique entry is bumped at most
  // once per row.
  function attachTodayMetrics(campaignRows, adRows) {
    for (const r of campaignRows) {
      if (!r.campaignName) continue;
      const visited = new WeakSet();
      bumpToday(campaignIndex, canonicalKey(r.campaignName), r, visited);
      if (r.campaignId) bumpToday(campByIdIndex, String(r.campaignId), r, visited);
    }
    for (const r of adRows) {
      const visited = new WeakSet();
      if (r.adsetName) {
        const ak = canonicalKey(r.adsetName);
        bumpToday(adsetIndex, ak, r, visited);
        if (r.campaignId) bumpToday(adsetCompositeIndex, `${r.campaignId}::${ak}`, r, visited);
        if (r.adsetId) bumpToday(adsetByIdIndex, String(r.adsetId), r, visited);
      }
      if (r.adName) {
        const ak = canonicalKey(r.adName);
        bumpToday(adIndex, ak, r, visited);
        if (r.campaignId) bumpToday(adCompositeIndex, `${r.campaignId}::${ak}`, r, visited);
        if (r.adId) bumpToday(adByIdIndex, String(r.adId), r, visited);
      }
    }
  }

  function bumpToday(idx, key, row, visited) {
    const e = idx.get(key);
    if (!e) return;
    if (visited.has(e)) return;
    visited.add(e);
    e.revenueToday = (e.revenueToday || 0) + (row.revenueToday || 0);
    if (!e.adjustCurrency && row.adjustCurrency) e.adjustCurrency = row.adjustCurrency;
    e.todayRowExisted = e.todayRowExisted || !!row.todayRowExisted;
  }

  // Locate the TikTok "Cost" header cell once per decorate pass. Returns
  // { headerEl, headerX, headerLeft, headerRight, headerWidth, headerText }
  // on success, null otherwise. The header X mid-pixel is the column anchor
  // used to find each row's cost cell by nearest-X within shared row Y.
  //
  // We deliberately match on header TEXT rather than column index because
  // TikTok's <ks-virtual-table> renders cells without a stable row-wrapper
  // node, so child-indexed walks across the table are brittle. Same scan
  // pattern Meta uses (full leaf walk minus skip tags).
  function locateCostColumn() {
    // Two anti-decoys at work here:
    //  (1) Scope the scan to <ks-virtual-table> — TikTok's left nav and top
    //      toolbar carry text leaves that match our cost-header keys.
    //  (2) Even inside the table, custom-column popovers and frozen left
    //      columns can hold a "Cost" label that wins on Y alone. We score
    //      candidates by currency-cells-below-X (step 2) instead of trusting
    //      Y order.
    const tableScope = document.querySelector('ks-virtual-table')
      || document.querySelector('[class*="ks-table"]')
      || document.body;

    // Step 1: gather every header-text candidate within scope.
    const candidates = [];
    for (const el of tableScope.querySelectorAll('*')) {
      if (HEADER_SCAN_SKIP_TAGS.has(el.tagName)) continue;
      if (el.children.length > 0) continue; // leaf only
      const raw = el.textContent || '';
      if (!raw || raw.length > 60) continue;
      const k = canonicalKey(raw);
      let matched = TIKTOK_COST_HEADER_KEYS.has(k);
      if (!matched && raw.match(/[.…]+$/)) {
        // Header may be truncated at narrow column widths ("Cos…").
        const prefix = k.replace(/[.…\s]+$/, '');
        if (prefix.length >= 3) {
          for (const hk of TIKTOK_COST_HEADER_KEYS) {
            if (hk.startsWith(prefix)) { matched = true; break; }
          }
        }
      }
      if (!matched) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.top < 0) continue;
      candidates.push({ el, rect: r });
    }
    if (candidates.length === 0) return null;

    // Step 2: pick the candidate that anchors a real data column. The real
    // Cost header has currency-looking cells stacked vertically under it
    // (one per row); spurious "Cost" leaves elsewhere have none. Score each
    // candidate by counting currency leaves below it at the same X (±60px).
    // Single pre-pass over all currency leaves keeps this O(leaves + cands).
    let winner;
    if (candidates.length === 1) {
      winner = candidates[0];
    } else {
      const currencyLeaves = [];
      for (const el of tableScope.querySelectorAll('*')) {
        if (HEADER_SCAN_SKIP_TAGS.has(el.tagName)) continue;
        if (el.children.length > 0) continue;
        const txt = (el.textContent || '').trim();
        if (!txt) continue;
        if (!looksLikeCurrency(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        currencyLeaves.push({ midX: (r.left + r.right) / 2, top: r.top });
      }
      let bestScore = -1;
      for (const cand of candidates) {
        const candX = (cand.rect.left + cand.rect.right) / 2;
        const candBottom = cand.rect.bottom;
        let score = 0;
        for (const lf of currencyLeaves) {
          if (lf.top < candBottom) continue;
          if (Math.abs(lf.midX - candX) > 60) continue;
          score++;
        }
        // Higher score wins; tie-break by topmost (the actual header row
        // sits at the table top while frozen-column duplicates can render
        // farther down).
        if (score > bestScore
            || (score === bestScore && winner && cand.rect.top < winner.rect.top)) {
          bestScore = score;
          winner = cand;
        }
      }
      if (!winner) winner = candidates[0];
    }

    // Step 3: walk up from the text leaf to find the column header CELL
    // container — header text may be left-aligned in a wider cell while
    // data cells in the same column are right-aligned numbers. The cell
    // container's X range is what matters for matching data cells.
    const bestHeader = winner.el;
    let cellAncestor = bestHeader;
    let cellRect = winner.rect;
    let node = bestHeader.parentElement;
    for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.height > 80) break;
      if (r.width > 400) break;
      if (r.width > cellRect.width) {
        cellAncestor = node;
        cellRect = r;
      }
    }
    return {
      headerX: (cellRect.left + cellRect.right) / 2,
      headerText: (bestHeader.textContent || '').trim().slice(0, 40),
    };
  }

  // Lazily build (and cache for the current decorate pass) a bucketed index
  // of every visible-text leaf within the data table, keyed by rounded Y
  // midpoint. Scope mirrors locateCostColumn — leaves outside the table
  // (left-nav, top-toolbar, banner, the today pills we just rendered) would
  // pollute the buckets and make findCostCellText pick currency-looking text
  // from unrelated UI chrome that happens to share a row's Y.
  function ensureRowYBuckets() {
    if (rowYBuckets) return rowYBuckets;
    rowYBuckets = new Map();
    const tableScope = document.querySelector('ks-virtual-table')
      || document.querySelector('[class*="ks-table"]')
      || document.body;
    for (const el of tableScope.querySelectorAll('*')) {
      if (HEADER_SCAN_SKIP_TAGS.has(el.tagName)) continue;
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 300) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const mid = (r.top + r.bottom) / 2;
      const k = Math.round(mid / ROW_BUCKET_PX);
      let bucket = rowYBuckets.get(k);
      if (!bucket) { bucket = []; rowYBuckets.set(k, bucket); }
      bucket.push(el);
    }
    return rowYBuckets;
  }

  // Vertical range of the row that contains `nameEl`. nameEl is the <KsLink>
  // wrapping the campaign-name text only — its bounding box ≈ name line
  // height (~16-20px), much shorter than the full row (~40-60px once the
  // budget / delivery sub-line is included). Cost-column cells are
  // vertical-aligned to the full row, so their Y midpoint lands outside
  // nameEl's own range. The column ancestor's rect spans the full row
  // height (one cell per row in a column), giving a Y range that catches
  // any column's cell on this row.
  function getRowYRange(nameEl) {
    const column = getColumnAncestor(nameEl);
    const r = (column || nameEl).getBoundingClientRect();
    return { top: r.top - 2, bottom: r.bottom + 2 };
  }

  // Read this row's cost cell text. Strategy: among same-row Y-bucket cells
  // whose text passes the currency filter, pick the one whose X mid is
  // nearest to the Cost-column header's X. No threshold — the closest
  // currency cell to the column header IS the cost cell by definition.
  function findCostCellText(nameEl) {
    if (!currentCostColumn) return null;
    const rowRange = getRowYRange(nameEl);
    const buckets = ensureRowYBuckets();
    const rowMid = (rowRange.top + rowRange.bottom) / 2;
    const rowMidKey = Math.round(rowMid / ROW_BUCKET_PX);
    const halfHeight = (rowRange.bottom - rowRange.top) / 2;
    const bucketSpan = Math.max(1, Math.ceil(halfHeight / ROW_BUCKET_PX));
    const headerX = currentCostColumn.headerX;

    let best = null;
    let bestDist = Infinity;
    const candidatesForDiag = [];
    for (let dk = -bucketSpan; dk <= bucketSpan; dk++) {
      const bucket = buckets.get(rowMidKey + dk);
      if (!bucket) continue;
      for (const el of bucket) {
        if (el === nameEl) continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0 || r.width === 0) continue;
        const mid = (r.top + r.bottom) / 2;
        if (mid < rowRange.top || mid > rowRange.bottom) continue;
        const txt = (el.textContent || '').trim();
        if (!txt) continue;
        if (!looksLikeCurrency(txt)) continue;
        const cellMidX = (r.left + r.right) / 2;
        const dist = Math.abs(cellMidX - headerX);
        // Capture first row's same-row currency candidates so diagnostics can
        // dump them. Helps diagnose "cost never reads" without DOM probing.
        if (lastTodayStats.sampleRowCandidates == null) {
          candidatesForDiag.push({ x: Math.round(cellMidX), text: txt.slice(0, 30), dist: Math.round(dist) });
        }
        if (dist < bestDist) { best = txt; bestDist = dist; }
      }
    }
    if (lastTodayStats.sampleRowCandidates == null && candidatesForDiag.length > 0) {
      lastTodayStats.sampleRowCandidates = candidatesForDiag.sort((a, b) => a.x - b.x).slice(0, 12);
    }
    return best;
  }

  // Plausibility test: does this cell text look like a money value? Loose by
  // design — final parsing happens in parseCurrencyCell. CRITICAL: the
  // leading-char gate rejects labelled subtext like "Starting daily budget:
  // 250.00 USD" (TikTok's budget tooltip renders next to the cost column).
  // Without the gate, that tooltip can be picked as a cost cell. Real cost
  // cells start with sign / paren / digit / symbol, or an ISO prefix.
  function looksLikeCurrency(txt) {
    if (/^[–—-]$/.test(txt)) return true;
    if (!/\d/.test(txt)) return false;
    if (/%$/.test(txt)) return false;
    if (!/^\s*(?:[A-Z]{2,3}\s+)?[(\-−\d\$€£¥₫₹₩฿₱₪₺₽]/.test(txt)) return false;
    if (/[\$€£¥₫₹₩฿₱₪₺₽]/.test(txt)) return true;
    if (/\b(USD|EUR|GBP|JPY|VND|INR|KRW|THB|PHP|ILS|TRY|RUB|AUD|CAD|MXN|BRL|CHF|SEK|NOK|DKK|PLN|TWD|HKD|SGD|MYR|IDR|CNY|NZD)\b/i.test(txt)) return true;
    if (/\d[.,]\d/.test(txt) && txt.length >= 4) return true;
    return false;
  }

  // Parse a TikTok UI currency cell. Returns { value, currency, parsed }:
  //   value    — number or null when unparseable.
  //   currency — best-effort ISO 3-letter code, or null.
  //   parsed   — false for abbreviations (e.g. "$1.2K"), empty/dash cells.
  // See meta-injector.parseCurrencyCell for full format-support notes.
  function parseCurrencyCell(text) {
    if (!text) return { value: null, currency: null, parsed: false };
    const trimmed = text.trim();
    if (!trimmed || /^[–—-]$/.test(trimmed)) {
      return { value: null, currency: null, parsed: false };
    }
    if (/\d[\s]?[KMB]\b/i.test(trimmed)) {
      return { value: null, currency: null, parsed: false, abbreviated: true };
    }
    if (/[٠-٩۰-۹०-९]/.test(trimmed)) {
      return { value: null, currency: null, parsed: false };
    }

    let currency = null;
    for (const ch of trimmed) {
      if (SYMBOL_TO_ISO[ch]) { currency = SYMBOL_TO_ISO[ch]; break; }
    }
    if (!currency) {
      const iso = trimmed.match(/\b([A-Z]{3})\b/);
      if (iso) currency = iso[1];
    }

    let negative = false;
    let cleaned = trimmed;
    if (/^\(.*\)$/.test(cleaned)) { negative = true; cleaned = cleaned.slice(1, -1); }
    if (/^[-−]/.test(cleaned)) { negative = true; cleaned = cleaned.replace(/^[-−]/, ''); }

    cleaned = cleaned
      .replace(/[\$€£¥₫₹₩฿₱₪₺₽]/g, '')
      .replace(/\b[A-Z]{3}\b/g, '')
      .replace(/[   \s]/g, '')
      .trim();

    if (!/^[\d.,]+$/.test(cleaned)) {
      return { value: null, currency, parsed: false };
    }

    const isZeroDecimal = currency && ZERO_DECIMAL_CURRENCIES.has(currency);
    let numericStr;
    if (isZeroDecimal) {
      numericStr = cleaned.replace(/[.,]/g, '');
    } else {
      const lastDot = cleaned.lastIndexOf('.');
      const lastComma = cleaned.lastIndexOf(',');
      const lastSep = Math.max(lastDot, lastComma);
      const fractionLen = lastSep >= 0 ? cleaned.length - lastSep - 1 : -1;
      if (lastSep >= 0 && fractionLen >= 1 && fractionLen <= 2) {
        const intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, '');
        const fracPart = cleaned.slice(lastSep + 1);
        numericStr = `${intPart}.${fracPart}`;
      } else {
        numericStr = cleaned.replace(/[.,]/g, '');
      }
    }

    const value = parseFloat(numericStr);
    if (!Number.isFinite(value)) return { value: null, currency, parsed: false };
    return { value: negative ? -value : value, currency, parsed: true };
  }

  // Detect whether TikTok UI's date filter is set to "Today". TikTok exposes
  // the active range via `?st=YYYY-MM-DD&et=YYYY-MM-DD` with no preset
  // keyword (unlike Meta's `date_preset` / `,today` suffix). When both equal
  // browser-local today → isToday=true. When absent → isToday=false (don't
  // silently divide by an unknown range's spend).
  //
  // Returns: { isToday: bool, label: string, source: 'range'|'absent'|'error' }
  function detectTikTokDateInfo() {
    try {
      const params = new URLSearchParams(window.location.search);
      const st = params.get('st');
      const et = params.get('et');
      if (!st && !et) {
        return { isToday: false, label: 'unknown', source: 'absent' };
      }
      if (st && et && /^\d{4}-\d{2}-\d{2}$/.test(st) && /^\d{4}-\d{2}-\d{2}$/.test(et)) {
        const today = todayLocalIsoDate();
        if (st === today && et === today) {
          return { isToday: true, label: 'today', source: 'range' };
        }
        const label = st === et ? st : `${st}…${et}`;
        return { isToday: false, label, source: 'range' };
      }
      return { isToday: false, label: `${st || '?'}…${et || '?'}`, source: 'range' };
    } catch {
      return { isToday: false, label: 'unknown', source: 'error' };
    }
  }

  function formatMoneyOrDash(n) {
    if (n == null || !Number.isFinite(n)) return '–';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatTodayTooltip(rev, spend, displayCcy, adjCcy, data) {
    const ageMin = lastSyncAt ? Math.round((Date.now() - lastSyncAt) / 60000) : null;
    const lines = [
      `Today realtime ROAS`,
      `Rev (Adjust today${adjCcy ? `, ${adjCcy}` : ''}): ${formatMoneyOrDash(rev)}`,
      `Spend (TikTok UI${displayCcy ? `, ${displayCcy}` : ''}): ${formatMoneyOrDash(spend)}`,
    ];
    if (ageMin != null) lines.push(`Adjust sync age: ${ageMin}m`);
    if (!data.todayRowExisted) {
      lines.push(`Note: no cohort data for this row (new today?)`);
    }
    return lines.join('\n');
  }

  // Build (or refresh) the today pill for this row. ALWAYS renders when the
  // cost column is found and the row is not ambiguous — even when rev or
  // spend is missing/zero, the pill shows `Today: rev/spend` so the user can
  // SEE pipeline state instead of guessing why nothing appeared. Skip paths
  // bump counters but never throw.
  function maybeRenderTodayPill(nameEl, mainPill, data, mainKey) {
    if (!data || data.ambiguous) { lastTodayStats.skippedAmbiguous++; return; }
    if (!currentCostColumn) return; // banner handles user messaging

    const rev = (data.revenueToday == null) ? null : data.revenueToday;
    const adjCcy = data.adjustCurrency;

    // Off-date: TikTok UI is on a different date range, so the cost cell is
    // not today's spend. Render a rev-only warn pill (pipeline-state-visible
    // rule) and skip the cost-cell read — its value would only confuse
    // diagnostics.
    if (currentTikTokDate && !currentTikTokDate.isToday) {
      const todayKey = `${mainKey}|offdate:${currentTikTokDate.label}|rev:${rev}|a:${adjCcy || ''}`;
      if (decoratedTodayKey.get(nameEl) === todayKey) return;

      const todayPill = document.createElement('span');
      todayPill.className = TODAY_PILL_CLASS_OFFDATE;
      todayPill.textContent =
        `Today rev${adjCcy ? ` (${adjCcy})` : ''}: ${formatMoneyOrDash(rev)} ` +
        `(TikTok on ${currentTikTokDate.label})`;
      todayPill.title =
        `Today ROAS not computed — TikTok UI date range is "${currentTikTokDate.label}".\n` +
        `Cost cell reflects that range, not today's spend, so dividing would mislead.\n` +
        `Switch TikTok UI date picker to Today for live ROAS.\n` +
        (rev != null
          ? `Adjust today rev${adjCcy ? ` (${adjCcy})` : ''}: ${formatMoneyOrDash(rev)}`
          : `Adjust has no revenue for this row today yet.`);

      lastTodayStats.pillsRenderedOffDate++;
      lastTodayStats.skippedOffDate++;
      if (lastTodayStats.sampleRevToday == null && rev != null) lastTodayStats.sampleRevToday = rev;
      if (!lastTodayStats.adjustCurrencyExample && adjCcy) lastTodayStats.adjustCurrencyExample = adjCcy;
      commitTodayPill(nameEl, mainPill, todayPill, todayKey);
      return;
    }

    const spendText = findCostCellText(nameEl);
    let spend = null;
    let ttCcy = null;
    if (spendText != null) {
      const parsed = parseCurrencyCell(spendText);
      if (parsed.abbreviated) {
        lastTodayStats.skippedAbbreviated++;
      } else if (parsed.parsed && parsed.value != null) {
        spend = parsed.value;
        ttCcy = parsed.currency;
      }
    } else {
      lastTodayStats.skippedNoCostCell++;
    }

    if (lastTodayStats.sampleSpend == null && spend != null) lastTodayStats.sampleSpend = spend;
    if (lastTodayStats.detectedTikTokCurrency == null && ttCcy) lastTodayStats.detectedTikTokCurrency = ttCcy;
    if (lastTodayStats.sampleRevToday == null && rev != null) lastTodayStats.sampleRevToday = rev;
    if (!lastTodayStats.adjustCurrencyExample && adjCcy) lastTodayStats.adjustCurrencyExample = adjCcy;

    const currencyMismatch = ttCcy && adjCcy && ttCcy !== adjCcy;

    const todayKey = `${mainKey}|rev:${rev}|spend:${spend}|t:${ttCcy || ''}|a:${adjCcy || ''}|mm:${currencyMismatch}`;
    if (decoratedTodayKey.get(nameEl) === todayKey) return;

    const todayPill = document.createElement('span');

    if (currencyMismatch) {
      todayPill.className = TODAY_PILL_CLASS_MISMATCH;
      todayPill.textContent = `Today: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)} (${adjCcy}→${ttCcy})`;
      todayPill.title =
        `Today ROAS unavailable — cross-currency.\n` +
        `Adjust app revenue (${adjCcy}): ${formatMoneyOrDash(rev)}\n` +
        `TikTok ad-account spend (${ttCcy}): ${formatMoneyOrDash(spend)}\n` +
        `Refusing to divide across currencies (would mislead).`;
      lastTodayStats.skippedCurrencyMismatch++;
    } else {
      todayPill.className = TODAY_PILL_CLASS_NORMAL;
      todayPill.appendChild(document.createTextNode(
        `Today: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)}`
      ));
      if (rev != null && spend != null && spend > 0) {
        const roas = rev / spend;
        todayPill.appendChild(document.createTextNode(' '));
        const valSpan = document.createElement('span');
        valSpan.textContent = pct(roas);
        if (roas < colorThresholds.red) valSpan.className = 'adjust-rv-red';
        else if (roas > colorThresholds.green) valSpan.className = 'adjust-rv-green';
        todayPill.appendChild(valSpan);
      }
      todayPill.title = formatTodayTooltip(rev, spend, ttCcy || adjCcy || '?', adjCcy, data);
      lastTodayStats.pillsRendered++;
    }

    commitTodayPill(nameEl, mainPill, todayPill, todayKey);
  }

  // Final commit step shared by both render branches: drop any stale pill,
  // apply position-fixed styling, position once on the current frame, attach
  // to body, register in the tracking Maps, invalidate the rAF early-exit
  // (so the next frame re-syncs the new pill with the cell's current rect),
  // and arm the loop. Centralized so neither branch can drift on style/dedup
  // bookkeeping.
  function commitTodayPill(nameEl, mainPill, todayPill, todayKey) {
    const stale = cellToTodayPill.get(nameEl);
    if (stale) { stale.remove(); cellToTodayPill.delete(nameEl); }
    todayPill.style.position = 'fixed';
    todayPill.style.zIndex = '99999';
    todayPill.style.margin = '0';
    positionTodayPillToCell(nameEl, mainPill, todayPill);
    document.body.appendChild(todayPill);
    cellToTodayPill.set(nameEl, todayPill);
    decoratedTodayKey.set(nameEl, todayKey);
    // The rAF early-exit prefilter only tracks the main pill's cell rect; a
    // newly-created today pill would otherwise sit at its initial position
    // until the row moved. Drop the prefilter cache so the next frame runs
    // the full positioning path once and re-records the prev state.
    lastPositioned.delete(nameEl);
    ensureRepositionLoop();
  }

  // Position the today pill to the right of the main pill. Both pills are
  // position:fixed children of body. We DELIBERATELY avoid
  // `mainPill.getBoundingClientRect()` here: repositionLoopTick writes the
  // main pill's style.left/top immediately before calling this fn, so a rect
  // read would force a synchronous layout flush per visible row per scroll
  // frame. Instead we anchor off the main pill's left from `lastPositioned`
  // (same source positionPillToCell wrote to) plus the pill's width cached
  // on the element at creation. Fallback path (no cached entry yet) anchors
  // past the column right; the next rAF tick tightens placement once both
  // caches are populated.
  function positionTodayPillToCell(cell, mainPill, todayPill) {
    const cr = cell.getBoundingClientRect();
    const offscreen = cr.width === 0 || cr.height === 0
      || cr.bottom < 0 || cr.top > window.innerHeight;
    if (offscreen) {
      todayPill.style.display = 'none';
      return;
    }
    const cached = lastPositioned.get(cell);
    let mainWidth = mainPill._aoxWidth || 0;
    // Lazy re-measure if the creation-time read returned 0 (shouldn't happen
    // with the off-screen park, but be defensive — e.g. if CSS animations
    // were mid-flight on creation). Costs one layout flush per pill once.
    if (mainWidth === 0 && mainPill.isConnected) {
      mainWidth = mainPill.offsetWidth;
      if (mainWidth > 0) mainPill._aoxWidth = mainWidth;
    }
    let leftAnchor;
    if (cached && !cached.hidden && mainWidth > 0) {
      leftAnchor = cached.left + mainWidth + 4;
    } else {
      const column = getColumnAncestor(cell);
      const colRight = column ? column.getBoundingClientRect().right : cr.right;
      leftAnchor = colRight + 110;
    }
    todayPill.style.display = '';
    todayPill.style.left = Math.round(leftAnchor) + 'px';
    todayPill.style.top = Math.round(cr.top + (cr.height / 2) - 9) + 'px';
  }

  function logDomDiagnostics() {
    const candidates = pickNameCandidates();
    const usedSelector = candidates.length > 0
      ? (document.querySelectorAll(NAME_CANDIDATE_SELECTOR_PRIMARY).length > 0
          ? NAME_CANDIDATE_SELECTOR_PRIMARY
          : NAME_CANDIDATE_SELECTOR_FALLBACK)
      : '(none matched)';
    let firstMatch = null;
    let firstUnmatchedSample = null;
    let firstMatchEntry = null;
    let matchCount = 0;
    let matchedLevel = null;
    const tab = getCurrentTab();
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      const k = canonicalKey(text);
      const lvl = adIndex.has(k) ? 'ad' : adsetIndex.has(k) ? 'adset' : campaignIndex.has(k) ? 'campaign' : null;
      if (lvl) {
        matchCount++;
        if (!firstMatch) {
          firstMatch = text.slice(0, 120);
          matchedLevel = lvl;
          firstMatchEntry = lvl === 'ad' ? adIndex.get(k)
                          : lvl === 'adset' ? adsetIndex.get(k)
                          : campaignIndex.get(k);
        }
      } else if (!firstUnmatchedSample && text.length >= 5) {
        firstUnmatchedSample = text.slice(0, 120);
      }
    }

    const bridgeNode = document.getElementById('aox-tt-bridge-data');
    let bridgeProbe = { error: 'aox-tt-bridge-data node not found' };
    if (bridgeNode) {
      try {
        const payload = JSON.parse(bridgeNode.textContent || '{}');
        bridgeProbe = {
          bridgeVersion: payload.version,
          bridgeAgeMs: payload.timestamp ? Date.now() - payload.timestamp : null,
          knownAdIds: payload.knownAdIdsSize,
          knownAdsetIds: payload.knownAdsetIdsSize,
          knownCampIds: payload.knownCampIdsSize,
          rowsScanned: payload.scanned,
          rowsHit: payload.hits,
          sampleHits: (payload.results || []).slice(0, 3),
        };
      } catch (e) {
        bridgeProbe = { error: 'bad JSON: ' + e.message };
      }
    }

    console.log(
      '%c[AOX-TT]%c DOM diagnostics',
      'background:#0066ff;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
      'color:#0066ff', {
      version: INJECTOR_VERSION,
      tab,
      candidateSelector: usedSelector,
      candidatesFound: candidates.length,
      matchedToAdjustNames: matchCount,
      firstMatchText: firstMatch,
      firstMatchLevel: matchedLevel,
      firstUnmatchedSample,
      firstMatchEntry,
      indexSizes: {
        campaign: campaignIndex.size,
        campById: campByIdIndex.size,
        adset: adsetIndex.size,
        adsetById: adsetByIdIndex.size,
        ad: adIndex.size,
        adById: adByIdIndex.size,
      },
      // Sample of indexed keys so we can compare vs the DOM textContent and
      // diagnose name-normalization mismatches without re-walking the whole
      // index. Filtered by current candidate's first 8 chars when possible
      // (narrow signal beats a random slice of 5).
      sampleCampaignKeys: pickSampleKeys(campaignIndex, firstUnmatchedSample),
      sampleAdsetKeys:    pickSampleKeys(adsetIndex,    firstUnmatchedSample),
      sampleAdKeys:       pickSampleKeys(adIndex,       firstUnmatchedSample),
      lastDecoratePass: { ...lastDecorateStats },
      bridgeProbe,
      today: { ...lastTodayStats },
    });
  }

  function pickSampleKeys(map, hint) {
    const all = [...map.keys()];
    if (hint && hint.length >= 6) {
      const probe = canonicalKey(hint).slice(0, 8);
      const matches = all.filter(k => k.startsWith(probe));
      if (matches.length) return matches.slice(0, 5);
    }
    return all.slice(0, 5);
  }

  // ---- Decorate one candidate ----
  function decorateCandidate(el) {
    const rawName = el.textContent || '';
    if (rawName.length < 5 || rawName.length > 300) return;
    const key = canonicalKey(rawName);

    lastDecorateStats.candidates++;

    // Try the level matching the current tab first. Falls through to the
    // others so a name visible elsewhere still decorates correctly.
    const tab = getCurrentTab();
    const order = tab === 'campaign' ? ['campaign', 'adset', 'ad']
                : tab === 'adset'    ? ['adset', 'ad', 'campaign']
                :                       ['ad', 'adset', 'campaign'];

    let data = null;
    for (const level of order) {
      data = lookupForLevel(el, key, level);
      if (data) break;
    }
    if (!data) return;

    lastDecorateStats.matched++;

    if (decoratedKey.get(el) === key) {
      // Same cell + same content — main pill is up to date. Today pill has
      // its own independent dedup map (decoratedTodayKey) and MUST still be
      // attempted: column header may not have been visible on the first pass,
      // or the date filter may have flipped. The rAF loop is already (or
      // about to be) tracking pill positions; nothing else to do for main.
      const existingPill = cellToPill.get(el);
      if (existingPill) maybeRenderTodayPill(el, existingPill, data, key);
      ensureRepositionLoop();
      return;
    }

    // Cell got reassigned to a different campaign (virtualization recycle):
    // drop the old pills before creating fresh ones. Today pill is tracked
    // separately and must also be dropped or it would orphan once cellToPill
    // is rekeyed.
    const stale = cellToPill.get(el);
    if (stale) {
      stale.remove();
      cellToPill.delete(el);
    }
    const staleToday = cellToTodayPill.get(el);
    if (staleToday) {
      staleToday.remove();
      cellToTodayPill.delete(el);
      decoratedTodayKey.delete(el);
    }

    const pill = document.createElement('span');
    if (data.ambiguous) {
      pill.className = 'adjust-pill adjust-pill-ambiguous';
      pill.title = formatAmbiguousTooltip(data);
    } else {
      pill.className = `adjust-pill adjust-pill-${classifyForColor(data.roas, colorThresholds)}`;
      pill.title = formatTooltip(data);
    }
    fillPillSegments(pill, data.roas);

    pill.style.position = 'fixed';
    pill.style.zIndex = '99999';
    pill.style.margin = '0';
    // Park the pill off-screen (still display:'') BEFORE appending so we can
    // measure its rendered width without a layout flicker. If we let
    // positionPillToCell run first, a cell that's currently offscreen would
    // apply `display:none` — and offsetWidth on a display:none element is 0,
    // making the cached width useless and causing the today pill to overlap
    // the main pill when the row later scrolls into view. The off-screen
    // park + measure + reposition sequence guarantees a non-zero width
    // regardless of cell visibility at creation time.
    pill.style.left = '-99999px';
    pill.style.top = '0';
    document.body.appendChild(pill);
    pill._aoxWidth = pill.offsetWidth;
    positionPillToCell(el, pill);

    cellToPill.set(el, pill);
    decoratedKey.set(el, key);

    // Today pill is a SEPARATE position:fixed sibling tracked in
    // cellToTodayPill. ALWAYS attempt; its own decoratedTodayKey WeakMap
    // dedups so repeated calls are cheap. Failure paths bump lastTodayStats
    // counters but never throw.
    maybeRenderTodayPill(el, pill, data, key);

    ensureRepositionLoop();
  }

  // Cache the column ancestor per leaf cell. DOM structure for a row is
  // stable for the life of the cell, so re-walking 8 ancestors with
  // getBoundingClientRect on every rAF tick is wasted work. WeakMap means
  // entries auto-evict when TikTok virtualizes the cell out of the DOM.
  const cellColumnCache = new WeakMap();

  function positionPillToCell(cell, pill) {
    const r = cell.getBoundingClientRect();
    const offscreen = r.width === 0 || r.height === 0
      || r.bottom < 0 || r.top > window.innerHeight;
    // Horizontal: align to the name column's right edge, not the leaf link's,
    // so pills line up vertically across rows regardless of name truncation
    // length. Vertical: still keyed off the leaf cell so each pill matches
    // its own row.
    const column = getColumnAncestor(cell);
    const colRight = column ? column.getBoundingClientRect().right : r.right;
    const left = Math.round(colRight + 6);
    const top = Math.round(r.top + (r.height / 2) - 9);
    if (offscreen) {
      pill.style.display = 'none';
    } else {
      pill.style.display = '';
      pill.style.left = left + 'px';
      pill.style.top = top + 'px';
    }
    // Store cell's own rect.right alongside the column-aligned left so the
    // rAF early-exit can re-validate cheaply without re-walking ancestors.
    lastPositioned.set(cell, { left, top, hidden: offscreen, cellRight: r.right });
  }

  function getColumnAncestor(cell) {
    let column = cellColumnCache.get(cell);
    if (column && column.isConnected) return column;
    column = findColumnAncestor(cell);
    if (column) cellColumnCache.set(cell, column);
    return column;
  }

  // Walk up from the leaf name link to its enclosing column cell. Heuristic:
  // first ancestor noticeably wider than the leaf and short enough to be a
  // single-row cell. Returns the leaf as fallback if no good match is found.
  function findColumnAncestor(cell) {
    const cellW = cell.getBoundingClientRect().width;
    let n = cell.parentElement;
    for (let i = 0; i < 8 && n; i++) {
      const r = n.getBoundingClientRect();
      if (r.width >= cellW + 40 && r.height > 0 && r.height < 200) return n;
      n = n.parentElement;
    }
    return cell;
  }

  // TikTok's `<ks-virtual-table>` scrolls by mutating row transforms instead
  // of firing native scroll events on a real scroll container, so we cannot
  // rely on `scroll` listeners to know when to reposition. A continuous rAF
  // loop runs while at least one pill is alive; each frame compares the
  // cell's current bounding rect to the last positioned values and only
  // updates style when something moved (cheap idle, smooth follow on scroll).
  // The loop self-terminates as soon as cellToPill drains.
  let rafLoopActive = false;
  const lastPositioned = new WeakMap(); // cell → {left, top, hidden}

  function repositionLoopTick() {
    rafLoopActive = false;
    if (cellToPill.size === 0) return;

    for (const [cell, pill] of cellToPill) {
      if (!cell.isConnected) {
        pill.remove();
        cellToPill.delete(cell);
        lastPositioned.delete(cell);
        // Today pill is keyed by the same cell; cleanup must mirror main pill
        // or it would leak orphaned floating pills as TikTok virtualizes rows.
        const todayPill = cellToTodayPill.get(cell);
        if (todayPill) {
          todayPill.remove();
          cellToTodayPill.delete(cell);
          decoratedTodayKey.delete(cell);
        }
        continue;
      }
      // Cheap prefilter using the cell's own rect: if vertical position and
      // visibility match what we last wrote, the pill is already correct.
      // commitTodayPill deletes the lastPositioned entry whenever a new
      // today pill is attached, so this exit also fires only AFTER the
      // today pill has been synced to the row.
      const r = cell.getBoundingClientRect();
      const offscreen = r.width === 0 || r.height === 0
        || r.bottom < 0 || r.top > window.innerHeight;
      const top = Math.round(r.top + (r.height / 2) - 9);
      const prev = lastPositioned.get(cell);
      if (prev && prev.top === top && prev.hidden === offscreen && prev.cellRight === r.right) {
        continue;
      }
      positionPillToCell(cell, pill);
      const todayPill = cellToTodayPill.get(cell);
      if (todayPill) positionTodayPillToCell(cell, pill, todayPill);
    }

    if (cellToPill.size > 0) {
      rafLoopActive = true;
      requestAnimationFrame(repositionLoopTick);
    }
  }

  function ensureRepositionLoop() {
    if (rafLoopActive || cellToPill.size === 0) return;
    rafLoopActive = true;
    requestAnimationFrame(repositionLoopTick);
  }

  // Resolve a row at a specific level. Strategy chain:
  //   1. Exact name lookup. If unique → return.
  //   2. If ambiguous, ask the bridge for the row's id and resolve via byId.
  //   3. Else return the ambiguous aggregate.
  function lookupForLevel(el, key, level) {
    const byName = level === 'campaign' ? campaignIndex
                 : level === 'adset'    ? adsetIndex
                 :                        adIndex;
    const byId   = level === 'campaign' ? campByIdIndex
                 : level === 'adset'    ? adsetByIdIndex
                 :                        adByIdIndex;
    const byComposite = level === 'adset' ? adsetCompositeIndex
                      : level === 'ad'    ? adCompositeIndex
                      :                     null;

    const entry = byName.get(key);
    if (!entry) return null;
    if (!entry.ambiguous) {
      lastDecorateStats.resolvedByName++;
      return entry;
    }

    // Ambiguous → try the bridge.
    const hit = lookupBridgeRowHit(el);
    if (hit) {
      const id = level === 'campaign' ? hit.c
               : level === 'adset'    ? hit.s
               :                        hit.a;
      if (id) {
        const direct = byId.get(id);
        if (direct) {
          lastDecorateStats.resolvedByBridgeId++;
          return direct;
        }
        if (byComposite) {
          // adset/ad: bridge gave us the id, but byId may be empty if the
          // captured id space doesn't match. Try (campId :: name) composite
          // when bridge ALSO supplies the campaign id (`c`) as a sibling hint.
          if (hit.c) {
            const m = byComposite.get(`${hit.c}::${key}`);
            if (m) {
              lastDecorateStats.resolvedByBridgeId++;
              return m;
            }
          }
        }
      }
    }

    lastDecorateStats.stillAmbiguous++;
    return entry;
  }

  // ---- Pill helpers (kept compatible with content/meta-injector.css) ----
  function pct(x) {
    return x == null ? '–' : `${(x * 100).toFixed(0)}%`;
  }

  function fillPillSegments(parent, roas) {
    const segments = [
      { label: 'D0', value: roas.d0 },
      { label: '3d', value: roas.d3 },
      { label: '7d', value: roas.d7 },
      { label: 'All', value: roas.allTime },
    ];
    for (const seg of segments) {
      const span = document.createElement('span');
      span.className = 'adjust-pill-seg';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'adjust-pill-label';
      labelSpan.textContent = seg.label + ':';
      const valSpan = document.createElement('span');
      valSpan.className = 'adjust-pill-value';
      valSpan.textContent = pct(seg.value);
      // Per-segment coloring: each value lights up by its own threshold so
      // the user sees granular signal even when the overall pill stays
      // neutral. Whole-pill background only escalates to red on bad signal
      // (see classifyForColor) — green-whole-pill is intentionally absent.
      if (seg.value != null) {
        if (seg.value < colorThresholds.red) valSpan.classList.add('adjust-rv-red');
        else if (seg.value > colorThresholds.green) valSpan.classList.add('adjust-rv-green');
      }
      span.appendChild(labelSpan);
      span.appendChild(valSpan);
      parent.appendChild(span);
    }
  }

  function formatTooltip(data) {
    const lines = [
      `Name: ${data.campaignName}`,
      `Network: ${data.network}`,
    ];
    if (data.rowCount > 1) lines.push(`Aggregated from: ${data.rowCount} rows`);
    if (data.cost != null) {
      lines.push(`Cost: $${data.cost.toFixed(2)} · Installs: ${data.installs ?? 0}`);
    }
    lines.push(`Last sync: ${new Date(lastSyncAt).toLocaleString()}`);
    lines.push(`Source: ${sourceLabel}`);
    return lines.join('\n');
  }

  function formatAmbiguousTooltip(data) {
    const head = `${data.campaignName} — ambiguous across ${data.candidates?.length ?? '?'} rows`;
    const detail = (data.candidates || [])
      .slice()
      .sort((a, b) => (b.cost || 0) - (a.cost || 0))
      .slice(0, 5)
      .map(c =>
        `  • ${c.campaignName} → spend $${(c.cost || 0).toFixed(2)} | ` +
        `D0 ${pct(c.roas?.d0)} 7d ${pct(c.roas?.d7)}`
      ).join('\n');
    return head + '\n' + detail;
  }

  // ---- Banner ----
  // showBanner / createBanner / restoreBannerPosition / attachBannerInteractions
  // are defined in content/shared.js (loaded before this file via manifest).

  function buildBannerText() {
    const ageMin = Math.round((Date.now() - lastSyncAt) / 60000);
    const base = `Adjust [TikTok]: ${campaignIndex.size} campaigns / ${adsetIndex.size} ad sets / ${adIndex.size} ads · synced ${ageMin}m ago · ${sourceLabel}`;
    const lines = [base];
    // Today-pill banner lines (at most one). Priority: column-missing wins
    // over off-date wins over currency-mismatch wins over abbreviation. Each
    // higher-priority condition gates EVERY row, so surfacing it first avoids
    // the user fixing a per-row issue while a global block still hides pills.
    const t = lastTodayStats;
    if (!t.columnFound) {
      lines.push(`⚠ Today ROAS disabled — enable "Cost" column in this TikTok view.`);
    } else if (t.ttDateIsToday === false) {
      const label = t.ttDateLabel || 'unknown';
      lines.push(`⚠ Today ROAS not computed — TikTok UI date range is "${label}". Switch to Today for live ROAS.`);
    } else if (t.skippedCurrencyMismatch > 0 && t.pillsRendered === 0) {
      const adj = t.adjustCurrencyExample || '?';
      const tt = t.detectedTikTokCurrency || '?';
      lines.push(`⚠ Today ROAS unavailable — Adjust app currency (${adj}) ≠ TikTok ad-account currency (${tt}).`);
    } else if (t.skippedAbbreviated > 0 && t.pillsRendered === 0) {
      lines.push(`⚠ Today ROAS disabled — disable TikTok's number abbreviation to read cost cells.`);
    }
    return lines.join('\n');
  }

  function decorateAllVisibleRows() {
    lastDecorateStats = { candidates: 0, matched: 0, resolvedByName: 0, resolvedByBridgeId: 0, stillAmbiguous: 0 };
    lastTodayStats = createEmptyTodayStats();
    rowYBuckets = null;
    // Locate the Cost column + detect TikTok UI date filter once per pass.
    // Today-pill rendering is skipped when the column isn't visible (banner
    // surfaces guidance). Off-date → rev-only warn variant.
    currentCostColumn = locateCostColumn();
    if (currentCostColumn) {
      lastTodayStats.columnFound = true;
      lastTodayStats.columnX = Math.round(currentCostColumn.headerX);
      lastTodayStats.columnHeaderText = currentCostColumn.headerText;
    }
    currentTikTokDate = detectTikTokDateInfo();
    lastTodayStats.ttDateIsToday = currentTikTokDate.isToday;
    lastTodayStats.ttDateLabel = currentTikTokDate.label;
    lastTodayStats.ttDateSource = currentTikTokDate.source;

    dispatchBridgeScan();
    pickNameCandidates().forEach(decorateCandidate);

    rowYBuckets = null; // release; rects go stale on next mutation anyway
    currentCostColumn = null;
    currentTikTokDate = null;

    // Re-render banner after every pass so it reflects the CURRENT pass
    // stats — not stale stats from loadData's initial showBanner call (which
    // ran before column lookup). Severity: warn if any guidance line was
    // appended, else ok.
    if (lastSyncAt) {
      const text = buildBannerText();
      const hasWarn = text.includes('\n⚠');
      showBanner(text, hasWarn ? 'warn' : 'ok');
    }
  }

  function removeAllPills() {
    for (const [cell, pill] of cellToPill) pill.remove();
    cellToPill.clear();
    for (const [cell, pill] of cellToTodayPill) pill.remove();
    cellToTodayPill.clear();
    document.querySelectorAll('.adjust-pill').forEach(p => p.remove());
    pickNameCandidates().forEach(el => {
      decoratedKey.delete(el);
      decoratedTodayKey.delete(el);
    });
  }

  function scheduleDecorate() {
    if (decorateTimer) return;
    decorateTimer = setTimeout(() => {
      decorateTimer = null;
      decorateAllVisibleRows();
    }, 200);
  }

  function ensureObserving() {
    if (bodyObserver) return;
    bodyObserver = new MutationObserver(() => scheduleDecorate());
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Init ----
  // Load thresholds first so the very first decoration uses user-configured
  // colors rather than briefly painting with defaults and re-painting.
  loadColorThresholds().then(() => loadData());

  // Safety net: TikTok loads its table 2-10 seconds after document_idle on
  // slow networks, and MutationObserver sometimes misses the initial paint
  // because Vmok renders inside a portaled root that wasn't in the DOM when
  // we attached. Re-trigger decorate every 2s for the first 30s so we catch
  // the table appearance regardless. Stops itself once the page settles.
  const RETRY_INTERVAL_MS = 2000;
  const RETRY_DEADLINE_MS = 30000;
  const retryStartedAt = Date.now();
  let lastRetryCandidateCount = -1;
  const retryHandle = setInterval(() => {
    if (Date.now() - retryStartedAt > RETRY_DEADLINE_MS) {
      clearInterval(retryHandle);
      return;
    }
    const count = pickNameCandidates().length;
    // Only re-decorate when the candidate set changed since last tick (avoids
    // wasted work once the table is stable).
    if (count !== lastRetryCandidateCount) {
      lastRetryCandidateCount = count;
      decorateAllVisibleRows();
      logDomDiagnostics();
    }
  }, RETRY_INTERVAL_MS);

  // Re-load whenever background writes a new cache. Subscribing to
  // chrome.storage.onChanged means the popup doesn't need tabs/messaging
  // permissions to push us refreshes — same pattern as meta-injector.
  // Threshold changes also trigger a re-decorate so saved values take effect
  // without a page reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.campaignDataCache) {
      loadData();
    } else if (changes.colorThresholds) {
      loadColorThresholds().then(() => {
        removeAllPills();
        decorateAllVisibleRows();
      });
    }
  });
})();
