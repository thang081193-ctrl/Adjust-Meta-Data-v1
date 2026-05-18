# Adjust today endpoint returns creative_id=null shadow rows

## What

When fetching `date_period=today` from Adjust Reporting v2 with `dimensions=...,creative_network`, the response occasionally contains **two rows for the same ad creative**: one with `attr_dependency.creative_id_network=null` (a "shadow" / unresolved-attribution bucket) and one with `creative_id_network=<real id>`. The fresh API may return only the resolved rows; the shadow rows appear and disappear as Adjust finalizes attribution within the day.

Observed 2026-05-18 on TradeBuddy adgroup `AG_BadEntryFear_R08`:

- **Adset-level direct query** (`dimensions: channel,campaign_network,adgroup_network`): 1 row, `ad_revenue=1.1663` — matches Datascape adgroup view exactly.
- **Ad-level fresh query** (`+ creative_network`): 3 rows with `creative_id_network=real`, sum `ad_revenue=1.1663` — also matches Datascape.
- **Cached ad-level rows** (captured earlier): 10 rows for the same adgroup, 7 with `creative_id_network=null` summing $24.78 in `revToday`, plus 3 orphan rows with real creative_id summing $1.17. Total $25.95 — 22× inflated.

## Why it matters

Rolling up ad-level today rows into adset/campaign totals **double-counts** when shadow rows are present:

1. `data-source.mergeTodayInto` matches shadow rows to cohort rows by name fallback (since both have `adId=null`), stamping the shadow's `revenueToday` onto the cohort row.
2. The remaining shadow rows that don't find a cohort match get appended as orphan rows.
3. `attachTodayMetrics` in the injector sums **all** ad-level rows' `revenueToday` onto a single adset entry → shadow value + orphan value both counted.
4. Worse: the contaminated cache **persists** across Adjust's attribution finalization. Even when the fresh API stops returning shadows, the stale cache keeps inflating the pill until the user hits Force-refresh.

## How to apply

- **Query at the dimension level that matches the pill's display granularity.** Adset pills must query Adjust with `dimensions: channel,campaign_network,adgroup_network` — never roll up ad-level rows. Adset-level Adjust queries do not split by `creative_id_network`, so shadows can't appear.
- For ad pills, the ad-level query is unavoidable. Mitigate by deduping today rows on `(canonicalKey(adName), preferReal(adId))` if shadow contamination ever surfaces there.
- **Bump cache schema version when the merge/rollup logic changes.** A user who ships a fix but still loads stale pre-fix cache will see the bug for the cache lifetime. `background.js` discards caches with older `schemaVersion`.

## Verified
- Adjust API call `dimensions: channel,campaign_network,adgroup_network` returns one canonical row per (channel, campaign, adset). No shadow duplicates.
- Fix shipped 2026-05-18 in injector v0.4.0-tt-adset-direct / v0.7.0-adset-direct, cache schema v2.

## Follow-up — v3 fixes idKey namespace collision (2026-05-18)

Adding the adset-level fetch alone was not enough. `mergeTodayInto` keyed shadow ad-rows (level='ad', adId=null) into the **same namespace** as adset-level rows via the legacy fallback `if (row.level === 'ad' && row.adsetId) return 'adset::' + row.adsetId`. Since `idIndex.set` is last-writer-wins, shadow ad-rows clobbered the legitimate adset today row, causing:

1. The cohort adset row matched the **shadow's** revenueToday (e.g. 0.1901 instead of 0.477).
2. The real adset-level today row never entered `matched` → got appended as an **orphan row** with the correct revenue.
3. Cache stored two `level='adset'` rows for the same adsetId.
4. `attachTodayMetrics` bumped `adsetByIdIndex` twice → pill showed sum (0.1901 + 0.477 = 0.6671 vs the true $0.477).

Verified across 5 adgroups: every "off-by-shadow" pill matched cohort.revToday + orphan.revToday exactly. The R08 adgroup that matched Datascape (1.17) coincidentally had cohort.revToday=0 + orphan.revToday=1.17 due to no shadow ad-row collision in that specific case.

Fix: remove the `level==='ad' && adsetId` fallback in `todayIdKey`. Each level owns its own namespace. Shipped in injector v0.4.1-tt-idkey-namespace / v0.7.1-idkey-namespace, cache schema v3.
