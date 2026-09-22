# Day-ROAS pill: why its three denominators come from two different places

Shipped v0.9.6 (Meta injector `v0.9.6-day-roas-pill`, TikTok `v0.5.4-day-roas-pill`,
`CACHE_SCHEMA_VERSION = 9`).

## What the pill is

One compact pill rendering same-day ROAS for three consecutive days:

```
T:82%  D-1:91%  D-2:71%
```

Every segment is **revenue of that day ÷ spend of that day** (event-date). It is
explicitly **not** the cohort pill's `D0 3d 7d All`, which follows a single day's
install cohort forward as it matures. The two answer different questions and will
not agree — see [today_pill_vs_adjust_ui_metric_diff.md](today_pill_vs_adjust_ui_metric_diff.md)
for the same trap in the other direction.

## The constraint

Adjust's **event-date report rejects `cost`** — `cost`, `currency`, `all_revenue`
and `network_revenue` all return HTTP 400 "Unsupported metric" (verified
2026-05-11, encoded at `src/adjust-client.js` in `fetchGrossRevenue`'s comment
block). So a same-day ROAS always needs its denominator from somewhere else:

- the **cohort report**, which does expose `cost` (`ad_spend_mode=network`) and
  accepts an explicit `YYYY-MM-DD:YYYY-MM-DD` single-day range; or
- the **ads-manager DOM**, scraping Meta's "Amount spent" / TikTok's "Cost" cell.

## The decision, per segment

| Segment | Denominator | Why |
|---|---|---|
| `T` (today) | ads-manager DOM cell | The day is still open. Adjust's cohort `cost` lags intraday, so the UI cell is the only trustworthy live spend. |
| `D-1` (yesterday) | Adjust cohort `cost`, single-day range | Day is closed, so cost is settled. Crucially this needs **no DOM capture**, so the segment works without the user parking the date picker on "Yesterday". |
| `D-2` | Adjust cohort `cost`, single-day range | Same as D-1. Already how the standalone D-2 pill worked. |

**Consequence to remember: `D-1` and `D-2` are apples-to-apples; `T` is the odd
one out** and can sit slightly off the other two even on a flat day, because it
divides by Meta/TikTok's own spend figure rather than Adjust's network cost.

This also means the day-ROAS pill's `D-1` and the standalone **Yesterday pill's
percentage can legitimately differ** — the Yesterday pill divides by the
DOM-captured Meta spend (what the user literally sees in the UI), the day-ROAS
pill divides by Adjust's cost. Neither is wrong. Check which pill you're reading
before filing it as a bug.

## Date alignment

D-1 revenue uses Adjust's `date_period=yesterday` keyword while D-1 cost uses an
explicit range from `isoDateDaysAgoAtOffset(1, utcOffset)`. These resolve to the
**same calendar day** — that helper shifts the epoch by the reporting offset and
reads UTC components, which is the arithmetic Adjust applies to `yesterday`
itself. If that ever drifts, D-1 silently divides two different days.

## Error contract (inverse of D-2)

`fetchYesterdayGrossRevenue` fetches revenue and cost via `Promise.allSettled`:

- **revenue rejection rethrows** — the standalone Yesterday pill is revenue-driven
  and must keep working exactly as before.
- **cost rejection is swallowed** (logged, `costYesterday: null`) — its absence
  only costs the day-ROAS pill's D-1 segment, which then renders `–`.

`fetchD2GrossRevenue` is the mirror image: cost required, revenue best-effort.
Do not "unify" these; the asymmetry is deliberate.

## Null is never zero

A missing cost must stay `null` all the way through
`mergeRealtimeInto` → `bumpToday` → `ratioOrNull`. Coercing it to `0` would either
divide by zero or read as a real free-spend day. Revenue keeps 0-on-match
semantics because "earned nothing" is meaningful; **denominators do not**.

## Cost

Turning the pill on funds both the yesterday and D-2 fetches (see
`createDataSource`), and the new D-1 cost call adds ×3 report requests (one per
level). Full tilt is now ~18 parallel reports, which is why the ≤3 concurrency cap
and retry/backoff from [adjust_500_concurrency_retry.md](adjust_500_concurrency_retry.md)
matter more than before, not less.

## Debugging

`logDomDiagnostics()` prints a `dayRoas` checklog block in both injectors. It
reports `campaignRowsCarryingField` counts, so a dashed segment immediately
separates an **upstream** cause (field absent on every row → fetch didn't run or
failed) from a **per-row** one. If `costYesterday` is `0/N`, hit Force refresh —
the 5-min cache survives an extension reload
([feedback_force_refresh_after_code_change.md](feedback_force_refresh_after_code_change.md)).

`rowsConsidered` vs `pillsRepainted` in that block are deliberately different
numbers: the segment-miss counters and the banner's "missing on every row" test
run **before** the dedup return, so they cover every visible row, not just the
ones that happened to repaint that pass. Any new per-pass counter here must go
above the dedup return for the same reason.

A D-1 **cost** failure is swallowed by design (the Yesterday pill only needs
revenue) but is reported through `onWarning` → the data source's `warnings[]` →
the banner's `⚠ Partial sync` line. If D-1 dashes everywhere and that line is
absent, the cost call succeeded and returned nothing — a different problem from a
failed call.

## Traps hit while building this

- **`appendSegment` is per-injector.** The two content scripts are separate IIFEs
  on different hosts and share no scope, and their segment markup differs
  (`meta` flat, `tiktok` `.adjust-pill-seg`/`-label`/`-value`). Calling one from
  the other throws `ReferenceError` out of the `forEach` in
  `decorateAllVisibleRows`, leaving **every later row completely undecorated** —
  and because the dedup `set` happens after the throw, it never self-heals. Any
  helper used by a pill must be defined in that injector's own file.
- **The cohort-pill sibling guard must exclude every realtime variant.** It used
  to spell out `!isTodayVariantPill && !isYesterdayVariantPill`, so with cohort +
  today + yesterday all off it mistook the D-2 pill for the cohort pill and
  removed it every pass while its dedup map still claimed "current" — permanently
  invisible. Now `isRealtimeVariantPill()` covers all four.
