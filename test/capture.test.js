'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { capture, toFlow, normalise } = require('../src/capture');
const { serveStatic } = require('../src/server');
const { loadFlow } = require('../src/config');
const { resolveFlowSecrets } = require('../src/secrets');

const REPO = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-capture-'));

let server;
test.before(async () => { server = await serveStatic(path.join(REPO, 'demo', 'portal'), 8233); });
test.after(async () => {
  if (server) await server.close();
  fs.rmSync(work, { recursive: true, force: true });
});

/** Run a capture session, driving the page with `drive`, and return the flow. */
async function captureWith(drive, startPath = '/dashboard.html?auth=1') {
  const outFile = path.join(work, `flow-${Math.random().toString(36).slice(2)}.json`);
  const result = await capture({
    url: `${server.url}${startPath}`,
    outFile,
    headless: true,
    onReady: async (page, ctl) => {
      // Fail fast: a selector that never matches should not stall the suite.
      page.setDefaultTimeout(8000);
      await page.waitForFunction(() => window.__tutPanelLoaded === true);
      await drive(page, ctl);
      ctl.finish();
    },
  });
  return { ...result, outFile };
}

test('the first step is always getting to the page', async () => {
  const { flow } = await captureWith(async () => {});
  assert.strictEqual(flow.steps[0].action, 'goto');
  assert.strictEqual(flow.steps[0].url, '/dashboard.html?auth=1');
  assert.strictEqual(flow.baseUrl, server.url);
});

test('clicking something records a step with a usable selector', async () => {
  const { flow } = await captureWith(async (page) => {
    await page.click('#tile-hours');
    await page.waitForTimeout(120);
  });
  const step = flow.steps[1];
  assert.strictEqual(step.action, 'click');
  assert.strictEqual(step.selector, '#tile-hours', 'an author-written id is the best thing to use');
});

