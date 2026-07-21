// popup/popup.js
import { classifyAll, DEFAULT_THRESHOLDS } from '../src/decision-engine.js';

const $ = (id) => document.getElementById(id);

async function refreshStatus() {
  const cached = await chrome.runtime.sendMessage({ type: 'GET_CACHED' });
  if (!cached) {
    $('status').textContent = 'No data yet. Configure tokens below and Sync.';
    return;
  }
  const ageMin = Math.round(cached.ageMs / 60000);
  // Cached array now mixes 'campaign'- and 'ad'-level rows. Show counts of
  // each. Decision groups classify ad-level rows since ads are the unit the
  // user actually pauses/scales — campaign-level signal is in the pill UI.
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
    $('apiToken').value = dataSourceConfig?.apiToken || '';
    $('utcOffset').value = offsetLabelFor(dataSourceConfig?.utcOffset || '+07:00');
    $('accountTimezone').value = dataSourceConfig?.accountTimezone || '';
    $('datePeriod').value = dataSourceConfig?.datePeriod || 'rolling30';
    $('appTokens').value = dataSourceConfig?.appTokens || '';
  }
  syncPeriodButtons(dataSourceConfig?.datePeriod || 'rolling30');
}

async function saveCfg() {
  const cfg = {
    kind: 'adjust-direct',
    apiToken: $('apiToken').value.trim(),
    utcOffset: parseOffsetInput($('utcOffset').value),
    accountTimezone: $('accountTimezone').value.trim(),
    datePeriod: $('datePeriod').value.trim() || 'rolling30',
    appTokens: $('appTokens').value.trim(),
  };
  await chrome.storage.local.set({ dataSourceConfig: cfg });
  $('status').textContent = 'Config saved. Click Sync.';
  syncPeriodButtons(cfg.datePeriod);
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
  meta:   { cohort: 'pillCohort',   today: 'pillToday',   yesterday: 'pillYesterday' },
  tiktok: { cohort: 'ttPillCohort', today: 'ttPillToday', yesterday: 'ttPillYesterday' },
};
const DEFAULT_PILL_VIS = { cohort: true, today: true, yesterday: false };

function readPillVis(stored, platform) {
  const m = stored?.[platform] || {};
  return {
    cohort:    typeof m.cohort    === 'boolean' ? m.cohort    : DEFAULT_PILL_VIS.cohort,
    today:     typeof m.today     === 'boolean' ? m.today     : DEFAULT_PILL_VIS.today,
    yesterday: typeof m.yesterday === 'boolean' ? m.yesterday : DEFAULT_PILL_VIS.yesterday,
  };
}

function loadPillVisibility(prefetched) {
  for (const [platform, ids] of Object.entries(PILL_PLATFORMS)) {
    const v = readPillVis(prefetched, platform);
    $(ids.cohort).checked = v.cohort;
    $(ids.today).checked = v.today;
    $(ids.yesterday).checked = v.yesterday;
  }
}

function currentPillVis() {
  const out = {};
  for (const [platform, ids] of Object.entries(PILL_PLATFORMS)) {
    out[platform] = {
      cohort: $(ids.cohort).checked,
      today: $(ids.today).checked,
      yesterday: $(ids.yesterday).checked,
    };
  }
  return out;
}

async function savePillVisibility() {
  const stored = (await chrome.storage.local.get('pillVisibility')).pillVisibility;
  const prevYesterday = Object.keys(PILL_PLATFORMS)
    .some(p => readPillVis(stored, p).yesterday);
  const next = currentPillVis();
  const nextYesterday = Object.values(next).some(v => v.yesterday);

  await chrome.storage.local.set({ pillVisibility: next });
  // Yesterday OFF→ON needs the yesterday event-date report (only fetched when
  // at least one platform's toggle is on). Force a sync so the pill has data
  // immediately. Other toggles are pure client-side gating — the content
  // scripts re-decorate on the storage change without a refetch.
  if (nextYesterday && !prevYesterday) {
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

// Re-snap the offset field to its canonical city label once the user commits an
// edit (blur or datalist pick). Without this, hand-editing just the sign — e.g.
// flipping "+07:00 — Bangkok" to "-07:00" — leaves the stale cities showing,
// even though the saved value is correct. Snapping makes the zone unambiguous.
$('utcOffset').addEventListener('change', () => {
  $('utcOffset').value = offsetLabelFor($('utcOffset').value);
});
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
  populateUtcOffsetList();
  const [{ dataSourceConfig, colorThresholds, pillVisibility }] = await Promise.all([
    chrome.storage.local.get(['dataSourceConfig', 'colorThresholds', 'pillVisibility']),
    refreshStatus(),
  ]);
  loadCfg(dataSourceConfig);
  loadColorThresholds(colorThresholds);
  loadPillVisibility(pillVisibility);
})();
