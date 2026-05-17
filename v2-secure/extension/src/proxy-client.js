// src/proxy-client.js
//
// All network calls go through the Cloudflare Worker proxy. The extension
// never sees the Adjust API token or app tokens — those live as Worker
// secrets. Only artifact stored client-side is a short-lived JWT (7-day exp)
// in chrome.storage.local.
//
// Replaces the old adjust-client.js wholesale. Same return shapes for
// fetchCampaignROAS / fetchTodayGrossRevenue so data-source.js + injectors
// don't need changes downstream.

const PROXY_URL = 'https://adjust-roas-proxy.extension-secure.workers.dev';

const STORAGE_KEYS = {
  token: 'authToken',
  email: 'authEmail',
  role: 'authRole',
  exp: 'authExp',
};

// ---- Authed fetch ----

async function authedFetch(path) {
  const { [STORAGE_KEYS.token]: token } = await chrome.storage.local.get(STORAGE_KEYS.token);
  if (!token) throw new Error('NOT_LOGGED_IN');

  let res;
  try {
    res = await fetch(`${PROXY_URL}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new Error(`Proxy unreachable: ${err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    // JWT invalid/expired (401) or scope revoked server-side (403) — either
    // way the stored token is useless; clear it so the popup falls back to
    // the login UI on the next render pass.
    await clearAuth();
    throw new Error('SESSION_EXPIRED');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Proxy ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---- Public API (matches old adjust-client.js shape) ----

export async function fetchCampaignROAS({ datePeriod = 'rolling30', utcOffset = '+07:00' } = {}) {
  const params = new URLSearchParams({ period: datePeriod, utcOffset });
  const result = await authedFetch(`/api/roas?${params}`);
  // Server wraps rows in { rows, fromCache } — unwrap to keep the
  // signature byte-compatible with the old direct client.
  return result.rows ?? [];
}

export async function fetchTodayGrossRevenue({ utcOffset = '+07:00' } = {}) {
  const params = new URLSearchParams({ utcOffset });
  const result = await authedFetch(`/api/today-revenue?${params}`);
  return result.rows ?? [];
}

// ---- Auth ----

export async function login(email, password) {
  let res;
  try {
    res = await fetch(`${PROXY_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
  } catch (err) {
    throw new Error(`Proxy unreachable: ${err.message}`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(data.error || `LOGIN_FAILED (${res.status})`);
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.token]: data.token,
    [STORAGE_KEYS.email]: data.email,
    [STORAGE_KEYS.role]: data.role,
    [STORAGE_KEYS.exp]: data.expiresAt,
  });
  return data;
}

export async function logout() {
  await clearAuth();
  // Also drop the cached campaign data so the next user (or next login) doesn't
  // see leftover rows from the previous session.
  await chrome.storage.local.remove('campaignDataCache');
}

async function clearAuth() {
  await chrome.storage.local.remove(Object.values(STORAGE_KEYS));
}

export async function getAuthState() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  const token = stored[STORAGE_KEYS.token];
  const exp = stored[STORAGE_KEYS.exp];
  // Treat tokens within 60s of expiry as already expired, so the popup
  // forces a fresh login instead of issuing requests that will 401.
  const expired = exp != null && Date.now() / 1000 > exp - 60;
  if (token && expired) {
    await clearAuth();
    return { loggedIn: false };
  }
  return {
    loggedIn: !!token,
    email: stored[STORAGE_KEYS.email] ?? null,
    role: stored[STORAGE_KEYS.role] ?? null,
    exp: exp ?? null,
  };
}
