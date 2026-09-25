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
    assert.ok(html.includes('<title>Qapture</title>'), 'the window is the app, not a blank page');
  });
});

// The server can launch browsers and write files, and anything on 127.0.0.1 is
// reachable from any page the browser happens to have open.
test('every action refuses to run without the token', async () => {
  await withApp(async ({ base }) => {
    for (const [p, body] of [
      ['/api/setup', null], ['/api/capture', { url: 'https://x.test' }],
      ['/api/render', {}], ['/api/reveal', {}], ['/api/video', null],
      ['/api/upload?kind=image&name=x.png', {}], ['/api/card-preview', { card: 'intro' }],
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
  const noKey = friendly(new Error('ELEVENLABS_API_KEY is not set, so narration cannot be generated.'));
  assert.match(noKey, /turn narration off/);
  // There is somewhere in the window to put one now, so say where.
  assert.match(noKey, /under Style/);
  assert.match(friendly(new Error('ffmpeg is required but not usable.')), /needed to put the video together/);
  // The tool fetches the browser itself now, so this must not ask a colleague
  // to run a command.
  const browserMessage = friendly(new Error("Executable doesn't exist at /opt/x"));
  assert.match(browserMessage, /start the recorder again/);
  assert.ok(!/npx|npm|install chromium/.test(browserMessage),
    `should not hand a colleague a command to run: ${browserMessage}`);
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

// --- settings ----------------------------------------------------------

test('the settings screen is told the fields, the values and which passwords are wanted', async () => {
  await withApp(async ({ call, dir }) => {
    fs.copyFileSync(path.join(REPO, 'demo', 'portal-flow.json'), path.join(dir, 'flow.json'));
    const s = await call('/api/settings').then((r) => r.json());
    assert.ok(s.fields.length >= 10);
    assert.strictEqual(s.problem, null);
    assert.ok('theme.cursor.moveMs' in s.values);
    const names = s.secrets.filter((x) => x.role === 'flow').map((x) => x.name).sort();
    assert.deepStrictEqual(names, ['PORTAL_EMAIL', 'PORTAL_PASSWORD']);
    assert.ok(s.secrets.every((x) => x.set === false));
  });
});

// A stored password is never handed back to the page. The window is told which
// names are set and that is all it needs to draw the form.
test('a saved password is never sent back to the window', async () => {
  await withApp(async ({ call, dir }) => {
    fs.copyFileSync(path.join(REPO, 'demo', 'portal-flow.json'), path.join(dir, 'flow.json'));
    await call('/api/settings', { secrets: { PORTAL_PASSWORD: 'hunter2' } });

    const s = await call('/api/settings').then((r) => r.json());
    assert.ok(!JSON.stringify(s).includes('hunter2'), 'the value leaked to the page');
    assert.strictEqual(s.secrets.find((x) => x.name === 'PORTAL_PASSWORD').set, true);
  });
});

test('saving settings writes settings.json and never the theme', async () => {
  await withApp(async ({ call, dir }) => {
    const themeBefore = fs.readFileSync(path.join(dir, 'theme.json'), 'utf8');
    const res = await call('/api/settings', {
      values: { 'theme.cursor.moveMs': 820, 'flow.minStepMs': 2200 },
    });
    assert.strictEqual(res.status, 200);

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    // Visual settings are kept per style; everything else holds for the project.
    assert.strictEqual(written.styles['theme.json'].cursor.moveMs, 820);
    assert.strictEqual(written.flow.minStepMs, 2200);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'), themeBefore);
  });
});

test('a value the tool will not accept comes back as a sentence, not a stack trace', async () => {
  await withApp(async ({ call }) => {
    const res = await call('/api/settings', { values: { 'theme.video.width': 1921 } });
    assert.strictEqual(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /even number of pixels/);
  });
});

test('settings need the token like everything else', async () => {
  await withApp(async ({ base }) => {
    assert.strictEqual((await fetch(`${base}/api/settings`)).status, 403);
    const posted = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secrets: { X: 'y' } }),
    });
    assert.strictEqual(posted.status, 403);
  });
});

// Some combinations only break later: switching the opening card on without
// giving it a title renders nothing and stops the run three minutes in.
test('a combination that would break the render is refused while saving', async () => {
  await withApp(async ({ call }) => {
    const res = await call('/api/settings', {
      values: { 'theme.intro.enabled': true, 'theme.intro.title': '', 'theme.intro.subtitle': '' },
    });
    assert.strictEqual(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /no title, subtitle or logo/);
  });
});

// The fonts folder is the catalogue, so the dropdown offers the lot without
// anything having to be declared first.
test('the settings screen is offered every font in the project', async () => {
  await withApp(async ({ call, dir }) => {
    const s = await call('/api/settings').then((r) => r.json());
    const onDisk = fs.readdirSync(path.join(dir, 'fonts')).filter((f) => /\.(ttf|otf)$/i.test(f));
    assert.strictEqual(s.fonts.length, onDisk.length);

    // The page draws each option in its own face, so it needs the file too.
    assert.ok(s.fonts.every((f) => f.key && f.family && f.label && f.file));
    const inter = s.fonts.find((f) => f.key === 'inter-bold');
    assert.deepStrictEqual(
      { family: inter.family, label: inter.label, file: inter.file, weight: inter.weight },
      { family: 'Inter', label: 'Inter Bold', file: 'Inter-Bold.ttf', weight: 700 }
    );
    // A file name, never a path: it is fetched back through /api/font.
    assert.ok(s.fonts.every((f) => !f.file.includes('/')));
  });
});

test('a font the project does not have is refused with some that it does', async () => {
  await withApp(async ({ call }) => {
    const res = await call('/api/settings', { values: { 'theme.intro.titleFont': 'Comic Sans' } });
    assert.strictEqual(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /no font called "Comic Sans"/);
    assert.match(error, /This style has: /);
    assert.match(error, /and \d+ more/, 'a whole font folder listed back is a wall of text');
  });
});

test('colours and card text survive a save and come back', async () => {
  await withApp(async ({ call, dir }) => {
    await call('/api/settings', {
      values: {
        'theme.highlight.color': '#e6007e',
        'theme.intro.title': 'Q Portal',
        'theme.intro.titleFont': 'poppins-bold',
      },
    });
    const s = await call('/api/settings').then((r) => r.json());
    assert.strictEqual(s.values['theme.highlight.color'], '#E6007E');
    assert.strictEqual(s.values['theme.intro.title'], 'Q Portal');
    assert.strictEqual(s.values['theme.intro.titleFont'], 'poppins-bold');

    // And the theme file itself is still the hand-written one.
    assert.ok(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8').includes('//'));
  });
});

// The passwords list is built by reading the flow. A mistake there used to be
// swallowed and shown as "this walkthrough does not sign in anywhere".
test('a flow that will not parse says so instead of showing no passwords', async () => {
  await withApp(async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, 'flow.json'), '{ "steps": [ ');
    const s = await call('/api/settings').then((r) => r.json());
    assert.ok(s.problem, 'the broken flow should be reported');
    assert.match(s.problem, /not valid JSON/);
  });
});

