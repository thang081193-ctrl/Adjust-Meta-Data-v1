// content/page-bridge.js
// Runs in the page's MAIN world (manifest world: "MAIN") so it can read the
// `__reactProps$XXX` / `__reactFiber$XXX` expando properties Meta attaches
// to DOM nodes — those properties are isolated per JS world and are NOT
// visible to the regular content script that lives in Chrome's ISOLATED
// world.
//
// === FACEBOOK SAFETY ===
// This bridge is read-only against Meta DOM:
//   ✗ NEVER calls .click(), .focus(), .dispatchEvent(), .submit(), etc.
//   ✗ NEVER mutates attributes/dataset/classList of any element Facebook
//     rendered. The only DOM mutation we perform is appending and updating
//     OUR OWN <script id="aox-bridge-data"> node under documentElement —
//     a sibling that Facebook's React reconciler does not own.
//   ✗ NEVER reads cookies, storage, auth tokens, or DOM input values.
//
// === COMMUNICATION PROTOCOL (with content/meta-injector.js) ===
// The isolated content script drives the bridge through synchronous custom
// events on `document`:
//
//   `aox-set-known-ids`   — detail: { adIds: string[], adsetIds: string[] }
//                            Bridge stores both id sets so it knows which
//                            digit-strings in row props are interesting.
//
//   `aox-scan-rows`       — no detail. Bridge scans every div.ellipsis
//                            currently in the DOM, walks each row's React
//                            props/fiber for any digit string in the stored
//                            id sets, and writes a JSON array of hits to
//                            <script id="aox-bridge-data">.
//
// The content script then reads `aox-bridge-data` synchronously after
// dispatchEvent returns (custom-event listeners run synchronously, even
// across worlds, in the same task tick). Each hit carries `{t, y, a, s}`:
//   t : ad-name text                (used as primary join key)
//   y : row centre Y (rounded)      (disambiguates duplicates in viewport)
//   a : matched ad id, if any       (Adjust creative_id_network)
//   s : matched adset id, if any    (Adjust adgroup_id_network)
//
// The content script matches each div.ellipsis it's about to decorate by
// (textContent, rounded Y mid) against the hits array — element references
// cannot cross JS worlds, so identity-by-coordinates is the substitute.

(function () {
  'use strict';

  const BRIDGE_VERSION = 'v0.2.0-combined-walks';
  const DATA_NODE_ID = 'aox-bridge-data';

  // Same skip list rationale as content/meta-injector.js: keep walk scoped
  // to this row's component subtree, don't escape into parent / sibling /
  // previous-render fibers and pollute results.
  const SKIP_FIBER_FIELDS = new Set([
    'return', 'alternate', 'sibling',
    'firstEffect', 'lastEffect', 'nextEffect',
    '_debugSource', '_debugOwner', '_debugHookTypes',
    'stateNode',
  ]);

  let knownAdIds = new Set();
  let knownAdsetIds = new Set();

  function findRowAncestor(nameEl) {
    let bestNode = nameEl;
    let bestRect = nameEl.getBoundingClientRect();
    let node = nameEl.parentElement;
    for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.height > 200) break;
      if (r.height > bestRect.height) {
        bestRect = r;
        bestNode = node;
      }
    }
    return bestNode;
  }

  // Walks `value` recursively looking for digit strings that match either
  // lookup set. Returns { adId, adsetId } as soon as both are found, or
  // exhausts the tree. Combining the two probes into one walk halves prop-
  // tree traversal cost vs. running findIdInValue twice independently.
  function findIdsInValue(value, adSet, adsetSet, found, depth, seen) {
    depth = depth || 0;
    seen = seen || new WeakSet();
    if (depth > 10 || value == null) return;
    if (found.adId && found.adsetId) return;
    if (typeof value === 'string') {
      const matches = value.match(/\d{15,19}/g);
      if (!matches) return;
      for (const id of matches) {
        if (!found.adId && adSet.has(id)) found.adId = id;
        if (!found.adsetId && adsetSet.has(id)) found.adsetId = id;
        if (found.adId && found.adsetId) return;
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const v of value) {
        findIdsInValue(v, adSet, adsetSet, found, depth + 1, seen);
        if (found.adId && found.adsetId) return;
      }
      return;
    }
    for (const k of Object.keys(value)) {
      if (SKIP_FIBER_FIELDS.has(k)) continue;
      try {
        findIdsInValue(value[k], adSet, adsetSet, found, depth + 1, seen);
        if (found.adId && found.adsetId) return;
      } catch {}
    }
  }

  function findIdsInRowProps(nameEl, adSet, adsetSet) {
    if (adSet.size === 0 && adsetSet.size === 0) return { adId: null, adsetId: null };
    const root = findRowAncestor(nameEl);
    if (!root || root === document.body) return { adId: null, adsetId: null };

    const found = { adId: null, adsetId: null };
    const stack = [root];
    let scanned = 0;
    const MAX_SCAN = 300;

    while (stack.length > 0 && scanned < MAX_SCAN) {
      const el = stack.pop();
      scanned++;
      for (const propKey of Object.keys(el)) {
        if (!propKey.startsWith('__react')) continue;
        const v = el[propKey];
        if (!v || typeof v !== 'object') continue;
        findIdsInValue(v, adSet, adsetSet, found);
        if (found.adId && found.adsetId) return found;
      }
      if (el.children) for (const c of el.children) stack.push(c);
    }
    return found;
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

  document.addEventListener('aox-set-known-ids', (e) => {
    const d = e.detail || {};
    knownAdIds = new Set(Array.isArray(d.adIds) ? d.adIds : []);
    knownAdsetIds = new Set(Array.isArray(d.adsetIds) ? d.adsetIds : []);
  });

  document.addEventListener('aox-scan-rows', () => {
    const results = [];
    let scanCount = 0;
    let hitCount = 0;
    for (const el of document.querySelectorAll('div.ellipsis')) {
      const text = (el.textContent || '').trim();
      if (!text || text.length < 5 || text.length > 200) continue;
      scanCount++;
      const { adId, adsetId } = findIdsInRowProps(el, knownAdIds, knownAdsetIds);
      if (!adId && !adsetId) continue;
      const rect = el.getBoundingClientRect();
      results.push({
        t: text,
        y: Math.round((rect.top + rect.bottom) / 2),
        a: adId || null,
        s: adsetId || null,
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
      results,
    });
  });

  console.log(`[Adjust Overlay] page-bridge loaded ${BRIDGE_VERSION}`);
})();
