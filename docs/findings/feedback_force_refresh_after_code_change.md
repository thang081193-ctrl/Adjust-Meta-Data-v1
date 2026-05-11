---
name: After code changes affecting Adjust fetch params, instruct user to Force-refresh the popup once
description: The extension's 5-min cache holds the previous fetch's result. If code changes alter what the Adjust fetch returns (new metric, new dimensions, new endpoint), a normal reload of the extension is NOT enough — the cache must be invalidated by clicking Force-refresh.
type: feedback
---

# Force-refresh after Adjust-fetch code changes

The extension caches Adjust fetch results in `chrome.storage.local.campaignDataCache` with a 5-minute TTL. When extension code changes alter the fetch params or response handling (new metric name, new endpoint, fixed bug), reloading the extension via `chrome://extensions` reload icon does NOT invalidate the cache — only the in-memory state. The next `loadData()` call reads the old cached payload.

**Why:** The user spent ~10 min thinking a fix didn't work when actually the cache was stale. The pills only updated when they happened to click a different popup period button, which triggered `doSync(true)` (force refresh).

**How to apply:** Whenever a code change touches `src/adjust-client.js` (metric names, dimensions, endpoint, response parsing) or `src/data-source.js` (merge logic, new fields), include these THREE steps in the reload instructions:

1. `chrome://extensions` → click 🔄 reload icon on the extension card.
2. F5 the Meta Ads Manager tab.
3. **Click the extension popup → click "Force refresh" button** (not "Sync"). This bypasses the 5-min cache.

Step 3 is the one users skip. Without it the test reuses stale cache and you waste a debug cycle.

Pure rendering changes (CSS, DOM injection logic) don't need step 3 — only changes that affect what the Adjust fetch returns or how it's merged.
