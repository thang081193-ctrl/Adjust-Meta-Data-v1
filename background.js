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

const TTL_MS = 5 * 60 * 1000;
const CACHE_KEY = 'campaignDataCache';
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
const CACHE_SCHEMA_VERSION = 11;

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
          sendResponse(await getCached());
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
    lastSyncAt: Date.now(),
    sourceLabel: source.describe(),
  };
  await chrome.storage.local.set({ [CACHE_KEY]: stored });
  return { ...stored, ageMs: 0, isStale: false, fromCache: false };
}

// Returns null when no data, otherwise the cache payload enriched with
// ageMs + isStale so callers don't need a second round-trip to compute freshness.
// Caches from a previous extension version (missing schemaVersion or older
// than current) are discarded — caller treats this as "no data" and triggers
// a fresh sync, ensuring users don't see stale rollup-era numbers after update.
async function getCached() {
  const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
  if (!cached) return null;
  if ((cached.schemaVersion || 0) < CACHE_SCHEMA_VERSION) {
    await chrome.storage.local.remove(CACHE_KEY);
    return null;
  }
  const ageMs = Date.now() - cached.lastSyncAt;
  return { ...cached, ageMs, isStale: ageMs > TTL_MS };
}
