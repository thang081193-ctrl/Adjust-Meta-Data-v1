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

async function loadCfg() {
  const { dataSourceConfig } = await chrome.storage.local.get('dataSourceConfig');
  if (dataSourceConfig?.kind === 'adjust-direct' || !dataSourceConfig) {
    $('apiToken').value = dataSourceConfig?.apiToken || '';
    $('utcOffset').value = dataSourceConfig?.utcOffset || '+07:00';
    $('datePeriod').value = dataSourceConfig?.datePeriod || 'rolling30';
  }
  syncPeriodButtons(dataSourceConfig?.datePeriod || 'rolling30');
}

async function saveCfg() {
  const cfg = {
    kind: 'adjust-direct',
    apiToken: $('apiToken').value.trim(),
    utcOffset: $('utcOffset').value.trim() || '+07:00',
    datePeriod: $('datePeriod').value.trim() || 'rolling30',
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

$('sync').addEventListener('click', () => doSync(false));
$('forceSync').addEventListener('click', () => doSync(true));
$('saveCfg').addEventListener('click', saveCfg);

for (const btn of $('periods').querySelectorAll('button')) {
  btn.addEventListener('click', () => pickPeriod(btn.dataset.period));
}

loadCfg();
refreshStatus();
