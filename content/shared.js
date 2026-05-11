// content/shared.js
// Helpers shared by content/meta-injector.js and content/tiktok-injector.js.
// Loaded as a separate file in the same content_scripts entry as each
// injector — top-level function declarations are visible across files in the
// same isolated world, so both injectors can call these by bare name. Keep
// this file IIFE-free for that reason.
//
// Extraction is intentionally conservative: only blocks that were
// byte-identical (or differed only by a platform key / cosmetic comment word)
// between the two injectors moved here. Anything that closes over per-
// injector state stays in the injector with a thin wrapper that delegates
// here.

function todayLocalIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Whole-pill background only escalates to red when primary ROAS (d7 or
// all-time fallback) is below the user-configured pause threshold (default
// 30% — "unacceptable"). For anything above that the pill stays neutral and
// per-segment coloring (each injector's own segment renderer) carries the
// granular signal. Returns 'unknown' | 'pause' | 'hold'.
function classifyForColor(roas, colorThresholds) {
  const primary = roas.d7 ?? roas.allTime;
  if (primary == null) return 'unknown';
  if (primary < colorThresholds.pause) return 'pause';
  return 'hold';
}

// Read user-configured thresholds for a platform ('meta' | 'tiktok') from
// chrome.storage.local. Returns a new thresholds object if storage held one,
// or the caller's `current` unchanged if nothing was stored / read failed.
// Caller is responsible for assigning the result back into its own local
// `colorThresholds` variable.
async function fetchColorThresholds(platform, current) {
  try {
    const { colorThresholds: stored } = await chrome.storage.local.get('colorThresholds');
    const t = stored?.[platform];
    if (t) {
      return {
        pause: typeof t.pause === 'number' ? t.pause : current.pause,
        red:   typeof t.red   === 'number' ? t.red   : current.red,
        green: typeof t.green === 'number' ? t.green : current.green,
      };
    }
  } catch { /* keep current */ }
  return current;
}

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
