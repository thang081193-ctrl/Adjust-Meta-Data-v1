---
name: TikTok Today data pill — implementation handoff
description: Active follow-up. Meta side has Today pill working (rev/spend ratio, off-date detection). TikTok side does NOT yet have Today pill. This doc captures what's needed to ship symmetric behavior on TikTok, with design decisions, file pointers, and the constraints already mapped from the Meta build.
type: project
---

# TikTok Today data pill — implementation handoff

**Status (2026-05-11):** not started. Meta side fully shipped + verified (v0.6.1 in main as of commit `3d0458d`). All other extension features complete; Today pill on TikTok is the last piece to reach feature parity.

**Why:** Meta gets a `Today: rev/spend NN%` pill that shows realtime ROAS using Adjust today event-date revenue ÷ Meta UI's "Amount spent" cell. TikTok has the same use case but currently shows only cohort pills (`D0/3d/7d/All`), missing the today-realtime signal.

## What already works (reusable)

The data pipeline and most rendering logic is already shared:

- **Adjust today fetch:** `fetchTodayGrossRevenue` in [src/adjust-client.js](../../src/adjust-client.js) already pulls `revenue + ad_revenue` event-date for today, returns rows with `revenueToday` + `currency` per ad/campaign. Currently consumed only by Meta side. Same data is available for TikTok.
- **Today data merge:** [src/data-source.js](../../src/data-source.js) `mergeTodayInto` joins today rows into cohort rows by ID then name. Output rows already carry `revenueToday`, `todayRowExisted`, `adjustCurrency`. **TikTok injector reads the same cache** (filtered by `network.startsWith('TikTok')`) — fields are already there, just unused.
- **Color thresholds + currency parser:** Reuse from Meta side ([content/meta-injector.js](../../content/meta-injector.js) `parseCurrencyCell`, `formatMoneyOrDash`, `formatTodayTooltip`).

## What's TikTok-specific (must build)

### 1. Locate the "Cost" column

Meta uses `locateAmountSpentColumn()` — scans `*` for header text matching multilingual `SPEND_HEADER_KEYS` (English "Amount spent", Vietnamese "Số tiền đã chi", etc.). On TikTok the column header text is **"Cost"** (verified from screenshots: `Cost` column shows `24.92 USD`, `62.80 USD`).

**Plan:** add `TIKTOK_COST_HEADER_KEYS` set with `cost` (English), `chi phí` (Vietnamese), and other locales as discovered. Reuse the same scan + truncation-tolerance pattern from Meta. Selector scope can be narrower than `*` since TikTok uses `<ks-virtual-table>` — investigate whether `[class*="ks-table-header"]` or similar narrows safely. Fall back to broad scan if narrower selectors miss.

### 2. Per-row spend cell extraction

Meta uses Y-bucket index + ±40px X tolerance to find the spend cell sharing the row's Y. **TikTok DOM is structured differently** — rows are inside `<ks-virtual-table>` with cells that have their own React props carrying row identity. The row layout still aligns visually by Y, so the same Y-bucket approach should work, but selector for "leaf cell" candidates needs adjustment.

**Plan:**
- Investigate TikTok's cost cell DOM: open Cost cell in DevTools, find a stable selector (likely a class like `[class*="cl-"]` or `[class*="cell"]`).
- Build TikTok Y-bucket index over those selectors.
- Reuse Meta's `parseCurrencyCell` for the actual number parse — currency parser is locale-aware and handles all the same edge cases (zero-decimal currencies, abbreviated values, etc.).

See [meta_spend_column.md](meta_spend_column.md) for the full Meta strategy + rejected approaches (child-index, aria-colindex). Same constraints apply to TikTok.

### 3. Pill placement

Meta inserts the today pill as a **sibling** next to the main pill (`mainPill.nextSibling`). On TikTok the main pill is **`position: fixed`** and tracked via `cellToPill` Map (because `<ks-virtual-table>` clips siblings — see [tiktok-injector.js](../../content/tiktok-injector.js) line 105-110).

**Plan:**
- The today pill must ALSO be `position: fixed` and tracked separately in a `cellToTodayPill` Map (parallel to `cellToPill`).
- Position: anchor to the same row as the main pill, but offset to the right of the main pill (e.g. `mainPill.right + 6px`).
- Reposition loop: integrate into existing `repositionLoopTick` so today pills follow scroll same as main pills.
- Cleanup: when cell disconnects, remove BOTH main pill and today pill.

