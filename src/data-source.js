// src/data-source.js
// Adapter pattern. Today: pulls direct from the Adjust API.
// Later (when JM-AM exits soak): swap to JmAmDataSource without touching anything else.
//
// v0.12.2 — cross-account duplicates are MERGED (see dedupeAcrossAccounts).
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
      // checklog: cross-account merge. `split` > 0 means an app's traffic is
      // genuinely divided between accounts right now (both sides carry
      // installs/revenue) — the case that v0.10–v0.12.1's pick-one rule
      // silently undercounted. See docs/findings/adjust_multi_account.md.
      console.info(
        `[Adjust Overlay] merged ${this.accounts.length} Adjust accounts — ` +
          `${stats.merged} entity(ies) reported by >1 account collapsed ` +
          `(${stats.dropped} row(s) folded; spend=max, installs/revenue=sum)` +
          (stats.split
            ? `; ${stats.split} with SDK traffic on BOTH sides, e.g. ${stats.splitSamples.join(' | ')}`
            : '')
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
    const merged = this.lastMergeStats?.merged;
    return merged ? `${base} · ${merged} entity gộp từ 2 acc` : base;
  }
}

// ---- Cross-account merge -----------------------------------------------
//
// Two Adjust accounts can legitimately report the SAME Meta entity. The user
// migrates apps between accounts app-by-app: the old account keeps its Meta
// ad-spend integration (so it keeps reporting `cost`), and — while a build
// carrying the new account's app_token rolls out — BOTH accounts receive SDK
// traffic (installs + revenue) for the same campaign. v0.10–v0.12.1 resolved a
// duplicate by keeping ONLY the row from the account that "owned" the app
// (most installs). That is exact for a clean cut-over but silently drops the
// other account's revenue during a split — which is the state a migrating
// portfolio is in most of the time (observed 2026-09-18: Video Downloader
// lives as `d2khbj9qdgjk` in Adjust 1 AND `[JM] …` in Adjust 2, both live).
//
// v0.12.2 rule — MERGE, don't pick:
//   cost / costYesterday / costD2      → MAX across accounts. Spend is one
//       number per Meta ad; every account's integration mirrors that same
//       figure, so summing doubles it and taking one loses nothing. MAX also
//       survives an account whose spend integration is off (0 / null).
//   installs / cohortAllRevenue /
//   revenueToday / revenueYesterday /
//   revenueD2                          → SUM. An install or a revenue event is
//       recorded by exactly one SDK app_token, so the accounts never contain
//       each other's events; the sum is the whole picture.
//   roas.d0 / d3 / d7                  → Σ(roas_i × cost_i) ÷ merged cost.
//       Adjust returns ratios, not window revenue, so each row's window
//       revenue is recovered first. A row with no cost contributes nothing
//       (its window revenue is unknowable) — only undercounts in the rare
//       SDK-only / no-spend-integration case.
//   roas.allTime                       → Σ cohortAllRevenue ÷ merged cost.
//   accountLabel                       → "Adjust 1 + Adjust 2", so every pill
//       tooltip says the number is a merge; `mergedFrom[]` keeps each side's
//       raw installs / cost / revenue for diagnostics.
// The PRIMARY row (ids, names, network, currency) is the one with the strongest
// SDK signal — the same ownershipScore as before — so nothing about matching
// changed, only the arithmetic. Same-network only: see mergeKey.
//
// Key space deliberately mirrors how the injectors index rows, so the only
// rows collapsed here are ones that WOULD have collided downstream:
//   campaign → Meta campaign id, else canonical campaign name (buildDirectIndex
//              keys campaigns by name, so same-name rows collide there anyway)
//   adset/ad → the Meta id when present, else campaignId + canonical name
function dedupeAcrossAccounts(rows) {
  const groups = new Map(); // mergeKey -> rows[]
  const order = [];
  for (const r of rows) {
    const k = mergeKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else {
      groups.set(k, [r]);
      order.push(k);
    }
  }

  let dropped = 0;
  let merged = 0;
  let split = 0;
  const splitSamples = [];
  const out = order.map((k) => {
    const g = groups.get(k);
    if (g.length === 1) return g[0];
    dropped += g.length - 1;
    merged += 1;
    const res = mergeGroup(g);
    if (res.split) {
      split += 1;
      if (splitSamples.length < 5) splitSamples.push(res.row.campaignName || k);
    }
    return res.row;
  });

  return {
    rows: out,
    stats: { dropped, kept: order.length, merged, split, splitSamples },
  };
}

