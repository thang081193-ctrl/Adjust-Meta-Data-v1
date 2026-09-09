---
name: D-2 pill pipeline — why it showed "chưa có dữ liệu" on every row
description: Three independent defects that each made the D-2 pill look dead, and how v0.10 fixes them. Read before touching the D-2 fetch or the Meta cohort-pill DOM guards.
type: project
---

# D-2 pill — three defects, one symptom

**Date:** 2026-09-01 · **Fixed in:** v0.10.0 (meta `v0.10.0-multi-account-d2-fix`, tt `v0.6.0-multi-account-d2-fix`, cache schema v9)

The D-2 pill (added v0.9.4) rendered `D-2: –/– — chưa có dữ liệu` on every row,
or vanished entirely. Three unrelated causes produce that same symptom, which is
why it read as "the feature doesn't work" rather than as any one bug.

## 1. A spend-side failure killed the whole pipeline

`fetchD2GrossRevenue` fetched revenue (event-date report) and spend (cohort
report) with `Promise.allSettled`, then did:

```js
if (costRes.status === 'rejected') throw costRes.reason;   // ← whole pill dead
```

Spend was **required**. Any rejection on that side — a 500, a 60s abort — threw,
`d2Available` stayed false in `data-source.js`, and every row got
`revenueD2 = null, costD2 = null`. Every pill on the page then took the "no data"
branch, indistinguishable from the fetch never having run.

**Fix:** both halves are independently best-effort. A half-failure returns rows
with the working half populated and the other null; the pill shows
`D-2: 30.00/–` plus a `⚠ Thiếu spend` note in the tooltip. Only when **both**
halves fail does `fetchD2GrossRevenue` throw. `data-source.js` tracks
`d2RevAvailable` and `d2CostAvailable` separately so a miss on the working half
still means "genuinely zero" while the failed half stays null.

## 2. The spend half was the heaviest request in the sync

To read `cost`, it called `fetchCampaignROAS` — the **full** cohort report,
`metrics=cost,roas_d0,roas_d3,roas_d7,cohort_all_revenue,installs`, at three
grouping levels. The `roas_dN` columns are cohort metrics: Adjust walks each
install cohort forward N days to build them. All of that was computed and thrown
away; only `cost` was read.

That made D-2 both the most expensive pipeline and the most likely to hit
Adjust's server-side report timeout (see
[adjust_500_concurrency_retry.md](adjust_500_concurrency_retry.md)) — and by
defect #1, its timeout took the pill down.

**Fix:** `SPEND_METRICS = 'cost,installs'` — base (non-cohort) metrics, same
endpoint and params otherwise. Verify with
[`docs/diagnostics/d2-probe.mjs`](../diagnostics/d2-probe.mjs), which requests
both metric sets for the same D-2 day and asserts the `cost` totals match.

## 3. The Meta cohort pill deleted the D-2 pill

`content/meta-injector.js` anchors pills as sibling `<span>`s and identified the
cohort pill by exclusion:

```js
!isTodayVariantPill(n) && !isYesterdayVariantPill(n)   // ← D-2 pill matches this
```

When v0.9.4 added a fourth pill type, all three of those guards started
classifying the D-2 pill **as a cohort pill**. So rebuilding the cohort pill (or
toggling it off) removed the D-2 pill instead — and because `maybeRenderD2Pill`
dedups on an unchanged tag, it was never rebuilt. Turning the cohort pill off,
or any pass where the D-2 pill sat directly after the name cell, silently ate it.

**Fix:** `isCohortPill()` matches the cohort classes **positively**
(`pause / scale / hold / unknown / ambiguous`). An unknown class is now simply
not a cohort pill, so a fifth pill type cannot repeat this.

TikTok was never affected: `tiktok-injector.js` tracks each pill type in its own
`cellTo*Pill` Map instead of walking siblings.

## How to apply

- **Adding a fifth pill type:** grep `COHORT_PILL_CLASSES` and `is*VariantPill`
  in `meta-injector.js`. Every DOM guard must identify its own type positively —
  never "is not one of the others".
- **Adding a pill that fetches:** it costs 3+ report calls per sync **per Adjust
  account**. Keep the toggle-gated fetch, reuse `fetchAdjustRows` (concurrency
  gate + retry), and ask for the narrowest metric set that answers the question.
- **Diagnosing "chưa có dữ liệu":** hover the pill first. v0.10 puts the actual
  Adjust error in the tooltip when `syncWarnings` contains a D-2 entry, and names
  the D-2 calendar date so you can check the same day in Datascape. If the
  tooltip says the row simply has no data, run `d2-probe.mjs` for that account.
- **Never collapse a failed fetch to 0.** `null` = "no answer", `0` = "the answer
  was zero". Conflating them renders a fabricated red 0% ROAS that looks like
  real data. See [feedback_show_pipeline_state.md](feedback_show_pipeline_state.md).
