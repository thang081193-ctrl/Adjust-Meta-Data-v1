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

// ---- Concurrency gate + retry (v0.9.5) ----
// The D-2 pill (v0.9.4) doubled a sync's parallel report calls from 6 to 12
// (cohort ×3 + today ×3 + D-2 cohort ×3 + D-2 event-date ×3; +3 more with the
// Yesterday pill on). Under that burst Adjust's report generator started
// replying HTTP 500 {"error_desc":"Internal Service Error: TimeoutError"} —
// their backend timing out building 12 concurrent limit=10000 reports, not a
// client bug. Two layers of defense (see
// docs/findings/adjust_500_concurrency_retry.md):
//   1. At most MAX_CONCURRENT report requests in flight PER ADJUST ACCOUNT
//      (API token); the rest queue. The overload this cap guards against is
//      per-account — it is that account's report generator that chokes — so
//      with multi-account (v0.10) the gate is keyed by token. A single global
//      gate made "Cả 2 (gộp)" queue both accounts through 3 shared slots,
//      roughly doubling sync wall-clock while protecting nothing.
//   2. Transient failures (429/5xx, network drop) retry with backoff.
// Client-side 60s aborts are NOT retried: each attempt already held the
// popup's Force-refresh spinner for the full FETCH_TIMEOUT_MS.
const MAX_CONCURRENT = 3;
const RETRY_ATTEMPTS = 3;          // total tries per request
const RETRY_BASE_DELAY_MS = 1000;  // 1s, then 3s (×3 per retry) + jitter
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// token → { inFlight, queue }. One entry per distinct API token seen this
// service-worker lifetime (2-3 in practice), never pruned — the gate must
// outlive individual syncs.
const gates = new Map();

function gateFor(token) {
  let g = gates.get(token);
  if (!g) { g = { inFlight: 0, queue: [] }; gates.set(token, g); }
  return g;
}

async function acquireSlot(token) {
  const g = gateFor(token);
  if (g.inFlight < MAX_CONCURRENT) { g.inFlight++; return; }
  // releaseSlot hands the slot to us directly (no inFlight-- / ++ pair), so
  // a late acquireSlot can never sneak past a queued waiter and exceed the cap.
  await new Promise((resolve) => g.queue.push(resolve));
}

