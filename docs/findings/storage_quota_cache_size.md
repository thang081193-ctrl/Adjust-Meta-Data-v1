# `Resource::kQuotaBytes quota exceeded` — the cache outgrew storage.local

**Date:** 2026-09-21 · **Hit on:** v0.12.3 · **Fixed in:** v0.12.4

## Symptom

Popup: `Sync failed: Resource::kQuotaBytes quota exceeded`, right after a sync
that otherwise looked healthy (no Adjust 500s, no partial-sync banner).

The message names neither the storage key nor a size, so it reads like a
mysterious browser failure. It is neither mysterious nor Adjust's fault.

## Cause

`chrome.storage.local` is capped at **10 MB** unless the manifest asks for the
`unlimitedStorage` permission. This extension's `permissions` was `["storage"]`
only — the cap had always been there; the payload just hadn't reached it before.

`background.js` writes the entire result set as ONE key (`campaignDataCache`).
Measured row size (`docs/diagnostics/cache-size-probe.mjs`, realistic Vietnamese
campaign/ad names + Meta 17-digit ids):

```
$ node docs/diagnostics/cache-size-probe.mjs
  rows      22140  (campaign 310 / adset 1420 / ad 20410)
  size      13.98 MB   (662 B/row)
  10 MB cap fits ~15,831 rows
  verdict   OVER the default cap
```

**~662 bytes/row → the 10 MB cap is reached at roughly 15,800 rows.**

What pushed it over, all landing in v0.10–v0.12:

| change | effect on row count / size |
|---|---|
| multi-Adjust-account fan-out (2 accounts) | ~2× rows |
| 3 levels per account — campaign + adset + ad, `limit: 10000` each | up to 60,000 rows theoretical |
| Google Ads channel (`partner_7`) added to `channel_id__in` | more rows per level |
| v11 `costYesterday`, v7 `revenueD2`/`costD2` | ~5 more fields on EVERY row |

So the ceiling is ~16k rows and the fetch is structurally capable of 60k. The
error was a matter of the account growing into it, not a regression in logic.

**The whole Adjust fetch had already succeeded.** Only the final
`chrome.storage.local.set` failed, so the sync burned a full multi-report pull
and cached nothing.

## Fix (v0.12.4)

1. `manifest.json` → `"permissions": ["storage", "unlimitedStorage"]`.
   Lifts the cap entirely. Chrome shows **no extra install warning** for this
   permission. Needs an extension **Reload** to take effect.
2. `background.js` → `writeCache()` wraps the `set`:
   - **checklog on every sync, success or failure**:
     `[Adjust Overlay] cache written — 12.30 MB · 22140 rows (campaign 310 / adset 1420 / ad 20410)`
     The size is now never a guess again — this was the single missing fact.
   - a quota failure is re-thrown as an actionable Vietnamese message naming the
     real size and the Reload → Force-refresh steps. Non-quota errors pass
     through untouched.
   - `measureBytes` uses `TextEncoder`, not `.length` — campaign/ad names are
     full of non-ASCII and `.length` undercounts exactly where the payload is
     heaviest.

## If it ever comes back (i.e. even unlimited isn't enough)

In order of preference:

1. Pick ONE Adjust account in the dropdown instead of **Cả 2 (gộp)** — halves
   the rows outright.
2. Trim app tokens in the popup to the apps actually being scaled.
3. Drop dead fields from the row: `accountId` (only used during the merge
   itself) and `mergedFrom[]` (read by nothing shipped — only
   `docs/diagnostics/datasource-itest.mjs`). Worth ~5%, so only if desperate.
4. Lower `limit: '10000'` in `fetchAtLevel` — but that silently truncates, so
   it would need a `limit_rows` warning surfaced into `syncWarnings` first.

## Watch out: payload size is also an IPC cost

Every injector pulls the whole array over `GET_CACHED` on every page load, and
each `storage.onChanged` fires a structured clone of it. `unlimitedStorage`
removes the error but not that cost — if the checklog starts reading 30 MB+,
the fix is fewer rows, not more quota.

## Related

- `adjust_500_concurrency_retry.md` — the *other* sync failure. Distinguish by
  message: a 500/TimeoutError is Adjust-side and retries; a quota error is
  local and never will.
- `debug_trap_stale_service_worker.md` — `unlimitedStorage` only applies after
  an extension Reload, the same gate that trips the build handshake.
