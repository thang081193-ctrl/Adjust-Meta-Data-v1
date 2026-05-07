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

// Adjust channel ids for Meta. Verified from the dashboard URL's
// channel_id__in param (partner_34 = Facebook).
const META_CHANNEL_ID = 'partner_34';

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
}) {
  const resolvedPeriod = expandDatePeriod(datePeriod);

  const [campaignRows, adRows] = await Promise.all([
    fetchAtLevel({
      apiToken, utcOffset, datePeriod: resolvedPeriod,
      dimensions: 'channel,campaign_network',
    }),
    fetchAtLevel({
      apiToken, utcOffset, datePeriod: resolvedPeriod,
      dimensions: 'channel,campaign_network,adgroup_network,creative_network',
    }),
  ]);

  const out = [];
  for (const row of campaignRows) out.push(toRow(row, 'campaign'));
  for (const row of adRows) out.push(toRow(row, 'ad'));
  return out;
}

async function fetchAtLevel({ apiToken, utcOffset, datePeriod, dimensions }) {
  const params = new URLSearchParams({
    format_dates: 'false',
    full_data: 'true',
    readable_names: 'false',
    ad_spend_mode: 'network',
    attribution_source: 'first',
    attribution_type: 'all',
    channel_id__in: META_CHANNEL_ID,
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
  return json.rows || [];
}

function toRow(row, level) {
  const cost = parseNum(row.cost);
  const cohortAllRevenue = parseNum(row.cohort_all_revenue);
  const allTime = cost != null && cost > 0 ? cohortAllRevenue / cost : null;
  // campaign_id_network is Meta's actual campaign id and shows up in the
  // ?selected_campaign_ids=... URL param when the user drills into a campaign.
  // We use it to break ad-name ties (same ad name across multiple campaigns).
  const dep = row.attr_dependency || {};
  return {
    level,
    campaignName: row.campaign_network,
    adsetName: row.adgroup_network || null,
    adName: row.creative_network || null,
    campaignId: dep.campaign_id_network || null,
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
