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

/* ---------------------------------------------------------------------- *
 * Typing into a field that already says something.
 *
 * `text` is what the field should read afterwards, because that is what the
 * capture panel writes down: it listens for `change` and records the value the
 * field ended up with, never the keys that got it there. So replaying has to
 * produce that value, not add to whatever is in the box.
 * ---------------------------------------------------------------------- */

const FORM = '<!doctype html><body style="margin:0;font:15px system-ui">' +
  '<input id="hours" value="8">' +
  '<input id="blank" value="">' +
  '<input id="num" type="number" value="8">' +
  '<textarea id="note">old note</textarea>' +
  '<div id="rich" contenteditable>8</div>' +
  '<select id="day"><option>Monday</option><option>Tuesday</option></select>' +
  '<select id="project"><option value="1">Alpha</option><option value="2">Beta</option></select>' +
  '<input id="agree" type="checkbox">' +
  '</body>';

async function withForm() {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(FORM)}`, { waitUntil: 'load' });
  const theme = deepMerge(DEFAULTS, { cursor: { moveMs: 0 }, highlight: { fadeMs: 0 } });
  const type = (step) => runStep(page, { action: 'type', ...step }, FLOW, theme, { overlay: false });
  const value = (id) => page.locator(`#${id}`).evaluate(
    (el) => (el.isContentEditable ? el.innerText : (el.type === 'checkbox' ? String(el.checked) : el.value))
  );
  return { page, type, value, close: () => ctx.close() };
}

// The bug this exists for: a timesheet box reading "8", typed into with "7.5",
// came out "87.5". Which is the wrong number, and not what the person recording
// it did.
test('typing replaces what is in the field rather than adding to it', async () => {
  const { type, value, close } = await withForm();
  try {
    await type({ selector: '#hours', text: '7.5' });
    assert.strictEqual(await value('hours'), '7.5');

    // And every other shape of text field, because a form has all of them.
    await type({ selector: '#num', text: '7.5' });
    assert.strictEqual(await value('num'), '7.5');
    await type({ selector: '#note', text: 'new note' });
    assert.strictEqual(await value('note'), 'new note');
    await type({ selector: '#rich', text: '7.5' });
    assert.strictEqual(await value('rich'), '7.5');

    // An empty field has nothing to clear, and still ends up right.
    await type({ selector: '#blank', text: '7.5' });
    assert.strictEqual(await value('blank'), '7.5');
  } finally { await close(); }
});

test('an empty text empties the field, which is a step and not a mistake', async () => {
  const { type, value, close } = await withForm();
  try {
    await type({ selector: '#hours', text: '' });
    assert.strictEqual(await value('hours'), '');
    await type({ selector: '#note', text: '' });
    assert.strictEqual(await value('note'), '');
  } finally { await close(); }
});

test('clear: false adds to what is there, for a box you are adding to', async () => {
  const { type, value, close } = await withForm();
  try {
    await type({ selector: '#note', text: ' and more', clear: false });
    assert.strictEqual(await value('note'), 'old note and more');
  } finally { await close(); }
});

// A dropdown is recorded as a "type" step, because change is the event the
// browser fires. Clicking one opens a popup Chromium draws outside the page:
// the keystrokes went into that instead of the page, and picked whatever
// option the first letter happened to land on.
test('a dropdown is picked rather than typed into', async () => {
  const { type, value, close } = await withForm();
  try {
    await type({ selector: '#day', text: 'Tuesday' });
    assert.strictEqual(await value('day'), 'Tuesday');

    // Capture writes down el.value, which is the option's value when it has
    // one and its text when it does not. Both spellings are in flows already.
    await type({ selector: '#project', text: '2' });
    assert.strictEqual(await value('project'), '2');
    await type({ selector: '#project', text: 'Alpha' });
    assert.strictEqual(await value('project'), '1');
  } finally { await close(); }
});

// A click on a tickbox is a toggle, so replaying one onto a box that already
// starts the way the recording left it produces the opposite of the recording.
test('a tickbox is set to the state that was recorded, not toggled', async () => {
  const { page, type, value, close } = await withForm();
  try {
    await type({ selector: '#agree', text: 'checked' });
    assert.strictEqual(await value('agree'), 'true');
    // Again. A toggle would turn it back off; setting it leaves it alone.
    await type({ selector: '#agree', text: 'checked' });
    assert.strictEqual(await value('agree'), 'true');

    await type({ selector: '#agree', text: 'unchecked' });
    assert.strictEqual(await value('agree'), 'false');

    // A flow recorded before the state was written down has only a click to
    // go on, and still works the way it always did.
    await page.locator('#agree').evaluate((el) => { el.checked = false; });
    await type({ selector: '#agree', text: 'on' });
    assert.strictEqual(await value('agree'), 'true');
  } finally { await close(); }
});

test('a step says what it is about to do, including when that is clearing', () => {
  const { describeStep } = require('../src/recorder');
  assert.strictEqual(
    describeStep({ action: 'type', selector: '#hours', text: '7.5' }),
    'type "7.5" into #hours'
  );
  assert.strictEqual(
    describeStep({ action: 'type', selector: '#hours', text: '' }),
    'clear #hours'
  );
  assert.strictEqual(
    describeStep({ action: 'type', selector: '#agree', text: 'checked' }),
    'tick #agree'
  );
  assert.strictEqual(
    describeStep({ action: 'type', selector: '#agree', text: 'unchecked' }),
    'untick #agree'
  );
  assert.match(
    describeStep({ action: 'type', selector: '#note', text: 'x', clear: false }),
    /keeping what is there/
  );
  // A password is still dots, whatever else changed.
  assert.ok(!/hunter2/.test(
    describeStep({ action: 'type', selector: '#p', text: 'hunter2', secret: true })
  ));
});
