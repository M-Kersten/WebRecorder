'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadFlow, stripJsonComments } = require('../src/config');
const { resolveUrl, readingTimeMs } = require('../src/recorder');
const { estimateDuration, cacheKey } = require('../src/tts');
const { parseArgs, applyOverrides, initProject } = require('../src/index');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-config-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

let n = 0;
function withFlow(obj) {
  const file = path.join(work, `flow-${n++}.json`);
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return loadFlow(file);
}

const goto = { action: 'goto', url: '/' };

test('a valid flow loads with sensible defaults', () => {
  const flow = withFlow({ steps: [goto] });
  assert.strictEqual(flow.steps.length, 1);
  assert.strictEqual(flow.minStepMs, 1200);
  assert.strictEqual(flow.stepPaddingMs, 600);
});

test('a missing flow file is reported by path', () => {
  assert.throws(() => loadFlow(path.join(work, 'nope.json')), /No flow file found at/);
});

test('an unknown action lists the ones that exist', () => {
  assert.throws(
    () => withFlow({ steps: [{ action: 'swipe', selector: '#x' }] }),
    /unknown action "swipe". Known actions: goto, click, type, hover, scroll, wait/
  );
});

test('a step missing a required field names the field and the step index', () => {
  assert.throws(
    () => withFlow({ steps: [goto, { action: 'click' }] }),
    /steps\[1\] \(action "click"\) is missing required field "selector"/
  );
  assert.throws(
    () => withFlow({ steps: [{ action: 'type', selector: '#a' }] }),
    /missing required field "text"/
  );
});

test('actions with no required fields are accepted bare', () => {
  assert.doesNotThrow(() => withFlow({ steps: [{ action: 'wait' }, { action: 'scroll' }] }));
});

test('an empty or absent steps array is rejected', () => {
  assert.throws(() => withFlow({ steps: [] }), /"steps" must be a non-empty array/);
  assert.throws(() => withFlow({}), /"steps" must be a non-empty array/);
});

test('narration must be a string if present', () => {
  assert.throws(() => withFlow({ steps: [{ ...goto, narration: 42 }] }), /"narration" must be a string/);
});

test('malformed JSON is reported as such, not as a crash', () => {
  assert.throws(() => withFlow('{ "steps": [ '), /is not valid JSON/);
});

test('comments are allowed in flow files, and URLs survive them', () => {
  const flow = withFlow(`{
    // the site under test
    "baseUrl": "http://example.com/a//b",
    /* steps */
    "steps": [ { "action": "goto", "url": "/" } ]
  }`);
  assert.strictEqual(flow.baseUrl, 'http://example.com/a//b');
});

test('stripJsonComments leaves comment-like text inside strings alone', () => {
  assert.strictEqual(stripJsonComments('{"a":"x // y"}'), '{"a":"x // y"}');
  assert.strictEqual(stripJsonComments('{"a":"x /* y */"}'), '{"a":"x /* y */"}');
  assert.strictEqual(stripJsonComments('{"a":"say \\"hi\\" // no"}'), '{"a":"say \\"hi\\" // no"}');
});

test('relative step URLs resolve against baseUrl, absolute ones pass through', () => {
  assert.strictEqual(resolveUrl('/pricing', 'http://x.test'), 'http://x.test/pricing');
  assert.strictEqual(resolveUrl('pricing', 'http://x.test/app'), 'http://x.test/app/pricing');
  assert.strictEqual(resolveUrl('https://other.test/y', 'http://x.test'), 'https://other.test/y');
});

test('a relative URL with no baseUrl is an error rather than a bad request', () => {
  assert.throws(() => resolveUrl('/pricing', null), /relative but the flow has no "baseUrl"/);
});

test('silence length tracks word count, with a floor', () => {
  assert.strictEqual(estimateDuration('hi'), 1.5);
  assert.ok(estimateDuration('one two three four five six seven eight nine ten') > 3);
});

test('the TTS cache key covers everything that changes the audio', () => {
  const base = { voiceId: 'v1', modelId: 'm1', voiceSettings: { stability: 0.5 } };
  const key = cacheKey('hello', base);
  assert.strictEqual(key, cacheKey('hello', base), 'stable for identical input');
  assert.notStrictEqual(key, cacheKey('hello!', base), 'text');
  assert.notStrictEqual(key, cacheKey('hello', { ...base, voiceId: 'v2' }), 'voice');
  assert.notStrictEqual(key, cacheKey('hello', { ...base, modelId: 'm2' }), 'model');
  assert.notStrictEqual(key, cacheKey('hello', { ...base, voiceSettings: { stability: 0.9 } }), 'settings');
});

