// src/data-source.js
// Adapter pattern. Today: pulls direct from Adjust API.
// Later (when JM-AM exits soak): swap to JmAmDataSource without touching anything else.

import { fetchCampaignROAS, fetchTodayGrossRevenue } from './adjust-client.js';
import { canonicalKey } from './matcher.js';

/**
 * Common interface every data source must implement.
 *   fetchAll(): Promise<Array<{campaignName, network, roas: {d0, d3, d7, allTime}}>>
 */

export class AdjustDirectDataSource {
  constructor({ apiToken, utcOffset, datePeriod, appTokens }) {
    this.apiToken = apiToken;
    this.utcOffset = utcOffset;
    this.datePeriod = datePeriod;
    this.appTokens = appTokens;
  }

  async fetchAll() {
    // Parallel: existing cohort pipeline + new today-revenue pipeline. The
    // today fetch is allowed to fail without taking down the cohort pills —
    // the today pill simply won't render. This keeps the existing user
    // experience intact if Adjust adds/changes the today endpoint shape.
    const [cohortRows, todayRows] = await Promise.all([
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
    ]);
    return mergeTodayInto(cohortRows, todayRows);
  }

  describe() {
    // The v2 endpoint pulls data for every app the API token has access to,
    // so there's nothing app-specific to identify the source by.
    return 'Adjust Reporting v2 (Meta + TikTok)';
  }
}

// Attach revenueToday + currency from todayRows onto matching cohortRows.
// Match priority: Meta ID (campaign / adset / ad) when both sides carry it,
// then canonical name as fallback. Today-only rows (ads that ran today but
// have no cohort row in the cohort fetch's wider window) are appended with
// roas fields = null — covers brand-new ads launched today.
//
// Output rows always carry: revenueToday (number, 0 if no match),
// todayRowExisted (bool), adjustCurrency (string|null). Cache-shape addition
// is backwards-compatible — readers that don't know about the new fields
// behave exactly as before.
function mergeTodayInto(cohortRows, todayRows) {
  const idIndex = new Map();
  const nameIndex = new Map();
  for (const t of todayRows) {
    const idKey = todayIdKey(t);
    if (idKey) idIndex.set(idKey, t);
    const nameKey = todayNameKey(t);
    if (nameKey && !nameIndex.has(nameKey)) nameIndex.set(nameKey, t);
  }

  const matched = new Set();
  const out = [];
  for (const c of cohortRows) {
    const idKey = todayIdKey(c);
    const nameKey = todayNameKey(c);
    const match = (idKey && idIndex.get(idKey)) || (nameKey && nameIndex.get(nameKey)) || null;
    if (match) matched.add(match);
    out.push({
      ...c,
      revenueToday: match?.revenueToday ?? 0,
      todayRowExisted: !!match,
      adjustCurrency: match?.currency ?? null,
    });
  }

  // Today-only rows (no cohort counterpart): append with cohort fields nulled.
  // matcher.js's canonicalKey is applied indirectly via todayNameKey, so the
  // injector's index builders will still key these by their canonical names.
  for (const t of todayRows) {
    if (matched.has(t)) continue;
    out.push({
      level: t.level,
      campaignName: t.campaignName,
      adsetName: t.adsetName,
      adName: t.adName,
      campaignId: t.campaignId,
      adsetId: t.adsetId,
      adId: t.adId,
      network: t.network,
      cost: null,
      cohortAllRevenue: null,
      installs: null,
      roas: { d0: null, d3: null, d7: null, allTime: null },
      revenueToday: t.revenueToday ?? 0,
      todayRowExisted: true,
      adjustCurrency: t.currency || null,
    });
  }
  return out;
}

function todayIdKey(row) {
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

function todayNameKey(row) {
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
  const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
  const cfg = dataSourceConfig || { kind: 'adjust-direct' };

  if (cfg.kind === 'jm-am') {
    return new JmAmDataSource(cfg);
  }
  return new AdjustDirectDataSource(cfg);
}
