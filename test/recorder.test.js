'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { runStep } = require('../src/recorder');
const { buildOverlayScript } = require('../src/overlay');
const { launch } = require('../src/browser');
const { deepMerge, DEFAULTS } = require('../src/theme');

const PAGE = '<!doctype html><body style="margin:0;background:#eee">' +
  '<button id="near" style="position:absolute;left:30px;top:30px;width:120px;height:44px">Near</button>' +
  '<button id="far" style="position:absolute;left:760px;top:520px;width:180px;height:60px">Far</button>' +
  '<input id="box" style="position:absolute;left:400px;top:300px;width:200px;height:36px">' +
  '</body>';

let browser;
test.before(async () => { browser = await launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

async function withPage(overrides = {}) {
  const theme = deepMerge(DEFAULTS, overrides);
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await ctx.addInitScript(buildOverlayScript(theme, []));
  // Sample the cursor position and the ring's opacity together, so the two can
  // be compared on one timeline.
  //
  // The position comes from the inline transform, not from the bounding box.
  // The click pulse scales the cursor through the animation API, which leaves
  // the inline style alone but does move the box, so a sample taken during the
  // pulse would read as the pointer having jumped when it has not.
  await ctx.addInitScript(() => {
    window.__samples = [];
    setInterval(() => {
      const cursor = document.querySelector('[data-tut-cursor]');
      const ring = document.querySelector('[data-tut-ring]');
      if (!cursor || !ring) return;
      const match = /translate3d\(([-\d.]+)px/.exec(cursor.style.transform || '');
      if (!match) return;
      window.__samples.push({
        x: Math.round(Number(match[1])),
        opacity: Number(getComputedStyle(ring).opacity),
      });
    }, 16);
  });
  const page = await ctx.newPage();
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__tutOverlayReady === true);
  return { page, theme, close: () => ctx.close() };
}

const FLOW = { baseUrl: null, typeDelayMs: 5, steps: [] };

/** Where the cursor will have translated to once it has arrived. */
async function restingX(page, selector, theme) {
  const box = await page.locator(selector).boundingBox();
  return Math.round(box.x + box.width / 2 - theme.cursor.size * theme.cursor.hotspot[0]);
}

// The ring appearing first tells the viewer where to look before the pointer
// gets there, and the eye goes to the ring instead of following the movement
// that is supposed to be carrying the explanation.
test('the ring stays hidden until the cursor has finished travelling', async () => {
  const { page, theme, close } = await withPage({ cursor: { moveMs: 600 } });
  try {
    await page.evaluate(() => window.__tutMoveCursor(30, 30, 0));
    await page.evaluate(() => { window.__samples = []; });

    await runStep(page, { action: 'hover', selector: '#far' }, FLOW, theme);
    await page.waitForTimeout(120);

    const samples = await page.evaluate(() => window.__samples);
    assert.ok(samples.length > 8, `expected a run of samples, got ${samples.length}`);

    const moved = new Set(samples.map((s) => s.x)).size;
    assert.ok(moved > 3, 'the cursor should have been seen travelling');

    const firstVisible = samples.findIndex((s) => s.opacity > 0);
    assert.notStrictEqual(firstVisible, -1, 'the ring should have appeared');

    const arrived = await restingX(page, '#far', theme);
    assert.strictEqual(samples[firstVisible].x, arrived,
      'the ring appeared while the cursor was still on its way');

    // And nothing before that frame showed the ring at all.
    assert.ok(samples.slice(0, firstVisible).every((s) => s.opacity === 0));
  } finally { await close(); }
});

test('a click marks its target the same way round', async () => {
  const { page, theme, close } = await withPage({ cursor: { moveMs: 400 } });
  try {
    await page.evaluate(() => window.__tutMoveCursor(30, 30, 0));
    await page.evaluate(() => { window.__samples = []; });

    await runStep(page, { action: 'click', selector: '#far' }, FLOW, theme);
    const samples = await page.evaluate(() => window.__samples);
    const firstVisible = samples.findIndex((s) => s.opacity > 0);
    assert.notStrictEqual(firstVisible, -1);
    assert.strictEqual(samples[firstVisible].x, await restingX(page, '#far', theme),
      'the ring appeared while the cursor was still on its way');
  } finally { await close(); }
});

test('typing speed comes from the flow when a step does not say', async () => {
  const { page, theme, close } = await withPage({ cursor: { moveMs: 0 } });
  try {
    const slow = Date.now();
    await runStep(page, { action: 'type', selector: '#box', text: 'abcdefgh' },
      { ...FLOW, typeDelayMs: 40 }, theme);
    const slowMs = Date.now() - slow;
    assert.strictEqual(await page.inputValue('#box'), 'abcdefgh');

    await page.fill('#box', '');
    const fast = Date.now();
    await runStep(page, { action: 'type', selector: '#box', text: 'abcdefgh' },
      { ...FLOW, typeDelayMs: 0 }, theme);
    const fastMs = Date.now() - fast;

    assert.ok(slowMs > fastMs + 100, `40ms a key should be slower: ${slowMs} vs ${fastMs}`);
  } finally { await close(); }
});

test('a step can still set its own typing speed', async () => {
  const { page, theme, close } = await withPage({ cursor: { moveMs: 0 } });
  try {
    const started = Date.now();
    await runStep(page, { action: 'type', selector: '#box', text: 'abcdef', delayMs: 0 },
      { ...FLOW, typeDelayMs: 200 }, theme);
    assert.ok(Date.now() - started < 900, 'the step overrides the flow default');
  } finally { await close(); }
});

test('with the highlight off nothing is drawn at all', async () => {
  const { page, theme, close } = await withPage({
    highlight: { enabled: false }, cursor: { moveMs: 0 },
  });
  try {
    await runStep(page, { action: 'hover', selector: '#far' }, FLOW, theme);
    assert.strictEqual(await page.evaluate(() => !!document.querySelector('[data-tut-ring]')), false);
  } finally { await close(); }
});

// --- when a line starts -------------------------------------------------

const fs = require('fs');
const os = require('os');
const { record } = require('../src/recorder');
const { loadTheme } = require('../src/theme');

const REPO = path.join(__dirname, '..');

// A page that answers slowly, the way a real one does.
function slowSite(delayMs) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><body style="background:#fff"><h1 id="t">Here</h1></body>');
    }, delayMs);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

