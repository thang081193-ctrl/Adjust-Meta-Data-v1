// src/data-source.js
// Adapter pattern. Today: pulls direct from the Adjust API.
// Later (when JM-AM exits soak): swap to JmAmDataSource without touching anything else.
//
// v0.10 — MULTI-ACCOUNT. The user's apps live in more than one Adjust account
// (some migrated from an older account, some created in the newer one). An
// Adjust API token can only see the apps of the account that minted it, so one
// token can never cover every campaign in Ads Manager. AdjustDirectDataSource
// now fans a sync out across every SELECTED account and merges the rows into
// the single flat array the injectors already consume — so neither content
// script needed to learn about accounts.

import {
  fetchCampaignROAS,
  fetchTodayGrossRevenue,
  fetchYesterdayGrossRevenue,
  fetchD2GrossRevenue,
} from './adjust-client.js';
import { canonicalKey } from './matcher.js';
import { resolveActiveAccounts, describeSelection } from './accounts.js';

/**
 * Common interface every data source must implement.
 *   fetchAll(): Promise<{
 *     campaigns: Array<Row>,          // rows tagged with accountId/accountLabel
 *     warnings: string[],             // per-pipeline fetch failures survived by partial sync
 *     accountsStatus: Array<{id, label, ok, rows, warnings, error}>,
 *   }>
 * (Legacy sources returning a bare array are still normalized by background.js.)
 */

export class AdjustDirectDataSource {
  constructor({
    accounts = [],
    utcOffset,
    datePeriod,
    fetchYesterday = false,
    fetchD2 = false,
    selectionLabel = '',
  }) {
    this.accounts = accounts;
    this.utcOffset = utcOffset;
    this.datePeriod = datePeriod;
    // Only pull the yesterday / D-2 event-date reports when the corresponding
    // pill is enabled (set from pillVisibility in createDataSource). Saves one
    // multi-level report call per sync PER ACCOUNT per disabled pill.
    this.fetchYesterday = fetchYesterday;
    this.fetchD2 = fetchD2;
    this.selectionLabel = selectionLabel;
    this.lastMergeStats = null;
  }

  async fetchAll() {
    if (!this.accounts.length) {
      throw new Error(
        'No Adjust account with an API token. Open the popup → Settings → Adjust accounts.'
      );
    }

    // Accounts fan out in parallel, and fetchAdjustRows gates concurrency PER
    // API token (MAX_CONCURRENT each): the 500-timeout that cap guards against
    // is per-account — each account has its own report generator — so two
    // accounts genuinely run side by side at single-account speed instead of
    // queueing through one shared gate.
    const results = await Promise.all(
      this.accounts.map((acct) => this.fetchAccount(acct))
    );

    const warnings = [];
    const accountsStatus = [];
    const allRows = [];
    let anyOk = false;

    for (let i = 0; i < results.length; i++) {
      const acct = this.accounts[i];
      const r = results[i];
      accountsStatus.push({
        id: acct.id,
        label: acct.label,
        ok: r.ok,
        rows: r.rows.length,
        warnings: r.warnings,
        error: r.error || null,
      });
      // Warnings are prefixed with the account label so a partial sync across
      // two accounts still says WHICH Adjust failed — without that, "Cohort
      // ROAS: 500" is unactionable when two accounts are in play.
      for (const w of r.warnings) warnings.push(`[${acct.label}] ${w}`);
      if (r.error) warnings.push(`[${acct.label}] ${r.error}`);
      if (r.ok) {
        anyOk = true;
        allRows.push(...r.rows);
      }
    }

    // Every account failed outright → this is a failed sync, not a partial one.
    // Name EACH account in the message: total failure throws before anything is
    // cached, so accountsStatus never reaches the popup — and with two tokens
    // in play, an unlabeled 401 gives the user no way to tell which Adjust is
    // rejecting them.
    if (!anyOk) {
      const detail = accountsStatus
        .map((st) => `[${st.label}] ${st.error || 'failed'}`)
        .join('\n');
      throw new Error(detail || warnings[0] || 'All Adjust fetches failed');
    }

    const { rows: campaigns, stats } = dedupeAcrossAccounts(allRows);
    this.lastMergeStats = stats;
    if (stats.dropped) {
      console.info(
        `[Adjust Overlay] merged ${this.accounts.length} Adjust accounts — ` +
          `${stats.dropped} duplicate row(s) resolved to the owning account.`
      );
    }

    return { campaigns, warnings, accountsStatus };
  }

