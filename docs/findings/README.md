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
- [Yesterday pill spend from Adjust](adjust_yesterday_spend.md) — v0.12: D-1 denominator moved from scraped-UI spend to Adjust network cost (shared closed-day engine with D-2); no more "cần view Yesterday"; UI capture is fallback-only. Google today pill now shows a rev-only hint when the view lacks a Cost column.
- [Google Ads channel — selector-free injector](google_ads_channel.md) — index-driven candidate discovery + X-clustering instead of DOM selectors (Google obfuscates them); every injector now filters rows by Adjust channel (cross-network name collisions); `partner_7` is an assumed channel id — verify with channel-probe. Copy this injector's shape for any fourth platform.
- [D-2 pill pipeline — three defects, one symptom](adjust_d2_pipeline.md) — a spend-side rejection killed the whole D-2 fetch; the spend half asked for the full cohort metric set just to read `cost`; and the Meta cohort-pill DOM guards identified themselves by exclusion, so they deleted the D-2 pill. Read before adding a fifth pill type.
- [Multiple Adjust accounts](adjust_multi_account.md) — config shape (`accounts[]` + `activeAccountId`), why the fan-out is not proportionally heavier, and the v0.12.2 merge rule for an entity reported by two accounts (installs/revenue summed, spend = max, ROAS recomputed) — a migrating app legitimately has SDK traffic on both sides.
- [Adjust 500 TimeoutError under parallel report bursts](adjust_500_concurrency_retry.md) — 12+ concurrent report calls make Adjust's generator time out server-side (HTTP 500 service_error). Fix: ≤3 concurrent + retry/backoff on 5xx + partial-sync with labeled syncWarnings instead of all-or-nothing.
- [The decorate pass fed its own MutationObserver](perf_decorate_self_feedback_loop.md) — `showBanner` rewrote the banner text at the end of every decorate pass, and that childList mutation re-triggered the observer that scheduled the pass: a self-feeding ~5 passes/second loop on every ads tab, in ALL THREE injectors, even when idle. Invisible to `longtask` profiling (each pass is under 50 ms). Fixed v0.12.5 with an own-node cutout + idempotent banner + idle decorate + a parking rAF loop.
- [GET_CACHED ships only one channel's rows](perf_get_cached_channel_scope.md) — every injector used to receive the whole ~8–10 MB / 20k-row cache and throw ~two thirds away, re-read from storage and structured-cloned per call. v0.12.5 adds `msg.channel` + a 30 s worker-side memo. No schema bump: injectors still re-filter locally, so an old worker stays correct.
- [Google Ads table can take 2+ minutes to paint](google_ads_table_render_latency.md) — the shell paints first, so the page LOOKS loaded while the DOM is still ~800 nodes with no rows to decorate. Check `document.querySelectorAll('*').length` before suspecting the matcher. v0.12.5 raised the cold-start retry budget from 30 s to ~2.5 min with backoff.
- [`Resource::kQuotaBytes quota exceeded` — cache outgrew storage.local](storage_quota_cache_size.md) — `chrome.storage.local` caps at 10 MB without `unlimitedStorage`, and at ~662 B/row that is only ~15,800 rows. 2 accounts × 3 levels × 13 app tokens blew past it. The Adjust fetch had already SUCCEEDED — only the cache write failed. v0.12.4 adds the permission + a per-sync size checklog. Probe: `node docs/diagnostics/cache-size-probe.mjs`.

## Debug traps

- [Stale service worker after a code change](debug_trap_stale_service_worker.md) — Chrome re-reads popup + content scripts from disk but replaces the worker only on extension Reload. Tells: a warning string you can't grep in the working tree, an error without the account-label prefix, pills showing the other Adjust account's row. Guarded since v0.12.2 by `GET_BUILD` handshake + injector `EXPECTED_CACHE_SCHEMA`.
- [Popup stuck on “Loading…” with an empty Adjust dropdown](debug_trap_popup_module_parse_error.md) — popup.js is an ES module, so a SyntaxError means NOT ONE LINE runs: no version stamp next to the title is the tell. v0.12.2 broke it with single-quoted strings split across raw newlines. Note `node --check <file>` MISSES this; use `node docs/diagnostics/syntax-check.mjs`.

## Collaboration preferences

- [List reload steps, don't re-question them](feedback_skip_reload_steps.md) — Include reload/F5 in test plan; trust the user ran them, don't loop back.
- [Always render pipeline-state UI](feedback_show_pipeline_state.md) — Show placeholders (`Today: –/0.76`) instead of hiding; hidden UI is indistinguishable from broken UI.
- [Force-refresh popup after Adjust-fetch code changes](feedback_force_refresh_after_code_change.md) — 5-min cache survives extension reload; only Force-refresh button invalidates it.

## Active follow-ups

- [TikTok Today data pill — handoff for next session](project_tiktok_today_pill_handoff.md) — Meta has Today pill working; TikTok doesn't yet. Today rev data already in cache. Needs column locator, spend-cell finder, fixed-position pill render, URL date detector. Last feature for parity.

## Resolved

- [Today-pill Meta UI date detection](project_today_pill_date_filter_followup.md) — Shipped 2026-05-11 in injector v0.5.1. Off-date renders dashed-amber warn pill. Verified on real Meta accounts.

## Diagnostics

- [`docs/diagnostics/channel-probe.mjs`](../diagnostics/channel-probe.mjs) — `node docs/diagnostics/channel-probe.mjs <token> [app_tokens]`. Lists the Adjust channels visible to a token with and without the extension's channel filter, and verdicts whether the assumed Google Ads id (`partner_7`) is correct. Run once per account after v0.11.
- [`docs/diagnostics/datasource-itest.mjs`](../diagnostics/datasource-itest.mjs) — `node docs/diagnostics/datasource-itest.mjs`. Offline regression test for `src/data-source.js`: stubs `chrome.storage` + `fetch` and drives the real `createDataSource()/fetchAll()` path. Covers multi-account fan-out + dedupe, D-2 half-failures, one-account-down, single-account selection, legacy config migration, and toggle-gated fetches. Run it after touching data-source or adjust-client.
- [`docs/diagnostics/d2-probe.mjs`](../diagnostics/d2-probe.mjs) — `node docs/diagnostics/d2-probe.mjs` with `ADJUST_TOKEN` set. Fires each D-2 report call separately and prints status / row counts / timings, plus a light-vs-heavy `cost` comparison. Use when a D-2 pill reads "chưa có dữ liệu" and the tooltip doesn't already name the error. Run once per Adjust account.
- [`docs/diagnostics/verify-meta-preload.js`](../diagnostics/verify-meta-preload.js) — paste in DevTools Console on a Meta Ads Manager account to verify the `campaign_structure_tree` parser in [content/meta-injector.js](../../content/meta-injector.js) still matches that account's preload payload. Use whenever testing on a new account or after Meta ships a UI change.
