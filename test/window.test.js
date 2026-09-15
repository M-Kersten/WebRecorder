'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../src/ui');
const { launch } = require('../src/browser');

const REPO = path.join(__dirname, '..');

/**
 * The window itself, in a real browser.
 *
 * Everything here runs under Playwright, which is also how a person gets the
 * window: `openWindow` drives a chromeless Chromium through it. That detail is
 * the reason this file exists. Playwright dismisses every dialog when nothing
 * has registered a handler, so a native prompt() never appears and always
 * answers null. A button built on one does nothing at all, silently.
 */

let browser;
test.before(async () => { browser = await launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

const FLOW = {
  name: 'Q Portal walkthrough',
  baseUrl: 'https://portal.example.com',
  minStepMs: 1400,
  stepPaddingMs: 600,
  steps: [
    { action: 'goto', url: '/dashboard', narration: 'This is your portal.' },
    { action: 'hover', selector: '#tile-hours', label: 'Monthly hours' },
  ],
};

/** Open the window against a project that already has a walkthrough in it. */
async function withWindow(fn, flow = FLOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-window-'));
  for (const f of ['theme.json', 'theme-rebels.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  fs.cpSync(path.join(REPO, 'fonts'), path.join(dir, 'fonts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'assets'), path.join(dir, 'assets'), { recursive: true });
  if (flow) fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(flow, null, 2));

  const app = createApp({ projectDir: dir });
  const url = await app.listen();
  const page = await browser.newPage({ viewport: { width: 1240, height: 900 } });
  const dialogs = [];
  const errors = [];
  page.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });
  page.on('pageerror', (err) => errors.push(err.message));

  try {
    // Fail fast: a window that never paints should not hold the suite for
    // half a minute per assertion.
    page.setDefaultTimeout(10000);
    await page.goto(url, { waitUntil: 'networkidle' });
    await settled(page);
    return await fn({ page, dir, dialogs, errors, app });
  } finally {
    await page.close().catch(() => {});
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const visible = (page, id) => page.$eval(id, (el) => !el.hidden);

/**
 * Wait for the board to decide what it is showing.
 *
 * Not `waitForSelector('#board, #card-start')`: that resolves to whichever
 * comes first in the document and then waits for *that* one, which is the
 * wrong half of the question.
 */
const settled = (page) => page.waitForFunction(() => {
  const board = document.getElementById('board');
  const start = document.getElementById('card-start');
  return !!board && !!start && (!board.hidden || !start.hidden);
});

test('Record again asks for the address in the page, not in a dialog', async () => {
  await withWindow(async ({ page, dialogs }) => {
    assert.strictEqual(await visible(page, '#board'), true, 'the board opens on the saved flow');

    await page.click('#rerecord');
    await page.waitForSelector('#card-start', { state: 'visible' });

    assert.deepStrictEqual(dialogs, [], 'a native dialog here would never reach the person');
    assert.strictEqual(await visible(page, '#board'), false);
    assert.strictEqual(await page.inputValue('#url'), 'https://portal.example.com/dashboard',
      'prefilled with where the walkthrough starts, ready to be typed over');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'url');
    assert.strictEqual(await visible(page, '#start-warning'), true,
      'recording again costs the narration already written');
  });
});

test('changing your mind about recording again puts the board back', async () => {
  await withWindow(async ({ page, dir }) => {
    const before = fs.readFileSync(path.join(dir, 'flow.json'), 'utf8');
    await page.click('#rerecord');
    await page.waitForSelector('#card-start', { state: 'visible' });
    await page.fill('#url', 'https://somewhere.else');
    await page.click('#start-cancel');

    await page.waitForSelector('#board', { state: 'visible' });
    assert.strictEqual(await visible(page, '#card-start'), false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'), before);
  });
});

// A window that has to be reopened to see a change is a window people stop
// trusting. Everything below is repainted from the same state.
test('writing a line updates the step, the strip and the running time', async () => {
  await withWindow(async ({ page, dir, errors }) => {
    const lengthBefore = await page.textContent('#total-time');

    await page.click('.frame[data-i="1"]');
    assert.strictEqual(await page.textContent('#ed-title'), 'Step 2');
    assert.match(await page.textContent('#ed-pill'), /Nothing said yet/);

    await page.fill('#ed-narration', 'Your hours for this month are top left, with how far through you are.');
    await page.click('#ed-hint');                       // blur saves at once
    await page.waitForFunction(() => /Written/.test(document.getElementById('ed-pill').textContent));

    assert.match(await page.textContent('#strip-note'), /Every step has something to say/);
    assert.notStrictEqual(await page.textContent('#total-time'), lengthBefore,
      'a longer line makes a longer video, and the board says so');

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'));
    assert.match(saved.steps[1].narration, /^Your hours for this month/);
    assert.deepStrictEqual(errors, []);
  });
});

test('the storyboard keeps its shape at phone width', async () => {
  await withWindow(async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 900 });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `the page should not scroll sideways (${overflow}px over)`);
  });
});

