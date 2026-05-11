---
name: Reading Meta UI "Amount spent" cells per row
description: How the Today pill locates each row's spend cell in Meta Ads Manager and why several DOM strategies were rejected. Same column-preload constraint as meta_column_preload.md.
type: finding
---

# Reading Meta UI "Amount spent" cells per row

The Today pill (`Today: NN%`) divides Adjust gross revenue today by spend read directly from Meta Ads Manager. This doc captures the per-row spend-cell discovery strategy and the trade-offs around it.

## Why Meta UI, not Adjust, for the spend denominator

Meta's own UI surfaces realtime spend with no MMP lag. Adjust's cost number is pulled from Meta on a delayed schedule and can drift hours behind. For the "is today on track right now?" question the Today pill answers, only Meta's realtime spend is acceptable as the denominator.

## Column locator (per decorate pass)

`locateAmountSpentColumn()` ([content/meta-injector.js](../../content/meta-injector.js)) runs once per pass.

1. Scan every `div.ellipsis` whose text length ≤ 60 chars.
2. Compare its `canonicalKey(text)` against `SPEND_HEADER_KEYS` (multilingual: EN "Amount spent", VN "Số tiền đã chi" / "Số tiền đã tiêu", FR/ES/DE/IT/NL). Truncation tolerance: if the cell ends in `…` or `..`, accept a header key whose canonical form `startsWith` the prefix (≥6 chars to avoid spurious hits).
3. Pick the topmost match (header rows sit at the top of the table).
4. Capture the header's X mid and short text. The X mid is the **column anchor** used for per-row spend-cell discovery.

If no header is found, today-pill rendering is skipped and the banner appends: `⚠ Today ROAS disabled — enable "Amount spent" column in this Meta view.`

## Per-row spend cell

`findSpendCellText(nameEl)` reuses the existing Y-bucket index built for ambiguity disambiguation (`ensureRowYBuckets`). For the row that owns `nameEl`:

- Collect every leaf cell whose Y mid lies inside the row's vertical range.
- Among those, keep cells whose horizontal mid is within **±40 px** of the column anchor.
- Of the surviving cells, pick the one whose text passes `looksLikeCurrency(text)` (digits + currency symbol / ISO code / thousands separator) and is closest in X.

The ±40 px tolerance is tighter than the critique's initial ±100 px suggestion because adjacent columns ("Cost per result", "CPC", "CPM", "Budget") routinely sit closer than 100 px and they all look like currency. 40 px lets micro-pixel jitter through while rejecting neighbouring columns reliably on the layouts we tested.

### Why not child-index of the header row?

Meta's table is split into a frozen-left and scrollable-right panel; the two panels do not share a parent before the table root. Mapping the header cell's child index onto a data row's child container only works if you know which panel the spend column lives in, and even there the data-row container often has a different shape (extra wrapper nodes inserted by Meta's virtualization). Y-bucket + X-mid match handles both panels uniformly through the existing buckets — the same trick the campaign-ID disambiguator already uses.

### Why not `aria-colindex` / `data-testid`?

Meta dropped ARIA grid roles months before this extension was built ([content/meta-injector.js](../../content/meta-injector.js) line 33). `data-testid` attributes do exist on some elements but rotate across deploys. Neither survives long enough to be a safe primary signal.

## Currency parsing — `parseCurrencyCell`

Locale-aware. Detects currency by symbol first (`$`, `€`, `£`, `¥`, `₫`, `₹`, `₩`, `฿`, `₱`, `₪`, `₺`, `₽`), then falls back to a 3-letter ISO code anywhere in the cell.

Separator-role decision:
- **Zero-decimal currencies** (VND, JPY, KRW, IDR, CLP): every `.` and `,` is thousands grouping.
- **All others**: the rightmost separator is the decimal point IF followed by exactly 1–2 digits AND there is no later separator. Otherwise every separator is thousands. This handles both US-style `1,234.56` and EU-style `1.234,56` cleanly.

Negatives accepted: leading `-`, leading `−` (U+2212), or wrapped in parentheses (`($1.23)`).

### Refused inputs (returns `parsed: false`)

