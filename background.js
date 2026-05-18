// background.js
// Service worker. Owns the sync lifecycle and the cache.
//
// Cache policy (per Pham's accuracy requirement):
// - TTL_MS = 5 minutes during active session.
// - Force refresh from popup ALWAYS bypasses cache.
// - On fetch error, we throw - never serve stale silently.
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
const CACHE_SCHEMA_VERSION = 3;

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
  const campaigns = await source.fetchAll();
  const stored = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    campaigns,
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
