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

  const INJECTOR_VERSION = 'v0.5.1-tt-thresh-parity';
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
  // True once a real cache object has been received and indices built. The
  // first GET_CACHED at init can race a cold service worker and return null,
  // which leaves indices empty; the retry loop reloads until this flips true.
  let dataLoaded = false;
  // Guards against overlapping loadData() runs (retry tick + storage event).
  let loadInFlight = false;

  // Color thresholds — overridable per-platform from popup Settings. Defaults
  // mirror what the popup writes when the user hasn't customized yet, and are
  // kept identical to meta-injector's so one campaign reads the same colour in
  // either table (see DEFAULT_COLOR_THRESHOLDS in popup/popup.js).
  let colorThresholds = { pause: 0.60, red: 0.80, green: 1.00 };

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
      // Yesterday-pill counters (v0.5.0). yestCaptured counts spend cells
      // harvested while the UI sits on Yesterday; pillsYesterday counts full
      // ROAS pills; yestNeedSpend counts the "cần view Yesterday" prompts.
      ttDateIsYesterday: null,
      yestCaptured: 0, pillsYesterday: 0, yestNeedSpend: 0,
      skippedYestCurrencyMismatch: 0, sampleRevYesterday: null,
    };
  }
  let lastTodayStats = createEmptyTodayStats();

  // CSS class names for the today- and yesterday-pill variants. Defined once
  // so the strings can't drift between the render branches and the dedup
  // cleanup sweeps in decorateCandidate / maybeRender*Pill. The rules live in
  // content/meta-injector.css, which the manifest loads on TikTok too.
  const TODAY_PILL_CLASS_NORMAL   = 'adjust-pill adjust-pill-today';
  const TODAY_PILL_CLASS_OFFDATE  = 'adjust-pill adjust-pill-today-offdate';
  const TODAY_PILL_CLASS_MISMATCH = 'adjust-pill adjust-pill-today-mismatch';
  const YEST_PILL_CLASS_NORMAL    = 'adjust-pill adjust-pill-yesterday';
  const YEST_PILL_CLASS_OFFDATE   = 'adjust-pill adjust-pill-yest-offdate';
  const YEST_PILL_CLASS_MISMATCH  = 'adjust-pill adjust-pill-yest-mismatch';
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

  // Yesterday pill: a THIRD position:fixed sibling, same lifecycle contract as
  // the today pill but its own Map/WeakMap so each type can be toggled off
  // independently without disturbing the other two.
  const cellToYesterdayPill = new Map();
  const decoratedYesterdayKey = new WeakMap();

  // TikTok exposes no spend API, so yesterday's spend can only be scraped from
  // the table while the date picker is parked on Yesterday. Harvested values
  // live here keyed by the row's match key, tagged with the calendar day they
  // represent so a stale capture is never divided into a newer day's revenue.
  //   Map<mainKey, { representsDay: 'YYYY-MM-DD', spend: number, currency: string }>
  const ttYestSpendCache = new Map();

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

  async function loadColorThresholds() {
    try {
      const { colorThresholds: stored } = await chrome.storage.local.get('colorThresholds');
      const t = stored?.tiktok;
      if (t) {
        colorThresholds = {
          pause: typeof t.pause === 'number' ? t.pause : colorThresholds.pause,
          red:   typeof t.red   === 'number' ? t.red   : colorThresholds.red,
          green: typeof t.green === 'number' ? t.green : colorThresholds.green,
        };
      }
    } catch { /* keep defaults */ }
  }

  // ---- Sync data from background ----
  async function loadData() {
    if (loadInFlight) return;
    loadInFlight = true;
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
      const adsetRows = tiktokRows.filter(r => r.level === 'adset');
      const adRows = tiktokRows.filter(r => r.level === 'ad');

      campaignIndex = buildDirectIndex(campaignRows, r => r.campaignName);
      campByIdIndex = buildIdIndex(campaignRows, r => r.campaignId, r => r.campaignName);

      // Adset index built from adset-level Adjust rows directly — one row per
      // adset, no creative-level rollup. This eliminates the attribution-shadow
      // double-count bug where a stale today-row with creative_id_network=null
      // gets summed alongside the resolved creative_id row.
      // buildAggregatedIndex still groups by canonical adsetName so cross-app
      // collisions are marked ambiguous and resolved via the bridge.
      const adsetBuilt = buildAggregatedIndex(adsetRows, r => r.adsetName, r => r.adsetId);
      adsetIndex = adsetBuilt.byName;
      adsetCompositeIndex = adsetBuilt.byComposite;
      adsetByIdIndex = adsetBuilt.byId;

      const adBuilt = buildAdIndex(adRows);
      adIndex = adBuilt.byName;
      adCompositeIndex = adBuilt.byComposite;
      adByIdIndex = adBuilt.byAdId;

      lastSyncAt = cached.lastSyncAt;
      sourceLabel = cached.sourceLabel;
      dataLoaded = true;

      // Post-build: attach revenueToday + adjustCurrency onto each index
      // entry by summing the per-row `revenueToday` field that data-source.js
      // merged in. Kept as a separate pass so we never modify the signatures
      // of the existing index builders — diff stays additive.
      attachTodayMetrics(campaignRows, adsetRows, adRows);

      dispatchBridgeKnownIds();

      showBanner(buildBannerText(), cached.isStale ? 'warn' : 'ok');
      removeAllPills();
      ensureObserving();
      decorateAllVisibleRows();
      logDomDiagnostics();
    } catch (err) {
      console.warn('[Adjust Overlay TT] loadData failed:', err.message);
    } finally {
      loadInFlight = false;
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

  // Header text TikTok uses for the spend column across locales. Keys are
  // canonicalKey'd at construction. Failure is graceful (column-missing
  // banner) rather than silent miscoluming.
  //
  // TikTok labels this column "Cost" in some account/locale builds and
  // "Spend" in others (same underlying `stat_cost` metric — visible in the
  // URL's `sort_state=stat_cost`). v0.4.8 only knew "Cost", so accounts on
  // the "Spend" build silently got NO today pill and the misleading
  // "enable Cost column" banner while the column was right there. Both
  // spellings — and their locale variants — are accepted now.
  const TIKTOK_COST_HEADER_KEYS = new Set([
    canonicalKey('Cost'),
    canonicalKey('Spend'),
    canonicalKey('Amount spent'),
    canonicalKey('Total cost'),
    canonicalKey('Chi phí'),
    canonicalKey('Chi tiêu'),
    canonicalKey('Costo'),
    canonicalKey('Gasto'),
    canonicalKey('Coût'),
    canonicalKey('Dépenses'),
    canonicalKey('Kosten'),
    canonicalKey('Ausgaben'),
    canonicalKey('Custo'),
    canonicalKey('Gastos'),
    canonicalKey('Biaya'),
    canonicalKey('ค่าใช้จ่าย'),
    canonicalKey('费用'),
    canonicalKey('費用'),
    canonicalKey('花费'),
    canonicalKey('消費額'),
    canonicalKey('비용'),
    canonicalKey('지출'),
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
  function attachTodayMetrics(campaignRows, adsetRows, adRows) {
    for (const r of campaignRows) {
      if (!r.campaignName) continue;
      const visited = new WeakSet();
      bumpToday(campaignIndex, canonicalKey(r.campaignName), r, visited);
      if (r.campaignId) bumpToday(campByIdIndex, String(r.campaignId), r, visited);
    }
    // Adset today metrics come from adset-level Adjust rows directly. We do
    // NOT sum ad-level rows into adsetIndex here — that produced inflated
    // totals when Adjust returned creative_id=null shadow rows during
    // real-time attribution finalization (see docs/findings/adjust_today_shadow_row.md).
    for (const r of adsetRows) {
      if (!r.adsetName) continue;
      const visited = new WeakSet();
      const ak = canonicalKey(r.adsetName);
      bumpToday(adsetIndex, ak, r, visited);
      if (r.campaignId) bumpToday(adsetCompositeIndex, `${r.campaignId}::${ak}`, r, visited);
      if (r.adsetId) bumpToday(adsetByIdIndex, String(r.adsetId), r, visited);
    }
    for (const r of adRows) {
      if (!r.adName) continue;
      const visited = new WeakSet();
      const ak = canonicalKey(r.adName);
      bumpToday(adIndex, ak, r, visited);
      if (r.campaignId) bumpToday(adCompositeIndex, `${r.campaignId}::${ak}`, r, visited);
      if (r.adId) bumpToday(adByIdIndex, String(r.adId), r, visited);
    }
  }

  function bumpToday(idx, key, row, visited) {
    const e = idx.get(key);
    if (!e) return;
    if (visited.has(e)) return;
    visited.add(e);
    e.revenueToday = (e.revenueToday || 0) + (row.revenueToday || 0);
    // Yesterday event-date revenue. row.revenueYesterday is null when the
    // yesterday fetch did not run (no Yesterday pill enabled on either
    // platform) or failed — data-source.js leaves it null — and a number
    // (0 included) only when the fetch succeeded. Accumulate ONLY the numeric
    // case so a not-fetched row leaves the entry's revenueYesterday undefined
    // → the pill shows a dash rather than a fabricated red 0%. Same visited
    // guard as revenueToday: buildAdIndex shares one entry object across
    // byName/byComposite/byAdId, so without it revenue triple-counts.
    if (row.revenueYesterday != null) {
      e.revenueYesterday = (e.revenueYesterday || 0) + row.revenueYesterday;
    }
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
    const tableScope = document.querySelector('[class~="KsTable"]')
      || document.querySelector('ks-virtual-table')
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
    const tableScope = document.querySelector('[class~="KsTable"]')
      || document.querySelector('ks-virtual-table')
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

  // Detect whether TikTok UI's date filter is set to "Today" / "Yesterday".
  // TikTok exposes the active range via `?st=YYYY-MM-DD&et=YYYY-MM-DD` with no
  // preset keyword (unlike Meta's `date_preset` / `,today` suffix) — so unlike
  // Meta, which can short-circuit on the literal string 'yesterday', the ONLY
  // way to recognise yesterday here is ISO equality on a single-day range.
  // When both bounds equal browser-local today → isToday=true. When absent →
  // both false (don't silently divide by an unknown range's spend).
  //
  // Returns: { isToday, isYesterday, label, source: 'range'|'absent'|'error' }
  function detectTikTokDateInfo() {
    try {
      const params = new URLSearchParams(window.location.search);
      const st = params.get('st');
      const et = params.get('et');
      if (!st && !et) {
        return { isToday: false, isYesterday: false, label: 'unknown', source: 'absent' };
      }
      if (st && et && /^\d{4}-\d{2}-\d{2}$/.test(st) && /^\d{4}-\d{2}-\d{2}$/.test(et)) {
        const today = todayLocalIsoDate();
        if (st === today && et === today) {
          return { isToday: true, isYesterday: false, label: 'today', source: 'range' };
        }
        const yesterday = yesterdayLocalIsoDate();
        const isYesterday = st === yesterday && et === yesterday;
        const label = st === et ? st : `${st}…${et}`;
        return { isToday: false, isYesterday, label, source: 'range' };
      }
      return {
        isToday: false, isYesterday: false,
        label: `${st || '?'}…${et || '?'}`, source: 'range',
      };
    } catch {
      return { isToday: false, isYesterday: false, label: 'unknown', source: 'error' };
    }
  }

  function todayLocalIsoDate() {
    return localIsoDate(new Date());
  }

  // Browser-local yesterday. Deliberately the same clock the today check uses:
  // both assume the browser timezone tracks the ad-account timezone. If they
  // diverge the pill is off by a day — the SAME exposure the today pill has
  // always carried on TikTok, not a new one introduced here. Computed by
  // subtracting 24h from the epoch, so DST shifts land on the right calendar
  // day (a date-component decrement would not).
  function yesterdayLocalIsoDate() {
    return localIsoDate(new Date(Date.now() - 86400000));
  }

  function localIsoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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

  // Harvest yesterday's spend from the table — the ONLY moment it is readable
  // is while the date picker sits on Yesterday, because TikTok gives us no
  // spend API and the cost cell always reflects the active range. Runs
  // UNCONDITIONALLY from decorateCandidate (not gated on pillVis.yesterday) so
  // a user who browses Yesterday with the pill off still has the data cached
  // the moment they turn it on.
  //
  // Captures are tagged with the day they represent and re-validated at render
  // time; a capture from two days ago is dropped rather than divided into a
  // fresher revenue figure.
  function maybeCaptureYesterdaySpend(nameEl, mainKey) {
    if (!currentCostColumn) return;
    if (!currentTikTokDate || !currentTikTokDate.isYesterday) return;
    const text = findCostCellText(nameEl);
    if (text == null) return;
    const parsed = parseCurrencyCell(text);
    if (!parsed.parsed || parsed.value == null || parsed.abbreviated) return;
    ttYestSpendCache.set(mainKey, {
      representsDay: currentTikTokDate.label,
      spend: parsed.value,
      currency: parsed.currency,
    });
    lastTodayStats.yestCaptured++;
  }

  // Build (or refresh) the yesterday pill. Like the today pill it ALWAYS
  // renders (pipeline-state-visible rule) — when spend was never captured it
  // shows `Y'day: <rev>/– — cần view Yesterday` rather than vanishing, so the
  // user can tell "not captured yet" from "extension broken".
  //
  // Deliberately NOT gated on the current date filter: the pill's spend comes
  // from cache, not from the visible cells, so it stays meaningful (and stays
  // the daily driver) while the UI sits on Today.
  function maybeRenderYesterdayPill(nameEl, anchorPill, data, mainKey) {
    if (!data || data.ambiguous) return;

    const rev = (data.revenueYesterday == null) ? null : data.revenueYesterday;
    const adjCcy = data.adjustCurrency;
    if (lastTodayStats.sampleRevYesterday == null && rev != null) {
      lastTodayStats.sampleRevYesterday = rev;
    }

    // A capture only counts if it represents the day Adjust's `yesterday`
    // report covers. Comparing against the live yesterday ISO (not against
    // whatever the picker shows now) is what makes a day-rollover drop the
    // stale capture instead of misattributing it.
    const cached = ttYestSpendCache.get(mainKey);
    const spendFresh = !!(
      cached && cached.representsDay === yesterdayLocalIsoDate() && cached.spend != null
    );
    const spend = spendFresh ? cached.spend : null;
    const ttCcy = spendFresh ? cached.currency : null;
    const currencyMismatch = ttCcy && adjCcy && ttCcy !== adjCcy;

    const yestKey =
      `${mainKey}|yrev:${rev}|yspend:${spend}|t:${ttCcy || ''}|a:${adjCcy || ''}|mm:${currencyMismatch}`;
    if (decoratedYesterdayKey.get(nameEl) === yestKey) return;

    const yestPill = document.createElement('span');

    if (!spendFresh) {
      yestPill.className = YEST_PILL_CLASS_OFFDATE;
      yestPill.textContent = `Y'day: ${formatMoneyOrDash(rev)}/– — cần view Yesterday`;
      yestPill.title =
        `Yesterday ROAS chưa tính — chưa bắt được TikTok spend hôm qua.\n` +
        `Chuyển TikTok date picker sang đúng ngày ${yesterdayLocalIsoDate()} một lần để\n` +
        `extension đọc cost cell, rồi quay lại Today.\n` +
        `Revenue hôm qua (Adjust, event-date) đã có: ` +
        `${formatMoneyOrDash(rev)}${adjCcy ? ` ${adjCcy}` : ''}.`;
      lastTodayStats.yestNeedSpend++;
    } else if (currencyMismatch) {
      yestPill.className = YEST_PILL_CLASS_MISMATCH;
      yestPill.textContent =
        `Y'day: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)} (${adjCcy}→${ttCcy})`;
      yestPill.title =
        `Yesterday ROAS unavailable — cross-currency.\n` +
        `Adjust yesterday rev (${adjCcy}): ${formatMoneyOrDash(rev)}\n` +
        `TikTok yesterday spend (${ttCcy}): ${formatMoneyOrDash(spend)}\n` +
        `Refusing to divide across currencies (would mislead).`;
      lastTodayStats.skippedYestCurrencyMismatch++;
    } else {
      yestPill.className = YEST_PILL_CLASS_NORMAL;
      yestPill.appendChild(document.createTextNode(
        `Y'day: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)}`
      ));
      if (rev != null && spend != null && spend > 0) {
        const roas = rev / spend;
        yestPill.appendChild(document.createTextNode(' '));
        const valSpan = document.createElement('span');
        valSpan.textContent = pct(roas);
        if (roas < colorThresholds.red) valSpan.className = 'adjust-rv-red';
        else if (roas > colorThresholds.green) valSpan.className = 'adjust-rv-green';
        yestPill.appendChild(valSpan);
      }
      const ageMin = lastSyncAt ? Math.round((Date.now() - lastSyncAt) / 60000) : null;
      yestPill.title =
        `Yesterday realtime ROAS (event-date — directional, not cohort d0)\n` +
        `Rev (Adjust yesterday${adjCcy ? `, ${adjCcy}` : ''}): ${formatMoneyOrDash(rev)}\n` +
        `Spend (TikTok ${cached.representsDay}${ttCcy ? `, ${ttCcy}` : ''}): ` +
        `${formatMoneyOrDash(spend)}` +
        (ageMin != null ? `\nAdjust sync age: ${ageMin}m` : '');
      lastTodayStats.pillsYesterday++;
    }

    commitYesterdayPill(nameEl, anchorPill, yestPill, yestKey);
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
    // Park off-screen and measure BEFORE positioning, same reason the main
    // pill does: the yesterday pill's column anchor is derived from the widest
    // today pill, and offsetWidth on a display:none element reads 0. Without
    // this the two would overlap on rows created while scrolled out of view.
    todayPill.style.left = '-99999px';
    todayPill.style.top = '0';
    document.body.appendChild(todayPill);
    todayPill._aoxWidth = todayPill.offsetWidth;
    if (todayPill._aoxWidth > maxTodayPillWidth) maxTodayPillWidth = todayPill._aoxWidth;
    positionTodayPillToCell(nameEl, mainPill, todayPill);
    cellToTodayPill.set(nameEl, todayPill);
    decoratedTodayKey.set(nameEl, todayKey);
    // The rAF early-exit prefilter only tracks the main pill's cell rect; a
    // newly-created today pill would otherwise sit at its initial position
    // until the row moved. Drop the prefilter cache so the next frame runs
    // the full positioning path once and re-records the prev state.
    lastPositioned.delete(nameEl);
    ensureRepositionLoop();
  }

  // Same contract as commitTodayPill, for the third column.
  function commitYesterdayPill(nameEl, anchorPill, yestPill, yestKey) {
    const stale = cellToYesterdayPill.get(nameEl);
    if (stale) { stale.remove(); cellToYesterdayPill.delete(nameEl); }
    yestPill.style.position = 'fixed';
    yestPill.style.zIndex = '99999';
    yestPill.style.margin = '0';
    yestPill.style.left = '-99999px';
    yestPill.style.top = '0';
    document.body.appendChild(yestPill);
    yestPill._aoxWidth = yestPill.offsetWidth;
    positionYesterdayPillToCell(nameEl, anchorPill, yestPill);
    cellToYesterdayPill.set(nameEl, yestPill);
    decoratedYesterdayKey.set(nameEl, yestKey);
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
    // mainPill is null when the cohort pill is toggled off — the today pill is
    // then the leading pill and simply takes the main column's slot.
    let mainWidth = mainPill && mainPill._aoxWidth || 0;
    // Lazy re-measure if the creation-time read returned 0 (shouldn't happen
    // with the off-screen park, but be defensive — e.g. if CSS animations
    // were mid-flight on creation). Costs one layout flush per pill once.
    if (mainWidth === 0 && mainPill && mainPill.isConnected) {
      mainWidth = mainPill.offsetWidth;
      if (mainWidth > 0) mainPill._aoxWidth = mainWidth;
    }
    let leftAnchor;
    if (mainPillAnchorX != null) {
      // Fixed slot: every Today pill starts at the same x (main column anchor +
      // widest main pill + gap), so the Today pills line up in one straight
      // column that never collides with the main-pill column. With the cohort
      // pill off, maxMainPillWidth stays 0 and this collapses onto the main
      // column rather than leaving an empty gutter.
      leftAnchor = mainPillAnchorX + (maxMainPillWidth > 0 ? maxMainPillWidth + 6 : 0);
    } else if (cached && !cached.hidden && mainWidth > 0) {
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

  // Third column, same fixed-slot discipline as the today pill. Anchors past
  // the widest today pill so all three columns stay straight regardless of
  // per-row text width.
  //
  // When the today pill is toggled OFF no today pill is ever created, so
  // maxTodayPillWidth stays 0 and this collapses onto the today slot exactly —
  // the yesterday pill slides left into the vacated column instead of leaving
  // a visible gap.
  function positionYesterdayPillToCell(cell, anchorPill, yestPill) {
    const cr = cell.getBoundingClientRect();
    const offscreen = cr.width === 0 || cr.height === 0
      || cr.bottom < 0 || cr.top > window.innerHeight;
    if (offscreen) {
      yestPill.style.display = 'none';
      return;
    }
    let leftAnchor;
    if (mainPillAnchorX != null) {
      const todaySlot = mainPillAnchorX + (maxMainPillWidth > 0 ? maxMainPillWidth + 6 : 0);
      leftAnchor = maxTodayPillWidth > 0 ? todaySlot + maxTodayPillWidth + 6 : todaySlot;
    } else {
      // Pre-anchor fallback: chain off whatever pill we were handed. The next
      // rAF tick tightens placement once the table-wide anchors are computed.
      let anchorWidth = anchorPill && anchorPill._aoxWidth || 0;
      if (anchorWidth === 0 && anchorPill && anchorPill.isConnected) {
        anchorWidth = anchorPill.offsetWidth;
        if (anchorWidth > 0) anchorPill._aoxWidth = anchorWidth;
      }
      const cached = lastPositioned.get(cell);
      if (cached && !cached.hidden && anchorWidth > 0) {
        leftAnchor = cached.left + anchorWidth + 4;
      } else {
        const column = getColumnAncestor(cell);
        const colRight = column ? column.getBoundingClientRect().right : cr.right;
        leftAnchor = colRight + 220;
      }
    }
    yestPill.style.display = '';
    yestPill.style.left = Math.round(leftAnchor) + 'px';
    yestPill.style.top = Math.round(cr.top + (cr.height / 2) - 9) + 'px';
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
      // Checklog for the straight-column layout: anchorX is the shared left x
      // every main pill snaps to; slot is the reserved main-pill width the
      // Today column clears. If pills look staggered again, check these are
      // stable across rows instead of re-deriving the layout from scratch.
      pillLayout: {
        anchorX: mainPillAnchorX,
        slot: maxMainPillWidth,
        todaySlot: maxTodayPillWidth,
      },
      // Checklog for the per-type toggles + yesterday capture. `pillVis` is
      // what the popup checkboxes resolved to; yestSpendCacheSize is how many
      // rows have a harvested yesterday spend. A yesterday pill stuck on
      // "cần view Yesterday" with a non-zero cache size means the capture is
      // landing but the day tag no longer matches (rollover) — check
      // yestRepresentsDay against today's date before re-hunting the scraper.
      pillVis: { ...pillVis },
      yesterday: {
        cacheSize: ttYestSpendCache.size,
        expectsDay: yesterdayLocalIsoDate(),
        sampleEntry: ttYestSpendCache.size
          ? [...ttYestSpendCache.values()][0]
          : null,
      },
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

    // Harvest yesterday spend BEFORE any visibility gate — see the function
    // comment: a user browsing Yesterday with the pill off should still come
    // back to a populated cache when they switch it on.
    maybeCaptureYesterdaySpend(el, key);

    if (decoratedKey.get(el) === key) {
      // Same cell + same content — main pill SHOULD be up to date. Today and
      // yesterday pills have their own independent dedup maps and MUST still
      // be attempted: column header may not have been visible on the first
      // pass, or the date filter may have flipped. The rAF loop is already (or
      // about to be) tracking pill positions; nothing else to do for main.
      const existingPill = cellToPill.get(el);
      if (existingPill) {
        renderTrailingPills(el, existingPill, data, key);
        ensureRepositionLoop();
        return;
      }
      // decoratedKey says up-to-date but the main pill is gone. removeAllPills()
      // can only clear decoratedKey for cells that are candidates AT THAT MOMENT
      // (a WeakMap can't be enumerated), so if this cell was transiently absent
      // from pickNameCandidates() during a virtualization recycle, its pill got
      // removed while this flag stayed set. Fall through to recreate instead of
      // trusting the stale flag and leaving the top rows permanently blank.
      lastDecorateStats.selfHealed++;
      console.debug(
        `%c[AOX-TT]%c self-heal: recreated missing pill for "${rawName.slice(0, 40)}"`,
        'background:#0066ff;color:#fff;padding:1px 4px;border-radius:3px',
        'color:#0066ff'
      );
    }

    // Cell got reassigned to a different campaign (virtualization recycle):
    // drop the old pills before creating fresh ones. The trailing pills are
    // tracked separately and must also be dropped or they would orphan once
    // cellToPill is rekeyed.
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
    const staleYest = cellToYesterdayPill.get(el);
    if (staleYest) {
      staleYest.remove();
      cellToYesterdayPill.delete(el);
      decoratedYesterdayKey.delete(el);
    }

    let pill = null;
    if (pillVis.cohort) {
      pill = document.createElement('span');
      if (data.ambiguous) {
        pill.className = 'adjust-pill adjust-pill-ambiguous';
        pill.title = formatAmbiguousTooltip(data);
      } else {
        pill.className = `adjust-pill adjust-pill-${classifyForColor(data.roas)}`;
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
      // Track the widest main pill so the Today pill column gets a fixed slot
      // wide enough to clear every main pill — keeps both columns straight.
      if (pill._aoxWidth > maxMainPillWidth) maxMainPillWidth = pill._aoxWidth;
      positionPillToCell(el, pill);

      cellToPill.set(el, pill);
      decoratedKey.set(el, key);
    } else {
      // Cohort pill off: clear its dedup flag so re-enabling the checkbox
      // repaints instead of stale-skipping this cell forever.
      decoratedKey.delete(el);
    }

    renderTrailingPills(el, pill, data, key);

    ensureRepositionLoop();
  }

  // Today + yesterday pills, each independently gated. Both are SEPARATE
  // position:fixed siblings with their own tracking Maps; their dedup WeakMaps
  // make repeated calls cheap, and every failure path bumps a lastTodayStats
  // counter rather than throwing.
  //
  // The else-branches are load-bearing, not defensive noise: TikTok recycles
  // cell nodes across rows, so a pill left behind after its checkbox was
  // unticked would be re-adopted by whatever campaign lands on that node next.
  function renderTrailingPills(el, mainPill, data, key) {
    if (pillVis.today) {
      maybeRenderTodayPill(el, mainPill, data, key);
    } else {
      const t = cellToTodayPill.get(el);
      if (t) { t.remove(); cellToTodayPill.delete(el); }
      decoratedTodayKey.delete(el);
    }

    if (pillVis.yesterday) {
      maybeRenderYesterdayPill(el, cellToTodayPill.get(el) || mainPill, data, key);
    } else {
      const y = cellToYesterdayPill.get(el);
      if (y) { y.remove(); cellToYesterdayPill.delete(el); }
      decoratedYesterdayKey.delete(el);
    }
  }

  // Cache the column ancestor per leaf cell. DOM structure for a row is
  // stable for the life of the cell, so re-walking 8 ancestors with
  // getBoundingClientRect on every rAF tick is wasted work. WeakMap means
  // entries auto-evict when TikTok virtualizes the cell out of the DOM.
  const cellColumnCache = new WeakMap();

  // Single table-wide anchors so every pill lines up in one straight vertical
  // column instead of staggering by each row's own column-ancestor right edge
  // (the per-cell heuristic returns slightly different ancestors row to row).
  // Recomputed once per decorate pass; the rAF loop reuses them so the column
  // stays put on vertical scroll. maxMainPillWidth only grows, reserving a
  // fixed slot for the main pill so the Today pill column never overlaps it.
  let mainPillAnchorX = null;
  let maxMainPillWidth = 0;
  // Widest today pill seen this session — reserves the today column's slot so
  // the yesterday column starts clear of it. Grows only, like maxMainPillWidth:
  // shrinking it mid-session would make the columns jitter as rows scroll.
  let maxTodayPillWidth = 0;

  // Median (not max) of the visible name cells' column right edges: robust to
  // the occasional row where findColumnAncestor walks up to an over-wide
  // wrapper, which a max would let drag every pill far to the right.
  function computeMainPillAnchorX() {
    const rights = [];
    for (const cell of pickNameCandidates()) {
      const r = cell.getBoundingClientRect();
      if (r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
      const column = getColumnAncestor(cell);
      rights.push(column ? column.getBoundingClientRect().right : r.right);
    }
    if (rights.length === 0) return null;
    rights.sort((a, b) => a - b);
    const mid = rights[Math.floor(rights.length / 2)];
    return Math.round(mid + 6);
  }

  function positionPillToCell(cell, pill) {
    const r = cell.getBoundingClientRect();
    const offscreen = r.width === 0 || r.height === 0
      || r.bottom < 0 || r.top > window.innerHeight;
    // Horizontal: anchor every main pill to the SAME table-wide x so they form
    // one straight vertical column. Fall back to this cell's own column right
    // edge only before the first pass computes the shared anchor. Vertical:
    // still keyed off the leaf cell so each pill matches its own row.
    let left;
    if (mainPillAnchorX != null) {
      left = mainPillAnchorX;
    } else {
      const column = getColumnAncestor(cell);
      const colRight = column ? column.getBoundingClientRect().right : r.right;
      left = Math.round(colRight + 6);
    }
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
  //
  // Tracked as the requestAnimationFrame HANDLE (not a bare boolean) so a
  // suspended-then-dropped frame — which a long tab-hide or machine sleep can
  // cause — can be cancelAnimationFrame'd and rescheduled cleanly on return.
  // A boolean guard would get stuck "true" with no live frame, leaving the loop
  // permanently dead (pills stop following scroll) and impossible to revive
  // without risking a double-schedule. 0 means "no frame scheduled".
  let rafHandle = 0;
  const lastPositioned = new WeakMap(); // cell → {left, top, hidden}

  // Cells with at least one live pill. cellToPill is a SUPERSET of the two
  // trailing maps whenever the cohort pill is enabled (decorateCandidate
  // creates it first), so the common path returns its keys directly with no
  // per-frame allocation. Only when the cohort pill is toggled off — where a
  // row can have a today/yesterday pill and no main pill — do we pay for the
  // union. Iterating cellToPill alone in that state would leave the trailing
  // pills frozen at stale coordinates and unreaped.
  function livePillCells() {
    if (pillVis.cohort) return cellToPill.keys();
    const cells = new Set(cellToPill.keys());
    for (const cell of cellToTodayPill.keys()) cells.add(cell);
    for (const cell of cellToYesterdayPill.keys()) cells.add(cell);
    return cells;
  }

  function hasLivePills() {
    return cellToPill.size > 0 || cellToTodayPill.size > 0 || cellToYesterdayPill.size > 0;
  }

  function repositionLoopTick() {
    rafHandle = 0;
    if (!hasLivePills()) return;

    for (const cell of livePillCells()) {
      const pill = cellToPill.get(cell);
      // Anchor cell left the DOM (virtualized out / table rebuilt) — reap its
      // floating pills. dropPillFor is shared with gcDisconnectedPills so this
      // teardown can't drift from the decorate-time sweep.
      if (!cell.isConnected) { dropPillFor(cell); continue; }
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
      if (pill) {
        positionPillToCell(cell, pill);
      } else {
        // No cohort pill on this row (toggled off). positionPillToCell is what
        // normally records the prefilter entry, so record it here instead —
        // otherwise `prev` stays undefined forever and every frame re-runs the
        // full positioning path for every visible row.
        lastPositioned.set(cell, {
          left: mainPillAnchorX != null ? mainPillAnchorX : r.right,
          top, hidden: offscreen, cellRight: r.right,
        });
      }
      const todayPill = cellToTodayPill.get(cell);
      if (todayPill) positionTodayPillToCell(cell, pill, todayPill);
      const yestPill = cellToYesterdayPill.get(cell);
      if (yestPill) positionYesterdayPillToCell(cell, todayPill || pill, yestPill);
    }

    if (hasLivePills()) {
      rafHandle = requestAnimationFrame(repositionLoopTick);
    }
  }

  function ensureRepositionLoop() {
    if (rafHandle || !hasLivePills()) return;
    rafHandle = requestAnimationFrame(repositionLoopTick);
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
    if (entry && !entry.ambiguous) {
      lastDecorateStats.resolvedByName++;
      return entry;
    }

    // Reach here on BOTH a true name miss (campaign renamed on the TikTok side
    // so its current name isn't in the Adjust index) AND an ambiguous name
    // match. Either way, resolve by the row's own id via the page-world bridge:
    // Adjust keys its rows by the stable campaign/adgroup/ad id, which survives
    // a UI rename, so this is the only path that rescues renamed campaigns.
    const hit = lookupBridgeRowHit(el);
    if (hit) {
      const id = level === 'campaign' ? hit.c
               : level === 'adset'    ? hit.s
               :                        hit.a;
      if (id) {
        const direct = byId.get(id);
        if (direct) {
          lastDecorateStats.resolvedByBridgeId++;
          if (!entry) {
            // Checklog: a climbing rescuedRenamed counter means more campaigns
            // were renamed away from their Adjust names — expected after bid
            // edits, but a sudden spike to ~all rows means the name index or
            // bridge id space drifted and name matching silently died.
            lastDecorateStats.rescuedRenamed++;
            console.debug(
              `%c[AOX-TT]%c bridge-id rescued renamed/missing row "${(el.textContent || '').slice(0, 48)}" → ${direct.campaignName}`,
              'background:#0066ff;color:#fff;padding:1px 4px;border-radius:3px',
              'color:#0066ff'
            );
          }
          return direct;
        }
        if (byComposite && hit.c) {
          // adset/ad: bridge gave us the id, but byId may be empty if the
          // captured id space doesn't match. Try (campId :: name) composite
          // when bridge ALSO supplies the campaign id (`c`) as a sibling hint.
          const m = byComposite.get(`${hit.c}::${key}`);
          if (m) {
            lastDecorateStats.resolvedByBridgeId++;
            return m;
          }
        }
      }
    }

    // Bridge couldn't resolve. Fall back to the ambiguous aggregate if we had
    // one; a true name miss with no bridge hit has nothing to render.
    if (entry) {
      lastDecorateStats.stillAmbiguous++;
      return entry;
    }
    return null;
  }

  // ---- Pill helpers (kept compatible with content/meta-injector.css) ----
  function classifyForColor(roas) {
    // Whole-pill background only escalates to red when d7 is below the
    // user-configured pause threshold (default 30% — "unacceptable"). For
    // anything above that, the pill stays neutral and per-segment coloring
    // (see fillPillSegments) carries the granular signal.
    const primary = roas.d7 ?? roas.allTime;
    if (primary == null) return 'unknown';
    if (primary < colorThresholds.pause) return 'pause';
    return 'hold';
  }

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
  // Banner is a small draggable badge that toggles into a details panel on
  // click. Position persists to localStorage so the user keeps it where they
  // moved it. showBanner() only updates content + status color; the DOM and
  // event wiring is built once on first call.
  function showBanner(text, level) {
    let banner = document.getElementById('adjust-overlay-banner');
    if (!banner) banner = createBanner();
    banner.classList.remove('adjust-banner-ok', 'adjust-banner-warn', 'adjust-banner-error');
    banner.classList.add(`adjust-banner-${level}`);
    const panel = banner.querySelector('.adjust-banner-panel');
    if (panel) panel.textContent = text;
    banner.title = text;
  }

  function createBanner() {
    const banner = document.createElement('div');
    banner.id = 'adjust-overlay-banner';
    banner.classList.add('adjust-banner-collapsed');

    const badge = document.createElement('span');
    badge.className = 'adjust-banner-badge';
    badge.textContent = 'A';

    const panel = document.createElement('div');
    panel.className = 'adjust-banner-panel';

    const close = document.createElement('span');
    close.className = 'adjust-banner-close';
    close.textContent = '×';
    close.title = 'Collapse';

    banner.appendChild(badge);
    banner.appendChild(panel);
    banner.appendChild(close);

    restoreBannerPosition(banner);
    attachBannerInteractions(banner, close);
    document.body.appendChild(banner);
    return banner;
  }

  function restoreBannerPosition(banner) {
    try {
      const pos = JSON.parse(localStorage.getItem('adjust-banner-pos') || 'null');
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        banner.style.left = pos.left + 'px';
        banner.style.top = pos.top + 'px';
        banner.style.right = 'auto';
        banner.style.bottom = 'auto';
      }
    } catch { /* ignore */ }
  }

  // Distinguish click vs drag via a 3px movement threshold. Below threshold
  // → toggle expanded/collapsed. Above → reposition the banner and persist
  // the new coordinates so reload restores them.
  function attachBannerInteractions(banner, closeEl) {
    let dragging = false;
    let pendingClick = false;
    let dragStartX = 0, dragStartY = 0, initialLeft = 0, initialTop = 0;

    banner.addEventListener('mousedown', (e) => {
      if (e.target === closeEl) {
        banner.classList.remove('adjust-banner-expanded');
        banner.classList.add('adjust-banner-collapsed');
        e.stopPropagation();
        return;
      }
      pendingClick = true;
      dragging = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = banner.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      e.preventDefault();

      const onMove = (ev) => {
        const dx = ev.clientX - dragStartX;
        const dy = ev.clientY - dragStartY;
        if (!dragging && Math.hypot(dx, dy) > 3) {
          dragging = true;
          pendingClick = false;
        }
        if (dragging) {
          banner.style.left = Math.max(0, initialLeft + dx) + 'px';
          banner.style.top = Math.max(0, initialTop + dy) + 'px';
          banner.style.right = 'auto';
          banner.style.bottom = 'auto';
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragging) {
          const r = banner.getBoundingClientRect();
          try {
            localStorage.setItem('adjust-banner-pos', JSON.stringify({ left: r.left, top: r.top }));
          } catch { /* ignore quota errors */ }
        } else if (pendingClick) {
          banner.classList.toggle('adjust-banner-expanded');
          banner.classList.toggle('adjust-banner-collapsed');
        }
        pendingClick = false;
        dragging = false;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function buildBannerText() {
    const ageMin = Math.round((Date.now() - lastSyncAt) / 60000);
    const base = `Adjust [TikTok]: ${campaignIndex.size} campaigns / ${adsetIndex.size} ad sets / ${adIndex.size} ads · synced ${ageMin}m ago · ${sourceLabel}`;
    const lines = [base];
    // Today-pill banner lines (at most one). Priority: column-missing wins
    // over off-date wins over currency-mismatch wins over abbreviation. Each
    // higher-priority condition gates EVERY row, so surfacing it first avoids
    // the user fixing a per-row issue while a global block still hides pills.
    const t = lastTodayStats;
    if (!pillVis.cohort && !pillVis.today && !pillVis.yesterday) {
      lines.push(`ⓘ All pills are hidden — re-enable them in the extension popup ("Pills shown").`);
    } else if (!t.columnFound && (pillVis.today || pillVis.yesterday)) {
      lines.push(`⚠ Today ROAS disabled — enable the "Cost" / "Spend" column in this TikTok view.`);
    } else if (t.ttDateIsYesterday && t.yestCaptured > 0) {
      // Parked on Yesterday to harvest spend. The today pill IS off-date here,
      // but saying so reads as a failure at the exact moment the yesterday
      // capture is doing its job — report the capture instead.
      lines.push(`ⓘ Đang ở view Yesterday — đã bắt spend hôm qua cho ${t.yestCaptured} dòng. Quay lại Today để xem ROAS realtime.`);
    } else if (t.ttDateIsToday === false && pillVis.today) {
      const label = t.ttDateLabel || 'unknown';
      lines.push(`⚠ Today ROAS not computed — TikTok UI date range is "${label}". Switch to Today for live ROAS.`);
    } else if (t.skippedCurrencyMismatch > 0 && t.pillsRendered === 0) {
      const adj = t.adjustCurrencyExample || '?';
      const tt = t.detectedTikTokCurrency || '?';
      lines.push(`⚠ Today ROAS unavailable — Adjust app currency (${adj}) ≠ TikTok ad-account currency (${tt}).`);
    } else if (t.skippedAbbreviated > 0 && t.pillsRendered === 0) {
      lines.push(`⚠ Today ROAS disabled — disable TikTok's number abbreviation to read cost cells.`);
    } else if (pillVis.yesterday && t.yestNeedSpend > 0 && t.pillsYesterday === 0) {
      lines.push(`⚠ Yesterday ROAS chưa có spend — ghé date range ${yesterdayLocalIsoDate()} một lần để extension đọc cost cell.`);
    }
    return lines.join('\n');
  }

  function decorateAllVisibleRows() {
    // `selfHealed` is a checklog signal: it counts cells whose decoratedKey
    // flag said "pill exists" but cellToPill had none, forcing a recreate.
    // Steady-state it should hover near 0; a sustained climb means the pill
    // anchor/dedup invariant is breaking again (the v0.4.4 recycle bug) — watch
    // it in DOM diagnostics instead of re-hunting the symptom from scratch.
    lastDecorateStats = { candidates: 0, matched: 0, resolvedByName: 0, resolvedByBridgeId: 0, stillAmbiguous: 0, selfHealed: 0, rescuedRenamed: 0, gcOrphans: 0, gcLeaked: 0 };
    lastTodayStats = createEmptyTodayStats();
    rowYBuckets = null;
    // Sweep stale pills BEFORE decorating, independent of the rAF janitor.
    // gcDisconnectedPills drops pills whose cell virtualized out; sweepUntracked
    // removes any leaked .adjust-pill node. Without this, a day-rollover refresh
    // (MutationObserver path, no removeAllPills) leaves previous-day pills
    // stacked under the new pass while the tab's rAF loop is suspended.
    lastDecorateStats.gcOrphans = gcDisconnectedPills();
    lastDecorateStats.gcLeaked = sweepUntrackedPills();
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
    lastTodayStats.ttDateIsYesterday = currentTikTokDate.isYesterday;
    lastTodayStats.ttDateLabel = currentTikTokDate.label;
    lastTodayStats.ttDateSource = currentTikTokDate.source;

    // Compute the shared pill column anchor BEFORE decorating so the very
    // first pill in this pass already lands in the straight column.
    mainPillAnchorX = computeMainPillAnchorX();

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
    for (const [cell, pill] of cellToYesterdayPill) pill.remove();
    cellToYesterdayPill.clear();
    document.querySelectorAll('.adjust-pill').forEach(p => p.remove());
    pickNameCandidates().forEach(el => {
      decoratedKey.delete(el);
      decoratedTodayKey.delete(el);
      // Omitting this one lets a recycled virtualized row stale-skip the
      // yesterday pill into permanent absence — the same class of bug the
      // v0.4.4 recycle regression was.
      decoratedYesterdayKey.delete(el);
    });
  }

  // Single source of truth for tearing down a cell's pills + bookkeeping. Both
  // the rAF reposition loop (disconnect branch) and gcDisconnectedPills call
  // this so the cleanup steps can never drift apart — this exact set of deletes
  // regressed once before (the v0.4.4 recycle bug) when one call site forgot to
  // clear decoratedKey. Idempotent: safe to call for a cell with no pill.
  function dropPillFor(cell) {
    const pill = cellToPill.get(cell);
    if (pill) { pill.remove(); cellToPill.delete(cell); }
    lastPositioned.delete(cell);
    // Clear the main-pill dedup flag too. TikTok recycles the same DOM node
    // object across rows, so leaving decoratedKey set would make the next
    // decorate pass believe a pill still exists and skip recreating it — the
    // recycled top rows would render blank.
    decoratedKey.delete(cell);
    const todayPill = cellToTodayPill.get(cell);
    if (todayPill) {
      todayPill.remove();
      cellToTodayPill.delete(cell);
      decoratedTodayKey.delete(cell);
    }
    const yestPill = cellToYesterdayPill.get(cell);
    if (yestPill) {
      yestPill.remove();
      cellToYesterdayPill.delete(cell);
      decoratedYesterdayKey.delete(cell);
    }
  }

  // Drop every tracked pill whose anchor cell has left the DOM (TikTok
  // virtualized the row out). Our pills are position:fixed body children, so a
  // detached cell leaves its pill floating at its last coordinates until
  // something removes it. The rAF loop does this per frame — but rAF is
  // SUSPENDED while the tab is backgrounded, and TikTok still refreshes its own
  // table across a day rollover (date-filter flip / auto-reload) via the
  // MutationObserver path, which does NOT call removeAllPills(). Without a
  // decorate-time sweep those stale pills hang around and the new pass renders
  // fresh pills on top of them — the "stacked previous-day pills" symptom. The
  // second loop catches a today pill whose cell left cellToPill but lingered in
  // cellToTodayPill (bookkeeping drift), so the pair can never desync into an
  // orphan. Returns count removed.
  function gcDisconnectedPills() {
    let removed = 0;
    for (const [cell] of cellToPill) {
      if (cell.isConnected) continue;
      dropPillFor(cell);
      removed++;
    }
    for (const [cell, pill] of cellToTodayPill) {
      if (cell.isConnected) continue;
      pill.remove();
      cellToTodayPill.delete(cell);
      decoratedTodayKey.delete(cell);
      removed++;
    }
    for (const [cell, pill] of cellToYesterdayPill) {
      if (cell.isConnected) continue;
      pill.remove();
      cellToYesterdayPill.delete(cell);
      decoratedYesterdayKey.delete(cell);
      removed++;
    }
    return removed;
  }

  // Belt to gcDisconnectedPills's suspenders: remove any .adjust-pill node no
  // longer referenced by either tracking Map. Such a node is genuinely leaked
  // — a Map entry got overwritten without removing the old node, or a node
  // escaped a prior removeAllPills query. Build the live set once per pass
  // (visible-row count, cheap). Runs at the TOP of a decorate pass, before any
  // new pill is created, so every legitimate pill is already in the Maps and
  // only true orphans are swept. Returns count removed.
  function sweepUntrackedPills() {
    const live = new Set();
    for (const pill of cellToPill.values()) live.add(pill);
    for (const pill of cellToTodayPill.values()) live.add(pill);
    for (const pill of cellToYesterdayPill.values()) live.add(pill);
    let removed = 0;
    document.querySelectorAll('.adjust-pill').forEach(node => {
      if (!live.has(node)) { node.remove(); removed++; }
    });
    return removed;
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

  // ---- Pill visibility (per type, from the popup) ----
  // NOTE: the old in-page floating "ROAS pill: ON/OFF" button (a binary
  // hide-all toggle backed by localStorage under 'aox-tt-pills-hidden') was
  // removed in v0.5.0 for parity with meta-injector v0.9.0. It hid every
  // `.adjust-pill` with one CSS !important rule, so it could not distinguish
  // pill types — and a stale '1' left in a user's localStorage would have
  // silently hidden pills the new checkboxes say are ON, with no popup
  // affordance to recover. Visibility is now per-type and controlled from the
  // popup's "Pills shown" checkboxes (chrome.storage.local.pillVisibility
  // .tiktok), gated at decoration time in decorateCandidate. Unchecking all
  // three is the new "hide everything".
  //
  // migratePillsHiddenLegacy() below removes the dead localStorage key and any
  // <style> node an older build left behind, so upgrading users are not stuck
  // with invisible pills.
  let pillVis = { cohort: true, today: true, yesterday: false };

  async function loadPillVisibility() {
    try {
      const { pillVisibility } = await chrome.storage.local.get('pillVisibility');
      const t = pillVisibility?.tiktok || {};
      pillVis = {
        cohort:    typeof t.cohort    === 'boolean' ? t.cohort    : true,
        today:     typeof t.today     === 'boolean' ? t.today     : true,
        yesterday: typeof t.yesterday === 'boolean' ? t.yesterday : false,
      };
    } catch { /* keep defaults */ }
  }

  // One-shot cleanup of the pre-v0.5.0 hide mechanism. Idempotent and cheap;
  // runs before the first decorate so no frame ever paints under the stale
  // blanket-hide style.
  function migratePillsHiddenLegacy() {
    let hadLegacy = false;
    try {
      if (localStorage.getItem('aox-tt-pills-hidden') !== null) {
        localStorage.removeItem('aox-tt-pills-hidden');
        hadLegacy = true;
      }
    } catch { /* ignore */ }
    const staleStyle = document.getElementById('aox-pill-hide-style');
    if (staleStyle) { staleStyle.remove(); hadLegacy = true; }
    const staleBtn = document.getElementById('aox-pill-toggle');
    if (staleBtn) { staleBtn.remove(); hadLegacy = true; }
    if (hadLegacy) {
      console.log(
        `%c[AOX-TT]%c migrated legacy hide-all toggle → popup per-type checkboxes`,
        'background:#0066ff;color:#fff;padding:1px 4px;border-radius:3px',
        'color:#0066ff'
      );
    }
  }

  // ---- Init ----
  // Drop the pre-v0.5.0 blanket-hide artifacts before anything paints.
  migratePillsHiddenLegacy();

  // Load thresholds AND pill visibility first so the very first decoration
  // uses user-configured colors and renders exactly the enabled pill types —
  // rather than briefly painting with defaults and re-painting.
  Promise.all([loadColorThresholds(), loadPillVisibility()]).then(() => {
    // Checklog: which pill types this page will actually paint. "0 pills"
    // reports that used to mean a broken matcher can now legitimately mean
    // three unticked checkboxes — this line settles it without a code dive.
    console.log(
      `%c[AOX-TT ${INJECTOR_VERSION}]%c pills enabled → ` +
      `cohort:${pillVis.cohort ? 'on' : 'OFF'} ` +
      `today:${pillVis.today ? 'on' : 'OFF'} ` +
      `yesterday:${pillVis.yesterday ? 'on' : 'OFF'}`,
      'background:#0066ff;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
      'color:#0066ff'
    );
    loadData();
  });

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
    // Data-level retry: the first GET_CACHED can lose a race with a cold
    // service worker and return null, so loadData() bails before building any
    // index. Without this, the DOM-level retry below would only ever decorate
    // against empty indices (0 matches) until the user manually reloaded.
    // Keep reloading until a real cache lands; loadData() decorates on success.
    if (!dataLoaded) {
      loadData();
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
    } else if (changes.dataSourceConfig) {
      // Reporting offset / app tokens changed → yesterday captures were tagged
      // under the old config's calendar day and may no longer line up with
      // what Adjust now calls "yesterday". Drop them rather than divide a
      // stale spend into fresh revenue.
      ttYestSpendCache.clear();
      removeAllPills();
      decorateAllVisibleRows();
    } else if (changes.pillVisibility) {
      // Full teardown + repaint. Incremental diffing would have to reason
      // about which of the three pill types changed AND about cells recycled
      // by TikTok's virtualizer since the last pass — not worth it for a
      // click-frequency event.
      loadPillVisibility().then(() => {
        removeAllPills();
        decorateAllVisibleRows();
      });
    }
  });

  // The rAF reposition loop — our per-frame orphan janitor — is SUSPENDED while
  // the tab is hidden. TikTok can refresh its table across a day rollover while
  // backgrounded, detaching the cells our pills anchor to; those pills then
  // float at stale coordinates with no live loop to reap them. The moment the
  // tab is visible again, sweep synchronously so the user never sees yesterday's
  // pills stacked under today's, then debounce a full re-decorate (which also
  // restarts the reposition loop). Both sweeps are idempotent and cheap.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    gcDisconnectedPills();
    sweepUntrackedPills();
    // The rAF frame that was pending when we were hidden may have been dropped
    // by the browser, leaving rafHandle set but no live loop. Cancel it (a
    // no-op if it already fired or was dropped) and reset, so the schedule
    // below installs exactly one fresh frame and pills resume following scroll.
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    ensureRepositionLoop();
    scheduleDecorate();
  });
})();
