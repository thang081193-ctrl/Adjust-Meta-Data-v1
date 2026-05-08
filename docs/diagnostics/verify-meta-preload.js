// Verify whether the current `campaign_structure_tree` parser in
// content/meta-injector.js still works on this Meta Ads Manager account.
//
// HOW TO USE
//   1. Open Meta Ads Manager in the account you want to verify (e.g. DecorAI),
//      with at least one campaign filter applied so trees are preloaded.
//   2. Open DevTools → Console.
//   3. Paste this entire file and press Enter.
//   4. Read the printed report. Anything labelled FAIL means the parser in
//      content/meta-injector.js will not work on this account and the regex /
//      marker needs to be widened.
//
// WHAT IT CHECKS (mirrors content/meta-injector.js:521-606 exactly)
//   1. Marker `"campaign_structure_tree":{` is present in <script> text.
//   2. Brace-walker can extract a complete tree body (string- and escape-aware).
//   3. `"campaign_id":"<digits>"` regex hits inside the body.
//   4. `"adgroup_id":"<digits>" ... "name":"<...>"` regex hits, with `[^{}]*?`
//      between them — i.e. no nested `{}` chen vào giữa.
//   5. Cross-check: at least one extracted (adName) is one you can see in the UI.
//
// OUTPUT — copy the JSON object printed and paste back to assistant if any FAIL.

(() => {
  const MARKER = '"campaign_structure_tree":{';
  const campIdRe = /"campaign_id":"(\d+)"/;
  const adgroupRe = /"adgroup_id":"(\d+)"[^{}]*?"name":"((?:[^"\\]|\\.)*)"/g;

  // Replica of extractStructureTreeBodies() from meta-injector.js
  function extractBodies(text) {
    const bodies = [];
    let pos = 0;
    while (true) {
      const start = text.indexOf(MARKER, pos);
      if (start === -1) break;
      const bodyStart = start + MARKER.length;
      let depth = 1, i = bodyStart, inStr = false, esc = false;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = !inStr;
        else if (!inStr) {
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

  const scripts = [...document.querySelectorAll('script')];
  const stats = {
    totalScripts: scripts.length,
    scriptsWithMarker: 0,
    bodiesExtracted: 0,
    bodiesWithCampaignId: 0,
    bodiesWithAdgroups: 0,
    totalAdgroupHits: 0,
    sampleCampIds: new Set(),
    sampleAdNames: [],
    firstBodyPreview: null,
    failures: [],
  };

  for (const s of scripts) {
    const t = s.textContent || '';
    if (t.length < 500) continue;
    if (!t.includes(MARKER)) continue;
    stats.scriptsWithMarker++;

    const bodies = extractBodies(t);
    stats.bodiesExtracted += bodies.length;

    for (const body of bodies) {
      if (!stats.firstBodyPreview) stats.firstBodyPreview = body.slice(0, 600);

      const cm = campIdRe.exec(body);
      if (cm) {
        stats.bodiesWithCampaignId++;
        stats.sampleCampIds.add(cm[1]);
      } else {
        stats.failures.push('body without campaign_id (preview): ' + body.slice(0, 200));
      }

      adgroupRe.lastIndex = 0;
      let am, hitsThisBody = 0;
      while ((am = adgroupRe.exec(body)) !== null) {
        hitsThisBody++;
        stats.totalAdgroupHits++;
        if (stats.sampleAdNames.length < 8) {
          stats.sampleAdNames.push({ adgroupId: am[1], name: am[2] });
        }
      }
      if (hitsThisBody > 0) stats.bodiesWithAdgroups++;
    }
  }

  // Verdict
  const verdict = {
    marker_found:           stats.scriptsWithMarker > 0,
    body_extraction_works:  stats.bodiesExtracted > 0,
    campaign_id_regex_ok:   stats.bodiesWithCampaignId === stats.bodiesExtracted && stats.bodiesExtracted > 0,
    adgroup_regex_ok:       stats.bodiesWithAdgroups > 0 && stats.totalAdgroupHits > 0,
  };
  const allPass = Object.values(verdict).every(Boolean);

  console.group('%c[verify-meta-preload] ' + (allPass ? 'PASS ✅' : 'FAIL ❌'),
    'font-weight:bold;color:' + (allPass ? '#0a0' : '#c00'));
  console.log('verdict:', verdict);
  console.log('stats:', {
    ...stats,
    sampleCampIds: [...stats.sampleCampIds].slice(0, 6),
  });
  if (stats.firstBodyPreview) {
    console.log('first body preview (first 600 chars):\n' + stats.firstBodyPreview);
  }
  if (!allPass) {
    console.warn('NEXT STEPS:');
    if (!verdict.marker_found)          console.warn(' - Meta renamed the marker. Search scripts for new key around "campaign_id"/"adgroup_id".');
    if (!verdict.body_extraction_works) console.warn(' - Brace walker failed — tree body terminator changed shape.');
    if (!verdict.campaign_id_regex_ok)  console.warn(' - "campaign_id":"\\d+" not found in body. Field may be renamed (e.g. "id", "ad_campaign_group_id").');
    if (!verdict.adgroup_regex_ok)      console.warn(' - adgroup_id+name pair not found OR nested {} now appears between them. Try widening regex from [^{}]*? to [\\s\\S]*?{,200}.');
  }
  console.groupEnd();

  return { verdict, stats };
})();
