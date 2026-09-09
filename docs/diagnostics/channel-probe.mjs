#!/usr/bin/env node
// docs/diagnostics/channel-probe.mjs
//
// Verifies the extension's Adjust channel filter — specifically whether the
// Google Ads channel id we assumed ('partner_7') is correct for this account.
//
// Two report calls over the last 7 days, dimensions=channel only:
//   A. WITHOUT channel_id__in  → every channel the token can see, with spend.
//   B. WITH the extension's NETWORK_CHANNEL_IDS (Facebook, TikTok ×2, Google)
//      → what actually gets through the extension's filter.
// If "Google Ads" shows up in A but not in B, the Google channel id is wrong:
// step C lists the account's real id↔name mapping (partner_254 = Google Ads,
// verified 2026-09-01); put the right id into NETWORK_CHANNEL_IDS
// (src/adjust-client.js).
//
// USAGE (any shell; args win over env):
//   node docs/diagnostics/channel-probe.mjs <api_token> [app_tokens] [utc_offset]
//
// Run once per Adjust account. The token only ever goes to automate.adjust.com.

const ADJUST_BASE = 'https://automate.adjust.com/reports-service/report';
const TOKEN = process.argv[2] || process.env.ADJUST_TOKEN;
const APP_TOKENS = process.argv[3] || process.env.ADJUST_APP_TOKENS || '';
const UTC_OFFSET = process.argv[4] || process.env.ADJUST_UTC_OFFSET || '+07:00';
const TIMEOUT_MS = 90_000;

// Keep in sync with NETWORK_CHANNEL_IDS in src/adjust-client.js.
const EXTENSION_CHANNEL_IDS = ['partner_34', 'partner_1678', '2337', 'partner_254'];

if (!TOKEN) {
  console.error('No token. Pass it as the first argument:');
  console.error('  node docs/diagnostics/channel-probe.mjs <api_token> [app_tokens] [utc_offset]');
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

function isoDaysAgo(daysAgo) {
  const m = UTC_OFFSET.trim().match(/^([+-])(\d{1,2}):?(\d{2})?$/);
  const offMin = m
    ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0))
    : 420;
  const d = new Date(Date.now() + offMin * 60000 - daysAgo * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const range = `${isoDaysAgo(7)}:${isoDaysAgo(1)}`;

function buildUrl(channelIds) {
  const params = new URLSearchParams({
    format_dates: 'false',
    full_data: 'true',
    readable_names: 'false',
    ad_spend_mode: 'network',
    attribution_source: 'first',
    attribution_type: 'all',
    date_period: range,
    dimensions: 'channel',
    fingerprint_status: 'all',
    include_attr_dependency: 'true',
    digital_turbine_mode: 'digital_turbine',
    ironsource_mode: 'ironsource',
    limit: '1000',
    metrics: 'cost,installs',
    reattributed: 'all',
    sandbox: 'false',
    sdk_signature_enforcement_status: 'all',
    utc_offset: UTC_OFFSET,
  });
  if (channelIds) params.set('channel_id__in', channelIds.join(','));
  if (APP_TOKENS.trim()) params.set('app_token__in', APP_TOKENS.trim());
  return `${ADJUST_BASE}?${params}`;
}

async function fetchChannels(label, channelIds) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(buildUrl(channelIds), {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.log(`\n✗ ${label}: ${err.name}: ${err.message} (${Date.now() - t0}ms)`);
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.log(`\n✗ ${label}: HTTP ${res.status} (${Date.now() - t0}ms)\n   ${body.slice(0, 300)}`);
    return null;
  }
  const json = await res.json();
  const rows = json?.rows || [];
  console.log(`\n✓ ${label} — ${rows.length} channel(s), ${Date.now() - t0}ms`);
  for (const r of rows) {
    const cost = parseFloat(r.cost);
    const installs = parseFloat(r.installs);
    console.log(
      `   ${String(r.channel ?? '(null)').padEnd(28)} cost=${Number.isFinite(cost) ? cost.toFixed(2) : '–'}` +
      `  installs=${Number.isFinite(installs) ? installs : '–'}`
    );
  }
  return rows.map((r) => r.channel).filter(Boolean);
}

// C. Ask the reports service for its channel filter METADATA - the same
// id<->name mapping the Datascape filter UI is built from. This is what turns
// "partner_7 is wrong" into "the real id is X" without a dashboard visit.
// Documented Reporting v2 filters_data shape:
//   [{ id: 'channels', list: [{ id: 'partner_34', name: 'Facebook', ... }] }]
async function discoverChannelIds() {
  const url = 'https://automate.adjust.com/reports-service/filters_data?' +
    new URLSearchParams({ required_filters: 'channels' });
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.log(`\n? C. filters_data: ${err.name}: ${err.message}`);
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.log(`\n? C. filters_data: HTTP ${res.status} (${Date.now() - t0}ms) - ${body.slice(0, 200)}`);
    return null;
  }
  const json = await res.json().catch(() => null);
  // Observed live shape (2026-09-01): an object keyed by filter name —
  // { channels: [{ id: 'partner_254', name: 'Google Ads', ... }, ...] }.
  // Older docs describe [{ id: 'channels', list: [...] }]; accept both.
  let list = null;
  if (json && Array.isArray(json.channels)) {
    list = json.channels;
  } else {
    const groups = Array.isArray(json) ? json
      : (json && Array.isArray(json.filters) ? json.filters : null);
    const grp = groups
      ? groups.find((g) => g && (g.id === 'channels' || g.id === 'channel') && Array.isArray(g.list))
        || groups.find((g) => g && Array.isArray(g.list))
      : null;
    list = grp ? grp.list : null;
  }
  if (!list) {
    console.log(`\n? C. filters_data returned an unexpected shape - first 400 chars (send this back):`);
    console.log('   ' + JSON.stringify(json).slice(0, 400));
    return null;
  }
  console.log(`\nOK C. Channel id <-> name mapping - ${list.length} channel(s) known to this account:`);
  for (const c of list) {
    const mark = /google|adwords/i.test(`${c.name ?? ''} ${c.id ?? ''}`) ? '   <-- GOOGLE' : '';
    console.log(`   id=${String(c.id).padEnd(18)} name=${c.name}${mark}`);
  }
  return list.filter((c) => /google|adwords/i.test(`${c.name ?? ''} ${c.id ?? ''}`));
}

