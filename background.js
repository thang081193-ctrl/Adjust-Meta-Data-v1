// background.js
// Service worker. Owns the sync lifecycle and the cache.
//
// Cache policy (per Pham's accuracy requirement):
// - TTL_MS = 5 minutes during active session.
// - Force refresh from popup ALWAYS bypasses cache.
// - On TOTAL fetch failure, we throw - never serve stale silently. A PARTIAL
//   failure (some Adjust pipelines 500'd, at least one succeeded) caches what
//   succeeded plus syncWarnings[], which popup + injector banners display —
//   partial data is always labeled, never silent.
// - lastSyncAt timestamp is persisted and surfaced to UI.

import { createDataSource } from './src/data-source.js';

// Build stamp for the popup ↔ worker handshake (message GET_BUILD). MUST be
// bumped together with POPUP_BUILD in popup/popup.js and EXPECTED_CACHE_SCHEMA
// in every content/*-injector.js on every release.
//
// WHY A HARD-CODED STRING: Chrome re-reads popup + content scripts from disk on
// every open / injection, but replaces the service worker ONLY on an explicit
// extension Reload — so after a git pull the worker silently keeps running the
// previous build. Observed 2026-09-18: a v0.9.8 worker (no cross-account
// dedupe) under v0.12.1 popup/injectors made Video Downloader pills show the
// other account's row (0% cohort ROAS) and doubled D-2 spend, while the popup
// header cheerfully read v0.12.1. chrome.runtime.getManifest().version cannot
// catch this — the manifest is re-parsed on browser restart while the cached
// worker script is not — only a constant baked into THIS file can.
const WORKER_BUILD = 'v0.12.6';

const TTL_MS = 5 * 60 * 1000;
const CACHE_KEY = 'campaignDataCache';

// ---- Channel-scoped GET_CACHED (v0.12.5, perf) ----
//
// WHY: every injector used to ask for the WHOLE cache and filter it itself.
// With two Adjust accounts x three levels x four networks the payload reached
// ~8-10 MB / ~20k rows (see writeCache's size checklog), and each GET_CACHED
// paid for it twice: once re-reading + JSON-parsing storage in the worker, and
// once structured-cloning the full array across the message port into the tab.
// A Google Ads tab then threw ~65% of those rows away. Measured 2026-09-22 on
// the Jelly account: 2429 Google campaigns + 4969 ad groups is only a third of
// the cache, and the google-injector's cold-start retry loop asks up to 15
// times while the table renders — so the same 10 MB crossed the port over and
// over while Chrome was already busy painting 725 campaigns.
//
// These predicates MUST stay identical to the per-injector filters they
// mirror (meta-injector `!network || /facebook|instagram|meta/i`,
// tiktok-injector `startsWith('TikTok')`, google-injector `/google|adwords/i`).
// The injectors still re-apply their own filter after receiving the rows, so
// an OLD worker that ignores `channel` stays correct — just slow.
const CHANNEL_FILTERS = {
  meta:   (r) => !r.network || /facebook|instagram|meta/i.test(r.network),
  tiktok: (r) => (r.network || '').startsWith('TikTok'),
  google: (r) => /google|adwords/i.test(r.network || ''),
};

