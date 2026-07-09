// src/adjust-client.js
// Adjust Reporting Service v2 (Datascape) client.
//
// Endpoint + params verified 2026-05-07 by capturing the Datascape dashboard's
// own XHR call to https://automate.adjust.com/reports-service/report.
//
// AUTH NOTE (unverified — needs first-run check):
// The dashboard uses session cookies. For programmatic access we send the API
// token from Account Settings → My profile via Authorization: Bearer header,
// which is Adjust's documented v2 scheme. If we get HTTP 401 on first sync,
// switch to passing the token as `?api_token=...` query param instead.
//
// CRITICAL ACCURACY NOTES:
// - API returns numeric metrics as STRINGS — always parseFloat.
// - all-time ROAS is not a native metric; computed client-side as
//   cohort_all_revenue / cost (matches Datascape's "All revenue (cohort)" col).
// - On any HTTP error, throw — caller must NOT silently fall back to stale data.

const ADJUST_BASE = 'https://automate.adjust.com/reports-service/report';

// Adjust occasionally takes 30+ seconds for large multi-app reports; cap at
// 60s so a hung server doesn't leave the popup's Force-refresh button stuck
// disabled forever. AbortSignal.timeout (Chrome 103+) gives us cancellation
// without manual setTimeout/clear bookkeeping.
const FETCH_TIMEOUT_MS = 60_000;

