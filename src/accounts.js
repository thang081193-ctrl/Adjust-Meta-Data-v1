// src/accounts.js
// Single source of truth for the multi-Adjust-account config shape.
//
// WHY THIS EXISTS
// The user runs their apps across MORE THAN ONE Adjust account (apps were
// migrated between accounts, and new apps were created in the newer one). One
// API token can only ever see the apps of the account that minted it, so a
// single-token client is structurally unable to cover every campaign in Meta /
// TikTok Ads Manager. This module owns the account list, the "which account(s)
// am I looking at" selection, and the migration from the pre-v0.10 single-token
// config — imported by BOTH popup/popup.js and src/data-source.js so the two
// can never drift.
//
// STORAGE SHAPE (chrome.storage.local.dataSourceConfig)
//   {
//     kind: 'adjust-direct',
//     utcOffset:       '+07:00',      // shared: Adjust reporting offset
//     accountTimezone: 'America/…',   // shared: Meta ad-account tz (spend est.)
//     datePeriod:      'rolling30',   // shared: cohort window
//     accounts: [
//       { id: 'acct1', label: 'Adjust cũ',  apiToken: '…', appTokens: 'a,b,c' },
//       { id: 'acct2', label: 'Adjust mới', apiToken: '…', appTokens: 'd,e' },
//     ],
//     activeAccountId: 'all' | '<account id>',
//   }
//
// utcOffset / accountTimezone / datePeriod stay SHARED on purpose: they describe
// the window the user wants to read (and the Meta ad-account's clock), not a
// property of an Adjust account. Two accounts read on two different offsets
// would produce pills whose numbers cannot be compared side by side.

export const MAX_ACCOUNTS = 5;

// 'all' fans the sync out across every configured account and merges the rows.
export const ALL_ACCOUNTS = 'all';

let idSeq = 0;

// Ids are storage keys, not secrets — a counter plus the account's slot index
// is enough, and stays stable once written. (crypto.randomUUID is available in
// both MV3 contexts, but short readable ids make the popup + logs legible.)
export function newAccountId() {
  idSeq += 1;
  return `acct${Date.now().toString(36)}${idSeq}`;
}

function blankAccount(index) {
  return {
    id: newAccountId(),
    label: `Adjust ${index + 1}`,
    apiToken: '',
    appTokens: '',
  };
}

/**
 * Normalize whatever is in storage into the canonical `accounts` array.
 *
 * Handles three inputs:
 *  - v0.10+ config (already has `accounts`) → sanitized copy.
 *  - pre-v0.10 config (`apiToken` / `appTokens` at the top level) → migrated
 *    into a single account so an existing install keeps working untouched.
 *  - missing/garbage → one empty account slot so the popup always has a card
 *    to type into (per the "always render pipeline-state UI" rule — an empty
 *    form is a visible state, a missing form looks broken).
 *
 * Never returns an empty array.
 */
export function normalizeAccounts(cfg) {
  const raw = Array.isArray(cfg?.accounts) ? cfg.accounts : null;

  if (raw && raw.length) {
    const out = raw.slice(0, MAX_ACCOUNTS).map((a, i) => ({
      id: typeof a?.id === 'string' && a.id ? a.id : newAccountId(),
      label: (typeof a?.label === 'string' && a.label.trim()) || `Adjust ${i + 1}`,
      apiToken: typeof a?.apiToken === 'string' ? a.apiToken.trim() : '',
      appTokens: typeof a?.appTokens === 'string' ? a.appTokens.trim() : '',
    }));
    // Duplicate ids would make the selector ambiguous and let one account's
    // rows overwrite another's in the per-account status map. Re-mint dupes.
    const seen = new Set();
    for (const a of out) {
      if (seen.has(a.id)) a.id = newAccountId();
      seen.add(a.id);
    }
    return out;
  }

  // Legacy single-token config → one account. Label it explicitly so the user
  // can tell at a glance that their old setup survived the upgrade.
  const legacyToken = typeof cfg?.apiToken === 'string' ? cfg.apiToken.trim() : '';
  const legacyApps = typeof cfg?.appTokens === 'string' ? cfg.appTokens.trim() : '';
  if (legacyToken || legacyApps) {
    return [{
      id: newAccountId(),
      label: 'Adjust 1',
      apiToken: legacyToken,
      appTokens: legacyApps,
    }];
  }

  return [blankAccount(0)];
}

export function makeBlankAccount(index) {
  return blankAccount(index);
}

/**
 * The accounts a sync should actually fetch.
 *
 * Selection is resolved against the normalized list, then filtered to accounts
 * that carry an API token — a token-less account can only ever produce a 401,
 * so fetching it would spend a report slot to manufacture a warning. It is
 * reported separately via `skipped` so the popup can say WHY it was left out
 * instead of silently ignoring a card the user filled in halfway.
 *
 * A selection pointing at a deleted account falls back to ALL rather than
 * returning nothing — an empty fetch would look identical to "Adjust is down".
 */
export function resolveActiveAccounts(cfg) {
  const accounts = normalizeAccounts(cfg);
  const sel = cfg?.activeAccountId || ALL_ACCOUNTS;
  const selected =
    sel === ALL_ACCOUNTS
      ? accounts
      : (accounts.filter((a) => a.id === sel).length
          ? accounts.filter((a) => a.id === sel)
          : accounts);

  const active = selected.filter((a) => a.apiToken);
  const skipped = selected.filter((a) => !a.apiToken);
  return { accounts, selected, active, skipped, selection: sel };
}

/**
 * Human label for the active selection, e.g.
 *   "Adjust cũ + Adjust mới"  (all, 2 configured)
 *   "Adjust mới"              (single selection)
 * Used in `describe()` → cache.sourceLabel → both injector banners, so the user
 * can always see WHICH Adjust the pills on screen came from.
 */
export function describeSelection(cfg) {
  const { active, selection } = resolveActiveAccounts(cfg);
  if (!active.length) return 'no Adjust account configured';
  const names = active.map((a) => a.label).join(' + ');
  return selection === ALL_ACCOUNTS && active.length > 1 ? `${names} (gộp)` : names;
}
