// popup/popup.js
import { classifyAll, DEFAULT_THRESHOLDS } from '../src/decision-engine.js';
import {
  ALL_ACCOUNTS,
  MAX_ACCOUNTS,
  makeBlankAccount,
  normalizeAccounts,
} from '../src/accounts.js';

const $ = (id) => document.getElementById(id);

// Build stamp. MUST match WORKER_BUILD in background.js — see the comment there
// for why a popup and a service worker end up on different builds after a git
// pull (Chrome re-reads this file on every open; the worker only on Reload).
const POPUP_BUILD = 'v0.12.5';

// Returns true when the service worker is running the same build as this popup.
// On mismatch it takes over the error box and the caller must NOT sync: no
// amount of Force refresh fixes a stale worker, and letting the old worker run
// would overwrite an accurate diagnosis with plausible-looking wrong numbers
// (2026-09-18: a v0.9.8 worker under this popup showed the wrong Adjust
// account's row for a migrated app and doubled D-2 spend — no error anywhere).
async function checkWorkerBuild() {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'GET_BUILD' });
  } catch (err) {
    res = { error: err.message };
  }
  if (res && !res.error && res.build === POPUP_BUILD) return true;

  const worker = res?.build || 'cũ hơn v0.12.4 (không trả lời GET_BUILD)';
  console.warn(
    `[Adjust Overlay] build mismatch — popup ${POPUP_BUILD}, service worker ${worker}. ` +
    'Reload extension để service worker nạp code mới.'
  );
  $('error').style.display = 'block';
  // Multi-line message. Every segment is ONE template literal ending in an
  // explicit \n escape. A single-quoted string CANNOT contain a raw newline,
  // and the version of this block that did (v0.12.2, 2026-09-18) was a parse
  // error that killed the WHOLE module: popup stuck on "Loading…" with an
  // empty Adjust dropdown and no version stamp, because a SyntaxError means
  // not one line of popup.js ever runs. See
  // docs/findings/debug_trap_popup_module_parse_error.md.
  $('error').textContent =
    `⚠ Service worker đang chạy build ${worker}, còn popup là ${POPUP_BUILD}.\n` +
    `Chrome chỉ nạp lại service worker khi RELOAD extension — popup và injector thì đọc code mới mỗi lần mở.\n` +
    `Vào chrome://extensions → bấm Reload ở card extension → mở lại popup → Force refresh.\n` +
    `Ở trạng thái này số trên pill KHÔNG tin được: worker cũ không gộp 2 Adjust account ` +
    `(app có ở cả 2 account sẽ hiện row của account sai và spend D-1/D-2 bị nhân đôi).`;
  return false;
}

// In-memory mirror of dataSourceConfig.accounts. The account cards are built
// from this, and every edit writes straight back to storage — there is no
// separate "Save" for accounts because a half-saved token list is the one state
// that makes the extension look broken for reasons the user can't see.
let accounts = [];
let activeAccountId = ALL_ACCOUNTS;

async function refreshStatus() {
  const cached = await chrome.runtime.sendMessage({ type: 'GET_CACHED' });
  if (!cached) {
    $('status').textContent = 'No data yet. Configure tokens below and Sync.';
    $('warnings').style.display = 'none';
    renderAccountStatus(null);
    return;
  }
  renderSyncWarnings(cached.syncWarnings);
  renderAccountStatus(cached.accountsStatus);
  renderMergeStats(cached.mergeStats);
  const ageMin = Math.round(cached.ageMs / 60000);
  // Cached array now mixes 'campaign'- and 'ad'-level rows. Show counts of
  // each. Decision groups classify ad-level rows since ads are the unit the
  // user actually pauses/scales — campaign-level signal is in the pill UI.
  const campaignRows = cached.campaigns.filter(r => r.level === 'campaign');
  const adRows = cached.campaigns.filter(r => r.level === 'ad');
  $('status').textContent = `${campaignRows.length} campaigns · ${adRows.length} ads · synced ${ageMin}m ago${cached.isStale ? ' · STALE' : ''}`;
  renderGroups(adRows.length ? adRows : campaignRows);
}

