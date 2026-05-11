---
name: Meta Ads Manager URL `date` param encodes preset as comma suffix
description: Meta's `?date=...` URL param is `<dateRange>,<preset>` when the user clicked a preset chip. The date range portion can be stale from a previous selection — the `,<preset>` suffix is the source of truth that matches what Meta's picker label shows.
type: finding
---

# Meta Ads Manager URL `date` param format

When parsing `window.location.search` to detect Meta UI's date filter, the `date` param is **not** simply `YYYY-MM-DD_YYYY-MM-DD`. Two formats observed:

1. **Custom range:** `date=YYYY-MM-DD_YYYY-MM-DD` (no suffix)
2. **Preset clicked:** `date=YYYY-MM-DD_YYYY-MM-DD,<preset>` where `<preset>` is one of: `today`, `yesterday`, `last_7d`, `last_14d`, `last_28d`, `last_30d`, `this_month`, `last_month`, `maximum`, etc.

When format 2 is used, the `<dateRange>` portion is **stale** — it carries the date range that was active *before* the user clicked the preset chip. Meta's UI picker label shows the **preset name** (e.g. "Today: May 10, 2026"), not the range portion. If a parser uses the range and ignores the suffix, it will report the wrong date filter.

## Concrete example

Observed 2026-05-11 on `business.facebook.com/adsmanager/manage/campaigns`:

- Picker label (UI top-right): "Today: May 10, 2026"
- URL: `?date=2026-05-07_2026-05-08,today`

The range `2026-05-07_2026-05-08` is meaningless here — what matters is `,today`.

## Other params for date

- `date_preset=<preset>` — Meta also supports a separate `date_preset` query param (older URL style). When present, it wins outright (no range param needed).
- Neither `date` nor `date_preset` present — Meta uses an account-default picker state that is not derivable from the URL alone.

## How to apply

In any URL-parsing logic that needs to know Meta's active date filter:

1. Check `date_preset` first — if present, use it.
2. Else check `date`:
   - Split on `,`. If a suffix exists, treat the suffix as the active preset name (source of truth).
   - Else parse the bare `<range>` as a custom date range.
3. Treat absent params conservatively (don't assume "today").

The today-pill detector at [content/meta-injector.js](../../content/meta-injector.js) `detectMetaUiDateInfo()` implements this. Any future feature that needs Meta's date filter should reuse that function rather than re-parsing.

## Why this matters for the today pill

The today pill divides Adjust today rev by Meta UI's spend cell. The spend cell value reflects whatever Meta date filter is active. If we mis-detect the filter as "not today" when it actually is Today, we render the off-date warn variant and the user sees `⚠ Today rev: X.XX (Meta on <stale range>)` even though the picker is correctly on Today. Bug shipped in injector v0.5.0; fixed in v0.5.1 with the comma-split logic.
