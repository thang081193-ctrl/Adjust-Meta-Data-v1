---
name: Multiple Adjust accounts — config shape, fan-out, and cross-account dedupe
description: How the extension covers apps split across more than one Adjust account, and the ownership rule that resolves an entity reported by both.
type: project
---

# Multiple Adjust accounts (v0.10, merge rule v0.12.2)

**Date:** 2026-09-01 · **Added in:** v0.10.0 · **Merge rule:** v0.12.2 (2026-09-18) · **Cache schema:** v12

## Why

The user's apps are split across two Adjust accounts — Chatbot / ChartPilot /
PlantSmart were migrated from the older account, Video Downloader was created in
the newer one. An Adjust API token can only see the apps of the account that
minted it, so a single-token client structurally cannot cover every campaign in
Ads Manager: the missing apps' rows just never arrive and their pills read as
"no Adjust match".

## Config shape (`chrome.storage.local.dataSourceConfig`)

```js
{
  kind: 'adjust-direct',
  utcOffset: '+07:00',          // SHARED
  accountTimezone: 'America/…', // SHARED
  datePeriod: 'rolling30',      // SHARED
  accounts: [
    { id, label, apiToken, appTokens },   // app tokens are per-account
    …
  ],
  activeAccountId: 'all' | '<account id>',
}
```

`utcOffset` / `accountTimezone` / `datePeriod` stay **shared on purpose**: they
describe the window the user wants to read and the Meta ad-account's clock, not a
property of an Adjust account. Two accounts read on two different offsets would
produce pills whose numbers cannot be compared side by side.

`src/accounts.js` owns this shape, including migration from the pre-v0.10
top-level `apiToken`/`appTokens` (→ `accounts[0]`, label "Adjust 1"). Both
`popup/popup.js` and `src/data-source.js` import it so the two can never drift.
The popup deletes the legacy top-level fields on every write, so a retired token
cannot be resurrected from a stale copy.

## Fan-out cost

`fetchAll()` runs the selected accounts in parallel, and since v0.10.1 the
concurrency gate in `fetchAdjustRows` is **per API token** (`MAX_CONCURRENT = 3`
each): the 500-timeout the cap guards against is that account's own report
generator choking, so a second account — with its own generator — gets its own
3 slots instead of queueing behind the first (the v0.10.0 global gate roughly
doubled "Cả 2 (gộp)" sync time while protecting nothing). `AbortSignal.timeout`
starts only *after* a slot is acquired — queueing never eats the 60s budget.
Two accounts with the D-2 pill on is 24 report calls, but each account's 12 run
at the same pace as a single-account sync. Splitting the apps across two
accounts also makes each individual report smaller.

Selecting a single account fetches only that account. **Changing the selection
force-syncs** — the cached rows belong to the previously selected account, and
leaving them on screen under a new label would be the worst possible outcome.

## Cross-account merge — v0.12.2 (supersedes the v0.10 ownership rule)

Two accounts can legitimately report the **same** Meta entity, and — while a
migration is in flight — **both can carry SDK traffic for it**: the old account
keeps its Meta ad-spend integration (so it keeps reporting `cost`), the new
account's app_token ships in a build that rolls out gradually, and for days or
weeks installs + revenue land on both sides. Verified 2026-09-18: Video
Downloader is live as `d2khbj9qdgjk` in Adjust 1 (152 installs/day on one
campaign) and as `[JM] Video Downloader` in Adjust 2 at the same time.

v0.10–v0.12.1 resolved a duplicate by **keeping one row** (the account with
the most installs). Exact for a clean cut-over, but during a split it silently
throws away the other account's revenue — up to half the ROAS.

Rule now (`dedupeAcrossAccounts` → `mergeGroup` in `src/data-source.js`):

| field | merge | why |
|---|---|---|
| `cost`, `costYesterday`, `costD2` | **max** | spend is one number per Meta ad; every account's integration mirrors the same figure — summing doubles it, max also survives an account with the integration off |
| `installs`, `cohortAllRevenue`, `revenueToday`, `revenueYesterday`, `revenueD2` | **sum** | an install / revenue event is recorded by exactly one SDK app_token, so accounts never contain each other's events |
| `roas.d0/d3/d7` | Σ(roas_i × cost_i) ÷ merged cost | Adjust returns ratios, so window revenue is recovered per row first; a row with no cost contributes nothing |
| `roas.allTime` | Σ cohortAllRevenue ÷ merged cost | |
| `accountLabel` | `"Adjust 1 + Adjust 2"` | every pill tooltip says the number is a merge |
| `mergedFrom[]` | per-account raw installs / cost / revenue | diagnostics |

The **primary** row (ids, names, network, currency) is still chosen by the old
ownership score (installs → cohort revenue → realtime revenue → cost), so
matching is unchanged — only the arithmetic. Same-network only (see `mergeKey`).

`mergeStats { merged, split, splitSamples }` is written to the cache; the popup
renders it under the per-account lines (`⇄ N entity có ở ≥2 account → gộp · M
đang chia traffic`), and the worker logs it. `split > 0` is the normal state
of a migrating app, not an error.

The key space deliberately mirrors how the injectors index rows, so the only
rows collapsed here are ones that would have collided downstream anyway:

| level | key |
|---|---|
| campaign | Meta campaign id, else canonical campaign name |
| adset | `adsetId`, else `campaignId` + canonical adset name |
| ad | `adId`, else `campaignId` + canonical ad name |

Same-named ads in *different* campaigns keep different keys and both survive —
the existing composite/id index + ambiguity machinery handles them as before.

### What a STALE worker does to this

The merge runs in the service worker. Chrome replaces the worker only on an
explicit extension Reload, so after a `git pull` the injectors (re-read from
disk per injection) can be v0.12.x while the worker is still an older build
that never merged. The injectors then receive both accounts' rows: campaign
level indexes last-write-wins (the *second* account's cohort ROAS shows — 0%
for a `[JM]` twin with no cohort revenue) and `bumpToday` **sums** D-1/D-2
spend across the twins (doubled denominator). This is exactly what was
observed 2026-09-18 on the LPT30 Video Downloader campaigns. Since v0.12.2
every injector refuses a cache whose `schemaVersion` isn't its own and the
popup refuses to sync through a worker whose `GET_BUILD` doesn't match —
see [debug_trap_stale_service_worker.md](debug_trap_stale_service_worker.md).

## What the user can see

- Popup: a per-account status line per sync (`✓ Adjust cũ — 812 rows` /
  `✗ Adjust mới — 401 …`), from `cache.accountsStatus` (schema v9).
- Warnings are prefixed `[<account label>]`, so a partial sync says *which*
  Adjust failed.
- Both injector banners show the selection via `cache.sourceLabel`
  (`Adjust Reporting v2 · Adjust cũ + Adjust mới (gộp)`).
- Every pill tooltip carries `Adjust account: <label>` for the row it decorates.

## How to apply

- Adding a per-account setting: put it on the account object in
  `src/accounts.js`, not at the top level. Adding a *window* setting (a date, an
  offset): keep it shared, or pills stop being comparable.
- A token-less account card is **skipped, not fetched** — it could only produce a
  401. `resolveActiveAccounts` reports it in `skipped` so the popup can say why.
- Row count per account is the fastest check that a newly added token works:
  popup → the `✓ … rows` line. Zero rows with `ok` means the token is valid but
  its `appTokens` filter matched nothing.
