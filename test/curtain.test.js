'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const { record, settled } = require('../src/recorder');
const { launch } = require('../src/browser');
const { buildOverlayScript } = require('../src/overlay');
const { deepMerge, DEFAULTS, validateTheme, loadTheme } = require('../src/theme');
const ff = require('../src/ffmpeg');

/**
 * What the viewer sees while a page is loading.
 *
 * A site being fetched, parsed and hydrated is not something anybody wants in a
 * walkthrough, and every one of these faults is invisible in a still: you have
 * to look at the frames. So these tests record a deliberately slow site and
 * count pixels.
 *
 * The site paints RED while it is loading and BLUE once it is ready. Red in any
 * frame is the bug, whatever it looks like to a person watching.
 */
const LOADING_RED = [220, 20, 20];
const READY_BLUE = [20, 40, 200];

let server;
let base;

test.before(async () => {
  server = http.createServer(async (req, res) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (req.url === '/late.css') {
      await wait(250);
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end('body{background:rgb(220,20,20)}');
    }
    if (req.url === '/content.json') {
      await wait(700);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.url === '/late.js') {
      await wait(150);
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      // The shape nearly every site has now: paint a shell, fetch, then render.
      // Between the shell and the response the DOM does not move at all, which
      // is the gap a recorder watching only mutations falls into.
      return res.end(
        'fetch("/content.json").then(r => r.json()).then(() => {' +
        'document.body.style.background = "rgb(20,40,200)";' +
        'document.body.innerHTML = \'<button id="go" style="position:fixed;left:40px;top:40px">Go</button>\';' +
        '});'
      );
    }
    await wait(300);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><link rel="stylesheet" href="/late.css"></head>' +
      '<body style="margin:0;background:rgb(220,20,20)">' +
      '<script src="/late.js"></script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 60000 });

test.after(() => new Promise((r) => server.close(r)));

const REPO = path.join(__dirname, '..');

/** Record one goto and hand back every frame as an average colour. */
async function framesOf(themeOverrides = {}) {
  const theme = validateTheme(
    deepMerge(loadTheme(path.join(REPO, 'theme.json')), themeOverrides),
    'theme.json'
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-curtain-'));
  const flow = {
    baseUrl: null, minStepMs: 900, stepPaddingMs: 300, typeDelayMs: 10, settleMs: 500,
    timeoutMs: 15000, dismiss: { builtins: false, selectors: [], frames: [] }, viewport: null,
    steps: [{ action: 'goto', url: base }],
  };
  const { videoPath } = await record(flow, theme, [null], { outDir: dir, headless: true });

  // signalstats gives a per-frame average for each plane; asking ffmpeg for it
  // is far cheaper than decoding frames here and reading pixels.
  const shots = path.join(dir, 'shots');
  fs.mkdirSync(shots);
  execFileSync(ff.binaries().ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
    '-vf', 'fps=12,scale=24:14', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    path.join(shots, 'raw.rgb'),
  ]);
  const raw = fs.readFileSync(path.join(shots, 'raw.rgb'));
  const perFrame = 24 * 14 * 3;
  const frames = [];
  for (let i = 0; i + perFrame <= raw.length; i += perFrame) {
    let r = 0; let g = 0; let b = 0;
    for (let px = 0; px < perFrame; px += 3) {
      r += raw[i + px]; g += raw[i + px + 1]; b += raw[i + px + 2];
    }
    const n = perFrame / 3;
    frames.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return frames;
}

/** How close a frame is to a colour, 0 = identical. */
const distance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const nearest = (frame) => (distance(frame, LOADING_RED) < distance(frame, READY_BLUE)
  ? 'loading' : 'ready');

test('a page being loaded never reaches the video', async () => {
  const frames = await framesOf();
  assert.ok(frames.length > 8, `only ${frames.length} frames came back`);

  // Anything obviously red is the loading state, which the viewer must never
  // see. A frame part-way through the fade is a blend, so the test asks whether
  // red dominates rather than whether it is present at all.
  const reddish = frames.filter((f) => f[0] > f[2] + 25);
  assert.deepStrictEqual(reddish, [],
    `${reddish.length} frames show the site still loading: ${JSON.stringify(reddish)}`);

  // And it does get there in the end.
  assert.strictEqual(nearest(frames[frames.length - 1]), 'ready');
}, { timeout: 120000 });

test('the video does not open on a flash of white', async () => {
  const frames = await framesOf();
  const [first] = frames;
  // theme.json's stage is #0F1115. White would be 255 across the board.
  assert.ok(first.every((v) => v < 80),
    `the first frame is ${JSON.stringify(first)}, which is not the stage colour`);
}, { timeout: 120000 });

test('turning the curtain off puts the loading back, which is how we know it was the curtain',
  async () => {
    const frames = await framesOf({ video: { curtain: false } });
    const reddish = frames.filter((f) => f[0] > f[2] + 25);
    assert.ok(reddish.length > 0,
      'with no curtain the loading state should be visible; if it is not, these ' +
      'tests are not measuring what they claim to');
  }, { timeout: 120000 });

test('settled waits for the page to stop changing, not for a fixed pause', async () => {
  const browser = await launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } });
    const page = await ctx.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(
      '<body><div id="x">0</div><script>let n=0;' +
      'const t=setInterval(()=>{document.getElementById("x").textContent=++n;' +
      'if(n>=6)clearInterval(t);},120);</script></body>'
    )}`, { waitUntil: 'load' });

    const started = Date.now();
    const result = await settled(page, { settleMs: 300, timeout: 8000 });
    const waited = Date.now() - started;

    assert.strictEqual(result.quiet, true);
    // Six ticks at 120ms is 720ms of movement, then 300ms of quiet.
    assert.ok(waited >= 850, `it called the page settled after ${waited}ms, mid-change`);
    assert.strictEqual(await page.textContent('#x'), '6');
    await ctx.close();
  } finally {
    await browser.close();
  }
}, { timeout: 60000 });

test('a page that never stops moving is recorded anyway, with a note', async () => {
  const browser = await launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } });
    const page = await ctx.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(
      '<body><div id="x">0</div><script>let n=0;' +
      'setInterval(()=>{document.getElementById("x").textContent=++n;},50);</script></body>'
    )}`, { waitUntil: 'load' });

    const notes = [];
    const result = await settled(page, { settleMs: 400, timeout: 1500, log: (m) => notes.push(m) });
    assert.strictEqual(result.quiet, false);
    assert.match(notes.join('\n'), /never stopped changing/);
    await ctx.close();
  } finally {
    await browser.close();
  }
}, { timeout: 60000 });

