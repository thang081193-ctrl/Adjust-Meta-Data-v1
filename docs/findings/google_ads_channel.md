---
name: Google Ads channel — selector-free injector, channel filters, partner_254
description: How the Google Ads pills work without any Google DOM selectors, why every injector now filters by Adjust channel, and the verified Google channel id (partner_254, via filters_data).
type: project
---

# Google Ads channel (v0.11)

**Date:** 2026-09-01 · **Added in:** v0.11.0 · **Cache schema:** v10 ·
**Injector:** `content/google-injector.js` (`v0.11.0-google-pills`)

Third platform alongside Meta and TikTok: same four pills (cohort / Today /
Y'day / D-2), same popup toggles and thresholds (new `google` namespace in
`pillVisibility` + `colorThresholds`), same position-fixed pill architecture as
TikTok. Levels map: Campaigns → `campaign`, Ad groups → `adset`
(`adgroup_network`), Ads → `ad` (`creative_network`).

## The selector problem, and the selector-free answer

Meta pins `div.ellipsis`; TikTok pins `KsLink`. Google Ads obfuscates its
class names and swaps internal tags between releases, so there is nothing
stable to pin. The injector therefore never queries Google-specific selectors:

- **Candidates are index-driven.** Every visible text leaf whose
  `canonicalKey(text)` exists in the Adjust indexes is a candidate. Then the
  largest cluster of candidates sharing a left edge (±8px) is taken as the name
  column — a breadcrumb / hovercard / detail panel repeating a campaign name
  almost never lines up with the table's name column, so it lands in a smaller
  cluster and is dropped. Verified on the mock: a same-name decoy at a
  different X was not decorated.
- **Table scope is the deepest common ancestor** of the matched candidates —
  used to scope the Cost-column and row-Y-bucket scans.
- **Cost column** is found by header text (`Cost` + localized variants, exact
  canonical match so `Cost / conv.` — which also holds currency cells — can
  never be a candidate) and scored by currency-looking cells stacked below at
  the same X. Verified on the mock: with both `Cost` and `Cost / conv.` columns
  present, spend reads came from `Cost`.
- **Date detection** reads the toolbar's date-picker text (a leaf in the top
  ~250px starting with "Today" / "Yesterday"; `r.bottom < 0` is the cutoff, not
  `r.top < 0` — sticky toolbars can sit a few px negative). Unknown range → the
  today pill renders its revenue-only off-date variant instead of dividing into
  an unidentified spend window. The `isOwnNode` guard here is load-bearing: our
  own today pill's text starts with "Today" and would otherwise self-trigger
  the detection.
- **Drill-down scoping** uses `/aw/adgroups?campaignId=N` — the numeric id
  Google mints, which Adjust returns in `attr_dependency.campaign_id_network` —
  to resolve ambiguous ad-group/ad names via the composite index. No
  page-world bridge.

`viewportH()` (innerHeight → documentElement.clientHeight → 800) exists because
`window.innerHeight` can read 0 in edge states, and a 0 viewport would cull
every candidate.

## Channel filters became mandatory everywhere

The user's campaign naming ("…-GL-ROAS…", "Caller ID-…") repeats across
networks, and until v0.11 **meta-injector indexed every row in the shared
cache** — harmless while the fetch was Meta + TikTok, but adding Google rows
would have let a same-named Google campaign collide into (and win) Meta's
name-keyed indexes. Now every injector filters before indexing:

| injector | filter |
|---|---|
| meta | `/facebook|instagram|meta/i` (rows with no network kept — old behavior) |
| tiktok | `startsWith('TikTok')` (pre-existing) |
| google | `/google|adwords/i` |

Cache schema bumped to **v10** so the first post-upgrade sync repopulates with
Google rows instead of waiting out the TTL.

## Google channel id = `partner_254` (verified live)

First guess was `partner_7` (Adjust's classic AdWords partner id) — **wrong**:
the report filter silently returned zero Google rows while the unfiltered probe
showed Google Ads as the account's BIGGEST channel ($13.5k spend / 106.8k
installs over 7 days). The real id came from the reports-service
**`filters_data`** endpoint (`?required_filters=channels`), which returns the
same id↔name mapping the Datascape filter UI is built from:
`{"id":"partner_254","name":"Google Ads","section":"Partners"}` (2026-09-01,
old account). Live response shape is `{ channels: [ {id, name, …} ] }` — an
object keyed by filter name, not the documented array-of-groups.

If Google rows ever vanish again, re-run per account before suspecting code:

```
node docs/diagnostics/channel-probe.mjs <api_token> [app_tokens]
```

Step A/B diff the channel lists with/without the extension filter; step C
prints the account's full channel id↔name mapping with Google rows marked.
The Google banner also warns when Adjust returned zero Google rows.

## How to apply

- Pills missing on ads.google.com → DevTools console, filter `AOX-GG`: the DOM
  diagnostics object shows `candidatesFound`, `clusterSizes`, index sizes, and
  today-pill stats. `candidatesFound: 0` with non-empty indexes means the name
  text on screen doesn't canonical-match Adjust's names (rename?);
  empty indexes mean the channel filter / partner id (run the probe).
- Cost/date quirks are per-locale text matching — extend
  `GOOGLE_COST_HEADER_KEYS` / `DATE_TODAY_RE` rather than reaching for DOM
  selectors.
- Adding a fourth platform: copy this injector's shape (index-driven
  candidates + clustering), not Meta's or TikTok's selector pinning — and
  remember its channel filter AND the popup/table columns and
  `createDataSource` gating (`pillVisibility.<platform>`).
