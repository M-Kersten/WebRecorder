'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The cursor, highlight and hint overlay, built as a string and injected with
 * addInitScript so it survives every navigation.
 *
 * Two things this has to get right:
 *
 * 1. addInitScript runs before the document exists. Touching document.head or
 *    document.body unconditionally throws, the script dies, and the overlay
 *    never appears - with no error anywhere near the recording code. Every DOM
 *    touch below is guarded, and mounting retries on readystatechange.
 * 2. It runs again on every navigation, so mounting is idempotent, and the
 *    cursor's position is carried across in sessionStorage. Without that the
 *    pointer snaps back to the middle of the screen on every page load, which
 *    is the single most obvious tell that a walkthrough is automated.
 *
 * Everything visual is interpolated from the theme, so restyling never means
 * editing this file.
 */

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const FONT_FORMAT = { '.otf': 'opentype', '.woff': 'woff', '.woff2': 'woff2' };

function dataUri(file, table = MIME) {
  const ext = path.extname(file).toLowerCase();
  return `data:${table[ext] || 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** An @font-face rule with the file inlined, so no network or CORS is involved. */
function fontFaceCss(font) {
  const ext = path.extname(font.path).toLowerCase();
  const format = FONT_FORMAT[ext] || 'truetype';
  return `@font-face{font-family:'${font.family.replace(/'/g, "\\'")}';` +
    `src:url(${dataUri(font.path, { [ext]: `font/${ext.slice(1)}` })}) format('${format}');` +
    `font-weight:${font.weight};font-style:${font.style};font-display:block;}`;
}

