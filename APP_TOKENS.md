# Adjust App Tokens

Reference list of the Adjust `app_token` identifiers for the apps we run Meta /
TikTok ads for. Paste each account's comma string into that account's
**"App tokens"** field in the extension popup (Settings → Tài khoản Adjust) — it
becomes the `app_token__in` query param so Adjust resolves the *full* tracker set
per app (without it, Adjust's default `tracker_filter` silently drops newer
networks like TikTok). See the comment in [src/adjust-client.js](src/adjust-client.js)
for why this is needed.

> These are **app identifiers, not auth secrets** — safe to keep in the repo.
> The API tokens they pair with are NOT in this repo; they live only in the
> popup's per-account fields.
> Source of truth: each Adjust dashboard → Apps list. Re-verify on add/rename.

## ⚠ Migration in progress: Adjust 1 → Adjust 2

Apps are moving one at a time onto a second Adjust account. A migrated app gets
a **brand-new app_token** — it is not the same string as in the old account.

**When you move an app:** paste its new token into the Adjust 2 list *and*
delete the old token from the Adjust 1 list, in the same edit. Leaving it in
both makes the same campaign appear under two accounts, which the extension
flags as a `syncWarning` because the "Tất cả" view would double-count its cost.
See [docs/findings/multi_adjust_account_split.md](docs/findings/multi_adjust_account_split.md).

## Adjust 1 (tài khoản cũ)

### Paste-ready (App tokens field — Adjust 1)

```
b6yjkg1hc7wg,ox6zszk8msjk,c1um2rdnch6o,rzfdacwjzm68,kb64lotprz7k,vpjmthw8l8u8,lpz0c08fnitc,pmh28w0ksfls,wz9wt6b3bim8,9p5pqomqr8jk,7z52ql6392f4
```

### Token → App

| App | Adjust app_token | Trạng thái |
|---|---|---|
| AI Home Design: DecoAI | `b6yjkg1hc7wg` | Adjust 1 |
| AI Tutor - Math Homework Help | `ox6zszk8msjk` | Adjust 1 |
| ChartLens: AI Analyzer | `c1um2rdnch6o` | Adjust 1 |
| Chatbot AI GPT Smart Assistant | `rzfdacwjzm68` | Adjust 1 |
| Chatify – AI Chat & PDF Reader | `kb64lotprz7k` | Adjust 1 |
| Gen Art AI | `vpjmthw8l8u8` | Adjust 1 |
| PlantSmart - AI Identifier | `lpz0c08fnitc` | Adjust 1 |
| TradeBuddy - AI Chart Analyst | `pmh28w0ksfls` | Adjust 1 |
| MathDojo: AI Math Practice | `wz9wt6b3bim8` | Adjust 1 |
| ScoreDeck: Live Football Score | `9p5pqomqr8jk` | Adjust 1 |
| Show ID Caller & Spam Blocker | `7z52ql6392f4` | Adjust 1 |

<!-- First 8 confirmed 2026-05-11; last 3 (MathDojo, ScoreDeck, Caller ID) added 2026-06-16. -->

## Adjust 2 (tài khoản mới)

Chưa có app nào được chuyển sang. Khi chuyển app đầu tiên: lấy app_token mới từ
URL Datascape của **tài khoản 2** (`app_token__in=…`), thêm dòng vào bảng dưới,
cập nhật chuỗi paste-ready, và xoá token cũ khỏi danh sách Adjust 1 ở trên.

### Paste-ready (App tokens field — Adjust 2)

```
(trống — chưa chuyển app nào)
```

### Token → App

| App | Adjust app_token | Ngày chuyển |
|---|---|---|
| _(chưa có)_ | | |