// Merge one entity's rows from several accounts into a single row. `split` is
// true when more than one account carries SDK-side signal (installs/revenue)
// — i.e. the app's traffic is genuinely divided between accounts, the case the
// old pick-one rule got wrong.
function mergeGroup(group) {
  // Stable sort → ties keep config order (Array.prototype.sort is stable).
  const sorted = [...group].sort((a, b) => ownershipScore(b) - ownershipScore(a));
  const primary = sorted[0];
  const hasSignal = (r) =>
    num(r.installs) > 0 || num(r.cohortAllRevenue) > 0 ||
    num(r.revenueToday) + num(r.revenueYesterday) + num(r.revenueD2) > 0;
  const split = group.filter(hasSignal).length > 1;

  const cost = maxOrNull(group.map((r) => r.cost));
  const cohortAllRevenue = sumOrNull(group.map((r) => r.cohortAllRevenue));
  const roasWindow = (key) => {
    let rev = 0;
    let any = false;
    for (const r of group) {
      const ratio = r.roas?.[key];
      const c = num(r.cost);
      if (typeof ratio === 'number' && Number.isFinite(ratio) && c > 0) {
        rev += ratio * c;
        any = true;
      }
    }
    if (any && cost > 0) return rev / cost;
    return primary.roas?.[key] ?? null;
  };

  const labels = [];
  for (const r of group) {
    if (r.accountLabel && !labels.includes(r.accountLabel)) labels.push(r.accountLabel);
  }

  const row = {
    ...primary,
    cost,
    installs: sumOrNull(group.map((r) => r.installs)),
    cohortAllRevenue,
    roas: {
      d0: roasWindow('d0'),
      d3: roasWindow('d3'),
      d7: roasWindow('d7'),
      allTime:
        cost != null && cost > 0 && cohortAllRevenue != null
          ? cohortAllRevenue / cost
          : (primary.roas?.allTime ?? null),
    },
    // revenueToday's contract is "number, 0 when no today row" (never null).
    revenueToday: sumOrNull(group.map((r) => r.revenueToday)) ?? 0,
    // The D-1 / D-2 halves keep their null-means-not-fetched contract: null
    // only when EVERY account's fetch of that half failed.
    revenueYesterday: sumOrNull(group.map((r) => r.revenueYesterday)),
    costYesterday: maxOrNull(group.map((r) => r.costYesterday)),
    revenueD2: sumOrNull(group.map((r) => r.revenueD2)),
    costD2: maxOrNull(group.map((r) => r.costD2)),
    todayRowExisted: group.some((r) => !!r.todayRowExisted),
    adjustCurrency: group.map((r) => r.adjustCurrency).find(Boolean) || null,
    accountLabel: labels.join(' + ') || primary.accountLabel,
    mergedFrom: group.map((r) => ({
      accountId: r.accountId,
      accountLabel: r.accountLabel,
      installs: r.installs ?? null,
      cost: r.cost ?? null,
      cohortAllRevenue: r.cohortAllRevenue ?? null,
      revenueToday: r.revenueToday ?? null,
      revenueYesterday: r.revenueYesterday ?? null,
      costYesterday: r.costYesterday ?? null,
      revenueD2: r.revenueD2 ?? null,
      costD2: r.costD2 ?? null,
    })),
  };
  return { row, split };
}

// The key is NETWORK-SCOPED: this merge exists to collapse the same entity
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
// spend-only mirror row from the account the app moved away from. Since v0.12.2
// it only chooses the PRIMARY row (ids / names / currency) of a merge — the
// numbers themselves are combined in mergeGroup.
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

// null-aware reducers: null in → ignored; all null → null (keeps the
// "not fetched" contract of the realtime halves intact through a merge).
function sumOrNull(vals) {
  let s = null;
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) s = (s ?? 0) + v;
  }
  return s;
}

function maxOrNull(vals) {
  let m = null;
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) m = m == null ? v : Math.max(m, v);
  }
  return m;
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
export const __test__ = { dedupeAcrossAccounts, mergeGroup, ownershipScore, mergeRealtimeInto, mergeKey };
