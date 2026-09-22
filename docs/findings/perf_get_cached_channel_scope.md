# GET_CACHED now ships only one channel's rows (v0.12.5)

**Status:** shipped 2026-09-22 in v0.12.5

## What was wrong

Every injector asked the service worker for the **whole** cache and filtered it
itself:

```js
const cached = await chrome.runtime.sendMessage({ type: 'GET_CACHED' });
const googleRows = (cached.campaigns || []).filter(r => GOOGLE_NETWORK_RE.test(r.network || ''));
```

With two Adjust accounts × three levels (campaign/adset/ad) × four networks the
payload is ~8–10 MB / ~20 k rows — see `writeCache`'s size checklog and
[[storage_quota_cache_size]]. Each `GET_CACHED` therefore paid for it twice:

1. the worker re-read and JSON-parsed the full 10 MB out of `chrome.storage.local`
2. the whole `campaigns` array was structured-cloned across the message port

…and a Google Ads tab then threw ~65 % of the rows away. Measured on the
Jelly - Chatbot 2 account: 2429 Google campaigns + 4969 ad groups + 5 ads is
only about a third of the cache.

It happened more often than "once per tab": the google-injector's cold-start
retry loop calls `loadData()` on every tick while the table has not painted,
and the Google Ads campaigns view for this account can take **over two minutes**
to render (see [[google_ads_table_render_latency]]). Same 10 MB over the port,
again and again, while Chrome was already busy painting 725 campaigns.

## What changed

- `GET_CACHED` accepts `msg.channel` — `'meta' | 'tiktok' | 'google'`. The
  worker filters `campaigns` **before** the response is cloned.
  Omitted (popup, internal callers) = full payload, unchanged.
- `CHANNEL_FILTERS` in `background.js` mirrors the three injector predicates
  exactly. Keep them in sync:
  | channel | predicate |
  |---|---|
  | meta | `!network \|\| /facebook\|instagram\|meta/i` |
  | tiktok | `network.startsWith('TikTok')` |
  | google | `/google\|adwords/i` |
- A 30 s in-memory `cacheMemo` in the worker, so a burst of `GET_CACHED`
  (three ads tabs waking at once, or one tab's retry loop) costs ONE storage
  read. Refreshed by `writeCache`, cleared when a write fails, and it dies with
  the worker — so it can never outlive a sync.
- Checklog on every call:
  `[Adjust Overlay] GET_CACHED google → 7403/20114 rows (memo hit)`

## Why no CACHE_SCHEMA_VERSION bump

Row shape is unchanged. Crucially, **each injector still re-applies its own
network filter** after receiving the rows — so an old worker that ignores
`channel` and returns everything stays correct, just slower. That is deliberate:
the stale-worker tripwire ([[debug_trap_stale_service_worker]]) must not fire
for a change that is purely an optimisation.

Related: [[perf_decorate_self_feedback_loop]], [[multi_adjust_account_split]].