  // One account's four pipelines. Mirrors the pre-v0.10 single-account
  // fetchAll(): EVERY pipeline is allowed to fail individually — its pills
  // simply won't render — as long as at least one succeeded. Only when every
  // pipeline that ran failed is the account marked failed (ok:false), and only
  // when every ACCOUNT fails does the sync itself throw. A partial sync with
  // visible warnings beats a 19-hour-old cache; total failure must still
  // surface as an error, never as an empty-but-"fresh" cache.
  //
  // The *Available flags track whether a fetch actually SUCCEEDED (toggle on
  // AND no error). When one didn't, mergeRealtimeInto leaves that field null
  // (not 0) so the pill shows a "no data" dash instead of a fabricated red 0%
  // — distinguishing a failed/absent fetch from a genuine zero-revenue day.
  async fetchAccount(acct) {
    const warnings = [];
    const common = {
      apiToken: acct.apiToken,
      utcOffset: this.utcOffset,
      appTokens: acct.appTokens,
    };

    let cohortAvailable = false;
    let cohortError = null;
    const cohortPromise = fetchCampaignROAS({ ...common, datePeriod: this.datePeriod })
      .then((rows) => { cohortAvailable = true; return rows; })
      .catch((err) => {
        console.warn(`[Adjust Overlay] [${acct.label}] cohort ROAS fetch failed:`, err.message);
        cohortError = err;
        warnings.push(`Cohort ROAS: ${err.message}`);
        return [];
      });

    let todayAvailable = false;
    const todayPromise = fetchTodayGrossRevenue(common)
      .then((rows) => { todayAvailable = true; return rows; })
      .catch((err) => {
        console.warn(`[Adjust Overlay] [${acct.label}] today-revenue fetch failed:`, err.message);
        warnings.push(`Today revenue: ${err.message}`);
        return [];
      });

    // Yesterday mirrors D-2 since v0.12: two independent halves (event-date
    // revenue + Adjust network spend), each best-effort — see
    // fetchYesterdayGrossRevenue. Half-success still populates the half that
    // worked so the pill degrades instead of vanishing.
    let yRevAvailable = false;
    let yCostAvailable = false;
    const yesterdayPromise = this.fetchYesterday
      ? fetchYesterdayGrossRevenue(common)
          .then((res) => {
            yRevAvailable = res.revOk;
            yCostAvailable = res.costOk;
            for (const w of res.warnings) warnings.push(w);
            return res.rows;
          })
          .catch((err) => {
            console.warn(`[Adjust Overlay] [${acct.label}] yesterday fetch failed:`, err.message);
            warnings.push(`Yesterday: ${err.message}`);
            return [];
          })
      : Promise.resolve([]);

    // D-2 reports per-side availability: the spend half and the revenue half
    // fail independently (see fetchD2GrossRevenue). Half-success must still
    // populate the half that worked, or the pill reads "chưa có dữ liệu" on
    // every row and looks like a broken feature rather than a degraded one.
    let d2RevAvailable = false;
    let d2CostAvailable = false;
    const d2Promise = this.fetchD2
      ? fetchD2GrossRevenue(common)
          .then((res) => {
            d2RevAvailable = res.revOk;
            d2CostAvailable = res.costOk;
            for (const w of res.warnings) warnings.push(w);
            return res.rows;
          })
          .catch((err) => {
            console.warn(`[Adjust Overlay] [${acct.label}] D-2 fetch failed:`, err.message);
            warnings.push(`D-2: ${err.message}`);
            return [];
          })
      : Promise.resolve([]);

    const [cohortRows, todayRows, yesterdayRows, d2Rows] = await Promise.all([
      cohortPromise, todayPromise, yesterdayPromise, d2Promise,
    ]);

    const anyPipelineOk =
      cohortAvailable || todayAvailable || yRevAvailable || yCostAvailable ||
      d2RevAvailable || d2CostAvailable;
    if (!anyPipelineOk) {
      return {
        ok: false,
        rows: [],
        warnings,
        error: (cohortError && cohortError.message) || warnings[0] || 'All Adjust fetches failed',
      };
    }

    const rows = mergeRealtimeInto(cohortRows, todayRows, yesterdayRows, d2Rows, {
      yRevAvailable,
      yCostAvailable,
      d2RevAvailable,
      d2CostAvailable,
    });
    // Tag every row with its origin so the merge below can resolve duplicates
    // and the injector tooltips can say which Adjust a number came from.
    for (const r of rows) {
      r.accountId = acct.id;
      r.accountLabel = acct.label;
    }
    return { ok: true, rows, warnings, error: null };
  }

