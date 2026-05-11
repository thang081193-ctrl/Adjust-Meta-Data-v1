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

  const [campaignRows, adRows] = await Promise.all([
    fetchAtLevel({
      apiToken, utcOffset, datePeriod: resolvedPeriod, appTokens,
      dimensions: 'channel,campaign_network',
    }),
    fetchAtLevel({
      apiToken, utcOffset, datePeriod: resolvedPeriod, appTokens,
      dimensions: 'channel,campaign_network,adgroup_network,creative_network',
    }),
  ]);

  const out = [];
  for (const row of campaignRows) out.push(toRow(row, 'campaign'));
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
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
  });

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
  const [campaignRows, adRows] = await Promise.all([
    fetchTodayAtLevel({
      apiToken, utcOffset, appTokens,
      dimensions: 'channel,campaign_network',
    }),
    fetchTodayAtLevel({
      apiToken, utcOffset, appTokens,
      dimensions: 'channel,campaign_network,adgroup_network,creative_network',
    }),
  ]);
  const out = [];
  for (const row of campaignRows) out.push(toTodayRow(row, 'campaign'));
  for (const row of adRows) out.push(toTodayRow(row, 'ad'));
  return out;
}

async function fetchTodayAtLevel({ apiToken, utcOffset, dimensions, appTokens }) {
  const params = new URLSearchParams({
    format_dates: 'false',
    full_data: 'true',
    readable_names: 'false',
    ad_spend_mode: 'network',
    attribution_source: 'first',
    attribution_type: 'all',
    channel_id__in: NETWORK_CHANNEL_IDS.join(','),
    date_period: 'today',
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

  const res = await fetch(`${ADJUST_BASE}?${params}`, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Adjust today fetch failed: ${res.status} ${res.statusText}` +
        (body ? ` — ${body.slice(0, 200)}` : '')
    );
  }
  const json = await res.json();
  return json.rows || [];
}

function toTodayRow(row, level) {
  const dep = row.attr_dependency || {};
  // Tolerate any revenue-named field Adjust returns. `all_revenue` is the
  // intended event-date total; we also fall through to `network_revenue`
  // (IAA-only) and `revenue` (IAP-only) in case the account's data shape
  // differs. Sum when multiple are present so partial metric availability
  // never silently drops data.
  let revenueToday = 0;
  let saw = false;
  for (const key of ['all_revenue', 'network_revenue', 'ad_revenue', 'revenue']) {
    const v = parseNum(row[key]);
    if (v != null) { revenueToday += v; saw = true; }
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
    revenueToday: saw ? revenueToday : null,
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