console.log('Adjust channel probe');
console.log(`  date_period : ${range} (last 7 closed days)`);
console.log(`  app_token__in: ${APP_TOKENS.trim() || '(none — Adjust default tracker filter)'}`);
console.log(`  extension ids: ${EXTENSION_CHANNEL_IDS.join(', ')}`);

const all = await fetchChannels('A. All channels (no channel filter)', null);
const filtered = await fetchChannels('B. Through the extension filter', EXTENSION_CHANNEL_IDS);
const googleIds = await discoverChannelIds();

console.log('\n--- verdict ---');
if (!all || !filtered) {
  console.log('One of the requests failed — fix that first (see above).');
} else {
  const googleInAll = all.some((c) => /google|adwords/i.test(c));
  const googleInFiltered = filtered.some((c) => /google|adwords/i.test(c));
  if (!googleInAll) {
    console.log('No Google Ads channel in this account\'s data at all (this week).');
    console.log('→ Either the app tokens exclude the Google-running apps, or Google spend is in the OTHER Adjust account — run the probe there.');
  } else if (googleInFiltered) {
    console.log('Google Ads passes the extension filter — the configured Google channel id is CORRECT. Nothing to change.');
  } else {
    console.log('Google Ads exists (A) but is BLOCKED by the filter (B) — the Google channel id in the filter is wrong for this account.');
    if (googleIds && googleIds.length) {
      console.log(`→ Step C found the real id(s): ${googleIds.map((c) => `${c.id} (${c.name})`).join(', ')}`);
      console.log('→ Put that id in src/adjust-client.js NETWORK_CHANNEL_IDS (replacing the wrong Google entry).');
    } else {
      console.log('→ Step C could not list ids — in Datascape, filter channel = Google Ads and copy the id from the URL channel_id__in=…');
    }
  }
  const lost = all.filter((c) => !filtered.includes(c));
  if (lost.length) console.log(`Channels visible in A but not in B: ${lost.join(', ')}`);
}
