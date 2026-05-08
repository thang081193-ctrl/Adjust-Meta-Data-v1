# Findings

Reusable observations about Meta Ads Manager / Adjust behavior that the codebase relies on. Each finding documents what was observed, why it matters, and how to apply it — so future work doesn't re-derive the same constraints from scratch.

To re-load these into a Claude Code session's memory on a new machine, copy the contents into `~/.claude/projects/<project-hash>/memory/` and add a one-line pointer in that directory's `MEMORY.md`.

## Index

- [Meta only preloads visible columns](meta_column_preload.md) — Meta preload + React props only have campaign-id info for currently enabled columns; ambiguity needs Campaign name/ID column on.
- [Page-world bridge for reading React props](page_world_bridge.md) — Chrome ISOLATED-world content scripts cannot see `__reactProps`/`__reactFiber` expandos page JS attached to DOM elements; needs a second `world: "MAIN"` content script bridging via custom events.

## Diagnostics

- [`docs/diagnostics/verify-meta-preload.js`](../diagnostics/verify-meta-preload.js) — paste in DevTools Console on a Meta Ads Manager account to verify the `campaign_structure_tree` parser in [content/meta-injector.js](../../content/meta-injector.js) still matches that account's preload payload. Use whenever testing on a new account or after Meta ships a UI change.
