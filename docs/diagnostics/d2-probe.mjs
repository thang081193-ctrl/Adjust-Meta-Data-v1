#!/usr/bin/env node
// docs/diagnostics/d2-probe.mjs
//
// Probes the exact Adjust report calls the D-2 pill makes, one at a time, and
// prints status + row counts + sample values for each. Use it when the D-2 pill
// shows "chưa có dữ liệu" to find out WHICH half is failing and why, without
// guessing from inside the extension.
//
// It also runs the one comparison that cannot be made from the extension: the
// lightweight `metrics=cost,installs` spend report (what v0.10 sends) against
// the old full `cost,roas_d0,roas_d3,roas_d7,cohort_all_revenue,installs`
// report, for the same day — confirming the cheaper request returns the same
// cost, and how much faster it is.
//
// The token never leaves your machine: it is read from the environment and used
// only as the Authorization header on requests to automate.adjust.com.
//
// USAGE (PowerShell)
//   $env:ADJUST_TOKEN = "<token from Adjust → Account Settings → My profile>"
//   $env:ADJUST_APP_TOKENS = "b6yjkg1hc7wg,ox6zszk8msjk"   # optional
//   $env:ADJUST_UTC_OFFSET = "+07:00"                      # optional
//   node docs/diagnostics/d2-probe.mjs
//
// USAGE (bash)
//   ADJUST_TOKEN=... ADJUST_APP_TOKENS=... node docs/diagnostics/d2-probe.mjs
//
// Run it once per Adjust account — each token sees only its own account's apps.

const ADJUST_BASE = 'https://automate.adjust.com/reports-service/report';
// Args win over env so one copy-paste command works in any shell:
//   node docs/diagnostics/d2-probe.mjs <api_token> [app_tokens] [utc_offset]
const TOKEN = process.argv[2] || process.env.ADJUST_TOKEN;
const APP_TOKENS = process.argv[3] || process.env.ADJUST_APP_TOKENS || '';
const UTC_OFFSET = process.argv[4] || process.env.ADJUST_UTC_OFFSET || '+07:00';
const TIMEOUT_MS = 90_000;

const NETWORK_CHANNEL_IDS = ['partner_34', 'partner_1678', '2337'];
const COHORT_METRICS = 'cost,roas_d0,roas_d3,roas_d7,cohort_all_revenue,installs';
const SPEND_METRICS = 'cost,installs';
const EVENT_METRICS = 'revenue,ad_revenue';

if (!TOKEN) {
  console.error('No token. Pass it as the first argument:');
  console.error('  node docs/diagnostics/d2-probe.mjs <api_token> [app_tokens] [utc_offset]');
  process.exit(2);
}

// A real Adjust token is plain ASCII. Catching the un-replaced placeholder
// ("DÁN_TOKEN...") here beats fetch()'s cryptic "cannot convert to
// ByteString" TypeError when the Vietnamese diacritics hit the header.
if (!/^[!-~]+$/.test(TOKEN)) {
  console.error('First argument is not a real Adjust API token (contains non-ASCII characters).');
  console.error('Thay chỗ placeholder bằng token thật: Adjust dashboard → avatar → Account settings → My profile → API token.');
  process.exit(2);
}

// Same day arithmetic as src/adjust-client.js isoDateDaysAgoAtOffset().
function isoDaysAgo(daysAgo) {
  const m = UTC_OFFSET.trim().match(/^([+-])(\d{1,2}):?(\d{2})?$/);
  const offMin = m
    ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0))
    : 420;
  const d = new Date(Date.now() + offMin * 60000 - daysAgo * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function buildUrl({ metrics, datePeriod, dimensions, cohort }) {
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
    metrics,
    reattributed: 'all',
    sandbox: 'false',
    sdk_signature_enforcement_status: 'all',
    utc_offset: UTC_OFFSET,
  });
  if (cohort) params.set('cohort_maturity', 'immature');
  if (APP_TOKENS.trim()) params.set('app_token__in', APP_TOKENS.trim());
  return `${ADJUST_BASE}?${params}`;
}