test('the curtain is not drawn inside an iframe', async () => {
  const browser = await launch({ headless: true });
  try {
    const theme = deepMerge(DEFAULTS, { cursor: { enabled: false } });
    const ctx = await browser.newContext({ viewport: { width: 500, height: 400 } });
    await ctx.addInitScript(buildOverlayScript(theme, []));
    const page = await ctx.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(
      '<body><iframe id="f" srcdoc="<body>inner</body>" style="width:300px;height:200px"></iframe></body>'
    )}`, { waitUntil: 'load' });

    assert.strictEqual(await page.locator('[data-tut-curtain]').count(), 1);
    assert.strictEqual(
      await page.frameLocator('#f').locator('[data-tut-curtain]').count(), 0,
      'a curtain inside the widget would blank it out for the whole recording'
    );
    await ctx.close();
  } finally {
    await browser.close();
  }
}, { timeout: 60000 });

test('a connection held open for the whole visit does not hold up the recording', async () => {
  // Long polls, websocket fallbacks and analytics beacons that never return are
  // ordinary on real sites. What matters for a video is whether the picture is
  // moving, and a request that has changed nothing for seconds is not evidence
  // that it is about to.
  const held = [];
  const poller = http.createServer((req, res) => {
    if (req.url === '/poll') { held.push(res); return; }   // never answered
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body style="margin:0;background:#123">' +
      '<script>fetch("/poll");</script></body>');
  });
  await new Promise((r) => poller.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${poller.address().port}/`;

  const browser = await launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } });
    await ctx.addInitScript(buildOverlayScript(deepMerge(DEFAULTS, {}), []));
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });

    const started = Date.now();
    const result = await settled(page, { settleMs: 300, stuckMs: 900, timeout: 15000 });
    const waited = Date.now() - started;

    assert.strictEqual(result.quiet, true, 'it should settle, not time out');
    assert.ok(waited < 3000, `it waited ${waited}ms on a request that will never return`);
    assert.ok(await page.evaluate(() => window.__tutNet.inflight) > 0,
      'the request really is still open, so this test is measuring what it claims to');
    await ctx.close();
  } finally {
    await browser.close();
    for (const res of held) res.destroy();
    await new Promise((r) => poller.close(r));
  }
}, { timeout: 60000 });
