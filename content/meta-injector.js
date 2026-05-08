// content/meta-injector.js
// Injects multi-window ROAS pills into Meta Ads Manager campaign rows.
//
// === FACEBOOK ACCOUNT SAFETY ===
// This script is engineered to have ZERO impact on the user's Meta/Facebook
// account beyond appending visual-only DOM nodes that Facebook's React tree
// does not own. Specifically:
//
//   READ-ONLY of Meta DOM:
//     ✓ querySelector + textContent (no innerHTML reads of forms)
//     ✗ NEVER reads cookies, localStorage, sessionStorage, IndexedDB
//     ✗ NEVER reads auth tokens, access_token URL params, or DOM input values
//
//   NO MUTATION of Meta-owned elements:
//     ✓ Pills inserted as SIBLINGS via insertBefore — never inside a
//       Meta-managed container, never as replacement of a Meta node.
//     ✗ NEVER sets attributes (class, style, dataset, aria-*) on any element
//       Facebook rendered. Decoration tracking lives in a JS WeakMap so the
//       DOM observed by Facebook's React reconciler is unmodified.
//     ✗ NEVER calls .click(), .focus(), .dispatchEvent(), .submit() on
//       anything.
//
//   NO NETWORK to facebook.com:
//     ✗ NEVER calls fetch / XMLHttpRequest to any facebook.com host. The
//       extension's manifest host_permissions only includes adjust.com, so
//       even if we tried, Chrome would block it.
//     ✗ NEVER imports scripts, images, or iframes from third parties.
//
//   NO FACEBOOK-VISIBLE BEHAVIOR CHANGE:
//     ✓ Page interactions (clicks, scrolling, navigation) work exactly as
//       Facebook ships them — we do not capture, intercept, or rewrite events.
//
// Strategy: text-driven matching. Meta has dropped ARIA grid/row roles, so
// scoped grid selectors no longer work. Instead we walk every truncated-text
// container (`div.ellipsis`, a stable Meta utility class) and check whether
// its text matches a known Adjust campaign name. No false positives unless
// some other UI element happens to render an exact campaign-name string.