// --- the storyboard ----------------------------------------------------

const BOARD_FLOW = {
  name: 'Q Portal walkthrough',
  baseUrl: 'https://portal.example.com',
  minStepMs: 1400,
  stepPaddingMs: 600,
  steps: [
    { action: 'goto', url: '/dashboard' },
    { action: 'type', selector: '#password', text: '${PORTAL_PASSWORD}', secret: true },
    { action: 'hover', selector: '#tile-hours', label: 'Monthly hours', narration: 'word '.repeat(20) },
    { action: 'click', selector: '#tile-reg', hint: 'One line per client.' },
  ],
};

function withFlow(dir, flow = BOARD_FLOW) {
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(flow, null, 2));
}

test('the storyboard is one entry per step, with how long each will be on screen', async () => {
  await withApp(async ({ call, dir }) => {
    withFlow(dir);
    const story = await call('/api/story').then((r) => r.json());
    assert.strictEqual(story.exists, true);
    assert.strictEqual(story.name, 'Q Portal walkthrough');
    assert.strictEqual(story.startUrl, 'https://portal.example.com/dashboard');
    assert.strictEqual(story.steps.length, 4);

    const [, secret, spoken, hinted] = story.steps;
    assert.strictEqual(secret.secret, true);
    assert.ok(!JSON.stringify(story).includes('PORTAL_PASSWORD'),
      'the storyboard has no reason to carry what a step types');
    assert.strictEqual(spoken.label, 'Monthly hours', 'what the element says, not its selector');
    assert.strictEqual(spoken.timing.decidedBy, 'narration');
    assert.strictEqual(hinted.timing.decidedBy, 'hint');
    assert.ok(spoken.estimateMs > 1400);

    // The total covers the steps and everything the recorder does around them.
    const stepSum = story.steps.reduce((a, s) => a + s.estimateMs, 0);
    assert.ok(story.totalMs > stepSum, 'the lead-in, the fades and the tail are in there too');
  });
});

test('with nothing recorded there is no storyboard to show', async () => {
  await withApp(async ({ call }) => {
    const story = await call('/api/story').then((r) => r.json());
    assert.strictEqual(story.exists, false);
    assert.deepStrictEqual(story.steps, []);
    assert.strictEqual(story.problem, null);
  });
});

test('a flow that will not parse is reported on the board, not swallowed', async () => {
  await withApp(async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, 'flow.json'), '{ "steps": [ ');
    const story = await call('/api/story').then((r) => r.json());
    assert.strictEqual(story.exists, false);
    assert.match(story.problem, /not valid JSON/);
  });
});

test('writing narration on the board lands in the flow file', async () => {
  await withApp(async ({ call, dir }) => {
    withFlow(dir);
    const story = await call('/api/story', {
      steps: [{ index: 0, narration: '  This is your portal.  ', hint: 'Everything in one place.' }],
    }).then((r) => r.json());

    assert.strictEqual(story.steps[0].narration, 'This is your portal.');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'));
    assert.strictEqual(saved.steps[0].narration, 'This is your portal.');
    assert.strictEqual(saved.steps[0].hint, 'Everything in one place.');
    assert.ok(story.steps[0].estimateMs > 1400, 'and the board re-times the step it just changed');
  });
});

