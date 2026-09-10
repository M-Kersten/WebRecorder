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
  await ctx.addInitScript(() => {
    window.__samples = [];
    setInterval(() => {
      const cursor = document.querySelector('[data-tut-cursor]');
      const ring = document.querySelector('[data-tut-ring]');
      if (!cursor || !ring) return;
      window.__samples.push({
        x: Math.round(cursor.getBoundingClientRect().left),
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

    const restingX = samples[samples.length - 1].x;
    assert.strictEqual(samples[firstVisible].x, restingX,
      'the ring appeared while the cursor was still moving');

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
    assert.strictEqual(samples[firstVisible].x, samples[samples.length - 1].x);
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
