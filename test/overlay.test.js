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
async function withOverlay(overrides, body = PAGE, mask = []) {
  const theme = deepMerge(DEFAULTS, overrides);
  if (overrides && overrides.cursor && overrides.cursor.image) {
    theme.cursor.imagePath = path.resolve(REPO, overrides.cursor.image);
  }
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await ctx.addInitScript(buildOverlayScript(theme, mask));
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

// --- masking -----------------------------------------------------------
//
// A walkthrough of a logged-in product is a recording of real data. These
// checks are about that data never reaching a frame.

const PERSONAL = [
  '<!doctype html><body style="margin:0">',
  '<h1 id="greeting">Hello, Merijn Kersten</h1>',
  '<div id="avatar" style="width:40px;height:40px;background:#E6007E"></div>',
  '<span id="secret">secret@example.com</span>',
  '<table><tbody id="rows"></tbody></table>',
  // Rows arrive after load, the way a real dashboard fills a table.
  '<script>setTimeout(function(){',
  '  document.getElementById("rows").innerHTML =',
  '    "<tr><td class=client>Vandelay Industries</td></tr>";',
  '}, 300);<' + '/script></body>',
].join('');

test('a blurred selector is blurred', async () => {
  const { page, close } = await withOverlay({}, PERSONAL, [
    { selector: '#avatar', mode: 'blur', radius: 12 },
  ]);
  try {
    const filter = await page.evaluate(() =>
      getComputedStyle(document.getElementById('avatar')).filter);
    assert.match(filter, /blur\(12px\)/);
    // Only what was asked for.
    assert.strictEqual(
      await page.evaluate(() => getComputedStyle(document.getElementById('greeting')).filter),
      'none'
    );
  } finally { await close(); }
});

test('text replacement swaps the content', async () => {
  const { page, close } = await withOverlay({}, PERSONAL, [
    { selector: '#greeting', mode: 'text', text: 'Hello, Alex Doe', radius: 10 },
  ]);
  try {
    assert.strictEqual(
      await page.evaluate(() => document.getElementById('greeting').textContent),
      'Hello, Alex Doe'
    );
  } finally { await close(); }
});

test('hide keeps the space so the layout still matches the site', async () => {
  const { page, close } = await withOverlay({}, PERSONAL, [
    { selector: '#secret', mode: 'hide', radius: 10 },
  ]);
  try {
    const state = await page.evaluate(() => {
      const el = document.getElementById('secret');
      return { visibility: getComputedStyle(el).visibility, width: el.getBoundingClientRect().width };
    });
    assert.strictEqual(state.visibility, 'hidden');
    assert.ok(state.width > 0, 'display:none would reflow the page and the recording would not match');
  } finally { await close(); }
});

// The case that matters on a real dashboard: rows arrive from an API after the
// page has loaded, so a mask applied once at startup would miss them entirely.
test('content rendered after load is masked too', async () => {
  const { page, close } = await withOverlay({}, PERSONAL, [
    { selector: '#rows td.client', mode: 'blur', radius: 8 },
  ]);
  try {
    await page.waitForSelector('#rows td.client');
    await page.waitForTimeout(150);
    const filter = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#rows td.client')).filter);
    assert.match(filter, /blur\(8px\)/, 'a late row must be blurred as soon as it exists');
  } finally { await close(); }
});

test('text replacement survives the page rewriting the same node', async () => {
  const rewriting = [
    '<!doctype html><body><h1 id="g">Merijn Kersten</h1>',
    '<script>var n = 0; var t = setInterval(function(){',
    '  document.getElementById("g").textContent = "Merijn Kersten " + (++n);',
    '  if (n > 3) clearInterval(t);',
    '}, 60);<' + '/script></body>',
  ].join('');
  const { page, close } = await withOverlay({}, rewriting, [
    { selector: '#g', mode: 'text', text: 'Alex Doe', radius: 10 },
  ]);
  try {
    await page.waitForTimeout(600);
    assert.strictEqual(await page.evaluate(() => document.getElementById('g').textContent), 'Alex Doe');
  } finally { await close(); }
});

test('a mask rule with a broken selector does not take the overlay down with it', async () => {
  const { page, close } = await withOverlay({}, PERSONAL, [
    { selector: ':::nonsense', mode: 'text', text: 'x', radius: 10 },
    { selector: '#greeting', mode: 'text', text: 'Alex Doe', radius: 10 },
  ]);
  try {
    assert.strictEqual(
      await page.evaluate(() => document.getElementById('greeting').textContent),
      'Alex Doe',
      'the valid rule still applies'
    );
  } finally { await close(); }
});

// --- highlight radius --------------------------------------------------

test('the ring takes its corners from the element when the theme says auto', async () => {
  const cards = '<!doctype html><body style="margin:0">' +
    '<div id="round" style="position:absolute;left:100px;top:100px;width:200px;' +
    'height:120px;border-radius:26px;background:#eee"></div></body>';
  const { page, close } = await withOverlay({ highlight: { borderRadius: 'auto' } }, cards);
  try {
    const rect = await page.locator('#round').boundingBox();
    rect.radius = await page.locator('#round').evaluate((el) => getComputedStyle(el).borderRadius);
    assert.strictEqual(rect.radius, '26px');

    await page.evaluate((r) => window.__tutHighlight(r), rect);
    await page.waitForTimeout(120);
    const ring = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-tut-ring]')).borderRadius);
    // The ring sits 6px outside the element, so its corners grow to match.
    assert.strictEqual(ring, '32px');
  } finally { await close(); }
});