// --- the settings pages -------------------------------------------------

const railNames = (page, id) => page.$$eval('#' + id + ' button', (b) => b.map((x) => x.textContent));

test('Styles and Settings are two pages, each with its own sections', async () => {
  await withWindow(async ({ page, errors }) => {
    await page.click('#tab-btn-styles');
    await page.waitForSelector('#tab-styles', { state: 'visible' });
    const styleSections = await railNames(page, 'styles-rail');
    assert.ok(styleSections.includes('Colours'), 'everything visual lives here');
    assert.ok(styleSections.includes('Opening card'));
    assert.ok(styleSections.includes('Frame'));
    assert.ok(!styleSections.includes('Passwords'));

    await page.click('#tab-btn-settings');
    await page.waitForSelector('#tab-settings', { state: 'visible' });
    assert.deepStrictEqual(await railNames(page, 'settings-rail'),
      ['Narration', 'Pacing', 'The site', 'Passwords']);
    assert.deepStrictEqual(errors, []);
  });
});

// Every control in the same track, so the eye can run down the edge of them.
test('the controls all line up in one column', async () => {
  await withWindow(async ({ page }) => {
    await page.click('#tab-btn-styles');
    await page.waitForSelector('#tab-styles', { state: 'visible' });
    await page.click('#styles-rail button[data-section="Colours"]');

    const lefts = await page.$$eval('#styles-body .pane:not([hidden]) .ctl',
      (els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    assert.ok(lefts.length > 3, 'there should be several rows to compare');
    assert.strictEqual(new Set(lefts).size, 1, `controls wandered: ${[...new Set(lefts)].join(', ')}`);
  });
});

// Switching section must not throw away a half-typed value in another one.
test('an edit survives a look at another section', async () => {
  await withWindow(async ({ page }) => {
    await page.click('#tab-btn-styles');
    await page.waitForSelector('#tab-styles', { state: 'visible' });
    await page.click('#styles-rail button[data-section="Colours"]');
    await page.fill('#set-theme-highlight-color', '#ABCDEF');

    await page.click('#styles-rail button[data-section="Frame"]');
    await page.click('#styles-rail button[data-section="Colours"]');
    assert.strictEqual(await page.inputValue('#set-theme-highlight-color'), '#ABCDEF');
  });
});

test('choosing a style on the storyboard is what the Styles tab edits', async () => {
  await withWindow(async ({ page, dir }) => {
    await page.selectOption('#theme', 'theme-rebels.json');
    await page.waitForFunction(() =>
      /Q Portal/.test(document.getElementById('theme-detail').textContent));

    await page.click('#tab-btn-styles');
    await page.waitForSelector('#tab-styles', { state: 'visible' });
    assert.strictEqual(await page.inputValue('#style-file'), 'theme-rebels.json');
    assert.strictEqual(await page.$eval('#style-inuse', (e) => !e.hidden), true);

    await page.click('#styles-rail button[data-section="Opening card"]');
    assert.strictEqual(await page.inputValue('#set-theme-intro-title'), 'Q Portal',
      'the values on screen are that style’s own');

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.strictEqual(written.style, 'theme-rebels.json');
  });
});

// A font is chosen by looking at it, and a native select cannot promise that
// across platforms, so the list is one of our own.
test('the font list shows every option set in its own face', async () => {
  await withWindow(async ({ page, errors }) => {
    await page.click('#tab-btn-styles');
    await page.waitForSelector('#tab-styles', { state: 'visible' });
    await page.click('#styles-rail button[data-section="Type"]');
    await page.click('.fontpick .fp-btn');
    await page.waitForSelector('.fp-list:not([hidden])');

    const options = await page.$$eval('.fp-list:not([hidden]) [role=option]', (els) =>
      els.map((el) => ({ value: el.dataset.value, family: getComputedStyle(el).fontFamily })));

    assert.ok(options.length > 20, 'the whole folder should be on offer');
    const fraunces = options.find((o) => o.value === 'fraunces-bold');
    assert.ok(fraunces, 'a font nothing declared is still there');
    assert.match(fraunces.family, /Fraunces/, 'and it is drawn in itself');
    assert.ok(options.every((o) => !o.value || /^["']?[A-Z]/.test(o.family)),
      'every option carries a face of its own');

    // The faces are real, not a fallback: they come from the project's folder.
    const loaded = await page.evaluate(() =>
      [...document.fonts].map((f) => f.family).includes('Fraunces'));
    assert.ok(loaded, 'the face should be loaded into the page');
    assert.deepStrictEqual(errors, []);
  });
});

test('picking a font sets it, closes the list, and saves', async () => {
  await withWindow(async ({ page, dir }) => {
    await page.click('#tab-btn-styles');
    await page.waitForSelector('#tab-styles', { state: 'visible' });
    await page.click('#styles-rail button[data-section="Type"]');

    await page.click('.fontpick .fp-btn');
    await page.click('.fp-list:not([hidden]) [data-value="space-grotesk-bold"]');
    assert.strictEqual(await page.$eval('.fp-list', (e) => e.hidden), true);
    assert.strictEqual(await page.textContent('.fontpick .fp-name'), 'Space Grotesk Bold');

    await page.click('#styles-save');
    await page.waitForFunction(() => !document.getElementById('styles-saved').hidden);

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.strictEqual(written.styles['theme.json'].hints.font, 'space-grotesk-bold');
  });
});

/**
 * The check, driven from the window against a real site.
 *
 * A walkthrough is recorded once and re-rendered for months while the site
 * underneath keeps moving, so the question this answers - does step 4 still
 * work - is the one people ask most often and the most expensive one to answer
 * by rendering.
 */
test('checking the steps marks the one that broke, on the step itself', async () => {
  const { serveStatic } = require('../src/server');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-site-'));
  fs.writeFileSync(path.join(site, 'index.html'),
    '<!doctype html><body><button id="open">Open</button></body>');
  const server = await serveStatic(site);

  try {
    await withWindow(async ({ page }) => {
      await page.waitForSelector('#board', { state: 'visible' });
      assert.strictEqual(await page.textContent('#check-pill'), 'Not checked');

      await page.click('#check');
      await page.waitForFunction(
        () => document.getElementById('check-pill').textContent !== 'Not checked',
        null, { timeout: 60000 }
      );

      assert.strictEqual(await page.textContent('#check-pill'), 'Something broke');
      const rows = await page.$$eval('.check-row', (els) => els.map((e) => e.textContent));
      assert.strictEqual(rows.length, 3, 'one row per step, including the ones not tried');
      assert.match(rows[1], /#gone/, 'the step that broke names what it was looking for');
      assert.match(rows[2], /not tried/);

      // And on the filmstrip, which is where people are actually looking.
      const marks = await page.$$eval('.frame',
        (els) => els.map((e) => e.className.replace('frame', '').trim()));
      assert.ok(marks[1].includes('broke'), `step 2 reads as ${marks[1]}`);
      assert.ok(marks[2].includes('untried'), `step 3 reads as ${marks[2]}`);
    }, {
      name: 'Check me',
      baseUrl: server.url,
      steps: [
        { action: 'goto', url: server.url, narration: 'Here it is.' },
        { action: 'click', selector: '#gone', timeoutMs: 1200 },
        { action: 'click', selector: '#open' },
      ],
    });
  } finally {
    await server.close();
    fs.rmSync(site, { recursive: true, force: true });
  }
});

test('a check that passes says so, and leaves nothing marked', async () => {
  const { serveStatic } = require('../src/server');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-site-ok-'));
  fs.writeFileSync(path.join(site, 'index.html'),
    '<!doctype html><body><button id="open" ' +
    'onclick="document.getElementById(\'p\').hidden=false">Open</button>' +
    '<div id="p" hidden>Panel</div></body>');
  const server = await serveStatic(site);

  try {
    await withWindow(async ({ page, errors }) => {
      await page.waitForSelector('#board', { state: 'visible' });
      await page.click('#check');
      await page.waitForFunction(
        () => document.getElementById('check-pill').textContent !== 'Not checked',
        null, { timeout: 60000 }
      );

      assert.strictEqual(await page.textContent('#check-pill'), 'Every step works');
      const marks = await page.$$eval('.frame', (els) => els.map((e) => e.className));
      assert.ok(marks.every((m) => !/broke|untried/.test(m)), marks.join(' | '));
      assert.deepStrictEqual(errors, []);
    }, {
      name: 'Fine',
      baseUrl: server.url,
      steps: [
        { action: 'goto', url: server.url },
        { action: 'click', selector: '#open' },
        { action: 'waitFor', selector: '#p' },
      ],
    });
  } finally {
    await server.close();
    fs.rmSync(site, { recursive: true, force: true });
  }
});
