// Cloudflare Worker entry point.
//
// Route map:
//   POST /auth/login          → { email, password } → { token, expiresAt }
//   GET  /api/whoami          → user info (requires Bearer JWT)
//   GET  /api/roas            → cohort ROAS (requires Bearer JWT)
//   GET  /api/today-revenue   → today's revenue (requires Bearer JWT)
//
// Secrets (wrangler secret put): ADJUST_API_TOKEN, JWT_SECRET, APP_TOKENS_JSON
// KV bindings (wrangler.toml):   USERS, CACHE, AUDIT
//
// CORS: reflect chrome-extension://<id> origins. Bearer auth (no cookies) so
// credentials mode never triggers preflight tightening.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { issueJwt, verifyJwt, verifyPassword, type JwtPayload } from './auth';
import { fetchCampaignROAS, fetchTodayGrossRevenue } from './adjust';
import { getOrFetch } from './cache';

export interface Env {
  ADJUST_API_TOKEN: string;
  JWT_SECRET: string;
  APP_TOKENS_JSON: string;
  USERS: KVNamespace;
  CACHE: KVNamespace;
  AUDIT: KVNamespace;
}

interface UserRecord {
  pwd_hash: string;
  role: 'admin' | 'user';
  allowed_apps: string[];   // app keys, or ['all']
}

type Variables = { user: JwtPayload };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', cors({
  origin: (origin) => (origin?.startsWith('chrome-extension://') ? origin : null),
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// Fail fast on missing secrets so misconfigured deploys surface as a clean
// 500 with a clear message rather than as deep errors from the JWT/Adjust
// libraries. Runs once per request — cheap and avoids module-load surprises.
app.use('*', async (c, next) => {
  const missing: string[] = [];
  if (!c.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!c.env.ADJUST_API_TOKEN) missing.push('ADJUST_API_TOKEN');
  if (!c.env.APP_TOKENS_JSON) missing.push('APP_TOKENS_JSON');
  if (missing.length) return c.json({ error: `MISCONFIGURED: missing secret(s) ${missing.join(', ')}` }, 500);
  await next();
});

// ---- Auth ----

app.post('/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>()
    .catch(() => ({} as { email?: string; password?: string }));
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? '';
  if (!email || !password) return c.json({ error: 'EMAIL_AND_PASSWORD_REQUIRED' }, 400);

  const raw = await c.env.USERS.get(email);
  if (!raw) {
    // Constant-time-ish: still hash the password to avoid leaking which emails exist.
    await verifyPassword(password, 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    return c.json({ error: 'INVALID_CREDENTIALS' }, 401);
  }
  const user = JSON.parse(raw) as UserRecord;
  const ok = await verifyPassword(password, user.pwd_hash);
  if (!ok) return c.json({ error: 'INVALID_CREDENTIALS' }, 401);

  const { token, expiresAt } = await issueJwt(c.env.JWT_SECRET, {
    sub: email,
    role: user.role,
    apps: user.allowed_apps,
  });
  audit(c, email, 'login_ok');
  return c.json({ token, expiresAt, email, role: user.role });
});

// ---- Auth middleware for /api/* ----

app.use('/api/*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return c.json({ error: 'MISSING_BEARER' }, 401);
  const payload = await verifyJwt(c.env.JWT_SECRET, token);
  if (!payload) return c.json({ error: 'INVALID_TOKEN' }, 401);
  c.set('user', payload);
  await next();
});

app.get('/api/whoami', (c) => {
  const u = c.get('user');
  return c.json({ email: u.sub, role: u.role, apps: u.apps, exp: u.exp });
});

// ---- Adjust proxy endpoints ----
//
// Server resolves which app tokens to query from the user's `allowed_apps`
// (KV) intersected with the APP_TOKENS_JSON server map. Caller never names
// tokens — prevents a JWT-stealing attacker from widening their app scope.
//
// 5-min KV cache keyed on (user|endpoint|period|appTokens). User-scoped
// because two users with different `allowed_apps` would otherwise see each
// other's filtered data.

