// content/google-injector.js
// Injects multi-window ROAS pills into Google Ads (ads.google.com/aw/*) rows.
//
// === ACCOUNT SAFETY ===
// Same read-only contract as meta-injector.js / tiktok-injector.js:
//   READ-ONLY of Google DOM (querySelector + textContent only; never cookies,
//   storage, auth, input values). NO MUTATION of Google-owned elements — pills
//   are position:fixed children of <body>, tracking lives in WeakMaps. NO
//   NETWORK to google.com (manifest host_permissions is adjust.com only).
//
// === HOW GOOGLE ADS DIFFERS FROM META / TIKTOK ===
// 1. Google obfuscates its Angular-era class names and swaps internal tag
//    names between releases, so there is NO stable name-cell selector to pin
//    (Meta pins div.ellipsis; TikTok pins KsLink). Instead candidates are
//    INDEX-DRIVEN: every visible text leaf whose canonical text matches a
//    campaign / ad-group / ad name in the Adjust cache is a candidate, and the
//    largest X-aligned cluster of matches is taken as the name column
//    (breadcrumbs, hovercards and detail panels match the text but never share
//    the column's left edge). Zero Google selectors involved.
// 2. Table scope for the cost-column / row-bucket scans is the deepest common
//    ancestor of the matched name cells — again selector-free.
// 3. The date range lives in UI state, not the URL (TikTok has ?st=&et=,
//    Meta has ?date=). We read the toolbar's date-picker text: a leaf in the
//    top strip starting with "Today" / "Yesterday". Unknown range → the today
//    pill renders its revenue-only off-date variant (pipeline-state-visible)
//    instead of dividing into a spend window we can't identify.
// 4. Drill-down scoping: /aw/adgroups?campaignId=N carries the numeric
//    campaign id Google mints — the same id Adjust returns in
//    attr_dependency.campaign_id_network — so ambiguous names resolve via the
//    (campaignId :: name) composite index. No page-world bridge needed (there
//    are no React/Angular props worth reading and no preload tree).
//
// Levels map 1:1 onto the Adjust row model:
//   Campaigns (/aw/campaigns) → level 'campaign'
//   Ad groups (/aw/adgroups)  → level 'adset'  (adgroup_network)
//   Ads       (/aw/ads)       → level 'ad'     (creative_network)