// In-memory copy of the parsed cache, so a burst of GET_CACHED (three ads tabs
// waking at once, or one tab's cold-start retry loop) costs ONE storage read
// instead of one per message. Dropped on every write, and naturally dies with
// the worker — so it can never outlive a sync.
const MEMO_TTL_MS = 30 * 1000;
let cacheMemo = null;
// Bump when cache shape changes incompatibly. Readers without this version
// or with an older version discard their cache and force a fresh sync.
// v2: introduced level='adset' rows from direct Adjust adset-level fetch.
// v3: fixed todayIdKey collision between ad-level shadow rows and adset-level
//     rows that caused adsetByIdIndex to be bumped twice (cohort row + orphan
//     row both keyed by adsetId), producing inflated pill revenue.
// v4: added per-row revenueYesterday (BKT-yesterday gross) for the Meta
//     LA-timezone today-pill regime-1 revenue estimate.
// v5: removed revenueYesterday again — the LA-timezone today-pill switched to
//     a BKT-anchored model (Option B) where revenue is kept as Adjust's
//     BKT-today and only spend is re-projected, so no Adjust yesterday-revenue
//     fetch/field is needed. Discard v4 caches to drop the now-dead field.
// v6: re-added per-row revenueYesterday (event-date, realtime gross) to power
//     the optional Meta Yesterday realtime pill (Adjust yesterday rev ÷ Meta
//     yesterday spend). Only populated when that pill's toggle is on; 0
//     otherwise. Discard v5 caches so the field is present on next sync.
// v7: added per-row revenueD2 + costD2 (event-date gross + Adjust network
//     spend for two days ago) powering the optional D-2 pill. Both sides of
//     that pill's ratio come from Adjust — no UI spend capture. Only populated
//     when a D-2 toggle is on; null otherwise.
// v8: added top-level syncWarnings[] (pipeline failures survived by partial
//     sync — v0.9.5's answer to Adjust 500 TimeoutError under 12 parallel
//     report calls). Row shape unchanged; bump is bookkeeping so a live cache
//     unambiguously identifies the build that wrote it.
// v9: multi-Adjust-account. Rows carry accountId + accountLabel (which Adjust
//     account they came from), and the cache gains top-level accountsStatus[]
//     (per-account ok / row count / error) plus activeAccountId so the popup
//     and both injectors can say WHICH Adjust is on screen. Discard v8 caches:
//     their rows have no account tag, so a v9 reader could not tell a
//     single-account cache from a merged one.
// v10: Google Ads channel added to the fetch (partner_7) and EVERY injector now
//     filters rows by channel before indexing (Meta previously indexed all
//     rows). Row shape unchanged; discard v9 caches so the first post-upgrade
//     paint already includes Google rows instead of waiting out the TTL.
// v11: rows gain costYesterday (Adjust network spend for D-1). The Yesterday
//     pill's denominator now comes from Adjust like D-2's; the scraped-UI
//     spend survives only as an injector-side fallback. Discard v10 caches so
//     the field exists after the first post-upgrade sync.
// v12: cross-account duplicates are MERGED (installs/revenue summed, spend =
//     max, ROAS recomputed) instead of resolved to one account. Merged rows
//     carry mergedFrom[] + a joined accountLabel ("Adjust 1 + Adjust 2"), and
//     the cache gains top-level mergeStats. Injectors now REFUSE a cache whose
//     schemaVersion isn't theirs — that is the stale-service-worker tripwire
//     (see WORKER_BUILD), so this bump is also what makes a v0.9.x/v0.12.1
//     worker visible instead of silently double-counting.
const CACHE_SCHEMA_VERSION = 12;

// First console line after a (re)load — the quickest way to confirm which build
// the worker is actually running.
console.info(`[Adjust Overlay] service worker ${WORKER_BUILD} started · cache schema v${CACHE_SCHEMA_VERSION}`);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Async pattern: return true to keep channel open.
  (async () => {
    try {
      switch (msg.type) {
        case 'SYNC':
          sendResponse(await syncIfStale());
          break;
        case 'FORCE_SYNC':
          sendResponse(await forceSync());
          break;
        case 'GET_CACHED':
          // msg.channel ('meta' | 'tiktok' | 'google') scopes the payload to
          // that network's rows. Omitted (popup, internal callers) = everything.
          sendResponse(await getCached(msg.channel));
          break;
        case 'GET_BUILD':
          // Build handshake — see WORKER_BUILD. A worker old enough not to know
          // this message type falls through to `default` and answers with an
          // error, which the popup reads as "stale worker" just the same.
          sendResponse({ build: WORKER_BUILD, schemaVersion: CACHE_SCHEMA_VERSION });
          break;
        default:
          sendResponse({ error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ error: err.message, stack: err.stack });
    }
  })();
  return true;
});

async function syncIfStale() {
  const cached = await getCached();
  if (cached && !cached.isStale) {
    return { ...cached, fromCache: true };
  }
  return forceSync();
}

async function forceSync() {
  const source = await createDataSource();
  // Let exceptions propagate - caller will see error, no stale fallback.
  // AdjustDirectDataSource returns { campaigns, warnings }; the JM-AM stub
  // (or any legacy source) may return a bare array — normalize both shapes.
  const result = await source.fetchAll();
  const campaigns = Array.isArray(result) ? result : result.campaigns;
  const syncWarnings =
    !Array.isArray(result) && Array.isArray(result.warnings) ? result.warnings : [];
  // Per-account outcome (v9). Persisted so the popup can render a row per
  // Adjust account — "Adjust cũ ✓ 812 rows / Adjust mới ✗ 500" — instead of a
  // single opaque count that hides one account being completely down.
  const accountsStatus =
    !Array.isArray(result) && Array.isArray(result.accountsStatus) ? result.accountsStatus : [];
  if (syncWarnings.length) {
    console.warn('[Adjust Overlay] partial sync —', syncWarnings.length, 'pipeline(s) failed:', syncWarnings);
  }
  const stored = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    campaigns,
    syncWarnings,
    accountsStatus,
    // Cross-account merge outcome (v12): how many entities were reported by
    // more than one account and how many of those have SDK traffic on both
    // sides. Popup renders it so a "gộp" number is never a silent one.
    mergeStats: source.lastMergeStats || null,
    lastSyncAt: Date.now(),
    sourceLabel: source.describe(),
  };
  await writeCache(stored);
  return { ...stored, ageMs: 0, isStale: false, fromCache: false };
}