// Partial-sync banner. background.js caches whatever pipelines succeeded and
// records the failed ones in syncWarnings — per the "never fail silently"
// rule, partial data must always be labeled as partial.
function renderSyncWarnings(warnings) {
  const el = $('warnings');
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.textContent =
    '⚠ Partial sync — some Adjust reports failed (pills for them show dashes):\n' +
    list.map((w) => `• ${w}`).join('\n') +
    '\nRetry with Force refresh.';
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
    // Refuse to sync through a stale worker — see checkWorkerBuild.
    if (!(await checkWorkerBuild())) return;
    const result = await chrome.runtime.sendMessage({
      type: force ? 'FORCE_SYNC' : 'SYNC',
    });
    if (result?.error) throw new Error(result.error);
    // No tabs.query / tabs.sendMessage needed — content script subscribes to
    // chrome.storage.onChanged and reloads automatically when background
    // writes the new cache. Keeps the extension free of any facebook.com
    // permissions beyond the content_scripts match.
    await refreshStatus();
  } catch (err) {
    $('error').style.display = 'block';
    $('error').textContent = `Sync failed: ${err.message}`;
  } finally {
    $('sync').disabled = false;
    $('forceSync').disabled = false;
  }
}

// Source of truth for the UTC-offset searchable dropdown. Each entry pairs the
// canonical Adjust offset (stored & sent to the API) with a human label that
// also lists major cities so the user can search by place name. The datalist
// option VALUE is the full label, so typing "Bangkok" or "+07" both filter to
// the right row; saveCfg() re-extracts the bare ±HH:MM before persisting.
const UTC_OFFSETS = [
  { off: '-11:00', label: '-11:00 — Pago Pago, Midway' },
  { off: '-10:00', label: '-10:00 — Honolulu (HST)' },
  { off: '-09:00', label: '-09:00 — Anchorage (AKST)' },
  { off: '-08:00', label: '-08:00 — Los Angeles, Vancouver (PT)' },
  { off: '-07:00', label: '-07:00 — Denver, Phoenix (MT)' },
  { off: '-06:00', label: '-06:00 — Chicago, Mexico City (CT)' },
  { off: '-05:00', label: '-05:00 — New York, Toronto, Lima (ET)' },
  { off: '-04:00', label: '-04:00 — Santiago, Halifax, Caracas' },
  { off: '-03:00', label: '-03:00 — São Paulo, Buenos Aires' },
  { off: '-01:00', label: '-01:00 — Azores, Cape Verde' },
  { off: '+00:00', label: '+00:00 — London, Lisbon, Accra (GMT)' },
  { off: '+01:00', label: '+01:00 — Berlin, Paris, Madrid, Lagos (CET)' },
  { off: '+02:00', label: '+02:00 — Cairo, Athens, Johannesburg (EET)' },
  { off: '+03:00', label: '+03:00 — Moscow, Istanbul, Riyadh, Nairobi' },
  { off: '+03:30', label: '+03:30 — Tehran' },
  { off: '+04:00', label: '+04:00 — Dubai, Baku, Tbilisi' },
  { off: '+04:30', label: '+04:30 — Kabul' },
  { off: '+05:00', label: '+05:00 — Karachi, Tashkent' },
  { off: '+05:30', label: '+05:30 — New Delhi, Mumbai, Colombo (IST)' },
  { off: '+05:45', label: '+05:45 — Kathmandu' },
  { off: '+06:00', label: '+06:00 — Dhaka, Almaty' },
  { off: '+06:30', label: '+06:30 — Yangon' },
  { off: '+07:00', label: '+07:00 — Bangkok, Hanoi, Jakarta (ICT)' },
  { off: '+08:00', label: '+08:00 — Singapore, Beijing, Manila, Taipei, Perth' },
  { off: '+09:00', label: '+09:00 — Tokyo, Seoul (JST/KST)' },
  { off: '+09:30', label: '+09:30 — Adelaide, Darwin' },
  { off: '+10:00', label: '+10:00 — Sydney, Brisbane (AEST)' },
  { off: '+11:00', label: '+11:00 — Nouméa, Solomon Is.' },
  { off: '+12:00', label: '+12:00 — Auckland, Fiji' },
  { off: '+13:00', label: "+13:00 — Apia, Nuku'alofa" },
  { off: '+14:00', label: '+14:00 — Kiritimati' },
];

