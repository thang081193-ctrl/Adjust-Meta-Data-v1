---
name: Yesterday pill spend comes from Adjust (v0.12)
description: The D-1 pill's denominator moved from scraped-UI spend to Adjust network cost, sharing the D-2 closed-day engine. UI capture survives only as a fallback.
type: project
---

# Yesterday (D-1) spend from Adjust (v0.12)

**Date:** 2026-09-01 · **Cache schema:** v11 · injectors
`v0.12.0-adjust-yday-spend` (meta/gg), `v0.7.0-adjust-yday-spend` (tt)

## What changed and why

The Yesterday pill used to divide Adjust event-date revenue by **spend scraped
from the ads-manager UI** while the user parked the date picker on "Yesterday"
(the "cần view Yesterday" prompt). Two things made that obsolete:

1. The **D-2 pill proved** Adjust's `ad_spend_mode=network` `cost` is a sound
   denominator for a *closed* day — and yesterday is exactly as closed as D-2.
2. **Google Ads** made the scrape structurally unreliable: views routinely ship
   without a Cost column at all.

`fetchYesterdayGrossRevenue` now returns revenue **and** spend via the shared
closed-day engine `fetchDayRevenueAndSpend` (also used by D-2): event-date
report for revenue + `SPEND_METRICS` cohort-endpoint report for cost, same
`date_period='yesterday'`, joined per row, both halves independently
best-effort (`revOk`/`costOk`). Rows carry `revenueYesterday` + `costYesterday`
(schema v11).

Because both sides come from Adjust, the pill needs **no timezone-window guard
and no cross-currency guard** — numerator and denominator share Adjust's
reporting window and currency by construction. This also removed Meta's
"revenue-only (LA-tz)" yesterday state whenever Adjust spend is present.

## Cost & fallback

Enabling the D-1 toggle now costs **6 report calls per account per sync**
(revenue ×3 levels + spend ×3), up from 3 — same weight as D-2, gated behind
the same toggle. The UI spend-capture machinery (`metaYestSpendCache` /
`ttYestSpendCache` / `ggYestSpendCache`) still runs and still feeds Meta's
LA-tz regime-2 estimate; the yesterday PILL falls back to it only for rows
whose Adjust spend half is null (fetch half-failed → warning names the side).

## Google today pill: no-Cost-column state

Same release: on Google Ads, a view without a Cost column used to render **no
today pill at all** (silent early-return). It now renders the revenue-only
off-date variant `Today rev: X — bật cột Cost` with the fix path in the
tooltip (Columns → Modify columns → Performance → Cost). Today's spend stays
UI-sourced on all platforms — Adjust has no trustworthy intraday cost.