// The narration for a step is placed at the timestamp the recorder logged. A
// goto used to be stamped the moment the address changed, so the voice
// described a page that was still blank and everything after it sat a page
// load early.
//
// The timestamps now come back in the delivered file's own seconds rather than
// the recorder's, because the waiting is cut off the front and everything
// shifts with it. So the load shows up as the size of the cut, and the first
// step lands on the lead-in. That the two agree once the file exists is
// measured on a finished render in sync.test.js.
test('a line for a page starts once the page is there', async () => {
  const site = await slowSite(900);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-timing-'));
  try {
    const theme = loadTheme(path.join(REPO, 'theme.json'));
    theme.video = { ...theme.video, width: 640, height: 480, fps: 15 };
    const flow = {
      baseUrl: site.url,
      minStepMs: 200, stepPaddingMs: 100, typeDelayMs: 10, settleMs: 400,
      steps: [{ action: 'goto', url: '/' }, { action: 'hover', selector: '#t' }],
      mask: [],
    };

    const { timeline, totalSec, trimSec } = await record(flow, theme, [null, null],
      { outDir: dir, headless: true });

    // The line starts on the lead-in: 0.9s of loading plus the settle beat is
    // no longer in front of it.
    assert.ok(timeline[0].startSec <= 0.45,
      `the first line is at ${timeline[0].startSec.toFixed(2)}s, behind a hold of nothing`);
    // The step that follows is timed from when it began, as it always was.
    assert.ok(timeline[1].startSec >= timeline[0].startSec);
    // And what is left is the walkthrough itself, whatever the cut turned out
    // to be. How much there was to cut varies by more than a second between
    // runs, because Playwright does not always start capturing at the same
    // point - which is the whole reason the cut is measured off the picture
    // rather than worked out from the clock.
    assert.ok(trimSec >= 0, 'the cut is never negative');
    assert.ok(totalSec > 1.5 && totalSec < 4,
      `${totalSec.toFixed(2)}s left after the cut, which is not the walkthrough`);
  } finally {
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