function adjustFetch(url, apiToken) {
  return fetch(url, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// Adjust channel ids per ad network. Verified from the dashboard URL's
// `channel_id__in` param. We pass both in a single comma-separated request so
// one Adjust call returns rows for every network the extension supports — the
// response carries a `channel` field per row (e.g. "Facebook", "TikTok for
// Business") that the per-platform content scripts use to filter.
//
// To add another network: capture its channel_id from the Adjust dashboard
// URL after applying its filter, and append here.
const NETWORK_CHANNEL_IDS = [
  'partner_34',    // Facebook (Meta Ads Manager)
  'partner_1678',  // TikTok for Business
  '2337',          // TikTok new integration channel (captured from dashboard
                   // URL 2026-05-08 — sent without 'partner_' prefix, contains
                   // newer trackers `1z*`/`20*+` that hold install/revenue
                   // data for the post-cutoff TikTok integration).
];

/**
 * Fetch ROAS data at three levels (campaign / ad set / ad) so pills can
 * decorate whichever Meta Ads Manager tab the user is on. Two parallel calls
 * are required because Adjust's cohort attribution math is computed
 * independently at each grouping level — aggregating ad-level rows up to a
 * campaign total drifts ~1–14% on tiny low-install campaigns vs. asking
 * Adjust directly. Verified by curl 2026-05-07.
 *
 * @param {object} cfg
 * @param {string} cfg.apiToken      - Adjust API token (Account → My profile)
 * @param {string} [cfg.utcOffset]   - e.g. '+07:00'
 * @param {string} [cfg.datePeriod]  - Adjust date_period. Accepts:
 *   - Rolling keywords (computed client-side as YYYY-MM-DD:YYYY-MM-DD ending
 *     yesterday, mirroring Datascape's rolling presets exactly):
 *       'rolling3', 'rolling7', 'rolling30' (default).
 *   - Adjust native keywords: 'today', 'yesterday', 'this_week', 'last_week',
 *     'this_month', 'last_month'.
 *   - Explicit range: 'YYYY-MM-DD:YYYY-MM-DD'.
 *   Verified by curl 2026-05-07: Adjust's 'last_7_days' / 'last_30_days' /
 *   'last_quarter' / 'this_year' return HTTP 400 — do NOT pass those through.
 * @returns {Promise<Array<Row>>} Each Row carries a `level` field of either
 *   'campaign' (one row per campaign) or 'ad' (one row per ad — adsetName
 *   and adName populated).
 */
export async function fetchCampaignROAS({
  apiToken,
  utcOffset = '+07:00',
  datePeriod = 'rolling30',
  appTokens,
}) {
  const resolvedPeriod = expandDatePeriod(datePeriod);

  const [campaignRows, adsetRows, adRows] = await Promise.all([
    fetchAtLevel({
      apiToken, utcOffset, datePeriod: resolvedPeriod, appTokens,
      dimensions: 'channel,campaign_network',
    }),
    // Adset-level direct fetch — separate from ad-level roll-up. Avoids
    // creative_id_network attribution shadows: when Adjust occasionally
    // returns a duplicate ad-level row with creative_id_network=null during
    // real-time attribution finalization, naive sum-of-ad-rows inflates the
    // adset total vs. what Datascape's adset-view shows. Direct adset query
    // (without creative dim) returns a single canonical row per adset.
    fetchAtLevel({
      apiToken, utcOffset, datePeriod: resolvedPeriod, appTokens,
      dimensions: 'channel,campaign_network,adgroup_network',
    }),
    fetchAtLevel({
      apiToken, utcOffset, datePeriod: resolvedPeriod, appTokens,
      dimensions: 'channel,campaign_network,adgroup_network,creative_network',
    }),
  ]);

  const out = [];
  for (const row of campaignRows) out.push(toRow(row, 'campaign'));
  for (const row of adsetRows) out.push(toRow(row, 'adset'));
  for (const row of adRows) out.push(toRow(row, 'ad'));
  return out;
}

async function fetchAtLevel({ apiToken, utcOffset, datePeriod, dimensions, appTokens }) {
  const params = new URLSearchParams({
    format_dates: 'false',
    full_data: 'true',
    readable_names: 'false',
    ad_spend_mode: 'network',
    attribution_source: 'first',
    attribution_type: 'all',
    channel_id__in: NETWORK_CHANNEL_IDS.join(','),
    cohort_maturity: 'immature',
    date_period: datePeriod,
    dimensions,
    fingerprint_status: 'all',
    // attr_dependency carries campaign_id_network (Meta's campaign id), used
    // to disambiguate ads that share a name across multiple campaigns.
    include_attr_dependency: 'true',
    digital_turbine_mode: 'digital_turbine',
    ironsource_mode: 'ironsource',
    // 10000 cap is enough for a few hundred apps; bump if the dashboard ever
    // emits a 'limit_rows' data_warning we want to silence.
    limit: '10000',
    // roas_d3 may or may not be supported by the account; if missing it parses
    // to null and the decision engine treats it as incomplete data.
    metrics: 'cost,roas_d0,roas_d3,roas_d7,cohort_all_revenue,installs',
    reattributed: 'all',
    sandbox: 'false',
    sdk_signature_enforcement_status: 'all',
    sort: '-installs',
    utc_offset: utcOffset,
  });

  // Without app_token__in, Adjust auto-applies a default tracker_filter
  // built from the user's account-wide tracker permissions. Verified
  // 2026-05-08: that auto-filter excludes newer trackers (TikTok integration
  // tokens minted after a cutoff date), so install/revenue rollups for newer
  // networks come back as zero while the cost endpoint still reports spend.
  // Passing app_token__in scopes Adjust's auto tracker_filter to the chosen
  // apps' full tracker set — matching what the Datascape dashboard does when
  // a user filters by App in the UI.
  if (appTokens) {
    const cleaned = String(appTokens).trim();
    if (cleaned) params.set('app_token__in', cleaned);
  }

  const url = `${ADJUST_BASE}?${params}`;

  // credentials: 'omit' forbids the browser from attaching any adjust.com
  // cookies. Without this, a stale session cookie in the profile (e.g. from
  // a previous Adjust login) gets sent alongside our Bearer token, and Adjust
  // rejects the request with "It is impossible to check account ownership!"
  // because the cookie identifies user A while the token identifies user B.
  let res;
  try {
    res = await adjustFetch(url, apiToken);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Adjust API timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Adjust API failed: ${res.status} ${res.statusText}` +
        (body ? ` — ${body.slice(0, 200)}` : '')
    );
  }

  const json = await res.json();
  return json?.rows || [];
}

// Realtime "Today" revenue, event-date attribution (NOT cohort). Used by the
// Today pill alongside the existing D0/3d/7d/All cohort pills. We ask Adjust
// for `revenue` instead of `cohort_*_revenue` so the number includes every
// purchase event fired today regardless of when the user installed — which is
// the denominator-correct match for Meta's "Amount spent today".
//
// Separated from fetchCampaignROAS so the existing cohort pipeline is untouched
// and a failure in this fetch degrades gracefully (caller catches and the
// today pill simply doesn't render).
//
// VERIFICATION NOTE: response shape (rows[].revenue, rows[].currency) is the
// documented Reporting v2 shape but specific account/app combinations may
// return either a `currency` field or an `app_currency` field; parser below
// accepts both. If a real account returns neither, currency-mismatch logic in
// the injector falls back to symbol-only detection from the Meta UI cell.
export async function fetchTodayGrossRevenue({ apiToken, utcOffset = '+07:00', appTokens }) {
  const rows = await fetchGrossRevenue({ apiToken, utcOffset, appTokens, datePeriod: 'today' });
  for (const r of rows) { r.revenueToday = r.revenue; }
  return rows;
}

// Realtime "Yesterday" revenue, event-date attribution (NOT cohort). Powers the
// optional Yesterday realtime pill (Adjust yesterday gross rev ÷ Meta yesterday
// spend read from the DOM). This uses the SAME event-date endpoint as the today
// fetch — the key property is that event-date revenue is available in near-real
// time and is NOT gated by Adjust's once-a-day cohort finalization (the post-9am
// pull). So the user gets a directional yesterday ROAS well before cohort
// roas_d0 for yesterday's installs matures.
//
// NOTE: a previous fetchYesterdayGrossRevenue was removed in v0.8.1 because the
// LA-timezone today-pill switched to a BKT-anchored model that no longer needed
// yesterday REVENUE (only yesterday SPEND). This re-introduction serves a
// different purpose (the Yesterday pill), so callers gate it behind that pill's
// toggle to avoid paying the extra report call when the pill is off.
export async function fetchYesterdayGrossRevenue({ apiToken, utcOffset = '+07:00', appTokens }) {
  const rows = await fetchGrossRevenue({ apiToken, utcOffset, appTokens, datePeriod: 'yesterday' });
  for (const r of rows) { r.revenueYesterday = r.revenue; }
  return rows;
}

async function fetchGrossRevenue({ apiToken, utcOffset = '+07:00', appTokens, datePeriod }) {
  const [campaignRows, adsetRows, adRows] = await Promise.all([
    fetchGrossRevenueAtLevel({
      apiToken, utcOffset, appTokens, datePeriod,
      dimensions: 'channel,campaign_network',
    }),
    // Adset-level direct fetch — see comment in fetchCampaignROAS.
    fetchGrossRevenueAtLevel({
      apiToken, utcOffset, appTokens, datePeriod,
      dimensions: 'channel,campaign_network,adgroup_network',
    }),
    fetchGrossRevenueAtLevel({
      apiToken, utcOffset, appTokens, datePeriod,
      dimensions: 'channel,campaign_network,adgroup_network,creative_network',
    }),
  ]);
  const out = [];
  for (const row of campaignRows) out.push(toGrossRow(row, 'campaign'));
  for (const row of adsetRows) out.push(toGrossRow(row, 'adset'));
  for (const row of adRows) out.push(toGrossRow(row, 'ad'));
  return out;
}

async function fetchGrossRevenueAtLevel({ apiToken, utcOffset, dimensions, appTokens, datePeriod }) {
  const params = new URLSearchParams({
    format_dates: 'false',
    full_data: 'true',
    readable_names: 'false',
    ad_spend_mode: 'network',
    attribution_source: 'first',
    attribution_type: 'all',
    channel_id__in: NETWORK_CHANNEL_IDS.join(','),
    date_period: datePeriod,
    dimensions,
    fingerprint_status: 'all',
    include_attr_dependency: 'true',
    digital_turbine_mode: 'digital_turbine',
    ironsource_mode: 'ironsource',
    limit: '10000',
    // `revenue` (IAP event-date) + `ad_revenue` (IAA event-date). User's apps
    // are IAA-style; Datascape's metric picker exposes a "Ad revenue (cohort)"
    // column, confirming `ad_revenue` exists. toTodayRow sums whichever come
    // back per row.
    // Verified 2026-05-11:
    //  - `revenue` returns rows:[] for IAA apps (IAP only).
    //  - `currency` is not a valid metric ("Unsupported metric: currency").
    //  - `all_revenue` also returns empty.
    //  - `network_revenue` is not supported ("network event doesn't exist or
    //    was renamed").
    metrics: 'revenue,ad_revenue',
    reattributed: 'all',
    sandbox: 'false',
    sdk_signature_enforcement_status: 'all',
    sort: '-ad_revenue',
    utc_offset: utcOffset,
  });
  if (appTokens) {
    const cleaned = String(appTokens).trim();
    if (cleaned) params.set('app_token__in', cleaned);
  }

  let res;
  try {
    res = await adjustFetch(`${ADJUST_BASE}?${params}`, apiToken);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Adjust ${datePeriod} fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Adjust ${datePeriod} fetch failed: ${res.status} ${res.statusText}` +
        (body ? ` — ${body.slice(0, 200)}` : '')
    );
  }
  const json = await res.json();
  return json?.rows || [];
}

function toGrossRow(row, level) {
  const dep = row.attr_dependency || {};
  // Tolerate any revenue-named field Adjust returns. `all_revenue` is the
  // intended event-date total; we also fall through to `network_revenue`
  // (IAA-only) and `revenue` (IAP-only) in case the account's data shape
  // differs. Sum when multiple are present so partial metric availability
  // never silently drops data.
  let revenue = 0;
  let saw = false;
  for (const key of ['all_revenue', 'network_revenue', 'ad_revenue', 'revenue']) {
    const v = parseNum(row[key]);
    if (v != null) { revenue += v; saw = true; }
  }
  return {
    level,
    campaignName: row.campaign_network,
    adsetName: row.adgroup_network || null,
    adName: row.creative_network || null,
    campaignId: dep.campaign_id_network || null,
    adsetId: dep.adgroup_id_network || null,
    adId: dep.creative_id_network || null,
    network: row.channel,
    revenue: saw ? revenue : null,
    currency: row.currency || row.app_currency || null,
  };
}

function toRow(row, level) {
  const cost = parseNum(row.cost);
  const cohortAllRevenue = parseNum(row.cohort_all_revenue);
  const allTime = cost != null && cost > 0 ? cohortAllRevenue / cost : null;
  // attr_dependency carries Meta's network IDs:
  //   campaign_id_network → Meta campaign_id (matches ?selected_campaign_ids URL)
  //   adgroup_id_network  → Meta adset_id
  //   creative_id_network → Meta ad_id (Meta's API names this `adgroup_id`)
  // The content script keys lookups by these IDs to resolve same-named ads
  // across campaigns without depending on name normalization.
  const dep = row.attr_dependency || {};
  return {
    level,
    campaignName: row.campaign_network,
    adsetName: row.adgroup_network || null,
    adName: row.creative_network || null,
    campaignId: dep.campaign_id_network || null,
    adsetId: dep.adgroup_id_network || null,
    adId: dep.creative_id_network || null,
    network: row.channel,
    cost,
    cohortAllRevenue,
    installs: parseNum(row.installs),
    roas: {
      d0: parseNum(row.roas_d0),
      d3: parseNum(row.roas_d3),
      d7: parseNum(row.roas_d7),
      allTime,
    },
  };
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Adjust does not have a built-in "last N days rolling" keyword (last_7_days,
// last_30_days etc. all 400). We compute it client-side as an inclusive ISO
// range ending yesterday, which mirrors what Datascape's "Last N Days" presets
// produce in the UI.
const ROLLING_DAYS = {
  rolling3: 3,
  rolling7: 7,
  rolling30: 30,
};

function expandDatePeriod(spec) {
  const days = ROLLING_DAYS[spec || 'rolling30'];
  if (days) {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 1); // yesterday
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (days - 1)); // N days inclusive
    return `${isoDate(start)}:${isoDate(end)}`;
  }
  return spec;
}

function isoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
