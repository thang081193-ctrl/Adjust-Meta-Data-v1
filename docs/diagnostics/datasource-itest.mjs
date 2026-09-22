#!/usr/bin/env node
// docs/diagnostics/datasource-itest.mjs
//
// Offline regression test for src/data-source.js. Stubs chrome.storage and
// fetch, then drives the REAL createDataSource() / fetchAll() path — no network,
// no token, no Chrome. Run from the repo root:
//
//     node docs/diagnostics/datasource-itest.mjs
//
// Covers the behaviours that are expensive to notice in production:
//   1. Multi-account fan-out, row tagging, and cross-account dedupe picking the
//      account that OWNS the app (installs) over one that only mirrors spend.
//   2. D-2 SPEND side down -> revenue still renders (this half-failure used to
//      take the whole D-2 pill down; see docs/findings/adjust_d2_pipeline.md).
//   3. D-2 REVENUE side down -> spend still renders.
//   4. One account entirely down -> the other account's rows still cache, with a
//      warning prefixed by the failing account's label.
//   5. Selecting a single account fetches only that account's token.
//   6. Pre-v0.10 single-token config migrates to accounts[0].
//   7. D-2 toggled off issues zero D-2 report calls.
//
// Read the printed lines, not an exit code — this is a diagnostic, not a CI gate.

const BASE = new URL('../../src/', import.meta.url).href;

let store = {};
globalThis.chrome = {
  storage: { local: {
    get: async (keys) => {
      const ks = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of ks) if (k in store) out[k] = store[k];
      return out;
    },
    set: async (obj) => { Object.assign(store, obj); },
  } },
};

const calls = [];
let failMode = null;
const inflightByToken = {};
const peakByToken = {};

function row({ camp = 'C1', campId = '111', adset = null, adsetId = null, ad = null, adId = null, extra = {} }) {
  const r = { channel: 'Facebook', campaign_network: camp, attr_dependency: { campaign_id_network: campId } };
  if (adset) { r.adgroup_network = adset; r.attr_dependency.adgroup_id_network = adsetId; }
  if (ad) { r.creative_network = ad; r.attr_dependency.creative_id_network = adId; }
  return { ...r, ...extra };
}

function classify(u) {
  const p = new URL(u).searchParams;
  const m = p.get('metrics');
  const dp = p.get('date_period');
  const dims = (p.get('dimensions') || '').split(',').length;
  if (m === 'cost,installs') return { kind: dp === 'yesterday' ? 'yspend' : 'd2spend', dims, dp };
  if (m && m.startsWith('cost,roas')) return { kind: 'cohort', dims, dp };
  if (dp === 'today') return { kind: 'today', dims, dp };
  if (dp === 'yesterday') return { kind: 'yesterday', dims, dp };
  return { kind: 'd2rev', dims, dp };
}

globalThis.fetch = async (u, opts) => {
  const token = (opts.headers.Authorization || '').replace('Bearer ', '');
  const c = classify(u);
  calls.push({ token, ...c });
  // Per-token concurrency telemetry: per-token gates must let the two accounts
  // overlap while never exceeding MAX_CONCURRENT within one token. The tiny
  // delay makes requests actually overlap so the recorded peak is meaningful.
  inflightByToken[token] = (inflightByToken[token] || 0) + 1;
  peakByToken[token] = Math.max(peakByToken[token] || 0, inflightByToken[token]);
  await new Promise((r) => setTimeout(r, 5));
  inflightByToken[token] -= 1;

  if (failMode === 'd2spend-all' && c.kind === 'd2spend') {
    return { ok: false, status: 500, statusText: 'Server Error', text: async () => '{"error_desc":"TimeoutError"}' };
  }
  if (failMode === 'd2rev-all' && c.kind === 'd2rev') {
    return { ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"error_desc":"Unsupported metric"}' };
  }
  if (failMode === 'acctB-down' && token === 'TOKEN_B') {
    return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad token' };
  }

  // Account A owns campaign "Shared" (installs+revenue); account B mirrors its
  // spend only. Each account also has one exclusive campaign.
  const own = token === 'TOKEN_A';
  const mk = (kind) => {
    if (kind === 'cohort') {
      return [
        row({ camp: 'Shared', campId: '111', extra: { cost: '100', installs: own ? '50' : '0', cohort_all_revenue: own ? '80' : '0', roas_d0: '0.2', roas_d7: '0.8' } }),
        row({ camp: own ? 'OnlyA' : 'OnlyB', campId: own ? '222' : '333', extra: { cost: '10', installs: '5', cohort_all_revenue: '9', roas_d0: '0.3', roas_d7: '0.9' } }),
      ];
    }
    if (kind === 'd2spend' || kind === 'yspend') {
      return [row({ camp: 'Shared', campId: '111', extra: { cost: '40', installs: own ? '20' : '0' } })];
    }
    // event-date revenue
    return [row({ camp: 'Shared', campId: '111', extra: { ad_revenue: own ? '30' : '0', revenue: '0', currency: 'USD' } })];
  };
  const rows = c.dims === 2 ? mk(c.kind) : []; // only campaign level for brevity
  return { ok: true, json: async () => ({ rows }) };
};

