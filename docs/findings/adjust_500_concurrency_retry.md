# Adjust 500 "Internal Service Error: TimeoutError" under parallel report bursts

**Date:** 2026-08-15 · **Fixed in:** v0.9.5 (meta injector `v0.9.5-adjust-retry-partial-sync`, tt `v0.5.3-adjust-retry-partial-sync`, cache schema v8)

## What was observed

Popup showed `Sync failed: Adjust API failed: 500 — {"error_code":"service_error","error_desc":"Internal Service Error: TimeoutError","correlation_id":"..."}` and the cache sat stale for 19 hours (user kept working off old pills).

## Root cause

Not a client bug — Adjust's report generator times out server-side when too many
heavy reports are requested at once. The D-2 pill (v0.9.4) doubled a sync's
parallel calls from 6 to 12 (cohort ×3 levels + today ×3 + D-2 cohort ×3 + D-2
event-date ×3; 15 with Yesterday on), each with `limit=10000` over 11 app
tokens. One call 500s → the cohort pipeline was the only one without a
`.catch()` → whole `fetchAll()` rejected → nothing cached.

## Fix (three layers, all in `src/adjust-client.js` + `src/data-source.js`)

1. **Concurrency gate** — `fetchAdjustRows` holds a semaphore slot
   (`MAX_CONCURRENT = 3`); excess requests queue. Slot released before backoff
   sleeps so retries don't starve the queue.
2. **Retry with backoff** — 3 attempts total, 1s/3s (+0–400ms jitter), only on
   429/500/502/503/504 and network drops. Client-side 60s aborts are NOT
   retried (each attempt already held the Force-refresh spinner for 60s).
3. **Partial sync** — every pipeline in `fetchAll()` catches its own failure
   into `warnings[]`; cache is written from whatever succeeded. Only when ALL
   pipelines fail does sync throw. `cache.syncWarnings` (schema v8) is rendered
   by the popup (amber box) and both injector banners ("⚠ Partial sync — …"),
   so partial data is always labeled, never silent.

Also fixed in passing: `fetchD2GrossRevenue` created a floating
`costRowsPromise` awaited only after the revenue fetch — a cost-side rejection
during that window fired `unhandledrejection` in the service worker. Now uses
`Promise.allSettled`.

## How to apply / checklog

- If the popup shows the amber "Partial sync" box or a banner says
  `⚠ Partial sync — N Adjust report(s) failed`, that's Adjust-side load, not a
  data bug: Force refresh retries everything.
- Verified by simulation (`scratchpad/synctest/test.mjs` pattern): 500-once →
  retry succeeds with zero warnings; cohort permanently down → today/yesterday
  pills still populate, cohort fields null (never fabricated 0); all down →
  sync throws the cohort error.
- If Adjust 500s return DESPITE retry+cap, lower `MAX_CONCURRENT` to 2 or
  raise retry attempts before hunting client bugs — check the popup error's
  `correlation_id` against Adjust support first.
- Adding another pill that fetches: it adds 3+ report calls per sync. Keep the
  toggle-gated fetch pattern AND reuse `fetchAdjustRows` so the gate covers it.