test('a fixed radius in the theme still wins', async () => {
  const { page, close } = await withOverlay({ highlight: { borderRadius: 4 } });
  try {
    await page.evaluate(() => window.__tutHighlight({ x: 10, y: 10, width: 100, height: 50, radius: '26px' }));
    await page.waitForTimeout(120);
    const ring = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-tut-ring]')).borderRadius);
    assert.strictEqual(ring, '4px');
  } finally { await close(); }
});

test('an element with no radius gets a square ring, not a broken one', async () => {
  const { page, close } = await withOverlay({ highlight: { borderRadius: 'auto' } });
  try {
    await page.evaluate(() => window.__tutHighlight({ x: 10, y: 10, width: 100, height: 50, radius: '0px' }));
    await page.waitForTimeout(120);
    const ring = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-tut-ring]')).borderRadius);
    assert.strictEqual(ring, '6px');
  } finally { await close(); }
});

// --- hint surface ------------------------------------------------------
//
// A slab of brand colour down the left edge is the callout pattern every
// generated dashboard reaches for. The default is a hairline instead.

test('by default a hint has an even hairline and no coloured bar', async () => {
  const { page, close } = await withOverlay({ hints: { color: '#FFFFFF' } });
  try {
    await page.evaluate(() => window.__tutShowHint('Explaining something', null));
    await settle(page);
    const style = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('[data-tut-hint]'));
      return {
        left: s.borderLeftWidth, top: s.borderTopWidth,
        right: s.borderRightWidth, bottom: s.borderBottomWidth,
        leftColour: s.borderLeftColor, topColour: s.borderTopColor,
      };
    });
    assert.strictEqual(style.left, '1px', 'no slab down one side');
    assert.deepStrictEqual(
      [style.top, style.right, style.bottom], ['1px', '1px', '1px'],
      'the hairline runs all the way round'
    );
    assert.strictEqual(style.leftColour, style.topColour, 'and it is one colour');
    // Derived from the text colour, so it works on a dark or a light surface.
    assert.match(style.topColour, /rgba\(255,\s*255,\s*255/);
  } finally { await close(); }
});

test('accent "bar" brings the coloured edge back', async () => {
  const { page, close } = await withOverlay({
    hints: { accent: 'bar', accentColor: '#E6007E', fontSize: 28 },
  });
  try {
    await page.evaluate(() => window.__tutShowHint('Explaining something', null));
    await settle(page);
    const style = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('[data-tut-hint]'));
      return { left: parseFloat(s.borderLeftWidth), colour: s.borderLeftColor, top: s.borderTopWidth };
    });
    assert.ok(style.left > 1, `expected a wider left edge, got ${style.left}px`);
    assert.strictEqual(style.colour, 'rgb(230, 0, 126)');
    assert.strictEqual(style.top, '1px', 'the other three stay hairlines');
  } finally { await close(); }
});

// A hint at 0.95 opacity without a blur lets the page's own text read straight
// through it, which looks like a rendering fault rather than a translucent card.
test('anything that can show through a hint is blurred behind it', async () => {
  const translucent = await withOverlay({ hints: { backgroundOpacity: 0.95 } });
  try {
    await translucent.page.evaluate(() => window.__tutShowHint('Text', null));
    await settle(translucent.page);
    const filter = await translucent.page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-tut-hint]')).backdropFilter);
    assert.match(filter, /blur/);
  } finally { await translucent.close(); }

  const opaque = await withOverlay({ hints: { backgroundOpacity: 1 } });
  try {
    await opaque.page.evaluate(() => window.__tutShowHint('Text', null));
    await settle(opaque.page);
    const filter = await opaque.page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-tut-hint]')).backdropFilter);
    assert.strictEqual(filter, 'none', 'nothing can show through, so nothing to blur');
  } finally { await opaque.close(); }
});

test('an explicit border colour overrides the derived one', async () => {
  const { page, close } = await withOverlay({ hints: { borderColor: '#E6007E' } });
  try {
    await page.evaluate(() => window.__tutShowHint('Text', null));
    await settle(page);
    const colour = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-tut-hint]')).borderTopColor);
    assert.strictEqual(colour, 'rgb(230, 0, 126)');
  } finally { await close(); }
});

