> **SUPERSEDED (2026-09-18).** This describes the v0.9.7 "never merge, user picks
> the view" design that lived on the local line stashed as
> `wip-v0.9.8-superseded-by-v0.12.0-pull`. The shipped implementation is
> `src/accounts.js` + the merge in `src/data-source.js`; read
> [adjust_multi_account.md](adjust_multi_account.md) instead. Kept only because
> the v0.9.8 worker was still running in Chrome on 2026-09-18 (see
> [debug_trap_stale_service_worker.md](debug_trap_stale_service_worker.md)).

# Two Adjust accounts, kept separate

**Date:** 2026-08-27 · **Shipped in:** v0.9.7 (meta injector `v0.9.7-multi-adjust-account`, tt `v0.5.5-multi-adjust-account`, cache schema v10)

## What changed

The portfolio is migrating app-by-app from one Adjust account onto a second
one. A migrated app gets a **brand-new `app_token`** in the new account, and the
new account has its **own API token**. Up to v0.9.6 `dataSourceConfig` held a
single `apiToken` + `appTokens` pair, which cannot express that.

`dataSourceConfig.accounts` is now a list:

```js
{ id: 'a1', label: 'Adjust 1', apiToken: '…', appTokens: 'tok1,tok2', enabled: true }
```

`normalizeAccounts()` in [src/adjust-accounts.js](../../src/adjust-accounts.js)
migrates the legacy single-token shape into a one-entry list, so upgrading users
retype nothing.

## The decision that shapes everything: no merging

Rows from different accounts are **fetched independently, tagged with
`accountId`, and cached side by side**. Nothing is summed across accounts.
The user chooses which account the pills read (popup → "Nguồn dữ liệu",
persisted as `chrome.storage.local.adjustView`), defaulting to `all`.

**Why:** an app lives in exactly one Adjust account at a time, so `all` is a
*union*, not a *sum* — there is nothing to reconcile. Merging would have forced
a guess on cost: if the same campaign appeared in both accounts, is its spend
*split across the migration* (add the two) or *pulled twice by two Facebook
integrations* (take one)? Either guess fabricates a number. Keeping the rows
separate makes the question unnecessary.

**The tripwire:** `findCrossAccountDuplicates()` in
[src/data-source.js](../../src/data-source.js) scans the merged row set for any
entity (campaign / adset / ad, by id or canonical name) that appears under more
than one `accountId`, and pushes a `syncWarning` naming it. It does not fix the
row — the injectors aggregate by id/name, so under `all` that entity's cost
really is double-counted. The warning tells the user to pin the view to one
account or remove the app from the old one. **If this warning ever fires, the
assumption above has broken and the merge policy needs an actual decision.**

## Concurrency is per account, not global

v0.9.5 capped report calls at 3 concurrent because Adjust's report generator
returned `HTTP 500 Internal Service Error: TimeoutError` under a 12-call burst
(see [adjust_500_concurrency_retry.md](adjust_500_concurrency_retry.md)). That
was **one account's backend** timing out on its own queue.

So the gate in [src/adjust-client.js](../../src/adjust-client.js) is now keyed
by API token: each account gets its own 3-in-flight budget. Two accounts with
every pill enabled = 36 report calls, at most 6 in flight, **3 per Adjust
backend** — identical per-account load to the single-account build, without
doubling sync wall-clock. Verified with a stubbed-fetch harness: peak per token
3, peak total 6.

A shared global cap would have been the "safer" choice only in appearance: it
halves throughput while leaving the per-backend load — the thing that actually
caused the 500s — unchanged.

## Things that bit / would have bitten

- **`buildDirectIndex` overwrites, it does not sum.** Campaign-level rows are
  indexed by name with `map.set()`, last write wins. Had accounts been
  concatenated *without* the view filter, one account's campaign row would have
  silently replaced the other's — no error, just wrong numbers. Every consumer
  filters by `accountId` *before* indexing.
- **Cache schema had to bump to v10.** v9 rows carry no `accountId`; a view
  pinned to an account would match zero rows and every pill would vanish with no
  explanation. Bumping discards those caches on upgrade.
- **A pinned view whose account is deleted or switched off** looks exactly like
  a broken matcher. `resolveView()` snaps it back to `all`, and both injectors
  emit a banner line when a pinned view yields zero rows.
- **Enabled-but-tokenless accounts are skipped** (`syncableAccounts`), otherwise
  a half-filled form row fires `Authorization: Bearer ` and burns a retry cycle
  on a guaranteed 401.

## How to apply

- Adding an app to Adjust 2: paste its new `app_token` into **Adjust 2's** App
  tokens field and remove the old token from Adjust 1's. Keep
  [APP_TOKENS.md](../../APP_TOKENS.md) in step — it is split per account.
- Every enabled account is fetched on **every** sync regardless of the active
  view, so switching views is instant (one storage write, no refetch). To stop
  paying report calls for an account, untick it rather than switching away.
- Warnings and retry logs are prefixed with the account label
  (`Adjust 2 · Adjust API failed: …`), so "which account is broken" is answered
  by the message itself.
