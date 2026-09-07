'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { buildOverlayScript } = require('../src/overlay');
const { launch } = require('../src/browser');
const { loadTheme, deepMerge, DEFAULTS } = require('../src/theme');
const { serveStatic } = require('../src/server');

const REPO = path.join(__dirname, '..');
const PAGE = '<!doctype html><body style="margin:0;height:200vh">' +
  '<button id="b" style="position:absolute;left:300px;top:200px;width:160px;height:44px">Go</button>' +
  '<button id="low" style="position:absolute;left:300px;top:640px;width:160px;height:44px">Low</button>' +
  '</body>';

/**
 * Wait for the hint's fade-in to finish. It slides in on a transform, so a
 * measurement taken mid-transition reads a few pixels off its resting place.
 */
const settle = (page) => page.waitForTimeout(DEFAULTS.hints.fadeMs + 120);

let browser;
let server;
test.before(async () => {
  browser = await launch({ headless: true });
  server = await serveStatic(path.join(REPO, 'demo'), 8211);
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/**
 * Open a page with the overlay for `theme` injected, and hand back the page.
 *
 * Navigates rather than using setContent: setContent replaces the whole
 * document, which tears the mounted overlay out of it. The recorder always
 * navigates, so this is what the overlay actually has to survive.
 */
async function withOverlay(overrides, body = PAGE) {
  const theme = deepMerge(DEFAULTS, overrides);
  if (overrides && overrides.cursor && overrides.cursor.image) {
    theme.cursor.imagePath = path.resolve(REPO, overrides.cursor.image);
  }
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await ctx.addInitScript(buildOverlayScript(theme));
  const page = await ctx.newPage();
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__tutOverlayReady === true);
  await page.waitForFunction(() => !!document.getElementById('__tut_overlay_root'));
  return { page, close: () => ctx.close() };
}

test('the overlay mounts and exposes its whole API', async () => {
  const { page, close } = await withOverlay({});
  try {
    const api = await page.evaluate(() => ({
      move: typeof window.__tutMoveCursor,
      pulse: typeof window.__tutClickPulse,
      highlight: typeof window.__tutHighlight,
      clear: typeof window.__tutClearHighlight,
      showHint: typeof window.__tutShowHint,
      hideHint: typeof window.__tutHideHint,
      mounted: !!document.getElementById('__tut_overlay_root'),
    }));
    assert.deepStrictEqual(api, {
      move: 'function', pulse: 'function', highlight: 'function',
      clear: 'function', showHint: 'function', hideHint: 'function', mounted: true,
    });
  } finally { await close(); }
});

test('a custom cursor image is drawn instead of the built-in arrow', async () => {
  const { page, close } = await withOverlay({ cursor: { image: 'assets/cursor.png' } });
  try {
    const drawn = await page.evaluate(() => {
      const el = document.querySelector('[data-tut-cursor] img');
      return el ? { tag: 'img', src: el.getAttribute('src').slice(0, 14) } : null;
    });
    assert.deepStrictEqual(drawn, { tag: 'img', src: 'data:image/png' },
      'the file should be inlined, so no request can fail mid-recording');
    assert.strictEqual(await page.evaluate(() => !!document.querySelector('[data-tut-cursor] svg')), false);
  } finally { await close(); }
});

test('without an image the arrow is drawn in the theme colour', async () => {
  const { page, close } = await withOverlay({ cursor: { color: '#FFE066' } });
  try {
    const fill = await page.evaluate(() =>
      document.querySelector('[data-tut-cursor] svg path').getAttribute('fill'));
    assert.strictEqual(fill, '#FFE066');
  } finally { await close(); }
});

test('the hotspot decides which part of the pointer lands on the target', async () => {
  const at = async (hotspot) => {
    const { page, close } = await withOverlay({ cursor: { size: 100, hotspot } });
    try {
      await page.evaluate(() => window.__tutMoveCursor(500, 300, 0));
      // await, not just return: finally would otherwise close the page first.
      return await page.evaluate(() => {
        const r = document.querySelector('[data-tut-cursor]').getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top) };
      });
    } finally { await close(); }
  };
  // [0,0] puts the image's top-left on the point; [0.5,0.5] centres it.
  assert.deepStrictEqual(await at([0, 0]), { left: 500, top: 300 });
  assert.deepStrictEqual(await at([0.5, 0.5]), { left: 450, top: 250 });
});

test('the cursor eases to its target rather than jumping', async () => {
  const { page, close } = await withOverlay({ cursor: { moveMs: 400, easing: 'easeInOut' } });
  try {
    await page.evaluate(() => window.__tutMoveCursor(100, 100, 0));
    const samples = await page.evaluate(async () => {
      const seen = [];
      const moving = window.__tutMoveCursor(800, 600);
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 55));
        const box = document.querySelector('[data-tut-cursor]').getBoundingClientRect();
        seen.push(Math.round(box.left));
      }
      await moving;
      return seen;
    });
    const distinct = new Set(samples).size;
    assert.ok(distinct >= 3, `expected intermediate positions, saw ${JSON.stringify(samples)}`);
    // Monotonic: an ease should never overshoot and come back.
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i] >= samples[i - 1], `went backwards: ${JSON.stringify(samples)}`);
    }
  } finally { await close(); }
});

