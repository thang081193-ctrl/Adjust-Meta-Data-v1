# Perf: the decorate pass fed its own MutationObserver (fixed v0.12.5)

**Status:** fixed 2026-09-22 in v0.12.5 · affected **all three** injectors (Meta, TikTok, Google)

## Symptom

"Extension đang khá nặng, load bị lag cả Chrome." No error, no warning banner,
no single slow call in a profile — just a permanent tax on every open ads tab,
worst on Meta (biggest DOM), and present even on a tab sitting completely idle
with nothing being scrolled or clicked.

## Root cause

`decorateAllVisibleRows()` ends with `showBanner(buildBannerText(), …)`, and
`showBanner` did an unconditional

```js
panel.textContent = text;
```

`textContent =` **removes the existing text node and inserts a new one**. The
banner lives in `document.body`, and every injector observes

```js
bodyObserver.observe(document.body, { childList: true, subtree: true /*, characterData */ });
```

So: decorate → banner rewrite → childList mutation → `scheduleDecorate()` →
200 ms later another decorate → banner rewrite → … **forever**. A self-feeding
loop at ~5 passes/second per ads tab, which never settles because the thing
that triggers it is the pass itself.

Each of those passes was not cheap:

| injector | per-pass cost before the fix |
|---|---|
| Google | 4 full DOM walks (`pickNameCandidates`, `detectGoogleDateInfo`, `locateCostColumn` ×2, `ensureRowYBuckets`) + `getBoundingClientRect()` on every leaf |
| TikTok | 3 scoped walks + rect per leaf |
| Meta | 2 full-document walks (`locateAmountSpentColumn`, `ensureRowYBuckets`) + rect per leaf, on the largest DOM of the three |

Pill insertion fed the same loop: appending a pill to `document.body` (Google,
TikTok) or next to the name cell (Meta) is also a `childList` mutation inside
the observed subtree.

Why it never showed up as a long task: one pass is only a few ms on Google's
small (~3 k node) virtualized DOM, well under the 50 ms `longtask` threshold.
It is the **5×/second forever, on every tab, times three injectors** that is
felt, not any single pass.

## Fix (v0.12.5)

1. **Own-node cutout in the observer** — the real fix. Each injector now skips
   mutation records that it caused itself:
   - target (or its parent) inside `.adjust-pill` / `#adjust-overlay-banner`
   - `childList` records whose added+removed nodes are *all* our own elements

   Every pill class constant starts with `adjust-pill` (verified across all
   three files), so the class test is complete.
2. **`showBanner` is idempotent** — early-returns when `(text, level)` is
   unchanged, via `banner._aoxText` / `_aoxLevel`. Second line of defence, and
   it also stops the banner re-rendering on passes where nothing changed.
   *Note:* this alone would NOT have fixed it — `buildBannerText()` embeds
   `synced Nm ago`, so the text genuinely changes once a minute, and the
   loop would restart each time.
3. **Decorate runs in idle time** — `scheduleDecorate` debounce 200 → 300 ms,
   then `requestIdleCallback(run, { timeout: 400 })`. A `decoratePending` flag
   stops a second pass queueing behind the idle callback.
4. **rAF reposition loop parks itself** (Google + TikTok) — it used to re-arm
   unconditionally for the life of the tab, calling `getBoundingClientRect()`
   on every pill cell every frame (a forced style+layout flush at 60 Hz) while
   nothing was moving. Now `RAF_IDLE_FRAMES = 45` (~0.75 s) of "nothing moved"
   parks it; scroll (capture, passive), resize, any decorate pass, and
   `visibilitychange` wake it again.
5. **One leaf walk per pass** (Google) — `allLeaves()` / `scopedLeaves(scope)`
   produce `(el, text)` pairs once per pass and every scan filters that array.
   Per-scan `getBoundingClientRect()` calls are unchanged, so each scan sees
   exactly the geometry it saw before.

## Verified (2026-09-22, ads.google.com/aw/campaigns, Jelly - Chatbot 2)

Idle tab, 8 s window, after the fix:

```
pillStyleWrites: 0   bannerPanelMutations: 0   otherPageMutations: 0
longTasks: 0         pills: 12 (stable)
```

Before the fix the same window showed continuous banner-panel churn.

## Trap for next time

Do **not** measure this with `PerformanceObserver({entryTypes:['longtask']})`
— each pass is under the 50 ms threshold, so the loop is invisible there.
Measure it by observing our own banner panel:

```js
const panel = document.querySelector('#adjust-overlay-banner .adjust-banner-panel');
let n = 0;
new MutationObserver(r => n += r.length).observe(panel, { childList: true, characterData: true, subtree: true });
setTimeout(() => console.log('banner mutations in 8s:', n), 8000);
```

On an idle, fully-painted tab this must be **0**. Anything above ~1 per minute
means a decorate loop is running again.

Related: [[storage_quota_cache_size]] (the payload that made every GET_CACHED
expensive), [[perf_get_cached_channel_scope]].
