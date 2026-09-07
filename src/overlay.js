'use strict';

/**
 * The cursor/highlight overlay, built as a string and injected with
 * addInitScript so it survives every navigation.
 *
 * Two things this has to get right:
 *
 * 1. addInitScript runs before the document exists. Touching document.head or
 *    document.body unconditionally throws, the script dies, and the overlay
 *    never appears - with no error anywhere near the recording code. Every DOM
 *    touch below is guarded, and mounting retries on readystatechange.
 * 2. It runs again on every navigation, so mounting is idempotent.
 *
 * Colours and sizes are interpolated from the theme rather than hardcoded, so
 * restyling the cursor never means editing this file.
 */
function buildOverlayScript(theme) {
  const cursor = theme.cursor;
  const highlight = theme.highlight;

  // JSON.stringify, not string concatenation: a colour from theme.json is
  // validated but still user input, and it ends up inside a script.
  const config = JSON.stringify({
    cursor: {
      enabled: !!cursor.enabled,
      color: cursor.color,
      strokeColor: cursor.strokeColor,
      size: cursor.size,
    },
    highlight: {
      enabled: !!highlight.enabled,
      color: highlight.color,
      glow: !!highlight.glow,
      borderWidth: highlight.borderWidth,
      borderRadius: highlight.borderRadius,
    },
  });

  return `(() => {
  const CFG = ${config};
  const ROOT_ID = '__tut_overlay_root';
  const MOVE_MS = 450;

  let root = null, cursorEl = null, ringEl = null;
  let pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let anim = null;

  function cursorSvg(size, fill, stroke) {
    // A plain arrow pointer, drawn rather than imported so there is no asset to
    // load and nothing to go missing mid-navigation.
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" ' +
      'xmlns="http://www.w3.org/2000/svg" style="display:block">' +
      '<path d="M5 2 L5 20 L10 15.5 L13 22 L16.5 20.3 L13.5 14 L20 14 Z" ' +
      'fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5" ' +
      'stroke-linejoin="round"/></svg>';
  }

  function mount() {
    if (!document.body) return false;
    const existing = document.getElementById(ROOT_ID);
    if (existing && existing.isConnected) { root = existing; return true; }

    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('data-tut-overlay', '');
    root.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      'z-index:2147483647', 'contain:layout style size',
    ].join(';');

    if (CFG.highlight.enabled) {
      ringEl = document.createElement('div');
      ringEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
        'border:' + CFG.highlight.borderWidth + 'px solid ' + CFG.highlight.color,
        'border-radius:' + CFG.highlight.borderRadius + 'px',
        'box-sizing:border-box',
        'opacity:0',
        'transition:opacity 180ms ease, transform 220ms ease, left 220ms ease, top 220ms ease, width 220ms ease, height 220ms ease',
        'pointer-events:none',
        CFG.highlight.glow
          ? 'box-shadow:0 0 0 4px ' + hexA(CFG.highlight.color, 0.25) + ', 0 0 18px 2px ' + hexA(CFG.highlight.color, 0.55)
          : '',
      ].filter(Boolean).join(';');
      root.appendChild(ringEl);
    }

    if (CFG.cursor.enabled) {
      cursorEl = document.createElement('div');
      cursorEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0',
        'width:' + CFG.cursor.size + 'px', 'height:' + CFG.cursor.size + 'px',
        'pointer-events:none',
        'filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45))',
        'will-change:transform',
      ].join(';');
      cursorEl.innerHTML = cursorSvg(CFG.cursor.size, CFG.cursor.color, CFG.cursor.strokeColor);
      root.appendChild(cursorEl);
      paintCursor();
    }

    document.body.appendChild(root);
    return true;
  }

  function hexA(hex, alpha) {
    const h = String(hex).replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function paintCursor() {
    if (cursorEl) cursorEl.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
  }

  function ensure() {
    if (root && root.isConnected) return true;
    return mount();
  }

  // Mounting can fail here (no body yet) and succeed on a later event; that is
  // the whole point of retrying rather than assuming the document is ready.
  mount();
  document.addEventListener('DOMContentLoaded', mount);
  document.addEventListener('readystatechange', mount);
  window.addEventListener('load', mount);

  window.__tutMoveCursor = (x, y, durationMs) => new Promise((resolve) => {
    if (!CFG.cursor.enabled || !ensure() || !cursorEl) return resolve();
    if (anim) cancelAnimationFrame(anim);
    const from = { x: pos.x, y: pos.y };
    const dist = Math.hypot(x - from.x, y - from.y);
    const ms = durationMs != null ? durationMs : Math.min(MOVE_MS, 120 + dist * 0.6);
    if (ms <= 0 || dist < 1) { pos = { x, y }; paintCursor(); return resolve(); }
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      // easeInOutCubic - a linear glide reads as a teleport on video.
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      pos = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
      paintCursor();
      if (t < 1) { anim = requestAnimationFrame(tick); } else { anim = null; resolve(); }
    };
    anim = requestAnimationFrame(tick);
  });

  window.__tutClickPulse = () => {
    if (!CFG.cursor.enabled || !ensure() || !cursorEl) return;
    cursorEl.animate(
      [{ transform: cursorEl.style.transform + ' scale(1)' },
       { transform: cursorEl.style.transform + ' scale(0.78)' },
       { transform: cursorEl.style.transform + ' scale(1)' }],
      { duration: 260, easing: 'ease-out' }
    );
  };

  window.__tutHighlight = (rect) => {
    if (!CFG.highlight.enabled || !ensure() || !ringEl) return;
    const pad = 6;
    ringEl.style.left = (rect.x - pad) + 'px';
    ringEl.style.top = (rect.y - pad) + 'px';
    ringEl.style.width = (rect.width + pad * 2) + 'px';
    ringEl.style.height = (rect.height + pad * 2) + 'px';
    ringEl.style.opacity = '1';
  };

  window.__tutClearHighlight = () => {
    if (ringEl) ringEl.style.opacity = '0';
  };

  window.__tutOverlayReady = true;
})();`;
}

module.exports = { buildOverlayScript };
