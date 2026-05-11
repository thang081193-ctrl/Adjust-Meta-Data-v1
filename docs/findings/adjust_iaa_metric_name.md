---
name: Adjust v2 metric names for IAA event-date revenue
description: Which Adjust Reporting v2 metric name returns today's ad-network revenue for IAA-style apps. Several intuitive names DON'T work — verified by trial.
type: reference
---

# Adjust v2 metric names — IAA event-date revenue

The user's apps (Plant-Identifier-style: DecorAI, Chatbot, Chatify, PlantSmart, etc.) are **IAA** (in-app advertising). Their revenue comes from ad networks, not in-app purchases. For event-date revenue at `date_period=today`, the metric name matters.

## What works

- **`ad_revenue`** — event-date ad-network revenue. Verified 2026-05-11: returns rows with `ad_revenue` field populated. Datascape's metric picker labels this column "Ad revenue".
- **`revenue`** — event-date IAP revenue. Valid metric, but returns `0` for these IAA-only apps (no IAP).

Recommended request: `metrics=revenue,ad_revenue` — sum both fields per row for total event-date revenue. Adjust currently returns `0` for IAP, but if any app adds subscriptions later this still works.

## What DOESN'T work

- `currency` → 400 "Unsupported metric: currency loc=metrics" (currency is response-level, not a metric)
- `network_revenue` → 400 "Unsupported metric: network_revenue (network event doesn't exist or was renamed)"
- `all_revenue` → 200 with `rows: []` (silently empty — accepted but no data)

## Cohort variant

For COHORT (the existing pipeline at `src/adjust-client.js`):
- `cohort_all_revenue` — cohort IAP + IAA revenue (currently used)
- `cohort_ad_revenue` — cohort ad-network revenue (Datascape uses this when period=today, captured from real network call)

Drop the `cohort_` prefix to get event-date analog: `cohort_ad_revenue` → `ad_revenue` (works), `cohort_all_revenue` → `all_revenue` (does NOT work).

## How to apply

When picking an Adjust metric name, don't guess from naming conventions. Check Datascape's metric picker UI for the column's display label, then capture the actual network request from Datascape's DevTools Network tab to see the real `kpis=...` parameter the dashboard sends. The Reporting v2 endpoint translates v2 metric names → KPI service `kpis` names, and the translation is not always intuitive.

Verified `kpis=ad_revenue,revenue` works for these IAA apps with `utc_offset=+07:00`, `date_period=today`.
