// docs/diagnostics/cache-size-probe.mjs
// How many rows fit in chrome.storage.local before it throws
// "Resource::kQuotaBytes quota exceeded"?
//
// Context: docs/findings/storage_quota_cache_size.md. The extension writes its
// whole result set as ONE key (`campaignDataCache`), and storage.local is
// capped at 10 MB without the `unlimitedStorage` permission. This probe turns
// that cap into a row count so "is the cache too big?" is a number, not a hunch.
//
// USAGE
//   node docs/diagnostics/cache-size-probe.mjs
//       synthetic row at realistic Vietnamese-name / Meta-id width
//
//   node docs/diagnostics/cache-size-probe.mjs <dump.json>
//       measure a REAL cache. Get one from the service-worker console:
//         copy(JSON.stringify((await chrome.storage.local.get('campaignDataCache')).campaignDataCache))
//       then paste into a file and pass its path.

import { readFile } from 'node:fs/promises';

const QUOTA_DEFAULT = 10 * 1024 * 1024;   // storage.local without unlimitedStorage

// TextEncoder, not .length: chrome.storage measures the UTF-8 serialization,
// and campaign/ad names are exactly where the non-ASCII lives.
const bytesOf = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

// One ad-level row as v0.12 actually shapes it: toRow() in src/adjust-client.js
// + the realtime fields from mergeRealtimeInto() + the account tag.
function sampleRow(i, level) {
  return {
    level,
    campaignName: `VN | Android | Video Downloader | Lookalike 3% | Chiến dịch ${i}`,
    adsetName: `Nhóm quảng cáo ${i} — Tối ưu lượt cài đặt`,
    adName: `Quảng cáo ${i} — bản dựng ngang 9x16`,
    campaignId: `120212${String(i).padStart(11, '0')}`,
    adsetId: `120212${String(i).padStart(11, '1')}`,
    adId: `120212${String(i).padStart(11, '2')}`,
    network: 'Facebook Installs',
    cost: 12.34,
    cohortAllRevenue: 5.6789,
    installs: 428,
    roas: { d0: 0.1123, d3: 0.2234, d7: 0.3345, allTime: 0.4601 },
    revenueToday: 1.23,
    revenueYesterday: 2.34,
    costYesterday: 3.45,
    revenueD2: 4.56,
    costD2: 5.67,
    todayRowExisted: true,
    adjustCurrency: 'USD',
    accountId: 'acctmfp9x2k1',
    accountLabel: 'Adjust 1',
  };
}

function report(label, rows) {
  const total = bytesOf(rows);
  const per = total / rows.length;
  const byLevel = rows.reduce((a, r) => ((a[r.level] = (a[r.level] || 0) + 1), a), {});
  console.log(`${label}`);
  console.log(`  rows      ${rows.length}  (${Object.entries(byLevel).map(([k, v]) => `${k} ${v}`).join(' / ')})`);
  console.log(`  size      ${mb(total)}   (${Math.round(per)} B/row)`);
  console.log(`  10 MB cap fits ~${Math.floor(QUOTA_DEFAULT / per).toLocaleString('en-US')} rows`);
  console.log(`  verdict   ${total > QUOTA_DEFAULT
    ? 'OVER the default cap — needs unlimitedStorage (v0.12.4+) or fewer rows'
    : `under the default cap (${(100 * total / QUOTA_DEFAULT).toFixed(0)}% used)`}`);
  console.log();
}

const dumpPath = process.argv[2];

if (dumpPath) {
  const parsed = JSON.parse(await readFile(dumpPath, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.campaigns;
  if (!Array.isArray(rows)) {
    console.error('Expected an array of rows, or a cache object with .campaigns');
    process.exit(1);
  }
  report(`REAL cache — ${dumpPath}`, rows);
} else {
  // The shape the extension actually produces: one campaign row per handful of
  // adsets, one adset per handful of ads. Ad-level rows dominate, which is why
  // they are what any trimming has to target.
  const rows = [
    ...Array.from({ length: 310 }, (_, i) => sampleRow(i, 'campaign')),
    ...Array.from({ length: 1420 }, (_, i) => sampleRow(i, 'adset')),
    ...Array.from({ length: 20410 }, (_, i) => sampleRow(i, 'ad')),
  ];
  report('SYNTHETIC — 2 Adjust accounts, 13 app tokens, 3 levels', rows);
  console.log('Pass a real cache dump for an exact number — see the header of this file.');
}