function buildOverlayScript(theme) {
  const { cursor, highlight, hints } = theme;
  const hintFont = hints.enabled && hints.font ? theme.fonts[hints.font] : null;

  // JSON.stringify, not string concatenation: these values are validated but
  // still user input, and they end up inside a script.
  const config = JSON.stringify({
    cursor: {
      enabled: !!cursor.enabled,
      color: cursor.color,
      strokeColor: cursor.strokeColor,
      size: cursor.size,
      image: cursor.imagePath ? dataUri(cursor.imagePath) : null,
      hotspotX: cursor.hotspot[0],
      hotspotY: cursor.hotspot[1],
      moveMs: cursor.moveMs,
      easing: cursor.easing,
      ripple: !!cursor.ripple,
      rippleColor: cursor.rippleColor || highlight.color,
      rippleMs: cursor.rippleMs,
    },
    highlight: {
      enabled: !!highlight.enabled,
      color: highlight.color,
      glow: !!highlight.glow,
      borderWidth: highlight.borderWidth,
      borderRadius: highlight.borderRadius,
    },
    hints: {
      enabled: !!hints.enabled,
      fontFamily: hintFont ? hintFont.family : null,
      fontWeight: hintFont ? hintFont.weight : 400,
      fontSize: hints.fontSize,
      color: hints.color,
      backgroundColor: hints.backgroundColor,
      backgroundOpacity: hints.backgroundOpacity,
      accentColor: hints.accentColor,
      borderRadius: hints.borderRadius,
      maxWidth: hints.maxWidth,
      padding: hints.padding,
      position: hints.position,
      offset: hints.offset,
      fadeMs: hints.fadeMs,
    },
    fontFace: hintFont ? fontFaceCss(hintFont) : '',
  });

  return `(() => {
  const CFG = ${config};
  const ROOT_ID = '__tut_overlay_root';
  const POS_KEY = '__tut_cursor_pos';

  let root = null, cursorEl = null, ringEl = null, hintEl = null, styleEl = null;
  let pos = loadPos();
  let anim = null;

  function loadPos() {
    // Carried across navigations so the pointer does not jump to the middle of
    // the screen every time a page loads.
    try {
      const saved = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
      if (saved && isFinite(saved.x) && isFinite(saved.y)) return saved;
    } catch (e) { /* private mode, or no storage: fall through */ }
    return { x: window.innerWidth / 2, y: window.innerHeight * 0.62 };
  }

  function savePos() {
    try { sessionStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* ignore */ }
  }

  function rgba(hex, alpha) {
    const h = String(hex).replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  const EASING = {
    linear: (t) => t,
    easeOut: (t) => 1 - Math.pow(1 - t, 3),
    easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  };

  function cursorMarkup() {
    if (CFG.cursor.image) {
      return '<img src="' + CFG.cursor.image + '" width="' + CFG.cursor.size +
        '" alt="" style="display:block;width:' + CFG.cursor.size +
        'px;height:auto;user-select:none">';
    }
    // A plain arrow, drawn rather than imported so there is no asset to load
    // and nothing to go missing mid-navigation.
    return '<svg width="' + CFG.cursor.size + '" height="' + CFG.cursor.size +
      '" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="display:block">' +
      '<path d="M5 2 L5 20 L10 15.5 L13 22 L16.5 20.3 L13.5 14 L20 14 Z" fill="' +
      CFG.cursor.color + '" stroke="' + CFG.cursor.strokeColor +
      '" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  }

  function mount() {
    if (!document.body) return false;
    const existing = document.getElementById(ROOT_ID);
    if (existing && existing.isConnected) { root = existing; return true; }

    if (CFG.fontFace && document.head && !document.getElementById('__tut_overlay_font')) {
      styleEl = document.createElement('style');
      styleEl.id = '__tut_overlay_font';
      styleEl.textContent = CFG.fontFace;
      document.head.appendChild(styleEl);
    }

    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('data-tut-overlay', '');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;' +
      'z-index:2147483647;contain:layout style size';

    if (CFG.highlight.enabled) {
      ringEl = document.createElement('div');
      ringEl.setAttribute('data-tut-ring', '');
      ringEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
        'border:' + CFG.highlight.borderWidth + 'px solid ' + CFG.highlight.color,
        'border-radius:' + CFG.highlight.borderRadius + 'px',
        'box-sizing:border-box', 'opacity:0', 'pointer-events:none',
        'transition:opacity 200ms ease, left 260ms cubic-bezier(.22,.61,.36,1), ' +
          'top 260ms cubic-bezier(.22,.61,.36,1), width 260ms cubic-bezier(.22,.61,.36,1), ' +
          'height 260ms cubic-bezier(.22,.61,.36,1)',
        CFG.highlight.glow
          ? 'box-shadow:0 0 0 4px ' + rgba(CFG.highlight.color, 0.22) +
            ', 0 0 20px 2px ' + rgba(CFG.highlight.color, 0.5)
          : '',
      ].filter(Boolean).join(';');
      root.appendChild(ringEl);
    }

    if (CFG.hints.enabled) {
      hintEl = document.createElement('div');
      hintEl.setAttribute('data-tut-hint', '');
      const h = CFG.hints;
      hintEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0',
        'max-width:' + h.maxWidth + 'px',
        'padding:' + h.padding + 'px ' + Math.round(h.padding * 1.25) + 'px',
        'background:' + rgba(h.backgroundColor, h.backgroundOpacity),
        'color:' + h.color,
        'border-radius:' + h.borderRadius + 'px',
        'border-left:' + Math.max(3, Math.round(h.fontSize * 0.16)) + 'px solid ' + h.accentColor,
        'font-family:' + (h.fontFamily ? "'" + h.fontFamily + "', " : '') +
          'system-ui, -apple-system, sans-serif',
        'font-weight:' + h.fontWeight,
        'font-size:' + h.fontSize + 'px',
        'line-height:1.45',
        'box-shadow:0 10px 34px rgba(0,0,0,.42)',
        'backdrop-filter:blur(6px)',
        '-webkit-font-smoothing:antialiased',
        'opacity:0', 'transform:translateY(8px)',
        'transition:opacity ' + h.fadeMs + 'ms ease, transform ' + h.fadeMs + 'ms cubic-bezier(.22,.61,.36,1)',
        'pointer-events:none', 'white-space:pre-wrap',
      ].join(';');
      root.appendChild(hintEl);
    }

    if (CFG.cursor.enabled) {
      cursorEl = document.createElement('div');
      cursorEl.setAttribute('data-tut-cursor', '');
      cursorEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0',
        'width:' + CFG.cursor.size + 'px',
        'pointer-events:none',
        'filter:drop-shadow(0 2px 5px rgba(0,0,0,.45))',
        'will-change:transform',
      ].join(';');
      cursorEl.innerHTML = cursorMarkup();
      root.appendChild(cursorEl);
      paintCursor();
    }

    document.body.appendChild(root);
    return true;
  }

  function paintCursor() {
    if (!cursorEl) return;
    // The hotspot is the point that should sit on the target, expressed as a
    // fraction of the image, so a custom PNG lands where its tip is.
    const dx = pos.x - CFG.cursor.size * CFG.cursor.hotspotX;
    const dy = pos.y - CFG.cursor.size * CFG.cursor.hotspotY;
    cursorEl.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
  }

  function ensure() {
    if (root && root.isConnected) return true;
    return mount();
  }

  mount();
  document.addEventListener('DOMContentLoaded', mount);
  document.addEventListener('readystatechange', mount);
  window.addEventListener('load', mount);

  window.__tutMoveCursor = (x, y, durationMs) => new Promise((resolve) => {
    if (!CFG.cursor.enabled || !ensure() || !cursorEl) return resolve();
    if (anim) cancelAnimationFrame(anim);
    const from = { x: pos.x, y: pos.y };
    const dist = Math.hypot(x - from.x, y - from.y);
    const auto = Math.min(900, 180 + dist * 0.62);
    const ms = durationMs != null ? durationMs : (CFG.cursor.moveMs != null ? CFG.cursor.moveMs : auto);
    const ease = EASING[CFG.cursor.easing] || EASING.easeInOut;

    if (ms <= 0 || dist < 1) {
      pos = { x, y }; paintCursor(); savePos(); return resolve();
    }
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      pos = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
      paintCursor();
      if (t < 1) { anim = requestAnimationFrame(tick); }
      else { anim = null; savePos(); resolve(); }
    };
    anim = requestAnimationFrame(tick);
  });

  window.__tutClickPulse = () => {
    if (!CFG.cursor.enabled || !ensure()) return;
    if (cursorEl) {
      const base = cursorEl.style.transform;
      cursorEl.animate(
        [{ transform: base + ' scale(1)' },
         { transform: base + ' scale(0.82)' },
         { transform: base + ' scale(1)' }],
        { duration: 240, easing: 'ease-out' }
      );
    }
    if (!CFG.cursor.ripple || !root) return;

    // A ring that expands and fades from the click point. Removed on finish so
    // a long flow does not accumulate hundreds of dead nodes.
    const size = Math.max(48, CFG.cursor.size * 2.4);
    const ripple = document.createElement('div');
    ripple.setAttribute('data-tut-ripple', '');
    ripple.style.cssText = [
      'position:fixed',
      'left:' + (pos.x - size / 2) + 'px', 'top:' + (pos.y - size / 2) + 'px',
      'width:' + size + 'px', 'height:' + size + 'px',
      'border:2px solid ' + CFG.cursor.rippleColor,
      'background:' + rgba(CFG.cursor.rippleColor, 0.16),
      'border-radius:50%', 'pointer-events:none',
      'will-change:transform,opacity',
    ].join(';');
    root.appendChild(ripple);
    const done = ripple.animate(
      [{ transform: 'scale(0.28)', opacity: 0.85 },
       { transform: 'scale(1)', opacity: 0 }],
      { duration: CFG.cursor.rippleMs, easing: 'cubic-bezier(.22,.61,.36,1)' }
    );
    done.onfinish = () => ripple.remove();
    // animate() can be a no-op if the element never renders; clean up anyway.
    setTimeout(() => ripple.remove(), CFG.cursor.rippleMs + 400);
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

  window.__tutShowHint = (text, rect) => {
    if (!CFG.hints.enabled || !ensure() || !hintEl) return;
    hintEl.textContent = text;
    hintEl.style.opacity = '0';
    hintEl.style.transform = 'translateY(8px)';
    // Measure after the text is in, then place, then fade in on the next frame.
    requestAnimationFrame(() => {
      place(hintEl, rect);
      requestAnimationFrame(() => {
        hintEl.style.opacity = '1';
        hintEl.style.transform = 'translateY(0)';
      });
    });
  };

  window.__tutHideHint = () => {
    if (!hintEl) return;
    hintEl.style.opacity = '0';
    hintEl.style.transform = 'translateY(8px)';
  };

  function place(el, rect) {
    const gap = CFG.hints.offset;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let left;
    let top;

    if (CFG.hints.position === 'auto' && rect) {
      // Under the element if it fits, otherwise above it.
      const below = rect.y + rect.height + gap;
      top = below + h <= vh - gap ? below : rect.y - h - gap;
      left = rect.x + rect.width / 2 - w / 2;
    } else {
      const spot = CFG.hints.position === 'auto' ? 'bottom-center' : CFG.hints.position;
      const [vert, horiz] = spot.split('-');
      top = vert === 'top' ? gap : vh - h - gap;
      left = horiz === 'left' ? gap : horiz === 'right' ? vw - w - gap : (vw - w) / 2;
    }
    el.style.left = clamp(left, gap, Math.max(gap, vw - w - gap)) + 'px';
    el.style.top = clamp(top, gap, Math.max(gap, vh - h - gap)) + 'px';
  }

  window.__tutOverlayReady = true;
})();`;
}

module.exports = { buildOverlayScript, dataUri, fontFaceCss };
