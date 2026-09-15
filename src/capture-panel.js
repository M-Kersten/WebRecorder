'use strict';

const { SELECTOR_SCRIPT } = require('./selector');

/**
 * The panel that rides along on the site while you walk through it.
 *
 * Clicks and typing are captured as you go and passed through to the page, so
 * the site behaves normally and the flow that comes out is the walk you just
 * did. Node holds the list of steps; this only renders it and sends edits back,
 * which is what lets the list survive a navigation.
 *
 * The panel lives in a shadow root. Plenty of sites style bare element
 * selectors - `header { display: flex }` is enough - and that styling reaches
 * anything the panel puts in the page, so without isolation the panel arrives
 * wearing whatever the site was wearing.
 */
function buildPanelScript() {
  return `(() => {
  if (window.__tutPanelLoaded) return;
  window.__tutPanelLoaded = true;

${SELECTOR_SCRIPT}

  const PANEL_ID = '__tut_capture_panel';
  let steps = [];
  let paused = false;
  let host = null, shadow = null, root = null, listEl = null, pauseBtn = null;

  const ACTIONS = ['click', 'hover', 'type', 'scroll', 'wait', 'goto'];

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const PANEL_WIDTH = 380;

  function css() {
    return \`
      :host { all: initial; }
      * {
        box-sizing: border-box; min-width: 0;
        font-family: 'Overused Grotesk', ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .panel {
        position: fixed; top: 0; right: 0; width: \${PANEL_WIDTH}px; height: 100vh;
        background: #EFF0F4; color: #12141A;
        display: flex; flex-direction: column;
        border-left: 1px solid #E0E2E9; box-shadow: -14px 0 44px rgba(18,20,26,.10);
        font-size: 13px; line-height: 1.45;
      }
      .head { padding: 16px 16px 14px; display: block; }
      .head h2 {
        display: flex; align-items: center; gap: 9px; margin: 0 0 5px;
        font-size: 14px; font-weight: 700; letter-spacing: -.01em; color: #12141A;
      }
      .mark {
        width: 22px; height: 22px; border-radius: 7px; background: #12141A; flex: none;
        display: inline-grid; place-items: center;
      }
      .mark svg { width: 9px; height: 9px; display: block; }
      .sub { display: block; color: #7B8090; font-size: 12px; line-height: 1.5; }
      .list { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 14px 10px; }
      .empty {
        background: #fff; border-radius: 16px; color: #7B8090;
        padding: 28px 18px; text-align: center; line-height: 1.7;
      }
      .step {
        background: #fff; border: 1.5px solid transparent; border-radius: 16px;
        padding: 12px 13px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(18,20,26,.04);
      }
      .step:focus-within { border-color: #12141A; }
      /* A "type" step carries an extra text box. Without min-width:0 on the
         flex children its intrinsic width wins and that one step alone renders
         wider than the rest of the list. */
      .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .row > * { min-width: 0; }
      .n {
        color: #7B8090; font-variant-numeric: tabular-nums; flex: none;
        min-width: 16px; font-size: 12px; font-weight: 700;
      }
      select, input, textarea {
        background: #fff; color: #12141A; border: 1px solid #E0E2E9;
        border-radius: 10px; padding: 7px 10px; font-size: 12px; width: 100%;
        font-family: inherit;
      }
      input, textarea { min-width: 0; flex: 1 1 auto; }
      select {
        flex: none; width: auto; padding-right: 26px; font-weight: 700; cursor: pointer;
        -webkit-appearance: none; appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5l5-5' stroke='%2312141A' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: right 9px center; background-size: 9px;
      }
      input:focus, select:focus, textarea:focus { outline: none; border-color: #12141A; }
      textarea { resize: vertical; min-height: 32px; margin-top: 7px; line-height: 1.5; }
      .target {
        color: #7B8090; font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 11px; margin-top: 8px; word-break: break-all; line-height: 1.45;
      }
      .x {
        margin-left: auto; flex: none; background: none; border: 0; color: #7B8090;
        cursor: pointer; font-size: 16px; padding: 0 3px; line-height: 1; border-radius: 6px;
      }
      .x:hover { color: #A32222; }
      .foot { padding: 12px 14px 14px; display: flex; gap: 8px; }
      button.act {
        flex: 1; padding: 10px 12px; border-radius: 999px; border: 1px solid #E0E2E9;
        background: #fff; color: #12141A; cursor: pointer; font-size: 13px; font-weight: 700;
        font-family: inherit; white-space: nowrap;
      }
      button.act:hover { background: #F4F5F8; }
      button.primary { background: #E6007E; border-color: #E6007E; color: #fff; }
      button.primary:hover { background: #FF2C99; border-color: #FF2C99; }
      .paused { color: #8C6008; }
    \`;
  }

  /** The only two rules that have to live in the page itself. */
  function pageCss() {
    return 'html{margin-right:' + PANEL_WIDTH + 'px !important}' +
      '[data-tut-pick]{outline:2px solid #E6007E !important;outline-offset:2px}' +
      '#' + PANEL_ID + '{position:fixed;inset:0 0 auto auto;z-index:2147483647}';
  }

  /**
   * The panel belongs to the top frame only.
   *
   * This script is injected into every frame, iframes included, and that is
   * wanted: a click inside an embedded widget has to be recorded like any
   * other. What must not happen is a second panel mounting inside the widget,
   * squeezed into its box with its own margin pushing the widget's layout
   * around.
   */
  const TOP_FRAME = (() => {
    try { return window.self === window.top; } catch (e) { return false; }
  })();

  function mount() {
    if (!TOP_FRAME) return false;
    if (!document.body) return false;
    if (document.getElementById(PANEL_ID)) return true;

    const pageStyle = document.createElement('style');
    pageStyle.id = '__tut_panel_page_css';
    pageStyle.textContent = pageCss();
    (document.head || document.documentElement).appendChild(pageStyle);

    host = document.createElement('div');
    host.id = PANEL_ID;
    // A shadow root, so the site's own CSS cannot reach the panel.
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + css() + '</style>' + [
      '<div class="panel">',
      '  <div class="head">',
      '    <h2><span class="mark">' +
      '<svg viewBox="0 0 10 12" fill="#fff" aria-hidden="true"><path d="M0 0l10 6-10 6z"/></svg>' +
      '</span>Recording your walkthrough</h2>',
      '    <span class="sub" id="__tut_hint_line">Use the site as you normally would. ',
      '    Every click and everything you type is written down.</span>',
      '  </div>',
      '  <div class="list" id="__tut_list"></div>',
      '  <div class="foot">',
      '    <button class="act" id="__tut_pause">Pause</button>',
      '    <button class="act" id="__tut_page">Add page</button>',
      '    <button class="act primary" id="__tut_done">Save flow</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(host);

    root = shadow;
    listEl = shadow.getElementById('__tut_list');
    pauseBtn = shadow.getElementById('__tut_pause');

    pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('paused', paused);
      shadow.getElementById('__tut_hint_line').innerHTML = paused
        ? '<span class="paused">Paused.</span> Click around freely; nothing is recorded.'
        : 'Use the site as you normally would. Every click and everything you type is written down.';
    });
    shadow.getElementById('__tut_page').addEventListener('click', async (e) => {
      e.stopPropagation();
      steps = await window.__tutCaptureAdd({ action: 'goto', url: location.href });
      render();
    });
    shadow.getElementById('__tut_done').addEventListener('click', (e) => {
      e.stopPropagation();
      window.__tutCaptureDone();
    });

    refresh();
    return true;
  }

  // An event from inside the shadow root is retargeted to the host, so testing
  // the host id is enough and works from either side of the boundary.
  const inPanel = (el) => !!(el && el.closest && el.closest('#' + PANEL_ID));

  async function refresh() {
    steps = await window.__tutCaptureList();
    render();
  }

  function render() {
    if (!TOP_FRAME) return;
    if (!listEl) return;
    if (!steps.length) {
      listEl.innerHTML = '<div class="empty">Nothing recorded yet.<br>' +
        'Click something on the page to start.</div>';
      return;
    }
    listEl.innerHTML = steps.map((s, i) => [
      '<div class="step" data-i="' + i + '">',
      '  <div class="row">',
      '    <span class="n">' + (i + 1) + '</span>',
      '    <select data-field="action">' +
           ACTIONS.map((a) => '<option' + (a === s.action ? ' selected' : '') + '>' + a + '</option>').join('') +
         '</select>',
      s.action === 'type'
        ? '    <input data-field="text" value="' + esc(s.text) + '" placeholder="text to type">'
        : '',
      '    <button class="x" data-remove="' + i + '" title="Remove">&times;</button>',
      '  </div>',
      '  <div class="target">' + esc(s.selector || s.url || s.label || '') + '</div>',
      '  <textarea data-field="narration" placeholder="Narration, spoken aloud">' + esc(s.narration) + '</textarea>',
      '  <textarea data-field="hint" placeholder="Hint, shown on screen">' + esc(s.hint) + '</textarea>',
      '</div>',
    ].filter(Boolean).join('')).join('');

    listEl.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        steps = await window.__tutCaptureRemove(Number(btn.dataset.remove));
        render();
      });
    });
    listEl.querySelectorAll('[data-field]').forEach((input) => {
      const commit = async () => {
        const index = Number(input.closest('.step').dataset.i);
        const patch = {};
        patch[input.dataset.field] = input.value;
        steps = await window.__tutCaptureUpdate(index, patch);
        // Re-render only when the shape changed; otherwise it steals focus.
        if (input.dataset.field === 'action') render();
      };
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
    });
  }

  // Capture in the capture phase, so a step is recorded even when the page
  // stops the event from bubbling. The click still goes through: the site
  // behaves normally and the flow matches the walk you actually did.
  document.addEventListener('click', async (e) => {
    if (paused || inPanel(e.target) || !window.__tutCaptureAdd) return;
    const el = e.target;
    if (el.matches('input, textarea, select')) return;   // handled on change
    steps = await window.__tutCaptureAdd({
      action: 'click',
      selector: bestSelector(el),
      label: describeElement(el),
    });
    render();
  }, true);

  document.addEventListener('change', async (e) => {
    if (paused || inPanel(e.target) || !window.__tutCaptureAdd) return;
    const el = e.target;
    if (!el.matches || !el.matches('input, textarea, select')) return;
    if (el.type === 'password') {
      // Never write a password into the flow file. Leave a placeholder that
      // reads from the environment instead.
      steps = await window.__tutCaptureAdd({
        action: 'type', selector: bestSelector(el),
        text: '\${PASSWORD}', label: describeElement(el), secret: true,
      });
    } else {
      steps = await window.__tutCaptureAdd({
        action: 'type', selector: bestSelector(el),
        text: el.value, label: describeElement(el),
      });
    }
    render();
  }, true);

  // A dotted outline under the pointer, so it is obvious what a click records.
  let outlined = null;
  document.addEventListener('mouseover', (e) => {
    if (paused || inPanel(e.target)) return;
    if (outlined) outlined.removeAttribute('data-tut-pick');
    outlined = e.target;
    if (outlined && outlined.setAttribute) outlined.setAttribute('data-tut-pick', '');
  }, true);

  mount();
  document.addEventListener('DOMContentLoaded', mount);
  window.addEventListener('load', () => { mount(); refresh(); });
})();`;
}

module.exports = { buildPanelScript };