test('emptying a box takes the line out rather than leaving a blank one', async () => {
  await withApp(async ({ call, dir }) => {
    withFlow(dir);
    await call('/api/story', { steps: [{ index: 3, hint: '' }] });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'));
    assert.ok(!('hint' in saved.steps[3]), 'an empty hint is no hint at all');
  });
});

// The board is for writing what gets said over a recording. It is not a place
// to rewrite how a step finds its element, or what it types into it.
test('the board can only write narration, hints and the name', async () => {
  await withApp(async ({ call, dir }) => {
    withFlow(dir);
    await call('/api/story', {
      name: 'Renamed',
      steps: [{
        index: 1,
        narration: 'Signing in.',
        selector: '#somewhere-else',
        text: 'hunter2',
        action: 'goto',
        secret: false,
      }],
    });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'));
    assert.strictEqual(saved.name, 'Renamed');
    assert.strictEqual(saved.steps[1].narration, 'Signing in.');
    assert.strictEqual(saved.steps[1].selector, '#password', 'the selector is the recording');
    assert.strictEqual(saved.steps[1].text, '${PORTAL_PASSWORD}');
    assert.strictEqual(saved.steps[1].action, 'type');
    assert.strictEqual(saved.steps[1].secret, true);
  });
});

test('a step out of range is ignored rather than growing the flow', async () => {
  await withApp(async ({ call, dir }) => {
    withFlow(dir);
    await call('/api/story', { steps: [{ index: 99, narration: 'nowhere' }] });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'));
    assert.strictEqual(saved.steps.length, 4);
  });
});

test('asking for a picture that was never taken says so', async () => {
  await withApp(async ({ call, dir }) => {
    withFlow(dir);
    assert.strictEqual((await call('/api/shot?i=0')).status, 404);
    assert.strictEqual((await call('/api/shot?i=notanumber')).status, 404);
  });
});

test('a picture is served for the step the manifest names', async () => {
  await withApp(async ({ call, dir }) => {
    withFlow(dir);
    const shots = require('../src/shots');
    const flowFile = path.join(dir, 'flow.json');
    fs.mkdirSync(shots.dirFor(flowFile), { recursive: true });
    fs.writeFileSync(path.join(shots.dirFor(flowFile), '7.jpg'), 'pretend jpeg');
    shots.writeManifest(flowFile, [null, null, '7.jpg', null]);

    assert.strictEqual((await call('/api/shot?i=0')).status, 404);
    const res = await call('/api/shot?i=2');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
    assert.strictEqual(await res.text(), 'pretend jpeg');

    const story = await call('/api/story').then((r) => r.json());
    assert.deepStrictEqual(story.steps.map((s) => s.hasShot), [false, false, true, false]);
  });
});

// The window is set in the same face as the videos, which means serving it.
test('the bundled fonts are served, and nothing else is', async () => {
  await withApp(async ({ call }) => {
    const ok = await call('/api/font/OverusedGrotesk-Roman.ttf');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('content-type'), 'font/ttf');
    for (const bad of ['/api/font/..%2F..%2Fpackage.json', '/api/font/README.md', '/api/font/nope.ttf']) {
      assert.strictEqual((await call(bad)).status, 404, `${bad} must not be served`);
    }
  });
});