| Input | Why |
|-------|-----|
| `$1.2K`, `1,2M` | Abbreviated values — the K/M scale silently loses precision. Banner asks user to disable Meta's abbreviation toggle. |
| Eastern Arabic numerals (`١٢٣`, `۱۲۳`, `१२३`) | Not supported in v1. Add per-locale digit transliteration only if a user surfaces this need. |
| `–` / `—` | Empty cell — paused ad or no-data. Distinct from `$0.00` (zero spent, intentional). |
| Cells failing the `\d` test, or wrapped in `%` | Not a money column. Sanity filter so neighbouring CPM/CTR/Frequency cells don't sneak through. |

## Currency mismatch handling

Each Adjust row carries a `currency` field (the app's reporting currency). The Today pill compares it to the currency detected in the Meta cell:

- **Match**: render `Today: NN%` with red/green coloring at <60% / >100%.
- **Mismatch** (e.g. Adjust USD, Meta VND): render the mismatch variant pill `⚠ Today: – (USD→VND)` with a tooltip explaining the refusal. **No FX conversion** — too easy to mislead at 3 a.m. when the user is making pause/scale calls.

If many rows hit currency-mismatch and zero rows render successfully, the banner appends: `⚠ Today ROAS unavailable — Adjust app currency (X) ≠ Meta ad-account currency (Y).`

## Constraint inherited from `meta_column_preload.md`

The "Amount spent" column must be **enabled in the Meta view**. This is the same constraint already in [meta_column_preload.md](meta_column_preload.md) for Campaign-name / Campaign-ID disambiguation: Meta only ships data for columns that are currently visible. There is no hidden DOM path that lets us read spend without the user enabling the column — don't try.

## Safety

Spend reading is pure `textContent` on cells Meta already rendered:

- No attribute writes on Meta-owned nodes.
- No `dispatchEvent`, `click`, `focus`, `submit`.
- No fetch to facebook.com.
- No use of the page-world bridge — `textContent` is shared across JS worlds, so isolated-world reads work.

## Performance

The column locator is O(N) over all `div.ellipsis` elements once per pass (~40–80 ms candidates). Per-row spend-cell discovery is O(1) thanks to the existing Y-bucket index (built once, lazy). The 200 ms decorate debounce remains the upper bound on user-perceived latency.

## Diagnostics

`logDomDiagnostics()` now logs a `today` block on every pass with:

- `columnFound`, `columnHeaderText`, `columnX`
- `pillsRendered`, `skippedNoSpendCell`, `skippedCurrencyMismatch`, `skippedAmbiguous`, `skippedAbbreviated`
- `sampleSpend`, `sampleRevToday`, `detectedMetaCurrency`, `adjustCurrencyExample`

When triaging "Today pills don't appear": check `columnFound` first, then `skippedNoSpendCell` (the X-tolerance may be off on the user's layout) and `skippedCurrencyMismatch`.

## Known limitations

- **Meta UI date filter MUST be set to "Today" for the pill to be meaningful.** The spend cell value reflects whatever Meta date filter is currently active. If the user has Meta UI on "Yesterday" or "Last 7 days", the spend cell shows that period's spend, but the today-pill's numerator is always Adjust's TODAY revenue — dividing them produces a meaningless ratio. **Follow-up needed:** detect Meta UI date filter from URL params (`date_preset=today` or `date=YYYY-MM-DD_YYYY-MM-DD` matching today's date) and either (a) render the pill only when Meta filter = Today, or (b) render a warning variant when it's not (e.g. `⚠ Today rev: $X.XX (Meta UI on <date>, switch to Today for ROAS)`).
- Cache TTL for today revenue is the same 5 min as cohort data. Users will see numerator update every 5 min while denominator updates every render. Tooltip surfaces `Adjust sync age` so the user can judge staleness. If lag bites, split the cache.
- UTC boundary: `date_period=today` evaluates against the user's `utcOffset` setting; Meta's spend is in the ad-account timezone, which may differ. Around midnight in either zone, the pill can be briefly off. Document and live with it for v1.
- Horizontal scroll inside the table: the column anchor X is captured per pass. If the user scrolls the table horizontally between MutationObserver ticks, the next decorate pass re-anchors — no caching across passes. Spurious silent reads remain unlikely but not impossible.
