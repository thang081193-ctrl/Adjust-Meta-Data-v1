// src/data-source.js
// Adapter pattern. Today: pulls direct from Adjust API.
// Later (when JM-AM exits soak): swap to JmAmDataSource without touching anything else.

import { fetchCampaignROAS, fetchTodayGrossRevenue, fetchYesterdayGrossRevenue } from './adjust-client.js';
import { canonicalKey } from './matcher.js';

/**
 * Common interface every data source must implement.
 *   fetchAll(): Promise<Array<{campaignName, network, roas: {d0, d3, d7, allTime}}>>
 */

export class AdjustDirectDataSource {
  constructor({ apiToken, utcOffset, datePeriod, appTokens, fetchYesterday = false }) {
    this.apiToken = apiToken;
    this.utcOffset = utcOffset;
    this.datePeriod = datePeriod;
    this.appTokens = appTokens;
    // Only pull the yesterday event-date report when the Yesterday realtime
    // pill is enabled (set from pillVisibility in createDataSource). Saves one
    // multi-level report call per sync when the pill is off.
    this.fetchYesterday = fetchYesterday;
  }

  async fetchAll() {
    // Parallel: cohort pipeline + today-revenue pipeline + optional
    // yesterday-revenue pipeline. Each realtime fetch is allowed to fail
    // without taking down the cohort pills — that pill simply won't render.
    // This keeps the existing user experience intact if Adjust changes the
    // realtime endpoint shape.
    //
    // yesterdayAvailable tracks whether the yesterday fetch actually SUCCEEDED
    // (toggle on AND no error). When it didn't, mergeRealtimeInto leaves
    // revenueYesterday null (not 0) so the pill shows a "no data" dash instead
    // of a fabricated red 0% — distinguishing a failed/absent fetch from a
    // genuine zero-revenue day.
    let yesterdayAvailable = false;
    const yesterdayPromise = this.fetchYesterday
      ? fetchYesterdayGrossRevenue({
          apiToken: this.apiToken,
          utcOffset: this.utcOffset,
          appTokens: this.appTokens,
        }).then(rows => { yesterdayAvailable = true; return rows; })
          .catch(err => {
            console.warn('[Adjust Overlay] yesterday-revenue fetch failed:', err.message);
            return [];
          })
      : Promise.resolve([]);

    const [cohortRows, todayRows, yesterdayRows] = await Promise.all([
      fetchCampaignROAS({
        apiToken: this.apiToken,
        utcOffset: this.utcOffset,
        datePeriod: this.datePeriod,
        appTokens: this.appTokens,
      }),
      fetchTodayGrossRevenue({
        apiToken: this.apiToken,
        utcOffset: this.utcOffset,
        appTokens: this.appTokens,
      }).catch(err => {
        console.warn('[Adjust Overlay] today-revenue fetch failed:', err.message);
        return [];
      }),
      yesterdayPromise,
    ]);
    return mergeRealtimeInto(cohortRows, todayRows, yesterdayRows, yesterdayAvailable);
  }

  describe() {
    // The v2 endpoint pulls data for every app the API token has access to,
    // so there's nothing app-specific to identify the source by.
    return 'Adjust Reporting v2 (Meta + TikTok)';
  }
}

// Attach revenueToday + revenueYesterday + currency from the realtime fetches
// onto matching cohortRows. Match priority: Meta ID (campaign / adset / ad)
// when both sides carry it, then canonical name as fallback. Realtime-only
// rows (an ad that ran today/yesterday but has no cohort row in the cohort
// fetch's wider window) are appended with roas fields = null; a row present in
// BOTH today and yesterday orphan sets is merged into one output row carrying
// both revenue fields.
//
// Output rows always carry: revenueToday (number, 0 if no match),
// revenueYesterday (number 0 for a genuine no-match when the yesterday fetch
// SUCCEEDED, or null when it didn't run / failed), todayRowExisted (bool),
// adjustCurrency (string|null). Cache-shape addition is backwards-compatible —
// readers that don't know about the new fields behave exactly as before.
//
// yesterdayAvailable: true only when the yesterday fetch ran and succeeded. When
// false, revenueYesterday is null on every row so the pill renders a "no data"
// dash rather than a fabricated 0% ROAS.
function mergeRealtimeInto(cohortRows, todayRows, yesterdayRows, yesterdayAvailable = false) {
  const today = buildRealtimeIndex(todayRows);
  const yest = buildRealtimeIndex(yesterdayRows);
  // 0 for a genuine no-match only when the fetch succeeded; null otherwise.
  const yestMiss = yesterdayAvailable ? 0 : null;

  const matchedToday = new Set();
  const matchedYest = new Set();
  const out = [];

  for (const c of cohortRows) {
    const tMatch = matchRealtime(c, today);
    const yMatch = matchRealtime(c, yest);
    if (tMatch) matchedToday.add(tMatch);
    if (yMatch) matchedYest.add(yMatch);
    out.push({
      ...c,
      revenueToday: tMatch?.revenueToday ?? 0,
      revenueYesterday: yMatch?.revenueYesterday ?? yestMiss,
      todayRowExisted: !!tMatch,
      adjustCurrency: tMatch?.currency ?? yMatch?.currency ?? null,
    });
  }

  // Realtime-only rows (no cohort counterpart): append with cohort fields
  // nulled. Dedup today-only and yesterday-only orphans by the same key space
  // so a row seen in both merges into one output row.
  const orphanMap = new Map();
  const addOrphan = (r, which, matchedSet) => {
    if (matchedSet.has(r)) return;
    const k = orphanKey(r);
    let o = orphanMap.get(k);
    if (!o) {
      o = {
        level: r.level,
        campaignName: r.campaignName,
        adsetName: r.adsetName,
        adName: r.adName,
        campaignId: r.campaignId,
        adsetId: r.adsetId,
        adId: r.adId,
        network: r.network,
        cost: null,
        cohortAllRevenue: null,
        installs: null,
        roas: { d0: null, d3: null, d7: null, allTime: null },
        revenueToday: 0,
        revenueYesterday: yestMiss,
        todayRowExisted: false,
        adjustCurrency: r.currency || null,
      };
      orphanMap.set(k, o);
    }
    if (which === 'today') { o.revenueToday = r.revenueToday ?? 0; o.todayRowExisted = true; }
    else { o.revenueYesterday = r.revenueYesterday ?? 0; }
    if (!o.adjustCurrency && r.currency) o.adjustCurrency = r.currency;
  };
  for (const t of todayRows) addOrphan(t, 'today', matchedToday);
  for (const y of yesterdayRows) addOrphan(y, 'yesterday', matchedYest);
  for (const o of orphanMap.values()) out.push(o);

  return out;
}