function populateUtcOffsetList() {
  const dl = $('utcOffsetList');
  if (!dl) return;
  dl.replaceChildren();
  for (const o of UTC_OFFSETS) {
    const opt = document.createElement('option');
    opt.value = o.label;
    dl.appendChild(opt);
  }
}

// Extract a canonical ±HH:MM from whatever the field holds — a picked rich
// label ("+07:00 — Bangkok …"), a bare offset, or a sloppily typed "+7:0".
// Falls back to +07:00 (BKT) when nothing parseable is present.
function parseOffsetInput(raw) {
  const m = String(raw || '').match(/([+-])(\d{1,2}):?(\d{2})/);
  if (!m) return '+07:00';
  const h = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${m[1]}${h}:${m[3]}`;
}

// Map a stored offset back to its rich label for display, so the field shows
// city context on reopen. Unknown offsets (e.g. a hand-typed +05:15) show raw.
function offsetLabelFor(off) {
  const norm = parseOffsetInput(off);
  const found = UTC_OFFSETS.find((o) => o.off === norm);
  return found ? found.label : norm;
}

async function loadCfg(prefetched) {
  const dataSourceConfig = prefetched !== undefined
    ? prefetched
    : (await chrome.storage.local.get('dataSourceConfig')).dataSourceConfig;
  if (dataSourceConfig?.kind === 'adjust-direct' || !dataSourceConfig) {
    $('utcOffset').value = offsetLabelFor(dataSourceConfig?.utcOffset || '+07:00');
    $('accountTimezone').value = dataSourceConfig?.accountTimezone || '';
    $('datePeriod').value = dataSourceConfig?.datePeriod || 'rolling30';
  }
  syncPeriodButtons(dataSourceConfig?.datePeriod || 'rolling30');
}

// Saves the SHARED settings only. Accounts have their own write path
// (persistAccounts) so a token edit is never lost by forgetting this button.
// The timezone fields (top of popup) also self-save via persistTimezone; this
// button re-reads the same two DOM elements, so re-saving them here is a no-op.
async function saveCfg() {
  const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
  const cfg = {
    ...(dataSourceConfig || {}),
    kind: 'adjust-direct',
    utcOffset: parseOffsetInput($('utcOffset').value),
    accountTimezone: $('accountTimezone').value.trim(),
    datePeriod: $('datePeriod').value.trim() || 'rolling30',
    accounts,
    activeAccountId,
  };
  // The pre-v0.10 top-level token fields are migrated into accounts[0] on load;
  // drop them here so a stale copy can never resurrect a retired token.
  delete cfg.apiToken;
  delete cfg.appTokens;
  await chrome.storage.local.set({ dataSourceConfig: cfg });
  $('status').textContent = 'Config saved. Click Sync.';
  syncPeriodButtons(cfg.datePeriod);
}

// The timezone box moved to the top of the popup (v0.12.1), outside the
// Settings <details>, so it can no longer lean on the Save-config button down
// there — a change must land in storage the moment it is committed.
//   utcOffset       : the utc_offset every Adjust report is queried with, so a
//                     change invalidates every cached row → force-sync.
//   accountTimezone : only feeds the injectors' Meta spend estimate; all three
//                     injectors re-read dataSourceConfig on storage change and
//                     repaint, so a plain save is enough — no refetch.
async function persistTimezone({ resync }) {
  const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
  const cfg = {
    ...(dataSourceConfig || {}),
    kind: 'adjust-direct',
    utcOffset: parseOffsetInput($('utcOffset').value),
    accountTimezone: $('accountTimezone').value.trim(),
  };
  delete cfg.apiToken;
  delete cfg.appTokens;
  await chrome.storage.local.set({ dataSourceConfig: cfg });
  console.log(
    `[AOX popup] timezone saved → utcOffset=${cfg.utcOffset} ` +
    `accountTimezone=${cfg.accountTimezone || '(same)'} resync=${resync}`,
  );
  if (resync) {
    $('status').textContent = `Adjust offset = ${cfg.utcOffset} — đang force-sync…`;
    doSync(true);
  } else {
    $('status').textContent =
      `Đã lưu Meta timezone (${cfg.accountTimezone || 'Same'}) — pill tự cập nhật.`;
  }
}

// ---- Adjust accounts ----
// The user's apps are split across more than one Adjust account, and an API
// token only ever sees its own account's apps. Each card is one account; the
// dropdown at the top picks which one(s) a sync pulls and the pills show.

async function persistAccounts({ resync = false, statusText = '' } = {}) {
  const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
  const cfg = {
    ...(dataSourceConfig || {}),
    kind: 'adjust-direct',
    accounts,
    activeAccountId,
  };
  delete cfg.apiToken;
  delete cfg.appTokens;
  await chrome.storage.local.set({ dataSourceConfig: cfg });
  if (resync) doSync(true);
  else if (statusText) $('status').textContent = statusText;
}

function renderAccountPicker() {
  const sel = $('activeAccount');
  sel.replaceChildren();
  // The merged option only makes sense with more than one account configured —
  // otherwise it is an identical duplicate of the single account's entry.
  if (accounts.length > 1) {
    const opt = document.createElement('option');
    opt.value = ALL_ACCOUNTS;
    opt.textContent = `Cả ${accounts.length} (gộp)`;
    sel.appendChild(opt);
  }
  for (const a of accounts) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.apiToken ? a.label : `${a.label} (chưa có token)`;
    sel.appendChild(opt);
  }
  // A stored selection pointing at a since-deleted account falls back to "all"
  // rather than to nothing: an empty fetch would look identical to Adjust being
  // down.
  if (activeAccountId !== ALL_ACCOUNTS && !accounts.some((a) => a.id === activeAccountId)) {
    activeAccountId = ALL_ACCOUNTS;
  }
  // With ONE account, "all" and "that account" are the same fetch, so the
  // dropdown shows the account while storage keeps 'all'. Pinning storage to
  // the single id would mean adding a second account later left the sync
  // silently single-account — the exact thing the user came here to fix.
  sel.value = (activeAccountId === ALL_ACCOUNTS && accounts.length === 1)
    ? accounts[0].id
    : activeAccountId;
}

function renderAccountCards() {
  const list = $('accountList');
  list.replaceChildren();
  for (const [i, a] of accounts.entries()) {
    const card = document.createElement('div');
    card.className = 'acct-card';

    const top = document.createElement('div');
    top.className = 'acct-card-top';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = a.label;
    nameInput.placeholder = `Adjust ${i + 1}`;
    nameInput.title = 'Tên hiển thị của account này (chỉ để phân biệt).';
    nameInput.addEventListener('change', () => {
      a.label = nameInput.value.trim() || `Adjust ${i + 1}`;
      nameInput.value = a.label;
      renderAccountPicker();
      persistAccounts({ statusText: 'Đã lưu tên account.' });
    });
    top.appendChild(nameInput);

    // Removing the last account would leave the popup with no card to type
    // into, so the button is disabled rather than hidden — a greyed control
    // explains itself, a missing one looks like a rendering bug.
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = accounts.length > 1
      ? `Xoá account "${a.label}"`
      : 'Không thể xoá account cuối cùng';
    del.disabled = accounts.length <= 1;
    del.addEventListener('click', () => {
      accounts = accounts.filter((x) => x.id !== a.id);
      if (activeAccountId === a.id) {
        activeAccountId = accounts.length > 1 ? ALL_ACCOUNTS : accounts[0].id;
      }
      renderAccountPicker();
      renderAccountCards();
      persistAccounts({ statusText: 'Đã xoá account. Bấm Sync để cập nhật.' });
    });
    top.appendChild(del);
    card.appendChild(top);

    card.appendChild(accountField({
      label: 'API token (Adjust → Account Settings → My profile)',
      type: 'password',
      value: a.apiToken,
      placeholder: 'Bearer token của account này',
      onChange: (v) => {
        a.apiToken = v;
        renderAccountPicker();
        persistAccounts({ statusText: 'Đã lưu token. Bấm Force refresh.' });
      },
    }));

    card.appendChild(accountField({
      label: 'App tokens của account này (comma-separated)',
      type: 'text',
      value: a.appTokens,
      placeholder: 'ví dụ lpz0c08fnitc,b6yjkg1hc7wg',
      title: 'Copy từ URL Adjust Datascape: app_token__in="...". Bỏ trống = tất cả app của account, dùng tracker filter mặc định (thường thiếu network mới như TikTok).',
      onChange: (v) => {
        a.appTokens = v;
        persistAccounts({ statusText: 'Đã lưu app tokens. Bấm Force refresh.' });
      },
    }));

    list.appendChild(card);
  }
  $('addAccount').disabled = accounts.length >= MAX_ACCOUNTS;
}

function accountField({ label, type, value, placeholder, title, onChange }) {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  const input = document.createElement('input');
  input.className = 'f';
  input.type = type;
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  if (title) input.title = title;
  input.addEventListener('change', () => onChange(input.value.trim()));
  wrap.appendChild(input);
  return wrap;
}

// Per-account outcome of the last sync (cache.accountsStatus, schema v9+).
// Rendered even when everything succeeded: seeing the row count per account is
// how the user confirms the account they just added is actually being pulled.
function renderAccountStatus(statusList) {
  const el = $('acctStatus');
  el.replaceChildren();
  if (!Array.isArray(statusList) || !statusList.length) {
    if (accounts.length > 1) {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = 'Chưa có kết quả theo từng account — bấm Sync.';
      el.appendChild(span);
    }
    return;
  }
  for (const st of statusList) {
    const div = document.createElement('div');
    div.className = st.ok ? 'ok' : 'bad';
    div.textContent = st.ok
      ? `✓ ${st.label} — ${st.rows} rows` +
        (st.warnings?.length ? ` (${st.warnings.length} report lỗi)` : '')
      : `✗ ${st.label} — ${st.error || 'fetch failed'}`;
    if (!st.ok && st.error) div.title = st.error;
    el.appendChild(div);
  }
}

// Cross-account merge outcome of the last sync (cache.mergeStats, schema v12+).
// Rendered under the per-account lines so a merged number is never silent: the
// user can see how many entities live in >1 account and how many of those are
// genuinely split (SDK traffic on both sides) right now.
function renderMergeStats(stats) {
  const el = $('acctStatus');
  if (!stats || !stats.merged) return;
  const div = document.createElement('div');
  div.className = 'muted';
  div.textContent =
    `⇄ ${stats.merged} entity có ở ≥2 account → gộp (revenue/installs cộng, spend lấy max)` +
    (stats.split
      ? ` · ${stats.split} đang chia traffic${stats.splitSamples?.length ? ` (vd: ${stats.splitSamples.slice(0, 2).join(' | ')})` : ''}`
      : '');
  div.title = 'Xem docs/findings/adjust_multi_account.md — rule gộp v0.12.2.';
  el.appendChild(div);
}

// Highlights whichever quick-period button matches the saved value, or none if
// the user is using a custom range (explicit date or non-button keyword).
function syncPeriodButtons(currentPeriod) {
  const btns = $('periods').querySelectorAll('button');
  for (const b of btns) {
    b.classList.toggle('active', b.dataset.period === currentPeriod);
  }
}

async function pickPeriod(period) {
  const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
  const cfg = {
    ...(dataSourceConfig || {}),
    kind: 'adjust-direct',
    datePeriod: period,
  };
  await chrome.storage.local.set({ dataSourceConfig: cfg });
  $('datePeriod').value = period;
  syncPeriodButtons(period);
  // Auto-trigger force sync so the pill numbers refresh immediately.
  doSync(true);
}

// ---- Color thresholds (per-platform) ----
// Stored as decimals (0.60 = 60%) under chrome.storage.local.colorThresholds.
// Pill background turns red when d7 < pause. Each segment value gets red text
// when below `red` or green text when above `green`. Defaults are tuned for
// app-marketing ROAS where d7 < 60% is "stop bleeding", 60-80% is acceptable
// while ramping, 80-99% is hold, 100%+ is breakeven/scale.
//
// Both platforms share one scale on purpose: the same campaign judged on the
// same d7 ROAS should get the same colour whichever table it is read in.
// Meta moved to this scale in v0.9.2 and TikTok followed — a split scale meant
// a 50% d7 campaign read red on Meta and neutral on TikTok, which is exactly
// the kind of inconsistency that erodes trust in the colour signal.
const DEFAULT_COLOR_THRESHOLDS = {
  meta:   { pause: 0.60, red: 0.80, green: 1.00 },
  tiktok: { pause: 0.60, red: 0.80, green: 1.00 },
  google: { pause: 0.60, red: 0.80, green: 1.00 },
};

async function loadColorThresholds(prefetched) {
  const colorThresholds = prefetched !== undefined
    ? prefetched
    : (await chrome.storage.local.get('colorThresholds')).colorThresholds;
  const t = mergeThresholds(colorThresholds);
  $('metaPause').value   = pctOf(t.meta.pause);
  $('metaRed').value     = pctOf(t.meta.red);
  $('metaGreen').value   = pctOf(t.meta.green);
  $('tiktokPause').value = pctOf(t.tiktok.pause);
  $('tiktokRed').value   = pctOf(t.tiktok.red);
  $('tiktokGreen').value = pctOf(t.tiktok.green);
  $('googlePause').value = pctOf(t.google.pause);
  $('googleRed').value   = pctOf(t.google.red);
  $('googleGreen').value = pctOf(t.google.green);
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
    google: {
      pause: pctParse($('googlePause').value),
      red:   pctParse($('googleRed').value),
      green: pctParse($('googleGreen').value),
    },
  };
  await chrome.storage.local.set({ colorThresholds: cfg });
  $('status').textContent = 'Color thresholds saved.';
}

function mergeThresholds(stored) {
  const m = stored?.meta || {};
  const t = stored?.tiktok || {};
  const g = stored?.google || {};
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
    google: {
      pause: numOr(g.pause, DEFAULT_COLOR_THRESHOLDS.google.pause),
      red:   numOr(g.red,   DEFAULT_COLOR_THRESHOLDS.google.red),
      green: numOr(g.green, DEFAULT_COLOR_THRESHOLDS.google.green),
    },
  };
}

// ---- Pill visibility (Meta + TikTok) ----
// Stored under chrome.storage.local.pillVisibility as one object namespaced by
// platform: { meta: {...}, tiktok: {...} }, three booleans each. Each content
// script gates its pill types on its own namespace; the Yesterday pill ALSO
// drives whether the background pulls the yesterday event-date report (see
// createDataSource), so enabling it on EITHER platform force-syncs to populate
// the data.
//
// Both platforms are written on every save. v0.9.1 wrote `{ meta: next }`,
// which whole-object-replaced the key — the moment a second platform existed
// that would silently wipe its settings on any Meta checkbox change. Reading
// both checkbox sets from the DOM (which loadPillVisibility already seeded
// from storage) keeps the write total and clobber-free.
const PILL_PLATFORMS = {
  meta:   { cohort: 'pillCohort',   today: 'pillToday',   yesterday: 'pillYesterday',   d2: 'pillD2' },
  tiktok: { cohort: 'ttPillCohort', today: 'ttPillToday', yesterday: 'ttPillYesterday', d2: 'ttPillD2' },
  google: { cohort: 'ggPillCohort', today: 'ggPillToday', yesterday: 'ggPillYesterday', d2: 'ggPillD2' },
};
const DEFAULT_PILL_VIS = { cohort: true, today: true, yesterday: false, d2: false };

function readPillVis(stored, platform) {
  const m = stored?.[platform] || {};
  return {
    cohort:    typeof m.cohort    === 'boolean' ? m.cohort    : DEFAULT_PILL_VIS.cohort,
    today:     typeof m.today     === 'boolean' ? m.today     : DEFAULT_PILL_VIS.today,
    yesterday: typeof m.yesterday === 'boolean' ? m.yesterday : DEFAULT_PILL_VIS.yesterday,
    d2:        typeof m.d2        === 'boolean' ? m.d2        : DEFAULT_PILL_VIS.d2,
  };
}

function loadPillVisibility(prefetched) {
  for (const [platform, ids] of Object.entries(PILL_PLATFORMS)) {
    const v = readPillVis(prefetched, platform);
    $(ids.cohort).checked = v.cohort;
    $(ids.today).checked = v.today;
    $(ids.yesterday).checked = v.yesterday;
    $(ids.d2).checked = v.d2;
  }
}

function currentPillVis() {
  const out = {};
  for (const [platform, ids] of Object.entries(PILL_PLATFORMS)) {
    out[platform] = {
      cohort: $(ids.cohort).checked,
      today: $(ids.today).checked,
      yesterday: $(ids.yesterday).checked,
      d2: $(ids.d2).checked,
    };
  }
  return out;
}

async function savePillVisibility() {
  const stored = (await chrome.storage.local.get('pillVisibility')).pillVisibility;
  const prevYesterday = Object.keys(PILL_PLATFORMS)
    .some(p => readPillVis(stored, p).yesterday);
  const prevD2 = Object.keys(PILL_PLATFORMS)
    .some(p => readPillVis(stored, p).d2);
  const next = currentPillVis();
  const nextYesterday = Object.values(next).some(v => v.yesterday);
  const nextD2 = Object.values(next).some(v => v.d2);

  await chrome.storage.local.set({ pillVisibility: next });
  // Yesterday / D-2 OFF→ON each needs its own event-date report (only fetched
  // when at least one platform's toggle is on). Force a sync so the newly
  // enabled pill has data immediately. Other toggles are pure client-side
  // gating — the content scripts re-decorate on the storage change without a
  // refetch.
  if ((nextYesterday && !prevYesterday) || (nextD2 && !prevD2)) {
    doSync(true);
  } else {
    $('status').textContent = 'Pill visibility saved.';
  }
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function pctOf(decimal) {
  return Math.round(decimal * 100).toString();
}
function pctParse(raw) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.max(0, n) / 100 : 0;
}

$('sync').addEventListener('click', () => doSync(false));
$('forceSync').addEventListener('click', () => doSync(true));
$('saveCfg').addEventListener('click', saveCfg);

// Switching account changes WHICH Adjust the sync pulls, so the cached rows are
// for the wrong account the instant the selection changes. Force-sync rather
// than leaving the previous account's pills on screen under a new label.
$('activeAccount').addEventListener('change', () => {
  // With a single account the dropdown has no "all" row, so picking the only
  // option still means "all" — see renderAccountPicker.
  activeAccountId = accounts.length > 1 ? $('activeAccount').value : ALL_ACCOUNTS;
  persistAccounts({ resync: true });
});

$('addAccount').addEventListener('click', () => {
  if (accounts.length >= MAX_ACCOUNTS) return;
  accounts = [...accounts, makeBlankAccount(accounts.length)];
  renderAccountPicker();
  renderAccountCards();
  // No resync: a brand-new account has no token yet, so fetching it could only
  // produce a 401. It joins the next sync once a token is pasted in.
  persistAccounts({ statusText: 'Thêm account mới — dán API token vào đó.' });
});

// Re-snap the offset field to its canonical city label once the user commits an
// edit (blur or datalist pick). Without this, hand-editing just the sign — e.g.
// flipping "+07:00 — Bangkok" to "-07:00" — leaves the stale cities showing,
// even though the saved value is correct. Snapping makes the zone unambiguous.
// Then persist + force-sync: the box lives at the top, with no Save button.
$('utcOffset').addEventListener('change', () => {
  $('utcOffset').value = offsetLabelFor($('utcOffset').value);
  persistTimezone({ resync: true });
});
$('accountTimezone').addEventListener('change', () => persistTimezone({ resync: false }));
$('saveThresholds').addEventListener('click', saveColorThresholds);

for (const btn of $('periods').querySelectorAll('button')) {
  btn.addEventListener('click', () => pickPeriod(btn.dataset.period));
}

for (const ids of Object.values(PILL_PLATFORMS)) {
  for (const id of Object.values(ids)) {
    $(id).addEventListener('change', savePillVisibility);
  }
}

// Batch the two storage reads + the GET_CACHED IPC into a single concurrent
// burst so the popup paints faster on open. Sequential awaits used to add
// 15-45ms of unnecessary IPC latency across three round trips.
(async function bootstrap() {
  // Build stamp in the header so a stale popup is visible at a glance. This is
  // the popup's OWN constant, not the manifest: the manifest can be re-parsed
  // (browser restart) while the worker is not, so the two must be compared as
  // two independent constants (see checkWorkerBuild).
  $('ver').textContent = POPUP_BUILD;
  const manifestVer = `v${chrome.runtime.getManifest().version}`;
  if (manifestVer !== POPUP_BUILD) {
    console.warn(`[Adjust Overlay] popup ${POPUP_BUILD} but manifest ${manifestVer} — bump both together.`);
  }
  // Checklog: one line per popup open. If this is absent from the popup's
  // devtools console, popup.js did not run at all (module parse error) and
  // nothing below — including the Adjust dropdown — was ever built.
  console.info(`[Adjust Overlay] popup ${POPUP_BUILD} booted (manifest ${manifestVer})`);
  // Handshake first: if the worker is stale, every number below it is suspect.
  checkWorkerBuild();
  populateUtcOffsetList();
  // refreshStatus() talks to the service worker. If the worker is dead or
  // mid-restart, sendMessage REJECTS — and before v0.12.3 that rejection took
  // the whole bootstrap down with it, leaving the popup on "Loading…" with an
  // empty Adjust dropdown and no clue why. Catch it here so the account picker
  // and every settings field still render: a token list the user cannot see is
  // indistinguishable from a token list that is gone.
  const [{ dataSourceConfig, colorThresholds, pillVisibility }] = await Promise.all([
    chrome.storage.local.get(['dataSourceConfig', 'colorThresholds', 'pillVisibility']),
    refreshStatus().catch((err) => {
      console.error('[Adjust Overlay] refreshStatus failed —', err);
      $('status').textContent = `Không đọc được cache từ service worker: ${err.message}`;
    }),
  ]);
  // Accounts first: renderAccountStatus (already called by refreshStatus) reads
  // `accounts.length`, and loadCfg no longer owns the token fields.
  accounts = normalizeAccounts(dataSourceConfig);
  activeAccountId = dataSourceConfig?.activeAccountId || ALL_ACCOUNTS;
  renderAccountPicker();
  renderAccountCards();
  // Persist the migration result (pre-v0.10 single-token config -> accounts[])
  // so the next sync reads the new shape even if the user never opens Settings.
  if (!Array.isArray(dataSourceConfig?.accounts)) {
    await persistAccounts();
  }
  loadCfg(dataSourceConfig);
  loadColorThresholds(colorThresholds);
  loadPillVisibility(pillVisibility);
  // Re-render account status now that `accounts` is populated: the call inside
  // refreshStatus ran before migration, so a first-run popup would otherwise
  // show nothing where the per-account lines belong.
  const cached = await chrome.runtime
    .sendMessage({ type: 'GET_CACHED' })
    .catch(() => null);
  renderAccountStatus(cached?.accountsStatus);
  renderMergeStats(cached?.mergeStats);
})().catch((err) => {
  // Last-resort net. A throw past this point used to be silent: the popup just
  // stopped painting. Surface it in the error box so the next bug of this shape
  // is one screenshot away from a diagnosis instead of a console dive.
  console.error('[Adjust Overlay] popup bootstrap failed —', err);
  const box = document.getElementById('error');
  if (box) {
    box.style.display = 'block';
    box.textContent = `⚠ Popup bootstrap lỗi: ${err.message}\nMở devtools của popup (chuột phải vào popup → Inspect) để xem stack.`;
  }
});