  describe() {
    const base = `Adjust Reporting v2 · ${this.selectionLabel || 'Adjust'}`;
    const dropped = this.lastMergeStats?.dropped;
    return dropped ? `${base} · ${dropped} dup row(s) merged` : base;
  }
}

// ---- Cross-account merge -----------------------------------------------
//
// Two Adjust accounts can legitimately report the SAME Meta entity. The user
// migrated apps between accounts, and an Adjust account keeps its Meta ad-spend
// integration (and therefore keeps reporting `cost`) even after the app's SDK
// traffic has moved elsewhere. Summing those rows would double the spend;
// last-one-wins would silently depend on fetch order.
//
// Rule: for a duplicated entity, keep the row from the account that OWNS the
// app. Ownership shows up as SDK-side signal — only the owning account receives
// installs and revenue; a non-owning account mirrors spend with zeros next to
// it. Compared lexicographically: installs → cohort revenue → realtime revenue
// → cost. Ties keep the earlier account (config order), which is stable.
//
// Key space deliberately mirrors how the injectors index rows, so the only
// rows collapsed here are ones that WOULD have collided downstream:
//   campaign → Meta campaign id, else canonical campaign name (buildDirectIndex
//              keys campaigns by name, so same-name rows collide there anyway)
//   adset/ad → the Meta id when present, else campaignId + canonical name
function dedupeAcrossAccounts(rows) {
  const byKey = new Map();
  const order = [];
  let dropped = 0;

  for (const r of rows) {
    const k = mergeKey(r);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, r);
      order.push(k);
      continue;
    }
    dropped++;
    if (ownershipScore(r) > ownershipScore(prev)) byKey.set(k, r);
  }

  return {
    rows: order.map((k) => byKey.get(k)),
    stats: { dropped, kept: order.length },
  };
}

// The key is NETWORK-SCOPED: this dedupe exists to collapse the same entity
// reported by two ACCOUNTS, and one entity lives on exactly one ad network —
// so two rows on different channels are never the same entity, however equal
// their names are. Without the network prefix, the user's cross-network naming
// convention ("Caller ID-GL-…" duplicated on Meta AND Google/TikTok) made
// same-named campaigns from different channels collide whenever a row lacked
// its network id, and ownershipScore then dropped the smaller channel's row —
// observed live as "29 dup row(s) merged" on a SINGLE-account sync, where no
// cross-account duplicate can even exist.
function mergeKey(r) {
  const net = (r.network || '').toLowerCase();
  if (r.level === 'campaign') {
    return `${net}::campaign::${r.campaignId || canonicalKey(r.campaignName || '')}`;
  }
  if (r.level === 'adset') {
    return r.adsetId
      ? `${net}::adset::id::${r.adsetId}`
      : `${net}::adset::name::${r.campaignId || ''}::${canonicalKey(r.adsetName || '')}`;
  }
  return r.adId
    ? `${net}::ad::id::${r.adId}`
    : `${net}::ad::name::${r.campaignId || ''}::${canonicalKey(r.adName || '')}`;
}