(function () {
  'use strict';

  const INJECTOR_VERSION = 'v0.12.6-yday-zero-cost';
  // Cache schema this injector was written against. MUST equal
  // CACHE_SCHEMA_VERSION in background.js — bump both together. Used as the
  // stale-service-worker tripwire in loadData().
  const EXPECTED_CACHE_SCHEMA = 12;

  console.log(
    `%c[AOX-GG ${INJECTOR_VERSION}]%c google-injector loaded`,
    'background:#188038;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
    'color:#188038;font-weight:bold'
  );

  // ---- Embedded matcher (kept in sync with src/matcher.js + other injectors) ----
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

  // Network filter — matches the `channel` field Adjust returns for Google
  // rows ("Google Ads"; older accounts may still say "AdWords"). Anything not
  // matching is a different network's data and must be ignored here.
  const GOOGLE_NETWORK_RE = /google|adwords/i;

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
  let syncWarnings = [];
  let dataLoaded = false;
  let loadInFlight = false;

  let colorThresholds = { pause: 0.60, red: 0.80, green: 1.00 };

  let bodyObserver = null;
  let decorateTimer = null;
  const decoratedKey = new WeakMap();
  // Google's virtualized table clips siblings the same way TikTok's does, so
  // every pill is a position:fixed child of <body>, repositioned by the rAF
  // loop. Map cell → pill per type, one WeakMap dedup per type.
  const cellToPill = new Map();
  const cellToTodayPill = new Map();
  const decoratedTodayKey = new WeakMap();
  const cellToYesterdayPill = new Map();
  const decoratedYesterdayKey = new WeakMap();
  const cellToD2Pill = new Map();
  const decoratedD2Key = new WeakMap();

  // Yesterday spend harvested from the Cost column while the picker sits on
  // Yesterday — Google gives us no spend API and the cost cell always shows
  // the active range. Tagged with the day it represents (see TikTok twin).
  const ggYestSpendCache = new Map();

  let lastDecorateStats = createEmptyDecorateStats();
  function createEmptyDecorateStats() {
    return {
      candidates: 0, matched: 0,
      resolvedByName: 0, resolvedByUrlScope: 0, stillAmbiguous: 0,
      selfHealed: 0, gcOrphans: 0, gcLeaked: 0,
      clusterSizes: null,
    };
  }

  function createEmptyTodayStats() {
    return {
      columnFound: false, columnHeaderText: null, columnX: null,
      pillsRendered: 0, pillsRenderedOffDate: 0,
      skippedNoCostCell: 0, skippedCurrencyMismatch: 0,
      skippedAmbiguous: 0, skippedAbbreviated: 0, skippedOffDate: 0,
      sampleSpend: null, sampleRevToday: null,
      detectedGoogleCurrency: null, adjustCurrencyExample: null,
      sampleRowCandidates: null,
      ggDateIsToday: null, ggDateIsYesterday: null, ggDateLabel: null, ggDateSource: null,
      yestCaptured: 0, pillsYesterday: 0, yestNeedSpend: 0,
      skippedYestCurrencyMismatch: 0, sampleRevYesterday: null,
      pillsD2: 0, d2NoData: 0, sampleRevD2: null,
    };
  }
  let lastTodayStats = createEmptyTodayStats();

  const TODAY_PILL_CLASS_NORMAL   = 'adjust-pill adjust-pill-today';
  const TODAY_PILL_CLASS_OFFDATE  = 'adjust-pill adjust-pill-today-offdate';
  const TODAY_PILL_CLASS_MISMATCH = 'adjust-pill adjust-pill-today-mismatch';
  const YEST_PILL_CLASS_NORMAL    = 'adjust-pill adjust-pill-yesterday';
  const YEST_PILL_CLASS_OFFDATE   = 'adjust-pill adjust-pill-yest-offdate';
  const YEST_PILL_CLASS_MISMATCH  = 'adjust-pill adjust-pill-yest-mismatch';
  const D2_PILL_CLASS_NORMAL      = 'adjust-pill adjust-pill-d2';
  const D2_PILL_CLASS_NODATA      = 'adjust-pill adjust-pill-d2-nodata';

  // Per-pass caches populated at the start of decorateAllVisibleRows.
  let currentCostColumn = null;
  let currentGoogleDate = null;
  let rowYBuckets = null;
  let currentTableScope = null;

  // ---- Tab detection from URL pathname ----
  // /aw/campaigns → Campaigns; /aw/adgroups → Ad groups (adset level);
  // /aw/ads → Ads. Other /aw/ views (overview, keywords, …) → null: name
  // matching still runs on whatever level matches, but no tab priority.
  function getCurrentTab() {
    const path = window.location.pathname;
    if (path.includes('/aw/adgroups')) return 'adset';
    if (path.includes('/aw/ads')) return 'ad';
    if (path.includes('/aw/campaigns')) return 'campaign';
    return null;
  }

  // Numeric campaign id Google puts in the URL when the user drills into one
  // campaign (/aw/adgroups?campaignId=N). Matches Adjust's
  // attr_dependency.campaign_id_network for Google rows, so it scopes
  // ambiguous ad-group / ad names to the right campaign.
  function getUrlCampaignId() {
    try {
      const v = new URLSearchParams(window.location.search).get('campaignId');
      return v && /^\d+$/.test(v) ? v : null;
    } catch { return null; }
  }

  let reportingUtcOffset = '+07:00';
  async function loadReportingOffset() {
    try {
      const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
      if (dataSourceConfig?.utcOffset) reportingUtcOffset = dataSourceConfig.utcOffset;
    } catch { /* keep default */ }
  }

  async function loadColorThresholds() {
    try {
      const { colorThresholds: stored } = await chrome.storage.local.get('colorThresholds');
      const t = stored?.google;
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
      // channel: the worker filters to Google rows before the payload is
      // structured-cloned into this tab (v0.12.5). The local filter below
      // stays as-is so an older worker that ignores `channel` is still correct.
      const cached = await chrome.runtime.sendMessage({ type: 'GET_CACHED', channel: 'google' });
      if (cached?.error) {
        showBanner(`Data load error: ${cached.error}`, 'error');
        return;
      }
      if (!cached) {
        showBanner('No Adjust data yet. Click extension icon → Sync.', 'warn');
        return;
      }
      // Stale-worker tripwire (v0.12.2). The cache carries the schema of the
      // service worker that wrote it. A mismatch means Chrome is still running
      // a previous build's worker (it only reloads on an explicit extension
      // Reload, while this script is re-read from disk on every injection) —
      // its rows are shaped for a different pipeline. Observed 2026-09-18: a
      // pre-merge worker leaves cross-account duplicates in, which this build
      // would index last-write-wins (wrong account's cohort ROAS) and sum in
      // bumpToday (doubled D-1/D-2 spend). Refuse to decorate: a pill showing
      // the wrong account's number looks healthier than no pill at all.
      if (cached.schemaVersion !== EXPECTED_CACHE_SCHEMA) {
        showBanner(
          `⚠ Service worker đang chạy build cũ (cache schema v${cached.schemaVersion ?? '?'}, ` +
          `injector ${INJECTOR_VERSION} cần v${EXPECTED_CACHE_SCHEMA}). ` +
          'Vào chrome://extensions → bấm Reload ở card extension → mở popup → Force refresh.',
          'error'
        );
        return;
      }

      // Filter to Google rows only — the shared cache carries Meta + TikTok +
      // Google, and cross-channel campaigns often share naming conventions
      // (the user's "…-GL-ROAS…" scheme runs on several networks), so an
      // unfiltered index would collide names across channels.
      const allRows = (cached.campaigns || []);
      const googleRows = allRows.filter(r => GOOGLE_NETWORK_RE.test(r.network || ''));
      const campaignRows = googleRows.filter(r => r.level === 'campaign');
      const adsetRows = googleRows.filter(r => r.level === 'adset');
      const adRows = googleRows.filter(r => r.level === 'ad');

      campaignIndex = buildDirectIndex(campaignRows, r => r.campaignName);
      campByIdIndex = buildIdIndex(campaignRows, r => r.campaignId, r => r.campaignName);

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
      syncWarnings = Array.isArray(cached.syncWarnings) ? cached.syncWarnings : [];
      dataLoaded = true;

      attachTodayMetrics(campaignRows, adsetRows, adRows);

      showBanner(buildBannerText(), (cached.isStale || syncWarnings.length) ? 'warn' : 'ok');
      removeAllPills();
      ensureObserving();
      decorateAllVisibleRows();
      logDomDiagnostics();
    } catch (err) {
      console.warn('[Adjust Overlay GG] loadData failed:', err.message);
    } finally {
      loadInFlight = false;
    }
  }

  // ---- Index builders (same shapes as the TikTok injector) ----
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

  function attachTodayMetrics(campaignRows, adsetRows, adRows) {
    for (const r of campaignRows) {
      if (!r.campaignName) continue;
      const visited = new WeakSet();
      bumpToday(campaignIndex, canonicalKey(r.campaignName), r, visited);
      if (r.campaignId) bumpToday(campByIdIndex, String(r.campaignId), r, visited);
    }
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
    // null = fetch didn't run / failed → leave undefined so the pill shows a
    // dash, never a fabricated red 0%. Same contract as the other injectors.
    if (row.revenueYesterday != null) {
      e.revenueYesterday = (e.revenueYesterday || 0) + row.revenueYesterday;
    }
    // Adjust network spend for D-1 (v0.12) — the Yesterday pill's primary
    // denominator, same null-guard contract as the other realtime fields.
    if (row.costYesterday != null) {
      e.costYesterday = (e.costYesterday || 0) + row.costYesterday;
    }
    if (row.revenueD2 != null) {
      e.revenueD2 = (e.revenueD2 || 0) + row.revenueD2;
    }
    if (row.costD2 != null) {
      e.costD2 = (e.costD2 || 0) + row.costD2;
    }
    if (!e.adjustCurrency && row.adjustCurrency) e.adjustCurrency = row.adjustCurrency;
    if (!e.accountLabel && row.accountLabel) e.accountLabel = row.accountLabel;
    e.todayRowExisted = e.todayRowExisted || !!row.todayRowExisted;
  }

  // ---- Candidate discovery (index-driven, selector-free) ----
  const HEADER_SCAN_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
    'META', 'LINK', 'TITLE', 'HEAD',
    'SVG', 'PATH', 'CIRCLE', 'RECT', 'POLYGON', 'G', 'DEFS', 'USE',
  ]);
  const ROW_BUCKET_PX = 8;

  // Viewport height with a fallback: window.innerHeight can read 0 in edge
  // states (pre-render, some embedded/hidden-window contexts). A 0 viewport
  // would cull every candidate and hide every pill until the next decorate —
  // fall back to the document element, then a sane constant.
  function viewportH() {
    return window.innerHeight || document.documentElement.clientHeight || 800;
  }

  // Skip our own UI (pills, banner) during scans — their text can contain a
  // campaign name (tooltips) and currency-looking numbers.
  function isOwnNode(el) {
    return !!(el.closest && el.closest('.adjust-pill, #adjust-overlay-banner'));
  }

  // Cache the full-DOM candidate scan briefly: decorateAllVisibleRows,
  // computeMainPillAnchorX and removeAllPills all ask for candidates within
  // the same tick, and each scan is a full leaf walk.
  let candCache = { t: 0, list: [] };

  // ---- Shared leaf snapshot (v0.12.5, perf) ----
  //
  // WHY: one decorate pass used to walk the DOM FOUR separate times —
  // pickNameCandidates and detectGoogleDateInfo over document, locateCostColumn
  // (twice: headers, then currency cells) and ensureRowYBuckets over the table
  // scope — each re-running the same tag filter, the same `children.length`
  // leaf test and the same `textContent` read on every node. Those passes fire
  // every 200 ms for as long as Google Ads mutates, which on the campaigns view
  // is continuously. Now ONE walk per pass produces (el, text) pairs and every
  // scan filters that array; per-scan getBoundingClientRect calls are unchanged,
  // so the geometry each scan sees is identical to before.
  let leafSnap = null;        // { t, leaves: [{ el, text }] }
  let scopedLeafSnap = null;  // { scope, t, leaves }

  function allLeaves() {
    const now = Date.now();
    if (leafSnap && now - leafSnap.t < 120) return leafSnap.leaves;
    const leaves = [];
    for (const el of document.querySelectorAll('*')) {
      if (HEADER_SCAN_SKIP_TAGS.has(el.tagName)) continue;
      if (el.children.length > 0) continue; // leaf only
      const text = (el.textContent || '').trim();
      if (!text) continue;
      leaves.push({ el, text });
    }
    leafSnap = { t: now, leaves };
    return leaves;
  }

  // Leaves inside a subtree. Node.contains is a native ancestor walk, cheaper
  // than re-running querySelectorAll('*') over the subtree and re-reading every
  // textContent — and it reuses the snapshot the document-wide scans already paid for.
  function scopedLeaves(scope) {
    const now = Date.now();
    if (scopedLeafSnap && scopedLeafSnap.scope === scope && now - scopedLeafSnap.t < 120) {
      return scopedLeafSnap.leaves;
    }
    const base = allLeaves();
    const leaves = (!scope || scope === document.body)
      ? base
      : base.filter(l => scope.contains(l.el));
    scopedLeafSnap = { scope, t: now, leaves };
    return leaves;
  }

  function invalidateLeafSnapshots() {
    leafSnap = null;
    scopedLeafSnap = null;
  }

  function pickNameCandidates() {
    if (!dataLoaded) return [];
    const now = Date.now();
    if (now - candCache.t < 120) return candCache.list;

    const matches = [];
    for (const { el, text: raw } of allLeaves()) {
      if (raw.length < 5 || raw.length > 300) continue;
      const k = canonicalKey(raw);
      if (!campaignIndex.has(k) && !adsetIndex.has(k) && !adIndex.has(k)) continue;
      if (isOwnNode(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.width === 0) continue;
      if (r.top > viewportH() || r.bottom < 0) continue;
      matches.push({ el, left: Math.round(r.left) });
    }

    let list;
    if (matches.length <= 1) {
      list = matches.map(m => m.el);
      lastDecorateStats.clusterSizes = matches.length ? [matches.length] : [];
    } else {
      // Column clustering: the name column is the largest group of matches
      // sharing a left edge (±8px). A breadcrumb, hovercard or detail panel
      // that happens to repeat a campaign name almost never lines up with the
      // table's name column, so it falls into a smaller cluster and is
      // dropped instead of decorated.
      const groups = new Map();
      for (const m of matches) {
        const bucket = Math.round(m.left / 8);
        let g = groups.get(bucket) || groups.get(bucket - 1) || groups.get(bucket + 1);
        if (!g) { g = []; groups.set(bucket, g); }
        g.push(m);
      }
      let best = null;
      const sizes = [];
      for (const g of groups.values()) {
        sizes.push(g.length);
        if (!best || g.length > best.length) best = g;
      }
      sizes.sort((a, b) => b - a);
      lastDecorateStats.clusterSizes = sizes.slice(0, 5);
      list = best.map(m => m.el);
    }

    candCache = { t: now, list };
    return list;
  }

  // Deepest ancestor containing every candidate — the table region, found
  // without knowing Google's table markup. Scopes the cost-column and
  // row-bucket scans so toolbar/nav text can't pollute them.
  function guessTableScope(candidates) {
    if (!candidates || candidates.length === 0) return document.body;
    let node = candidates[0];
    const last = candidates[candidates.length - 1];
    const mid = candidates[Math.floor(candidates.length / 2)];
    while (node && node !== document.body) {
      if (node.contains(last) && node.contains(mid)) return node.parentElement || node;
      node = node.parentElement;
    }
    return document.body;
  }

  // ---- Cost column (header-text match, currency-scored) ----
  // Google labels the spend column "Cost" (localized variants below). Header
  // keys are exact canonical matches, so "Cost / conv." — a different column
  // that also holds currency cells — never becomes a candidate.
  const GOOGLE_COST_HEADER_KEYS = new Set([
    canonicalKey('Cost'),
    canonicalKey('Chi phí'),
    canonicalKey('Coût'),
    canonicalKey('Costo'),
    canonicalKey('Custo'),
    canonicalKey('Kosten'),
    canonicalKey('Gasto'),
    canonicalKey('Biaya'),
    canonicalKey('費用'),
    canonicalKey('费用'),
    canonicalKey('비용'),
  ]);

  const ZERO_DECIMAL_CURRENCIES = new Set(['VND', 'JPY', 'KRW', 'IDR', 'CLP']);
  const SYMBOL_TO_ISO = {
    '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₫': 'VND',
    '₹': 'INR', '₩': 'KRW', '฿': 'THB', '₱': 'PHP', '₪': 'ILS',
    '₺': 'TRY', '₽': 'RUB',
  };

  function locateCostColumn() {
    const tableScope = currentTableScope || document.body;

    const candidates = [];
    for (const { el, text: raw } of scopedLeaves(tableScope)) {
      if (raw.length > 60) continue;
      const k = canonicalKey(raw);
      let matched = GOOGLE_COST_HEADER_KEYS.has(k);
      if (!matched && raw.match(/[.…]+$/)) {
        const prefix = k.replace(/[.…\s]+$/, '');
        if (prefix.length >= 3) {
          for (const hk of GOOGLE_COST_HEADER_KEYS) {
            if (hk.startsWith(prefix)) { matched = true; break; }
          }
        }
      }
      if (!matched) continue;
      if (isOwnNode(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.top < 0) continue;
      candidates.push({ el, rect: r });
    }
    if (candidates.length === 0) return null;

    // Score candidates by currency-looking cells stacked below at the same X —
    // the real Cost header anchors a column of money cells; a stray "Cost"
    // label elsewhere doesn't.
    let winner;
    if (candidates.length === 1) {
      winner = candidates[0];
    } else {
      const currencyLeaves = [];
      for (const { el, text: txt } of scopedLeaves(tableScope)) {
        if (!looksLikeCurrency(txt)) continue;
        if (isOwnNode(el)) continue;
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
        if (score > bestScore
            || (score === bestScore && winner && cand.rect.top < winner.rect.top)) {
          bestScore = score;
          winner = cand;
        }
      }
      if (!winner) winner = candidates[0];
    }

    const bestHeader = winner.el;
    let cellRect = winner.rect;
    let node = bestHeader.parentElement;
    for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.height > 80) break;
      if (r.width > 400) break;
      if (r.width > cellRect.width) cellRect = r;
    }
    return {
      headerX: (cellRect.left + cellRect.right) / 2,
      headerText: (bestHeader.textContent || '').trim().slice(0, 40),
    };
  }

  function ensureRowYBuckets() {
    if (rowYBuckets) return rowYBuckets;
    rowYBuckets = new Map();
    const tableScope = currentTableScope || document.body;
    for (const { el, text: t } of scopedLeaves(tableScope)) {
      if (t.length > 300) continue;
      if (isOwnNode(el)) continue;
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

  function getRowYRange(nameEl) {
    const column = getColumnAncestor(nameEl);
    const r = (column || nameEl).getBoundingClientRect();
    return { top: r.top - 2, bottom: r.bottom + 2 };
  }

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

  // ---- Date detection ----
  // Google Ads keeps the active date range in UI state, not the URL, so we
  // read the toolbar's date-picker text: a short leaf in the top strip of the
  // viewport starting with "Today" / "Yesterday" (localized variants below).
  // Anything else — an explicit range, "Last 30 days", or nothing detected —
  // yields isToday=false with the best label we saw, and the today pill
  // renders its revenue-only off-date variant rather than dividing into an
  // unidentified spend window.
  const DATE_TODAY_RE = /^(today|hôm nay)\b/i;
  const DATE_YESTERDAY_RE = /^(yesterday|hôm qua)\b/i;
  const DATE_RANGE_HINT_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i;

  function detectGoogleDateInfo() {
    try {
      let label = null;
      for (const { el, text: raw } of allLeaves()) {
        if (raw.length > 48) continue;
        const r = el.getBoundingClientRect();
        // Sticky toolbars can sit a few px above the viewport origin (and
        // embedded contexts can report small negative tops), so gate on
        // "not fully above the viewport" rather than top >= 0.
        if (r.height === 0 || r.bottom < 0 || r.top > 250) continue;
        if (isOwnNode(el)) continue;
        if (DATE_TODAY_RE.test(raw)) {
          return { isToday: true, isYesterday: false, label: 'today', source: 'picker' };
        }
        if (DATE_YESTERDAY_RE.test(raw)) {
          return { isToday: false, isYesterday: true, label: 'yesterday', source: 'picker' };
        }
        if (!label && DATE_RANGE_HINT_RE.test(raw)) label = raw.slice(0, 40);
      }
      return { isToday: false, isYesterday: false, label: label || 'unknown', source: label ? 'picker' : 'absent' };
    } catch {
      return { isToday: false, isYesterday: false, label: 'unknown', source: 'error' };
    }
  }

  function todayLocalIsoDate() { return localIsoDate(new Date()); }
  function yesterdayLocalIsoDate() { return localIsoDate(new Date(Date.now() - 86400000)); }
  function localIsoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function reportingD2Iso() {
    const m = String(reportingUtcOffset || '').trim().match(/^([+-])(\d{1,2}):?(\d{2})?$/);
    const offMin = m
      ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0))
      : 420;
    const shifted = new Date(Date.now() + offMin * 60000 - 2 * 86400000);
    const y = shifted.getUTCFullYear();
    const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
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
      `Spend (Google UI${displayCcy ? `, ${displayCcy}` : ''}): ${formatMoneyOrDash(spend)}`,
    ];
    if (ageMin != null) lines.push(`Adjust sync age: ${ageMin}m`);
    if (!data.todayRowExisted) lines.push(`Note: no cohort data for this row (new today?)`);
    return lines.join('\n');
  }

  // ---- Pill renderers ----
  function maybeRenderTodayPill(nameEl, mainPill, data, mainKey) {
    if (!data || data.ambiguous) { lastTodayStats.skippedAmbiguous++; return; }

    const rev = (data.revenueToday == null) ? null : data.revenueToday;
    const adjCcy = data.adjustCurrency;

    // No Cost column in this Google Ads view → the spend half is unreadable.
    // Render the revenue half with a how-to-fix hint instead of nothing: an
    // absent pill is indistinguishable from a broken one, and Google views
    // routinely ship without the Cost column enabled.
    if (!currentCostColumn) {
      const todayKey = `${mainKey}|nocol|rev:${rev}|a:${adjCcy || ''}`;
      if (decoratedTodayKey.get(nameEl) === todayKey) return;
      const p = document.createElement('span');
      p.className = TODAY_PILL_CLASS_OFFDATE;
      p.textContent = `Today rev${adjCcy ? ` (${adjCcy})` : ''}: ${formatMoneyOrDash(rev)} — bật cột Cost`;
      p.title =
        `Today ROAS chưa tính được — view Google Ads này không hiển thị cột "Cost",\n` +
        `nên extension không đọc được spend realtime của hôm nay.\n` +
        `Thêm cột: Columns → Modify columns → Performance → Cost → Apply.\n` +
        `Revenue hôm nay (Adjust, event-date): ${formatMoneyOrDash(rev)}${adjCcy ? ` ${adjCcy}` : ''}.`;
      lastTodayStats.pillsRenderedOffDate++;
      if (lastTodayStats.sampleRevToday == null && rev != null) lastTodayStats.sampleRevToday = rev;
      if (!lastTodayStats.adjustCurrencyExample && adjCcy) lastTodayStats.adjustCurrencyExample = adjCcy;
      commitTrailingPill(cellToTodayPill, decoratedTodayKey, nameEl, p, todayKey, 'today');
      return;
    }

    if (currentGoogleDate && !currentGoogleDate.isToday) {
      const todayKey = `${mainKey}|offdate:${currentGoogleDate.label}|rev:${rev}|a:${adjCcy || ''}`;
      if (decoratedTodayKey.get(nameEl) === todayKey) return;

      const todayPill = document.createElement('span');
      todayPill.className = TODAY_PILL_CLASS_OFFDATE;
      todayPill.textContent =
        `Today rev${adjCcy ? ` (${adjCcy})` : ''}: ${formatMoneyOrDash(rev)} ` +
        `(Google on ${currentGoogleDate.label})`;
      todayPill.title =
        `Today ROAS not computed — Google Ads date range is "${currentGoogleDate.label}".\n` +
        `The Cost cell reflects that range, not today's spend, so dividing would mislead.\n` +
        `Switch the Google Ads date picker to Today for live ROAS.\n` +
        (rev != null
          ? `Adjust today rev${adjCcy ? ` (${adjCcy})` : ''}: ${formatMoneyOrDash(rev)}`
          : `Adjust has no revenue for this row today yet.`);

      lastTodayStats.pillsRenderedOffDate++;
      lastTodayStats.skippedOffDate++;
      if (lastTodayStats.sampleRevToday == null && rev != null) lastTodayStats.sampleRevToday = rev;
      if (!lastTodayStats.adjustCurrencyExample && adjCcy) lastTodayStats.adjustCurrencyExample = adjCcy;
      commitTrailingPill(cellToTodayPill, decoratedTodayKey, nameEl, todayPill, todayKey, 'today');
      return;
    }

    const spendText = findCostCellText(nameEl);
    let spend = null;
    let ggCcy = null;
    if (spendText != null) {
      const parsed = parseCurrencyCell(spendText);
      if (parsed.abbreviated) {
        lastTodayStats.skippedAbbreviated++;
      } else if (parsed.parsed && parsed.value != null) {
        spend = parsed.value;
        ggCcy = parsed.currency;
      }
    } else {
      lastTodayStats.skippedNoCostCell++;
    }

    if (lastTodayStats.sampleSpend == null && spend != null) lastTodayStats.sampleSpend = spend;
    if (lastTodayStats.detectedGoogleCurrency == null && ggCcy) lastTodayStats.detectedGoogleCurrency = ggCcy;
    if (lastTodayStats.sampleRevToday == null && rev != null) lastTodayStats.sampleRevToday = rev;
    if (!lastTodayStats.adjustCurrencyExample && adjCcy) lastTodayStats.adjustCurrencyExample = adjCcy;

    const currencyMismatch = ggCcy && adjCcy && ggCcy !== adjCcy;

    const todayKey = `${mainKey}|rev:${rev}|spend:${spend}|g:${ggCcy || ''}|a:${adjCcy || ''}|mm:${currencyMismatch}`;
    if (decoratedTodayKey.get(nameEl) === todayKey) return;

    const todayPill = document.createElement('span');

    if (currencyMismatch) {
      todayPill.className = TODAY_PILL_CLASS_MISMATCH;
      todayPill.textContent = `Today: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)} (${adjCcy}→${ggCcy})`;
      todayPill.title =
        `Today ROAS unavailable — cross-currency.\n` +
        `Adjust app revenue (${adjCcy}): ${formatMoneyOrDash(rev)}\n` +
        `Google ad-account spend (${ggCcy}): ${formatMoneyOrDash(spend)}\n` +
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
      todayPill.title = formatTodayTooltip(rev, spend, ggCcy || adjCcy || '?', adjCcy, data);
      lastTodayStats.pillsRendered++;
    }

    commitTrailingPill(cellToTodayPill, decoratedTodayKey, nameEl, todayPill, todayKey, 'today');
  }

  // Harvest yesterday's spend while the picker sits on Yesterday. Runs
  // unconditionally from decorateCandidate (not gated on pillVis.yesterday) so
  // browsing Yesterday with the pill off still fills the cache.
  function maybeCaptureYesterdaySpend(nameEl, mainKey) {
    if (!currentCostColumn) return;
    if (!currentGoogleDate || !currentGoogleDate.isYesterday) return;
    const text = findCostCellText(nameEl);
    if (text == null) return;
    const parsed = parseCurrencyCell(text);
    if (!parsed.parsed || parsed.value == null || parsed.abbreviated) return;
    ggYestSpendCache.set(mainKey, {
      representsDay: yesterdayLocalIsoDate(),
      spend: parsed.value,
      currency: parsed.currency,
    });
    lastTodayStats.yestCaptured++;
  }

  function maybeRenderYesterdayPill(nameEl, anchorPill, data, mainKey) {
    if (!data || data.ambiguous) return;

    const rev = (data.revenueYesterday == null) ? null : data.revenueYesterday;
    const adjCcy = data.adjustCurrency;
    if (lastTodayStats.sampleRevYesterday == null && rev != null) {
      lastTodayStats.sampleRevYesterday = rev;
    }

    // Adjust-sourced spend (v0.12) — primary path, same closed-day contract as
    // the D-2 pill; the scraped-spend cache below survives only as a fallback
    // for rows whose Adjust spend half failed.
    const adjSpend = (data.costYesterday == null) ? null : data.costYesterday;
    const cached = ggYestSpendCache.get(mainKey);
    const spendFresh = !!(
      cached && cached.representsDay === yesterdayLocalIsoDate() && cached.spend != null
    );
    // An Adjust cost of 0 is NOT authoritative on its own: Adjust ingests the
    // network's spend for a closed day with a lag, and until it lands the cohort
    // report answers 0 for every row. Trust it only when nothing contradicts it —
    // a fresh UI capture (user parked the picker on Yesterday) or revenue > 0
    // with zero spend both mean "not ingested yet", so fall through to the
    // UI-capture path (captured spend, or the "cần view Yesterday" prompt).
    const adjSpendUsable = adjSpend != null && (adjSpend > 0 || (!spendFresh && !(rev > 0)));
    if (adjSpendUsable) {
      const yestKey = `${mainKey}|yadj:${rev}/${adjSpend}|a:${adjCcy || ''}`;
      if (decoratedYesterdayKey.get(nameEl) === yestKey) return;
      const yestPill = document.createElement('span');
      yestPill.className = YEST_PILL_CLASS_NORMAL;
      yestPill.appendChild(document.createTextNode(
        `Y'day: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(adjSpend)}`
      ));
      if (rev != null && adjSpend > 0) {
        const roas = rev / adjSpend;
        yestPill.appendChild(document.createTextNode(' '));
        const valSpan = document.createElement('span');
        valSpan.textContent = pct(roas);
        if (roas < colorThresholds.red) valSpan.className = 'adjust-rv-red';
        else if (roas > colorThresholds.green) valSpan.className = 'adjust-rv-green';
        yestPill.appendChild(valSpan);
      }
      const ageMin = lastSyncAt ? Math.round((Date.now() - lastSyncAt) / 60000) : null;
      yestPill.title =
        `Yesterday ROAS (event-date, closed day — both sides from Adjust)\n` +
        `Rev (Adjust yesterday${adjCcy ? `, ${adjCcy}` : ''}): ${formatMoneyOrDash(rev)}\n` +
        `Spend (Adjust yesterday${adjCcy ? `, ${adjCcy}` : ''}): ${formatMoneyOrDash(adjSpend)}` +
        (rev == null ? `\n⚠ Thiếu revenue — report event-date yesterday lỗi, xem banner/popup.` : '') +
        (data.accountLabel ? `\nAdjust account: ${data.accountLabel}` : '') +
        (ageMin != null ? `\nAdjust sync age: ${ageMin}m` : '');
      lastTodayStats.pillsYesterday++;
      commitTrailingPill(cellToYesterdayPill, decoratedYesterdayKey, nameEl, yestPill, yestKey, 'yesterday');
      return;
    }

    const spend = spendFresh ? cached.spend : null;
    const ggCcy = spendFresh ? cached.currency : null;
    const currencyMismatch = ggCcy && adjCcy && ggCcy !== adjCcy;

    const yestKey =
      `${mainKey}|yrev:${rev}|yspend:${spend}|g:${ggCcy || ''}|a:${adjCcy || ''}|mm:${currencyMismatch}`;
    if (decoratedYesterdayKey.get(nameEl) === yestKey) return;

    const yestPill = document.createElement('span');

    if (!spendFresh) {
      yestPill.className = YEST_PILL_CLASS_OFFDATE;
      yestPill.textContent = `Y'day: ${formatMoneyOrDash(rev)}/– — cần view Yesterday`;
      yestPill.title =
        `Yesterday ROAS chưa tính — chưa bắt được Google spend hôm qua.\n` +
        `Chuyển Google Ads date picker sang "Yesterday" một lần để extension\n` +
        `đọc cost cell, rồi quay lại Today.\n` +
        `Revenue hôm qua (Adjust, event-date) đã có: ` +
        `${formatMoneyOrDash(rev)}${adjCcy ? ` ${adjCcy}` : ''}.`;
      lastTodayStats.yestNeedSpend++;
    } else if (currencyMismatch) {
      yestPill.className = YEST_PILL_CLASS_MISMATCH;
      yestPill.textContent =
        `Y'day: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)} (${adjCcy}→${ggCcy})`;
      yestPill.title =
        `Yesterday ROAS unavailable — cross-currency.\n` +
        `Adjust yesterday rev (${adjCcy}): ${formatMoneyOrDash(rev)}\n` +
        `Google yesterday spend (${ggCcy}): ${formatMoneyOrDash(spend)}\n` +
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
        `Spend (Google ${cached.representsDay}${ggCcy ? `, ${ggCcy}` : ''}): ` +
        `${formatMoneyOrDash(spend)}` +
        (ageMin != null ? `\nAdjust sync age: ${ageMin}m` : '');
      lastTodayStats.pillsYesterday++;
    }

    commitTrailingPill(cellToYesterdayPill, decoratedYesterdayKey, nameEl, yestPill, yestKey, 'yesterday');
  }

  function maybeRenderD2Pill(nameEl, anchorPill, data, mainKey) {
    if (!data || data.ambiguous) return;

    const rev = (data.revenueD2 == null) ? null : data.revenueD2;
    const spend = (data.costD2 == null) ? null : data.costD2;
    const adjCcy = data.adjustCurrency;
    if (lastTodayStats.sampleRevD2 == null && rev != null) lastTodayStats.sampleRevD2 = rev;
    const hasRatio = rev != null && spend != null && spend > 0;

    const d2Key = `${mainKey}|d2rev:${rev}|d2spend:${spend}|a:${adjCcy || ''}`;
    if (decoratedD2Key.get(nameEl) === d2Key) return;

    const d2Pill = document.createElement('span');
    const d2Iso = reportingD2Iso();
    if (rev == null && spend == null) {
      const d2Warnings = syncWarnings.filter((w) => /D-2/i.test(w));
      d2Pill.className = D2_PILL_CLASS_NODATA;
      d2Pill.textContent = `D-2: –/– — chưa có dữ liệu`;
      d2Pill.title = d2Warnings.length
        ? `D-2 (${d2Iso}) — report Adjust lỗi ở lần sync này:\n` +
          d2Warnings.map((w) => `• ${w}`).join('\n') +
          `\nBấm Force refresh trong popup để thử lại.`
        : `D-2 (hôm kia, ${d2Iso}) chưa có dữ liệu Adjust cho dòng này.\n` +
          `Nếu vừa bật pill, bấm Force refresh trong popup để kéo report D-2.`;
      lastTodayStats.d2NoData++;
    } else {
      d2Pill.className = D2_PILL_CLASS_NORMAL;
      d2Pill.appendChild(document.createTextNode(
        `D-2: ${formatMoneyOrDash(rev)}/${formatMoneyOrDash(spend)}`
      ));
      if (hasRatio) {
        const roas = rev / spend;
        d2Pill.appendChild(document.createTextNode(' '));
        const valSpan = document.createElement('span');
        valSpan.textContent = pct(roas);
        if (roas < colorThresholds.red) valSpan.className = 'adjust-rv-red';
        else if (roas > colorThresholds.green) valSpan.className = 'adjust-rv-green';
        d2Pill.appendChild(valSpan);
      }
      const ageMin = lastSyncAt ? Math.round((Date.now() - lastSyncAt) / 60000) : null;
      const halfNote = rev == null
        ? `\n⚠ Thiếu revenue — report event-date D-2 lỗi, xem banner/popup.`
        : spend == null
          ? `\n⚠ Thiếu spend — report spend D-2 lỗi, xem banner/popup.`
          : '';
      d2Pill.title =
        `D-2 realtime ROAS (event-date, ${d2Iso} — final, both sides from Adjust)\n` +
        `Rev (Adjust D-2${adjCcy ? `, ${adjCcy}` : ''}): ${formatMoneyOrDash(rev)}\n` +
        `Spend (Adjust D-2${adjCcy ? `, ${adjCcy}` : ''}): ${formatMoneyOrDash(spend)}` +
        halfNote +
        (data.accountLabel ? `\nAdjust account: ${data.accountLabel}` : '') +
        (ageMin != null ? `\nAdjust sync age: ${ageMin}m` : '');
      lastTodayStats.pillsD2++;
    }

    commitTrailingPill(cellToD2Pill, decoratedD2Key, nameEl, d2Pill, d2Key, 'd2');
  }

  // Shared commit for the three trailing pill types (today / yesterday / D-2):
  // drop the stale instance, park off-screen, measure, position, register, and
  // invalidate the rAF prefilter. One function instead of three keeps the
  // bookkeeping steps from drifting apart (the TikTok twin has three copies —
  // this file collapses them since all three were line-identical).
  function commitTrailingPill(map, dedup, nameEl, pill, key, slot) {
    const stale = map.get(nameEl);
    if (stale) { stale.remove(); map.delete(nameEl); }
    pill.style.position = 'fixed';
    pill.style.zIndex = '99999';
    pill.style.margin = '0';
    pill.style.left = '-99999px';
    pill.style.top = '0';
    document.body.appendChild(pill);
    pill._aoxWidth = pill.offsetWidth;
    if (slot === 'today' && pill._aoxWidth > maxTodayPillWidth) maxTodayPillWidth = pill._aoxWidth;
    if (slot === 'yesterday' && pill._aoxWidth > maxYesterdayPillWidth) maxYesterdayPillWidth = pill._aoxWidth;
    positionTrailingPill(nameEl, pill, slot);
    map.set(nameEl, pill);
    dedup.set(nameEl, key);
    lastPositioned.delete(nameEl);
    ensureRepositionLoop();
  }

  // ---- Positioning (fixed-slot columns, same discipline as TikTok) ----
  const cellColumnCache = new WeakMap();
  let mainPillAnchorX = null;
  let maxMainPillWidth = 0;
  let maxTodayPillWidth = 0;
  let maxYesterdayPillWidth = 0;

  function computeMainPillAnchorX() {
    const rights = [];
    for (const cell of pickNameCandidates()) {
      const r = cell.getBoundingClientRect();
      if (r.height === 0 || r.bottom < 0 || r.top > viewportH()) continue;
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
      || r.bottom < 0 || r.top > viewportH();
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
    lastPositioned.set(cell, { left, top, hidden: offscreen, cellRight: r.right });
  }

  // Slot chain: main → today → yesterday → d2. A disabled earlier pill type
  // contributes a 0-width slot, so later pills slide left into the gap.
  function slotLeftAnchor(slot, cell) {
    if (mainPillAnchorX == null) {
      const column = getColumnAncestor(cell);
      const colRight = column
        ? column.getBoundingClientRect().right
        : cell.getBoundingClientRect().right;
      const fallbackPad = slot === 'today' ? 110 : slot === 'yesterday' ? 220 : 330;
      return colRight + fallbackPad;
    }
    const todaySlot = mainPillAnchorX + (maxMainPillWidth > 0 ? maxMainPillWidth + 6 : 0);
    if (slot === 'today') return todaySlot;
    const yestSlot = maxTodayPillWidth > 0 ? todaySlot + maxTodayPillWidth + 6 : todaySlot;
    if (slot === 'yesterday') return yestSlot;
    return maxYesterdayPillWidth > 0 ? yestSlot + maxYesterdayPillWidth + 6 : yestSlot;
  }

  function positionTrailingPill(cell, pill, slot) {
    const cr = cell.getBoundingClientRect();
    const offscreen = cr.width === 0 || cr.height === 0
      || cr.bottom < 0 || cr.top > viewportH();
    if (offscreen) {
      pill.style.display = 'none';
      return;
    }
    pill.style.display = '';
    pill.style.left = Math.round(slotLeftAnchor(slot, cell)) + 'px';
    pill.style.top = Math.round(cr.top + (cr.height / 2) - 9) + 'px';
  }

  function getColumnAncestor(cell) {
    let column = cellColumnCache.get(cell);
    if (column && column.isConnected) return column;
    column = findColumnAncestor(cell);
    if (column) cellColumnCache.set(cell, column);
    return column;
  }

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

  // ---- rAF reposition loop ----
  let rafHandle = 0;
  // Frames of "nothing moved" before the loop parks itself. ~45 frames is
  // about 0.75 s at 60 Hz: long enough to ride out a fling-scroll's coast,
  // short enough that an idle tab stops burning layout almost immediately.
  const RAF_IDLE_FRAMES = 45;
  let idleFrames = 0;
  let rafParked = false;
  const lastPositioned = new WeakMap();

  function livePillCells() {
    if (pillVis.cohort) return cellToPill.keys();
    const cells = new Set(cellToPill.keys());
    for (const cell of cellToTodayPill.keys()) cells.add(cell);
    for (const cell of cellToYesterdayPill.keys()) cells.add(cell);
    for (const cell of cellToD2Pill.keys()) cells.add(cell);
    return cells;
  }

  function hasLivePills() {
    return cellToPill.size > 0 || cellToTodayPill.size > 0
      || cellToYesterdayPill.size > 0 || cellToD2Pill.size > 0;
  }

  function repositionLoopTick() {
    rafHandle = 0;
    if (!hasLivePills()) return;
    let moved = 0;

    for (const cell of livePillCells()) {
      const pill = cellToPill.get(cell);
      if (!cell.isConnected) { dropPillFor(cell); continue; }
      const r = cell.getBoundingClientRect();
      const offscreen = r.width === 0 || r.height === 0
        || r.bottom < 0 || r.top > viewportH();
      const top = Math.round(r.top + (r.height / 2) - 9);
      const prev = lastPositioned.get(cell);
      if (prev && prev.top === top && prev.hidden === offscreen && prev.cellRight === r.right) {
        continue;
      }
      moved++;
      if (pill) {
        positionPillToCell(cell, pill);
      } else {
        lastPositioned.set(cell, {
          left: mainPillAnchorX != null ? mainPillAnchorX : r.right,
          top, hidden: offscreen, cellRight: r.right,
        });
      }
      const todayPill = cellToTodayPill.get(cell);
      if (todayPill) positionTrailingPill(cell, todayPill, 'today');
      const yestPill = cellToYesterdayPill.get(cell);
      if (yestPill) positionTrailingPill(cell, yestPill, 'yesterday');
      const d2Pill = cellToD2Pill.get(cell);
      if (d2Pill) positionTrailingPill(cell, d2Pill, 'd2');
    }

    // Park the loop once the table has been still for a while (v0.12.5).
    //
    // WHY: this used to re-arm unconditionally, so for the entire life of the
    // tab it ran every frame and called getBoundingClientRect on every pill
    // cell — a forced style+layout flush 60x/s on a page Google is already
    // laying out. Nothing was moving for the vast majority of those frames.
    // Everything that CAN move a row re-arms the loop: scroll/wheel/resize
    // (listeners below), any decorate pass (decorateCandidate ->
    // ensureRepositionLoop), and tab re-show (visibilitychange).
    if (moved > 0) idleFrames = 0; else idleFrames++;
    if (idleFrames >= RAF_IDLE_FRAMES) {
      idleFrames = 0;
      rafParked = true;
      return;
    }
    if (hasLivePills()) {
      rafHandle = requestAnimationFrame(repositionLoopTick);
    }
  }

  function ensureRepositionLoop() {
    if (rafHandle || !hasLivePills()) return;
    rafParked = false;
    idleFrames = 0;
    rafHandle = requestAnimationFrame(repositionLoopTick);
  }

  // ---- Lookup ----
  // Strategy chain per level:
  //   1. Exact name lookup — unique → done.
  //   2. URL campaign scope: /aw/adgroups?campaignId=N + (campaignId::name)
  //      composite resolves same-named ad groups / ads inside a drill-down.
  //   3. Ambiguous aggregate as the honest fallback.
  function lookupForLevel(el, key, level) {
    const byName = level === 'campaign' ? campaignIndex
                 : level === 'adset'    ? adsetIndex
                 :                        adIndex;
    const byComposite = level === 'adset' ? adsetCompositeIndex
                      : level === 'ad'    ? adCompositeIndex
                      :                     null;

    const entry = byName.get(key);
    if (entry && !entry.ambiguous) {
      lastDecorateStats.resolvedByName++;
      return entry;
    }

    if (byComposite) {
      const urlCamp = getUrlCampaignId();
      if (urlCamp) {
        const m = byComposite.get(`${urlCamp}::${key}`);
        if (m) {
          lastDecorateStats.resolvedByUrlScope++;
          return m;
        }
      }
    }

    if (entry) {
      lastDecorateStats.stillAmbiguous++;
      return entry;
    }
    return null;
  }

  // ---- Decorate one candidate ----
  function decorateCandidate(el) {
    const rawName = el.textContent || '';
    if (rawName.length < 5 || rawName.length > 300) return;
    const key = canonicalKey(rawName);

    lastDecorateStats.candidates++;

    const tab = getCurrentTab();
    const order = tab === 'campaign' ? ['campaign', 'adset', 'ad']
                : tab === 'adset'    ? ['adset', 'ad', 'campaign']
                : tab === 'ad'       ? ['ad', 'adset', 'campaign']
                :                       ['campaign', 'adset', 'ad'];

    let data = null;
    for (const level of order) {
      data = lookupForLevel(el, key, level);
      if (data) break;
    }
    if (!data) return;

    lastDecorateStats.matched++;

    // Harvest yesterday spend BEFORE any visibility gate so browsing the
    // Yesterday view with the pill off still fills the cache.
    maybeCaptureYesterdaySpend(el, key);

    if (decoratedKey.get(el) === key) {
      const existingPill = cellToPill.get(el);
      if (existingPill) {
        renderTrailingPills(el, existingPill, data, key);
        ensureRepositionLoop();
        return;
      }
      // Dedup flag says decorated but the pill is gone (virtualization race —
      // see the TikTok twin's self-heal note). Fall through and recreate.
      lastDecorateStats.selfHealed++;
    }

    // Node recycled onto a different row: drop the old pills first.
    const stale = cellToPill.get(el);
    if (stale) { stale.remove(); cellToPill.delete(el); }
    for (const [map, dedup] of [
      [cellToTodayPill, decoratedTodayKey],
      [cellToYesterdayPill, decoratedYesterdayKey],
      [cellToD2Pill, decoratedD2Key],
    ]) {
      const p = map.get(el);
      if (p) { p.remove(); map.delete(el); dedup.delete(el); }
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
      // Park off-screen and measure before positioning — offsetWidth on a
      // display:none element reads 0, which would desync the fixed slots.
      pill.style.left = '-99999px';
      pill.style.top = '0';
      document.body.appendChild(pill);
      pill._aoxWidth = pill.offsetWidth;
      if (pill._aoxWidth > maxMainPillWidth) maxMainPillWidth = pill._aoxWidth;
      positionPillToCell(el, pill);

      cellToPill.set(el, pill);
      decoratedKey.set(el, key);
    } else {
      decoratedKey.delete(el);
    }

    renderTrailingPills(el, pill, data, key);

    ensureRepositionLoop();
  }

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

    if (pillVis.d2) {
      const anchor = cellToYesterdayPill.get(el) || cellToTodayPill.get(el) || mainPill;
      maybeRenderD2Pill(el, anchor, data, key);
    } else {
      const d = cellToD2Pill.get(el);
      if (d) { d.remove(); cellToD2Pill.delete(el); }
      decoratedD2Key.delete(el);
    }
  }

  // ---- Pill helpers ----
  function classifyForColor(roas) {
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
    if (data.accountLabel) lines.push(`Adjust account: ${data.accountLabel}`);
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

  // ---- Banner (same draggable badge as the other injectors) ----
  // Idempotent since v0.12.5. WHY THIS MATTERS FAR MORE THAN IT LOOKS:
  // decorateAllVisibleRows() ends by calling showBanner(), and
  // `panel.textContent = text` destroys the old text node and inserts a new
  // one — a childList mutation inside the very subtree the body
  // MutationObserver watches. So every decorate pass scheduled the next one,
  // forever: a self-feeding loop of full-DOM walks + getBoundingClientRect
  // storms at 5 passes/second on every open ads tab, idle or not. That is the
  // "extension nặng, lag cả Chrome" report (2026-09-22). The observer now has
  // an own-node cutout (mutationIsOurs) as the real fix; this early-return is
  // the cheap second line of defence — and it also stops the banner from
  // re-rendering on passes where nothing about it changed.
  function showBanner(text, level) {
    let banner = document.getElementById('adjust-overlay-banner');
    if (!banner) banner = createBanner();
    if (banner._aoxText === text && banner._aoxLevel === level) return;
    banner._aoxText = text;
    banner._aoxLevel = level;
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
    const base = `Adjust [Google]: ${campaignIndex.size} campaigns / ${adsetIndex.size} ad groups / ${adIndex.size} ads · synced ${ageMin}m ago · ${sourceLabel}`;
    const lines = [base];
    if (syncWarnings.length) {
      lines.push(`⚠ Partial sync — ${syncWarnings.length} Adjust report(s) failed, affected pills show no data. First: ${syncWarnings[0]} · Force refresh to retry.`);
    }
    const t = lastTodayStats;
    if (!pillVis.cohort && !pillVis.today && !pillVis.yesterday && !pillVis.d2) {
      lines.push(`ⓘ All pills are hidden — re-enable them in the extension popup ("Pills shown").`);
    } else if (campaignIndex.size === 0 && adsetIndex.size === 0 && adIndex.size === 0 && dataLoaded) {
      lines.push(`⚠ Adjust returned no Google Ads rows. Check the channel filter — run docs/diagnostics/channel-probe.mjs to verify the Google channel id.`);
    } else if (!t.columnFound && (pillVis.today || pillVis.yesterday)) {
      lines.push(`⚠ Today ROAS disabled — enable the "Cost" column in this Google Ads view.`);
    } else if (t.ggDateIsYesterday && t.yestCaptured > 0) {
      lines.push(`ⓘ Đang ở view Yesterday — đã bắt spend hôm qua cho ${t.yestCaptured} dòng. Quay lại Today để xem ROAS realtime.`);
    } else if (t.ggDateIsToday === false && pillVis.today) {
      const label = t.ggDateLabel || 'unknown';
      lines.push(`⚠ Today ROAS not computed — Google Ads date range is "${label}". Switch to Today for live ROAS.`);
    } else if (t.skippedCurrencyMismatch > 0 && t.pillsRendered === 0) {
      const adj = t.adjustCurrencyExample || '?';
      const gg = t.detectedGoogleCurrency || '?';
      lines.push(`⚠ Today ROAS unavailable — Adjust app currency (${adj}) ≠ Google ad-account currency (${gg}).`);
    } else if (pillVis.yesterday && t.yestNeedSpend > 0 && t.pillsYesterday === 0) {
      lines.push(`⚠ Yesterday ROAS chưa có spend — ghé date range Yesterday một lần để extension đọc cost cell.`);
    }
    return lines.join('\n');
  }

  // ---- Decorate pass ----
  function decorateAllVisibleRows() {
    lastDecorateStats = createEmptyDecorateStats();
    lastTodayStats = createEmptyTodayStats();
    rowYBuckets = null;
    candCache = { t: 0, list: [] };
    invalidateLeafSnapshots();

    lastDecorateStats.gcOrphans = gcDisconnectedPills();
    lastDecorateStats.gcLeaked = sweepUntrackedPills();

    const candidates = pickNameCandidates();
    currentTableScope = guessTableScope(candidates);
    currentCostColumn = locateCostColumn();
    if (currentCostColumn) {
      lastTodayStats.columnFound = true;
      lastTodayStats.columnX = Math.round(currentCostColumn.headerX);
      lastTodayStats.columnHeaderText = currentCostColumn.headerText;
    }
    currentGoogleDate = detectGoogleDateInfo();
    lastTodayStats.ggDateIsToday = currentGoogleDate.isToday;
    lastTodayStats.ggDateIsYesterday = currentGoogleDate.isYesterday;
    lastTodayStats.ggDateLabel = currentGoogleDate.label;
    lastTodayStats.ggDateSource = currentGoogleDate.source;

    mainPillAnchorX = computeMainPillAnchorX();

    candidates.forEach(decorateCandidate);

    rowYBuckets = null;
    currentCostColumn = null;
    currentGoogleDate = null;
    currentTableScope = null;

    if (lastSyncAt) {
      const text = buildBannerText();
      const hasWarn = text.includes('\n⚠');
      showBanner(text, hasWarn ? 'warn' : 'ok');
    }
  }

  function removeAllPills() {
    for (const [, pill] of cellToPill) pill.remove();
    cellToPill.clear();
    for (const [, pill] of cellToTodayPill) pill.remove();
    cellToTodayPill.clear();
    for (const [, pill] of cellToYesterdayPill) pill.remove();
    cellToYesterdayPill.clear();
    for (const [, pill] of cellToD2Pill) pill.remove();
    cellToD2Pill.clear();
    document.querySelectorAll('.adjust-pill').forEach(p => p.remove());
    pickNameCandidates().forEach(el => {
      decoratedKey.delete(el);
      decoratedTodayKey.delete(el);
      decoratedYesterdayKey.delete(el);
      decoratedD2Key.delete(el);
    });
  }

  function dropPillFor(cell) {
    const pill = cellToPill.get(cell);
    if (pill) { pill.remove(); cellToPill.delete(cell); }
    lastPositioned.delete(cell);
    decoratedKey.delete(cell);
    for (const [map, dedup] of [
      [cellToTodayPill, decoratedTodayKey],
      [cellToYesterdayPill, decoratedYesterdayKey],
      [cellToD2Pill, decoratedD2Key],
    ]) {
      const p = map.get(cell);
      if (p) { p.remove(); map.delete(cell); dedup.delete(cell); }
    }
  }

  function gcDisconnectedPills() {
    let removed = 0;
    for (const [cell] of cellToPill) {
      if (cell.isConnected) continue;
      dropPillFor(cell);
      removed++;
    }
    for (const [map, dedup] of [
      [cellToTodayPill, decoratedTodayKey],
      [cellToYesterdayPill, decoratedYesterdayKey],
      [cellToD2Pill, decoratedD2Key],
    ]) {
      for (const [cell, pill] of map) {
        if (cell.isConnected) continue;
        pill.remove();
        map.delete(cell);
        dedup.delete(cell);
        removed++;
      }
    }
    return removed;
  }

  function sweepUntrackedPills() {
    const live = new Set();
    for (const pill of cellToPill.values()) live.add(pill);
    for (const pill of cellToTodayPill.values()) live.add(pill);
    for (const pill of cellToYesterdayPill.values()) live.add(pill);
    for (const pill of cellToD2Pill.values()) live.add(pill);
    let removed = 0;
    document.querySelectorAll('.adjust-pill').forEach(node => {
      if (!live.has(node)) { node.remove(); removed++; }
    });
    return removed;
  }

  let decoratePending = false;

  function scheduleDecorate() {
    if (decorateTimer || decoratePending) return;
    decorateTimer = setTimeout(() => {
      decorateTimer = null;
      decoratePending = true;
      // Run the pass in idle time (v0.12.5): a decorate walks the DOM and reads
      // geometry, so running it inline during Google's own layout burst is what
      // turned "extension on" into visible jank. The timeout keeps it bounded —
      // a page that never goes idle still gets decorated within 400 ms.
      const run = () => { decoratePending = false; decorateAllVisibleRows(); };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 400 });
      } else {
        run();
      }
    }, 300);
  }

  // Is this mutation one WE caused? Appending a pill to <body>, moving one, or
  // rewriting the banner all fire mutations on the very tree we observe.
  // v0.12.4 reacted to those too, so every decorate pass scheduled the next one
  // — a self-sustaining 200 ms loop of full-DOM walks that never settled even
  // on a completely idle tab. This is the cutout.
  function isOwnElement(node) {
    return node.nodeType === 1 && node.classList
      && (node.classList.contains('adjust-pill') || node.id === 'adjust-overlay-banner');
  }

  function mutationIsOurs(rec) {
    const t = rec.target;
    const host = t && (t.nodeType === 1 ? t : t.parentElement);
    if (host && isOwnNode(host)) return true;
    if (rec.type !== 'childList') return false;
    if (rec.addedNodes.length === 0 && rec.removedNodes.length === 0) return false;
    for (const node of rec.addedNodes) if (!isOwnElement(node)) return false;
    for (const node of rec.removedNodes) if (!isOwnElement(node)) return false;
    return true;
  }

  function ensureObserving() {
    if (bodyObserver) return;
    // characterData included: Google's virtual scroller sometimes swaps a
    // cell's text in place instead of replacing the node, which childList
    // alone would miss — the recycled node would keep the old row's pill.
    bodyObserver = new MutationObserver((records) => {
      for (const rec of records) {
        if (mutationIsOurs(rec)) continue;
        scheduleDecorate();
        return;
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Virtual scrolling may translate existing nodes without DOM mutations;
    // the rAF loop repositions live pills, but newly revealed rows need a
    // decorate pass. Wake the cheap reposition loop immediately (it parks itself
    // when idle — see RAF_IDLE_FRAMES) and leave the expensive decorate pass
    // debounced. Passive + capture: Google scrolls inner panes, not the window.
    const onViewportChange = () => {
      if (rafParked || !rafHandle) ensureRepositionLoop();
      scheduleDecorate();
    };
    document.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
  }

  function logDomDiagnostics() {
    const candidates = pickNameCandidates();
    let firstMatch = null;
    let matchedLevel = null;
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      const k = canonicalKey(text);
      const lvl = adIndex.has(k) ? 'ad' : adsetIndex.has(k) ? 'adset' : campaignIndex.has(k) ? 'campaign' : null;
      if (lvl) { firstMatch = text.slice(0, 120); matchedLevel = lvl; break; }
    }
    console.log(
      '%c[AOX-GG]%c DOM diagnostics',
      'background:#188038;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
      'color:#188038', {
      version: INJECTOR_VERSION,
      tab: getCurrentTab(),
      urlCampaignId: getUrlCampaignId(),
      candidatesFound: candidates.length,
      clusterSizes: lastDecorateStats.clusterSizes,
      firstMatchText: firstMatch,
      firstMatchLevel: matchedLevel,
      indexSizes: {
        campaign: campaignIndex.size,
        campById: campByIdIndex.size,
        adset: adsetIndex.size,
        adsetById: adsetByIdIndex.size,
        ad: adIndex.size,
        adById: adByIdIndex.size,
      },
      decorateStats: lastDecorateStats,
      todayStats: lastTodayStats,
    });
  }

  // ---- Pill visibility (per type, from the popup) ----
  let pillVis = { cohort: true, today: true, yesterday: false, d2: false };

  async function loadPillVisibility() {
    try {
      const { pillVisibility } = await chrome.storage.local.get('pillVisibility');
      const g = pillVisibility?.google || {};
      pillVis = {
        cohort:    typeof g.cohort    === 'boolean' ? g.cohort    : true,
        today:     typeof g.today     === 'boolean' ? g.today     : true,
        yesterday: typeof g.yesterday === 'boolean' ? g.yesterday : false,
        d2:        typeof g.d2        === 'boolean' ? g.d2        : false,
      };
    } catch { /* keep defaults */ }
  }

  // ---- Init ----
  Promise.all([loadColorThresholds(), loadPillVisibility(), loadReportingOffset()]).then(() => {
    console.log(
      `%c[AOX-GG ${INJECTOR_VERSION}]%c pills enabled → ` +
      `cohort:${pillVis.cohort ? 'on' : 'OFF'} ` +
      `today:${pillVis.today ? 'on' : 'OFF'} ` +
      `yesterday:${pillVis.yesterday ? 'on' : 'OFF'} ` +
      `d2:${pillVis.d2 ? 'on' : 'OFF'}`,
      'background:#188038;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
      'color:#188038;font-weight:bold'
    );
    loadData();
  });

  // Safety net: Google Ads renders its table seconds after document_idle, and
  // the first GET_CACHED can race a cold service worker. Retry until data has
  // loaded AND some candidate matched, then settle into observer-driven mode.
  // Budget raised from 30 s (15 x 2 s, v0.12.4) to ~2.5 min, and the tail
  // backs off to 5 s. WHY: on the Jelly - Chatbot 2 account the campaigns view
  // (2 filters / 725 campaigns) does not paint its first rows for well over a
  // minute — measured 2026-09-22, a CDP Runtime.evaluate against that tab timed
  // out at 45 s while it was still loading. The old budget expired before the
  // table existed, so the FIRST paint of pills depended entirely on a later
  // mutation arriving — which is exactly the "Google Ads đã load nhưng không
  // show pills" report. Backing off keeps the long tail cheap.
  const MAX_RETRIES = 40;
  const FAST_RETRIES = 15;
  let retriesLeft = MAX_RETRIES;
  let retryTimer = 0;

  function retryTick() {
    if (retriesLeft-- <= 0) return;
    if (!dataLoaded) {
      loadData();
    } else if (!hasLivePills()) {
      scheduleDecorate();
    } else {
      return; // table found and decorated — the observer owns it from here
    }
    const delay = retriesLeft > (MAX_RETRIES - FAST_RETRIES) ? 2000 : 5000;
    retryTimer = setTimeout(retryTick, delay);
  }
  retryTimer = setTimeout(retryTick, 2000);

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
      ggYestSpendCache.clear();
      loadReportingOffset().then(() => {
        removeAllPills();
        decorateAllVisibleRows();
      });
    } else if (changes.pillVisibility) {
      loadPillVisibility().then(() => {
        removeAllPills();
        decorateAllVisibleRows();
      });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    gcDisconnectedPills();
    sweepUntrackedPills();
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    ensureRepositionLoop();
    scheduleDecorate();
  });
})();
