---
name: Page-world bridge for reading React props
description: Chrome content scripts in ISOLATED world cannot see `__reactProps`/`__reactFiber` expandos that page-world JS attached to DOM elements; a second content script in `world: "MAIN"` is required.
type: finding
---

# Page-world bridge for reading React expando properties

Chrome extension content scripts run in an **ISOLATED** JavaScript world by default. They share the DOM tree with the page, but **not** the JS heap. Properties added to a DOM element by page-world JavaScript — including React's `__reactProps$XXX` and `__reactFiber$XXX` expandos — are **invisible** to isolated content scripts. `Object.keys(domEl)` from the content script will not list them.

This silently broke our row-id disambiguation for ambiguous ad names: the original `findCampaignIdViaReactProps` and `findEntryViaAdjustId` walks compiled and ran without errors, but `Object.keys(el)` never returned a `__reactProps*` key, so the walks always returned 0. The diagnostic counter `resolvedByReactProps` had been zero for the entire history of the extension before this was diagnosed.

## How we proved it

1. A standalone DevTools-Console snippet (page world, run by paste-into-console) walked the same row's React props and found 30+ digit IDs.
2. The same walk re-implemented inside `logDomDiagnostics` (isolated world) returned 0 IDs on the same rows in the same DOM state.
3. Same code, same DOM, different result → world isolation is the only explanation.

## Fix: split into two content scripts

`manifest.json` now declares two `content_scripts` entries on the same matches glob:

```json
{ "js": ["content/page-bridge.js"],   "world": "MAIN",     "run_at": "document_idle" },
{ "js": ["content/meta-injector.js"],                       "run_at": "document_idle" }
```

The page bridge ([content/page-bridge.js](../../content/page-bridge.js)) runs in the page world and can read `__react*` expandos. The injector ([content/meta-injector.js](../../content/meta-injector.js)) stays in the isolated world so it can call `chrome.runtime` for cache/sync. They communicate via a synchronous custom-event protocol on `document`:

```
content (isolated)              bridge (main)
    │                              │
    │  dispatchEvent('aox-set-known-ids', {adIds, adsetIds})
    │ ─────────────────────────────► │  store id sets
    │                              │
    │  dispatchEvent('aox-scan-rows')
    │ ─────────────────────────────► │  walk rows, find hits,
    │                              │  write JSON into
    │                              │  <script id="aox-bridge-data">
    │ ◄───────────────────────────── │  (synchronous return)
    │                              │
    │  read aox-bridge-data        │
    │  textContent                 │
```

Custom events are dispatched synchronously across worlds — by the time `dispatchEvent` returns, the bridge has finished writing. The injector then reads the JSON node directly.

Element references cannot cross JS worlds (structured-clone rejects DOM nodes), so we join rows by `(textContent, roundedY)` instead of element identity. Each hit carries `{t, y, a, s}`: ad name text, rounded Y mid-pixel, matched ad id, matched adset id.

## How to apply

- Any future strategy that needs to read page-attached object properties on DOM elements (React props, React fiber state, MobX observables, jQuery `.data()`, etc.) **must** go through the page bridge.
- Don't add fresh isolated-world `__reactProps` walks "just to try" — they will silently return 0 and look like a depth/key-prefix bug.
- The bridge MUST stay read-only against Meta DOM. The header in [content/page-bridge.js](../../content/page-bridge.js) restates the same Facebook-account safety rules as the injector — keep them in sync.
- The data node is `<script id="aox-bridge-data" type="application/json">`. It is the bridge's own element, appended to `documentElement` — not a Meta-rendered node. We never set attributes on Meta-owned nodes.

## Performance notes

Bridge walks every `div.ellipsis` per `aox-scan-rows`, ~40-50 rows × 300-element cap × prop walk depth 10. Empirically ~10-30 ms per scan on a typical Ads tab, well below the 200 ms decoration debounce. If this ever bites, cache results across MutationObserver ticks rather than re-scanning every decorate pass.
