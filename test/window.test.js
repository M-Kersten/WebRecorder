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
  fs.copyFileSync(path.join(REPO, 'theme.json'), path.join(dir, 'theme.json'));
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
