'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp, friendly, slug } = require('../src/ui');

const REPO = path.join(__dirname, '..');

/** A project directory holding the shipped themes, so the app has something real. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-ui-'));
  fs.copyFileSync(path.join(REPO, 'theme.json'), path.join(dir, 'theme.json'));
  fs.copyFileSync(path.join(REPO, 'theme-rebels.json'), path.join(dir, 'theme-rebels.json'));
  fs.copyFileSync(path.join(REPO, 'theme.example.json'), path.join(dir, 'theme.example.json'));
  fs.cpSync(path.join(REPO, 'fonts'), path.join(dir, 'fonts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'assets'), path.join(dir, 'assets'), { recursive: true });
  return dir;
}

async function withApp(fn) {
  const dir = makeProject();
  const app = createApp({ projectDir: dir });
  const url = await app.listen();
  const base = new URL(url).origin;
  const call = (p, body) => fetch(`${base}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-tutvid-token': app.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    return await fn({ app, base, call, url, dir });
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the window is served with its token filled in', async () => {
  await withApp(async ({ base, app }) => {
    const html = await fetch(`${base}/`).then((r) => r.text());
    assert.ok(html.includes(app.token), 'the page carries the token it needs');
    assert.ok(!html.includes('__TOKEN__'), 'the placeholder was replaced');
    assert.ok(html.includes('Walkthrough Recorder'));
  });
});

// The server can launch browsers and write files, and anything on 127.0.0.1 is
// reachable from any page the browser happens to have open.
test('every action refuses to run without the token', async () => {
  await withApp(async ({ base }) => {
    for (const [p, body] of [
      ['/api/setup', null], ['/api/capture', { url: 'https://x.test' }],
      ['/api/render', {}], ['/api/reveal', {}], ['/api/video', null],
    ]) {
      const res = await fetch(`${base}${p}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.strictEqual(res.status, 403, `${p} should refuse an untokened call`);
    }
  });
});

test('a wrong token is refused too', async () => {
  await withApp(async ({ base }) => {
    const res = await fetch(`${base}/api/setup`, { headers: { 'x-tutvid-token': 'nope' } });
    assert.strictEqual(res.status, 403);
  });
});

test('setup reports the themes it found and what the machine can do', async () => {
  await withApp(async ({ call }) => {
    const setup = await call('/api/setup').then((r) => r.json());
    const files = setup.themes.map((t) => t.file).sort();
    assert.deepStrictEqual(files, ['theme-rebels.json', 'theme.json']);
    assert.ok(!files.includes('theme.example.json'), 'the sample is not a style to pick');
    assert.ok(setup.themes.every((t) => t.ok), 'both should load');
    assert.ok(setup.themes.find((t) => t.file === 'theme-rebels.json').detail.includes('Q Portal'));
    assert.strictEqual(typeof setup.ready.ffmpeg, 'boolean');
    assert.strictEqual(typeof setup.ready.narration, 'boolean');
    assert.strictEqual(setup.state.phase, 'idle');
  });
});

test('a broken theme is listed but cannot be chosen', async () => {
  await withApp(async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, 'theme-broken.json'), '{ "video": { "width": 1921 } }');
    const setup = await call('/api/setup').then((r) => r.json());
    const broken = setup.themes.find((t) => t.file === 'theme-broken.json');
    assert.ok(broken, 'it is still shown, so the problem is visible');
    assert.strictEqual(broken.ok, false);
    assert.match(broken.detail, /even/);
  });
});

test('a web address that is not one is turned away before a browser opens', async () => {
  await withApp(async ({ call }) => {
    for (const bad of ['', 'portal.example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const res = await call('/api/capture', { url: bad });
      assert.strictEqual(res.status, 400, `"${bad}" should be refused`);
      const { error } = await res.json();
      assert.match(error, /web address/);
    }
  });
});

test('asking for a video before there is one says so plainly', async () => {
  await withApp(async ({ call }) => {
    assert.strictEqual((await call('/api/video')).status, 404);
    const res = await call('/api/render', {});
    const body = await res.json();
    // Either refused outright, or the run fails and the phase says so.
    if (res.status === 200) {
      await new Promise((r) => setTimeout(r, 300));
    } else {
      assert.match(body.error, /no recording/i);
    }
  });
});

test('the event stream sends the current state immediately', async () => {
  await withApp(async ({ base, app }) => {
    const res = await fetch(`${base}/api/events?token=${app.token}`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^data: /);
    const state = JSON.parse(text.replace(/^data: /, '').trim());
    assert.strictEqual(state.phase, 'idle');
    assert.deepStrictEqual(state.steps, []);
    await reader.cancel();
  });
});

test('failures are rewritten into something worth showing a colleague', () => {
  assert.match(friendly(new Error('ELEVENLABS_API_KEY is not set, so narration cannot be generated.')),
    /Turn narration off/);
  assert.match(friendly(new Error('ffmpeg is required but not usable.')), /needed to put the video together/);
  assert.match(friendly(new Error("Executable doesn't exist at /opt/x")), /playwright install chromium/);
  assert.match(friendly(new Error('Selector "#gone" never became visible')), /Record the walkthrough again/);
  // Anything unrecognised is passed through rather than swallowed.
  assert.strictEqual(friendly(new Error('something odd')), 'something odd');
});

test('a file name typed by a person becomes a safe file name', () => {
  assert.strictEqual(slug('Onboarding walkthrough'), 'onboarding-walkthrough');
  assert.strictEqual(slug('  Q Portal / uren  '), 'q-portal-uren');
  assert.strictEqual(slug('../../etc/passwd'), 'etc-passwd', 'no climbing out of the folder');
  assert.strictEqual(slug(''), '');
});

test('the default style is offered first', async () => {
  await withApp(async ({ call }) => {
    const setup = await call('/api/setup').then((r) => r.json());
    assert.strictEqual(setup.themes[0].file, 'theme.json',
      'the dropdown should open on the default, not on whatever readdir returned');
  });
});
