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
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      .panel {
        position: fixed; top: 0; right: 0; width: \${PANEL_WIDTH}px; height: 100vh;
        background: #101318; color: #E8EAF0;
        display: flex; flex-direction: column;
        border-left: 1px solid #232833; box-shadow: -12px 0 40px rgba(0,0,0,.45);
        font-size: 13px; line-height: 1.4;
      }
      .head { padding: 16px 18px 13px; border-bottom: 1px solid #232833; display: block; }
      .head h2 { display: block; margin: 0 0 4px; font-size: 14px; font-weight: 650;
                 letter-spacing: -.2px; color: #E8EAF0; }
      .sub { display: block; color: #8A93A6; font-size: 12px; line-height: 1.5; }
      .list { flex: 1; overflow-y: auto; padding: 10px 12px; }
      .empty { color: #6B7488; padding: 26px 8px; text-align: center; line-height: 1.7; }
      .step {
        background: #171B23; border: 1px solid #232833; border-radius: 10px;
        padding: 10px 11px; margin-bottom: 9px;
      }
      .row { display: flex; align-items: center; gap: 7px; }
      .n { color: #6B7488; font-variant-numeric: tabular-nums; min-width: 17px; font-size: 12px; }
      select, input, textarea {
        background: #0C0F14; color: #E8EAF0; border: 1px solid #2A3040;
        border-radius: 7px; padding: 6px 8px; font-size: 12px; width: 100%;
        font-family: inherit;
      }
      select { width: auto; padding-right: 22px; }
      textarea { resize: vertical; min-height: 30px; margin-top: 6px; line-height: 1.45; }
      .target {
        color: #8A93A6; font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 11px; margin-top: 7px; word-break: break-all; line-height: 1.45;
      }
      .x {
        margin-left: auto; background: none; border: 0; color: #6B7488;
        cursor: pointer; font-size: 15px; padding: 0 3px; line-height: 1;
      }
      .x:hover { color: #FF6B6B; }
      .foot { padding: 12px; border-top: 1px solid #232833; display: flex; gap: 8px; }
      button.act {
        flex: 1; padding: 10px; border-radius: 9px; border: 1px solid #2A3040;
        background: #171B23; color: #E8EAF0; cursor: pointer; font-size: 13px; font-weight: 550;
        font-family: inherit;
      }
      button.act:hover { background: #1E232D; }
      button.primary { background: #6C5CE7; border-color: #6C5CE7; color: #fff; }
      button.primary:hover { background: #7d6ff0; }
      .paused { color: #FFB74D; }
    \`;
  }

  /** The only two rules that have to live in the page itself. */
  function pageCss() {
    return 'html{margin-right:' + PANEL_WIDTH + 'px !important}' +
      '[data-tut-pick]{outline:2px solid #6C5CE7 !important;outline-offset:2px}' +
      '#' + PANEL_ID + '{position:fixed;inset:0 0 auto auto;z-index:2147483647}';
  }

  function mount() {
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
      '    <h2>Recording your walkthrough</h2>',
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
