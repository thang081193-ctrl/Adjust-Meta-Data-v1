// Adjust Reporting Service v2 client — Workers port of extension/src/adjust-client.js.
//
// Same wire-level params (channel ids, dimensions, metrics, date_period) as the
// original direct-from-extension client; only difference is the API token now
// comes from a Workers secret instead of a popup field.
//
// Return shape is byte-compatible with the JS client so extension/proxy-client
// can drop in with no consumer changes.

const ADJUST_BASE = 'https://automate.adjust.com/reports-service/report';
const FETCH_TIMEOUT_MS = 60_000;

const NETWORK_CHANNEL_IDS = [
  'partner_34',    // Facebook (Meta Ads Manager)
  'partner_1678',  // TikTok for Business (legacy integration)
  '2337',          // TikTok new integration channel (post-cutoff trackers)
];

export interface Roas {
  d0: number | null;
  d3: number | null;
  d7: number | null;
  allTime: number | null;
}

export interface RoasRow {
  level: 'campaign' | 'ad';
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  network: string | null;
  cost: number | null;
  cohortAllRevenue: number | null;
  installs: number | null;
  roas: Roas;
}

export interface TodayRow {
  level: 'campaign' | 'ad';
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  network: string | null;
  revenueToday: number | null;
  currency: string | null;
}

export interface AdjustCfg {
  apiToken: string;
  utcOffset?: string;
  datePeriod?: string;
  appTokens?: string;   // comma-separated; resolved server-side from user's allowed_apps
}

// ---- Cohort ROAS (campaign + ad level) ----

export async function fetchCampaignROAS(cfg: AdjustCfg): Promise<RoasRow[]> {
  const utcOffset = cfg.utcOffset ?? '+07:00';
  const datePeriod = expandDatePeriod(cfg.datePeriod ?? 'rolling30');

  const [campaignRows, adRows] = await Promise.all([
    fetchAtLevel({
      apiToken: cfg.apiToken, utcOffset, datePeriod, appTokens: cfg.appTokens,
      dimensions: 'channel,campaign_network',
    }),
    fetchAtLevel({
      apiToken: cfg.apiToken, utcOffset, datePeriod, appTokens: cfg.appTokens,
      dimensions: 'channel,campaign_network,adgroup_network,creative_network',
    }),
  ]);

  const out: RoasRow[] = [];
  for (const r of campaignRows) out.push(toRow(r, 'campaign'));
  for (const r of adRows) out.push(toRow(r, 'ad'));
  return out;
}

interface LevelArgs {
  apiToken: string;
  utcOffset: string;
  datePeriod: string;
  dimensions: string;
  appTokens?: string;
}

async function fetchAtLevel(args: LevelArgs): Promise<AdjustRawRow[]> {
  const params = new URLSearchParams({
    format_dates: 'false',
    full_data: 'true',
    readable_names: 'false',
    ad_spend_mode: 'network',
    attribution_source: 'first',
    attribution_type: 'all',
    channel_id__in: NETWORK_CHANNEL_IDS.join(','),
    cohort_maturity: 'immature',
    date_period: args.datePeriod,
    dimensions: args.dimensions,
    fingerprint_status: 'all',
    include_attr_dependency: 'true',
    digital_turbine_mode: 'digital_turbine',
    ironsource_mode: 'ironsource',
    limit: '10000',
    metrics: 'cost,roas_d0,roas_d3,roas_d7,cohort_all_revenue,installs',
    reattributed: 'all',
    sandbox: 'false',
    sdk_signature_enforcement_status: 'all',
    sort: '-installs',
    utc_offset: args.utcOffset,
  });
  if (args.appTokens && args.appTokens.trim()) {
    params.set('app_token__in', args.appTokens.trim());
  }

  return adjustGet(`${ADJUST_BASE}?${params}`, args.apiToken, 'Adjust cohort fetch');
}

// ---- Today's gross revenue (event-date attribution) ----

export async function fetchTodayGrossRevenue(cfg: Omit<AdjustCfg, 'datePeriod'>): Promise<TodayRow[]> {
  const utcOffset = cfg.utcOffset ?? '+07:00';

  const [campaignRows, adRows] = await Promise.all([
    fetchTodayAtLevel({
      apiToken: cfg.apiToken, utcOffset, appTokens: cfg.appTokens,
      dimensions: 'channel,campaign_network',
    }),
    fetchTodayAtLevel({
      apiToken: cfg.apiToken, utcOffset, appTokens: cfg.appTokens,
      dimensions: 'channel,campaign_network,adgroup_network,creative_network',
    }),
  ]);

  const out: TodayRow[] = [];
  for (const r of campaignRows) out.push(toTodayRow(r, 'campaign'));
  for (const r of adRows) out.push(toTodayRow(r, 'ad'));
  return out;
}

