// background.js — v2-secure variant
// Service worker. Owns the sync lifecycle and the cache.
//
// Cache policy (v2-secure):
// - TTL_MS = 30 seconds in extension storage. The Worker's KV cache is the
//   real freshness layer (5 min); extension cache here exists only to
//   dedupe rapid double-clicks within the same popup session. Each popup
//   open hits the proxy → audit log records every real sync attempt.
// - Force refresh ALWAYS bypasses extension cache; Worker still serves
//   from KV if <5 min — that's intentional (rate-limit Adjust).
// - On fetch error, throw — never serve stale silently.
// - SESSION_EXPIRED / NOT_LOGGED_IN errors propagate up so popup can show login UI.

import { createDataSource } from './src/data-source.js';

const TTL_MS = 30 * 1000;
const CACHE_KEY = 'campaignDataCache';

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
    campaigns,
    lastSyncAt: Date.now(),
    sourceLabel: source.describe(),
  };
  await chrome.storage.local.set({ [CACHE_KEY]: stored });
  return { ...stored, ageMs: 0, isStale: false, fromCache: false };
}

// Returns null when no data, otherwise the cache payload enriched with
// ageMs + isStale so callers don't need a second round-trip to compute freshness.
async function getCached() {
  const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
  if (!cached) return null;
  const ageMs = Date.now() - cached.lastSyncAt;
  return { ...cached, ageMs, isStale: ageMs > TTL_MS };
}