const { createDataSource } = await import(BASE + 'data-source.js');

store = {
  dataSourceConfig: {
    kind: 'adjust-direct',
    utcOffset: '+07:00',
    datePeriod: 'rolling30',
    accounts: [
      { id: 'a', label: 'Adjust cu', apiToken: 'TOKEN_A', appTokens: 'app1,app2' },
      { id: 'b', label: 'Adjust moi', apiToken: 'TOKEN_B', appTokens: 'app3' },
    ],
    activeAccountId: 'all',
  },
  pillVisibility: { meta: { cohort: true, today: true, yesterday: true, d2: true } },
};

function reset() { calls.length = 0; }
const find = (rows, name) => rows.find((r) => r.level === 'campaign' && r.campaignName === name);

// ---- 1. Happy path, both accounts, D-2 on -------------------------------
reset(); failMode = null;
let src = await createDataSource();
let res = await src.fetchAll();
const tokensUsed = [...new Set(calls.map((c) => c.token))].sort();
console.log('1) tokens used:', tokensUsed.join(','), '| calls:', calls.length);
console.log('   gate peak per token:',
  Object.entries(peakByToken).map(([t, p]) => `${t}=${p}`).join(' '),
  '(cap 3/token; both >1 = accounts truly overlap)');
console.log('   d2spend metric used:', calls.some((c) => c.kind === 'd2spend'));
console.log('   warnings:', res.warnings.length, '| accountsStatus:',
  res.accountsStatus.map((a) => `${a.label}:${a.ok ? 'ok' : 'FAIL'}/${a.rows}`).join(' '));
const shared = find(res.campaigns, 'Shared');
// v0.12.2: the mirror row is MERGED in, not dropped — label names both
// accounts, installs/revenue are summed (mirror adds 0), spend is max (100,
// NOT 200), and the D-1/D-2 spend halves are max too (40, not 80).
console.log('   Shared -> account:', shared.accountLabel, '| installs:', shared.installs,
  '| cost:', shared.cost, '(100 not 200) | revenueD2:', shared.revenueD2, '| costD2:', shared.costD2,
  '(40 not 80) | revYest:', shared.revenueYesterday, '| costYest:', shared.costYesterday,
  '| mergeStats:', JSON.stringify(src.lastMergeStats));
console.log('   OnlyA present:', !!find(res.campaigns, 'OnlyA'), '| OnlyB present:', !!find(res.campaigns, 'OnlyB'));
console.log('   sourceLabel:', src.describe());

// ---- 2. D-2 SPEND side down (the old whole-pipeline killer) -------------
reset(); failMode = 'd2spend-all';
src = await createDataSource();
res = await src.fetchAll();
const s2 = find(res.campaigns, 'Shared');
console.log('2) d2 spend down -> revenueD2:', s2.revenueD2, '| costD2:', s2.costD2,
  '| warnings:', res.warnings.filter((w) => /D-2/.test(w)).length);

// ---- 3. D-2 REVENUE side down ------------------------------------------
reset(); failMode = 'd2rev-all';
src = await createDataSource();
res = await src.fetchAll();
const s3 = find(res.campaigns, 'Shared');
console.log('3) d2 revenue down -> revenueD2:', s3.revenueD2, '| costD2:', s3.costD2,
  '| warnings:', res.warnings.filter((w) => /D-2/.test(w)).length);

// ---- 4. One account entirely down --------------------------------------
reset(); failMode = 'acctB-down';
src = await createDataSource();
res = await src.fetchAll();
console.log('4) acct B down -> status:',
  res.accountsStatus.map((a) => `${a.label}:${a.ok ? 'ok' : 'FAIL'}`).join(' '),
  '| OnlyA:', !!find(res.campaigns, 'OnlyA'), '| OnlyB:', !!find(res.campaigns, 'OnlyB'),
  '| warning sample:', res.warnings[0]?.slice(0, 60));

// ---- 5. Single-account selection ---------------------------------------
reset(); failMode = null;
store.dataSourceConfig = { ...store.dataSourceConfig, activeAccountId: 'b' };
src = await createDataSource();
res = await src.fetchAll();
console.log('5) select acct B -> tokens:', [...new Set(calls.map((c) => c.token))].join(','),
  '| OnlyA:', !!find(res.campaigns, 'OnlyA'), '| OnlyB:', !!find(res.campaigns, 'OnlyB'),
  '| label:', src.describe());

