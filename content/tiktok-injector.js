// content/tiktok-injector.js
// Injects multi-window ROAS pills into TikTok Ads Manager rows.
//
// === FACEBOOK / TIKTOK ACCOUNT SAFETY ===
// Same read-only contract as content/meta-injector.js. Specifically:
//
//   READ-ONLY of TikTok DOM:
//     ✓ querySelector + textContent
//     ✗ NEVER reads cookies, localStorage, sessionStorage, IndexedDB
//     ✗ NEVER reads auth tokens or DOM input values
//
//   NO MUTATION of TikTok-owned elements:
//     ✓ Pills inserted as SIBLINGS via insertBefore — never inside a
//       TikTok-managed container, never as replacement of a TikTok node.
//     ✗ NEVER sets attributes (class, style, dataset, aria-*) on any element
//       TikTok rendered. Decoration tracking lives in a JS WeakMap so the
//       DOM observed by TikTok's React reconciler is unmodified.
//     ✗ NEVER calls .click(), .focus(), .dispatchEvent(), .submit().
//
//   NO NETWORK to tiktok.com:
//     ✗ NEVER calls fetch / XMLHttpRequest to any tiktok.com host. The
//       extension's manifest host_permissions only includes adjust.com.
//
// === HOW TIKTOK DIFFERS FROM META ===
// 1. No row DOM container: TikTok's `<ks-virtual-table>` renders cells
//    directly without a row wrapper. We cannot walk-up to a "row" node.
// 2. The cell's own React props carry the row's full id (campaign_id /
//    adgroup_id / ad_id), so id resolution is a single leaf-cell scan via
//    the page-world bridge — no row subtree walk, no Y-bucket join.
// 3. URL has no `?selected_campaign_ids=` parameter; the tab's URL pathname
//    is the only scope signal (`/manage/campaign` vs `/adgroup` vs
//    `/creative`).
// 4. No Meta-style preload tree to parse — we rely entirely on the bridge.
//
// === STRATEGIES (much simpler than Meta) ===
//   1. Direct match by name in the per-tab index. If unique → done.
//   2. Bridge id match: read the cell's id from the bridge's hit table and
//      resolve via byId index. Works regardless of column visibility.
//   3. Otherwise show ambiguous aggregate.

