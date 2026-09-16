'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { chromium } = require('playwright');
const { record } = require('../src/recorder');
const { loadTheme, validateTheme } = require('../src/theme');
const { findChromium } = require('../src/browser');

/**
 * Record with chrome-headless-shell, which is what a normal install gives you.
 *
 * This file exists because of a bug that shipped. A recording launched with
 * --default-background-color, a perfectly ordinary Chromium switch, and every
 * test here passed - because this machine happens to have the full Chromium
 * and resolveExecutablePath prefers it. On a normal Windows install Playwright
 * reaches for chrome-headless-shell instead, which classes that switch as a
 * "headless command" and refuses to start at all when one is combined with
 * remote debugging. Playwright always uses remote debugging. So the browser
 * died on launch, with a wall of Chromium log and nothing about what to do.
 *
 * The two builds take different switches. Whatever the recorder passes has to
 * work on both, and nothing but running it on both will say whether it does.
 */

/** The headless shell beside whichever Chromium is installed, if there is one. */
function headlessShell() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const roots = [root, path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')].filter(Boolean);
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/^chromium[_-]headless[_-]shell/.test(name)) continue;
      for (const rel of [
        path.join('chrome-linux', 'headless_shell'),
        path.join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
        path.join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        path.join('chrome-headless-shell-mac', 'chrome-headless-shell'),
      ]) {
        const candidate = path.join(dir, name, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const SHELL = headlessShell();

test('the recorder\'s launch flags do not kill chrome-headless-shell', { skip: !SHELL && 'no chrome-headless-shell installed' }, async () => {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body style="margin:0;background:rgb(30,120,200)">' +
      '<button id="go" style="margin:40px">Go</button></body>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-shell-'));

  // Point the shared launcher at the shell for this test only, the way a
  // machine that only has that build would.
  const before = process.env.CHROMIUM_EXECUTABLE_PATH;
  process.env.CHROMIUM_EXECUTABLE_PATH = SHELL;
  try {
    const theme = validateTheme(loadTheme(path.join(__dirname, '..', 'theme.json')), 'theme.json');
    theme.video = { ...theme.video, width: 640, height: 400, fps: 15 };
    const flow = {
      baseUrl: null, minStepMs: 600, stepPaddingMs: 200, typeDelayMs: 10, settleMs: 300,
      timeoutMs: 15000, dismiss: { builtins: false, selectors: [], frames: [] }, viewport: null,
      steps: [{ action: 'goto', url }, { action: 'click', selector: '#go' }],
    };
    const { videoPath, timeline } = await record(flow, theme, [null, null],
      { outDir: dir, headless: true });

    assert.ok(fs.existsSync(videoPath), 'no video came out of the headless shell');
    assert.ok(fs.statSync(videoPath).size > 1000, 'the video is empty');
    assert.strictEqual(timeline.length, 2);
  } finally {
    if (before === undefined) delete process.env.CHROMIUM_EXECUTABLE_PATH;
    else process.env.CHROMIUM_EXECUTABLE_PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => site.close(r));
  }
}, { timeout: 180000 });

test('a switch the headless shell treats as a command is refused, loudly', { skip: !SHELL && 'no chrome-headless-shell installed' }, async () => {
  // The proof that the test above is measuring something: the flag that broke
  // it still breaks it, so a future one cannot be added without this failing.
  await assert.rejects(
    chromium.launch({ headless: true, executablePath: SHELL, args: ['--default-background-color=FF0F1115'] }),
    /closed|Headless commands/i,
    'chrome-headless-shell used to refuse this; if it no longer does, this file has stopped proving anything'
  );
}, { timeout: 120000 });

test('findChromium can see a headless shell build', { skip: !SHELL && 'no chrome-headless-shell installed' }, () => {
  // Not the same question as the launch, but worth knowing the resolver is not
  // blind to the build most people have.
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return;
  assert.ok(findChromium(root), 'nothing usable found under the browsers root');
});
