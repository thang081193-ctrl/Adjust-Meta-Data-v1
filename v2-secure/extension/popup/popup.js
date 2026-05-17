// popup/popup.js — v2-secure variant
//
// Two UI states:
//   - loginPanel  : when no JWT in storage (or expired)
//   - mainPanel   : after successful login — period buttons, sync, groups, thresholds
//
// Settings (apiToken / appTokens / customDatePeriod) are GONE — those live
// server-side. Only client-side prefs remaining: chosen period (one of the
// preset buttons) and color thresholds.

import { classifyAll, DEFAULT_THRESHOLDS } from '../src/decision-engine.js';
import { login, logout, getAuthState } from '../src/proxy-client.js';

const $ = (id) => document.getElementById(id);

// ---- Auth state UI switching ----

async function renderAuthState() {
  const auth = await getAuthState();
  // Banner name reflects current session — placeholder when nobody's signed in.
  $('bannerUaName').textContent = auth.loggedIn ? auth.email : '<Tên UA>';
  if (auth.loggedIn) {
    $('loginPanel').style.display = 'none';
    $('mainPanel').style.display = 'block';
    $('whoLabel').textContent = `Signed in as ${auth.email}`;
    await refreshStatus();
  } else {
    $('loginPanel').style.display = 'block';
    $('mainPanel').style.display = 'none';
    // Move focus into email field for fast keyboard-only login
    setTimeout(() => $('loginEmail').focus(), 30);
  }
}

async function doLogin() {
  $('loginError').style.display = 'none';
  $('loginBtn').disabled = true;
  try {
    await login($('loginEmail').value, $('loginPwd').value);
    $('loginPwd').value = '';
    await renderAuthState();
  } catch (err) {
    $('loginError').style.display = 'block';
    $('loginError').textContent = friendlyAuthError(err.message);
  } finally {
    $('loginBtn').disabled = false;
  }
}

function friendlyAuthError(msg) {
  if (msg.includes('INVALID_CREDENTIALS')) return 'Wrong email or password.';
  if (msg.includes('Proxy unreachable')) return 'Cannot reach the proxy server. Check your connection.';
  if (msg.includes('LOGIN_FAILED')) return 'Login failed. Try again or contact admin.';
  return msg;
}

async function doLogout() {
  await logout();
  await renderAuthState();
}

// ---- Sync / status (largely unchanged from v0.3.0) ----

async function refreshStatus() {
  const cached = await chrome.runtime.sendMessage({ type: 'GET_CACHED' });
  if (!cached) {
    // First-run after login: trigger an automatic sync so the user doesn't
    // see an empty UI and assume the extension is broken. doSync handles
    // its own error path; we don't await so the popup paints immediately.
    $('status').textContent = 'Fetching first sync…';
    doSync(false);
    return;
  }
  const ageMin = Math.round(cached.ageMs / 60000);
  const campaignRows = cached.campaigns.filter(r => r.level === 'campaign');
  const adRows = cached.campaigns.filter(r => r.level === 'ad');
  $('status').textContent = `${campaignRows.length} campaigns · ${adRows.length} ads · synced ${ageMin}m ago${cached.isStale ? ' · STALE' : ''}`;
  renderGroups(adRows.length ? adRows : campaignRows);
}

function renderGroups(campaigns) {
  const groups = classifyAll(campaigns, DEFAULT_THRESHOLDS);
  const html = ['pause', 'scale', 'noisy', 'hold'].map(k => {
    const list = groups[k];
    return `<div class="group group-${k}"><strong>${k.toUpperCase()}</strong> (${list.length})</div>`;
  }).join('');
  $('groups').innerHTML = html;
}

async function doSync(force = false) {
  $('sync').disabled = true;
  $('forceSync').disabled = true;
  $('error').style.display = 'none';
  try {
    const result = await chrome.runtime.sendMessage({
      type: force ? 'FORCE_SYNC' : 'SYNC',
    });
    if (result?.error) throw new Error(result.error);
    await refreshStatus();
  } catch (err) {
    if (err.message.includes('SESSION_EXPIRED') || err.message.includes('NOT_LOGGED_IN')) {
      // Server kicked our token — drop back to login UI.
      await renderAuthState();
      return;
    }
    $('error').style.display = 'block';
    $('error').textContent = `Sync failed: ${err.message}`;
  } finally {
    $('sync').disabled = false;
    $('forceSync').disabled = false;
  }
}

