# Meta horizontally-virtualizes data cells

Meta Ads Manager doesn't render row-level cell DOM for columns scrolled out
of the horizontal viewport. The header bar keeps all column headers in DOM
(off-viewport but width > 0), but data cells per row only exist for columns
currently within the visible viewport range.

**Why this matters:** the today-pill reads spend by walking row-Y-bucketed
candidates and picking the one nearest the Amount-spent header's X position.
When the column is scrolled off-screen:

- The header element is still in DOM, so `currentSpendColumn` is non-null and
  `headerX` is preserved.
- BUT no row-level data cell exists at that X for any row → `findSpendCellText`
  returns `null` for every row in the pass.
- Before v0.6.2: `maybeRenderTodayPill` would fall through to "spend null"
  state, but the previous pass's pill DOM was never cleaned up because the
  early-return at `if (!currentSpendColumn) return;` doesn't fire here
  (column header IS detected). Effect: stale pill text from a prior pass
  (or a prior scroll state) sits on the row showing wrong numbers.

**Observed 2026-05-12:** user reported a row whose pill said
`Today: 0.88/0.40 221%` while the Amount-spent column (when scrolled into
view) actually showed `$2.17`. Scrolling the column back into view triggered
a new decorate pass that read the real cell, and the pill refreshed to the
correct value.

**Fix (v0.6.2-column-virt-aware):**
- Added `isSpendColumnInViewport()` helper that checks the header's bounding
  rect against `window.innerWidth`.
- New off-column variant in `maybeRenderTodayPill` runs AFTER the off-date
  check (off-date is the dominant state — ROAS is already meaningless if
  Meta UI is on a non-Today range, regardless of column visibility).
- Off-column pill renders rev-only with text:
  `⚠ Today rev: $X.XX (scroll Amount spent into view)`
  Tooltip explains the virtualization and the fix.
- Stale-pill cleanup classList check now includes `adjust-pill-today-offcolumn`
  in BOTH the off-date and normal branches, so transitions between any pair
  of variants don't leave a leftover sibling.
- Diagnostics counter: `pillsRenderedOffColumn` in `lastTodayStats`.

**Pattern reuse:** identical visual style (`background #fff3e0`, dashed amber
border) to off-date variant — both are "warn, rev-only" states. Separate
class names so the rendered text and dedup key can diverge.

**TikTok status:** unverified. TikTok uses `<ks-virtual-table>` whose
horizontal virtualization behavior may differ. Don't assume parity; verify
with a similar repro on TikTok Ads Manager before porting the fix.