test('the recorded selector actually finds the element it was recorded from', async () => {
  const { flow } = await captureWith(async (page) => {
    // A nested element with no id of its own: the selector has to be derived.
    await page.click('#tile-docs .label');
    await page.waitForTimeout(120);
  });
  const step = flow.steps[1];
  assert.ok(step.selector, 'a selector was produced');

  // The real test of a selector is whether it resolves, uniquely, on the page.
  const { launch } = require('../src/browser');
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/dashboard.html?auth=1`, { waitUntil: 'load' });
    const count = await page.locator(step.selector).count();
    assert.strictEqual(count, 1, `"${step.selector}" should match exactly one element, matched ${count}`);
  } finally { await browser.close(); }
});

test('typing is recorded with what was typed', async () => {
  const { flow } = await captureWith(async (page) => {
    await page.fill('#email', 'someone@example.com');
    await page.locator('#email').blur();
    await page.waitForTimeout(150);
  }, '/index.html');
  const step = flow.steps.find((s) => s.action === 'type');
  assert.ok(step, 'a type step was recorded');
  assert.strictEqual(step.selector, '#email');
  assert.strictEqual(step.text, 'someone@example.com');
});

// Capture watches everything you type. A password field is the one thing that
// must never be written into a file that gets committed.
test('a password is never written into the flow', async () => {
  const { flow } = await captureWith(async (page) => {
    await page.fill('#pw', 'hunter2');
    await page.locator('#pw').blur();
    await page.waitForTimeout(150);
  }, '/index.html');

  const written = JSON.stringify(flow);
  assert.ok(!written.includes('hunter2'), `the password reached the flow: ${written}`);
  const step = flow.steps.find((s) => s.selector === '#pw');
  assert.strictEqual(step.text, '${PASSWORD}', 'and a placeholder is left in its place');
});

test('the captured flow is a valid flow file', async () => {
  const { outFile } = await captureWith(async (page) => {
    await page.click('#tile-hours');
    await page.click('#tile-profile');
    await page.waitForTimeout(150);
  });
  assert.ok(fs.existsSync(outFile), 'it was written to disk');
  const flow = loadFlow(outFile);
  assert.ok(flow.steps.length >= 3);
  assert.doesNotThrow(() => resolveFlowSecrets(flow, {}));
});

test('a captured password placeholder resolves from the environment', async () => {
  const { outFile } = await captureWith(async (page) => {
    await page.fill('#pw', 'hunter2');
    await page.locator('#pw').blur();
    await page.waitForTimeout(150);
  }, '/index.html');

  const flow = loadFlow(outFile);
  assert.throws(() => resolveFlowSecrets(flow, {}), /PASSWORD/, 'unset, it says so');
  resolveFlowSecrets(flow, { PASSWORD: 'from-the-env' });
  assert.ok(flow.steps.some((s) => s.text === 'from-the-env'));
});

test('the panel itself is never recorded as a step', async () => {
  const { flow } = await captureWith(async (page) => {
    await page.click('#__tut_capture_panel #__tut_pause');
    await page.waitForTimeout(120);
    await page.click('#__tut_capture_panel #__tut_pause');
    await page.waitForTimeout(120);
  });
  assert.strictEqual(flow.steps.length, 1, 'only the opening goto');
});

test('pausing stops recording, resuming starts it again', async () => {
  const { flow } = await captureWith(async (page) => {
    await page.click('#__tut_capture_panel #__tut_pause');
    await page.waitForTimeout(100);
    await page.click('#tile-hours');           // ignored
    await page.waitForTimeout(100);
    await page.click('#__tut_capture_panel #__tut_pause');
    await page.waitForTimeout(100);
    await page.click('#tile-profile');         // recorded
    await page.waitForTimeout(150);
  });
  const clicks = flow.steps.filter((s) => s.action === 'click');
  assert.strictEqual(clicks.length, 1);
  assert.strictEqual(clicks[0].selector, '#tile-profile');
});

test('the step list survives a navigation', async () => {
  const { flow } = await captureWith(async (page) => {
    await page.click('#tile-hours');
    await page.waitForTimeout(120);
    await page.goto(`${server.url}/dashboard.html?auth=1&second`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__tutPanelLoaded === true);
    await page.click('#tile-profile');
    await page.waitForTimeout(150);
    // The panel reads the list back from Node, so both clicks are still there.
    const shown = await page.evaluate(() =>
      document.getElementById('__tut_capture_panel').shadowRoot
        .querySelectorAll('#__tut_list .step').length);
    assert.strictEqual(shown, 3, `the panel should still list every step, showed ${shown}`);
  });
  assert.strictEqual(flow.steps.length, 3);
});

test('urls are made relative to the site, so a flow moves between environments', () => {
  const flow = toFlow([
    normalise({ action: 'goto', url: 'https://app.test/a/b' }),
    normalise({ action: 'goto', url: 'https://elsewhere.test/x' }),
  ], 'https://app.test/a/b');
  assert.strictEqual(flow.baseUrl, 'https://app.test');
  assert.strictEqual(flow.steps[0].url, '/a/b');
  assert.strictEqual(flow.steps[1].url, 'https://elsewhere.test/x', 'another site stays absolute');
});

test('empty narration and hints are left out of the file', () => {
  const flow = toFlow([
    normalise({ action: 'click', selector: '#a', narration: '', hint: '' }),
    normalise({ action: 'click', selector: '#b', narration: 'Said out loud', hint: 'Shown' }),
  ], 'https://app.test/');
  assert.deepStrictEqual(Object.keys(flow.steps[0]), ['action', 'selector']);
  assert.strictEqual(flow.steps[1].narration, 'Said out loud');
  assert.strictEqual(flow.steps[1].hint, 'Shown');
});

// The portal fixture styles bare `header { display: flex }`, which reached the
// panel and laid its title out beside its own subtitle. Any site that styles
// element selectors does this, so the panel lives in a shadow root.
test('the site cannot style the panel', async () => {
  await captureWith(async (page) => {
    const layout = await page.evaluate(() => {
      const shadow = document.getElementById('__tut_capture_panel').shadowRoot;
      const head = shadow.querySelector('.head');
      const title = shadow.querySelector('.head h2').getBoundingClientRect();
      const sub = shadow.getElementById('__tut_hint_line').getBoundingClientRect();
      return {
        headDisplay: getComputedStyle(head).display,
        titleBottom: title.bottom,
        subTop: sub.top,
        panelWidth: shadow.querySelector('.panel').getBoundingClientRect().width,
      };
    });
    assert.strictEqual(layout.headDisplay, 'block', "the site's header rule must not apply");
    assert.ok(layout.subTop >= layout.titleBottom - 1,
      `the subtitle should sit under the title, not beside it (${layout.subTop} vs ${layout.titleBottom})`);
    assert.strictEqual(layout.panelWidth, 380);
  });
});

test('a table cell with no id of its own still gets a selector that resolves', async () => {
  const { flow } = await captureWith(async (page) => {
    await page.waitForSelector('#rows td.client');
    // Deliberately the second row: the naive selector matches all four.
    await page.locator('#rows tr').nth(1).locator('td').first().click();
    await page.waitForTimeout(150);
  });
  const step = flow.steps[1];
  assert.ok(step.selector, 'a selector was produced');

  const { launch } = require('../src/browser');
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/dashboard.html?auth=1`, { waitUntil: 'load' });
    await page.waitForSelector('#rows td.client');
    const count = await page.locator(step.selector).count();
    assert.strictEqual(count, 1,
      `"${step.selector}" should match one element, matched ${count}`);
  } finally { await browser.close(); }
});

