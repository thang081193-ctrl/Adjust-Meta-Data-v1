# Debug trap: popup stuck on "Loading…" = popup.js never parsed

**Date:** 2026-09-21 · **Found in:** v0.12.2 · **Fixed in:** v0.12.3

## Symptom

Popup opens and paints its static HTML, but:

- status line stays on the literal `Loading…` from `popup.html` forever
- **Adjust account dropdown is completely empty** — not "1 account", *zero options*
- the `Adjust accounts` cards under Settings are empty too
- **no version stamp next to the "Adjust ROAS Overlay" title**
- no error box, no banner, nothing in the *page* console

This reads exactly like "the Adjust API isn't answering" or "the service worker
is down", and that is the trap: it sent the first investigation at the network
layer, at `GET_CACHED`, and at the app-token list. None of those were involved.

## Cause

`popup/popup.js` had this inside `checkWorkerBuild()`:

```js
$('error').textContent =
  `⚠ Service worker đang chạy build ${worker}…
` +
  'Chrome chỉ nạp lại service worker khi RELOAD extension — …
' +
```

A **single-quoted** string cannot contain a raw newline. Template literals
(backticks) can, which is why the first segment was fine and the next two were
a `SyntaxError: Invalid or unexpected token`.

`popup.js` is loaded as `<script type="module">`. **A module with a parse error
does not run at all** — not the broken function, not the top-level event
listeners, not `bootstrap()`. So `$('ver').textContent = POPUP_BUILD` never ran
and `renderAccountPicker()` never ran. The dropdown was empty because nothing
ever put an option in it.

### The tell

**Missing version stamp next to the title.** It is the first statement of
`bootstrap()`. Blank `ver` + "Loading…" ⇒ the module did not execute ⇒ look at
the *parser*, not at the data. Confirm in the popup's own devtools
(right-click the popup → Inspect → Console), which is a different console from
the page's and is the only place the SyntaxError appears.

## The trap inside the trap

`node --check` **does not catch this** on a `.js` path:

```
node --check popup/popup.js           -> exit 0   WRONG
node --input-type=module --check < popup/popup.js  -> exit 1   correct
```

Plain `node --check` parses the path as CommonJS first, and its ESM fallback
swallows the error. An all-green `node --check` sweep is what made the first
pass conclude "syntax is fine, must be the worker". Always pipe via stdin with
`--input-type=module`.

## Guard (v0.12.3)

```bash
node docs/diagnostics/syntax-check.mjs
```

Parses every shipped `.js` with the stdin/ESM form and exits 1 if any fail.
Run it before any reload after touching popup/background/injector code.

Two code-level guards also landed in v0.12.3:

1. The message block is now four template literals with explicit `\n` escapes,
   and `.err` got `white-space: pre-line` so those breaks actually render.
2. `bootstrap()` no longer dies on a failed IPC: `refreshStatus()` gets a
   `.catch()` so a dead/restarting service worker can't take the account picker
   down with it, and the IIFE has a terminal `.catch()` that writes the error
   into the error box. A *runtime* throw can no longer produce a blank popup —
   only a parse error can, and that is what the diagnostic covers.

## Related

- `debug_trap_stale_service_worker.md` — the *other* reason the popup lies
  about state. Note the interaction: the block that broke here is the stale-
  worker warning itself, so the v0.12.2 tripwire took out the popup it was
  written to protect.
- `debug_trap_app_token_missing.md` — "0 matches" with a *rendered* popup.
  Distinct symptom: there the UI works, here the UI never built.
