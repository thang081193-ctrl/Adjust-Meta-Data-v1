---
name: Today pill ≠ Adjust UI "All revenue (cohort)" — by design
description: Extension's Today pill uses event-date `revenue+ad_revenue` to match Meta's event-date spend denominator. Adjust UI's default "All revenue (cohort)" column uses cohort attribution. The numbers will not match for established apps — extension number ≥ cohort number, diff = rev from pre-today installs firing ads today.
type: finding
---

# Today pill numerator ≠ Adjust UI "All revenue (cohort)"

User reported 2026-05-11: extension showed `Today: 0.65/2.80` for an ad whose Adjust Datascape "All revenue (cohort)" column read `$0.5841` for the same row, same day, same UTC offset. Looked like a data drift bug; isn't.

## Why they differ

Two genuinely different metrics from the same Adjust API:

| Source | Adjust metric | Includes |
|---|---|---|
| Adjust UI default | `cohort_all_revenue` | Rev from users who **installed in the cohort window** (today). Returning users excluded. |
| Extension Today pill | `revenue + ad_revenue` (event-date) | Rev from **every event fired today**, regardless of when the user installed. Returning users included. |

For an established IAA app, returning users keep firing ad-revenue events daily → event-date number will be **strictly greater** than cohort number. The diff is rev from users who installed before today but watched ads today.

## Why event-date, not cohort, for the pill

Meta's "Amount spent" cell (the pill's denominator) is event-date — it's spend on impressions/clicks delivered today, not spend attributed to users acquired today. Pairing event-date spend with cohort revenue is apples-to-oranges. Event-date / event-date keeps the same time frame on top and bottom, which matches what an IAA optimizer wants: "of today's media spend, how much did today's ad revenue cover?"

The choice is documented in [src/adjust-client.js](../../src/adjust-client.js) `fetchTodayGrossRevenue` header comment.

## How to verify in Adjust UI

To get a number that matches the extension's pill numerator:

1. In Adjust Datascape, open the column picker for the "today rolling" view.
2. Replace **All revenue (cohort)** with **Ad revenue** (no "cohort" suffix → event-date IAA rev).
3. Add **Revenue** (no suffix → event-date IAP rev) for IAA+IAP apps.
4. Sum the two columns per row → should match the extension's `Today: rev/...` value (within rounding + 5-min cache lag).

If they still differ after that, **then** investigate. Likely culprits in order:
- Cache stale (extension TTL 5 min; force-refresh per [feedback_force_refresh_after_code_change.md](feedback_force_refresh_after_code_change.md))
- UTC offset mismatch (extension defaults `+07:00`; Adjust UI may be on `+00:00` or account-default)
- Different attribution settings (extension uses `attribution_source=first, attribution_type=all`)

## How to apply

When a user reports "extension number ≠ Adjust number":

1. **Don't assume bug.** First ask: which Adjust column are they reading? If it has "(cohort)" in the header, it's the wrong comparison.
2. Tell them to add **Ad revenue** + **Revenue** event-date columns and sum.
3. Only if the event-date sum still differs → check cache age, UTC offset, and attribution settings.

Same trap exists in reverse for the cohort pills (D0/3d/7d/All): those compare against Adjust's `cohort_*_revenue` columns, not event-date. So when triaging "main pill ≠ Adjust UI", check that they're comparing against a cohort column, not event-date.
