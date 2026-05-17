// src/data-source.js
//
// v2-secure variant: a single ProxyDataSource that calls the Cloudflare Worker
// proxy. AdjustDirectDataSource and JmAmDataSource are gone — there is no API
// token in this codebase to support a "direct" mode, and there is no JM-AM
// fallback. If the proxy is down, the extension fails closed (no stale data,
// no fallback path that could leak the Adjust token elsewhere).

import { fetchCampaignROAS, fetchTodayGrossRevenue } from './proxy-client.js';
import { canonicalKey } from './matcher.js';

/**
 * fetchAll(): Promise<Array<{campaignName, network, roas: {d0, d3, d7, allTime}, revenueToday, todayRowExisted, adjustCurrency}>>
 */
export class ProxyDataSource {
  constructor({ utcOffset, datePeriod }) {
    this.utcOffset = utcOffset;
    this.datePeriod = datePeriod;
  }

  async fetchAll() {
    // Parallel: cohort + today. Today is allowed to fail without taking down
    // cohort pills — same degradation strategy as the original direct client.
    const [cohortRows, todayRows] = await Promise.all([
      fetchCampaignROAS({
        utcOffset: this.utcOffset,
        datePeriod: this.datePeriod,
      }),
      fetchTodayGrossRevenue({
        utcOffset: this.utcOffset,
      }).catch(err => {
        console.warn('[Adjust Overlay] today-revenue fetch failed:', err.message);
        return [];
      }),
    ]);
    return mergeTodayInto(cohortRows, todayRows);
  }

  describe() {
    return 'Adjust Reporting v2 (via secure proxy)';
  }
}

// Attach revenueToday + currency from todayRows onto matching cohortRows.
// Match priority: Meta ID (campaign / adset / ad) when both sides carry it,
// then canonical name as fallback. Today-only rows (ads that ran today but
// have no cohort row in the cohort fetch's wider window) are appended with
// roas fields = null — covers brand-new ads launched today.
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
  if (row.level === 'ad' && row.adsetId) return `adset::${row.adsetId}`;
  if (row.campaignId) return `${row.level}::camp::${row.campaignId}::` +
    `${canonicalKey(row.adName || row.adsetName || row.campaignName || '')}`;
  return null;
}

function todayNameKey(row) {
  if (row.level === 'campaign') return `campaign::${canonicalKey(row.campaignName || '')}`;
  return `ad::${canonicalKey(row.adName || '')}`;
}

/**
 * Factory. Reads period preference from chrome.storage and returns the source.
 * No API token / app token configuration here — those live server-side.
 */
export async function createDataSource() {
  const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
  const cfg = dataSourceConfig || {};
  return new ProxyDataSource({
    utcOffset: cfg.utcOffset || '+07:00',
    datePeriod: cfg.datePeriod || 'rolling30',
  });
}