// Persist the cache, with a size checklog and a readable quota failure.
//
// WHY (2026-09-21, v0.12.3): a sync died on Chrome's raw
// "Resource::kQuotaBytes quota exceeded". chrome.storage.local is capped at
// 10 MB unless the manifest asks for `unlimitedStorage`, and this extension's
// payload had quietly grown past it: v0.12 fans the fetch across TWO Adjust
// accounts (~2x rows), each account pulls THREE levels (campaign + adset + ad,
// `limit: 10000` apiece), the Google Ads channel added a fourth network, and
// v11/v12 put five more fields on every row. Nothing in the error said any of
// that — it named neither the key nor the size — so the size is now logged on
// every single sync whether it succeeds or not.
//
// `unlimitedStorage` (manifest v0.12.4) removes the cap, but the guard stays:
// it is the only place that will say "your cache is 31 MB" out loud, and a
// payload that large is worth seeing even when it fits.
async function writeCache(stored) {
  const bytes = measureBytes(stored);
  const byLevel = countByLevel(stored.campaigns);
  const summary =
    `${(bytes / 1048576).toFixed(2)} MB · ${stored.campaigns.length} rows ` +
    `(campaign ${byLevel.campaign} / adset ${byLevel.adset} / ad ${byLevel.ad})`;
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: stored });
    cacheMemo = { payload: stored, readAt: Date.now() };
    console.info(`[Adjust Overlay] cache written — ${summary}`);
  } catch (err) {
    const quota = /quota/i.test(err.message || '');
    cacheMemo = null;
    console.error(`[Adjust Overlay] cache write FAILED at ${summary} —`, err);
    if (!quota) throw err;
    throw new Error(
      `Cache ${summary} — vượt quota của chrome.storage.local ` +
      `(10 MB khi chưa có quyền unlimitedStorage). ` +
      `Adjust đã kéo xong hết dữ liệu — chỉ bước ghi cache hỏng. ` +
      `Vào chrome://extensions → Reload để extension nhận quyền unlimitedStorage của v0.12.4, ` +
      `rồi Force refresh. Nếu vẫn hỏng: bớt app token, hoặc chọn 1 Adjust account thay vì “Cả 2 (gộp)”.`
    );
  }
}

// Byte size as chrome.storage measures it: the JSON serialization of the value.
function measureBytes(value) {
  // TextEncoder counts UTF-8 bytes — campaign/ad names are full of non-ASCII,
  // so .length would undercount exactly where the payload is heaviest.
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function countByLevel(rows) {
  const out = { campaign: 0, adset: 0, ad: 0 };
  for (const r of rows || []) {
    if (r.level in out) out[r.level] += 1;
  }
  return out;
}

// Returns null when no data, otherwise the cache payload enriched with
// ageMs + isStale so callers don't need a second round-trip to compute freshness.
// Caches from a previous extension version (missing schemaVersion or older
// than current) are discarded — caller treats this as "no data" and triggers
// a fresh sync, ensuring users don't see stale rollup-era numbers after update.
async function getCached(channel) {
  const now = Date.now();
  let cached = null;
  let memoHit = false;

  if (cacheMemo && now - cacheMemo.readAt < MEMO_TTL_MS) {
    cached = cacheMemo.payload;
    memoHit = true;
  } else {
    const got = await chrome.storage.local.get(CACHE_KEY);
    cached = got[CACHE_KEY] || null;
    if (cached && (cached.schemaVersion || 0) < CACHE_SCHEMA_VERSION) {
      await chrome.storage.local.remove(CACHE_KEY);
      cacheMemo = null;
      return null;
    }
    cacheMemo = cached ? { payload: cached, readAt: now } : null;
  }
  if (!cached) return null;

  const all = cached.campaigns || [];
  const filter = channel ? CHANNEL_FILTERS[channel] : null;
  const campaigns = filter ? all.filter(filter) : all;
  // Checklog: the one line that says how much actually crossed the port. If a
  // tab is slow again, this is where you see whether it received 7k rows or
  // 20k — and whether the storage read was skipped.
  console.debug(
    `[Adjust Overlay] GET_CACHED ${channel || 'all'} → ${campaigns.length}/${all.length} rows` +
    `${memoHit ? ' (memo hit)' : ' (storage read)'}`
  );

  const ageMs = Date.now() - cached.lastSyncAt;
  return { ...cached, campaigns, channel: channel || null, ageMs, isStale: ageMs > TTL_MS };
}
