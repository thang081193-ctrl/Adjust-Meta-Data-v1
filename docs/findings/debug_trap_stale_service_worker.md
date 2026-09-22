# Debug trap: stale service worker after a code change (401 "account ownership" / wrong-account pills)

**Date:** 2026-08-27, second sighting 2026-09-18 · **Guarded in:** v0.9.7 (popup ↔ worker build handshake); guard was lost in the v0.12.0 rewrite and **re-added in v0.12.2** (handshake + injector cache-schema tripwire)

## Symptom

Popup shows:

```
Sync failed: Adjust API failed: 401 —
{"error_code":"auth_error","error_desc":"It is impossible to check account ownership!","correlation_id":"…"}
```

It reads like a bad API token, a revoked token, or the known cookie-vs-token
mismatch that `credentials: 'omit'` exists to prevent
(see the header comment in [src/adjust-client.js](../../src/adjust-client.js)).

## Actual cause

**The popup and the service worker were running different builds.**

Chrome re-reads `popup/popup.html` + `popup/popup.js` **from disk every time the
popup opens**. The service worker is replaced **only when the extension is
reloaded** (`chrome://extensions` → Reload). So after editing code, the popup is
already new while the worker is still old — and nothing in the UI says so.

In v0.9.7 that combination is silently fatal: the new popup writes
`dataSourceConfig.accounts[]` and no longer writes the legacy
`dataSourceConfig.apiToken`. The old worker reads `cfg.apiToken`, gets
`undefined`, and sends `Authorization: Bearer undefined`. Adjust answers 401
`auth_error`.

## The tell

**The error message had no account-label prefix.** Since v0.9.7 every request
label is prefixed with the Adjust account (`Adjust 1 · Adjust API failed: …`,
see `labelFor()` in adjust-client.js). A bare `Adjust API failed: …` therefore
proves the request was built by pre-v0.9.7 code — the popup and the worker
disagree.

## Guard added

`background.js` answers a `GET_BUILD` message with `WORKER_BUILD`; the popup
compares it against its own `POPUP_BUILD` on open **and before every sync**. On
mismatch it takes over the error box with a reload instruction and refuses to
sync — syncing cannot fix a stale worker, and letting it run would overwrite an
accurate diagnosis with a misleading auth error. A worker old enough not to know
`GET_BUILD` falls through to the `default` case and answers with an error, which
counts as a mismatch too.

Both constants must be bumped together on every release. The service worker also
logs `service worker vX.Y.Z started · cache schema vN` as its first console line
after a reload.

## How to apply

- After ANY change to `background.js`, `src/*.js`, or `content/*.js`: reload the
  extension. Popup-only changes are the sole exception, and that exception is
  exactly what makes this trap convincing.
- If an auth error appears immediately after a code change, check the build
  banner / the worker's first console line **before** touching tokens.
- Related: [debug_trap_app_token_missing.md](debug_trap_app_token_missing.md)
  (0 matches → check app tokens first) and
  [feedback_force_refresh_after_code_change.md](feedback_force_refresh_after_code_change.md)
  (the 5-minute cache survives an extension reload).

## Second sighting — 2026-09-18 (no auth error this time)

The v0.12.0 pull replaced the v0.9.x line (new `src/accounts.js`, merge in
the worker) and **dropped the handshake**. The user's Chrome kept running the
v0.9.8 worker while popup + injectors read v0.12.1 from disk. Nothing errored:

- Popup header said `v0.12.1` (it reads `chrome.runtime.getManifest()`, and the
  manifest IS re-parsed on browser restart — the cached worker script is not).
- Popup warning box showed `⚠ 564 entity xuất hiện ở NHIỀU Adjust account …
  bị cộng dồn` — wording that exists **only in the stashed v0.9.8
  data-source.js** (`git stash list` → `wip-v0.9.8-superseded-by-v0.12.0-pull`).
  A warning string you cannot `grep` in the working tree is the definitive tell.
- Meta pills on the Video Downloader campaigns (an app live in BOTH Adjust
  accounts) showed the `[JM]` twin's 0% cohort ROAS and a doubled D-2 spend,
  while Adjust 1's Datascape showed 125% ROAS for the same campaign.

Mechanism: the old worker never merged cross-account rows; the new injector
expects merged rows, so it indexed both twins — campaign level last-write-wins,
`bumpToday` summed the D-1/D-2 spend.

## Guard as of v0.12.2

- `background.js` `WORKER_BUILD` ↔ `popup/popup.js` `POPUP_BUILD` via
  `GET_BUILD`, checked on popup open **and before every sync**; on mismatch the
  popup takes over the error box and refuses to sync.
- Every `content/*-injector.js` has `EXPECTED_CACHE_SCHEMA` and refuses a cache
  whose `schemaVersion` differs (banner: "Service worker đang chạy build cũ …
  Reload"). No pills beat wrong pills.
- The worker logs `service worker vX started · cache schema vN` as its first
  line after a reload.

**Release checklist:** bump `manifest.json` version, `WORKER_BUILD`,
`POPUP_BUILD`, `CACHE_SCHEMA_VERSION` (when the shape or pipeline changes) and
every injector's `EXPECTED_CACHE_SCHEMA` + `INJECTOR_VERSION` together, then
Reload the extension and Force refresh.
