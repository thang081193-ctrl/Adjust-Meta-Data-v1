# Meta only preloads data for visible columns

Meta Ads Manager preload behavior — `campaign_structure_tree` and React props only carry data for columns the user has currently enabled in the table view, so disambiguation strategies that don't have row-context cells will fail.

Meta Ads Manager's preload payloads (`campaign_structure_tree` in `<script>` tags, React `__reactProps$XXX`) only carry data for **columns the user has enabled** in the current table view. If Campaign name / Campaign ID columns are off, neither the structure tree nor the row's React props contain campaign-id info reliably enough to disambiguate same-named ads across multiple campaigns.

## Why

Observed 2026-05-07 on account "Meta LPT 11 - PlantAI" with `urlScopedCampaignIds.size === 4` and 8 ambiguous "MVideo 2003 / SVideo 2003" rows. Meta-tree by-name lookup, row React-props adgroup_id lookup, and DOM Y-position lookup all returned 0 resolutions until user toggled "Campaign name" column ON — Strategy 4 (DOM Y match by campaign-name text) immediately resolved everything.

## How to apply

When `stillAmbiguous > 0` after a decorate pass, the existing banner already tells the user to enable "Campaign name" or "Campaign ID" column. Don't try to engineer around this client-side — there is no hidden DOM source we missed; Meta genuinely does not ship the data when columns are off. Future strategies should focus on the post-column-enabled DOM, or pull the missing identity from the Adjust side (item F in [SESSION_NOTES.md](../../SESSION_NOTES.md): capture `creative_id_network` / `adgroup_id_network`).