// Clicking a cell while the table still says "loading" used to produce
// "td:nth-of-type(2)": unique at that instant, and matching four rows a second
// later. A selector has to survive the page finishing loading.
test('a selector taken before the data arrives still resolves after it does', async () => {
  const { flow } = await captureWith(async (page) => {
    // No wait: the rows land 900ms in, so this clicks the loading placeholder.
    await page.locator('#reg td').first().click();
    await page.waitForTimeout(150);
  });
  const step = flow.steps[1];

  const { launch } = require('../src/browser');
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/dashboard.html?auth=1`, { waitUntil: 'load' });
    await page.waitForSelector('#rows td.client');   // fully loaded
    const count = await page.locator(step.selector).count();
    assert.strictEqual(count, 1,
      `"${step.selector}" matched ${count} elements once the table filled in`);
  } finally { await browser.close(); }
});

// --- step screenshots ---------------------------------------------------

/** Width and height out of a JPEG's start-of-frame marker. */
function jpegSize(file) {
  const buf = fs.readFileSync(file);
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    const isFrame = marker >= 0xC0 && marker <= 0xCF &&
      marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isFrame) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

test('every recorded step gets a picture, lined up by the manifest', async () => {
  const shots = require('../src/shots');
  const { flow, outFile } = await captureWith(async (page) => {
    await page.click('#tile-hours');
    await page.waitForTimeout(150);
    await page.click('#tile-profile');
    await page.waitForTimeout(150);
  });

  const manifest = shots.readManifest(outFile);
  assert.strictEqual(manifest.length, flow.steps.length, 'one entry per step, in step order');
  assert.ok(manifest.every(Boolean), 'and every step got one');
  for (const name of manifest) {
    assert.ok(shots.fileFor(outFile, name), `${name} should be on disk`);
  }
});

// Playwright can hide an element for the length of a screenshot, but that makes
// the panel blink out from under whoever is mid-click. It gets cropped instead.
test('the recording panel is cropped out of the picture, not hidden mid-session', async () => {
  const shots = require('../src/shots');
  const { outFile } = await captureWith(async (page) => {
    await page.click('#tile-hours');
    await page.waitForTimeout(200);
    // The panel is still laid out and visible after a screenshot has been taken.
    const width = await page.evaluate(() => {
      const shadow = document.getElementById('__tut_capture_panel').shadowRoot;
      return shadow.querySelector('.panel').getBoundingClientRect().width;
    });
    assert.strictEqual(width, 380, 'the panel stays put while pictures are taken');
  });

  const file = shots.fileFor(outFile, shots.readManifest(outFile)[1]);
  const size = jpegSize(file);
  assert.ok(size, 'the file should be a readable jpeg');
  assert.strictEqual(size.height, 900, 'full height of the recording viewport');
  assert.strictEqual(size.width, 1440 - 380, 'and everything left of the panel');
});

// Somebody presses "Record again", changes their mind, and closes the browser.
// Writing the flow here would replace the walkthrough they already have, and
// every line of narration written on it, with a lone "goto".
test('a session abandoned before anything was recorded leaves the flow alone', async () => {
  const outFile = path.join(work, 'kept.json');
  const existing = {
    name: 'The one I already had',
    baseUrl: `${server.url}`,
    steps: [
      { action: 'goto', url: '/dashboard.html?auth=1' },
      { action: 'click', selector: '#tile-hours', narration: 'Hours are top left.' },
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(existing, null, 2));

  const result = await capture({
    url: `${server.url}/dashboard.html?auth=1`,
    outFile,
    headless: true,
    onReady: async (page) => { await page.close(); },
  });

  assert.strictEqual(result.saved, false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')), existing);
});

test('a session with steps in it is written even without pressing Save flow', async () => {
  const outFile = path.join(work, 'closed-with-steps.json');
  const result = await capture({
    url: `${server.url}/dashboard.html?auth=1`,
    outFile,
    headless: true,
    onReady: async (page) => {
      page.setDefaultTimeout(8000);
      await page.waitForFunction(() => window.__tutPanelLoaded === true);
      await page.click('#tile-hours');
      await page.waitForTimeout(200);
      await page.close();
    },
  });

  assert.strictEqual(result.saved, true, 'work already done is not thrown away');
  assert.strictEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')).steps.length, 2);
});
