# Adjust → Meta ROAS Overlay

Chrome extension that pulls accurate multi-window ROAS from Adjust and overlays it onto Meta Ads Manager rows for decision support.

## Why this exists

Meta's reported revenue/ROAS lags and skews vs MMP truth. This extension surfaces Adjust's accurate numbers (D0 / 3-day / 7-day / all-time) directly inside the Meta Ads Manager UI so you can review and act with reliable data — without alt-tabbing.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ Adjust KPI API  │ ──► │  background.js   │ ──► │  Meta Ads Manager   │
│ (4 windows)     │     │  (cache + sync)  │     │  (content injector) │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
        ▲                       ▲
        │                       │
        │                  ┌─────────┐
        └──────────────────│ popup   │
            (configure)    │ (sync)  │
                           └─────────┘
```

Adapter pattern in `src/data-source.js` lets you swap from direct Adjust API to JM-AM endpoint when JM-AM exits soak — no changes elsewhere.

## Decision rule (multi-window AND-logic)

Designed so a single bad day never kills a campaign:

| Action | Condition |
|--------|-----------|
| **Pause** | 3d ROAS < 20% **AND** 7d ROAS < 30% |
| **Scale** | 3d > 100% **AND** 7d > 80% **AND** all-time > 60% |
| **Noisy** | D0 deviates > 150% from 7d (do not action) |
| **Hold**  | Otherwise |

Thresholds are in `src/decision-engine.js` → `DEFAULT_THRESHOLDS`. Tune in code or expose via Settings later.

## Data accuracy guarantees

1. Each cohort window pulled separately from Adjust API — no client-side cohort math.
2. Full decimal precision preserved through the pipeline; rounding only at render.
3. 5-minute cache TTL; "Force refresh" button always bypasses cache.
4. Sync failure throws — never falls back to stale data silently.
5. `lastSyncAt` timestamp visible in the in-page banner and popup.

## The Unicode-safe matcher

`src/matcher.js` solves the "copy-paste from Adjust to Meta search returns nothing" bug. Adjust UI emits non-breaking spaces (U+00A0), en-dashes (U+2013), and zero-width chars. Meta search does exact substring match, so even one invisible char misses. The matcher normalizes both sides before comparing.

## Setup

1. Get Adjust user token: Adjust dashboard → Account → Personal access tokens.
2. Get app token from Adjust app settings.
3. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
4. Click extension icon → expand Settings → enter tokens → Save → Sync.
5. Open Meta Ads Manager — pills should appear next to each campaign name.

## TODOs before production use

- [ ] `src/adjust-client.js`: confirm whether your account uses KPI Service v1 or Reporting Service v2; adjust endpoint + response parsing accordingly.
- [ ] `content/meta-injector.js`: verify `SELECTORS.campaignRow` and `SELECTORS.campaignNameCell` against current Meta Ads Manager DOM (Meta obfuscates classNames so these need periodic check).
- [ ] Multi-app support: today config is single-app; extend `dataSourceConfig` to array if needed.
- [ ] Marketing API action layer: when ready to add automated pause/scale, add `src/meta-marketing-client.js` and a confirm dialog in the popup showing all 4 windows before sending the API call.

## Swapping to JM-AM later

When JM-AM exits soak, expose this endpoint:

```
GET {jmam_base}/api/adjust/campaign-roas?app={appId}&windows=d0,d3,d7,all
Authorization: Bearer {api_key}

Response: [{ campaignName, network, roas: { d0, d3, d7, allTime } }, ...]
```

Then in extension config, switch `dataSourceConfig.kind` from `'adjust-direct'` to `'jm-am'`. Zero code changes elsewhere.
