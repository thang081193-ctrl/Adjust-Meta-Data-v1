# Google Ads: the table can take 2+ minutes to paint — pills are gated on it

**Observed:** 2026-09-22, `ads.google.com/aw/campaigns`, account
Jelly - Chatbot 2 (846-635-2143), view "All campaigns · 2 filters · 725 campaigns"

## Symptom

"Google Ads đã load, nhưng không show pills." The page chrome is fully painted
— account switcher, nav, the "2 filters · 725 campaigns" label, the date-range
control — so the page *looks* loaded. No pills appear.

## What is actually happening

The Google Ads shell paints long before the campaign table does. Measured on
this account:

| t | `document.querySelectorAll('*').length` | pills |
|---|---|---|
| shell painted | 640 – 807 | 0 |
| ~40 s – 2 min later | ~2 300 – 3 200 | 12 → 20 |

Two runs took ~40 s; two took **over two minutes**, and during the slow ones a
CDP `Runtime.evaluate` against the tab timed out at 45 s because the renderer
was saturated. Nothing about this is the extension: Adjust data was already
loaded and indexed the whole time (banner read
`2429 campaigns / 4969 ad groups / 5 ads`), there was simply **no row in the
DOM to decorate**.

`pickNameCandidates()` only returns elements whose text canonical-matches an
indexed Adjust name, so with no table there are no candidates, and with no
candidates there are no pills. Working as designed — the extension just had to
survive the wait.

## Why v0.12.4 sometimes never recovered

The cold-start retry loop was `setInterval(…, 2000)` × `MAX_RETRIES = 15` — a
**30-second** budget. On this view it expired while the DOM was still ~800
nodes. After that the only remaining path to a first paint of pills was a
MutationObserver record arriving later — which normally happens, but leaves the
first paint dependent on timing rather than guaranteed.

## Fix (v0.12.5)

`MAX_RETRIES = 40` with backoff: the first `FAST_RETRIES = 15` ticks stay at
2 s, the remaining 25 go to 5 s → ~2.5 minutes of cover, cheap in the tail. The
loop stops on the first tick where `hasLivePills()` is true and hands over to
the observer.

## Verified after the fix

Same view, park-on build, measuring every visible pill against the row leaf to
its left:

```
before scroll     pills 8  onRow 8  orphan 0
after scroll down pills 18 onRow 18 orphan 0
after scroll up   pills 8  onRow 8  orphan 0
```

## Trap when debugging this

Do **not** conclude "no pills = broken matcher" from a screenshot. Check the
DOM size first:

```js
document.querySelectorAll('*').length   // < ~1000 → the table has not painted yet
document.querySelectorAll('.adjust-pill').length
document.getElementById('adjust-overlay-banner').textContent
```

If the banner reports non-zero campaign/ad-group counts, the Adjust side is
healthy and you are waiting on Google, not on us. Also beware transient
mid-scroll states: measuring pill alignment while the virtualiser is still
settling produces phantom "drift" that is gone a second later — compare each
pill against the nearest **leaf to its left on the same Y**, not against an
arbitrary `<a>`.

Reducing the view (fewer filters, fewer campaigns per page) is the only thing
that makes the table paint faster; it is entirely Google-side.

Related: [[perf_decorate_self_feedback_loop]], [[google_ads_channel]],
[[debug_trap_app_token_missing]].