async function fetchTodayAtLevel(args: Omit<LevelArgs, 'datePeriod'>): Promise<AdjustRawRow[]> {
  const params = new URLSearchParams({
    format_dates: 'false',
    full_data: 'true',
    readable_names: 'false',
    ad_spend_mode: 'network',
    attribution_source: 'first',
    attribution_type: 'all',
    channel_id__in: NETWORK_CHANNEL_IDS.join(','),
    date_period: 'today',
    dimensions: args.dimensions,
    fingerprint_status: 'all',
    include_attr_dependency: 'true',
    digital_turbine_mode: 'digital_turbine',
    ironsource_mode: 'ironsource',
    limit: '10000',
    metrics: 'revenue,ad_revenue',
    reattributed: 'all',
    sandbox: 'false',
    sdk_signature_enforcement_status: 'all',
    sort: '-ad_revenue',
    utc_offset: args.utcOffset,
  });
  if (args.appTokens && args.appTokens.trim()) {
    params.set('app_token__in', args.appTokens.trim());
  }

  return adjustGet(`${ADJUST_BASE}?${params}`, args.apiToken, 'Adjust today fetch');
}

// ---- Shared HTTP + parsing ----

interface AdjustRawRow {
  channel?: string;
  campaign_network?: string;
  adgroup_network?: string;
  creative_network?: string;
  cost?: string | number;
  cohort_all_revenue?: string | number;
  installs?: string | number;
  roas_d0?: string | number;
  roas_d3?: string | number;
  roas_d7?: string | number;
  revenue?: string | number;
  ad_revenue?: string | number;
  all_revenue?: string | number;
  network_revenue?: string | number;
  currency?: string;
  app_currency?: string;
  attr_dependency?: {
    campaign_id_network?: string;
    adgroup_id_network?: string;
    creative_id_network?: string;
  };
}

interface AdjustResponse {
  rows?: AdjustRawRow[];
}

async function adjustGet(url: string, apiToken: string, label: string): Promise<AdjustRawRow[]> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`${label} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`${label} network error: ${e.message ?? String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `${label} failed: ${res.status} ${res.statusText}` +
        (body ? ` — ${body.slice(0, 200)}` : '')
    );
  }

  const json = (await res.json()) as AdjustResponse;
  return json.rows ?? [];
}

function toRow(row: AdjustRawRow, level: 'campaign' | 'ad'): RoasRow {
  const cost = parseNum(row.cost);
  const cohortAllRevenue = parseNum(row.cohort_all_revenue);
  const allTime = cost != null && cost > 0 && cohortAllRevenue != null
    ? cohortAllRevenue / cost
    : null;
  const dep = row.attr_dependency ?? {};
  return {
    level,
    campaignName: row.campaign_network ?? null,
    adsetName: row.adgroup_network ?? null,
    adName: row.creative_network ?? null,
    campaignId: dep.campaign_id_network ?? null,
    adsetId: dep.adgroup_id_network ?? null,
    adId: dep.creative_id_network ?? null,
    network: row.channel ?? null,
    cost,
    cohortAllRevenue,
    installs: parseNum(row.installs),
    roas: {
      d0: parseNum(row.roas_d0),
      d3: parseNum(row.roas_d3),
      d7: parseNum(row.roas_d7),
      allTime,
    },
  };
}

function toTodayRow(row: AdjustRawRow, level: 'campaign' | 'ad'): TodayRow {
  const dep = row.attr_dependency ?? {};
  // Pick the most-specific revenue field that's populated. NEVER sum — IAA
  // and IAP metrics overlap (same purchase counted twice if both come back).
  // Order = most specific first; bail on first hit.
  let revenueToday: number | null = null;
  for (const key of ['ad_revenue', 'revenue', 'all_revenue', 'network_revenue'] as const) {
    const v = parseNum(row[key]);
    if (v != null) { revenueToday = v; break; }
  }
  return {
    level,
    campaignName: row.campaign_network ?? null,
    adsetName: row.adgroup_network ?? null,
    adName: row.creative_network ?? null,
    campaignId: dep.campaign_id_network ?? null,
    adsetId: dep.adgroup_id_network ?? null,
    adId: dep.creative_id_network ?? null,
    network: row.channel ?? null,
    revenueToday,
    currency: row.currency ?? row.app_currency ?? null,
  };
}

function parseNum(v: string | number | undefined | null): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const ROLLING_DAYS: Record<string, number> = {
  rolling3: 3,
  rolling7: 7,
  rolling30: 30,
};

function expandDatePeriod(spec: string): string {
  const days = ROLLING_DAYS[spec];
  if (days) {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    return `${isoDate(start)}:${isoDate(end)}`;
  }
  return spec;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
