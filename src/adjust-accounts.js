// src/adjust-accounts.js
// Shared shape + migration for the multi-Adjust-account config (v0.9.7).
//
// WHY THIS EXISTS
// Up to v0.9.6 the extension talked to exactly one Adjust account, and
// `dataSourceConfig` carried a single `apiToken` + `appTokens` pair. The
// portfolio is now being moved app-by-app onto a SECOND Adjust account, which
// mints a brand-new app_token per app — so a single token pair can no longer
// cover the portfolio during (or after) the migration.
//
// DESIGN DECISION — accounts are kept SEPARATE, never merged:
// Each account's rows are fetched independently, tagged with `accountId`, and
// cached side by side. The user picks which account's data the pills show
// (popup → "Nguồn dữ liệu"), defaulting to 'all' — safe precisely because an
// app lives in exactly ONE account at a time, so 'all' is a union with no
// overlap rather than a sum. If an entity ever DOES appear in two accounts,
// data-source.js raises a syncWarning instead of silently double-counting;
// see docs/findings/multi_adjust_account_split.md.
//
// Every consumer (background/data-source, popup) normalizes through
// normalizeAccounts() so the legacy single-token config keeps working on
// upgrade without the user retyping anything.

// The view selector's "show everything" sentinel. Stored under
// chrome.storage.local.adjustView; content scripts read the same key.
export const VIEW_ALL = 'all';

// Sanity cap. Nothing technical breaks above this — it exists so a stuck loop
// in the popup's "add account" button can't create hundreds of fetch fan-outs.
export const MAX_ACCOUNTS = 6;

/**
 * Canonical account list from any `dataSourceConfig` shape, old or new.
 *
 * Accepts:
 *   - v0.9.7+: cfg.accounts = [{ id, label, apiToken, appTokens, enabled }]
 *   - ≤v0.9.6: cfg.apiToken + cfg.appTokens (migrated to a single 'a1' entry)
 *   - null / garbage: returns one empty placeholder account so the popup always
 *     has a row to render and the user is never met with a blank settings box.
 *
 * Always returns at least one entry, each with every field present and typed.
 */
export function normalizeAccounts(cfg) {
  const raw = Array.isArray(cfg?.accounts) ? cfg.accounts : null;

  if (raw && raw.length) {
    const seen = new Set();
    const out = [];
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      // Duplicate ids would make row tagging ambiguous (two accounts' rows
      // indistinguishable in the cache), so re-id collisions rather than trust
      // whatever was persisted.
      let id = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : '';
      if (!id || seen.has(id)) id = nextAccountId(out);
      seen.add(id);
      out.push({
        id,
        label: typeof a.label === 'string' && a.label.trim()
          ? a.label.trim()
          : defaultLabelFor(out.length),
        apiToken: typeof a.apiToken === 'string' ? a.apiToken.trim() : '',
        appTokens: typeof a.appTokens === 'string' ? a.appTokens.trim() : '',
        // Missing `enabled` means a config written before the flag existed —
        // treat as on, so an upgrade never silently stops fetching an account.
        enabled: a.enabled !== false,
      });
      if (out.length >= MAX_ACCOUNTS) break;
    }
    if (out.length) return out;
  }

  // Legacy single-account config (or nothing at all).
  return [{
    id: 'a1',
    label: defaultLabelFor(0),
    apiToken: typeof cfg?.apiToken === 'string' ? cfg.apiToken.trim() : '',
    appTokens: typeof cfg?.appTokens === 'string' ? cfg.appTokens.trim() : '',
    enabled: true,
  }];
}

/**
 * Accounts that a sync should actually call: enabled AND holding an API token.
 * An enabled-but-tokenless account is a half-filled form row, not a request —
 * firing it would send `Authorization: Bearer ` and burn a retry cycle on a
 * guaranteed 401.
 */
export function syncableAccounts(cfg) {
  return normalizeAccounts(cfg).filter((a) => a.enabled && a.apiToken);
}

/**
 * Next free `aN` id for a list of existing accounts. Suffixes are never reused
 * after a delete: a recycled id would make rows cached under the old account
 * silently reappear as the new one until the next sync overwrites them.
 */
export function nextAccountId(accounts) {
  let max = 0;
  for (const a of accounts || []) {
    const m = /^a(\d+)$/.exec(a?.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `a${max + 1}`;
}

/**
 * Blank account row for the popup's "add account" button.
 */
export function makeAccount(accounts) {
  const list = accounts || [];
  return {
    id: nextAccountId(list),
    label: defaultLabelFor(list.length),
    apiToken: '',
    appTokens: '',
    enabled: true,
  };
}

export function defaultLabelFor(index) {
  return `Adjust ${index + 1}`;
}

/**
 * Human label for an account id, for banners / warnings / tooltips.
 * Unknown ids render as the raw id rather than an empty string — an unlabeled
 * row in a warning is worse than an ugly one.
 */
export function labelForAccount(accounts, id) {
  if (!id || id === VIEW_ALL) return 'Tất cả';
  const found = (accounts || []).find((a) => a.id === id);
  return found?.label || id;
}

/**
 * Collapse a stored view selection to something that still exists.
 * A view pinned to an account the user later deleted must fall back to 'all',
 * otherwise every pill silently disappears with no explanation.
 */
export function resolveView(view, accounts) {
  if (!view || view === VIEW_ALL) return VIEW_ALL;
  return (accounts || []).some((a) => a.id === view) ? view : VIEW_ALL;
}