// Captions are burned on after recording, so the overlay cannot see them. With
// both switched on, a hint and a caption landed in the same strip of screen and
// sat on top of each other.
test('a hint keeps clear of where the captions will be burned', async () => {
  const withCaptions = {
    captions: { enabled: true, position: 'bottom', marginBottom: 60, fontSize: 34 },
    hints: { position: 'auto', offset: 20 },
  };
  const { page, close } = await withOverlay(withCaptions);
  try {
    // No target, so it falls back to the bottom - straight into the captions.
    await page.evaluate(() => window.__tutShowHint('Explaining something here', null));
    await settle(page);
    const box = await page.evaluate(() =>
      document.querySelector('[data-tut-hint]').getBoundingClientRect().toJSON());
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const band = 60 + 34 * 3;
    assert.ok(box.bottom <= viewportHeight - band + 1,
      `the hint ends at ${box.bottom}, inside the caption band that starts at ${viewportHeight - band}`);
  } finally { await close(); }
});

test('with captions at the top the hint stays below them', async () => {
  const { page, close } = await withOverlay({
    captions: { enabled: true, position: 'top', marginBottom: 60, fontSize: 34 },
    hints: { position: 'top-center', offset: 20 },
  });
  try {
    await page.evaluate(() => window.__tutShowHint('Explaining something here', null));
    await settle(page);
    const box = await page.evaluate(() =>
      document.querySelector('[data-tut-hint]').getBoundingClientRect().toJSON());
    assert.ok(box.top >= 60 + 34 * 3, `the hint starts at ${box.top}, inside the caption band`);
  } finally { await close(); }
});

test('without captions the hint uses the whole frame again', async () => {
  const { page, close } = await withOverlay({
    captions: { enabled: false }, hints: { position: 'bottom-center', offset: 20 },
  });
  try {
    await page.evaluate(() => window.__tutShowHint('Explaining something here', null));
    await settle(page);
    const box = await page.evaluate(() =>
      document.querySelector('[data-tut-hint]').getBoundingClientRect().toJSON());
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    assert.ok(box.bottom > viewportHeight - 60, 'it should sit near the bottom edge');
  } finally { await close(); }
});

// --- highlight timing --------------------------------------------------
//
// The ring used to have CSS transitions on left/top/width/height, so it
// travelled across the page from the last element to this one. It read as a
// thing that moves rather than a marker on what is being pointed at.

test('the ring snaps to its target instead of travelling', async () => {
  const two = '<!doctype html><body style="margin:0">' +
    '<div id="a" style="position:absolute;left:40px;top:40px;width:120px;height:60px"></div>' +
    '<div id="b" style="position:absolute;left:700px;top:500px;width:200px;height:80px"></div>' +
    '</body>';
  const { page, close } = await withOverlay({ highlight: { fadeMs: 200 } }, two);
  try {
    const at = async (selector) => {
      const rect = await page.locator(selector).boundingBox();
      await page.evaluate((r) => window.__tutHighlight(r), rect);
      return rect;
    };
    await at('#a');
    await page.waitForTimeout(300);

    // Move it far away and sample immediately: a transition would still have
    // it somewhere between the two.
    const target = await at('#b');
    const landed = await page.evaluate(() =>
      document.querySelector('[data-tut-ring]').getBoundingClientRect().toJSON());

    assert.ok(Math.abs(landed.left - (target.x - 6)) < 2,
      `expected it at ${target.x - 6}, found it at ${landed.left}`);
    assert.ok(Math.abs(landed.top - (target.y - 6)) < 2,
      `expected it at ${target.y - 6}, found it at ${landed.top}`);
  } finally { await close(); }
});

test('only opacity is animated, so nothing about the ring can slide', async () => {
  const { page, close } = await withOverlay({ highlight: { fadeMs: 240 } });
  try {
    await page.evaluate(() => window.__tutHighlight({ x: 10, y: 10, width: 80, height: 40 }));
    await page.waitForTimeout(50);
    const transition = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-tut-ring]')).transition);
    assert.match(transition, /opacity/);
    assert.ok(!/\b(left|top|width|height)\b/.test(transition),
      `geometry must not be transitioned: ${transition}`);
  } finally { await close(); }
});

test('the ring fades in rather than appearing at full strength', async () => {
  const { page, close } = await withOverlay({ highlight: { fadeMs: 400 } });
  try {
    const during = await page.evaluate(async () => {
      window.__tutClearHighlight();
      await new Promise((r) => setTimeout(r, 250));
      window.__tutHighlight({ x: 10, y: 10, width: 80, height: 40 });
      await new Promise((r) => setTimeout(r, 120));
      return Number(getComputedStyle(document.querySelector('[data-tut-ring]')).opacity);
    });
    assert.ok(during > 0 && during < 1, `expected a partial fade, saw ${during}`);
  } finally { await close(); }
});
