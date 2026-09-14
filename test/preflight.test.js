'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const preflight = require('../src/preflight');
const { binaries, resolveBinary, checkToolchain } = require('../src/ffmpeg');

// The point of bundling is that a colleague never reads "install ffmpeg".
test('ffmpeg and ffprobe come from the project, not from the machine', () => {
  const bins = binaries();
  assert.ok(bins.bundled, `expected a bundled build, got ${bins.ffmpeg}`);
  assert.ok(fs.existsSync(bins.ffmpeg), 'the ffmpeg binary is on disk');
  assert.ok(fs.existsSync(bins.ffprobe), 'the ffprobe binary is on disk');
  assert.doesNotThrow(() => fs.accessSync(bins.ffmpeg, fs.constants.X_OK), 'and is executable');
});

// A build without libass renders captions in a system font, or not at all.
// It is worth checking the bundled one rather than assuming.
test('the bundled build has what the pipeline actually uses', async () => {
  await checkToolchain();
});

test('an explicit path still wins over the bundled build', () => {
  const before = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/somewhere/else/ffmpeg';
  try {
    assert.strictEqual(resolveBinary('FFMPEG_PATH', 'ffmpeg-static', 'ffmpeg'), '/somewhere/else/ffmpeg');
  } finally {
    if (before === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = before;
  }
});

test('a package that is not installed falls back to the system binary', () => {
  assert.strictEqual(resolveBinary('NOTHING_SET_HERE', 'no-such-package-xyz', 'ffmpeg'), 'ffmpeg');
});

test('inspect reports on all three things without downloading anything', async () => {
  const report = await preflight.inspect();
  assert.strictEqual(report.ffmpeg.ok, true);
  assert.strictEqual(report.ffmpeg.bundled, true);
  assert.strictEqual(report.browser.ok, true);
  assert.ok(typeof report.browser.path === 'string');
  assert.strictEqual(typeof report.narration, 'boolean');
});

test('a missing browser is reported as missing rather than guessed at', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-nobrowser-'));
  const before = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = empty;
  try {
    // findBrowser has to answer honestly here: resolveExecutablePath returns
    // null both when Playwright has its own copy and when there is nothing.
    assert.strictEqual(preflight.findBrowser(), null);
  } finally {
    if (before === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = before;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('the downloader that fetches the browser is present', () => {
  const cli = preflight.installerPath();
  assert.ok(cli, 'a Playwright CLI was found');
  assert.ok(fs.existsSync(cli));
});

test('ensureReady leaves a ready machine alone', async () => {
  const seen = [];
  const report = await preflight.ensureReady({ log: (m) => seen.push(m) });
  assert.strictEqual(report.browser.ok, true);
  assert.ok(!seen.some((m) => /Setting up the browser/.test(m)),
    'nothing should be downloaded when everything is already there');
});

test('the summary names what is missing rather than only what is fine', () => {
  const broken = {
    ffmpeg: { ok: false, path: 'ffmpeg', bundled: false, error: 'not usable' },
    browser: { ok: false, path: null },
    narration: false,
  };
  const text = preflight.describe(broken);
  assert.match(text, /video tools\s+MISSING/);
  assert.match(text, /browser\s+MISSING/);
  assert.match(text, /narration\s+off/);

  const fine = {
    ffmpeg: { ok: true, path: '/x/ffmpeg', bundled: true, error: null },
    browser: { ok: true, path: '/x/chrome' },
    narration: true,
  };
  assert.match(preflight.describe(fine), /bundled with the project/);
});

// --- the narration key --------------------------------------------------

const { hasNarrationKey } = require('../src/preflight');
const { saveSecrets } = require('../src/settings');

test('a key typed into the window counts as a key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-key-'));
  const had = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    assert.strictEqual(hasNarrationKey(dir), false);
    saveSecrets(dir, { ELEVENLABS_API_KEY: 'sk_saved' });
    assert.strictEqual(hasNarrationKey(dir), true);

    // The CLI has no window to have typed it into, so for it nothing changed.
    assert.strictEqual(hasNarrationKey(null), false);

    process.env.ELEVENLABS_API_KEY = 'sk_env';
    assert.strictEqual(hasNarrationKey(null), true);
  } finally {
    if (had === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = had;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable secrets file is no key rather than a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-key-'));
  const had = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    fs.writeFileSync(path.join(dir, '.secrets.json'), 'not json');
    assert.strictEqual(hasNarrationKey(dir), false);
  } finally {
    if (had !== undefined) process.env.ELEVENLABS_API_KEY = had;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
