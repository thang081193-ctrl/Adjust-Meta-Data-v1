---
name: Today-pill requires Meta UI date filter = Today (follow-up needed)
description: Active known-issue with the Today-ROAS pill shipped in PR #1 (commit bc551ac). The pill's denominator (Meta spend cell) reflects whatever date filter Meta UI has active. Pill is only correct when Meta UI is on "Today"; otherwise the ratio is meaningless. Detection logic NOT yet implemented.
type: project
---

# Today-pill: detect Meta UI date filter (follow-up)

The Today-ROAS pill (shipped 2026-05-11, PR #1, commit `bc551ac`) computes:

```
Today ROAS = Adjust event-date revenue (TODAY, fixed)
             ─────────────────────────────────────────
             Meta UI "Amount spent" cell value
```

The denominator is read directly from Meta Ads Manager's spend column, which reflects whatever date filter the user has active in Meta UI (the "Yesterday: May 9, 2026" picker at top-right of the table). If the user has it set to Yesterday, Last 7d, or any custom range that isn't today, the ratio is wrong — Adjust today rev / Meta yesterday spend = meaningless.

**Why:** User flagged 2026-05-11 after PR merge: they had to click "Today" in Meta UI for the pill to be meaningful. Initial misread as the extension popup's period buttons; actual issue is the Meta Ads Manager UI date picker.

**How to apply:** Next session, implement Meta-UI-date detection. Specifically:

1. In `content/meta-injector.js`, add `detectMetaUiDateIsToday()` that reads `window.location.search`:
   - `date_preset=today` → today
   - `date=YYYY-MM-DD_YYYY-MM-DD` where start == end == today's local date → today
   - Otherwise → not today
2. In `maybeRenderTodayPill`, branch on the detection:
   - **If today**: render normally (current behavior — `Today: rev/spend NN%`).
   - **If not today**: render warning variant. Options:
     - (a) Hide pill entirely + add banner line "Today ROAS hidden — Meta UI not on Today"
     - (b) Show pill with rev only + dash for ratio: `⚠ Today rev: $X.XX (Meta on <date>)`
     - Recommend (b) — keeps pipeline-state-visible feedback rule from [feedback_show_pipeline_state.md](feedback_show_pipeline_state.md).
3. Re-detect on URL change (Meta SPA-navigates without full reload). MutationObserver doesn't cover URL — add a `popstate` listener or poll `location.search` once per decorate pass.

**Where to look:** `content/meta-injector.js` `maybeRenderTodayPill` function. Reuse the existing banner/tooltip patterns.

**Related:** Updated [meta_spend_column.md](meta_spend_column.md) "Known limitations" section with the same note on 2026-05-11.