async function probe(name, spec) {
  const url = buildUrl(spec);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.log(`\n✗ ${name}`);
    console.log(`   ${err.name}: ${err.message}  (${Date.now() - t0}ms)`);
    return null;
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.log(`\n✗ ${name}`);
    console.log(`   HTTP ${res.status} ${res.statusText}  (${ms}ms)`);
    console.log(`   ${body.slice(0, 300)}`);
    return null;
  }
  const json = await res.json();
  const rows = json?.rows || [];
  console.log(`\n✓ ${name}`);
  console.log(`   HTTP 200 · ${rows.length} rows · ${ms}ms`);
  if (json?.warnings?.length) console.log(`   warnings: ${JSON.stringify(json.warnings).slice(0, 200)}`);
  if (rows.length) {
    const keys = Object.keys(rows[0]).filter((k) => k !== 'attr_dependency');
    console.log(`   fields: ${keys.join(', ')}`);
    console.log(`   sample: ${JSON.stringify(rows[0]).slice(0, 260)}`);
  } else {
    console.log('   (empty rows — the request was accepted but returned no data)');
  }
  return rows;
}

function sumField(rows, field) {
  if (!rows) return null;
  let total = 0;
  for (const r of rows) {
    const v = parseFloat(r[field]);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

const d2 = isoDaysAgo(2);
const range = `${d2}:${d2}`;
const DIMS = 'channel,campaign_network';

console.log('Adjust D-2 pill probe');
console.log(`  utc_offset   : ${UTC_OFFSET}`);
console.log(`  D-2 date     : ${d2}  (date_period=${range})`);
console.log(`  app_token__in: ${APP_TOKENS.trim() || '(none — Adjust default tracker filter)'}`);
console.log(`  dimensions   : ${DIMS} (campaign level only; the extension also runs adset + ad)`);

// 1. What the D-2 pill's SPEND half sends as of v0.10.
const spendRows = await probe('D-2 spend — metrics=cost,installs (v0.10 lightweight)', {
  metrics: SPEND_METRICS, datePeriod: range, dimensions: DIMS, cohort: true,
});

// 2. What it used to send: the full cohort report, just to read `cost` out.
const heavyRows = await probe('D-2 spend — full cohort metric set (pre-v0.10, for comparison)', {
  metrics: COHORT_METRICS, datePeriod: range, dimensions: DIMS, cohort: true,
});

// 3. The D-2 pill's REVENUE half: event-date report over an explicit ISO range.
const revRows = await probe('D-2 revenue — metrics=revenue,ad_revenue, explicit ISO range', {
  metrics: EVENT_METRICS, datePeriod: range, dimensions: DIMS,
});

// 4. Control: the same event-date report with the keyword that is known to work.
await probe('CONTROL: event-date revenue with date_period=yesterday (known-good shape)', {
  metrics: EVENT_METRICS, datePeriod: 'yesterday', dimensions: DIMS,
});

console.log('\n--- verdict ---');
const lightCost = sumField(spendRows, 'cost');
const heavyCost = sumField(heavyRows, 'cost');
if (lightCost != null && heavyCost != null) {
  const same = Math.abs(lightCost - heavyCost) < 0.005;
  console.log(
    `spend metric set: light=${lightCost?.toFixed(2)} heavy=${heavyCost?.toFixed(2)} → ` +
      (same ? 'IDENTICAL, lightweight request is safe' : 'MISMATCH — investigate before trusting D-2 spend')
  );
} else {
  console.log('spend metric set: could not compare (one side failed above)');
}
const revTotal = sumField(revRows, 'ad_revenue');
if (revRows == null) {
  console.log('D-2 revenue: FAILED — the event-date endpoint rejected the explicit ISO range.');
  console.log('  → the pill will show "D-2: –/<spend>" and a "Thiếu revenue" note. If the');
  console.log('    CONTROL above succeeded, the range form is the problem, not the metrics.');
} else if (!revRows.length) {
  console.log(`D-2 revenue: accepted but EMPTY for ${d2} — no event-date revenue that day.`);
} else {
  console.log(`D-2 revenue: OK — ad_revenue total ${revTotal?.toFixed(2)} across ${revRows.length} campaigns.`);
}
if (spendRows && !spendRows.length) {
  console.log(`D-2 spend: accepted but EMPTY for ${d2} — Adjust reports no network spend that day.`);
}