// ---- Period selector (saved to chrome.storage so background.js sees it) ----

function syncPeriodButtons(currentPeriod) {
  const btns = $('periods').querySelectorAll('button');
  for (const b of btns) {
    b.classList.toggle('active', b.dataset.period === currentPeriod);
  }
}

async function pickPeriod(period) {
  const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
  const cfg = { ...(dataSourceConfig || {}), datePeriod: period };
  await chrome.storage.local.set({ dataSourceConfig: cfg });
  syncPeriodButtons(period);
  // Auto force-sync so pill numbers refresh to the new period immediately.
  doSync(true);
}

async function loadPeriod(prefetched) {
  const cfg = prefetched !== undefined
    ? prefetched
    : (await chrome.storage.local.get('dataSourceConfig')).dataSourceConfig;
  syncPeriodButtons(cfg?.datePeriod || 'rolling30');
}

// ---- Color thresholds (unchanged from v0.3.0) ----

const DEFAULT_COLOR_THRESHOLDS = {
  meta:   { pause: 0.30, red: 0.60, green: 1.00 },
  tiktok: { pause: 0.30, red: 0.60, green: 1.00 },
};

async function loadColorThresholds(prefetched) {
  const stored = prefetched !== undefined
    ? prefetched
    : (await chrome.storage.local.get('colorThresholds')).colorThresholds;
  const t = mergeThresholds(stored);
  $('metaPause').value   = pctOf(t.meta.pause);
  $('metaRed').value     = pctOf(t.meta.red);
  $('metaGreen').value   = pctOf(t.meta.green);
  $('tiktokPause').value = pctOf(t.tiktok.pause);
  $('tiktokRed').value   = pctOf(t.tiktok.red);
  $('tiktokGreen').value = pctOf(t.tiktok.green);
}

async function saveColorThresholds() {
  const cfg = {
    meta: {
      pause: pctParse($('metaPause').value),
      red:   pctParse($('metaRed').value),
      green: pctParse($('metaGreen').value),
    },
    tiktok: {
      pause: pctParse($('tiktokPause').value),
      red:   pctParse($('tiktokRed').value),
      green: pctParse($('tiktokGreen').value),
    },
  };
  await chrome.storage.local.set({ colorThresholds: cfg });
  $('status').textContent = 'Color thresholds saved.';
}

function mergeThresholds(stored) {
  const m = stored?.meta || {};
  const t = stored?.tiktok || {};
  return {
    meta: {
      pause: numOr(m.pause, DEFAULT_COLOR_THRESHOLDS.meta.pause),
      red:   numOr(m.red,   DEFAULT_COLOR_THRESHOLDS.meta.red),
      green: numOr(m.green, DEFAULT_COLOR_THRESHOLDS.meta.green),
    },
    tiktok: {
      pause: numOr(t.pause, DEFAULT_COLOR_THRESHOLDS.tiktok.pause),
      red:   numOr(t.red,   DEFAULT_COLOR_THRESHOLDS.tiktok.red),
      green: numOr(t.green, DEFAULT_COLOR_THRESHOLDS.tiktok.green),
    },
  };
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function pctOf(decimal) { return Math.round(decimal * 100).toString(); }
function pctParse(raw) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.max(0, n) / 100 : 0;
}

// ---- Wiring ----

$('loginBtn').addEventListener('click', doLogin);
$('loginPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('loginEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginPwd').focus(); });
$('logoutBtn').addEventListener('click', doLogout);
$('sync').addEventListener('click', () => doSync(false));
$('forceSync').addEventListener('click', () => doSync(true));
$('saveThresholds').addEventListener('click', saveColorThresholds);
for (const btn of $('periods').querySelectorAll('button')) {
  btn.addEventListener('click', () => pickPeriod(btn.dataset.period));
}

// Bootstrap: prefetch shared storage in one round trip, then render auth state.
(async function bootstrap() {
  const stored = await chrome.storage.local.get(['dataSourceConfig', 'colorThresholds']);
  loadPeriod(stored.dataSourceConfig);
  loadColorThresholds(stored.colorThresholds);
  await renderAuthState();
})();
