// content/meta-injector.js
// Injects multi-window ROAS pills into Meta Ads Manager campaign rows.
//
// === FACEBOOK ACCOUNT SAFETY ===
// This script is engineered to have ZERO impact on the user's Meta/Facebook
// account beyond appending visual-only DOM nodes that Facebook's React tree
// does not own. Specifically:
//
//   READ-ONLY of Meta DOM:
//     ✓ querySelector + textContent (no innerHTML reads of forms)
//     ✗ NEVER reads cookies, localStorage, sessionStorage, IndexedDB
//     ✗ NEVER reads auth tokens, access_token URL params, or DOM input values
//
//   NO MUTATION of Meta-owned elements:
//     ✓ Pills inserted as SIBLINGS via insertBefore — never inside a
//       Meta-managed container, never as replacement of a Meta node.
//     ✗ NEVER sets attributes (class, style, dataset, aria-*) on any element
//       Facebook rendered. Decoration tracking lives in a JS WeakMap so the
//       DOM observed by Facebook's React reconciler is unmodified.
//     ✗ NEVER calls .click(), .focus(), .dispatchEvent(), .submit() on
//       anything.
//
//   NO NETWORK to facebook.com:
//     ✗ NEVER calls fetch / XMLHttpRequest to any facebook.com host. The
//       extension's manifest host_permissions only includes adjust.com, so
//       even if we tried, Chrome would block it.
//     ✗ NEVER imports scripts, images, or iframes from third parties.
//
//   NO FACEBOOK-VISIBLE BEHAVIOR CHANGE:
//     ✓ Page interactions (clicks, scrolling, navigation) work exactly as
//       Facebook ships them — we do not capture, intercept, or rewrite events.
//
// Strategy: text-driven matching. Meta has dropped ARIA grid/row roles, so
// scoped grid selectors no longer work. Instead we walk every truncated-text
// container (`div.ellipsis`, a stable Meta utility class) and check whether
// its text matches a known Adjust campaign name. No false positives unless
// some other UI element happens to render an exact campaign-name string.