app.get('/api/roas', async (c) => {
  const u = c.get('user');
  const period = c.req.query('period') || 'rolling30';
  const utcOffset = c.req.query('utcOffset') || '+07:00';
  let appTokens: string;
  try {
    appTokens = resolveAppTokens(c.env.APP_TOKENS_JSON, u.apps);
  } catch (err) {
    audit(c, u.sub, 'roas_misconfig');
    return c.json({ error: errMsg(err) }, 500);
  }

  try {
    const { data, fromCache } = await getOrFetch(
      c.executionCtx,
      c.env.CACHE,
      ['roas', u.sub, period, utcOffset, appTokens],
      () => fetchCampaignROAS({
        apiToken: c.env.ADJUST_API_TOKEN,
        utcOffset,
        datePeriod: period,
        appTokens,
      }),
    );
    audit(c, u.sub, fromCache ? 'roas_cache' : 'roas_fresh');
    return c.json({ rows: data, fromCache });
  } catch (err) {
    audit(c, u.sub, 'roas_error');
    return c.json({ error: errMsg(err) }, 502);
  }
});

app.get('/api/today-revenue', async (c) => {
  const u = c.get('user');
  const utcOffset = c.req.query('utcOffset') || '+07:00';
  let appTokens: string;
  try {
    appTokens = resolveAppTokens(c.env.APP_TOKENS_JSON, u.apps);
  } catch (err) {
    audit(c, u.sub, 'today_misconfig');
    return c.json({ error: errMsg(err) }, 500);
  }

  try {
    const { data, fromCache } = await getOrFetch(
      c.executionCtx,
      c.env.CACHE,
      ['today', u.sub, utcOffset, appTokens],
      () => fetchTodayGrossRevenue({
        apiToken: c.env.ADJUST_API_TOKEN,
        utcOffset,
        appTokens,
      }),
    );
    audit(c, u.sub, fromCache ? 'today_cache' : 'today_fresh');
    return c.json({ rows: data, fromCache });
  } catch (err) {
    audit(c, u.sub, 'today_error');
    return c.json({ error: errMsg(err) }, 502);
  }
});

// Resolve user.apps (['all'] or ['decoai','chatify']) → comma-separated
// Adjust app_token__in string. Throws on malformed APP_TOKENS_JSON to fail
// closed — silently returning '' would let Adjust serve every app in the
// account regardless of the user's scope (security: scope bypass).
//
// Unknown app keys in user record are silently dropped, not thrown — keeps
// adding/removing apps to the env map a non-breaking change.
function resolveAppTokens(jsonStr: string, allowedApps: string[]): string {
  let map: Record<string, string>;
  try {
    map = JSON.parse(jsonStr) as Record<string, string>;
  } catch {
    throw new Error('APP_TOKENS_JSON is not valid JSON; refusing to call Adjust');
  }
  const wantsAll = allowedApps.includes('all');
  const tokens: string[] = [];
  for (const [key, token] of Object.entries(map)) {
    if (wantsAll || allowedApps.includes(key)) {
      if (token) tokens.push(token);
    }
  }
  return tokens.join(',');
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---- Health ----

app.get('/', (c) => c.text('adjust-roas-proxy ok'));

// ---- Helpers ----

// Fire-and-forget audit log: caller doesn't await, the Worker keeps the
// request alive via waitUntil while the KV PUT lands. Saves ~50ms p50 off
// every endpoint response.
function audit(c: { executionCtx: ExecutionContext; env: Env; req: { raw: Request } }, email: string, action: string): void {
  const r = c.req.raw;
  const ip = r.headers.get('cf-connecting-ip') ?? 'unknown';
  const url = new URL(r.url);
  const key = `${Date.now()}|${email}|${action}`;
  const value = JSON.stringify({
    ts: Date.now(),
    email,
    ip,
    action,
    path: url.pathname + url.search,
    ua: r.headers.get('user-agent') ?? '',
  });
  // 90-day retention. At 2 users × 400 req/day = ~72k entries / 90d, well
  // within KV free tier (1GB storage).
  c.executionCtx.waitUntil(
    c.env.AUDIT.put(key, value, { expirationTtl: 90 * 24 * 60 * 60 })
  );
}

export default app;