// Build id + name lookup indexes for a set of realtime (event-date) rows.
function buildRealtimeIndex(rows) {
  const idIndex = new Map();
  const nameIndex = new Map();
  for (const r of rows) {
    const idKey = realtimeIdKey(r);
    if (idKey) idIndex.set(idKey, r);
    const nameKey = realtimeNameKey(r);
    if (nameKey && !nameIndex.has(nameKey)) nameIndex.set(nameKey, r);
  }
  return { idIndex, nameIndex };
}

function matchRealtime(row, index) {
  const idKey = realtimeIdKey(row);
  const nameKey = realtimeNameKey(row);
  return (idKey && index.idIndex.get(idKey)) || (nameKey && index.nameIndex.get(nameKey)) || null;
}

// Stable key for orphan dedup across the today/yesterday sets. Deliberately
// keyed by level + campaignId + canonical NAME (via realtimeNameKey), NOT by
// adId: Adjust can return creative_id_network on one event-date fetch and null
// (a finalization shadow) on the other for the SAME ad, so an adId-first key
// would split one ad's today-orphan and yesterday-orphan into two same-named
// rows that then collide as "ambiguous" downstream and suppress both realtime
// pills. Name+campaign keying merges them into one orphan carrying both fields.
function orphanKey(r) {
  const nameKey = realtimeNameKey(r) ||
    `${r.level}::${r.campaignName}::${r.adsetName}::${r.adName}`;
  return r.campaignId ? `${r.campaignId}::${nameKey}` : nameKey;
}

function realtimeIdKey(row) {
  if (row.level === 'ad' && row.adId) return `ad::${row.adId}`;
  if (row.level === 'adset' && row.adsetId) return `adset::${row.adsetId}`;
  // NOTE: ad-level rows with adId=null MUST NOT fall back to
  // `adset::${adsetId}` — that namespace is owned by adset-level rows, and
  // a shadow ad-row (creative_id_network=null) would clobber the legitimate
  // adset-level today row in idIndex, making the cohort adset row match the
  // shadow's revenue while the real adset today row gets orphan-appended.
  // Net effect: both rows end up in cache with same adsetId, both get summed
  // into adsetByIdIndex, pill displays double-counted revenue. Verified
  // 2026-05-18. See docs/findings/adjust_today_shadow_row.md.
  if (row.campaignId) return `${row.level}::camp::${row.campaignId}::` +
    `${canonicalKey(row.adName || row.adsetName || row.campaignName || '')}`;
  return null;
}

function realtimeNameKey(row) {
  if (row.level === 'campaign') return `campaign::${canonicalKey(row.campaignName || '')}`;
  if (row.level === 'adset') return `adset::${canonicalKey(row.adsetName || '')}`;
  // ad-level row: key by ad name; adset is implicit. Name-only matches risk
  // collisions for ads with duplicate names across campaigns — but in that
  // case the ID-key path above already resolved the canonical one; this is
  // a fallback only when ID is missing on both sides.
  return `ad::${canonicalKey(row.adName || '')}`;
}

/**
 * Future implementation - calls JM-AM endpoint that already aggregates Adjust data.
 * Same return shape, so consumer code never changes.
 */
export class JmAmDataSource {
  constructor({ baseUrl, apiKey, appId }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.appId = appId;
  }

  async fetchAll() {
    // TODO(pham): when JM-AM is out of soak, expose an endpoint like
    //   GET {baseUrl}/api/adjust/campaign-roas?app={appId}&windows=d0,d3,d7,all
    // returning the same shape as AdjustDirectDataSource.fetchAll().
    const res = await fetch(`${this.baseUrl}/api/adjust/campaign-roas?app=${this.appId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`JM-AM fetch failed: ${res.status}`);
    return res.json();
  }

  describe() {
    return `JM-AM (app=${this.appId})`;
  }
}

/**
 * Factory. Reads config from chrome.storage and returns the active source.
 */
export async function createDataSource() {
  const { dataSourceConfig, pillVisibility } = await chrome.storage.local.get([
    'dataSourceConfig', 'pillVisibility',
  ]);
  const cfg = dataSourceConfig || { kind: 'adjust-direct' };

  if (cfg.kind === 'jm-am') {
    return new JmAmDataSource(cfg);
  }
  // Only fetch the yesterday event-date report when the Meta Yesterday pill is
  // enabled — avoids an extra multi-level Adjust call on every sync otherwise.
  const fetchYesterday = !!(pillVisibility?.meta?.yesterday);
  return new AdjustDirectDataSource({ ...cfg, fetchYesterday });
}