function releaseSlot(token) {
  const g = gateFor(token);
  const next = g.queue.shift();
  if (next) next();
  else g.inFlight--;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backoff(attempt, label, msg) {
  const delayMs = RETRY_BASE_DELAY_MS * Math.pow(3, attempt - 1) + Math.random() * 400;
  console.warn(
    `[Adjust Overlay] ${label}: transient failure (attempt ${attempt}/${RETRY_ATTEMPTS}), ` +
      `retrying in ${Math.round(delayMs)}ms — ${msg}`
  );
  await sleep(delayMs);
}

// One Adjust report request → parsed rows. Owns the concurrency slot, the
// retry loop, and error formatting. `label` prefixes error messages so the
// popup/banner shows which pipeline failed (e.g. "Adjust API" for cohort,
// "Adjust today fetch" for event-date).
//
// credentials: 'omit' forbids the browser from attaching any adjust.com
// cookies. Without this, a stale session cookie in the profile (e.g. from
// a previous Adjust login) gets sent alongside our Bearer token, and Adjust
// rejects the request with "It is impossible to check account ownership!"
// because the cookie identifies user A while the token identifies user B.
async function fetchAdjustRows(url, apiToken, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    let res;
    await acquireSlot(apiToken);
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      releaseSlot(apiToken);
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`${label} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      }
      lastErr = new Error(`${label} network error: ${err.message}`);
      if (attempt < RETRY_ATTEMPTS) { await backoff(attempt, label, err.message); continue; }
      throw lastErr;
    }
    try {
      if (res.ok) {
        const json = await res.json();
        return json?.rows || [];
      }
      const body = await res.text().catch(() => '');
      let msg =
        `${label} failed: ${res.status} ${res.statusText}` +
        (body ? ` — ${body.slice(0, 200)}` : '');
      // "It is impossible to check account ownership!" is Adjust's identity-
      // mismatch error. Cookies are already omitted (credentials: 'omit'
      // above), so with multi-account configs the remaining cause is a card
      // pairing an API token with app_token__in values minted by a DIFFERENT
      // account — the token cannot prove ownership of those apps. Decode it
      // here, in the popup's language, because the raw JSON body gives the
      // user nothing to act on.
      if (res.status === 401 && /account ownership/i.test(body)) {
        msg +=
          '\n→ Token và App tokens không cùng một Adjust account. Mỗi card trong ' +
          'popup phải dùng app tokens CỦA CHÍNH account đó — app token của account ' +
          'kia sẽ bị Adjust từ chối đúng kiểu này.';
      }
      lastErr = new Error(msg);
    } finally {
      // Slot released before the backoff sleep so queued requests aren't
      // starved while this one waits out its retry delay.
      releaseSlot(apiToken);
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_ATTEMPTS) {
      await backoff(attempt, label, lastErr.message);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
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
  'partner_254',   // Google Ads. VERIFIED 2026-09-01 via the reports-service
                   // filters_data endpoint (channel-probe step C): the account
                   // maps {"id":"partner_254","name":"Google Ads"}. The first
                   // guess (partner_7, Adjust's classic AdWords id) returned
                   // zero rows for this account — if Google rows ever go
                   // missing again, re-run channel-probe before suspecting
                   // client code.
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

// Metric sets for the cohort/report endpoint.
//
// COHORT_METRICS is what the main ROAS pipeline needs. The roas_dN columns are
// COHORT metrics: Adjust has to walk each install cohort forward N days to
// build them, which is what makes those reports slow (30s+ over 11 app tokens).
//
// SPEND_METRICS is the D-2 pill's denominator and nothing else. Before v0.10 the
// D-2 pipeline reused the full cohort request just to read `cost` out of it,
// paying for three roas_dN cohort walks per level it then threw away — that made
// D-2 the heaviest of the four pipelines and the first to hit Adjust's
// server-side report timeout (HTTP 500 / client 60s abort), which took the whole
// D-2 pill down with it. `cost` and `installs` are base (non-cohort) metrics, so
// this report builds in a fraction of the time.
// See docs/findings/adjust_d2_pipeline.md.
const COHORT_METRICS = 'cost,roas_d0,roas_d3,roas_d7,cohort_all_revenue,installs';
const SPEND_METRICS = 'cost,installs';

async function fetchAtLevel({
  apiToken, utcOffset, datePeriod, dimensions, appTokens,
  metrics = COHORT_METRICS,
  label = 'Adjust API',
}) {
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
    metrics,
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

  return fetchAdjustRows(`${ADJUST_BASE}?${params}`, apiToken, label);
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

// Realtime "Yesterday" (D-1) revenue AND spend, both from Adjust. Same engine
// as the D-2 fetch below (fetchDayRevenueAndSpend).
//
// HISTORY: until v0.12 this returned event-date REVENUE only, and the pill
// divided it by spend scraped from the ads-manager UI while the user parked
// the date picker on "Yesterday" (the "cần view Yesterday" prompt). The D-2
// pill then proved Adjust's ad_spend_mode=network `cost` is a sound
// denominator for a CLOSED day — and yesterday is just as closed as D-2 — so
// the scrape became pure friction: on Google Ads there isn't even a guaranteed
// Cost column to scrape. Both sides now come from Adjust; the injectors keep
// the UI-capture path only as a fallback for rows whose Adjust spend half
// failed.
//
// @returns {Promise<{rows, warnings, revOk, costOk}>} — rows carry
//   revenueYesterday + costYesterday; a null half follows the D-2 contract
//   (null = "no answer", never a fabricated 0).
export async function fetchYesterdayGrossRevenue({ apiToken, utcOffset = '+07:00', appTokens }) {
  const res = await fetchDayRevenueAndSpend({
    apiToken, utcOffset, appTokens, datePeriod: 'yesterday', dayLabel: 'Yesterday',
  });
  for (const r of res.rows) {
    r.revenueYesterday = r.dayRevenue;
    r.costYesterday = r.dayCost;
  }
  return res;
}

// Realtime "D-2" (two days ago) revenue AND spend. Powers the optional D-2
// pill. Both sides of the ratio come from Adjust, which removes the
// currency-mismatch and timezone-window guards the UI-spend pills need.
//
// Adjust has no 'two_days_ago' keyword — we pass an explicit single-day range
// computed on the reporting offset, matching the calendar the 'yesterday'
// keyword uses.
//
// @returns {Promise<{rows, warnings, date, revOk, costOk}>}
export async function fetchD2GrossRevenue({ apiToken, utcOffset = '+07:00', appTokens }) {
  const iso = isoDateDaysAgoAtOffset(2, utcOffset);
  const res = await fetchDayRevenueAndSpend({
    apiToken, utcOffset, appTokens, datePeriod: `${iso}:${iso}`, dayLabel: `D-2 (${iso})`,
  });
  for (const r of res.rows) {
    r.revenueD2 = r.dayRevenue;
    r.costD2 = r.dayCost;
  }
  return { ...res, date: iso };
}

// Shared engine for the closed-day pills (Yesterday, D-2): event-date revenue
// + network spend for one date_period, fetched in parallel and joined per row.
//
// Two endpoints, because they carry different metrics:
//   • Revenue: the EVENT-DATE report (same as the today fetch). That endpoint
//     is finicky about metrics — `cost`, `currency`, `all_revenue`,
//     `network_revenue` all return HTTP 400 "Unsupported metric" (verified
//     2026-05-11), so we must NOT ask it for cost.
//   • Spend: the cohort/report endpoint asked for SPEND_METRICS only. `cost`
//     (ad_spend_mode=network) is a base metric there and accepts both the
//     'yesterday' keyword and explicit ISO ranges. Spend in a closed day's
//     window is independent of cohort maturity — the correct denominator.
//
// FAILURE POLICY (v0.10, formerly D-2-only — see
// docs/findings/adjust_d2_pipeline.md): both sides are INDEPENDENTLY
// best-effort. A half-failure still returns rows — one side populated, the
// other null — plus a warning naming the failed side. Only when BOTH sides
// fail does this throw. allSettled (not a floating promise + sequential
// await) so a spend-side rejection can never fire as an `unhandledrejection`
// in the service worker while we're still awaiting the revenue side.
async function fetchDayRevenueAndSpend({ apiToken, utcOffset, appTokens, datePeriod, dayLabel }) {
  const [costRes, revRes] = await Promise.allSettled([
    fetchDaySpend({ apiToken, utcOffset, appTokens, datePeriod, dayLabel }),
    fetchGrossRevenue({ apiToken, utcOffset, appTokens, datePeriod }),
  ]);
  const costOk = costRes.status === 'fulfilled';
  const revOk = revRes.status === 'fulfilled';

  if (!costOk && !revOk) {
    throw new Error(
      `${dayLabel} both sides failed — spend: ${costRes.reason?.message}; ` +
        `revenue: ${revRes.reason?.message}`
    );
  }

  const warnings = [];
  if (!costOk) {
    console.warn(`[Adjust Overlay] ${dayLabel} spend fetch failed:`, costRes.reason?.message);
    warnings.push(`${dayLabel} spend: ${costRes.reason?.message}`);
  }
  if (!revOk) {
    console.warn(`[Adjust Overlay] ${dayLabel} event-date revenue failed:`, revRes.reason?.message);
    warnings.push(`${dayLabel} revenue: ${revRes.reason?.message}`);
  }

  const rows = joinDayRevenueSpend(
    revOk ? revRes.value : [],
    costOk ? costRes.value : [],
    { revOk, costOk }
  );
  return { rows, warnings, revOk, costOk };
}

// Spend only. Same three grouping levels as the cohort pipeline so the join
// below has a counterpart row at every level the pills decorate, but asking
// for SPEND_METRICS instead of the full cohort metric set — see the constant's
// comment for why that matters.
async function fetchDaySpend({ apiToken, utcOffset, appTokens, datePeriod, dayLabel }) {
  const label = `Adjust ${dayLabel} spend fetch`;
  const [campaignRows, adsetRows, adRows] = await Promise.all([
    fetchAtLevel({
      apiToken, utcOffset, datePeriod, appTokens, metrics: SPEND_METRICS, label,
      dimensions: 'channel,campaign_network',
    }),
    fetchAtLevel({
      apiToken, utcOffset, datePeriod, appTokens, metrics: SPEND_METRICS, label,
      dimensions: 'channel,campaign_network,adgroup_network',
    }),
    fetchAtLevel({
      apiToken, utcOffset, datePeriod, appTokens, metrics: SPEND_METRICS, label,
      dimensions: 'channel,campaign_network,adgroup_network,creative_network',
    }),
  ]);
  const out = [];
  for (const row of campaignRows) out.push(toRow(row, 'campaign'));
  for (const row of adsetRows) out.push(toRow(row, 'adset'));
  for (const row of adRows) out.push(toRow(row, 'ad'));
  return out;
}

// Join one day's event-date revenue rows with its spend rows into one row set
// carrying dayRevenue + dayCost (the exported wrappers rename these onto the
// day-specific fields). Both sides come from the same account + date range +
// dimensions, so the full identity tuple matches exactly for the same entity —
// no canonicalization needed here.
//
// The `revOk` / `costOk` flags keep "we asked and the answer was zero"
// distinct from "we never got an answer". A spend row with no revenue
// counterpart means 0 revenue ONLY when the revenue fetch actually succeeded;
// if that side failed the field stays null so the pill renders a dash instead
// of a fabricated red 0%. Same rule mirrored for the spend side.
function joinDayRevenueSpend(revRows, costRows, { revOk = true, costOk = true } = {}) {
  const revMiss = revOk ? 0 : null;
  // Primary index: full identity tuple. Secondary: level + strongest id — a
  // safety net for the occasional row where the two endpoints disagree on a
  // name (whitespace) or one side carries a creative_id_network the other nulls.
  const costByTuple = new Map();
  const costById = new Map();
  for (const c of costRows) {
    costByTuple.set(dayTupleKey(c), c);
    const idk = dayIdKey(c);
    if (idk) costById.set(idk, c);
  }

  const usedCost = new Set();
  const matchCost = (r) => {
    let c = costByTuple.get(dayTupleKey(r));
    if (!c) { const idk = dayIdKey(r); c = idk ? costById.get(idk) : null; }
    return c || null;
  };

  const out = [];
  for (const r of revRows) {
    const c = matchCost(r);
    if (c) usedCost.add(c);
    // No spend counterpart → null, never 0: a 0 denominator would render as a
    // real "spent nothing" reading, and we cannot tell that apart from Adjust
    // simply not returning a spend row for this entity.
    out.push({ ...r, dayRevenue: r.revenue, dayCost: c ? c.cost : null });
  }
  for (const c of costRows) {
    if (usedCost.has(c)) continue;
    out.push({
      level: c.level,
      campaignName: c.campaignName,
      adsetName: c.adsetName,
      adName: c.adName,
      campaignId: c.campaignId,
      adsetId: c.adsetId,
      adId: c.adId,
      network: c.network,
      currency: null,
      dayRevenue: revMiss,
      dayCost: c.cost,
    });
  }
  return out;
}

function dayTupleKey(r) {
  return [
    r.level,
    r.campaignId || '', r.adsetId || '', r.adId || '',
    r.campaignName || '', r.adsetName || '', r.adName || '',
  ].join('::');
}

function dayIdKey(r) {
  const id = r.level === 'ad' ? r.adId : r.level === 'adset' ? r.adsetId : r.campaignId;
  return id ? `${r.level}::${id}` : null;
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

  return fetchAdjustRows(`${ADJUST_BASE}?${params}`, apiToken, `Adjust ${datePeriod} fetch`);
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

// Calendar date `daysAgo` days back on the given reporting offset (±HH:MM).
// Shifting the epoch by the offset then reading UTC components yields the
// wall-clock date in that zone — the same day arithmetic Adjust applies to its
// own 'yesterday' keyword. Unparseable offsets fall back to +07:00 (BKT),
// matching the default everywhere else in this client.
function isoDateDaysAgoAtOffset(daysAgo, utcOffset) {
  const m = String(utcOffset || '').trim().match(/^([+-])(\d{1,2}):?(\d{2})?$/);
  const offMin = m
    ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0))
    : 420;
  return isoDate(new Date(Date.now() + offMin * 60000 - daysAgo * 86400000));
}