// Lexicographic ownership score packed into one comparable number. Each tier
// dominates the next by construction (installs are weighted far above any
// plausible revenue figure), so a row with even a single install always beats a
// spend-only mirror row from the account the app moved away from.
function ownershipScore(r) {
  const installs = num(r.installs);
  const cohortRev = num(r.cohortAllRevenue);
  const realtimeRev = num(r.revenueToday) + num(r.revenueYesterday) + num(r.revenueD2);
  const cost = num(r.cost) + num(r.costD2) + num(r.costYesterday);
  return installs * 1e12 + cohortRev * 1e6 + realtimeRev * 1e1 + Math.min(cost, 1e5) * 1e-6;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ---- Realtime merge (within one account) -------------------------------
//
// Attach revenueToday + revenueYesterday + revenueD2/costD2 + currency from the
// realtime fetches onto matching cohortRows. Match priority: Meta ID (campaign
// / adset / ad) when both sides carry it, then canonical name as fallback.
// Realtime-only rows (an ad that ran today but has no cohort row in the cohort
// fetch's wider window) are appended with roas fields = null; a row present in
// several orphan sets is merged into one output row carrying every field.
//
// Output rows always carry: revenueToday (number, 0 if no match),
// revenueYesterday / revenueD2 / costD2 (number for a genuine no-match when
// that fetch SUCCEEDED, null when it didn't run / failed), todayRowExisted
// (bool), adjustCurrency (string|null).
//
// The availability flags are what keep "we asked, the answer was zero" separate
// from "we never got an answer" — the latter must render as a dash, never as a
// red 0%. D-2 tracks its two halves separately because they are two independent
// requests that fail independently.
function mergeRealtimeInto(
  cohortRows,
  todayRows,
  yesterdayRows,
  d2Rows = [],
  { yRevAvailable = false, yCostAvailable = false,
    d2RevAvailable = false, d2CostAvailable = false } = {}
) {
  const today = buildRealtimeIndex(todayRows);
  const yest = buildRealtimeIndex(yesterdayRows);
  const d2 = buildRealtimeIndex(d2Rows);
  const yRevMiss = yRevAvailable ? 0 : null;
  const yCostMiss = yCostAvailable ? 0 : null;
  const d2RevMiss = d2RevAvailable ? 0 : null;
  const d2CostMiss = d2CostAvailable ? 0 : null;

  const matchedToday = new Set();
  const matchedYest = new Set();
  const matchedD2 = new Set();
  const out = [];

  for (const c of cohortRows) {
    const tMatch = matchRealtime(c, today);
    const yMatch = matchRealtime(c, yest);
    const dMatch = matchRealtime(c, d2);
    if (tMatch) matchedToday.add(tMatch);
    if (yMatch) matchedYest.add(yMatch);
    if (dMatch) matchedD2.add(dMatch);
    out.push({
      ...c,
      revenueToday: tMatch?.revenueToday ?? 0,
      revenueYesterday: yMatch?.revenueYesterday ?? yRevMiss,
      costYesterday: yMatch?.costYesterday ?? yCostMiss,
      revenueD2: dMatch?.revenueD2 ?? d2RevMiss,
      costD2: dMatch?.costD2 ?? d2CostMiss,
      todayRowExisted: !!tMatch,
      adjustCurrency: tMatch?.currency ?? yMatch?.currency ?? dMatch?.currency ?? null,
    });
  }

  // Realtime-only rows (no cohort counterpart): append with cohort fields
  // nulled. Dedup today-only / yesterday-only / d2-only orphans by the same
  // key space so a row seen in several sets merges into one output row.
  const orphanMap = new Map();
  const addOrphan = (r, which, matchedSet) => {
    if (matchedSet.has(r)) return;
    const k = orphanKey(r);
    let o = orphanMap.get(k);
    if (!o) {
      o = {
        level: r.level,
        campaignName: r.campaignName,
        adsetName: r.adsetName,
        adName: r.adName,
        campaignId: r.campaignId,
        adsetId: r.adsetId,
        adId: r.adId,
        network: r.network,
        cost: null,
        cohortAllRevenue: null,
        installs: null,
        roas: { d0: null, d3: null, d7: null, allTime: null },
        revenueToday: 0,
        revenueYesterday: yRevMiss,
        costYesterday: yCostMiss,
        revenueD2: d2RevMiss,
        costD2: d2CostMiss,
        todayRowExisted: false,
        adjustCurrency: r.currency || null,
      };
      orphanMap.set(k, o);
    }
    if (which === 'today') { o.revenueToday = r.revenueToday ?? 0; o.todayRowExisted = true; }
    else if (which === 'yesterday') {
      // Two independent halves — keep a null half null (same rule as D-2).
      o.revenueYesterday = r.revenueYesterday ?? yRevMiss;
      o.costYesterday = r.costYesterday ?? yCostMiss;
    }
    else {
      // A D-2 row carries the two halves independently: keep a null half null
      // rather than collapsing it to 0, so a half-failed D-2 fetch still shows
      // the half that worked.
      o.revenueD2 = r.revenueD2 ?? d2RevMiss;
      o.costD2 = r.costD2 ?? d2CostMiss;
    }
    if (!o.adjustCurrency && r.currency) o.adjustCurrency = r.currency;
  };
  for (const t of todayRows) addOrphan(t, 'today', matchedToday);
  for (const y of yesterdayRows) addOrphan(y, 'yesterday', matchedYest);
  for (const d of d2Rows) addOrphan(d, 'd2', matchedD2);
  for (const o of orphanMap.values()) out.push(o);

  return out;
}

// Build id + name lookup indexes for a set of realtime (event-date) rows.
function buildRealtimeIndex(rows) {
  const idIndex = new Map();
  const nameIndex = new Map();
  for (const r of rows) {
    const idKey = realtimeIdKey(r);
    if (idKey) idIndex.set(idKey, r);
    const nameKey = realtimeNameKey(r);
    if (nameKey && !nameIndex.has(nameKey)) nameIndex.set(nameKey, r);
  }
  return { idIndex, nameIndex };
}

function matchRealtime(row, index) {
  const idKey = realtimeIdKey(row);
  const nameKey = realtimeNameKey(row);
  return (idKey && index.idIndex.get(idKey)) || (nameKey && index.nameIndex.get(nameKey)) || null;
}

// Stable key for orphan dedup across the today/yesterday/d2 sets. Deliberately
// keyed by level + campaignId + canonical NAME (via realtimeNameKey), NOT by
// adId: Adjust can return creative_id_network on one event-date fetch and null
// (a finalization shadow) on the other for the SAME ad, so an adId-first key
// would split one ad's today-orphan and yesterday-orphan into two same-named
// rows that then collide as "ambiguous" downstream and suppress both realtime
// pills. Name+campaign keying merges them into one orphan carrying both fields.
function orphanKey(r) {
  const nameKey = realtimeNameKey(r) ||
    `${r.level}::${r.campaignName}::${r.adsetName}::${r.adName}`;
  return r.campaignId ? `${r.campaignId}::${nameKey}` : nameKey;
}

function realtimeIdKey(row) {
  if (row.level === 'ad' && row.adId) return `ad::${row.adId}`;
  if (row.level === 'adset' && row.adsetId) return `adset::${row.adsetId}`;
  // NOTE: ad-level rows with adId=null MUST NOT fall back to
  // `adset::${adsetId}` — that namespace is owned by adset-level rows, and
  // a shadow ad-row (creative_id_network=null) would clobber the legitimate
  // adset-level today row in idIndex, making the cohort adset row match the
  // shadow's revenue while the real adset today row gets orphan-appended.
  // Net effect: both rows end up in cache with same adsetId, both get summed
  // into adsetByIdIndex, pill displays double-counted revenue. Verified
  // 2026-05-18. See docs/findings/adjust_today_shadow_row.md.
  if (row.campaignId) return `${row.level}::camp::${row.campaignId}::` +
    `${canonicalKey(row.adName || row.adsetName || row.campaignName || '')}`;
  return null;
}

function realtimeNameKey(row) {
  if (row.level === 'campaign') return `campaign::${canonicalKey(row.campaignName || '')}`;
  if (row.level === 'adset') return `adset::${canonicalKey(row.adsetName || '')}`;
  // ad-level row: key by ad name; adset is implicit. Name-only matches risk
  // collisions for ads with duplicate names across campaigns — but in that
  // case the ID-key path above already resolved the canonical one; this is
  // a fallback only when ID is missing on both sides.
  return `ad::${canonicalKey(row.adName || '')}`;
}

/**
 * Future implementation - calls JM-AM endpoint that already aggregates Adjust data.
 * Same return shape, so consumer code never changes.
 */
export class JmAmDataSource {
  constructor({ baseUrl, apiKey, appId }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.appId = appId;
  }

  async fetchAll() {
    // TODO(pham): when JM-AM is out of soak, expose an endpoint like
    //   GET {baseUrl}/api/adjust/campaign-roas?app={appId}&windows=d0,d3,d7,all
    // returning the same shape as AdjustDirectDataSource.fetchAll().
    const res = await fetch(`${this.baseUrl}/api/adjust/campaign-roas?app=${this.appId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`JM-AM fetch failed: ${res.status}`);
    return res.json();
  }

  describe() {
    return `JM-AM (app=${this.appId})`;
  }
}

/**
 * Factory. Reads config from chrome.storage and returns the active source.
 */
export async function createDataSource() {
  const { dataSourceConfig, pillVisibility } = await chrome.storage.local.get([
    'dataSourceConfig', 'pillVisibility',
  ]);
  const cfg = dataSourceConfig || { kind: 'adjust-direct' };

  if (cfg.kind === 'jm-am') {
    return new JmAmDataSource(cfg);
  }
  // Only fetch the yesterday / D-2 event-date reports when the corresponding
  // pill is enabled — avoids extra multi-level Adjust calls on every sync
  // otherwise. The cache is shared across platforms, so ANY platform asking
  // for it is enough; gating on `meta` alone would starve the TikTok pill.
  const fetchYesterday = !!(
    pillVisibility?.meta?.yesterday || pillVisibility?.tiktok?.yesterday ||
    pillVisibility?.google?.yesterday
  );
  const fetchD2 = !!(
    pillVisibility?.meta?.d2 || pillVisibility?.tiktok?.d2 ||
    pillVisibility?.google?.d2
  );
  const { active, skipped } = resolveActiveAccounts(cfg);
  if (skipped.length) {
    console.warn(
      '[Adjust Overlay] skipping Adjust account(s) with no API token:',
      skipped.map((a) => a.label).join(', ')
    );
  }
  return new AdjustDirectDataSource({
    accounts: active,
    utcOffset: cfg.utcOffset,
    datePeriod: cfg.datePeriod,
    fetchYesterday,
    fetchD2,
    selectionLabel: describeSelection(cfg),
  });
}

// Exported for the offline unit test in docs/diagnostics/ — not used by the
// extension at runtime.
export const __test__ = { dedupeAcrossAccounts, ownershipScore, mergeRealtimeInto, mergeKey };