(function () {
  'use strict';

  // Bump on every change to confirm the page is running the freshly-reloaded
  // build (page console logs this on every diagnostic dump). Format: vMAJOR.
  // MINOR.PATCH. Bump PATCH for fixes, MINOR for new strategies/fields.
  const INJECTOR_VERSION = 'v0.7.1-idkey-namespace';
  console.log(`[Adjust Overlay] meta-injector loaded ${INJECTOR_VERSION}`);

  // ---- Embedded copy of matcher logic (content scripts can't easily import modules) ----
  // ⚠️ KEEP IN SYNC WITH src/matcher.js. If you change normalization rules here
  // without updating that file (or vice versa), content-side keys will diverge
  // from background-side keys and pills will stop matching. See header comment
  // in src/matcher.js for the full rationale.
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

  // div.ellipsis is Meta's text-truncation utility. Verified 2026-05-07 via
  // DOM inspection: campaign names render inside such a div one level above
  // their innermost SPAN. Other truncated text (account names, breadcrumbs)
  // also matches this selector — the campaign-name lookup filters those out.
  const NAME_CANDIDATE_SELECTOR = 'div.ellipsis';

  let campaignIndex = new Map();
  let adsetIndex = new Map();
  let adIndex = new Map();
  // Composite indexes keyed by `${metaCampaignId}::${nameKey}` to disambiguate
  // when the same ad-name or adset-name appears in multiple campaigns. The
  // campaign id comes from Adjust's attr_dependency.campaign_id_network and
  // matches Meta's selected_campaign_ids URL param exactly.
  let adsetCompositeIndex = new Map();
  let adCompositeIndex = new Map();
  // Direct ID lookups keyed by Meta IDs that Adjust supplies via attr_dependency
  // (creative_id_network → Meta ad_id, adgroup_id_network → Meta adset_id).
  // When Meta's row React props expose those same digit IDs, we resolve the
  // Adjust entry without touching name keys at all — the most reliable
  // disambiguation path because it's invariant under any name normalization.
  let adByIdIndex = new Map();
  let adsetByIdIndex = new Map();
  let lastSyncAt = null;
  let sourceLabel = '';

  // Color thresholds — overridable per-platform from popup Settings. Defaults
  // mirror what the popup writes when the user hasn't customized yet.
  let colorThresholds = { pause: 0.30, red: 0.60, green: 1.00 };

  let bodyObserver = null;
  let decorateTimer = null;
  // Tracks which campaign key each ellipsis div is currently decorated for.
  // WeakMap keyed by Meta-owned DOM nodes — does NOT mutate those nodes (no
  // dataset/class/attribute changes), so React's reconciler is unaffected.
  // Entries auto-evict when Meta removes the node from the DOM.
  const decoratedKey = new WeakMap();
  // Parallel WeakMap for the today pill (sibling next to the main pill). Kept
  // separate so today-pill churn does not invalidate the main pill's dedup.
  const decoratedTodayKey = new WeakMap();

  // Row-Y bucket index, valid only inside one decorateAllVisibleRows() pass.
  // Built lazily on first ambiguous lookup, cleared at the end of the pass.
  // Meta uses a frozen-column table layout: the Ad-name cell (left frozen
  // panel) and the Campaign-name / Campaign-ID cells (right scrollable panel)
  // do NOT share a parent — they sit in entirely separate DOM subtrees that
  // only meet at the table root. Walking up the DOM never reaches them
  // before crossing other rows. They DO share a vertical Y coordinate
  // because Meta aligns them visually. Bucketing by Y at decoration time
  // makes "find the same row's other cells" an O(1) lookup.
  let rowYBuckets = null;
  const ROW_BUCKET_PX = 8;

  // Disambiguation tally for the last decorateAllVisibleRows() pass. Logged
  // by logDomDiagnostics() instead of recomputed there, so diagnostics is
  // O(N) instead of O(N × walk).
  let lastDecorateStats = {
    ambiguous: 0,
    resolvedByScope: 0,
    resolvedByAdjustId: 0,
    resolvedByMetaPreload: 0,
    resolvedByDom: 0,
    stillAmbiguous: 0,
  };

  // Today-pill stats for the last decorate pass. Used by buildBannerText to
  // surface column-missing / currency-mismatch issues, and by diagnostics.
  let lastTodayStats = {
    columnFound: false,
    columnHeaderText: null,
    columnX: null,
    pillsRendered: 0,
    pillsRenderedOffDate: 0,
    skippedNoSpendCell: 0,
    skippedZeroSpend: 0,
    skippedCurrencyMismatch: 0,
    skippedNoAdjustData: 0,
    skippedAmbiguous: 0,
    skippedAbbreviated: 0,
    skippedOffDate: 0,
    sampleSpend: null,
    sampleRevToday: null,
    detectedMetaCurrency: null,
    adjustCurrencyExample: null,
    sampleRowCandidates: null,
    metaDateIsToday: null,
    metaDateLabel: null,
    metaDateSource: null,
  };
  // Per-pass cache: { childIndex, headerX, panelRoot, headerEl } or null.
  let currentSpendColumn = null;
  // Per-pass cache for the Meta UI date filter detection (URL-driven). The
  // today-pill ratio is only meaningful when Meta UI's date picker = Today —
  // the spend cell value reflects whatever range the user has active. Detected
  // from URL params at decorate-pass start; see detectMetaUiDateInfo().
  let currentMetaDate = null;

  // Meta preloads campaign/ad structure as JSON inside <script> tags BEFORE
  // rendering the table — specifically `campaign_structure_tree` payloads,
  // one per filtered campaign. Each tree exposes the campaign_id alongside
  // its nested adgroup_id + name pairs, giving us a direct ad-name →
  // campaign_id mapping for every ad currently in the user's view. This
  // bypasses all DOM fragility (frozen columns, virtualized cells, varying
  // class names, line-clamp wrappers).
  //
  // metaPreloadIndex.byName        : Map<nameKey, Set<campId>>
  // metaPreloadIndex.byAdgroupId   : Map<adgroupId, campId>
  // metaPreloadIndex.parsedAt      : timestamp
  // metaPreloadIndex.urlFingerprint: window.location.search at parse time;
  //   invalidates the cache when the user changes filters.
  let metaPreloadIndex = {
    byName: new Map(),
    byAdgroupId: new Map(),
    parsedAt: 0,
    urlFingerprint: '',
  };

  async function loadColorThresholds() {
    try {
      const { colorThresholds: stored } = await chrome.storage.local.get('colorThresholds');
      const t = stored?.meta;
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

      // Cached rows come at three levels: 'campaign' (one row per campaign,
      // pulled directly with dimensions=campaign_network), 'adset' (one row
      // per adset, pulled with dimensions=campaign_network,adgroup_network),
      // and 'ad' (one row per ad, pulled with all four dimensions). Campaign
      // names are unique per account so campaignIndex never collides. Ad
      // names and ad set names routinely repeat across campaigns (e.g.
      // "MVideo 2003" reused in 20 campaigns), so for those we also build
      // composite (campaignId::name) indexes — used when the user has drilled
      // into a specific campaign and Meta's URL exposes ?selected_campaign_ids=ID.
      const campaignRows = cached.campaigns.filter(r => r.level === 'campaign');
      const adsetRows = cached.campaigns.filter(r => r.level === 'adset');
      const adRows = cached.campaigns.filter(r => r.level === 'ad');

      campaignIndex = buildDirectIndex(campaignRows, r => r.campaignName);
      // Adset index built from adset-level Adjust rows directly — one row per
      // adset, no creative-level rollup. This eliminates the attribution-shadow
      // double-count bug where a stale today-row with creative_id_network=null
      // gets summed alongside the resolved creative_id row.
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

      // Post-build: attach revenueToday + adjustCurrency onto each index entry
      // by summing the per-row `revenueToday` field that data-source.js merged
      // in. Kept as a separate pass so we never modify the signatures of the
      // existing buildDirectIndex / buildAdIndex / buildAggregatedIndex /
      // aggregateRoas functions — diff stays additive.
      attachTodayMetrics(campaignRows, adsetRows, adRows);

      // Push the freshly-built id sets to the page-world bridge so it knows
      // which digit strings to look for on subsequent row scans.
      dispatchBridgeKnownIds();

      showBanner(buildBannerText(), cached.isStale ? 'warn' : 'ok');
      // Clear before redecorating — otherwise after a sync, existing pills
      // would short-circuit the dedup check and keep showing stale ROAS.
      removeAllPills();
      ensureObserving();
      decorateAllVisibleRows();
      logDomDiagnostics();
    } catch (err) {
      // Extension context invalidated etc. - fail silently in content script,
      // user will see the issue when they click the popup.
      console.warn('[Adjust Overlay] loadData failed:', err.message);
    }
  }

  // Direct index: 1 row per name. Used for campaigns where names ARE unique.
  // (Ads use buildAdIndex below because their names regularly collide.)
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

  // Ad index with collision handling. Returns:
  //   byName:      Map<adKey, AdEntry | AmbiguousEntry>
  //   byComposite: Map<`${campaignId}::${adKey}`, AdEntry>  (always unique)
  //   byAdId:      Map<MetaAdId, AdEntry>  (Adjust creative_id_network)
  // AmbiguousEntry shape:
  //   { ambiguous: true, candidates: Row[], campaignName, roas (aggregated), ... }
  function buildAdIndex(adRows) {
    const byName = new Map();
    const byComposite = new Map();
    const byAdId = new Map();
    const collisions = new Set();
    const accums = new Map(); // adKey -> all rows for that name

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
        // Echo parent context for the ambiguous tooltip. Not shown in pill.
        parentCampaignName: row.campaignName,
        parentAdsetName: row.adsetName,
        campaignId: row.campaignId,
        adsetId: row.adsetId || null,
        adId: row.adId || null,
      };

      if (row.campaignId) {
        byComposite.set(`${row.campaignId}::${k}`, single);
      }
      if (row.adId) {
        byAdId.set(String(row.adId), single);
      }

      if (!byName.has(k)) {
        byName.set(k, single);
        accums.set(k, [row]);
      } else {
        collisions.add(k);
        accums.get(k).push(row);
      }
    }

    // Convert collisions to ambiguous entries with aggregated metrics so the
    // pill at least shows a sane "across all duplicates" number.
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

  // Aggregated index for ad sets. As of the adset-level Adjust fetch, rows
  // arrive at adset granularity directly (one row per adset) — but this
  // builder still groups by canonical adsetName so cross-campaign name
  // collisions ("2003 Italy" in 8 campaigns) get marked ambiguous and
  // resolved via the page-bridge ID lookup. When `getId` is provided, also
  // builds a direct ID lookup (Adjust's adgroup_id_network → Meta adset_id)
  // for name-free disambiguation.
  function buildAggregatedIndex(rows, getName, getId) {
    const byName = new Map();
    const byComposite = new Map();
    const byId = new Map();
    const composites = new Map(); // `${campId}::${k}` -> rows[]
    const flats = new Map();      // k -> rows[]
    const idGroups = new Map();   // metaId -> rows[]

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

  // Sum cost and back-computed cohort revenue across rows, divide at the end.
  // Aggregating ROAS this way correctly weights each row by its cost; naive
  // averaging would treat a $0.10 ad and a $1000 ad as equally important.
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
  // Today pill — Meta UI spend × Adjust today revenue
  // ============================================================
  //
  // Adds a SECOND pill (sibling of the main pill) showing realtime ROAS for
  // today: numerator = Adjust gross revenue today (all cohorts), denominator
  // = the row's "Amount spent" cell read directly from Meta Ads Manager. The
  // existing D0/3d/7d/All pill is untouched.
  //
  // Why split numerator/denominator across sources:
  //   - Meta UI shows realtime spend (single source of truth, no MMP lag).
  //   - Adjust knows revenue from purchase events; Meta's reported revenue
  //     is the very signal this whole extension was built to bypass.
  //
  // Safety: spend reading is pure textContent of Meta's existing cells (no
  // attribute writes, no event dispatch, no React-prop walk — that's why we
  // don't go through page-bridge here). Currency parsing is read-only.

  // Header text Meta uses for the "Amount spent" column across locales.
  // Keys are canonicalKey'd at construction. Add more locales as users
  // surface them — failure is graceful (column-missing banner) rather than
  // silent miscoluming.
  const SPEND_HEADER_KEYS = new Set([
    canonicalKey('Amount spent'),
    canonicalKey('Số tiền đã chi'),
    canonicalKey('Số tiền đã tiêu'),
    canonicalKey('Montant dépensé'),
    canonicalKey('Importe gastado'),
    canonicalKey('Betrag ausgegeben'),
    canonicalKey('Importo speso'),
    canonicalKey('Bedrag besteed'),
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

  // Aggregate revenueToday + adjustCurrency from the merged rows onto each
  // index entry that decorate-time lookups will return. Mirrors how each
  // index keys its rows in buildDirectIndex / buildAdIndex / buildAggregatedIndex,
  // so the same rows route to the same entries — no re-indexing.
  //
  // CRITICAL: buildAdIndex shares the SAME entry object across byName /
  // byComposite / byAdId for non-collision ads. Naive multi-index bumping
  // would triple-count the same row's revenue onto the same object. We
  // guard with a per-row `visited` WeakSet so each unique entry object is
  // bumped at most once per row. (buildAggregatedIndex constructs distinct
  // objects per index so the guard is a no-op for adsets — harmless.)
  function attachTodayMetrics(campaignRows, adsetRows, adRows) {
    for (const r of campaignRows) {
      if (!r.campaignName) continue;
      bumpToday(campaignIndex, canonicalKey(r.campaignName), r, new WeakSet());
    }
    // Adset today metrics come from adset-level Adjust rows directly. We do
    // NOT sum ad-level rows into adsetIndex here — that produced inflated
    // totals when Adjust returned creative_id=null shadow rows during
    // real-time attribution finalization.
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
    if (!e.adjustCurrency && row.adjustCurrency) e.adjustCurrency = row.adjustCurrency;
    e.todayRowExisted = e.todayRowExisted || !!row.todayRowExisted;
  }

  // Skip-tag list for full-DOM leaf scans. Same rationale as ensureRowYBuckets:
  // SCRIPT/STYLE leaves carry source text that never renders; SVG-internal
  // nodes have rects but never display row data.
  const HEADER_SCAN_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
    'META', 'LINK', 'TITLE', 'HEAD',
    'SVG', 'PATH', 'CIRCLE', 'RECT', 'POLYGON', 'G', 'DEFS', 'USE',
  ]);

  // Locate the Meta "Amount spent" header cell once per decorate pass.
  // Returns { headerEl, headerX } on success, null otherwise. The header X
  // mid-pixel is the column anchor used to find each row's spend cell.
  //
  // We deliberately match on header TEXT rather than column index because
  // Meta's table is split into a frozen-left and scrollable-right panel
  // whose DOM trees aren't siblings; child-indexed walks across that split
  // are brittle. The Y-bucket lookup the existing injector already uses
  // gracefully handles cross-panel cells via shared Y, and X-matching the
  // column gives the right cell in the right panel.
  //
  // Scan scope: every leaf element, not just `div.ellipsis`. Header text is
  // short and doesn't need truncation, so Meta renders it WITHOUT the
  // ellipsis utility class — the data-cell selector misses it. Same scan
  // pattern ensureRowYBuckets uses (full leaf walk minus skip tags).
  function locateAmountSpentColumn() {
    let bestHeader = null;
    let bestY = Infinity;
    for (const el of document.querySelectorAll('*')) {
      if (HEADER_SCAN_SKIP_TAGS.has(el.tagName)) continue;
      if (el.children.length > 0) continue; // leaf only
      const raw = el.textContent || '';
      if (!raw || raw.length > 60) continue; // headers are short
      const k = canonicalKey(raw);
      let matched = SPEND_HEADER_KEYS.has(k);
      if (!matched && raw.match(/[.…]+$/)) {
        // Header may be truncated at narrow column widths ("Amount sp…").
        const prefix = k.replace(/[.…\s]+$/, '');
        if (prefix.length >= 6) {
          for (const hk of SPEND_HEADER_KEYS) {
            if (hk.startsWith(prefix)) { matched = true; break; }
          }
        }
      }
      if (!matched) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.top < 0) continue;
      // Header rows sit at the top of the table; pick the topmost match.
      if (r.top < bestY) { bestY = r.top; bestHeader = el; }
    }
    if (!bestHeader) return null;
    // Walk up from the text leaf to find the column header CELL container.
    // The text leaf alone may be narrow (e.g. "Amount spent" text is left-
    // aligned in a wider cell). The cell container's X range is what
    // matters for matching data cells (which may be right-aligned numbers
    // in the same column). Heuristic: prefer the widest ancestor under
    // ~400px wide and ~80px tall, within a few levels up.
    let cellAncestor = bestHeader;
    let cellRect = bestHeader.getBoundingClientRect();
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
      headerEl: cellAncestor,
      headerLeft: cellRect.left,
      headerRight: cellRect.right,
      headerX: (cellRect.left + cellRect.right) / 2,
      headerWidth: cellRect.width,
      headerText: (bestHeader.textContent || '').trim().slice(0, 40),
    };
  }

  // Read this row's spend cell text. Returns the raw text (caller parses).
  // Strategy: among same-row Y-bucket cells whose text passes the currency
  // filter, pick the one whose X mid is NEAREST to the column header's X.
  // No threshold — the closest currency cell to the Amount-spent column
  // header IS the spend cell by definition. Threshold-based filters proved
  // too fragile across header/data alignment differences and column-walk-up
  // ambiguity.
  function findSpendCellText(nameEl) {
    if (!currentSpendColumn) return null;
    const rowRange = getRowYRange(nameEl);
    const buckets = ensureRowYBuckets();
    const rowMid = (rowRange.top + rowRange.bottom) / 2;
    const rowMidKey = Math.round(rowMid / ROW_BUCKET_PX);
    const halfHeight = (rowRange.bottom - rowRange.top) / 2;
    const bucketSpan = Math.max(1, Math.ceil(halfHeight / ROW_BUCKET_PX));

    const headerX = currentSpendColumn.headerX;

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
        // Capture the first row's same-row candidates so logDomDiagnostics
        // can dump them. Helps diagnose "spend never reads" without DOM
        // round-tripping.
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
  // design — final parsing happens in parseCurrencyCell.
  function looksLikeCurrency(txt) {
    if (/^[–—-]$/.test(txt)) return true; // em-dash empty cell
    // Must contain a digit and either a currency symbol, ISO code, or
    // thousands/decimal separator. Reject pure percent / pure integer < 4
    // digits (likely a count column).
    if (!/\d/.test(txt)) return false;
    if (/%$/.test(txt)) return false;
    if (/[\$€£¥₫₹₩฿₱₪₺₽]/.test(txt)) return true;
    if (/\b(USD|EUR|GBP|JPY|VND|INR|KRW|THB|PHP|ILS|TRY|RUB|AUD|CAD|MXN|BRL|CHF|SEK|NOK|DKK|PLN|TWD|HKD|SGD|MYR|IDR|CNY|NZD)\b/i.test(txt)) return true;
    // Bare number with thousands grouping or decimal — accept if it's wide
    // enough to plausibly be money rather than a count.
    if (/\d[.,]\d/.test(txt) && txt.length >= 4) return true;
    return false;
  }

  // Parse Meta UI currency cell text. Returns { value, currency, parsed }:
  //   value    — number, possibly negative, or null when not parseable.
  //   currency — ISO 3-letter code (best-effort), or null if undetectable.
  //   parsed   — false for abbreviations ($1.2K), empty/dash cells, or
  //              unsupported numeral systems. Caller must handle.
  //
  // Format support:
  //   US-style "$1,234.56" "$0.05" — comma thousands, dot decimal.
  //   EU-style "1.234,56 €" "€ 1.234,56" — dot thousands, comma decimal.
  //   No-decimal "1.234.567 ₫" "¥1,234" — every separator is thousands.
  //   Negative "-$1.23" "($1.23)" "−$1.23" (U+2212).
  //   ISO suffix "1,234.56 USD" "1.234,56 EUR".
  function parseCurrencyCell(text) {
    if (!text) return { value: null, currency: null, parsed: false };
    const trimmed = text.trim();
    if (!trimmed || /^[–—-]$/.test(trimmed)) {
      return { value: null, currency: null, parsed: false };
    }
    // Reject abbreviated values (K / M / B). Banner advises user to disable.
    if (/\d[\s]?[KMB]\b/i.test(trimmed)) {
      return { value: null, currency: null, parsed: false, abbreviated: true };
    }
    // Reject non-ASCII numeral systems for v1.
    if (/[٠-٩۰-۹०-९]/.test(trimmed)) {
      return { value: null, currency: null, parsed: false };
    }

    // Detect currency by symbol or ISO code, before stripping anything.
    let currency = null;
    for (const ch of trimmed) {
      if (SYMBOL_TO_ISO[ch]) { currency = SYMBOL_TO_ISO[ch]; break; }
    }
    if (!currency) {
      const iso = trimmed.match(/\b([A-Z]{3})\b/);
      if (iso) currency = iso[1];
    }

    // Negativity: leading `-`, leading `−` (U+2212), or wrapped in parens.
    let negative = false;
    let cleaned = trimmed;
    if (/^\(.*\)$/.test(cleaned)) { negative = true; cleaned = cleaned.slice(1, -1); }
    if (/^[-−]/.test(cleaned)) { negative = true; cleaned = cleaned.replace(/^[-−]/, ''); }

    // Strip currency symbols, ISO codes, whitespace (incl. NBSP / narrow NBSP).
    cleaned = cleaned
      .replace(/[\$€£¥₫₹₩฿₱₪₺₽]/g, '')
      .replace(/\b[A-Z]{3}\b/g, '')
      .replace(/[   \s]/g, '')
      .trim();

    if (!/^[\d.,]+$/.test(cleaned)) {
      return { value: null, currency, parsed: false };
    }

    // Decide separator role. Zero-decimal currencies treat ALL separators as
    // thousands. Otherwise: the rightmost separator is decimal if it's
    // followed by exactly 1–2 digits AND there is no later separator.
    const isZeroDecimal = currency && ZERO_DECIMAL_CURRENCIES.has(currency);
    let numericStr;
    if (isZeroDecimal) {
      numericStr = cleaned.replace(/[.,]/g, '');
    } else {
      const lastDot = cleaned.lastIndexOf('.');
      const lastComma = cleaned.lastIndexOf(',');
      const lastSep = Math.max(lastDot, lastComma);
      const decimalChar = lastSep === lastDot ? '.' : ',';
      const fractionLen = lastSep >= 0 ? cleaned.length - lastSep - 1 : -1;
      if (lastSep >= 0 && fractionLen >= 1 && fractionLen <= 2) {
        // Treat lastSep as decimal point, every OTHER separator as thousands.
        const intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, '');
        const fracPart = cleaned.slice(lastSep + 1);
        numericStr = `${intPart}.${fracPart}`;
      } else {
        // No decimal — every separator is thousands.
        numericStr = cleaned.replace(/[.,]/g, '');
      }
    }

    const value = parseFloat(numericStr);
    if (!Number.isFinite(value)) return { value: null, currency, parsed: false };
    return { value: negative ? -value : value, currency, parsed: true };
  }

  // Detect whether Meta UI's date filter is set to "Today". The spend cell
  // value reflects this filter, so the today-pill ratio (Adjust today rev /
  // Meta spend) is only meaningful when the filter = Today. When it isn't,
  // the render path falls back to a warn variant showing rev only.
  //
  // Returns: { isToday: bool, label: string, source: 'preset'|'range+preset'|'range'|'absent'|'error' }
  // - source='preset'        : URL has date_preset=...
  // - source='range+preset'  : URL has date=YYYY-MM-DD_YYYY-MM-DD,<preset>
  //                            (Meta appends the preset keyword to the range
  //                            when the user clicks a preset like "Today" —
  //                            the suffix is the source of truth, not the
  //                            date range, which can be stale from before the
  //                            user clicked the preset)
  // - source='range'         : URL has bare date=YYYY-MM-DD_YYYY-MM-DD (custom range)
  // - source='absent'        : neither param present (Meta default is unknowable client-side)
  // - source='error'         : URLSearchParams threw
  // When source='absent' we conservatively report isToday=false so we never
  // silently divide by some other date's spend; user clicks Today to opt in.
  function detectMetaUiDateInfo() {
    try {
      const params = new URLSearchParams(window.location.search);
      const preset = params.get('date_preset');
      if (preset) {
        return { isToday: preset === 'today', label: preset, source: 'preset' };
      }
      const range = params.get('date');
      if (range) {
        // Meta encodes the picker as `<dateRange>` optionally followed by
        // `,<preset>` when the user clicked a preset chip (Today, Yesterday,
        // Last 7 days, Maximum, etc). Observed 2026-05-11: clicking "Today"
        // produced `date=2026-05-07_2026-05-08,today` where the date portion
        // was a stale range and `today` was the active preset. The suffix
        // wins — that's what Meta's UI shows in the picker label.
        const commaIdx = range.indexOf(',');
        if (commaIdx !== -1) {
          const presetSuffix = range.slice(commaIdx + 1).trim();
          if (presetSuffix) {
            return {
              isToday: presetSuffix === 'today',
              label: presetSuffix,
              source: 'range+preset',
            };
          }
        }
        const datePart = commaIdx === -1 ? range : range.slice(0, commaIdx);
        const m = datePart.match(/^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/);
        if (m) {
          const start = m[1], end = m[2];
          const todayStr = todayLocalIsoDate();
          if (start === todayStr && end === todayStr) {
            return { isToday: true, label: 'today', source: 'range' };
          }
          const label = start === end ? start : `${start}…${end}`;
          return { isToday: false, label, source: 'range' };
        }
        return { isToday: false, label: range, source: 'range' };
      }
      return { isToday: false, label: 'unknown', source: 'absent' };
    } catch {
      return { isToday: false, label: 'unknown', source: 'error' };
    }
  }

  function todayLocalIsoDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Render the today pill next to the main pill. ALWAYS renders when the
  // Amount-spent column is found and the row is not ambiguous — even when
  // revenue or spend is missing/zero, the pill shows `rev/spend` so the user
  // can SEE the pipeline state instead of guessing why nothing appeared.
  // Skip cases that bump counters but don't render: ambiguous row, column
  // missing, abbreviated cell (can't parse), currency mismatch.
  function maybeRenderTodayPill(nameEl, mainPill, data, mainKey) {
    if (!data || data.ambiguous) { lastTodayStats.skippedAmbiguous++; return; }
    if (!currentSpendColumn) return; // banner handles user messaging

    const rev = (data.revenueToday == null) ? null : data.revenueToday;
    const adjCcy = data.adjustCurrency;

    // Off-date variant: Meta UI is not on Today, so the spend cell isn't
    // today's spend and dividing would mislead. Render rev-only warn pill so
    // the pipeline-state-visible rule still holds (user can see Adjust side
    // is alive). Skip the spend-cell read entirely — its value is correct for
    // some other date range and reading it would only confuse diagnostics.
    if (currentMetaDate && !currentMetaDate.isToday) {
      const todayKey = `${mainKey}|offdate:${currentMetaDate.label}|rev:${rev}|a:${adjCcy || ''}`;
      if (decoratedTodayKey.get(nameEl) === todayKey) return;

      const possibleStale = mainPill.nextElementSibling;
      if (possibleStale?.classList?.contains('adjust-pill-today') ||
          possibleStale?.classList?.contains('adjust-pill-today-mismatch') ||
          possibleStale?.classList?.contains('adjust-pill-today-offdate')) {
        possibleStale.remove();
      }

      const todayPill = document.createElement('span');
      todayPill.className = 'adjust-pill adjust-pill-today-offdate';
      todayPill.textContent =
        `Today rev${adjCcy ? ` (${adjCcy})` : ''}: ${formatMoneyOrDash(rev)} ` +
        `(Meta on ${currentMetaDate.label})`;
      todayPill.title =
        `Today ROAS not computed — Meta UI date filter is "${currentMetaDate.label}".\n` +
        `Spend cell reflects that range, not today's spend, so dividing would mislead.\n` +
        `Switch Meta UI date picker to "Today" for live ROAS.\n` +
        (rev != null
          ? `Adjust today rev${adjCcy ? ` (${adjCcy})` : ''}: ${formatMoneyOrDash(rev)}`
          : `Adjust has no revenue for this row today yet.`);

      mainPill.parentNode.insertBefore(todayPill, mainPill.nextSibling);
      decoratedTodayKey.set(nameEl, todayKey);
      lastTodayStats.pillsRenderedOffDate++;
      lastTodayStats.skippedOffDate++;
      if (lastTodayStats.sampleRevToday == null && rev != null) lastTodayStats.sampleRevToday = rev;
      if (!lastTodayStats.adjustCurrencyExample && adjCcy) lastTodayStats.adjustCurrencyExample = adjCcy;
      return;
    }

    const spendText = findSpendCellText(nameEl);
    let spend = null;
    let metaCcy = null;
    let spendUnreadable = false;
    if (spendText != null) {
      const parsed = parseCurrencyCell(spendText);
      if (parsed.abbreviated) {
        lastTodayStats.skippedAbbreviated++;
        spendUnreadable = true;
      } else if (parsed.parsed && parsed.value != null) {
        spend = parsed.value;
        metaCcy = parsed.currency;
      } else {
        spendUnreadable = true;
      }
    }

    if (lastTodayStats.sampleSpend == null && spend != null) lastTodayStats.sampleSpend = spend;
    if (lastTodayStats.detectedMetaCurrency == null && metaCcy) lastTodayStats.detectedMetaCurrency = metaCcy;
    if (lastTodayStats.sampleRevToday == null && rev != null) lastTodayStats.sampleRevToday = rev;
    if (!lastTodayStats.adjustCurrencyExample && adjCcy) lastTodayStats.adjustCurrencyExample = adjCcy;
    if (spend == null && !spendUnreadable && spendText == null) lastTodayStats.skippedNoSpendCell++;

    const currencyMismatch = metaCcy && adjCcy && metaCcy !== adjCcy;

    // Dedup key includes everything that drives render content.
    const todayKey = `${mainKey}|rev:${rev}|spend:${spend}|m:${metaCcy || ''}|a:${adjCcy || ''}|mm:${currencyMismatch}`;
    if (decoratedTodayKey.get(nameEl) === todayKey) return;

    const possibleStale = mainPill.nextElementSibling;
    if (possibleStale?.classList?.contains('adjust-pill-today') ||
        possibleStale?.classList?.contains('adjust-pill-today-mismatch') ||
        possibleStale?.classList?.contains('adjust-pill-today-offdate')) {
      possibleStale.remove();
    }

    const todayPill = document.createElement('span');

    if (currencyMismatch) {
      todayPill.className = 'adjust-pill adjust-pill-today-mismatch';
      todayPill.textContent = `Today: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)} (${adjCcy}→${metaCcy})`;
      todayPill.title =
        `Today ROAS unavailable — cross-currency.\n` +
        `Adjust app revenue (${adjCcy}): ${formatMoneyOrDash(rev)}\n` +
        `Meta ad-account spend (${metaCcy}): ${formatMoneyOrDash(spend)}\n` +
        `Refusing to divide across currencies (would mislead).`;
      lastTodayStats.skippedCurrencyMismatch++;
    } else {
      todayPill.className = 'adjust-pill adjust-pill-today';
      todayPill.textContent = '';
      todayPill.appendChild(document.createTextNode(
        `Today: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)}`
      ));
      if (rev != null && spend != null && spend > 0) {
        const roas = rev / spend;
        todayPill.appendChild(document.createTextNode(' '));
        const valSpan = document.createElement('span');
        valSpan.textContent = pct(roas);
        if (roas < 0.60) valSpan.className = 'adjust-rv-red';
        else if (roas > 1.00) valSpan.className = 'adjust-rv-green';
        todayPill.appendChild(valSpan);
      }
      todayPill.title = formatTodayTooltip(rev, spend, metaCcy || adjCcy || '?', adjCcy, data);
      lastTodayStats.pillsRendered++;
    }

    mainPill.parentNode.insertBefore(todayPill, mainPill.nextSibling);
    decoratedTodayKey.set(nameEl, todayKey);
  }

  function formatMoneyOrDash(n) {
    if (n == null || !Number.isFinite(n)) return '–';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatTodayTooltip(rev, spend, displayCcy, adjCcy, data) {
    const ageMin = lastSyncAt ? Math.round((Date.now() - lastSyncAt) / 60000) : null;
    const lines = [
      `Today realtime ROAS`,
      `Rev (Adjust today${adjCcy ? `, ${adjCcy}` : ''}): ${formatMoney(rev)}`,
      `Spend (Meta UI${displayCcy ? `, ${displayCcy}` : ''}): ${formatMoney(spend)}`,
    ];
    if (ageMin != null) lines.push(`Adjust sync age: ${ageMin}m`);
    if (!data.todayRowExisted) {
      lines.push(`Note: no cohort data for this row (new today?)`);
    }
    return lines.join('\n');
  }

  function formatMoney(n) {
    if (n == null || !Number.isFinite(n)) return '–';
    // Two-decimal display; rounding happens here only.
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function logDomDiagnostics() {
    const candidates = document.querySelectorAll(NAME_CANDIDATE_SELECTOR);
    let firstMatch = null;
    let matchCount = 0;
    let matchedLevel = null;
    for (const el of candidates) {
      const text = el.textContent || '';
      const k = canonicalKey(text);
      const lvl = adIndex.has(k) ? 'ad' : adsetIndex.has(k) ? 'adset' : campaignIndex.has(k) ? 'campaign' : null;
      if (lvl) {
        matchCount++;
        if (!firstMatch) { firstMatch = text.slice(0, 120); matchedLevel = lvl; }
      }
    }

    // Stats come from the decoration pass that just finished — diagnostics
    // does NOT redo the disambiguation work. This used to be done inline here,
    // doubling the per-pass cost on pages with many ambiguous rows.
    let ambiguousCount = 0;
    for (const e of adIndex.values()) if (e?.ambiguous) ambiguousCount++;
    const scope = getScopedCampaignIds();
    // Sample one Adjust adId so we can verify ID space alignment with Meta
    // tree's adgroup_id quickly when triaging F (resolvedByAdjustId).
    let sampleAdjustAdId = null;
    let sampleAdjustAdsetId = null;
    for (const e of adByIdIndex.values()) { sampleAdjustAdId = e?.adId; break; }
    for (const e of adsetByIdIndex.values()) {
      // adset entry has no adsetId field; we just need to know one key exists.
      sampleAdjustAdsetId = adsetByIdIndex.keys().next().value;
      break;
    }

    // bridgeProbe: did the page-world bridge load, receive id sets, and
    // find hits in the current viewport? Surfaces the F (resolvedByAdjustId)
    // pipeline state without re-walking React props from the isolated world
    // (which always returns zero — see findEntryViaAdjustId comment).
    const bridgeProbe = probeBridge();

    console.log('[Adjust Overlay] DOM diagnostics', {
      version: INJECTOR_VERSION,
      candidateSelector: NAME_CANDIDATE_SELECTOR,
      candidatesFound: candidates.length,
      matchedToAdjustNames: matchCount,
      firstMatchText: firstMatch,
      firstMatchLevel: matchedLevel,
      indexSizes: {
        campaign: campaignIndex.size,
        adset: adsetIndex.size,
        ad: adIndex.size,
        adById: adByIdIndex.size,
        adsetById: adsetByIdIndex.size,
      },
      sampleAdjustAdId,
      sampleAdjustAdsetId,
      adNamesAmbiguousInIndex: ambiguousCount,
      urlScopedCampaignIds: scope ? [...scope] : null,
      lastDecoratePass: { ...lastDecorateStats },
      bridgeProbe,
      today: { ...lastTodayStats },
    });
  }

  // Probe the page-world bridge: read the data node it writes, count how
  // many ambiguous rows the bridge resolved, and return a sample so we can
  // diagnose end-to-end without re-walking React props from this isolated
  // world (which would always fail — see findEntryViaAdjustId comment).
  function probeBridge() {
    const node = document.getElementById('aox-bridge-data');
    if (!node) return { error: 'aox-bridge-data node not found — bridge not loaded?' };
    let payload;
    try { payload = JSON.parse(node.textContent || '{}'); } catch (e) { return { error: 'bad JSON in bridge data: ' + e.message }; }

    const ambKeys = new Set();
    for (const [k, v] of adIndex) if (v?.ambiguous) ambKeys.add(k);

    const ambiguousRowsInDom = [];
    for (const el of document.querySelectorAll(NAME_CANDIDATE_SELECTOR)) {
      const k = canonicalKey(el.textContent || '');
      if (!ambKeys.has(k)) continue;
      ambiguousRowsInDom.push((el.textContent || '').trim());
    }

    const hits = Array.isArray(payload?.results) ? payload.results : [];
    const matchedAmbiguous = hits.filter(h => ambiguousRowsInDom.includes(h.t));

    return {
      bridgeVersion: payload?.version,
      bridgeAgeMs: payload?.timestamp ? Date.now() - payload.timestamp : null,
      bridgeKnownAdIds: payload?.knownAdIdsSize,
      bridgeKnownAdsetIds: payload?.knownAdsetIdsSize,
      bridgeRowsScanned: payload?.scanned,
      bridgeRowsHit: payload?.hits,
      sampleHits: hits.slice(0, 6),
      ambiguousInDomCount: ambiguousRowsInDom.length,
      ambiguousMatchedByBridge: matchedAmbiguous.length,
      ambiguousMatchedSample: matchedAmbiguous.slice(0, 6),
    };
  }

  // ---- Decorate one candidate ----
  // Place pill as a SIBLING (not child) of the ellipsis div, because the
  // ellipsis container clips overflowing children — a pill appended inside
  // would get truncated. Also: inserting a sibling means we never modify any
  // Meta-owned element (the parent's children list does change, but we never
  // touch attributes of Facebook nodes).
  function decorateCandidate(el) {
    const rawName = el.textContent || '';
    if (rawName.length < 5 || rawName.length > 300) return;
    const key = canonicalKey(rawName);
    // Try most specific first (ad), then ad set, then campaign. Meta's three
    // tabs only ever render one of these names per row, so collisions across
    // levels (same string used as both a campaign name and an ad name) are
    // rare. If they do happen, ad wins because it's the actionable unit.
    const data =
      lookupAmbiguousAware(el, key, adIndex, adCompositeIndex, adByIdIndex, 'ad') ||
      lookupAmbiguousAware(el, key, adsetIndex, adsetCompositeIndex, adsetByIdIndex, 'adset') ||
      campaignIndex.get(key);
    if (!data) return;

    // Self-healing dedup via WeakMap: if Meta replaces el, its WeakMap entry
    // auto-clears and we re-decorate. NOTE: today pill has an INDEPENDENT
    // dedup map (decoratedTodayKey) and must be allowed to render/refresh
    // on every pass even when the main pill is already current — column
    // header may not have been visible on the first pass.
    let pill;
    const mainCurrent = decoratedKey.get(el) === key;
    if (mainCurrent) {
      // Reuse the existing main pill as the today-pill anchor. el.nextSibling
      // is the main pill (today pill, if present, lives at pill.nextSibling).
      const sibling = el.nextElementSibling;
      if (sibling?.classList?.contains('adjust-pill') &&
          !sibling.classList.contains('adjust-pill-today') &&
          !sibling.classList.contains('adjust-pill-today-mismatch')) {
        pill = sibling;
      }
    }
    if (!pill) {
      // First decoration for this key, or main pill was removed. Build fresh.
      const stalePill = el.nextElementSibling;
      if (stalePill?.classList?.contains('adjust-pill')) {
        stalePill.remove();
      }
      pill = document.createElement('span');
      if (data.ambiguous) {
        pill.className = 'adjust-pill adjust-pill-ambiguous';
        pill.title = formatAmbiguousTooltip(data);
      } else {
        pill.className = `adjust-pill adjust-pill-${classifyForColor(data.roas)}`;
        pill.title = formatTooltip(data);
      }
      fillPillSegments(pill, data.roas);
      el.parentNode.insertBefore(pill, el.nextSibling);
      decoratedKey.set(el, key);
    }

    // Today pill is a SEPARATE sibling inserted after the main pill. ALWAYS
    // attempt; its own decoratedTodayKey WeakMap dedups so repeated calls
    // are cheap. Failure paths bump lastTodayStats counters but never throw.
    maybeRenderTodayPill(el, pill, data, key);
  }

  // Resolve an ambiguous index entry to a single (campaignId, name) match
  // using a chain of strategies. Returns the resolved entry, the original
  // ambiguous entry as a fallback, or null when the name isn't indexed.
  //
  // Strategy 1 — URL scope:
  //   When the user drilled into a single campaign, Meta puts
  //   ?selected_campaign_ids=ID in the URL. Composite-index lookup is exact.
  //
  // Strategy 2 — Adjust ID from row React props via page bridge:
  //   Adjust's attr_dependency carries Meta's ad_id (creative_id_network)
  //   and adset_id (adgroup_id_network). The MAIN-world page bridge walks
  //   each row's `__reactProps`/`__reactFiber` and reports any digit string
  //   in our id maps. We resolve the Adjust entry by ID directly — no name
  //   matching, no Meta tree, and works regardless of which Meta columns
  //   the user has currently enabled.
  //
  // Strategy 3 — Meta preload structure tree by ad name:
  //   Meta loads each filtered campaign's `campaign_structure_tree` as JSON
  //   inside <script> tags BEFORE rendering the table. We parse those once
  //   to build ad-name → Set<campaign_id>. Because the tree only contains
  //   campaigns Meta actually loaded for the current view, the set is often
  //   already a singleton; otherwise we narrow by intersecting with Adjust's
  //   candidate campaigns and (when present) urlScopedCampaignIds.
  //
  // Strategy 4 — DOM row context (Y-position match):
  //   Last resort. Look for a Meta campaign id (15–19 digits) or full
  //   campaign name in another cell on the same visual row. Requires the
  //   user to have a Campaign-name or Campaign-ID column visible.
  //
  // If nothing resolves, we return the ambiguous aggregate so the user at
  // least sees a (clearly-flagged) totals pill rather than nothing.
  function lookupAmbiguousAware(el, key, byName, byComposite, byId, kind) {
    const entry = byName.get(key);
    if (!entry) return null;
    if (!entry.ambiguous) return entry;

    lastDecorateStats.ambiguous++;

    const scope = getScopedCampaignIds();
    if (scope && scope.size === 1) {
      const onlyId = scope.values().next().value;
      const m = byComposite.get(`${onlyId}::${key}`);
      if (m) {
        lastDecorateStats.resolvedByScope++;
        return m;
      }
    }

    if (byId && byId.size > 0) {
      const direct = findEntryViaAdjustId(el, byId, kind);
      if (direct) {
        lastDecorateStats.resolvedByAdjustId++;
        return direct;
      }
    }

    const metaPreloadCampId = findCampaignIdViaMetaPreload(key, entry.candidates);
    if (metaPreloadCampId) {
      const m = byComposite.get(`${metaPreloadCampId}::${key}`);
      if (m) {
        lastDecorateStats.resolvedByMetaPreload++;
        return m;
      }
    }

    const rowCampaignId = findRowCampaignIdByYPosition(el, entry.candidates);
    if (rowCampaignId) {
      const m = byComposite.get(`${rowCampaignId}::${key}`);
      if (m) {
        lastDecorateStats.resolvedByDom++;
        return m;
      }
    }

    lastDecorateStats.stillAmbiguous++;
    return entry;
  }

  // Resolve an Adjust ad/adset entry for `nameEl` by reading the page-bridge
  // result table. We do NOT scan React props here: in an isolated content
  // script `Object.keys(domEl)` cannot see the page world's `__reactProps`
  // expandos, so the walk would always return zero. The bridge runs in
  // MAIN world (manifest content_scripts.world: "MAIN"), reads the props,
  // and writes hits to <script id="aox-bridge-data">. We refresh that
  // table once per decorate pass via dispatchBridgeScan().
  function findEntryViaAdjustId(nameEl, byId, kind) {
    const hit = lookupBridgeRowHit(nameEl);
    if (!hit) return null;
    const id = kind === 'adset' ? hit.s : hit.a;
    if (!id) return null;
    return byId.get(id) || null;
  }

  // Per-pass cache: parse the bridge data once and reuse for every row in
  // the current decorate pass. The bridge writes a flat JSON envelope; we
  // index `results[]` by `${text}|${roundedYBucket}` so per-row lookup is
  // O(1). The cache invalidates when bridgeScanToken changes (set by
  // dispatchBridgeScan after each scan).
  let bridgeScanToken = 0;
  let bridgeIndex = null;
  let bridgeIndexToken = -1;

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
    // Exact text + rounded Y bucket. We probe the exact bucket plus ±1 to
    // tolerate sub-pixel jitter between when the bridge measured and when
    // the content script reads.
    for (let dy = -1; dy <= 1; dy++) {
      const k = `${text}|${y + dy}`;
      const hit = bridgeIndex.get(k);
      if (hit) return hit;
    }
    return null;
  }

  function parseBridgeData() {
    const node = document.getElementById('aox-bridge-data');
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

  function dispatchBridgeKnownIds() {
    document.dispatchEvent(new CustomEvent('aox-set-known-ids', {
      detail: {
        adIds: [...adByIdIndex.keys()],
        adsetIds: [...adsetByIdIndex.keys()],
      },
    }));
  }

  function dispatchBridgeScan() {
    document.dispatchEvent(new CustomEvent('aox-scan-rows'));
    bridgeScanToken++;
  }

  // ---- Meta preload structure tree parser ----
  // Meta Ads Manager ships each filtered campaign's full structure as JSON
  // inside <script> tags. The shape is:
  //
  //   "campaign_structure_tree": {
  //     "children": [{
  //       "adset_id": "...", "name": "<adset name>", "status": "...",
  //       "children": [{
  //         "adgroup_id": "<ad id>", "name": "<ad name>", "status": "..."
  //       }, ...]
  //     }, ...],
  //     "campaign_id": "<camp id>", "name": "<camp name>", "status": "..."
  //   }
  //
  // The OUTER campaign_id is the only one in the tree (adgroups don't have a
  // campaign_id field), so we can extract it with a non-greedy first-match
  // regex. Adgroup pairs are extracted with a flat-block regex because each
  // adgroup object never nests another `{}` between its adgroup_id and name.
  //
  // The cache is keyed by URL search-string fingerprint so changing filters
  // immediately invalidates it (parsedAt TTL covers within-filter mutations).
  function ensureMetaPreloadIndex() {
    const fingerprint = window.location.search;
    const fresh = Date.now() - metaPreloadIndex.parsedAt < 30000;
    const sameFilter = fingerprint === metaPreloadIndex.urlFingerprint;
    if (fresh && sameFilter && metaPreloadIndex.byName.size > 0) {
      return metaPreloadIndex;
    }

    const byName = new Map();        // nameKey -> Set<campId>
    const byAdgroupId = new Map();   // adgroupId -> campId

    const campIdRe = /"campaign_id":"(\d+)"/;
    const adgroupRe = /"adgroup_id":"(\d+)"[^{}]*?"name":"((?:[^"\\]|\\.)*)"/g;

    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      if (text.length < 500) continue;
      if (!text.includes('"campaign_structure_tree"')) continue;

      for (const treeBody of extractStructureTreeBodies(text)) {
        const cm = campIdRe.exec(treeBody);
        if (!cm) continue;
        const campId = cm[1];

        adgroupRe.lastIndex = 0;
        let am;
        while ((am = adgroupRe.exec(treeBody)) !== null) {
          const adgroupId = am[1];
          const rawName = am[2];
          const name = rawName.includes('\\') ? decodeJsonStringEscapes(rawName) : rawName;
          const nameKey = canonicalKey(name);
          if (!nameKey) continue;

          let set = byName.get(nameKey);
          if (!set) { set = new Set(); byName.set(nameKey, set); }
          set.add(campId);

          byAdgroupId.set(adgroupId, campId);
        }
      }
    }

    metaPreloadIndex = {
      byName,
      byAdgroupId,
      parsedAt: Date.now(),
      urlFingerprint: fingerprint,
    };
    return metaPreloadIndex;
  }

  // Walk the script text once to find every `"campaign_structure_tree":{...}`
  // payload, returning each one's body (the chars between its outer braces).
  // The brace counter is string- and escape-aware so we don't get fooled by
  // `}` inside string literals (e.g. names containing punctuation).
  function extractStructureTreeBodies(text) {
    const bodies = [];
    const marker = '"campaign_structure_tree":{';
    let pos = 0;
    while (true) {
      const start = text.indexOf(marker, pos);
      if (start === -1) break;
      const bodyStart = start + marker.length;
      let depth = 1;
      let i = bodyStart;
      let inStr = false;
      let esc = false;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (esc) {
          esc = false;
        } else if (c === '\\') {
          esc = true;
        } else if (c === '"') {
          inStr = !inStr;
        } else if (!inStr) {
          if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        i++;
      }
      if (depth === 0) bodies.push(text.slice(bodyStart, i - 1));
      pos = i;
    }
    return bodies;
  }

  function decodeJsonStringEscapes(s) {
    return s
      .replace(/\\(["\\/])/g, '$1')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }

  // Resolve via Meta's structure tree: ad-name → Set<campaign_id>, narrowed
  // by Adjust's candidate campaigns and (when present) urlScopedCampaignIds.
  //
  // The tree is naturally scoped to the user's filter — Meta only ships trees
  // for campaigns currently loaded — so a name unique within that filter
  // resolves immediately. When the same name appears in multiple in-view
  // campaigns the intersection often still collapses to one (Adjust may
  // only have data for some of them); if not, return null and let DOM
  // Y-position handle it.
  function findCampaignIdViaMetaPreload(nameKey, candidates) {
    const idx = ensureMetaPreloadIndex();
    if (idx.byName.size === 0) return null;

    const treeCampIds = idx.byName.get(nameKey);
    if (!treeCampIds || treeCampIds.size === 0) return null;

    const validCampIds = new Set();
    for (const c of candidates) {
      if (c?.campaignId) validCampIds.add(String(c.campaignId));
    }
    if (validCampIds.size === 0) return null;

    const intersected = [...treeCampIds].filter(id => validCampIds.has(id));
    if (intersected.length === 1) return intersected[0];
    if (intersected.length === 0) return null;

    // Multiple intersect — narrow further by URL scope if available.
    const scope = getScopedCampaignIds();
    if (scope) {
      const narrowed = intersected.filter(id => scope.has(id));
      if (narrowed.length === 1) return narrowed[0];
    }
    return null;
  }

  // Walk up from `nameEl` to find the tallest plausible single-row ancestor.
  // Returns both the ancestor node (used by React-props scan) and its rect
  // (used by Y-bucket lookup). Stops once an ancestor exceeds 200px since
  // that means we've left the row and entered a multi-row container.
  function findRowAncestor(nameEl) {
    const myRect = nameEl.getBoundingClientRect();
    let bestNode = nameEl;
    let bestRect = myRect;
    let node = nameEl.parentElement;
    for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.height > 200) break;
      if (r.height > bestRect.height) {
        bestRect = r;
        bestNode = node;
      }
    }
    return { node: bestNode, rect: bestRect };
  }

  // Lazily build (and cache for the duration of the current decorate pass) a
  // bucketed index of every visible-text leaf on the page, keyed by rounded
  // Y midpoint. ROW_BUCKET_PX is 8 — small enough that a row only ever
  // spans 1–2 buckets, large enough that a typical row occupies a single
  // key. Built once per pass; rebuilt only after pills update.
  //
  // We scan EVERY leaf element rather than a class-based selector. Meta's
  // table markup varies between account views and column configurations:
  // sometimes div.ellipsis, sometimes inline -webkit-line-clamp, sometimes
  // a plain unstyled div. Diagnostics on real accounts (2026-05-07) showed
  // that even `div[style*="line-clamp"]` returns 0 in some views where the
  // outerHTML clearly shows that style elsewhere. A universal leaf scan is
  // the only durable strategy. The length filter (5–300 chars) cheaply
  // rejects structural shells and one-char labels; ID/name matching in
  // findRowCampaignIdByYPosition is exact, so over-bucketing is harmless.
  function ensureRowYBuckets() {
    if (rowYBuckets) return rowYBuckets;
    rowYBuckets = new Map();
    // SKIP_TAGS leaves carry textContent (CSS rules, JS source) that would
    // pollute the bucket index without ever rendering on the page. Also skip
    // SVG-internal nodes — they have rects but never display row data.
    const SKIP_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
      'META', 'LINK', 'TITLE', 'HEAD',
      'SVG', 'PATH', 'CIRCLE', 'RECT', 'POLYGON', 'G', 'DEFS', 'USE',
    ]);
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length < 5 || t.length > 300) continue;
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

  // Vertical range of the row that contains `nameEl`. The ancestor's
  // bounding rect spans the FULL row height (image + name + pill stack),
  // so cells in any column — even those rendered with different vertical
  // alignment in their own column subtree — will have midpoints inside
  // this Y range. Shares the row-ancestor walk with React-props lookup.
  function getRowYRange(nameEl) {
    const { rect } = findRowAncestor(nameEl);
    return { top: rect.top - 2, bottom: rect.bottom + 2 };
  }

  // Find an ID/name match in cells sharing nameEl's row.
  // We try Campaign ID first because it's a 15-19 digit string with no
  // normalization quirks — if the user has the Campaign ID column on, this
  // gives us a perfect, unambiguous match. Campaign name is fallback.
  function findRowCampaignIdByYPosition(nameEl, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const knownIds = new Set();
    const campKeyToId = new Map();
    for (const c of candidates) {
      if (c?.campaignId) {
        const id = String(c.campaignId);
        knownIds.add(id);
        if (c?.campaignName) {
          campKeyToId.set(canonicalKey(c.campaignName), id);
        }
      }
    }
    if (knownIds.size === 0) return null;

    const myRect = nameEl.getBoundingClientRect();
    if (myRect.height === 0) return null;
    const buckets = ensureRowYBuckets();

    // Row Y-range comes from the tallest single-row ancestor of nameEl.
    // Cells anywhere on the page whose midpoint falls inside this range
    // belong to the same row, even when they live in a different column
    // subtree (frozen vs scrollable side of Meta's table).
    const rowRange = getRowYRange(nameEl);
    const rowMid = (rowRange.top + rowRange.bottom) / 2;
    const rowMidKey = Math.round(rowMid / ROW_BUCKET_PX);
    const halfHeight = (rowRange.bottom - rowRange.top) / 2;
    const bucketSpan = Math.max(1, Math.ceil(halfHeight / ROW_BUCKET_PX));

    // First pass: collect same-row cells once, scan for exact ID / name match.
    // Second pass: prefix-match for truncated names (e.g. "Meta LPT 11 ...").
    const sameRow = [];
    for (let dk = -bucketSpan; dk <= bucketSpan; dk++) {
      const bucket = buckets.get(rowMidKey + dk);
      if (!bucket) continue;
      for (const el of bucket) {
        if (el === nameEl) continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        const mid = (r.top + r.bottom) / 2;
        if (mid < rowRange.top || mid > rowRange.bottom) continue;
        sameRow.push(el);
      }
    }

    for (const el of sameRow) {
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      // Exact ID match (cell whose text is just the ID).
      if (knownIds.has(txt)) return txt;
      // Embedded-ID match: cell text might be wrapped (e.g. "Campaign ID: 1202…",
      // a trailing zero-width char) so look for any 15–19 digit substring and
      // check each against knownIds.
      const matches = txt.match(/\d{15,19}/g);
      if (matches) {
        for (const m of matches) {
          if (knownIds.has(m)) return m;
        }
      }
      // Exact name match.
      const ck = canonicalKey(txt);
      const idByName = campKeyToId.get(ck);
      if (idByName) return idByName;
    }

    // Truncation fallback: Meta sometimes renders long campaign names with
    // a literal "..." suffix (JS truncation, not CSS). Match by prefix
    // against indexed campaign keys. Require ≥8 chars to avoid spurious hits.
    for (const el of sameRow) {
      const ck = canonicalKey(el.textContent || '');
      if (!ck) continue;
      const m = ck.match(/^(.+?)\s*(?:\.{2,}|…)\s*$/);
      if (!m) continue;
      const prefix = m[1].trim();
      if (prefix.length < 8) continue;
      for (const [fullKey, id] of campKeyToId) {
        if (fullKey.startsWith(prefix)) return id;
      }
    }
    return null;
  }

  function getScopedCampaignIds() {
    try {
      const params = new URLSearchParams(window.location.search);
      const csv = params.get('selected_campaign_ids');
      if (!csv) return null;
      const ids = csv.split(',').map(s => s.trim()).filter(Boolean);
      return ids.length ? new Set(ids) : null;
    } catch {
      return null;
    }
  }

  function formatAmbiguousTooltip(data) {
    const lines = [
      `⚠ Ambiguous: "${data.campaignName}" appears in ${data.candidates.length} campaigns.`,
      `Pill shows totals across all duplicates.`,
      `To see per-row ROAS: drill into a single campaign,`,
      `or enable the "Campaign name" column in this view.`,
      '',
      'Per-campaign breakdown:',
    ];
    // Largest spend first so the dominant campaign shows up at the top.
    const sorted = [...data.candidates].sort((a, b) => (b.cost || 0) - (a.cost || 0));
    for (const c of sorted.slice(0, 12)) {
      const r = c.roas || {};
      lines.push(
        `  • ${c.campaignName} → spend $${(c.cost || 0).toFixed(2)} | ` +
        `D0 ${pct(r.d0)} D7 ${pct(r.d7)}`
      );
    }
    if (sorted.length > 12) lines.push(`  … and ${sorted.length - 12} more`);
    lines.push('');
    lines.push(`Last sync: ${new Date(lastSyncAt).toLocaleString()}`);
    return lines.join('\n');
  }

  // Build pill content as labelled segments so each ROAS value can be colored
  // individually. Built via createElement (NOT innerHTML) — the campaign data
  // came over chrome.runtime messaging, but defense-in-depth: never inject
  // HTML strings sourced from the network.
  function fillPillSegments(pillEl, { d0, d3, d7, allTime }) {
    pillEl.textContent = '';
    appendSegment(pillEl, 'D0:', d0);
    pillEl.appendChild(document.createTextNode(' '));
    appendSegment(pillEl, '3d:', d3);
    pillEl.appendChild(document.createTextNode(' '));
    appendSegment(pillEl, '7d:', d7);
    pillEl.appendChild(document.createTextNode(' '));
    appendSegment(pillEl, 'All:', allTime);
  }

  function appendSegment(parent, label, value) {
    parent.appendChild(document.createTextNode(label));
    const valSpan = document.createElement('span');
    valSpan.textContent = pct(value);
    if (value != null) {
      if (value < colorThresholds.red) valSpan.className = 'adjust-rv-red';
      else if (value > colorThresholds.green) valSpan.className = 'adjust-rv-green';
    }
    parent.appendChild(valSpan);
  }

  function decorateAllVisibleRows() {
    // Reset stats and Y-buckets at start of pass; the bucket index will be
    // built lazily on the first ambiguous lookup and reused for the rest.
    lastDecorateStats = { ambiguous: 0, resolvedByScope: 0, resolvedByAdjustId: 0, resolvedByMetaPreload: 0, resolvedByDom: 0, stillAmbiguous: 0 };
    lastTodayStats = {
      columnFound: false, columnHeaderText: null, columnX: null,
      pillsRendered: 0, pillsRenderedOffDate: 0,
      skippedNoSpendCell: 0, skippedZeroSpend: 0,
      skippedCurrencyMismatch: 0, skippedNoAdjustData: 0,
      skippedAmbiguous: 0, skippedAbbreviated: 0,
      skippedOffDate: 0,
      sampleSpend: null, sampleRevToday: null,
      detectedMetaCurrency: null, adjustCurrencyExample: null,
      sampleRowCandidates: null,
      metaDateIsToday: null, metaDateLabel: null, metaDateSource: null,
    };
    rowYBuckets = null;
    // Locate the Amount-spent column once per pass. Today-pill rendering is
    // skipped if the column isn't visible.
    currentSpendColumn = locateAmountSpentColumn();
    if (currentSpendColumn) {
      lastTodayStats.columnFound = true;
      lastTodayStats.columnX = Math.round(currentSpendColumn.headerX);
      lastTodayStats.columnHeaderText = currentSpendColumn.headerText;
    }
    // Detect Meta UI's date filter once per pass. When not Today, the today
    // pill renders a warn variant (rev only) instead of dividing by spend
    // that reflects some other date range.
    currentMetaDate = detectMetaUiDateInfo();
    lastTodayStats.metaDateIsToday = currentMetaDate.isToday;
    lastTodayStats.metaDateLabel = currentMetaDate.label;
    lastTodayStats.metaDateSource = currentMetaDate.source;
    // Refresh the page-world bridge's row-id table so findEntryViaAdjustId
    // sees the current viewport. Synchronous: by the time dispatchEvent
    // returns, the bridge's listener has finished writing the data node.
    dispatchBridgeScan();
    document.querySelectorAll(NAME_CANDIDATE_SELECTOR).forEach(decorateCandidate);
    rowYBuckets = null; // release; rects go stale on next mutation anyway
    currentSpendColumn = null;
    currentMetaDate = null;

    // Re-render banner after every pass so it reflects the CURRENT pass
    // stats — not stale stats from loadData's initial showBanner call (which
    // ran before this pass collected its real column-found / pillsRendered
    // numbers). Severity: warn if any guidance line was appended, else ok.
    if (lastSyncAt) {
      const text = buildBannerText();
      const hasWarn = text.includes('\n⚠');
      showBanner(text, hasWarn ? 'warn' : 'ok');
    }
  }

  function removeAllPills() {
    document.querySelectorAll('.adjust-pill').forEach(p => p.remove());
    // WeakMap entries can't be enumerated to clear — but they're keyed by the
    // ellipsis div, so they auto-invalidate when Meta replaces those nodes.
    // For surviving nodes we re-decorate on next pass; if the pill is gone
    // but the WeakMap still says "decorated", decorateCandidate's dedup
    // would skip incorrectly. Force re-evaluation by clearing entries for
    // any ellipsis div currently in the DOM.
    document.querySelectorAll(NAME_CANDIDATE_SELECTOR).forEach(el => {
      decoratedKey.delete(el);
      decoratedTodayKey.delete(el);
    });
  }

  // Debounced decoration to avoid bursty work during rapid scroll.
  function scheduleDecorate() {
    if (decorateTimer) return;
    decorateTimer = setTimeout(() => {
      decorateTimer = null;
      decorateAllVisibleRows();
    }, 200);
  }

  function classifyForColor(roas) {
    // Whole-pill background only escalates to red when d7 is below the
    // user-configured pause threshold (default 30% — "unacceptable"). For
    // anything above that, the pill stays neutral and per-segment coloring
    // (see appendSegment) carries the granular signal.
    const primary = roas.d7 ?? roas.allTime;
    if (primary == null) return 'unknown';
    if (primary < colorThresholds.pause) return 'pause';
    return 'hold';
  }

  function pct(x) {
    return x == null ? '–' : `${(x * 100).toFixed(0)}%`;
  }

  function formatTooltip(data) {
    const lines = [
      `Name: ${data.campaignName}`,
      `Network: ${data.network}`,
    ];
    if (data.rowCount > 1) {
      lines.push(`Aggregated from: ${data.rowCount} rows`);
    }
    if (data.cost != null) {
      lines.push(`Cost: $${data.cost.toFixed(2)} · Installs: ${data.installs ?? 0}`);
    }
    lines.push(`Last sync: ${new Date(lastSyncAt).toLocaleString()}`);
    lines.push(`Source: ${sourceLabel}`);
    return lines.join('\n');
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
    const base = `Adjust data: ${campaignIndex.size} campaigns / ${adsetIndex.size} ad sets / ${adIndex.size} ads · synced ${ageMin}m ago · ${sourceLabel}`;
    const lines = [base];
    const s = lastDecorateStats;
    if (s.stillAmbiguous > 0) {
      // Tell the user exactly what to enable so the per-row pill becomes accurate.
      lines.push(`⚠ ${s.stillAmbiguous} row(s) showing aggregate ROAS — enable "Campaign name" or "Campaign ID" column to disambiguate.`);
    }
    // Today-pill banner lines (at most one). Priority: column-missing wins
    // over off-date wins over currency-mismatch wins over abbreviation. Each
    // higher-priority condition gates EVERY row, so surfacing it first avoids
    // the user fixing a per-row issue while a global block still hides pills.
    const t = lastTodayStats;
    if (!t.columnFound) {
      lines.push(`⚠ Today ROAS disabled — enable "Amount spent" column in this Meta view.`);
    } else if (t.metaDateIsToday === false) {
      const label = t.metaDateLabel || 'unknown';
      lines.push(`⚠ Today ROAS not computed — Meta UI date filter is "${label}". Switch to Today for live ROAS.`);
    } else if (t.skippedCurrencyMismatch > 0 && t.pillsRendered === 0) {
      const adj = t.adjustCurrencyExample || '?';
      const meta = t.detectedMetaCurrency || '?';
      lines.push(`⚠ Today ROAS unavailable — Adjust app currency (${adj}) ≠ Meta ad-account currency (${meta}).`);
    } else if (t.skippedAbbreviated > 0 && t.pillsRendered === 0) {
      lines.push(`⚠ Today ROAS disabled — disable Meta's number abbreviation (e.g. $1.2K) to read spend cells.`);
    }
    return lines.join('\n');
  }

  // ---- Observer ----
  // Watch the whole body subtree. SPA virtualizes the campaign list so rows
  // come and go on every scroll; debouncing absorbs the burst.
  function ensureObserving() {
    if (bodyObserver) return;
    bodyObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
          scheduleDecorate();
          return;
        }
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Listen for cache updates ----
  // Background writes campaignDataCache to chrome.storage.local on every sync.
  // Subscribing here means we don't need tabs.query/tabs.sendMessage from the
  // popup — which keeps the extension's permissions minimal (no `tabs` perm,
  // no host_permissions for facebook.com) and removes one moving part.
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

  // SPA URL changes: Meta's date picker pushes a new URL via history.pushState
  // (no popstate fires) AND re-renders the table — the body MutationObserver
  // already catches that path. popstate covers browser back/forward, where the
  // URL changes but the table may not always emit a child mutation in time.
  // We listen passively and just re-decorate; URL is re-read at pass start.
  window.addEventListener('popstate', () => {
    scheduleDecorate();
  });

  // Initial. Load thresholds first so the very first decoration uses
  // user-configured colors rather than briefly painting with defaults.
  loadColorThresholds().then(() => loadData());
})();
