'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');

const { record, trimOpening } = require('../src/recorder');
const { loadTheme, validateTheme, deepMerge } = require('../src/theme');
const ff = require('../src/ffmpeg');

const REPO = path.join(__dirname, '..');

/**
 * Does the narration land where the picture is?
 *
 * The pipeline times everything against the recorder's own clock and then
 * writes it into a file whose zero is not that clock's zero: Playwright begins
 * capturing while the page is still being created, most of a second before the
 * first step runs. Every line was landing that much early, and nothing said so,
 * because the captions were built from the same timeline and were off by
 * exactly the same amount.
 *
 * So this measures both sides of the finished file independently: when the
 * picture changes, and when the sound starts. They have to agree.
 */

let server;
let base;

test.before(async () => {
  server = http.createServer(async (req, res) => {
    // Slow on purpose. The whole question is what happens to the seconds
    // between the navigation and the page being there.
    await new Promise((r) => setTimeout(r, 700));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body style="margin:0;background:rgb(20,150,90)">' +
      '<button id="go" style="position:fixed;left:40px;top:40px">Go</button></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
}, { timeout: 60000 });

test.after(() => new Promise((r) => server.close(r)));

/** A tone, standing in for a spoken line, of a known length. */
function tone(seconds, out) {
  execFileSync(ff.binaries().ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds}`,
    '-ac', '2', '-c:a', 'aac', '-b:a', '128k', out,
  ]);
  return out;
}

/** The first second at which there is anything in the picture. */
async function pictureAt(file) {
  return ff.firstFrameWithDetail(file, { maxSec: 20, fps: 25 });
}

/** The first second at which there is sound, sampled in 40ms slices. */
function soundAt(file) {
  const out = spawnSync(ff.binaries().ffmpeg, [
    '-hide_banner', '-v', 'info', '-i', file,
    '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stderr;
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const at = /pts_time:([\d.]+)/.exec(lines[i]);
    if (!at) continue;
    const level = /RMS_level=(-?[\d.inf]+)/.exec(lines[i + 1] || '');
    if (level && Number(level[1]) > -50) return Number(at[1]);
  }
  return null;
}

test('the narration lands where the picture does', async () => {
  const theme = validateTheme(deepMerge(loadTheme(path.join(REPO, 'theme.json')), {
    intro: { enabled: false }, outro: { enabled: false },
    captions: { enabled: false }, transitions: { enabled: false },
    cursor: { enabled: false }, highlight: { enabled: false }, hints: { enabled: false },
  }), 'theme.json');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-sync-'));
  try {
    // One line, on the first step. It should start the instant the page is
    // there, which is the instant the curtain comes down.
    const clip = { file: tone(2, path.join(dir, 'line.m4a')), durationSec: 2 };
    const flow = {
      baseUrl: null, minStepMs: 2600, stepPaddingMs: 300, typeDelayMs: 10, settleMs: 500,
      timeoutMs: 15000, dismiss: { builtins: false, selectors: [], frames: [] }, viewport: null,
      steps: [{ action: 'goto', url: base, narration: 'x' }],
    };

    const { videoPath, timeline, totalSec, trimSec } = await record(flow, theme, [clip], {
      outDir: dir, headless: true,
    });

    const track = await ff.buildNarrationTrack(
      [{ file: clip.file, startSec: timeline[0].startSec }], totalSec,
      path.join(dir, 'narration.m4a')
    );
    const outFile = await ff.muxAudioVideo(
      videoPath, track, path.join(dir, 'out.mp4'), theme.video, null, 'working', trimSec
    );

    const picture = await pictureAt(outFile);
    const sound = soundAt(outFile);
    assert.ok(picture !== null, 'the page never appeared in the delivered file');
    assert.ok(sound !== null, 'no narration in the delivered file');

    const drift = Math.abs(sound - picture);
    assert.ok(drift < 0.25,
      `the line starts at ${sound.toFixed(2)}s and the page appears at ` +
      `${picture.toFixed(2)}s, ${drift.toFixed(2)}s apart`);

    // And the waiting is gone: the page is there almost at once, not after the
    // second and a half the server took.
    assert.ok(picture < 0.9, `the file opens on ${picture.toFixed(2)}s of nothing`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 180000 });

test('a recording with nothing to cut is left alone', async () => {
  const theme = validateTheme(loadTheme(path.join(REPO, 'theme.json')), 'theme.json');
  const timeline = [{ index: 0, startSec: 0.1, endSec: 2 }];
  const untouched = await trimOpening(
    { videoPath: '/nonexistent.webm', timeline, totalSec: 2 }, theme
  );
  assert.strictEqual(untouched.trimSec, 0);
  assert.deepStrictEqual(untouched.timeline, timeline, 'a probe that fails must change nothing');
});

test('turning the curtain off turns the trim off with it', async () => {
  const theme = validateTheme(deepMerge(loadTheme(path.join(REPO, 'theme.json')),
    { video: { curtain: false } }), 'theme.json');
  const timeline = [{ index: 0, startSec: 3, endSec: 6 }];
  const r = await trimOpening({ videoPath: 'x.webm', timeline, totalSec: 6 }, theme);
  assert.strictEqual(r.trimSec, 0);
  assert.strictEqual(r.timeline[0].startSec, 3);
});

test('a light page on a light stage is trimmed too', async () => {
  // The case that shipped broken. Detection used to ask whether the frame
  // differed from the stage colour, which works on a dark theme over a dark
  // site and fails completely the other way: a #F4F5F7 stage over a white
  // login page differs by eleven per channel. The page never "showed through",
  // nothing was cut, and the video opened on seconds of flat grey.
  const light = http.createServer(async (req, res) => {
    await new Promise((r) => setTimeout(r, 800));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body style="margin:0;background:#fff;font:14px system-ui;' +
      'display:grid;place-items:center;height:100vh">' +
      '<div style="background:#FAFAFB;border:1px solid #EEE;border-radius:12px;padding:40px;width:320px">' +
      '<div style="font-weight:700;font-size:20px;text-align:center">Employee portal</div>' +
      '<input id="u" style="width:100%;margin-top:20px;padding:10px;border:1px solid #DDD">' +
      '<button style="width:100%;margin-top:18px;padding:11px;background:#E6007E;color:#fff;border:0">Log in</button>' +
      '</div></body>');
  });
  await new Promise((r) => light.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${light.address().port}/`;

  const theme = validateTheme(deepMerge(loadTheme(path.join(REPO, 'theme.json')), {
    // The Rebels stage: near-white, like the site it records.
    video: { backgroundColor: '#F4F5F7' },
    intro: { enabled: false }, outro: { enabled: false },
    captions: { enabled: false }, transitions: { enabled: false },
  }), 'theme.json');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-light-'));
  try {
    const flow = {
      baseUrl: null, minStepMs: 1400, stepPaddingMs: 400, typeDelayMs: 10, settleMs: 500,
      timeoutMs: 15000, dismiss: { builtins: false, selectors: [], frames: [] }, viewport: null,
      steps: [{ action: 'goto', url }],
    };
    const { videoPath, timeline, totalSec, trimSec } = await record(flow, theme, [null], {
      outDir: dir, headless: true,
    });

    // Not how much was cut. How much there is to cut varies by more than a
    // second between runs, because Playwright does not always start capturing
    // at the same point - so the invariant worth holding is the one the viewer
    // sees: the file opens on the page, not on a hold of flat grey.
    assert.ok(trimSec >= 0, 'the cut is never negative');

    const track = await ff.buildNarrationTrack([], totalSec, path.join(dir, 'silence.m4a'));
    const outFile = await ff.muxAudioVideo(
      videoPath, track, path.join(dir, 'out.mp4'), theme.video, null, 'working', trimSec
    );
    const picture = await pictureAt(outFile);
    assert.ok(picture !== null && picture < 0.9,
      `the file opens on ${picture === null ? 'nothing at all' : picture.toFixed(2) + 's'} of flat grey`);
    assert.ok(timeline[0].startSec <= 0.45);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => light.close(r));
  }
}, { timeout: 180000 });
