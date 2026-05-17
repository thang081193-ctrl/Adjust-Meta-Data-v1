// src/matcher.js
// Unicode-safe campaign name matcher.
// Solves the "copy-paste from Adjust to Meta search returns nothing" bug
// caused by hidden Unicode chars in Adjust UI rendering.
//
// ⚠️ DUPLICATION WARNING:
// The WHITESPACE_VARIANTS / ZERO_WIDTH / DASH_VARIANTS regexes and the
// canonicalKey() function below are also embedded inline in
// content/meta-injector.js because MV3 content scripts can't import ES
// modules without a build step. If you change the normalization rules here,
// update the embedded copy too — otherwise content-side matching will drift
// from background-side matching and pills silently stop appearing.

const WHITESPACE_VARIANTS = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g;
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060]/g;
const DASH_VARIANTS = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const QUOTE_VARIANTS_DOUBLE = /[\u201C\u201D\u201E\u201F\u2033\u2036]/g;
const QUOTE_VARIANTS_SINGLE = /[\u2018\u2019\u201A\u201B\u2032\u2035]/g;

/**
 * Normalize a campaign name to a canonical form for matching.
 * Removes all the invisible-char and lookalike-char traps.
 */
export function normalize(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(WHITESPACE_VARIANTS, ' ')
    .replace(DASH_VARIANTS, '-')
    .replace(QUOTE_VARIANTS_DOUBLE, '"')
    .replace(QUOTE_VARIANTS_SINGLE, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stricter form for case-insensitive lookup keys.
 */
export function canonicalKey(raw) {
  return normalize(raw).toLowerCase();
}

/**
 * Returns true if two names match after normalization.
 */
export function namesMatch(a, b) {
  return canonicalKey(a) === canonicalKey(b);
}

/**
 * Build a Map<canonicalKey, originalName> from a list of names.
 * Use this to index Adjust campaigns once, then lookup by Meta names later.
 */
export function buildIndex(names) {
  const idx = new Map();
  for (const n of names) {
    idx.set(canonicalKey(n), n);
  }
  return idx;
}

/**
 * Returns a clean string safe to paste into Meta Ads Manager search.
 * Meta search is exact substring; we strip the invisible chars so the search hits.
 */
export function toSearchableString(raw) {
  return normalize(raw);
}

/**
 * Diagnostic: returns details about which hidden chars were found.
 * Useful for a "why didn't this match?" debug panel.
 *
 * Uses String.prototype.match (stateless) instead of RegExp.prototype.test
 * because the module-level regexes carry the /g flag for replace(), and
 * .test() with /g mutates lastIndex across calls — order-dependent results.
 */
export function diagnoseHiddenChars(raw) {
  if (typeof raw !== 'string') return { hasIssues: false, issues: [] };
  const issues = [];
  if (raw.match(WHITESPACE_VARIANTS)) issues.push('non-standard whitespace (likely U+00A0)');
  if (raw.match(ZERO_WIDTH)) issues.push('zero-width chars');
  if (raw.match(DASH_VARIANTS)) issues.push('non-standard dash (likely U+2013 en-dash)');
  if (raw.match(QUOTE_VARIANTS_DOUBLE) || raw.match(QUOTE_VARIANTS_SINGLE)) issues.push('smart quotes');
  return { hasIssues: issues.length > 0, issues };
}