test('a click leaves a ripple that cleans itself up', async () => {
  const { page, close } = await withOverlay({ cursor: { ripple: true, rippleMs: 300 } });
  try {
    await page.evaluate(() => window.__tutMoveCursor(400, 300, 0));
    await page.evaluate(() => window.__tutClickPulse());
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('[data-tut-ripple]').length), 1);

    // Ten clicks must not leave ten dead nodes behind.
    await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) window.__tutClickPulse();
    });
    await page.waitForTimeout(1000);
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('[data-tut-ripple]').length), 0);
  } finally { await close(); }
});

test('ripple can be turned off without turning off the cursor', async () => {
  const { page, close } = await withOverlay({ cursor: { ripple: false } });
  try {
    await page.evaluate(() => window.__tutClickPulse());
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('[data-tut-ripple]').length), 0);
    assert.ok(await page.evaluate(() => !!document.querySelector('[data-tut-cursor]')));
  } finally { await close(); }
});

test('a hint anchors under its target, and above it when there is no room below', async () => {
  const { page, close } = await withOverlay({ hints: { position: 'auto' } });
  try {
    const place = async (selector) => {
      const rect = await page.locator(selector).boundingBox();
      await page.evaluate(({ r }) => window.__tutShowHint('Some explaining text here', r), { r: rect });
      await settle(page);
      const hint = await page.evaluate(() =>
        document.querySelector('[data-tut-hint]').getBoundingClientRect().toJSON());
      return { rect, hint };
    };

    const high = await place('#b');
    assert.ok(high.hint.top > high.rect.y + high.rect.height,
      'an element near the top gets its hint below it');

    const low = await place('#low');
    assert.ok(low.hint.top + low.hint.height < low.rect.y,
      'an element near the bottom gets its hint above it');
  } finally { await close(); }
});

test('a fixed hint position ignores the target', async () => {
  const { page, close } = await withOverlay({ hints: { position: 'top-right', offset: 20 } });
  try {
    await page.evaluate(() => window.__tutShowHint('Pinned', { x: 10, y: 600, width: 40, height: 20 }));
    await settle(page);
    const hint = await page.evaluate(() =>
      document.querySelector('[data-tut-hint]').getBoundingClientRect().toJSON());
    assert.strictEqual(Math.round(hint.top), 20);
    assert.ok(hint.right > 900, `should hug the right edge, got right=${hint.right}`);
  } finally { await close(); }
});

test('a hint never leaves the viewport, whatever it is anchored to', async () => {
  const { page, close } = await withOverlay({ hints: { position: 'auto', offset: 20 } });
  try {
    await page.evaluate(() => window.__tutShowHint('Off the edge', { x: -400, y: 10, width: 30, height: 20 }));
    await settle(page);
    const hint = await page.evaluate(() =>
      document.querySelector('[data-tut-hint]').getBoundingClientRect().toJSON());
    assert.ok(hint.left >= 19, `clamped to the left edge, got ${hint.left}`);
    assert.ok(hint.right <= 1001, `clamped to the right edge, got ${hint.right}`);
  } finally { await close(); }
});

test('hints and the ring can each be switched off independently', async () => {
  for (const [overrides, expect] of [
    [{ hints: { enabled: false } }, { hint: false, ring: true }],
    [{ highlight: { enabled: false } }, { hint: true, ring: false }],
  ]) {
    const { page, close } = await withOverlay(overrides);
    try {
      const present = await page.evaluate(() => ({
        hint: !!document.querySelector('[data-tut-hint]'),
        ring: !!document.querySelector('[data-tut-ring]'),
      }));
      assert.deepStrictEqual(present, expect, JSON.stringify(overrides));
    } finally { await close(); }
  }
});

// The pointer snapping back to the middle of the screen on every page load is
// the most obvious tell that a walkthrough is automated.
test('the cursor keeps its position across a navigation', async () => {
  const theme = deepMerge(DEFAULTS, {});
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await ctx.addInitScript(buildOverlayScript(theme));
  const page = await ctx.newPage();
  try {
    await page.goto(server.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__tutOverlayReady === true);
    await page.evaluate(() => window.__tutMoveCursor(742, 431, 0));

    await page.goto(`${server.url}/index.html?second`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__tutOverlayReady === true);
    const after = await page.evaluate(() => {
      const r = document.querySelector('[data-tut-cursor]').getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top) };
    });
    // Position is the hotspot-adjusted corner, so compare against the same maths.
    const size = theme.cursor.size;
    assert.strictEqual(after.left, Math.round(742 - size * theme.cursor.hotspot[0]));
    assert.strictEqual(after.top, Math.round(431 - size * theme.cursor.hotspot[1]));
  } finally { await ctx.close(); }
});

test('the overlay survives being injected before the document exists', async () => {
  // addInitScript runs before document.body. If the script touched it
  // unconditionally it would throw here and the overlay would never appear.
  const theme = deepMerge(DEFAULTS, {});
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const errors = [];
  await ctx.addInitScript(buildOverlayScript(theme));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__tutOverlayReady === true);
    assert.deepStrictEqual(errors, []);
    assert.ok(await page.evaluate(() => !!document.getElementById('__tut_overlay_root')));
  } finally { await ctx.close(); }
});

test('the hint font is inlined so no request can fail mid-recording', () => {
  const theme = loadTheme(path.join(REPO, 'theme.json'));
  theme.hints.font = 'body';
  const script = buildOverlayScript(theme);
  assert.ok(script.includes('@font-face'), 'the face should be in the script');
  assert.ok(script.includes('data:font/ttf;base64,'), 'and the file inlined with it');
});
