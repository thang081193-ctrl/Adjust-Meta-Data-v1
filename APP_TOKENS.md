# Adjust App Tokens

Reference list of the Adjust `app_token` identifiers for the apps we run Meta /
TikTok ads for. Paste the comma string into the extension popup's **"App tokens"**
field — it becomes the `app_token__in` query param so Adjust resolves the *full*
tracker set per app (without it, Adjust's default `tracker_filter` silently drops
newer networks like TikTok). See the comment in [src/adjust-client.js](src/adjust-client.js)
for why this is needed.

> These are **app identifiers, not auth secrets** — safe to keep in the repo.
> Source of truth: Adjust dashboard → Apps list. Re-verify on add/rename.

## Paste-ready (App tokens field)

```
b6yjkg1hc7wg,ox6zszk8msjk,c1um2rdnch6o,rzfdacwjzm68,kb64lotprz7k,vpjmthw8l8u8,lpz0c08fnitc,pmh28w0ksfls,wz9wt6b3bim8,9p5pqomqr8jk,7z52ql6392f4
```

## Token → App

| App | Adjust app_token |
|---|---|
| AI Home Design: DecoAI | `b6yjkg1hc7wg` |
| AI Tutor - Math Homework Help | `ox6zszk8msjk` |
| ChartLens: AI Analyzer | `c1um2rdnch6o` |
| Chatbot AI GPT Smart Assistant | `rzfdacwjzm68` |
| Chatify – AI Chat & PDF Reader | `kb64lotprz7k` |
| Gen Art AI | `vpjmthw8l8u8` |
| PlantSmart - AI Identifier | `lpz0c08fnitc` |
| TradeBuddy - AI Chart Analyst | `pmh28w0ksfls` |
| MathDojo: AI Math Practice | `wz9wt6b3bim8` |
| ScoreDeck: Live Football Score | `9p5pqomqr8jk` |
| Show ID Caller & Spam Blocker | `7z52ql6392f4` |

<!-- First 8 confirmed 2026-05-11; last 3 (MathDojo, ScoreDeck, Caller ID) added 2026-06-16. -->
