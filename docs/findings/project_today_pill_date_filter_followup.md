---
name: Today-pill Meta UI date filter detection (implemented 2026-05-11, pending user verification)
description: Detection logic added in injector v0.5.0-today-meta-date-detect on 2026-05-11. When Meta UI date != Today, today-pill renders a warn variant (rev only, dashed amber) instead of dividing by spend that reflects some other date range. Banner surfaces a one-line guidance message. Awaits user verification on real Meta accounts.
type: project
---

# Today-pill: detect Meta UI date filter (implemented, pending verification)

**Status (2026-05-11):** implemented in injector `v0.5.0`, fixed in `v0.5.1-today-meta-date-preset-suffix` after first user test exposed the `date=...,today` URL format. Awaiting re-verification.

**v0.5.1 fix:** Meta encodes `date=<dateRange>,<preset>` when the user clicks a preset chip (Today, Yesterday, Last 7d, etc). Observed value: `date=2026-05-07_2026-05-08,today` while picker label said "Today: May 10, 2026" — the date range portion was stale from before the user clicked Today, but the `,today` suffix was the active preset. v0.5.0's regex required bare `<range>` and fell through to `isToday: false`, marking every row as off-date even when picker = Today. v0.5.1 splits on `,` and treats the suffix (when present) as the source of truth, matching what Meta's own picker label shows.

The Today-ROAS pill (shipped 2026-05-11, PR #1, commit `bc551ac`) computes:

```
Today ROAS = Adjust event-date revenue (TODAY, fixed)
             ─────────────────────────────────────────
             Meta UI "Amount spent" cell value
```

The denominator is read directly from Meta Ads Manager's spend column, which reflects whatever date filter the user has active in Meta UI (the "Yesterday: May 9, 2026" picker at top-right of the table). If the user has it set to Yesterday, Last 7d, or any custom range that isn't today, the ratio is wrong — Adjust today rev / Meta yesterday spend = meaningless.

**Why:** User flagged 2026-05-11 after PR merge: they had to click "Today" in Meta UI for the pill to be meaningful. Initial misread as the extension popup's period buttons; actual issue is the Meta Ads Manager UI date picker.

## What was implemented

[content/meta-injector.js](../../content/meta-injector.js):

1. `detectMetaUiDateInfo()` reads `window.location.search` and returns `{ isToday, label, source }`:
   - `date_preset=today` → `{ isToday: true, source: 'preset' }`
   - `date_preset=<other>` → `{ isToday: false, label: <preset>, source: 'preset' }`
   - `date=YYYY-MM-DD_YYYY-MM-DD` where start == end == browser-local today → `{ isToday: true, source: 'range' }`
   - `date=...` otherwise → `{ isToday: false, label: '<start>…<end>' or '<single>', source: 'range' }`
   - Neither param present → `{ isToday: false, label: 'unknown', source: 'absent' }` (conservative — Meta default isn't knowable client-side)
2. `currentMetaDate` set per pass in `decorateAllVisibleRows` next to `currentSpendColumn`.
3. `maybeRenderTodayPill` branch when `currentMetaDate.isToday === false`: skip the spend-cell read entirely, render `adjust-pill-today-offdate` (dashed amber, ⚠ prefix) with text `Today rev (CCY): X.XX (Meta on <label>)`, plus a tooltip explaining why ROAS isn't computed and how to fix it. Picked variant (b) per feedback rule from [feedback_show_pipeline_state.md](feedback_show_pipeline_state.md).
4. `buildBannerText` adds an off-date line right after the column-missing line: `⚠ Today ROAS not computed — Meta UI date filter is "<label>". Switch to Today for live ROAS.` Priority order: column-missing > off-date > currency-mismatch > abbreviation.
5. `popstate` listener calls `scheduleDecorate` for browser back/forward (Meta's pushState-driven date-picker change is already caught by the body MutationObserver re-rendering the table).

CSS: `.adjust-pill-today-offdate` added in [content/meta-injector.css](../../content/meta-injector.css) — same amber palette as the ambiguous pill but with a dashed border so it visually scans as "warn, not error".

Diagnostics: `lastTodayStats` adds `metaDateIsToday`, `metaDateLabel`, `metaDateSource`, `pillsRenderedOffDate`, `skippedOffDate`. Logged via `logDomDiagnostics()` `today` block.

## Verification plan (next test)

1. `chrome://extensions` → 🔄 reload extension.
2. F5 the Meta Ads Manager tab.
3. Click extension popup → **Force refresh** (cache invalidation per [feedback_force_refresh_after_code_change.md](feedback_force_refresh_after_code_change.md)).
4. Test cases on Meta Ads Manager:
   - **Date picker = Today** → pill renders blue `Today: rev/spend NN%` (existing behavior).
   - **Date picker = Yesterday / Last 7 days / custom range** → pill renders dashed amber `⚠ Today rev (USD): X.XX (Meta on <label>)`. Banner shows the off-date line.
   - **Switch from Yesterday → Today** → pill flips back to blue without manual reload.
   - **Switch from Today → Yesterday** → pill flips to amber without manual reload.

**Where to look if it doesn't:** `[Adjust Overlay] DOM diagnostics` → `today.metaDateIsToday`, `today.metaDateLabel`, `today.metaDateSource`. If `metaDateSource === 'absent'` on a URL that should have a date param, the picker may not be writing to the URL on this Meta build — fall back to scraping the date-picker element text.

**Related:** [meta_spend_column.md](meta_spend_column.md) "Known limitations" section still flags the underlying constraint; this resolves the action item.
