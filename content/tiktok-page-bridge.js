// content/tiktok-page-bridge.js
// MAIN-world bridge for TikTok Ads Manager (manifest world: "MAIN").
//
// Why a bridge: isolated-world content scripts cannot read page-attached JS
// expandos like `__reactProps$XXX` / `__reactFiber$XXX` — see
// docs/findings/page_world_bridge.md.
//
// Why TikTok-specific: unlike Meta's nested row containers, TikTok's
// `<ks-virtual-table>` renders cells directly with no row DOM at all. But
// every cell's own `__reactProps` already carries the row's identity (ad id /
// adset id / campaign id). So this bridge does NOT walk a row subtree —
// instead it scans each name-link cell's OWN react expandos for any digit
// string in our id maps and writes the hit table.
//
// === FACEBOOK / TIKTOK SAFETY ===
// Read-only against TikTok DOM:
//   ✗ NEVER calls .click(), .focus(), .dispatchEvent(), .submit(), etc.
//   ✗ NEVER mutates attributes/dataset/classList of any element TikTok
//     rendered. The only DOM mutation is appending and updating OUR own
//     <script id="aox-tt-bridge-data"> node under documentElement.
//   ✗ NEVER reads cookies, storage, auth tokens, or DOM input values.
//
// === COMMUNICATION PROTOCOL (with content/tiktok-injector.js) ===
//   `aox-tt-set-known-ids` — detail: { adIds, adsetIds, campIds }
//   `aox-tt-scan-rows`     — no detail. Bridge walks every name-link cell,
//                            finds id matches in own react expandos, writes
//                            JSON to <script id="aox-tt-bridge-data">.
// Each hit: { t, y, a, s, c }
//   t : text content of the cell    (primary join key)
//   y : rounded Y mid-pixel         (jitter-tolerant secondary key)
//   a : matched ad id, if any
//   s : matched adset id, if any
//   c : matched campaign id, if any

(function () {
  'use strict';

  const BRIDGE_VERSION = 'v0.1.1-tt';
  const DATA_NODE_ID = 'aox-tt-bridge-data';

  // KsLink is TikTok's link-text component used for the row name cells in
  // every Campaigns / Ad groups / Ads list view. The variant `KsLink--inherit`
  // matches the unstyled name link specifically, which keeps us from
  // false-positively matching navigation links elsewhere on the page.
  const NAME_CELL_SELECTOR = '[class*="KsLink--inherit"]';

  let knownAdIds = new Set();
  let knownAdsetIds = new Set();
  let knownCampIds = new Set();

  function findIdInValue(value, lookupSet, depth, seen) {
    depth = depth || 0;
    seen = seen || new WeakSet();
    if (depth > 10 || value == null) return null;
    if (typeof value === 'string') {
      const matches = value.match(/\d{15,19}/g);
      if (!matches) return null;
      for (const id of matches) {
        if (lookupSet.has(id)) return id;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const v of value) {
        const r = findIdInValue(v, lookupSet, depth + 1, seen);
        if (r) return r;
      }
      return null;
    }
    for (const k of Object.keys(value)) {
      try {
        const r = findIdInValue(value[k], lookupSet, depth + 1, seen);
        if (r) return r;
      } catch {}
    }
    return null;
  }

  function findIdInOwnProps(el, lookupSet) {
    if (lookupSet.size === 0) return null;
    for (const k of Object.keys(el)) {
      if (!k.startsWith('__react')) continue;
      const v = el[k];
      if (!v || typeof v !== 'object') continue;
      const id = findIdInValue(v, lookupSet);
      if (id) return id;
    }
    return null;
  }

  function ensureDataNode() {
    let node = document.getElementById(DATA_NODE_ID);
    if (!node) {
      node = document.createElement('script');
      node.id = DATA_NODE_ID;
      node.type = 'application/json';
      document.documentElement.appendChild(node);
    }
    return node;
  }

  document.addEventListener('aox-tt-set-known-ids', (e) => {
    const d = e.detail || {};
    knownAdIds = new Set(Array.isArray(d.adIds) ? d.adIds : []);
    knownAdsetIds = new Set(Array.isArray(d.adsetIds) ? d.adsetIds : []);
    knownCampIds = new Set(Array.isArray(d.campIds) ? d.campIds : []);
  });

  document.addEventListener('aox-tt-scan-rows', () => {
    const results = [];
    let scanCount = 0;
    let hitCount = 0;

    for (const el of document.querySelectorAll(NAME_CELL_SELECTOR)) {
      const text = (el.textContent || '').trim();
      if (!text || text.length < 5 || text.length > 200) continue;
      scanCount++;

      const adId = findIdInOwnProps(el, knownAdIds);
      const adsetId = findIdInOwnProps(el, knownAdsetIds);
      const campId = findIdInOwnProps(el, knownCampIds);
      if (!adId && !adsetId && !campId) continue;

      const rect = el.getBoundingClientRect();
      results.push({
        t: text,
        y: Math.round((rect.top + rect.bottom) / 2),
        a: adId || null,
        s: adsetId || null,
        c: campId || null,
      });
      hitCount++;
    }

    const node = ensureDataNode();
    node.textContent = JSON.stringify({
      version: BRIDGE_VERSION,
      timestamp: Date.now(),
      scanned: scanCount,
      hits: hitCount,
      knownAdIdsSize: knownAdIds.size,
      knownAdsetIdsSize: knownAdsetIds.size,
      knownCampIdsSize: knownCampIds.size,
      results,
    });
  });

  console.log(
    `%c[AOX-TT ${BRIDGE_VERSION}]%c tiktok-page-bridge loaded`,
    'background:#ff0066;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
    'color:#ff0066;font-weight:bold'
  );
})();