(function () {
  'use strict';

  // ---- Embedded copy of matcher logic (content scripts can't easily import modules) ----
  // ⚠️ KEEP IN SYNC WITH src/matcher.js. If you change normalization rules here
  // without updating that file (or vice versa), content-side keys will diverge
  // from background-side keys and pills will stop matching. See header comment
  // in src/matcher.js for the full rationale.
  const WHITESPACE_VARIANTS = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g;
  const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060]/g;
  const DASH_VARIANTS = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;

  function canonicalKey(raw) {
    if (typeof raw !== 'string') return '';
    return raw
      .normalize('NFC')
      .replace(ZERO_WIDTH, '')
      .replace(WHITESPACE_VARIANTS, ' ')
      .replace(DASH_VARIANTS, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // div.ellipsis is Meta's text-truncation utility. Verified 2026-05-07 via
  // DOM inspection: campaign names render inside such a div one level above
  // their innermost SPAN. Other truncated text (account names, breadcrumbs)
  // also matches this selector — the campaign-name lookup filters those out.
  const NAME_CANDIDATE_SELECTOR = 'div.ellipsis';

  let campaignIndex = new Map();
  let adsetIndex = new Map();
  let adIndex = new Map();
  // Composite indexes keyed by `${metaCampaignId}::${nameKey}` to disambiguate
  // when the same ad-name or adset-name appears in multiple campaigns. The
  // campaign id comes from Adjust's attr_dependency.campaign_id_network and
  // matches Meta's selected_campaign_ids URL param exactly.
  let adsetCompositeIndex = new Map();
  let adCompositeIndex = new Map();
  let lastSyncAt = null;
  let sourceLabel = '';

  let bodyObserver = null;
  let decorateTimer = null;
  // Tracks which campaign key each ellipsis div is currently decorated for.
  // WeakMap keyed by Meta-owned DOM nodes — does NOT mutate those nodes (no
  // dataset/class/attribute changes), so React's reconciler is unaffected.
  // Entries auto-evict when Meta removes the node from the DOM.
  const decoratedKey = new WeakMap();

  // Row-Y bucket index, valid only inside one decorateAllVisibleRows() pass.
  // Built lazily on first ambiguous lookup, cleared at the end of the pass.
  // Meta uses a frozen-column table layout: the Ad-name cell (left frozen
  // panel) and the Campaign-name / Campaign-ID cells (right scrollable panel)
  // do NOT share a parent — they sit in entirely separate DOM subtrees that
  // only meet at the table root. Walking up the DOM never reaches them
  // before crossing other rows. They DO share a vertical Y coordinate
  // because Meta aligns them visually. Bucketing by Y at decoration time
  // makes "find the same row's other cells" an O(1) lookup.
  let rowYBuckets = null;
  const ROW_BUCKET_PX = 8;

  // Disambiguation tally for the last decorateAllVisibleRows() pass. Logged
  // by logDomDiagnostics() instead of recomputed there, so diagnostics is
  // O(N) instead of O(N × walk).
  let lastDecorateStats = {
    ambiguous: 0,
    resolvedByScope: 0,
    resolvedByMetaPreload: 0,
    resolvedByReactProps: 0,
    resolvedByDom: 0,
    stillAmbiguous: 0,
  };

  // Meta preloads campaign/ad structure as JSON inside <script> tags BEFORE
  // rendering the table — specifically `campaign_structure_tree` payloads,
  // one per filtered campaign. Each tree exposes the campaign_id alongside
  // its nested adgroup_id + name pairs, giving us a direct ad-name →
  // campaign_id mapping for every ad currently in the user's view. This
  // bypasses all DOM fragility (frozen columns, virtualized cells, varying
  // class names, line-clamp wrappers).
  //
  // History: an earlier version of this index used (ad_name, spend) →
  // campaign_id pulled from preloaded insights rows. As of 2026-05 Meta
  // dropped ad-level rows from preload (insights now ships campaign-level
  // dimension_values only), so spend-matching at ad level is no longer
  // possible from the static preload. The structure tree is naturally
  // scoped to the user's filter, which usually leaves a name unique
  // in-view; when it doesn't, we fall back to DOM Y-position.
  //
  // metaPreloadIndex.byName        : Map<nameKey, Set<campId>>
  // metaPreloadIndex.byAdgroupId   : Map<adgroupId, campId>
  // metaPreloadIndex.parsedAt      : timestamp
  // metaPreloadIndex.urlFingerprint: window.location.search at parse time;
  //   invalidates the cache when the user changes filters.
  let metaPreloadIndex = {
    byName: new Map(),
    byAdgroupId: new Map(),
    parsedAt: 0,
    urlFingerprint: '',
  };

  // ---- Sync data from background ----
  async function loadData() {
    try {
      const cached = await chrome.runtime.sendMessage({ type: 'GET_CACHED' });
      if (cached?.error) {
        showBanner(`Data load error: ${cached.error}`, 'error');
        return;
      }
      if (!cached) {
        showBanner('No Adjust data yet. Click extension icon → Sync.', 'warn');
        return;
      }

      // Cached rows come at two levels: 'campaign' (one row per campaign,
      // pulled directly with dimensions=campaign_network) and 'ad' (one row
      // per ad, pulled with all four dimensions). Campaign names are unique
      // per account so campaignIndex never collides. Ad names and ad set names
      // routinely repeat across campaigns (e.g. "MVideo 2003" reused in 20
      // campaigns), so for those we also build composite (campaignId::name)
      // indexes — used when the user has drilled into a specific campaign and
      // Meta's URL exposes ?selected_campaign_ids=ID.
      const campaignRows = cached.campaigns.filter(r => r.level === 'campaign');
      const adRows = cached.campaigns.filter(r => r.level === 'ad');

      campaignIndex = buildDirectIndex(campaignRows, r => r.campaignName);
      const adsetBuilt = buildAggregatedIndex(adRows, r => r.adsetName);
      adsetIndex = adsetBuilt.byName;
      adsetCompositeIndex = adsetBuilt.byComposite;
      const adBuilt = buildAdIndex(adRows);
      adIndex = adBuilt.byName;
      adCompositeIndex = adBuilt.byComposite;
      lastSyncAt = cached.lastSyncAt;
      sourceLabel = cached.sourceLabel;

      showBanner(buildBannerText(), cached.isStale ? 'warn' : 'ok');
      // Clear before redecorating — otherwise after a sync, existing pills
      // would short-circuit the dedup check and keep showing stale ROAS.
      removeAllPills();
      ensureObserving();
      decorateAllVisibleRows();
      logDomDiagnostics();
    } catch (err) {
      // Extension context invalidated etc. - fail silently in content script,
      // user will see the issue when they click the popup.
      console.warn('[Adjust Overlay] loadData failed:', err.message);
    }
  }

  // Direct index: 1 row per name. Used for campaigns where names ARE unique.
  // (Ads use buildAdIndex below because their names regularly collide.)
  function buildDirectIndex(rows, getName) {
    const out = new Map();
    for (const row of rows) {
      const name = getName(row);
      if (!name) continue;
      out.set(canonicalKey(name), {
        campaignName: name,
        network: row.network,
        rowCount: 1,
        cost: row.cost,
        installs: row.installs,
        roas: row.roas,
      });
    }
    return out;
  }

  // Ad index with collision handling. Returns:
  //   byName: Map<adKey, AdEntry | AmbiguousEntry>
  //   byComposite: Map<`${campaignId}::${adKey}`, AdEntry>  (always unique)
  // AmbiguousEntry shape:
  //   { ambiguous: true, candidates: Row[], campaignName, roas (aggregated), ... }
  function buildAdIndex(adRows) {
    const byName = new Map();
    const byComposite = new Map();
    const collisions = new Set();
    const accums = new Map(); // adKey -> all rows for that name

    for (const row of adRows) {
      if (!row.adName) continue;
      const k = canonicalKey(row.adName);
      const single = {
        campaignName: row.adName,
        network: row.network,
        rowCount: 1,
        cost: row.cost,
        installs: row.installs,
        roas: row.roas,
        // Echo parent context for the ambiguous tooltip. Not shown in pill.
        parentCampaignName: row.campaignName,
        parentAdsetName: row.adsetName,
        campaignId: row.campaignId,
      };

      if (row.campaignId) {
        byComposite.set(`${row.campaignId}::${k}`, single);
      }

      if (!byName.has(k)) {
        byName.set(k, single);
        accums.set(k, [row]);
      } else {
        collisions.add(k);
        accums.get(k).push(row);
      }
    }

    // Convert collisions to ambiguous entries with aggregated metrics so the
    // pill at least shows a sane "across all duplicates" number.
    for (const k of collisions) {
      const rows = accums.get(k);
      const agg = aggregateRoas(rows);
      byName.set(k, {
        ambiguous: true,
        candidates: rows,
        campaignName: rows[0].adName,
        rowCount: rows.length,
        ...agg,
      });
    }

    return { byName, byComposite };
  }

  // Aggregated index for ad sets (API doesn't return adset-level rows; we
  // roll ads up by adsetName). Same composite-key disambiguation as ads —
  // adset names can repeat across campaigns ("2003 Italy" in 8 campaigns).
  function buildAggregatedIndex(rows, getName) {
    const byName = new Map();
    const byComposite = new Map();
    const composites = new Map(); // `${campId}::${k}` -> rows[]
    const flats = new Map();      // k -> rows[]

    for (const row of rows) {
      const name = getName(row);
      if (!name) continue;
      const k = canonicalKey(name);
      if (!flats.has(k)) flats.set(k, []);
      flats.get(k).push(row);
      if (row.campaignId) {
        const ck = `${row.campaignId}::${k}`;
        if (!composites.has(ck)) composites.set(ck, []);
        composites.get(ck).push(row);
      }
    }

    for (const [ck, rs] of composites) {
      byComposite.set(ck, {
        campaignName: getName(rs[0]),
        network: rs[0].network,
        rowCount: rs.length,
        ...aggregateRoas(rs),
      });
    }

    for (const [k, rs] of flats) {
      const distinctCampaigns = new Set(rs.map(r => r.campaignId).filter(Boolean));
      const ambiguous = distinctCampaigns.size > 1;
      const entry = {
        campaignName: getName(rs[0]),
        network: rs[0].network,
        rowCount: rs.length,
        ...aggregateRoas(rs),
      };
      if (ambiguous) {
        entry.ambiguous = true;
        entry.candidates = rs;
      }
      byName.set(k, entry);
    }

    return { byName, byComposite };
  }

  // Sum cost and back-computed cohort revenue across rows, divide at the end.
  // Aggregating ROAS this way correctly weights each row by its cost; naive
  // averaging would treat a $0.10 ad and a $1000 ad as equally important.
  function aggregateRoas(rows) {
    let cost = 0, installs = 0, cohortAllRev = 0;
    let r0 = 0, c0 = 0, r3 = 0, c3 = 0, r7 = 0, c7 = 0;
    for (const row of rows) {
      const rc = row.cost || 0;
      cost += rc;
      installs += row.installs || 0;
      cohortAllRev += row.cohortAllRevenue || 0;
      const r = row.roas || {};
      if (r.d0 != null) { r0 += r.d0 * rc; c0 += rc; }
      if (r.d3 != null) { r3 += r.d3 * rc; c3 += rc; }
      if (r.d7 != null) { r7 += r.d7 * rc; c7 += rc; }
    }
    return {
      cost,
      installs,
      roas: {
        d0: c0 > 0 ? r0 / c0 : null,
        d3: c3 > 0 ? r3 / c3 : null,
        d7: c7 > 0 ? r7 / c7 : null,
        allTime: cost > 0 ? cohortAllRev / cost : null,
      },
    };
  }

  function logDomDiagnostics() {
    const candidates = document.querySelectorAll(NAME_CANDIDATE_SELECTOR);
    let firstMatch = null;
    let matchCount = 0;
    let matchedLevel = null;
    for (const el of candidates) {
      const text = el.textContent || '';
      const k = canonicalKey(text);
      const lvl = adIndex.has(k) ? 'ad' : adsetIndex.has(k) ? 'adset' : campaignIndex.has(k) ? 'campaign' : null;
      if (lvl) {
        matchCount++;
        if (!firstMatch) { firstMatch = text.slice(0, 120); matchedLevel = lvl; }
      }
    }

    // Stats come from the decoration pass that just finished — diagnostics
    // does NOT redo the disambiguation work. This used to be done inline here,
    // doubling the per-pass cost on pages with many ambiguous rows.
    let ambiguousCount = 0;
    for (const e of adIndex.values()) if (e?.ambiguous) ambiguousCount++;
    const scope = getScopedCampaignIds();
    console.log('[Adjust Overlay] DOM diagnostics', {
      candidateSelector: NAME_CANDIDATE_SELECTOR,
      candidatesFound: candidates.length,
      matchedToAdjustNames: matchCount,
      firstMatchText: firstMatch,
      firstMatchLevel: matchedLevel,
      indexSizes: { campaign: campaignIndex.size, adset: adsetIndex.size, ad: adIndex.size },
      adNamesAmbiguousInIndex: ambiguousCount,
      urlScopedCampaignIds: scope ? [...scope] : null,
      lastDecoratePass: { ...lastDecorateStats },
    });
  }

  // ---- Decorate one candidate ----
  // Place pill as a SIBLING (not child) of the ellipsis div, because the
  // ellipsis container clips overflowing children — a pill appended inside
  // would get truncated. Also: inserting a sibling means we never modify any
  // Meta-owned element (the parent's children list does change, but we never
  // touch attributes of Facebook nodes).
  function decorateCandidate(el) {
    const rawName = el.textContent || '';
    if (rawName.length < 5 || rawName.length > 300) return;
    const key = canonicalKey(rawName);
    // Try most specific first (ad), then ad set, then campaign. Meta's three
    // tabs only ever render one of these names per row, so collisions across
    // levels (same string used as both a campaign name and an ad name) are
    // rare. If they do happen, ad wins because it's the actionable unit.
    const data =
      lookupAmbiguousAware(el, key, adIndex, adCompositeIndex) ||
      lookupAmbiguousAware(el, key, adsetIndex, adsetCompositeIndex) ||
      campaignIndex.get(key);
    if (!data) return;

    // Already decorated for this exact key? Self-healing dedup via WeakMap:
    // if Meta replaces el, its WeakMap entry auto-clears and we re-decorate.
    if (decoratedKey.get(el) === key) return;

    // Stale pill (key changed because the row was reused for another
    // campaign) — remove the old one before adding the new.
    const stalePill = el.nextElementSibling;
    if (stalePill?.classList?.contains('adjust-pill')) {
      stalePill.remove();
    }

    const pill = document.createElement('span');
    if (data.ambiguous) {
      pill.className = 'adjust-pill adjust-pill-ambiguous';
      pill.title = formatAmbiguousTooltip(data);
    } else {
      pill.className = `adjust-pill adjust-pill-${classifyForColor(data.roas)}`;
      pill.title = formatTooltip(data);
    }
    fillPillSegments(pill, data.roas);
    el.parentNode.insertBefore(pill, el.nextSibling);
    decoratedKey.set(el, key);
  }

  // Resolve an ambiguous index entry to a single (campaignId, name) match
  // using two strategies in order. Returns the resolved entry, the original
  // ambiguous entry as a fallback, or null when the name isn't indexed at all.
  //
  // Strategy 1 — URL scope:
  //   When the user drilled into a single campaign, Meta puts
  //   ?selected_campaign_ids=ID in the URL. Composite-index lookup is exact.
  //
  // Strategy 2 — Meta preload structure tree by ad name:
  //   Meta loads each filtered campaign's `campaign_structure_tree` as JSON
  //   inside <script> tags BEFORE rendering the table. We parse those once
  //   to build ad-name → Set<campaign_id>. Because the tree only contains
  //   campaigns Meta actually loaded for the current view, the set is often
  //   already a singleton; otherwise we narrow by intersecting with Adjust's
  //   candidate campaigns and (when present) urlScopedCampaignIds.
  //
  // Strategy 3 — Row's own adgroup_id from React props (most reliable):
  //   Meta's grid renders each row with React; React stores the developer's
  //   props on the DOM via hidden `__reactProps$XXX` properties on each
  //   element. Those props embed the row's adgroup_id (Meta's ad ID). We
  //   walk the row container's subtree, locate any 15–19 digit string in
  //   the props that matches our preload `byAdgroupId` map, and resolve
  //   directly to that adgroup's campaign_id. Robust against same-name
  //   ambiguity, virtualization, frozen columns, and column visibility.
  //
  // Strategy 4 — DOM row context (Y-position match):
  //   Last resort. Look for a Meta campaign id (15–19 digits) or full
  //   campaign name in another cell on the same visual row.
  //
  // If nothing resolves, we return the ambiguous aggregate so the user at
  // least sees a (clearly-flagged) totals pill rather than nothing.
  function lookupAmbiguousAware(el, key, byName, byComposite) {
    const entry = byName.get(key);
    if (!entry) return null;
    if (!entry.ambiguous) return entry;

    lastDecorateStats.ambiguous++;

    const scope = getScopedCampaignIds();
    if (scope && scope.size === 1) {
      const onlyId = scope.values().next().value;
      const m = byComposite.get(`${onlyId}::${key}`);
      if (m) {
        lastDecorateStats.resolvedByScope++;
        return m;
      }
    }

    const metaPreloadCampId = findCampaignIdViaMetaPreload(key, entry.candidates);
    if (metaPreloadCampId) {
      const m = byComposite.get(`${metaPreloadCampId}::${key}`);
      if (m) {
        lastDecorateStats.resolvedByMetaPreload++;
        return m;
      }
    }

    const reactPropsCampId = findCampaignIdViaReactProps(el, entry.candidates);
    if (reactPropsCampId) {
      const m = byComposite.get(`${reactPropsCampId}::${key}`);
      if (m) {
        lastDecorateStats.resolvedByReactProps++;
        return m;
      }
    }

    const rowCampaignId = findRowCampaignIdByYPosition(el, entry.candidates);
    if (rowCampaignId) {
      const m = byComposite.get(`${rowCampaignId}::${key}`);
      if (m) {
        lastDecorateStats.resolvedByDom++;
        return m;
      }
    }

    lastDecorateStats.stillAmbiguous++;
    return entry;
  }

  // ---- Meta preload structure tree parser ----
  // Meta Ads Manager ships each filtered campaign's full structure as JSON
  // inside <script> tags. The shape is:
  //
  //   "campaign_structure_tree": {
  //     "children": [{
  //       "adset_id": "...", "name": "<adset name>", "status": "...",
  //       "children": [{
  //         "adgroup_id": "<ad id>", "name": "<ad name>", "status": "..."
  //       }, ...]
  //     }, ...],
  //     "campaign_id": "<camp id>", "name": "<camp name>", "status": "..."
  //   }
  //
  // The OUTER campaign_id is the only one in the tree (adgroups don't have a
  // campaign_id field), so we can extract it with a non-greedy first-match
  // regex. Adgroup pairs are extracted with a flat-block regex because each
  // adgroup object never nests another `{}` between its adgroup_id and name.
  //
  // The cache is keyed by URL search-string fingerprint so changing filters
  // immediately invalidates it (parsedAt TTL covers within-filter mutations).
  function ensureMetaPreloadIndex() {
    const fingerprint = window.location.search;
    const fresh = Date.now() - metaPreloadIndex.parsedAt < 30000;
    const sameFilter = fingerprint === metaPreloadIndex.urlFingerprint;
    if (fresh && sameFilter && metaPreloadIndex.byName.size > 0) {
      return metaPreloadIndex;
    }

    const byName = new Map();        // nameKey -> Set<campId>
    const byAdgroupId = new Map();   // adgroupId -> campId

    const campIdRe = /"campaign_id":"(\d+)"/;
    const adgroupRe = /"adgroup_id":"(\d+)"[^{}]*?"name":"((?:[^"\\]|\\.)*)"/g;

    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      if (text.length < 500) continue;
      if (!text.includes('"campaign_structure_tree"')) continue;

      for (const treeBody of extractStructureTreeBodies(text)) {
        const cm = campIdRe.exec(treeBody);
        if (!cm) continue;
        const campId = cm[1];

        adgroupRe.lastIndex = 0;
        let am;
        while ((am = adgroupRe.exec(treeBody)) !== null) {
          const adgroupId = am[1];
          const rawName = am[2];
          const name = rawName.includes('\\') ? decodeJsonStringEscapes(rawName) : rawName;
          const nameKey = canonicalKey(name);
          if (!nameKey) continue;

          let set = byName.get(nameKey);
          if (!set) { set = new Set(); byName.set(nameKey, set); }
          set.add(campId);

          byAdgroupId.set(adgroupId, campId);
        }
      }
    }

    metaPreloadIndex = {
      byName,
      byAdgroupId,
      parsedAt: Date.now(),
      urlFingerprint: fingerprint,
    };
    return metaPreloadIndex;
  }

  // Walk the script text once to find every `"campaign_structure_tree":{...}`
  // payload, returning each one's body (the chars between its outer braces).
  // The brace counter is string- and escape-aware so we don't get fooled by
  // `}` inside string literals (e.g. names containing punctuation).
  function extractStructureTreeBodies(text) {
    const bodies = [];
    const marker = '"campaign_structure_tree":{';
    let pos = 0;
    while (true) {
      const start = text.indexOf(marker, pos);
      if (start === -1) break;
      const bodyStart = start + marker.length;
      let depth = 1;
      let i = bodyStart;
      let inStr = false;
      let esc = false;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (esc) {
          esc = false;
        } else if (c === '\\') {
          esc = true;
        } else if (c === '"') {
          inStr = !inStr;
        } else if (!inStr) {
          if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        i++;
      }
      if (depth === 0) bodies.push(text.slice(bodyStart, i - 1));
      pos = i;
    }
    return bodies;
  }

  function decodeJsonStringEscapes(s) {
    return s
      .replace(/\\(["\\/])/g, '$1')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }

  // Resolve via Meta's structure tree: ad-name → Set<campaign_id>, narrowed
  // by Adjust's candidate campaigns and (when present) urlScopedCampaignIds.
  //
  // The tree is naturally scoped to the user's filter — Meta only ships trees
  // for campaigns currently loaded — so a name unique within that filter
  // resolves immediately. When the same name appears in multiple in-view
  // campaigns the intersection often still collapses to one (Adjust may
  // only have data for some of them); if not, return null and let DOM
  // Y-position handle it.
  function findCampaignIdViaMetaPreload(nameKey, candidates) {
    const idx = ensureMetaPreloadIndex();
    if (idx.byName.size === 0) return null;

    const treeCampIds = idx.byName.get(nameKey);
    if (!treeCampIds || treeCampIds.size === 0) return null;

    const validCampIds = new Set();
    for (const c of candidates) {
      if (c?.campaignId) validCampIds.add(String(c.campaignId));
    }
    if (validCampIds.size === 0) return null;

    const intersected = [...treeCampIds].filter(id => validCampIds.has(id));
    if (intersected.length === 1) return intersected[0];
    if (intersected.length === 0) return null;

    // Multiple intersect — narrow further by URL scope if available.
    const scope = getScopedCampaignIds();
    if (scope) {
      const narrowed = intersected.filter(id => scope.has(id));
      if (narrowed.length === 1) return narrowed[0];
    }
    return null;
  }

  // Read the row's own adgroup_id from the React props that Meta attaches
  // to its DOM nodes via `__reactProps$XXX` hidden properties (a stable
  // React 17+ convention). The props embed the row's adgroup_id as a 15–19
  // digit string; once we find one that's in our preload `byAdgroupId`
  // map, we resolve directly to that adgroup's campaign_id — no DOM column
  // visibility, spend matching, or Y-position guesswork required.
  //
  // We BFS the row container's subtree, walking each node's React props
  // recursively (cycle-safe) and matching any 15–19 digit substring
  // against the known-adgroup-id map. The first hit whose campaign_id is
  // also in Adjust's candidate set wins.
  function findCampaignIdViaReactProps(nameEl, candidates) {
    const idx = ensureMetaPreloadIndex();
    if (idx.byAdgroupId.size === 0) return null;

    const validCampIds = new Set();
    for (const c of candidates) {
      if (c?.campaignId) validCampIds.add(String(c.campaignId));
    }
    if (validCampIds.size === 0) return null;

    const rowContainer = findRowAncestor(nameEl).node;
    if (!rowContainer || rowContainer === document.body) return null;

    // DFS via stack with a scan cap — typical row has tens of elements,
    // but a runaway subtree should not stall decoration.
    const stack = [rowContainer];
    let scanned = 0;
    const MAX_SCAN = 300;

    while (stack.length > 0 && scanned < MAX_SCAN) {
      const el = stack.pop();
      scanned++;

      for (const propKey of Object.keys(el)) {
        if (!propKey.startsWith('__reactProps')) continue;
        const props = el[propKey];
        if (!props || typeof props !== 'object') continue;

        const adgroupId = findAdgroupIdInValue(props, idx.byAdgroupId);
        if (adgroupId) {
          const campId = idx.byAdgroupId.get(adgroupId);
          if (campId && validCampIds.has(campId)) return campId;
        }
      }

      if (el.children) {
        for (const child of el.children) stack.push(child);
      }
    }
    return null;
  }

  // Recursively scan a value (object/array/string/etc.) for a 15–19 digit
  // substring that appears as a key in `byAdgroupId`. Returns the matched
  // id string, or null. Depth-limited and cycle-safe via WeakSet.
  function findAdgroupIdInValue(value, byAdgroupId, depth, seen) {
    depth = depth || 0;
    seen = seen || new WeakSet();
    if (depth > 6) return null;
    if (value == null) return null;

    if (typeof value === 'string') {
      const matches = value.match(/\d{15,19}/g);
      if (!matches) return null;
      for (const id of matches) {
        if (byAdgroupId.has(id)) return id;
      }
      return null;
    }

    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const v of value) {
        const r = findAdgroupIdInValue(v, byAdgroupId, depth + 1, seen);
        if (r) return r;
      }
      return null;
    }

    for (const k of Object.keys(value)) {
      try {
        const r = findAdgroupIdInValue(value[k], byAdgroupId, depth + 1, seen);
        if (r) return r;
      } catch {}
    }
    return null;
  }

  // Walk up from `nameEl` to find the tallest plausible single-row ancestor.
  // Returns both the ancestor node (used by React-props scan) and its rect
  // (used by Y-bucket lookup). Stops once an ancestor exceeds 200px since
  // that means we've left the row and entered a multi-row container.
  function findRowAncestor(nameEl) {
    const myRect = nameEl.getBoundingClientRect();
    let bestNode = nameEl;
    let bestRect = myRect;
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
    return { node: bestNode, rect: bestRect };
  }

  // Lazily build (and cache for the duration of the current decorate pass) a
  // bucketed index of every visible-text leaf on the page, keyed by rounded
  // Y midpoint. ROW_BUCKET_PX is 8 — small enough that a row only ever
  // spans 1–2 buckets, large enough that a typical row occupies a single
  // key. Built once per pass; rebuilt only after pills update.
  //
  // We scan EVERY leaf element rather than a class-based selector. Meta's
  // table markup varies between account views and column configurations:
  // sometimes div.ellipsis, sometimes inline -webkit-line-clamp, sometimes
  // a plain unstyled div. Diagnostics on real accounts (2026-05-07) showed
  // that even `div[style*="line-clamp"]` returns 0 in some views where the
  // outerHTML clearly shows that style elsewhere. A universal leaf scan is
  // the only durable strategy. The length filter (5–300 chars) cheaply
  // rejects structural shells and one-char labels; ID/name matching in
  // findRowCampaignIdByYPosition is exact, so over-bucketing is harmless.
  function ensureRowYBuckets() {
    if (rowYBuckets) return rowYBuckets;
    rowYBuckets = new Map();
    // SKIP_TAGS leaves carry textContent (CSS rules, JS source) that would
    // pollute the bucket index without ever rendering on the page. Also skip
    // SVG-internal nodes — they have rects but never display row data.
    const SKIP_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
      'META', 'LINK', 'TITLE', 'HEAD',
      'SVG', 'PATH', 'CIRCLE', 'RECT', 'POLYGON', 'G', 'DEFS', 'USE',
    ]);
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length < 5 || t.length > 300) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const mid = (r.top + r.bottom) / 2;
      const k = Math.round(mid / ROW_BUCKET_PX);
      let bucket = rowYBuckets.get(k);
      if (!bucket) { bucket = []; rowYBuckets.set(k, bucket); }
      bucket.push(el);
    }
    return rowYBuckets;
  }

  // Vertical range of the row that contains `nameEl`. The ancestor's
  // bounding rect spans the FULL row height (image + name + pill stack),
  // so cells in any column — even those rendered with different vertical
  // alignment in their own column subtree — will have midpoints inside
  // this Y range. Shares the row-ancestor walk with React-props lookup.
  function getRowYRange(nameEl) {
    const { rect } = findRowAncestor(nameEl);
    return { top: rect.top - 2, bottom: rect.bottom + 2 };
  }

  // Find an ID/name match in cells sharing nameEl's row.
  // We try Campaign ID first because it's a 15-19 digit string with no
  // normalization quirks — if the user has the Campaign ID column on, this
  // gives us a perfect, unambiguous match. Campaign name is fallback.
  function findRowCampaignIdByYPosition(nameEl, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const knownIds = new Set();
    const campKeyToId = new Map();
    for (const c of candidates) {
      if (c?.campaignId) {
        const id = String(c.campaignId);
        knownIds.add(id);
        if (c?.campaignName) {
          campKeyToId.set(canonicalKey(c.campaignName), id);
        }
      }
    }
    if (knownIds.size === 0) return null;

    const myRect = nameEl.getBoundingClientRect();
    if (myRect.height === 0) return null;
    const buckets = ensureRowYBuckets();

    // Row Y-range comes from the tallest single-row ancestor of nameEl.
    // Cells anywhere on the page whose midpoint falls inside this range
    // belong to the same row, even when they live in a different column
    // subtree (frozen vs scrollable side of Meta's table).
    const rowRange = getRowYRange(nameEl);
    const rowMid = (rowRange.top + rowRange.bottom) / 2;
    const rowMidKey = Math.round(rowMid / ROW_BUCKET_PX);
    const halfHeight = (rowRange.bottom - rowRange.top) / 2;
    const bucketSpan = Math.max(1, Math.ceil(halfHeight / ROW_BUCKET_PX));

    // First pass: collect same-row cells once, scan for exact ID / name match.
    // Second pass: prefix-match for truncated names (e.g. "Meta LPT 11 ...").
    const sameRow = [];
    for (let dk = -bucketSpan; dk <= bucketSpan; dk++) {
      const bucket = buckets.get(rowMidKey + dk);
      if (!bucket) continue;
      for (const el of bucket) {
        if (el === nameEl) continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        const mid = (r.top + r.bottom) / 2;
        if (mid < rowRange.top || mid > rowRange.bottom) continue;
        sameRow.push(el);
      }
    }

    for (const el of sameRow) {
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      // Exact ID match (cell whose text is just the ID).
      if (knownIds.has(txt)) return txt;
      // Embedded-ID match: cell text might be wrapped (e.g. "Campaign ID: 1202…",
      // a trailing zero-width char) so look for any 15–19 digit substring and
      // check each against knownIds.
      const matches = txt.match(/\d{15,19}/g);
      if (matches) {
        for (const m of matches) {
          if (knownIds.has(m)) return m;
        }
      }
      // Exact name match.
      const ck = canonicalKey(txt);
      const idByName = campKeyToId.get(ck);
      if (idByName) return idByName;
    }

    // Truncation fallback: Meta sometimes renders long campaign names with
    // a literal "..." suffix (JS truncation, not CSS). Match by prefix
    // against indexed campaign keys. Require ≥8 chars to avoid spurious hits.
    for (const el of sameRow) {
      const ck = canonicalKey(el.textContent || '');
      if (!ck) continue;
      const m = ck.match(/^(.+?)\s*(?:\.{2,}|…)\s*$/);
      if (!m) continue;
      const prefix = m[1].trim();
      if (prefix.length < 8) continue;
      for (const [fullKey, id] of campKeyToId) {
        if (fullKey.startsWith(prefix)) return id;
      }
    }
    return null;
  }

  function getScopedCampaignIds() {
    try {
      const params = new URLSearchParams(window.location.search);
      const csv = params.get('selected_campaign_ids');
      if (!csv) return null;
      const ids = csv.split(',').map(s => s.trim()).filter(Boolean);
      return ids.length ? new Set(ids) : null;
    } catch {
      return null;
    }
  }

  function formatAmbiguousTooltip(data) {
    const lines = [
      `⚠ Ambiguous: "${data.campaignName}" appears in ${data.candidates.length} campaigns.`,
      `Pill shows totals across all duplicates.`,
      `To see per-row ROAS: drill into a single campaign,`,
      `or enable the "Campaign name" column in this view.`,
      '',
      'Per-campaign breakdown:',
    ];
    // Largest spend first so the dominant campaign shows up at the top.
    const sorted = [...data.candidates].sort((a, b) => (b.cost || 0) - (a.cost || 0));
    for (const c of sorted.slice(0, 12)) {
      const r = c.roas || {};
      lines.push(
        `  • ${c.campaignName} → spend $${(c.cost || 0).toFixed(2)} | ` +
        `D0 ${pct(r.d0)} D7 ${pct(r.d7)}`
      );
    }
    if (sorted.length > 12) lines.push(`  … and ${sorted.length - 12} more`);
    lines.push('');
    lines.push(`Last sync: ${new Date(lastSyncAt).toLocaleString()}`);
    return lines.join('\n');
  }

  // Build pill content as labelled segments so each ROAS value can be colored
  // individually. Built via createElement (NOT innerHTML) — the campaign data
  // came over chrome.runtime messaging, but defense-in-depth: never inject
  // HTML strings sourced from the network.
  function fillPillSegments(pillEl, { d0, d3, d7, allTime }) {
    pillEl.textContent = '';
    appendSegment(pillEl, 'D0:', d0);
    pillEl.appendChild(document.createTextNode(' '));
    appendSegment(pillEl, '3d:', d3);
    pillEl.appendChild(document.createTextNode(' '));
    appendSegment(pillEl, '7d:', d7);
    pillEl.appendChild(document.createTextNode(' '));
    appendSegment(pillEl, 'All:', allTime);
  }

  function appendSegment(parent, label, value) {
    parent.appendChild(document.createTextNode(label));
    const valSpan = document.createElement('span');
    valSpan.textContent = pct(value);
    if (value != null) {
      if (value < 0.60) valSpan.className = 'adjust-rv-red';
      else if (value > 1.00) valSpan.className = 'adjust-rv-green';
    }
    parent.appendChild(valSpan);
  }

  function decorateAllVisibleRows() {
    // Reset stats and Y-buckets at start of pass; the bucket index will be
    // built lazily on the first ambiguous lookup and reused for the rest.
    lastDecorateStats = { ambiguous: 0, resolvedByScope: 0, resolvedByMetaPreload: 0, resolvedByReactProps: 0, resolvedByDom: 0, stillAmbiguous: 0 };
    rowYBuckets = null;
    document.querySelectorAll(NAME_CANDIDATE_SELECTOR).forEach(decorateCandidate);
    rowYBuckets = null; // release; rects go stale on next mutation anyway

    // Surface unresolved-ambiguity in the banner so the user sees what to do.
    // We only re-render the banner on a post-load decorate pass when the data
    // is fresh; the loadData flow already set the banner once before us.
    if (lastSyncAt && lastDecorateStats.stillAmbiguous > 0) {
      showBanner(buildBannerText(), 'warn');
    }
  }

  function removeAllPills() {
    document.querySelectorAll('.adjust-pill').forEach(p => p.remove());
    // WeakMap entries can't be enumerated to clear — but they're keyed by the
    // ellipsis div, so they auto-invalidate when Meta replaces those nodes.
    // For surviving nodes we re-decorate on next pass; if the pill is gone
    // but the WeakMap still says "decorated", decorateCandidate's dedup
    // would skip incorrectly. Force re-evaluation by clearing entries for
    // any ellipsis div currently in the DOM.
    document.querySelectorAll(NAME_CANDIDATE_SELECTOR).forEach(el => {
      decoratedKey.delete(el);
    });
  }

  // Debounced decoration to avoid bursty work during rapid scroll.
  function scheduleDecorate() {
    if (decorateTimer) return;
    decorateTimer = setTimeout(() => {
      decorateTimer = null;
      decorateAllVisibleRows();
    }, 200);
  }

  function classifyForColor(roas) {
    const { d3, d7 } = roas;
    if (d7 == null) return 'unknown';
    // d3 may not exist on every Adjust account; require d7 only for coloring.
    if ((d3 == null || d3 < 0.20) && d7 < 0.30) return 'pause';
    if ((d3 == null || d3 > 1.00) && d7 > 0.80) return 'scale';
    return 'hold';
  }

  function pct(x) {
    return x == null ? '–' : `${(x * 100).toFixed(0)}%`;
  }

  function formatTooltip(data) {
    const lines = [
      `Name: ${data.campaignName}`,
      `Network: ${data.network}`,
    ];
    if (data.rowCount > 1) {
      lines.push(`Aggregated from: ${data.rowCount} rows`);
    }
    if (data.cost != null) {
      lines.push(`Cost: $${data.cost.toFixed(2)} · Installs: ${data.installs ?? 0}`);
    }
    lines.push(`Last sync: ${new Date(lastSyncAt).toLocaleString()}`);
    lines.push(`Source: ${sourceLabel}`);
    return lines.join('\n');
  }

  // ---- Banner ----
  function showBanner(text, level) {
    let banner = document.getElementById('adjust-overlay-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'adjust-overlay-banner';
      document.body.appendChild(banner);
    }
    banner.className = `adjust-banner adjust-banner-${level}`;
    banner.textContent = text;
  }

  function buildBannerText() {
    const ageMin = Math.round((Date.now() - lastSyncAt) / 60000);
    const base = `Adjust data: ${campaignIndex.size} campaigns / ${adsetIndex.size} ad sets / ${adIndex.size} ads · synced ${ageMin}m ago · ${sourceLabel}`;
    const s = lastDecorateStats;
    if (s.stillAmbiguous > 0) {
      // Tell the user exactly what to enable so the per-row pill becomes accurate.
      return `${base}\n⚠ ${s.stillAmbiguous} row(s) showing aggregate ROAS — enable "Campaign name" or "Campaign ID" column to disambiguate.`;
    }
    return base;
  }

  // ---- Observer ----
  // Watch the whole body subtree. SPA virtualizes the campaign list so rows
  // come and go on every scroll; debouncing absorbs the burst.
  function ensureObserving() {
    if (bodyObserver) return;
    bodyObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
          scheduleDecorate();
          return;
        }
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Listen for cache updates ----
  // Background writes campaignDataCache to chrome.storage.local on every sync.
  // Subscribing here means we don't need tabs.query/tabs.sendMessage from the
  // popup — which keeps the extension's permissions minimal (no `tabs` perm,
  // no host_permissions for facebook.com) and removes one moving part.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.campaignDataCache) {
      loadData();
    }
  });

  // Initial.
  loadData();
})();
