# v2-secure — Adjust ROAS Overlay (Secure Variant)

Side-by-side rebuild of the extension that moves the Adjust API token + per-app
tokens off user machines and behind a Cloudflare Worker proxy. The original
v0.3.0 in the parent folder is left untouched — disable v0.4.0 in
`chrome://extensions` and the old build keeps working with no changes.

## Why

Threat model summary (full discussion in chat history):

- Anything in `chrome.storage.local` is plaintext on the user's disk.
- Anything sent in a `fetch()` is visible in DevTools Network tab.
- → If the Adjust admin token is on the user's machine, it leaks the moment a
  user with intent opens DevTools. Obfuscation does not change this.

v2-secure removes both surfaces. Extension only knows a short-lived JWT for the
proxy. The proxy holds the Adjust token, can be rotated in one command, and
logs every request. Compromised user → revoke their KV record, no Adjust token
rotation needed.

## Layout

```
v2-secure/
├── extension/           Chrome MV3 extension (clone of v0.3.0, will diverge)
│   └── manifest.json    name: "Adjust ROAS Overlay (Secure)", version 0.4.0
└── worker/              Cloudflare Worker (auth + Adjust proxy)
    ├── src/index.ts     Hono router: /auth/login, /api/whoami, /api/roas, /api/today-revenue
    ├── src/auth.ts      PBKDF2 password hash + JWT issue/verify
    ├── scripts/         CLI helpers (hash-password.ts)
    ├── wrangler.toml    KV bindings + secret list
    └── .dev.vars.example   Local-dev secrets template
```

## Setup — first time only

### 1. Cloudflare Worker

```bash
cd v2-secure/worker
npm install
npx wrangler login                                  # opens browser, sign into Cloudflare

# Create three KV namespaces, paste the returned ids into wrangler.toml
npx wrangler kv:namespace create USERS
npx wrangler kv:namespace create CACHE
npx wrangler kv:namespace create AUDIT

# Set production secrets (never commit these)
npx wrangler secret put ADJUST_API_TOKEN            # your Adjust admin token
npx wrangler secret put JWT_SECRET                  # openssl rand -hex 32
npx wrangler secret put APP_TOKENS_JSON             # see .dev.vars.example for shape

# Deploy
npx wrangler deploy
# → https://adjust-roas-proxy.<account>.workers.dev
```

### 2. Seed users

```bash
# Generate a password hash for each user
npx tsx scripts/hash-password.ts "user1-password"
# → pbkdf2$100000$abc...$xyz...

# Put the user record into KV (production: --remote)
npx wrangler kv:key put --binding=USERS --remote thang@jellymedia.vn \
  '{"pwd_hash":"pbkdf2$100000$abc...$xyz...","role":"admin","allowed_apps":["all"]}'

npx wrangler kv:key put --binding=USERS --remote ua-member@jellymedia.vn \
  '{"pwd_hash":"...","role":"user","allowed_apps":["all"]}'
```

### 3. Verify

```bash
curl -X POST https://adjust-roas-proxy.<account>.workers.dev/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"thang@jellymedia.vn","password":"user1-password"}'
# → { "token": "eyJ...", "expiresAt": ..., "email": "...", "role": "admin" }

curl https://adjust-roas-proxy.<account>.workers.dev/api/whoami \
  -H "Authorization: Bearer <paste-token>"
# → { "email": "...", "role": "admin", "apps": ["all"], "exp": ... }
```

## Local dev

```bash
cd v2-secure/worker
cp .dev.vars.example .dev.vars         # fill in real values
npm run dev                            # → http://localhost:8787
npm run tail                           # production logs (after deploy)
```

## Operational tasks

| Task | Command |
|---|---|
| Rotate Adjust token | `wrangler secret put ADJUST_API_TOKEN` |
| Rotate JWT secret (kicks all sessions) | `wrangler secret put JWT_SECRET` |
| Add user | `wrangler kv:key put --binding=USERS --remote <email> '<json>'` |
| Revoke user | `wrangler kv:key delete --binding=USERS --remote <email>` |
| List users | `wrangler kv:key list --binding=USERS --remote` |
| Tail audit log | `wrangler tail` |
| Inspect audit history | `wrangler kv:key list --binding=AUDIT --remote --prefix=<ts>` |

## Rollback to v0.3.0

If v0.4.0 misbehaves in production:

1. `chrome://extensions` → toggle off **Adjust ROAS Overlay (Secure)** v0.4.0.
2. Toggle on the original **Adjust → Meta ROAS Overlay** v0.3.0 (still installed
   from the parent folder, untouched).
3. Done. No data migration, no shared state — they store cache under separate
   extension IDs.

The worker can keep running (no cost). Re-enable v0.4.0 once fixed.

## Build status — current step

Day 1 setup (folders, Worker skeleton, auth flow) is in this commit. Next:

- [ ] Port `extension/src/adjust-client.js` → `worker/src/adjust.ts`
- [ ] Wire `/api/roas` and `/api/today-revenue` to call Adjust + cache
- [ ] Day 2: rewrite extension popup (login UI), swap `adjust-client.js` for
      `proxy-client.js`, drop `host_permissions` for `automate.adjust.com`
- [ ] Day 3: end-to-end test with both bro's account and a UA member account
- [ ] Day 4: bundle/minify, publish to Chrome Web Store as Unlisted
- [ ] Day 5 (Mon): onboard 2 UA members