(function () {
  'use strict';

  const INJECTOR_VERSION = 'v0.1.4-tt';
  // Styled prefix so it's findable in TikTok's verbose console — filter by
  // "AOX-TT" or "Adjust Overlay" to surface every log this injector emits.
  console.log(
    `%c[AOX-TT ${INJECTOR_VERSION}]%c tiktok-injector loaded`,
    'background:#0066ff;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
    'color:#0066ff;font-weight:bold'
  );

  // ---- Embedded matcher (kept in sync with src/matcher.js + meta-injector) ----
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

  // Primary selector matches the unstyled link wrapper TikTok renders for the
  // clickable row-name cell. Falls back to broader `KsLink` matches if the
  // primary returns nothing — TikTok library upgrades sometimes drop the
  // `--inherit` modifier and we'd rather match too much (filtered later by
  // text-length + index lookup) than miss legitimate rows entirely.
  const NAME_CANDIDATE_SELECTOR_PRIMARY = '[class*="KsLink--inherit"]';
  const NAME_CANDIDATE_SELECTOR_FALLBACK = '[class*="KsLink"]';
  function pickNameCandidates() {
    const primary = document.querySelectorAll(NAME_CANDIDATE_SELECTOR_PRIMARY);
    if (primary.length > 0) return primary;
    return document.querySelectorAll(NAME_CANDIDATE_SELECTOR_FALLBACK);
  }

  // Network filter — matches the `channel` field Adjust returns for TikTok
  // rows ("TikTok for Business"). Anything not matching this is a different
  // network's data and must be ignored on TikTok pages.
  const TIKTOK_NETWORK_PREFIX = 'TikTok';

  let campaignIndex = new Map();
  let adsetIndex = new Map();
  let adIndex = new Map();
  let adsetCompositeIndex = new Map();
  let adCompositeIndex = new Map();
  let adByIdIndex = new Map();
  let adsetByIdIndex = new Map();
  let campByIdIndex = new Map();
  let lastSyncAt = null;
  let sourceLabel = '';

  // Color thresholds — overridable per-platform from popup Settings. Defaults
  // mirror what the popup writes when the user hasn't customized yet.
  let colorThresholds = { pause: 0.30, red: 0.60, green: 1.00 };

  let bodyObserver = null;
  let decorateTimer = null;
  const decoratedKey = new WeakMap();
  // TikTok cells live inside `cl-w-full cl-overflow-hidden` ancestors that
  // clip any sibling content rendered next to the name. We render pills as
  // position:fixed children of <body> instead and reposition them on scroll
  // so they float above the row without being clipped. Map cell → pill so
  // we can update or remove each on virtualization / scroll.
  const cellToPill = new Map();

  let lastDecorateStats = {
    candidates: 0,
    matched: 0,
    resolvedByName: 0,
    resolvedByBridgeId: 0,
    stillAmbiguous: 0,
  };

  // ---- Bridge integration ----
  let bridgeScanToken = 0;
  let bridgeIndex = null;
  let bridgeIndexToken = -1;

  function dispatchBridgeKnownIds() {
    document.dispatchEvent(new CustomEvent('aox-tt-set-known-ids', {
      detail: {
        adIds: [...adByIdIndex.keys()],
        adsetIds: [...adsetByIdIndex.keys()],
        campIds: [...campByIdIndex.keys()],
      },
    }));
  }

  function dispatchBridgeScan() {
    document.dispatchEvent(new CustomEvent('aox-tt-scan-rows'));
    bridgeScanToken++;
  }

  function parseBridgeData() {
    const node = document.getElementById('aox-tt-bridge-data');
    if (!node) return null;
    let payload;
    try { payload = JSON.parse(node.textContent || '{}'); } catch { return null; }
    const out = new Map();
    const results = Array.isArray(payload?.results) ? payload.results : [];
    for (const r of results) {
      if (!r?.t) continue;
      out.set(`${r.t}|${r.y}`, r);
    }
    return out;
  }

  function lookupBridgeRowHit(nameEl) {
    if (bridgeIndexToken !== bridgeScanToken) {
      bridgeIndex = parseBridgeData();
      bridgeIndexToken = bridgeScanToken;
    }
    if (!bridgeIndex || bridgeIndex.size === 0) return null;
    const text = (nameEl.textContent || '').trim();
    if (!text) return null;
    const rect = nameEl.getBoundingClientRect();
    const y = Math.round((rect.top + rect.bottom) / 2);
    for (let dy = -1; dy <= 1; dy++) {
      const k = `${text}|${y + dy}`;
      const hit = bridgeIndex.get(k);
      if (hit) return hit;
    }
    return null;
  }

  // ---- Tab detection from URL pathname ----
  // /i18n/manage/campaign  → Campaigns tab → match against campaignIndex
  // /i18n/manage/adgroup   → Ad groups tab → match against adsetIndex
  // /i18n/manage/creative  → Ads tab       → match against adIndex
  function getCurrentTab() {
    const path = window.location.pathname;
    if (path.includes('/manage/creative')) return 'ad';
    if (path.includes('/manage/adgroup')) return 'adset';
    if (path.includes('/manage/campaign')) return 'campaign';
    return null;
  }

  async function loadColorThresholds() {
    try {
      const { colorThresholds: stored } = await chrome.storage.local.get('colorThresholds');
      const t = stored?.tiktok;
      if (t) {
        colorThresholds = {
          pause: typeof t.pause === 'number' ? t.pause : colorThresholds.pause,
          red:   typeof t.red   === 'number' ? t.red   : colorThresholds.red,
          green: typeof t.green === 'number' ? t.green : colorThresholds.green,
        };
      }
    } catch { /* keep defaults */ }
  }

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

      // Filter to TikTok network rows only — Adjust returns Meta + TikTok in
      // one fetch, and we don't want Meta names polluting TikTok indexes.
      const allRows = (cached.campaigns || []);
      const tiktokRows = allRows.filter(r => (r.network || '').startsWith(TIKTOK_NETWORK_PREFIX));
      const campaignRows = tiktokRows.filter(r => r.level === 'campaign');
      const adRows = tiktokRows.filter(r => r.level === 'ad');

      campaignIndex = buildDirectIndex(campaignRows, r => r.campaignName);
      campByIdIndex = buildIdIndex(campaignRows, r => r.campaignId, r => r.campaignName);

      const adsetBuilt = buildAggregatedIndex(adRows, r => r.adsetName, r => r.adsetId);
      adsetIndex = adsetBuilt.byName;
      adsetCompositeIndex = adsetBuilt.byComposite;
      adsetByIdIndex = adsetBuilt.byId;

      const adBuilt = buildAdIndex(adRows);
      adIndex = adBuilt.byName;
      adCompositeIndex = adBuilt.byComposite;
      adByIdIndex = adBuilt.byAdId;

      lastSyncAt = cached.lastSyncAt;
      sourceLabel = cached.sourceLabel;

      dispatchBridgeKnownIds();

      showBanner(buildBannerText(), cached.isStale ? 'warn' : 'ok');
      removeAllPills();
      ensureObserving();
      decorateAllVisibleRows();
      logDomDiagnostics();
    } catch (err) {
      console.warn('[Adjust Overlay TT] loadData failed:', err.message);
    }
  }

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

  function buildIdIndex(rows, getId, getName) {
    const out = new Map();
    for (const row of rows) {
      const id = getId(row);
      if (!id) continue;
      out.set(String(id), {
        campaignName: getName(row),
        network: row.network,
        rowCount: 1,
        cost: row.cost,
        installs: row.installs,
        roas: row.roas,
      });
    }
    return out;
  }

  function buildAdIndex(adRows) {
    const byName = new Map();
    const byComposite = new Map();
    const byAdId = new Map();
    const collisions = new Set();
    const accums = new Map();

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
        parentCampaignName: row.campaignName,
        parentAdsetName: row.adsetName,
        campaignId: row.campaignId,
        adsetId: row.adsetId || null,
        adId: row.adId || null,
      };

      if (row.campaignId) byComposite.set(`${row.campaignId}::${k}`, single);
      if (row.adId) byAdId.set(String(row.adId), single);

      if (!byName.has(k)) {
        byName.set(k, single);
        accums.set(k, [row]);
      } else {
        collisions.add(k);
        accums.get(k).push(row);
      }
    }

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

    return { byName, byComposite, byAdId };
  }

  function buildAggregatedIndex(rows, getName, getId) {
    const byName = new Map();
    const byComposite = new Map();
    const byId = new Map();
    const composites = new Map();
    const flats = new Map();
    const idGroups = new Map();

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
      if (getId) {
        const id = getId(row);
        if (id) {
          const sid = String(id);
          if (!idGroups.has(sid)) idGroups.set(sid, []);
          idGroups.get(sid).push(row);
        }
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

    for (const [sid, rs] of idGroups) {
      byId.set(sid, {
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

    return { byName, byComposite, byId };
  }

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
    const candidates = pickNameCandidates();
    const usedSelector = candidates.length > 0
      ? (document.querySelectorAll(NAME_CANDIDATE_SELECTOR_PRIMARY).length > 0
          ? NAME_CANDIDATE_SELECTOR_PRIMARY
          : NAME_CANDIDATE_SELECTOR_FALLBACK)
      : '(none matched)';
    let firstMatch = null;
    let firstUnmatchedSample = null;
    let firstMatchEntry = null;
    let matchCount = 0;
    let matchedLevel = null;
    const tab = getCurrentTab();
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      const k = canonicalKey(text);
      const lvl = adIndex.has(k) ? 'ad' : adsetIndex.has(k) ? 'adset' : campaignIndex.has(k) ? 'campaign' : null;
      if (lvl) {
        matchCount++;
        if (!firstMatch) {
          firstMatch = text.slice(0, 120);
          matchedLevel = lvl;
          firstMatchEntry = lvl === 'ad' ? adIndex.get(k)
                          : lvl === 'adset' ? adsetIndex.get(k)
                          : campaignIndex.get(k);
        }
      } else if (!firstUnmatchedSample && text.length >= 5) {
        firstUnmatchedSample = text.slice(0, 120);
      }
    }

    const bridgeNode = document.getElementById('aox-tt-bridge-data');
    let bridgeProbe = { error: 'aox-tt-bridge-data node not found' };
    if (bridgeNode) {
      try {
        const payload = JSON.parse(bridgeNode.textContent || '{}');
        bridgeProbe = {
          bridgeVersion: payload.version,
          bridgeAgeMs: payload.timestamp ? Date.now() - payload.timestamp : null,
          knownAdIds: payload.knownAdIdsSize,
          knownAdsetIds: payload.knownAdsetIdsSize,
          knownCampIds: payload.knownCampIdsSize,
          rowsScanned: payload.scanned,
          rowsHit: payload.hits,
          sampleHits: (payload.results || []).slice(0, 3),
        };
      } catch (e) {
        bridgeProbe = { error: 'bad JSON: ' + e.message };
      }
    }

    console.log(
      '%c[AOX-TT]%c DOM diagnostics',
      'background:#0066ff;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
      'color:#0066ff', {
      version: INJECTOR_VERSION,
      tab,
      candidateSelector: usedSelector,
      candidatesFound: candidates.length,
      matchedToAdjustNames: matchCount,
      firstMatchText: firstMatch,
      firstMatchLevel: matchedLevel,
      firstUnmatchedSample,
      firstMatchEntry,
      indexSizes: {
        campaign: campaignIndex.size,
        campById: campByIdIndex.size,
        adset: adsetIndex.size,
        adsetById: adsetByIdIndex.size,
        ad: adIndex.size,
        adById: adByIdIndex.size,
      },
      lastDecoratePass: { ...lastDecorateStats },
      bridgeProbe,
    });
  }

  // ---- Decorate one candidate ----
  function decorateCandidate(el) {
    const rawName = el.textContent || '';
    if (rawName.length < 5 || rawName.length > 300) return;
    const key = canonicalKey(rawName);

    lastDecorateStats.candidates++;

    // Try the level matching the current tab first. Falls through to the
    // others so a name visible elsewhere still decorates correctly.
    const tab = getCurrentTab();
    const order = tab === 'campaign' ? ['campaign', 'adset', 'ad']
                : tab === 'adset'    ? ['adset', 'ad', 'campaign']
                :                       ['ad', 'adset', 'campaign'];

    let data = null;
    for (const level of order) {
      data = lookupForLevel(el, key, level);
      if (data) break;
    }
    if (!data) return;

    lastDecorateStats.matched++;

    if (decoratedKey.get(el) === key) {
      // Same cell + same content — the rAF loop is already (or about to be)
      // tracking this pill's position; nothing else to do.
      ensureRepositionLoop();
      return;
    }

    // Cell got reassigned to a different campaign (virtualization recycle):
    // drop the old pill before creating a fresh one.
    const stale = cellToPill.get(el);
    if (stale) {
      stale.remove();
      cellToPill.delete(el);
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

    pill.style.position = 'fixed';
    pill.style.zIndex = '99999';
    pill.style.margin = '0';
    // Position the pill immediately rather than waiting for the rAF loop's
    // first frame. Previously we used display:none + relied on the loop to
    // reveal the pill, but on cache refresh (period change) the loop's
    // rafLoopActive flag could already be true from a prior tick that had
    // since drained without rescheduling, leaving newly-created pills stuck
    // hidden with `left/top: auto`. Painting on creation makes the pill
    // visible regardless of rAF state; the loop still runs to follow scroll.
    positionPillToCell(el, pill);
    document.body.appendChild(pill);

    cellToPill.set(el, pill);
    decoratedKey.set(el, key);
    ensureRepositionLoop();
  }

  function positionPillToCell(cell, pill) {
    const r = cell.getBoundingClientRect();
    const offscreen = r.width === 0 || r.height === 0
      || r.bottom < 0 || r.top > window.innerHeight;
    // Horizontal: align to the name column's right edge, not the leaf link's,
    // so pills line up vertically across rows regardless of name truncation
    // length. Vertical: still keyed off the leaf cell so each pill matches
    // its own row.
    const column = findColumnAncestor(cell);
    const colRight = column ? column.getBoundingClientRect().right : r.right;
    const left = Math.round(colRight + 6);
    const top = Math.round(r.top + (r.height / 2) - 9);
    if (offscreen) {
      pill.style.display = 'none';
    } else {
      pill.style.display = '';
      pill.style.left = left + 'px';
      pill.style.top = top + 'px';
    }
    lastPositioned.set(cell, { left, top, hidden: offscreen });
  }

  // Walk up from the leaf name link to its enclosing column cell. Heuristic:
  // first ancestor noticeably wider than the leaf and short enough to be a
  // single-row cell. Returns the leaf as fallback if no good match is found.
  function findColumnAncestor(cell) {
    const cellW = cell.getBoundingClientRect().width;
    let n = cell.parentElement;
    for (let i = 0; i < 8 && n; i++) {
      const r = n.getBoundingClientRect();
      if (r.width >= cellW + 40 && r.height > 0 && r.height < 200) return n;
      n = n.parentElement;
    }
    return cell;
  }

  // TikTok's `<ks-virtual-table>` scrolls by mutating row transforms instead
  // of firing native scroll events on a real scroll container, so we cannot
  // rely on `scroll` listeners to know when to reposition. A continuous rAF
  // loop runs while at least one pill is alive; each frame compares the
  // cell's current bounding rect to the last positioned values and only
  // updates style when something moved (cheap idle, smooth follow on scroll).
  // The loop self-terminates as soon as cellToPill drains.
  let rafLoopActive = false;
  const lastPositioned = new WeakMap(); // cell → {left, top, hidden}

  function repositionLoopTick() {
    rafLoopActive = false;
    if (cellToPill.size === 0) return;

    for (const [cell, pill] of cellToPill) {
      if (!cell.isConnected) {
        pill.remove();
        cellToPill.delete(cell);
        lastPositioned.delete(cell);
        continue;
      }
      const r = cell.getBoundingClientRect();
      const offscreen = r.width === 0 || r.height === 0
        || r.bottom < 0 || r.top > window.innerHeight;
      const left = Math.round(r.right + 6);
      const top = Math.round(r.top + (r.height / 2) - 9);
      const prev = lastPositioned.get(cell);
      if (prev && prev.left === left && prev.top === top && prev.hidden === offscreen) {
        continue; // nothing changed for this pill
      }
      positionPillToCell(cell, pill);
    }

    if (cellToPill.size > 0) {
      rafLoopActive = true;
      requestAnimationFrame(repositionLoopTick);
    }
  }

  function ensureRepositionLoop() {
    if (rafLoopActive || cellToPill.size === 0) return;
    rafLoopActive = true;
    requestAnimationFrame(repositionLoopTick);
  }

  // Resolve a row at a specific level. Strategy chain:
  //   1. Exact name lookup. If unique → return.
  //   2. If ambiguous, ask the bridge for the row's id and resolve via byId.
  //   3. Else return the ambiguous aggregate.
  function lookupForLevel(el, key, level) {
    const byName = level === 'campaign' ? campaignIndex
                 : level === 'adset'    ? adsetIndex
                 :                        adIndex;
    const byId   = level === 'campaign' ? campByIdIndex
                 : level === 'adset'    ? adsetByIdIndex
                 :                        adByIdIndex;
    const byComposite = level === 'adset' ? adsetCompositeIndex
                      : level === 'ad'    ? adCompositeIndex
                      :                     null;

    const entry = byName.get(key);
    if (!entry) return null;
    if (!entry.ambiguous) {
      lastDecorateStats.resolvedByName++;
      return entry;
    }

    // Ambiguous → try the bridge.
    const hit = lookupBridgeRowHit(el);
    if (hit) {
      const id = level === 'campaign' ? hit.c
               : level === 'adset'    ? hit.s
               :                        hit.a;
      if (id) {
        const direct = byId.get(id);
        if (direct) {
          lastDecorateStats.resolvedByBridgeId++;
          return direct;
        }
        if (byComposite) {
          // adset/ad: bridge gave us the id, but byId may be empty if the
          // captured id space doesn't match. Try (campId :: name) composite
          // when bridge ALSO supplies the campaign id (`c`) as a sibling hint.
          if (hit.c) {
            const m = byComposite.get(`${hit.c}::${key}`);
            if (m) {
              lastDecorateStats.resolvedByBridgeId++;
              return m;
            }
          }
        }
      }
    }

    lastDecorateStats.stillAmbiguous++;
    return entry;
  }

  // ---- Pill helpers (kept compatible with content/meta-injector.css) ----
  function classifyForColor(roas) {
    // Whole-pill background only escalates to red when d7 is below the
    // user-configured pause threshold (default 30% — "unacceptable"). For
    // anything above that, the pill stays neutral and per-segment coloring
    // (see fillPillSegments) carries the granular signal.
    const primary = roas.d7 ?? roas.allTime;
    if (primary == null) return 'unknown';
    if (primary < colorThresholds.pause) return 'pause';
    return 'hold';
  }

  function pct(x) {
    return x == null ? '–' : `${(x * 100).toFixed(0)}%`;
  }

  function fillPillSegments(parent, roas) {
    const segments = [
      { label: 'D0', value: roas.d0 },
      { label: '3d', value: roas.d3 },
      { label: '7d', value: roas.d7 },
      { label: 'All', value: roas.allTime },
    ];
    for (const seg of segments) {
      const span = document.createElement('span');
      span.className = 'adjust-pill-seg';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'adjust-pill-label';
      labelSpan.textContent = seg.label + ':';
      const valSpan = document.createElement('span');
      valSpan.className = 'adjust-pill-value';
      valSpan.textContent = pct(seg.value);
      // Per-segment coloring: each value lights up by its own threshold so
      // the user sees granular signal even when the overall pill stays
      // neutral. Whole-pill background only escalates to red on bad signal
      // (see classifyForColor) — green-whole-pill is intentionally absent.
      if (seg.value != null) {
        if (seg.value < colorThresholds.red) valSpan.classList.add('adjust-rv-red');
        else if (seg.value > colorThresholds.green) valSpan.classList.add('adjust-rv-green');
      }
      span.appendChild(labelSpan);
      span.appendChild(valSpan);
      parent.appendChild(span);
    }
  }

  function formatTooltip(data) {
    const lines = [
      `Name: ${data.campaignName}`,
      `Network: ${data.network}`,
    ];
    if (data.rowCount > 1) lines.push(`Aggregated from: ${data.rowCount} rows`);
    if (data.cost != null) {
      lines.push(`Cost: $${data.cost.toFixed(2)} · Installs: ${data.installs ?? 0}`);
    }
    lines.push(`Last sync: ${new Date(lastSyncAt).toLocaleString()}`);
    lines.push(`Source: ${sourceLabel}`);
    return lines.join('\n');
  }

  function formatAmbiguousTooltip(data) {
    const head = `${data.campaignName} — ambiguous across ${data.candidates?.length ?? '?'} rows`;
    const detail = (data.candidates || [])
      .slice()
      .sort((a, b) => (b.cost || 0) - (a.cost || 0))
      .slice(0, 5)
      .map(c =>
        `  • ${c.campaignName} → spend $${(c.cost || 0).toFixed(2)} | ` +
        `D0 ${pct(c.roas?.d0)} 7d ${pct(c.roas?.d7)}`
      ).join('\n');
    return head + '\n' + detail;
  }

  // ---- Banner ----
  // Banner is a small draggable badge that toggles into a details panel on
  // click. Position persists to localStorage so the user keeps it where they
  // moved it. showBanner() only updates content + status color; the DOM and
  // event wiring is built once on first call.
  function showBanner(text, level) {
    let banner = document.getElementById('adjust-overlay-banner');
    if (!banner) banner = createBanner();
    banner.classList.remove('adjust-banner-ok', 'adjust-banner-warn', 'adjust-banner-error');
    banner.classList.add(`adjust-banner-${level}`);
    const panel = banner.querySelector('.adjust-banner-panel');
    if (panel) panel.textContent = text;
    banner.title = text;
  }

  function createBanner() {
    const banner = document.createElement('div');
    banner.id = 'adjust-overlay-banner';
    banner.classList.add('adjust-banner-collapsed');

    const badge = document.createElement('span');
    badge.className = 'adjust-banner-badge';
    badge.textContent = 'A';

    const panel = document.createElement('div');
    panel.className = 'adjust-banner-panel';

    const close = document.createElement('span');
    close.className = 'adjust-banner-close';
    close.textContent = '×';
    close.title = 'Collapse';

    banner.appendChild(badge);
    banner.appendChild(panel);
    banner.appendChild(close);

    restoreBannerPosition(banner);
    attachBannerInteractions(banner, close);
    document.body.appendChild(banner);
    return banner;
  }

  function restoreBannerPosition(banner) {
    try {
      const pos = JSON.parse(localStorage.getItem('adjust-banner-pos') || 'null');
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        banner.style.left = pos.left + 'px';
        banner.style.top = pos.top + 'px';
        banner.style.right = 'auto';
        banner.style.bottom = 'auto';
      }
    } catch { /* ignore */ }
  }

  // Distinguish click vs drag via a 3px movement threshold. Below threshold
  // → toggle expanded/collapsed. Above → reposition the banner and persist
  // the new coordinates so reload restores them.
  function attachBannerInteractions(banner, closeEl) {
    let dragging = false;
    let pendingClick = false;
    let dragStartX = 0, dragStartY = 0, initialLeft = 0, initialTop = 0;

    banner.addEventListener('mousedown', (e) => {
      if (e.target === closeEl) {
        banner.classList.remove('adjust-banner-expanded');
        banner.classList.add('adjust-banner-collapsed');
        e.stopPropagation();
        return;
      }
      pendingClick = true;
      dragging = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = banner.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      e.preventDefault();

      const onMove = (ev) => {
        const dx = ev.clientX - dragStartX;
        const dy = ev.clientY - dragStartY;
        if (!dragging && Math.hypot(dx, dy) > 3) {
          dragging = true;
          pendingClick = false;
        }
        if (dragging) {
          banner.style.left = Math.max(0, initialLeft + dx) + 'px';
          banner.style.top = Math.max(0, initialTop + dy) + 'px';
          banner.style.right = 'auto';
          banner.style.bottom = 'auto';
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragging) {
          const r = banner.getBoundingClientRect();
          try {
            localStorage.setItem('adjust-banner-pos', JSON.stringify({ left: r.left, top: r.top }));
          } catch { /* ignore quota errors */ }
        } else if (pendingClick) {
          banner.classList.toggle('adjust-banner-expanded');
          banner.classList.toggle('adjust-banner-collapsed');
        }
        pendingClick = false;
        dragging = false;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function buildBannerText() {
    const ageMin = Math.round((Date.now() - lastSyncAt) / 60000);
    return `Adjust [TikTok]: ${campaignIndex.size} campaigns / ${adsetIndex.size} ad sets / ${adIndex.size} ads · synced ${ageMin}m ago · ${sourceLabel}`;
  }

  function decorateAllVisibleRows() {
    lastDecorateStats = { candidates: 0, matched: 0, resolvedByName: 0, resolvedByBridgeId: 0, stillAmbiguous: 0 };
    dispatchBridgeScan();
    pickNameCandidates().forEach(decorateCandidate);
  }

  function removeAllPills() {
    for (const [cell, pill] of cellToPill) pill.remove();
    cellToPill.clear();
    document.querySelectorAll('.adjust-pill').forEach(p => p.remove());
    pickNameCandidates().forEach(el => decoratedKey.delete(el));
  }

  function scheduleDecorate() {
    if (decorateTimer) return;
    decorateTimer = setTimeout(() => {
      decorateTimer = null;
      decorateAllVisibleRows();
    }, 200);
  }

  function ensureObserving() {
    if (bodyObserver) return;
    bodyObserver = new MutationObserver(() => scheduleDecorate());
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Init ----
  // Load thresholds first so the very first decoration uses user-configured
  // colors rather than briefly painting with defaults and re-painting.
  loadColorThresholds().then(() => loadData());

  // Safety net: TikTok loads its table 2-10 seconds after document_idle on
  // slow networks, and MutationObserver sometimes misses the initial paint
  // because Vmok renders inside a portaled root that wasn't in the DOM when
  // we attached. Re-trigger decorate every 2s for the first 30s so we catch
  // the table appearance regardless. Stops itself once the page settles.
  const RETRY_INTERVAL_MS = 2000;
  const RETRY_DEADLINE_MS = 30000;
  const retryStartedAt = Date.now();
  let lastRetryCandidateCount = -1;
  const retryHandle = setInterval(() => {
    if (Date.now() - retryStartedAt > RETRY_DEADLINE_MS) {
      clearInterval(retryHandle);
      return;
    }
    const count = pickNameCandidates().length;
    // Only re-decorate when the candidate set changed since last tick (avoids
    // wasted work once the table is stable).
    if (count !== lastRetryCandidateCount) {
      lastRetryCandidateCount = count;
      decorateAllVisibleRows();
      logDomDiagnostics();
    }
  }, RETRY_INTERVAL_MS);

  // Re-load whenever background writes a new cache. Subscribing to
  // chrome.storage.onChanged means the popup doesn't need tabs/messaging
  // permissions to push us refreshes — same pattern as meta-injector.
  // Threshold changes also trigger a re-decorate so saved values take effect
  // without a page reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.campaignDataCache) {
      loadData();
    } else if (changes.colorThresholds) {
      loadColorThresholds().then(() => {
        removeAllPills();
        decorateAllVisibleRows();
      });
    }
  });
})();
