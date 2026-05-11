# Findings

Reusable observations about Meta Ads Manager / Adjust behavior, plus collaboration preferences and active follow-ups, that the codebase and working style rely on. Each finding documents what was observed, why it matters, and how to apply it — so future work doesn't re-derive the same constraints from scratch.

To re-load these into a Claude Code session's memory on a new machine, copy the contents into `~/.claude/projects/<project-hash>/memory/` and add a one-line pointer in that directory's `MEMORY.md`.

## Technical findings

- [Meta only preloads visible columns](meta_column_preload.md) — Meta preload + React props only have campaign-id info for currently enabled columns; ambiguity needs Campaign name/ID column on.
- [Reading the Meta "Amount spent" cell per row](meta_spend_column.md) — Column locator strategy (header text + walk-up to cell container), nearest-currency-neighbor spend reader, locale-aware currency parser, cross-currency refusal.
- [Page-world bridge for reading React props](page_world_bridge.md) — Chrome ISOLATED-world content scripts cannot see `__reactProps`/`__reactFiber` expandos page JS attached to DOM elements; needs a second `world: "MAIN"` content script bridging via custom events.
- [Adjust v2 IAA metric is `ad_revenue`](adjust_iaa_metric_name.md) — `network_revenue` / `all_revenue` rejected or silently empty; `revenue` covers IAP only. Request `metrics=revenue,ad_revenue` for IAA apps.
- [Meta URL `date` param encodes preset as comma suffix](meta_url_date_param_format.md) — `date=<range>,<preset>` when user clicks a preset chip; the range can be stale, the suffix is the truth. Required parsing logic for any date-filter detection.
- [Today pill ≠ Adjust UI "All revenue (cohort)"](today_pill_vs_adjust_ui_metric_diff.md) — pill uses event-date `revenue+ad_revenue` to match Meta's event-date spend; Adjust UI default is cohort. Numbers won't match for established apps and that's by design.

## Collaboration preferences

- [List reload steps, don't re-question them](feedback_skip_reload_steps.md) — Include reload/F5 in test plan; trust the user ran them, don't loop back.
- [Always render pipeline-state UI](feedback_show_pipeline_state.md) — Show placeholders (`Today: –/0.76`) instead of hiding; hidden UI is indistinguishable from broken UI.
- [Force-refresh popup after Adjust-fetch code changes](feedback_force_refresh_after_code_change.md) — 5-min cache survives extension reload; only Force-refresh button invalidates it.

## Active follow-ups

- [TikTok Today data pill — handoff for next session](project_tiktok_today_pill_handoff.md) — Meta has Today pill working; TikTok doesn't yet. Today rev data already in cache. Needs column locator, spend-cell finder, fixed-position pill render, URL date detector. Last feature for parity.

## Resolved

- [Today-pill Meta UI date detection](project_today_pill_date_filter_followup.md) — Shipped 2026-05-11 in injector v0.5.1. Off-date renders dashed-amber warn pill. Verified on real Meta accounts.

## Diagnostics

- [`docs/diagnostics/verify-meta-preload.js`](../diagnostics/verify-meta-preload.js) — paste in DevTools Console on a Meta Ads Manager account to verify the `campaign_structure_tree` parser in [content/meta-injector.js](../../content/meta-injector.js) still matches that account's preload payload. Use whenever testing on a new account or after Meta ships a UI change.
