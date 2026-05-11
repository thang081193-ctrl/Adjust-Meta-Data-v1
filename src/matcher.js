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