// Somebody who recorded yesterday should not be shown an empty "paste a web
// address" form today.
test('a flow already on disk is picked up when the window opens', async () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(BOARD_FLOW, null, 2));
  const app = createApp({ projectDir: dir });
  try {
    const state = app.publicState();
    assert.strictEqual(state.phase, 'captured');
    assert.strictEqual(state.steps.length, 4);
    // The board says what it is; a message repeating it would sit there forever.
    assert.strictEqual(state.message, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a flow on disk that will not load still lets the window open', () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'flow.json'), '{ "steps": [ ');
  try {
    const app = createApp({ projectDir: dir });
    assert.strictEqual(app.publicState().phase, 'idle');
    assert.match(app.readStory().problem, /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the narration key -------------------------------------------------

/** An app whose key check answers however the test wants, without a network. */
async function withKeyApp(answer, fn) {
  const dir = makeProject();
  const seen = [];
  const app = createApp({
    projectDir: dir,
    verifyKeyFn: (key) => { seen.push(key); return Promise.resolve(answer); },
  });
  const url = await app.listen();
  const base = new URL(url).origin;
  const call = (p, body) => fetch(`${base}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-tutvid-token': app.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    return await fn({ app, call, dir, seen });
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const keyOf = (s) => s.secrets.find((x) => x.name === 'ELEVENLABS_API_KEY');

// No flow asks for it, so the old "what does the flow want" list never had it,
// and there was nowhere in the window to put one.
test('the narration key is offered even though no flow asks for it', async () => {
  await withApp(async ({ call }) => {
    const s = await call('/api/settings').then((r) => r.json());
    const key = keyOf(s);
    assert.ok(key, 'it should always be on the list');
    assert.strictEqual(key.role, 'narration', 'and marked apart from site passwords');
    assert.strictEqual(key.set, false);
    assert.strictEqual(s.secrets[0].name, 'ELEVENLABS_API_KEY', 'offered first');
  });
});

test('saving a key stores it and turns narration on', async () => {
  await withKeyApp({ state: 'accepted', reason: '' }, async ({ call, dir, seen }) => {
    const before = await call('/api/settings').then((r) => r.json());
    assert.strictEqual(before.ready.narration, false, 'nothing to speak with yet');

    const after = await call('/api/settings', {
      secrets: { ELEVENLABS_API_KEY: 'sk_test_abc' },
    }).then((r) => r.json());

    assert.deepStrictEqual(seen, ['sk_test_abc'], 'the key is checked before it is kept');
    assert.strictEqual(after.keyCheck.state, 'accepted');
    assert.strictEqual(keyOf(after).set, true);
    assert.strictEqual(after.ready.narration, true, 'the window can offer spoken narration now');

    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.secrets.json'), 'utf8'));
    assert.strictEqual(saved.ELEVENLABS_API_KEY, 'sk_test_abc');
  });
});

// The rule for every other secret holds for this one: the window is told which
// names are set, never what they are.
test('a saved key is never handed back to the window', async () => {
  await withKeyApp({ state: 'accepted', reason: '' }, async ({ call }) => {
    await call('/api/settings', { secrets: { ELEVENLABS_API_KEY: 'sk_do_not_leak' } });
    for (const path_ of ['/api/settings', '/api/setup']) {
      const body = await call(path_).then((r) => r.text());
      assert.ok(!body.includes('sk_do_not_leak'), `${path_} must not carry the value`);
    }
  });
});

// Without this, a typo is only discovered three minutes into a render.
test('a key ElevenLabs turns down is refused, not quietly kept', async () => {
  await withKeyApp({ state: 'rejected', reason: 'ElevenLabs turned it down (401).' },
    async ({ call, dir }) => {
      const res = await call('/api/settings', { secrets: { ELEVENLABS_API_KEY: 'nope' } });
      assert.strictEqual(res.status, 400);
      assert.match((await res.json()).error, /ElevenLabs key/);
      assert.ok(!fs.existsSync(path.join(dir, '.secrets.json')), 'nothing was written');
    });
});

// Being offline is not the key's fault, and refusing to save would leave
// somebody unable to set one up on a machine behind a proxy.
test('a key that could not be checked is saved, and says so', async () => {
  await withKeyApp({ state: 'unchecked', reason: 'fetch failed' }, async ({ call, dir }) => {
    const after = await call('/api/settings', { secrets: { ELEVENLABS_API_KEY: 'sk_maybe' } })
      .then((r) => r.json());
    assert.strictEqual(after.keyCheck.state, 'unchecked');
    assert.strictEqual(keyOf(after).set, true);
    assert.strictEqual(after.ready.narration, true);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(dir, '.secrets.json'), 'utf8')).ELEVENLABS_API_KEY,
      'sk_maybe'
    );
  });
});

test('saving anything else does not go asking ElevenLabs about it', async () => {
  await withKeyApp({ state: 'rejected', reason: 'should never be consulted' },
    async ({ call, seen }) => {
      const res = await call('/api/settings', { values: { 'flow.minStepMs': 1500 } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(seen, []);
    });
});

test('a key in the environment wins, and is reported as coming from there', async () => {
  process.env.ELEVENLABS_API_KEY = 'from-the-shell';
  try {
    await withApp(async ({ call }) => {
      const s = await call('/api/settings').then((r) => r.json());
      assert.strictEqual(keyOf(s).fromEnvironment, true);
      assert.strictEqual(keyOf(s).set, false);
      assert.strictEqual(s.ready.narration, true);
    });
  } finally {
    delete process.env.ELEVENLABS_API_KEY;
  }
});

// --- the voice ----------------------------------------------------------

test('the window offers the voices the project lists', async () => {
  await withApp(async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify([
      { id: 'nl_sanne', name: 'Sanne (Dutch)' },
      { id: 'nl_tom', name: 'Tom (Dutch, low)' },
    ]));

    const s = await call('/api/settings').then((r) => r.json());
    assert.deepStrictEqual(s.voices.map((v) => v.name), ['Sanne (Dutch)', 'Tom (Dutch, low)']);
    assert.ok(s.fields.some((f) => f.key === 'flow.voiceId' && f.type === 'voice'));

    const after = await call('/api/settings', { values: { 'flow.voiceId': 'nl_tom' } })
      .then((r) => r.json());
    assert.strictEqual(after.values['flow.voiceId'], 'nl_tom');

    const layer = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.strictEqual(layer.flow.voiceId, 'nl_tom', 'and it lands where the CLI reads it');
  });
});

// The dropdown is built from voices.json, so anything else came another way.
test('a voice the project does not list is refused', async () => {
  await withApp(async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify([{ id: 'nl_sanne', name: 'Sanne' }]));
    const res = await call('/api/settings', { values: { 'flow.voiceId': 'somebody-elses' } });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /not in voices.json/);
    assert.ok(!fs.existsSync(path.join(dir, 'settings.json')), 'nothing was written');
  });
});

test('a voices.json with a mistake in it is reported, not swallowed', async () => {
  await withApp(async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, 'voices.json'), '[{ "name": "no id here" }]');
    const s = await call('/api/settings').then((r) => r.json());
    assert.match(s.problem, /needs an ElevenLabs voice "id"/);
    assert.ok(s.fields.length, 'and the rest of the form still works');
  });
});

// --- styles -------------------------------------------------------------

test('the settings screen answers for the style it was asked about', async () => {
  await withApp(async ({ call }) => {
    const dflt = await call('/api/settings').then((r) => r.json());
    const rebels = await call('/api/settings?style=theme-rebels.json').then((r) => r.json());

    assert.strictEqual(dflt.style, 'theme.json');
    assert.strictEqual(rebels.style, 'theme-rebels.json');
    assert.notStrictEqual(dflt.values['theme.highlight.color'], rebels.values['theme.highlight.color']);
    assert.strictEqual(rebels.values['theme.intro.title'], 'Q Portal');
    assert.ok(rebels.styles.some((t) => t.file === 'theme-rebels.json'), 'and lists what there is');
  });
});

// This is the bug the split exists to fix: editing one style used to change
// every style, because there was only ever one pile of visual settings.
test('editing one style leaves the others as they were', async () => {
  await withApp(async ({ call, dir }) => {
    const before = await call('/api/settings?style=theme-rebels.json').then((r) => r.json());
    await call('/api/settings', {
      style: 'theme.json',
      values: { 'theme.highlight.color': '#00FF00', 'theme.intro.title': 'Changed' },
    });

    const after = await call('/api/settings?style=theme-rebels.json').then((r) => r.json());
    assert.strictEqual(after.values['theme.highlight.color'], before.values['theme.highlight.color']);
    assert.strictEqual(after.values['theme.intro.title'], 'Q Portal');

    const dflt = await call('/api/settings?style=theme.json').then((r) => r.json());
    assert.strictEqual(dflt.values['theme.highlight.color'], '#00FF00');

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.ok(!('theme-rebels.json' in written.styles), 'nothing was written against the other one');
  });
});

test('the storyboard style is remembered and is what gets rendered', async () => {
  await withApp(async ({ call, dir, app }) => {
    assert.strictEqual(app.currentStyle(), 'theme.json');

    const res = await call('/api/style', { style: 'theme-rebels.json' }).then((r) => r.json());
    assert.strictEqual(res.style, 'theme-rebels.json');
    assert.strictEqual(app.currentStyle(), 'theme-rebels.json');

    // Which is also what the settings screen and the storyboard timings read.
    const s = await call('/api/settings').then((r) => r.json());
    assert.strictEqual(s.style, 'theme-rebels.json');

    const setup = await call('/api/setup').then((r) => r.json());
    assert.strictEqual(setup.style, 'theme-rebels.json');

    // And it survives the window being closed.
    const reopened = createApp({ projectDir: dir });
    assert.strictEqual(reopened.currentStyle(), 'theme-rebels.json');
  });
});

test('a style that is not there is refused rather than rendered', async () => {
  await withApp(async ({ call, app }) => {
    for (const bad of ['nope.json', '', 'theme-nope.json', 'package.json', '.']) {
      const res = await call('/api/style', { style: bad });
      assert.strictEqual(res.status, 400, `"${bad}" should be refused`);
    }
    // A path is reduced to a name, so it lands on a style in this project or
    // on nothing at all. It never reaches outside the folder.
    const res = await call('/api/style', { style: '../../theme.json' }).then((r) => r.json());
    assert.strictEqual(res.style, 'theme.json');
    assert.strictEqual(app.currentStyle(), 'theme.json');
  });
});

test('a new style starts as a copy of the one it came from', async () => {
  await withApp(async ({ call, dir }) => {
    await call('/api/settings', {
      style: 'theme-rebels.json',
      values: { 'theme.highlight.color': '#123456' },
    });

    const made = await call('/api/style', { newName: 'Q Portal dark', from: 'theme-rebels.json' })
      .then((r) => r.json());

    assert.strictEqual(made.style, 'theme-q-portal-dark.json');
    assert.ok(fs.existsSync(path.join(dir, 'theme-q-portal-dark.json')), 'it is a real style file');
    assert.strictEqual(made.values['theme.intro.title'], 'Q Portal', 'copied from its parent');
    assert.strictEqual(made.values['theme.highlight.color'], '#123456',
      'edits and all, so it starts where its parent left off');

    // The comments that explain the file survive: it is a copy, not a re-dump.
    assert.ok(fs.readFileSync(path.join(dir, 'theme-q-portal-dark.json'), 'utf8').includes('//'));

    // And editing it does not reach back into the one it came from.
    await call('/api/settings', {
      style: 'theme-q-portal-dark.json',
      values: { 'theme.highlight.color': '#ABCDEF' },
    });
    const parent = await call('/api/settings?style=theme-rebels.json').then((r) => r.json());
    assert.strictEqual(parent.values['theme.highlight.color'], '#123456');
  });
});

test('a new style needs a name that becomes a usable file name', async () => {
  await withApp(async ({ call }) => {
    for (const bad of ['', '   ', '///']) {
      assert.strictEqual((await call('/api/style', { newName: bad })).status, 400, `"${bad}"`);
    }
    await call('/api/style', { newName: 'Portal' });
    const again = await call('/api/style', { newName: 'portal' });
    assert.strictEqual(again.status, 400, 'two styles cannot share a file');
    assert.match((await again.json()).error, /already a style/);
  });
});

// --- sound --------------------------------------------------------------

function withClips(dir, names) {
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(dir, 'audio', name), 'pretend audio');
  }
}

test('the audio folder is offered to the cards and to the music', async () => {
  await withApp(async ({ call, dir }) => {
    withClips(dir, ['brand-sting.mp3', 'soft-loop.mp3']);
    const s = await call('/api/settings').then((r) => r.json());

    assert.deepStrictEqual(s.sounds, [
      { file: 'brand-sting.mp3', label: 'Brand sting' },
      { file: 'soft-loop.mp3', label: 'Soft loop' },
    ]);
    const keys = s.fields.filter((f) => f.type === 'sound').map((f) => f.key);
    assert.deepStrictEqual(keys.sort(),
      ['theme.intro.audio', 'theme.music.file', 'theme.outro.audio']);
    assert.ok(s.fields.filter((f) => f.type === 'sound').every((f) => f.tab === 'style'),
      'sound belongs to a style, like everything else you can see or hear');
  });
});

test('a clip lands in the style, and one that is not there is refused', async () => {
  await withApp(async ({ call, dir }) => {
    withClips(dir, ['brand-sting.mp3']);
    await call('/api/settings', {
      style: 'theme.json',
      values: { 'theme.intro.audio': 'brand-sting.mp3', 'theme.music.volume': 0.1 },
    });

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.strictEqual(written.styles['theme.json'].intro.audio, 'brand-sting.mp3');
    assert.strictEqual(written.styles['theme.json'].music.volume, 0.1);

    const bad = await call('/api/settings', { values: { 'theme.music.file': 'nowhere.mp3' } });
    assert.strictEqual(bad.status, 400);
    assert.match((await bad.json()).error, /no clip called "nowhere.mp3".*brand-sting.mp3/s);
  });
});

// Hearing a clip is the only way to know it is the right one.
test('a clip can be played back, and only a clip in the folder', async () => {
  await withApp(async ({ call, dir }) => {
    withClips(dir, ['brand-sting.mp3']);
    fs.writeFileSync(path.join(dir, 'secret.json'), 'shh');

    const ok = await call('/api/sound?name=brand-sting.mp3');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('content-type'), 'audio/mpeg');
    assert.strictEqual(await ok.text(), 'pretend audio');

    for (const bad of ['../secret.json', 'audio/brand-sting.mp3', 'nothing.mp3', '']) {
      assert.strictEqual((await call(`/api/sound?name=${encodeURIComponent(bad)}`)).status, 404,
        `"${bad}" must not be served`);
    }
  });
});

test('the voice can be given a style, a speed and a language', async () => {
  await withApp(async ({ call, dir }) => {
    const s = await call('/api/settings').then((r) => r.json());
    const narration = s.fields.filter((f) => f.section === 'Narration').map((f) => f.key);
    assert.deepStrictEqual(narration.sort(), [
      'flow.narration', 'flow.voiceId', 'flow.voiceLanguage', 'flow.voiceModel',
      'flow.voiceSpeed', 'flow.voiceStyle',
    ]);

    await call('/api/settings', {
      values: {
        'flow.voiceModel': 'eleven_v3',
        'flow.voiceLanguage': 'nl',
        'flow.voiceStyle': 0.26,
        'flow.voiceSpeed': 0.9,
      },
    });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.deepStrictEqual(written.flow, {
      voiceModel: 'eleven_v3', voiceLanguage: 'nl', voiceStyle: 0.26, voiceSpeed: 0.9,
    });

    // They hold for the project, not for one style.
    assert.ok(!JSON.stringify(written.styles).includes('voiceSpeed'));
  });
});

test('a speed ElevenLabs would refuse comes back as a sentence', async () => {
  await withApp(async ({ call }) => {
    const res = await call('/api/settings', { values: { 'flow.voiceSpeed': 2 } });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /cannot be above 1.2/);
  });
});

// --- what the storyboard switches are ------------------------------------

// They used to be a choice made afresh every time the window opened, and
// nothing wrote them down. Opening the tool the next day and finding the
// subtitles off again is how they came to be missing from a video.
test('narration and subtitles are saved, not remembered for one window', async () => {
  await withApp(async ({ call, dir }) => {
    const setup = await call('/api/setup').then((r) => r.json());
    assert.deepStrictEqual(setup.options, { narration: true, captions: false });

    await call('/api/settings', { style: 'theme.json', values: { 'theme.captions.enabled': true } });
    await call('/api/settings', { values: { 'flow.narration': false } });

    const after = await call('/api/setup').then((r) => r.json());
    assert.deepStrictEqual(after.options, { narration: false, captions: true });

    // A fresh window opens on the same answer.
    const reopened = createApp({ projectDir: dir });
    assert.strictEqual(reopened.readSettings().values['theme.captions.enabled'], true);
    assert.strictEqual(reopened.readSettings().values['flow.narration'], false);
  });
});

// Subtitles are part of a style, so one style can burn them in and another not.
test('subtitles belong to the style, narration to the project', async () => {
  await withApp(async ({ call }) => {
    await call('/api/settings', { style: 'theme.json', values: { 'theme.captions.enabled': true } });

    const rebels = await call('/api/settings?style=theme-rebels.json').then((r) => r.json());
    assert.strictEqual(rebels.values['theme.captions.enabled'], false, 'the other style is its own');

    const picked = await call('/api/style', { style: 'theme-rebels.json' }).then((r) => r.json());
    assert.strictEqual(picked.options.captions, false, 'and the storyboard follows the style');

    await call('/api/style', { style: 'theme.json' });
    const back = await call('/api/setup').then((r) => r.json());
    assert.strictEqual(back.options.captions, true);
  });
});

test('hints can be turned off, and are on until they are', async () => {
  await withApp(async ({ call }) => {
    const s = await call('/api/settings').then((r) => r.json());
    assert.strictEqual(s.values['theme.hints.enabled'], true);

    await call('/api/settings', { values: { 'theme.hints.enabled': false } });
    const off = await call('/api/settings').then((r) => r.json());
    assert.strictEqual(off.values['theme.hints.enabled'], false);
  });
});

/* ---------------------------------------------------------------------- *
 * The card, previewed. The same builder the renderer uses, from values that
 * have not been saved.
 * ---------------------------------------------------------------------- */

test('the card preview is the renderer\u2019s own card, not an impression of one', async () => {
  await withApp(async ({ call }) => {
    const data = await call('/api/card-preview', {
      card: 'intro',
      values: { 'theme.intro.title': 'Booking a holiday', 'theme.intro.logo': 'logo.svg' },
    }).then((r) => r.json());

    assert.strictEqual(data.width, 1920);
    assert.strictEqual(data.height, 1080);
    assert.ok(data.html.includes('Booking a holiday'));
    // Inlined the way the renderer inlines them, so the preview cannot show a
    // font or a logo the video will not have.
    assert.ok(/@font-face/.test(data.html), 'the face is embedded');
    assert.ok(/src="data:image\/svg\+xml;base64,/.test(data.html), 'the logo is embedded');
    assert.ok(!/file:\/\//.test(data.html), 'nothing is left pointing at the disk');
  });
});

test('a value still being typed does not take the preview down with it', async () => {
  await withApp(async ({ call }) => {
    const res = await call('/api/card-preview', {
      card: 'outro',
      values: {
        'theme.outro.title': 'Thanks for watching',
        'theme.outro.backgroundColor': '#12',
        'theme.outro.durationSec': '',
      },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.html.includes('Thanks for watching'));
    assert.ok(!data.html.includes('#12;'), 'the unfinished colour was left out');
  });
});

// The form is a form. It must not be able to point the preview at a file.
test('the preview will not read a picture from outside the assets folder', async () => {
  await withApp(async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, 'secret.png'), 'not yours');
    for (const bad of ['../secret.png', '/etc/passwd.png', 'assets/../secret.png']) {
      const data = await call('/api/card-preview', {
        card: 'intro',
        values: { 'theme.intro.title': 'x', 'theme.intro.logo': bad },
      }).then((r) => r.json());
      assert.ok(!/<img class="logo"/.test(data.html), `${bad} was drawn`);
      assert.ok(!/not yours/.test(data.html), `${bad} was read`);
    }
  });
});

/* ---------------------------------------------------------------------- *
 * Putting a file into the project from the window.
 * ---------------------------------------------------------------------- */

async function upload(base, token, kind, name, body) {
  const res = await fetch(
    `${base}/api/upload?kind=${kind}&name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { 'x-tutvid-token': token }, body }
  );
  return { status: res.status, data: await res.json() };
}

test('an uploaded picture is on disk and in the list that comes back', async () => {
  await withApp(async ({ base, app, dir }) => {
    const bytes = fs.readFileSync(path.join(REPO, 'assets', 'logo.png'));
    const { status, data } = await upload(base, app.token, 'image', 'My Mark.png', bytes);

    assert.strictEqual(status, 200);
    assert.strictEqual(data.name, 'My Mark.png');
    assert.ok(fs.existsSync(path.join(dir, 'assets', 'My Mark.png')));
    assert.ok(data.images.some((im) => im.file === 'My Mark.png'),
      'the refreshed listing carries it, so no reload is needed');
    // And the picker can now be set to it, which is the whole point.
    const saved = await app.writeSettings({ 'theme.intro.logo': 'My Mark.png' }, null);
    assert.strictEqual(saved.values['theme.intro.logo'], 'My Mark.png');
  });
});

test('an upload cannot write outside the folder for its kind', async () => {
  await withApp(async ({ base, app, dir }) => {
    for (const sent of ['../../escaped.png', 'C:\\escaped.png', '../fonts/escaped.png']) {
      const { status, data } = await upload(base, app.token, 'image', sent, Buffer.from('x'));
      assert.strictEqual(status, 200, sent);
      // All three are the same name once the path is stripped, so the second
      // and third step aside rather than overwriting the first.
      assert.match(data.name, /^escaped(-\d)?\.png$/, sent);
      assert.ok(fs.existsSync(path.join(dir, 'assets', data.name)), sent);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'escaped.png')));
    assert.ok(!fs.existsSync(path.join(dir, 'fonts', 'escaped.png')));
  });
});

// Closing the socket would be cheaper and would land on the page as a network
// error, with nothing to read. This answer is one somebody can act on.
test('a file over the limit is refused with the size in the message', async () => {
  await withApp(async ({ base, app, dir }) => {
    const { status, data } = await upload(
      base, app.token, 'image', 'huge.png', Buffer.alloc(9 * 1024 * 1024)
    );
    assert.strictEqual(status, 400);
    assert.match(data.error, /9\.0 MB, and the limit is 8 MB/);
    assert.ok(!fs.existsSync(path.join(dir, 'assets', 'huge.png')));

    // And the server is still there afterwards.
    const after = await upload(base, app.token, 'image', 'small.png', Buffer.from('x'));
    assert.strictEqual(after.status, 200);
  });
});

test('there is nowhere to put a kind the window does not have', async () => {
  await withApp(async ({ base, app, dir }) => {
    for (const kind of ['font', 'video', '', '__proto__']) {
      const { status } = await upload(base, app.token, kind, 'x.png', Buffer.from('x'));
      assert.strictEqual(status, 400, kind);
    }
    assert.deepStrictEqual(
      fs.readdirSync(dir).filter((f) => !/^(theme|fonts|assets)/.test(f)), []
    );
  });
});

/* ---------------------------------------------------------------------- *
 * Hearing a voice before choosing it.
 * ---------------------------------------------------------------------- */

const VOICES = [
  { id: 'v3voice', name: 'Roland', model: 'eleven_v3' },
  { id: 'v2voice', name: 'Remko', model: 'eleven_multilingual_v2' },
  { id: 'anyvoice', name: 'Rachel' },
];

async function withVoices(fn, options = {}) {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify(VOICES));
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify({
    name: 'x', baseUrl: 'https://x.test',
    steps: [{ action: 'goto', url: '/', narration: 'Welcome to the portal. Here you fill in your hours for the week.' }],
  }));
  const calls = [];
  const app = createApp({
    projectDir: dir,
    synthesizeFn: async (steps, opts) => {
      calls.push({ text: steps[0].narration, ...opts });
      const file = path.join(dir, 'sample.mp3');
      fs.writeFileSync(file, Buffer.from('ID3fake'));
      return [{ file, durationSec: 1 }];
    },
    ...options,
  });
  const url = await app.listen();
  const base = new URL(url).origin;
  const call = (p, body) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'x-tutvid-token': app.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const saved = process.env.ELEVENLABS_API_KEY;
  try {
    return await fn({ app, call, calls, dir });
  } finally {
    if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = saved;
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a voice that names its model is read by that model, whatever the setting says', async () => {
  await withVoices(async ({ call, calls }) => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    let res = await call('/api/voice-preview', {
      values: { 'flow.voiceId': 'v3voice', 'flow.voiceModel': 'eleven_multilingual_v2' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-voice-model'), 'eleven_v3');
    assert.strictEqual(calls[0].modelId, 'eleven_v3');
    assert.strictEqual(calls[0].voiceId, 'v3voice');

    // A voice without a model of its own follows the setting.
    res = await call('/api/voice-preview', {
      values: { 'flow.voiceId': 'anyvoice', 'flow.voiceModel': 'eleven_turbo_v2_5' },
    });
    assert.strictEqual(calls[1].modelId, 'eleven_turbo_v2_5');
  });
});

test('the sample is the walkthrough’s own first line, cut to a sentence', async () => {
  await withVoices(async ({ call, calls }) => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    await call('/api/voice-preview', { values: { 'flow.voiceId': 'anyvoice' } });
    assert.strictEqual(calls[0].text, 'Welcome to the portal. Here you fill in your hours for the week.');
    // Through the project's own cache, so the render finds it already paid for.
    assert.match(calls[0].cacheDir, /\.tts-cache$/);
  });
});

test('without a key the sample says what is missing rather than failing somewhere', async () => {
  await withVoices(async ({ call, calls }) => {
    delete process.env.ELEVENLABS_API_KEY;
    const res = await call('/api/voice-preview', { values: { 'flow.voiceId': 'anyvoice' } });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /needs an ElevenLabs key/);
    assert.strictEqual(calls.length, 0, 'nothing was synthesised');
  });
});

test('a voices.json naming a model that does not exist says so', () => {
  const { loadVoices } = require('../src/voices');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-voices-'));
  fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify([{ id: 'a', name: 'A', model: 'eleven_v9' }]));
  assert.throws(() => loadVoices(dir), /"model" is "eleven_v9". Use one of/);
  fs.rmSync(dir, { recursive: true, force: true });
});