### 4. Off-date detection

Meta detects `date_preset=today` or `date=YYYY-MM-DD_YYYY-MM-DD,today` from URL — see [meta_url_date_param_format.md](meta_url_date_param_format.md). **TikTok URL format is different** and needs investigation:

Observed URL from current session: `ads.tiktok.com/i18n/manage/campaign?aadvid=...&st=2026-05-04&et=2026-05-11`

Looks like TikTok uses `st` (start date) + `et` (end date) as separate params, format `YYYY-MM-DD`. No preset keyword observed. So detection logic:
- Parse `st` and `et` from URL.
- If both equal browser-local today's date → `isToday=true`.
- Otherwise → off-date variant (rev-only pill with date label).

**Plan:** add `detectTikTokDateInfo()` in tiktok-injector.js. Reuse the same off-date render variant pattern from Meta (`adjust-pill-today-offdate` class already exists in CSS). Reuse banner priority chain logic.

### 5. Banner integration

Meta `buildBannerText()` adds today-pill diagnostic lines (column-missing, off-date, currency-mismatch, abbreviation). TikTok banner needs the same.

## Files that will change

- `content/tiktok-injector.js` — add column locator, spend-cell finder, today pill render, date detector, banner additions, `cellToTodayPill` Map
- `src/data-source.js` — no change needed (already produces `revenueToday` for TikTok rows)
- `src/adjust-client.js` — no change needed (already fetches today rev for all networks)
- `content/meta-injector.css` — likely no change (today pill classes already defined)
- `manifest.json` — no change

## Constraints inherited from existing findings

- **Spend column must be visible** — same as [meta_column_preload.md](meta_column_preload.md). Banner must surface `⚠ Today ROAS disabled — enable "Cost" column` if header not found.
- **Cross-currency refusal** — same as Meta. Don't divide USD revenue by VND spend; render mismatch variant.
- **Always render pipeline state** — per [feedback_show_pipeline_state.md](feedback_show_pipeline_state.md). When spend or rev missing, render `Today: –/0.76` style instead of hiding.
- **Cohort pill ≠ Today pill metric** — per [today_pill_vs_adjust_ui_metric_diff.md](today_pill_vs_adjust_ui_metric_diff.md). Today uses event-date `revenue+ad_revenue`; cohort pills use `cohort_*_revenue`. Numbers won't match Adjust UI's "All revenue (cohort)" column — that's by design.

## Test plan (after implementation)

1. Reload extension, F5 TikTok tab, popup → Force refresh.
2. Verify today pill renders next to main pill on a row with active spend today.
3. Switch TikTok UI date picker between Today / Yesterday / Last 7d → pill must flip between blue ratio variant and amber off-date variant.
4. Verify cross-currency case if any TikTok account is in USD while Adjust app is in VND.
5. Disable Cost column in TikTok view → banner must show "enable Cost column" message; today pill must disappear.

## Verification snippet (paste in extension isolated-world console)

After implementation, this snippet (similar to perf verification one) confirms today pill present + has expected fields:

```js
const todayPills = [...document.querySelectorAll('.adjust-pill-today, .adjust-pill-today-offdate, .adjust-pill-today-mismatch')];
console.log('[AOX-TT TODAY]', {
  count: todayPills.length,
  variants: [...new Set(todayPills.map(p => p.className))],
  sample: todayPills[0]?.textContent,
});
```

## Reference: Meta implementation entry points

When building TikTok version, mirror this structure from `content/meta-injector.js`:

- `locateAmountSpentColumn()` → `locateCostColumn()`
- `findSpendCellText(nameEl)` → `findCostCellText(nameEl)` (using TikTok Y-buckets)
- `maybeRenderTodayPill(nameEl, mainPill, data, mainKey)` → similar but inserts via `cellToTodayPill` Map (fixed position) instead of sibling
- `detectMetaUiDateInfo()` → `detectTikTokDateInfo()` (parse `st`/`et` URL params)
- `lastTodayStats` → add same shape to TikTok diagnostics

Keep the WHY-comments style matching the existing tiktok-injector.js — it's the convention this codebase uses.