test('CLI defaults and flags', () => {
  const d = parseArgs([]);
  assert.strictEqual(d.theme, 'theme.json');
  assert.strictEqual(d.flow, 'flow.json');
  assert.strictEqual(d.tts, true);
  // null, not false: an unset flag leaves the theme's own setting alone.
  assert.strictEqual(d.captions, null);
  assert.strictEqual(d.hints, null);
  assert.strictEqual(d.fades, null);

  const custom = parseArgs(['--theme', 'brand.json', '--flow', 'f.json', '--out', 'o.mp4', '--no-tts', '--captions']);
  assert.strictEqual(custom.theme, 'brand.json');
  assert.strictEqual(custom.flow, 'f.json');
  assert.strictEqual(custom.out, 'o.mp4');
  assert.strictEqual(custom.tts, false);
  assert.strictEqual(custom.captions, true);
});

test('CLI flags override the theme, and an unset flag does not', () => {
  const theme = () => ({
    captions: { enabled: false }, hints: { enabled: true }, transitions: { enabled: true },
  });

  const untouched = applyOverrides(theme(), parseArgs([]));
  assert.strictEqual(untouched.captions.enabled, false, 'theme setting survives');
  assert.strictEqual(untouched.hints.enabled, true);

  const on = applyOverrides(theme(), parseArgs(['--captions']));
  assert.strictEqual(on.captions.enabled, true);

  const off = applyOverrides(theme(), parseArgs(['--no-hints', '--no-fades']));
  assert.strictEqual(off.hints.enabled, false);
  assert.strictEqual(off.transitions.enabled, false);
});

test('init is recognised as a command, not an unknown option', () => {
  assert.strictEqual(parseArgs(['init']).command, 'init');
  assert.strictEqual(parseArgs([]).command, null);
  // Only in first position, so a stray "init" later is still an error.
  assert.throws(() => parseArgs(['--no-tts', 'init']), /Unknown option "init"/);
});

test('init scaffolds a theme and a flow, and never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-init-'));
  try {
    initProject(dir);
    const themeFile = path.join(dir, 'theme.json');
    const flowFile = path.join(dir, 'flow.json');
    assert.ok(fs.existsSync(themeFile) && fs.existsSync(flowFile));

    // Both must be loadable by the tools that consume them.
    assert.doesNotThrow(() => loadFlow(flowFile));
    const scaffolded = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
    assert.ok(scaffolded.steps.length >= 1);
    assert.ok(scaffolded.steps.some((s) => s.hint), 'the sample should show what a hint looks like');

    // The scaffolded theme references fonts and a pointer image; a scaffold
    // that does not bring them along fails on the first command a new user runs.
    const { loadTheme } = require('../src/theme');
    assert.doesNotThrow(() => loadTheme(themeFile), 'the scaffold must validate as written');
    assert.ok(fs.existsSync(path.join(dir, 'fonts', 'Inter-Regular.ttf')));
    assert.ok(fs.existsSync(path.join(dir, 'assets', 'cursor.png')));

    fs.writeFileSync(flowFile, '{"mine":true}');
    initProject(dir);
    assert.strictEqual(fs.readFileSync(flowFile, 'utf8'), '{"mine":true}', 'existing files are kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a step hint must be a string', () => {
  assert.doesNotThrow(() => withFlow({ steps: [{ ...goto, hint: 'Look here' }] }));
  assert.throws(() => withFlow({ steps: [{ ...goto, hint: 12 }] }), /"hint" must be a string/);
});

test('reading time scales with the hint, within bounds', () => {
  const short = readingTimeMs('Go');
  const long = readingTimeMs('word '.repeat(40));
  assert.ok(short >= 1800, 'even a two-word hint stays up long enough to read');
  assert.ok(long > short);
  assert.ok(long <= 9000, 'a long hint does not stall the video indefinitely');
});

test('an unknown or valueless option is rejected', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown option "--nope"/);
  assert.throws(() => parseArgs(['--theme']), /--theme needs a value/);
});

// The CLI builds the flow it records from as `loadFlow` plus the settings
// layer, and then hands `flow.voiceId` to the synthesiser. If that merge ever
// stopped carrying keys the loader does not know about, a voice picked in the
// window would silently be ignored.
test('the settings layer reaches the flow, including keys loadFlow never saw', () => {
  const { loadSettings } = require('../src/settings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-merge-'));
  try {
    const flowFile = path.join(dir, 'flow.json');
    fs.writeFileSync(flowFile, JSON.stringify({
      baseUrl: 'https://x.test',
      minStepMs: 1000,
      steps: [{ action: 'goto', url: '/' }],
    }));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      flow: { minStepMs: 2200, voiceId: 'nl_tom' },
    }));

    const settings = loadSettings(path.join(dir, 'settings.json'));
    const flow = Object.assign(loadFlow(flowFile), settings.flow);

    assert.strictEqual(flow.voiceId, 'nl_tom');
    assert.strictEqual(flow.minStepMs, 2200, 'and it still wins over the flow file');
    assert.strictEqual(flow.steps.length, 1, 'without disturbing anything else');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
