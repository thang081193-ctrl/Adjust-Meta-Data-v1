// src/data-source.js
// Adapter pattern. Today: pulls direct from Adjust API.
// Later (when JM-AM exits soak): swap to JmAmDataSource without touching anything else.

import { fetchCampaignROAS } from './adjust-client.js';

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
    return fetchCampaignROAS({
      apiToken: this.apiToken,
      utcOffset: this.utcOffset,
      datePeriod: this.datePeriod,
      appTokens: this.appTokens,
    });
  }

  describe() {
    // The v2 endpoint pulls data for every app the API token has access to,
    // so there's nothing app-specific to identify the source by.
    return 'Adjust Reporting v2 (Meta + TikTok)';
  }
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
