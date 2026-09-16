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

/**
 * How much of the frame the captions will occupy, top and bottom, in the
 * viewport's own pixels. Two lines plus the margin is the worst case.
 */
function captionBand(theme) {
  const c = theme.captions;
  if (!c.enabled) return { top: 0, bottom: 0 };
  const band = Math.round(c.marginBottom + c.fontSize * 3);
  return c.position === 'top' ? { top: band, bottom: 0 } : { top: 0, bottom: band };
}

function buildOverlayScript(theme, mask = []) {
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
      // "auto" means take it from the element being highlighted.
      borderRadius: highlight.borderRadius,
      fadeMs: highlight.fadeMs,
    },
    mask: mask.map((rule) => ({
      selector: rule.selector,
      mode: rule.mode,
      text: rule.text || '',
      radius: rule.radius,
    })),
    hints: {
      enabled: !!hints.enabled,
      fontFamily: hintFont ? hintFont.family : null,
      fontWeight: hintFont ? hintFont.weight : 400,
      fontSize: hints.fontSize,
      color: hints.color,
      backgroundColor: hints.backgroundColor,
      backgroundOpacity: hints.backgroundOpacity,
      accent: hints.accent,
      accentColor: hints.accentColor,
      borderColor: hints.borderColor,
      borderRadius: hints.borderRadius,
      maxWidth: hints.maxWidth,
      padding: hints.padding,
      position: hints.position,
      offset: hints.offset,
      fadeMs: hints.fadeMs,
      // Captions are burned on afterwards, so the overlay cannot see them.
      // Without this a hint and a caption land in the same strip of screen and
      // sit on top of each other.
      reserve: captionBand(theme),
    },
    // The stage, raised over a page while it loads. See the curtain block
    // below for why this is here rather than in the recorder.
    curtain: {
      enabled: theme.video.curtain !== false,
      color: theme.video.backgroundColor,
      fadeMs: Number.isFinite(theme.video.curtainFadeMs) ? theme.video.curtainFadeMs : 260,
      maxMs: 20000,
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
      'z-index:2147483646;contain:layout style size';

    if (CFG.highlight.enabled) {
      ringEl = document.createElement('div');
      ringEl.setAttribute('data-tut-ring', '');
      ringEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
        'border:' + CFG.highlight.borderWidth + 'px solid ' + CFG.highlight.color,
        'border-radius:' + ringRadius(null),
        'box-sizing:border-box', 'opacity:0', 'pointer-events:none',
        // Opacity only. Transitioning the geometry made the ring travel across
        // the page from the last element to this one, which reads as the ring
        // being a thing that moves rather than a marker on what is being
        // pointed at.
        'transition:opacity ' + CFG.highlight.fadeMs + 'ms ease',
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

      // A hairline rather than a slab of colour down one side. The border is
      // derived from the text colour, which contrasts with the surface by
      // definition, so it reads the same on a dark hint and a light one.
      const hairline = h.borderColor || rgba(h.color, 0.14);
      const border = ['border:1px solid ' + hairline];
      if (h.accent === 'bar') {
        border.push('border-left:' + Math.max(3, Math.round(h.fontSize * 0.16)) +
          'px solid ' + h.accentColor);
      }

      hintEl.style.cssText = [
        'position:fixed', 'left:0', 'top:0',
        'max-width:' + h.maxWidth + 'px',
        'padding:' + h.padding + 'px ' + Math.round(h.padding * 1.15) + 'px',
        'background:' + rgba(h.backgroundColor, h.backgroundOpacity),
        'color:' + h.color,
        'border-radius:' + h.borderRadius + 'px',
      ].concat(border).concat([
        'font-family:' + (h.fontFamily ? "'" + h.fontFamily + "', " : '') +
          'system-ui, -apple-system, sans-serif',
        'font-weight:' + h.fontWeight,
        'font-size:' + h.fontSize + 'px',
        'line-height:1.4',
        'letter-spacing:-0.01em',
        // Two layers: a wide soft one for depth, a tight one to seat it on the
        // page. One heavy shadow reads as a sticker floating above it.
        'box-shadow:0 24px 48px -18px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.16)',
        // Whenever anything can show through at all. Without the blur, a hint at
        // 0.95 opacity lets the page's own text ghost through it legibly, which
        // reads as a rendering fault rather than as a translucent surface.
        h.backgroundOpacity < 1 ? 'backdrop-filter:blur(14px) saturate(1.2)' : '',
        '-webkit-font-smoothing:antialiased',
        'opacity:0', 'transform:translateY(6px)',
        'transition:opacity ' + h.fadeMs + 'ms ease, transform ' + h.fadeMs + 'ms cubic-bezier(.22,.61,.36,1)',
        'pointer-events:none', 'white-space:pre-wrap',
      ]).filter(Boolean).join(';');
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

  /**
   * Hide personal data before it is ever recorded.
   *
   * blur and hide go in as a stylesheet keyed on the caller's own selectors.
   * That survives anything the page does to itself: a framework re-rendering a
   * table cannot undo a CSS rule the way it would undo an inline style or a
   * class we had added to a node.
   *
   * Text replacement has no CSS equivalent, so it runs on a MutationObserver,
   * guarded so that writing the replacement does not retrigger itself.
   */
  function applyMask() {
    if (!CFG.mask.length || !document.head) return;

    if (!document.getElementById('__tut_mask_style')) {
      const rules = [];
      for (const rule of CFG.mask) {
        if (rule.mode === 'blur') {
          rules.push(rule.selector + '{filter:blur(' + rule.radius + 'px) !important}');
        } else if (rule.mode === 'hide') {
          // visibility, not display: removing a node reflows the layout and the
          // recording no longer matches the site.
          rules.push(rule.selector + '{visibility:hidden !important}');
        }
      }
      if (rules.length) {
        const style = document.createElement('style');
        style.id = '__tut_mask_style';
        style.textContent = rules.join(' ');
        document.head.appendChild(style);
      }
    }

    replaceText();
    if (!maskObserver && document.body) {
      const textRules = CFG.mask.filter((r) => r.mode === 'text');
      if (textRules.length) {
        maskObserver = new MutationObserver(() => {
          if (replacing) return;
          replacing = true;
          try { replaceText(); } finally { replacing = false; }
        });
        maskObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  function replaceText() {
    for (const rule of CFG.mask) {
      if (rule.mode !== 'text') continue;
      let nodes;
      try { nodes = document.querySelectorAll(rule.selector); } catch (e) { continue; }
      for (const node of nodes) {
        // Only write when it differs, or the observer sees our own change and
        // we loop forever.
        if (node.textContent !== rule.text) node.textContent = rule.text;
      }
    }
  }

  let maskObserver = null;
  let replacing = false;

  /**
   * addInitScript runs in every frame, iframes included. The mask has to run in
   * all of them - a customer name inside an embedded dashboard is as personal
   * as one in the page around it - while the cursor, ring and hint belong to the
   * top frame only. Mounting them in a subframe puts a second pointer inside the
   * widget, clipped to its box and offset from the real one.
   */
  const TOP_FRAME = (() => {
    try { return window.self === window.top; } catch (e) { return false; }
  })();

  /* ------------------------------------------------------------------ *
   * The curtain.
   *
   * A page being fetched, parsed and hydrated is not a thing anybody wants in
   * a walkthrough: a flash of white, a half-styled skeleton, "Loading...", and
   * then the content popping in. The browser will not hold the previous frame
   * across a navigation, so the only way to cover it is from inside the new
   * document, before it has painted anything.
   *
   * Which is why this sits in the injected script and not in the recorder. It
   * has to run at document_start, and at document_start there is no
   * documentElement yet - so the first thing here is a MutationObserver
   * waiting for one, which fires while the parser is still working through the
   * head. The recorder lowers it once the page has settled; the timeout is a
   * safety net for a navigation nobody is driving, such as a link the flow
   * clicked, so a video can never be left sitting on a blank stage.
   * ------------------------------------------------------------------ */
  let curtainEl = null;
  let curtainTimer = null;

  function raiseCurtain() {
    if (!CFG.curtain.enabled || !TOP_FRAME) return true;
    if (!document.documentElement) return false;
    if (curtainEl && curtainEl.isConnected) return true;
    curtainEl = document.createElement('div');
    curtainEl.setAttribute('data-tut-curtain', '');
    // Above the cursor, not below it. A pointer hanging in the middle of a
    // blank stage while a page loads is the oddest thing in the video, and it
    // is also the one thing stopping the stage from being a flat, known colour
    // - which is what lets the recorder find where the curtain came down.
    curtainEl.style.cssText = 'position:fixed;inset:0;z-index:2147483647;' +
      'pointer-events:none;background:' + CFG.curtain.color + ';opacity:1;' +
      'transition:opacity ' + CFG.curtain.fadeMs + 'ms ease';
    document.documentElement.appendChild(curtainEl);
    if (curtainTimer) clearTimeout(curtainTimer);
    curtainTimer = setTimeout(() => lowerCurtain(), CFG.curtain.maxMs);
    return true;
  }

  function lowerCurtain(fadeMs) {
    if (curtainTimer) { clearTimeout(curtainTimer); curtainTimer = null; }
    const el = curtainEl || document.querySelector('[data-tut-curtain]');
    if (!el) return Promise.resolve();
    const ms = fadeMs != null ? fadeMs : CFG.curtain.fadeMs;
    el.style.transition = 'opacity ' + ms + 'ms ease';
    // A reflow, so the browser has an opacity of 1 to animate away from. Set
    // in the same frame it was created in, the transition never runs and the
    // curtain vanishes instead of fading.
    void el.offsetWidth;
    el.style.opacity = '0';
    return new Promise((resolve) => setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      curtainEl = null;
      resolve();
    }, ms + 30));
  }

  if (!raiseCurtain()) {
    const watcher = new MutationObserver(() => { if (raiseCurtain()) watcher.disconnect(); });
    watcher.observe(document, { childList: true, subtree: false });
  }

  window.__tutCurtainDown = (ms) => lowerCurtain(ms);
  window.__tutCurtainUp = () => { raiseCurtain(); };

  /* ------------------------------------------------------------------ *
   * In-flight requests.
   *
   * "Has the page stopped changing" is not answerable from the DOM alone. The
   * shape almost every site has now is: render a shell, fetch, render the
   * content. Between the shell and the response the DOM is perfectly still,
   * for as long as the request takes - so a recorder watching only mutations
   * calls it finished and films the skeleton.
   *
   * fetch and XMLHttpRequest are wrapped here rather than counted from
   * outside, because this script runs before any of the page's own, which is
   * the only moment where wrapping them is honest: a script that grabs its own
   * reference to fetch afterwards still goes through this one.
   * ------------------------------------------------------------------ */
  (() => {
    const net = { inflight: 0, at: Date.now() };
    const done = () => { net.inflight = Math.max(0, net.inflight - 1); net.at = Date.now(); };

    if (typeof window.fetch === 'function') {
      const original = window.fetch;
      window.fetch = function (...args) {
        net.inflight++;
        net.at = Date.now();
        let result;
        try {
          result = original.apply(this, args);
        } catch (e) {
          done();
          throw e;
        }
        return Promise.resolve(result).then(
          (r) => { done(); return r; },
          (e) => { done(); throw e; }
        );
      };
    }

    if (typeof window.XMLHttpRequest === 'function') {
      const send = window.XMLHttpRequest.prototype.send;
      window.XMLHttpRequest.prototype.send = function (...args) {
        net.inflight++;
        net.at = Date.now();
        // loadend covers success, failure and abort alike, so a request that
        // goes wrong cannot leave the counter stuck above zero forever.
        this.addEventListener('loadend', done, { once: true });
        return send.apply(this, args);
      };
    }

    window.__tutNet = net;
  })();

  function init() {
    if (TOP_FRAME) mount();
    applyMask();
  }

  init();
  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('readystatechange', init);
  window.addEventListener('load', init);

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

  const RING_PAD = 6;

  /**
   * The ring sits RING_PAD outside the element, so matching its corners means
   * growing each radius by that padding. Otherwise a ring around a card with a
   * 20px radius reads as a slightly wrong rectangle rather than a highlight.
   */
  function ringRadius(elementRadius) {
    if (CFG.highlight.borderRadius !== 'auto') return CFG.highlight.borderRadius + 'px';
    if (!elementRadius) return '0px';
    // border-radius can be four values, and each can be a percentage.
    return String(elementRadius).trim().split(/\s+/)
      .map((part) => (part.endsWith('%') ? part : 'calc(' + part + ' + ' + RING_PAD + 'px)'))
      .join(' ');
  }

  window.__tutHighlight = (rect) => {
    if (!CFG.highlight.enabled || !ensure() || !ringEl) return;

    // Move it while it cannot be seen, then fade in where it landed. The
    // transition is suppressed for the write itself so the ring snaps even if
    // it happened to still be visible from the step before.
    ringEl.style.transition = 'none';
    ringEl.style.left = (rect.x - RING_PAD) + 'px';
    ringEl.style.top = (rect.y - RING_PAD) + 'px';
    ringEl.style.width = (rect.width + RING_PAD * 2) + 'px';
    ringEl.style.height = (rect.height + RING_PAD * 2) + 'px';
    ringEl.style.borderRadius = ringRadius(rect.radius);
    void ringEl.offsetWidth;                       // commit the move
    ringEl.style.transition = 'opacity ' + CFG.highlight.fadeMs + 'ms ease';
    ringEl.style.opacity = '1';
  };

  window.__tutClearHighlight = () => {
    if (ringEl) ringEl.style.opacity = '0';
  };

  window.__tutShowHint = (text, rect) => {
    if (!CFG.hints.enabled || !ensure() || !hintEl) return;
    hintEl.textContent = text;
    hintEl.style.opacity = '0';
    hintEl.style.transform = 'translateY(6px)';
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
    hintEl.style.transform = 'translateY(6px)';
  };

  function place(el, rect) {
    const gap = CFG.hints.offset;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // The strip the captions will be burned into is not available.
    const ceiling = gap + CFG.hints.reserve.top;
    const floor = vh - gap - CFG.hints.reserve.bottom;
    let left;
    let top;

    if (CFG.hints.position === 'auto' && rect) {
      // Under the element if it fits, otherwise above it.
      const below = rect.y + rect.height + gap;
      top = below + h <= floor ? below : rect.y - h - gap;
      left = rect.x + rect.width / 2 - w / 2;
    } else {
      const spot = CFG.hints.position === 'auto' ? 'bottom-center' : CFG.hints.position;
      const [vert, horiz] = spot.split('-');
      top = vert === 'top' ? ceiling : floor - h;
      left = horiz === 'left' ? gap : horiz === 'right' ? vw - w - gap : (vw - w) / 2;
    }
    el.style.left = clamp(left, gap, Math.max(gap, vw - w - gap)) + 'px';
    el.style.top = clamp(top, ceiling, Math.max(ceiling, floor - h)) + 'px';
  }

  window.__tutOverlayReady = true;
})();`;
}

module.exports = { buildOverlayScript, dataUri, fontFaceCss, captionBand };