// ---- 6. Legacy single-token config migrates ----------------------------
reset();
store.dataSourceConfig = { kind: 'adjust-direct', apiToken: 'TOKEN_A', appTokens: 'app1', utcOffset: '+07:00', datePeriod: 'rolling30' };
src = await createDataSource();
res = await src.fetchAll();
console.log('6) legacy cfg -> tokens:', [...new Set(calls.map((c) => c.token))].join(','),
  '| rows:', res.campaigns.length, '| label:', src.describe());

// ---- 8-pre: cross-channel same-name rows must never merge --------------
{
  const { __test__ } = await import(BASE + 'data-source.js');
  const dd = __test__.dedupeAcrossAccounts([
    // Same name, NO network ids — the exact shape that used to collide.
    { level: 'campaign', campaignName: 'Caller ID-GL-Up1-082026', campaignId: null, network: 'Facebook', installs: 10 },
    { level: 'campaign', campaignName: 'Caller ID-GL-Up1-082026', campaignId: null, network: 'Google Ads', installs: 2 },
    // Genuine cross-account duplicate (same channel) — must still merge.
    { level: 'campaign', campaignName: 'Caller ID-GL-Up1-082026', campaignId: null, network: 'Facebook', installs: 0, cost: 5 },
  ]);
  console.log('8) cross-channel same-name -> kept:', dd.stats.kept, 'dropped:', dd.stats.dropped,
    '| networks kept:', dd.rows.map((r) => r.network).join(' + '),
    '| FB winner installs:', dd.rows.find((r) => r.network === 'Facebook')?.installs);
}

// ---- 9. Split traffic across accounts: SUM SDK metrics, never double spend --
// The migration state the pick-one rule got wrong: both accounts carry
// installs/revenue for the same campaign (new build rolling out with the new
// account's app_token). Expected: installs 60+40, cohort rev 80+30, cost stays
// 100 (mirrored, not summed), d0 = (0.2*100 + 0.1*100)/100 = 0.30, d7 = 1.10,
// allTime = 110/100, revenueToday 5+3, revenueD2 10 (B's null ignored), costD2
// max(40,40), label "A + B", split flagged.
{
  const { __test__ } = await import(BASE + 'data-source.js');
  const mk = (label, installs, cohRev, d0, d7, revT, revD2, costD2) => ({
    level: 'campaign', campaignName: 'Split', campaignId: '444', network: 'Facebook',
    accountId: label, accountLabel: label,
    cost: 100, installs, cohortAllRevenue: cohRev, roas: { d0, d3: null, d7, allTime: cohRev / 100 },
    revenueToday: revT, revenueYesterday: null, costYesterday: 100, revenueD2: revD2, costD2,
    todayRowExisted: true, adjustCurrency: 'USD',
  });
  const dd = __test__.dedupeAcrossAccounts([
    mk('A', 60, 80, 0.2, 0.8, 5, 10, 40),
    mk('B', 40, 30, 0.1, 0.3, 3, null, 40),
  ]);
  const m = dd.rows[0];
  console.log('9) split traffic -> label:', m.accountLabel, '| cost:', m.cost, '(100 not 200) | installs:', m.installs,
    '(100) | cohortRev:', m.cohortAllRevenue, '(110) | d0:', m.roas.d0.toFixed(2), '(0.30) | d7:', m.roas.d7.toFixed(2),
    '(1.10) | allTime:', m.roas.allTime.toFixed(2), '(1.10)');
  console.log('   revenueToday:', m.revenueToday, '(8) | revenueD2:', m.revenueD2, '(10) | costD2:', m.costD2,
    '(40) | costYest:', m.costYesterday, '(100) | revYest:', m.revenueYesterday, '(null = not fetched) | split:', dd.stats.split,
    '| mergedFrom:', m.mergedFrom.map((x) => `${x.accountLabel}:${x.installs}`).join(','));
  // Clean cut-over (mirror has zeros everywhere) must reduce to the old answer.
  const clean = __test__.dedupeAcrossAccounts([
    mk('A', 60, 80, 0.2, 0.8, 5, 10, 40),
    mk('B', 0, 0, 0, 0, 0, 0, 40),
  ]).rows[0];
  console.log('   clean cut-over -> installs:', clean.installs, '(60) | d7:', clean.roas.d7.toFixed(2), '(0.80) | cost:', clean.cost, '(100) | label:', clean.accountLabel);
}

// ---- 7. D-2 toggled OFF costs nothing ----------------------------------
reset();
store.pillVisibility = { meta: { cohort: true, today: true, yesterday: false, d2: false } };
src = await createDataSource();
await src.fetchAll();
console.log('7) d2 off -> d2 calls:', calls.filter((c) => c.kind.startsWith('d2')).length);
console.log('   scenario-7 call kinds:', JSON.stringify(calls.map(c => `${c.kind}:${c.dp}`)));
