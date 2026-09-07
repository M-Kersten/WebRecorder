'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadFlow, stripJsonComments } = require('../src/config');
const { resolveUrl } = require('../src/recorder');
const { estimateDuration, cacheKey } = require('../src/tts');
const { parseArgs } = require('../src/index');

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
  assert.strictEqual(d.captions, true);

  const custom = parseArgs(['--theme', 'brand.json', '--flow', 'f.json', '--out', 'o.mp4', '--no-tts', '--no-captions']);
  assert.strictEqual(custom.theme, 'brand.json');
  assert.strictEqual(custom.flow, 'f.json');
  assert.strictEqual(custom.out, 'o.mp4');
  assert.strictEqual(custom.tts, false);
  assert.strictEqual(custom.captions, false);
});

test('an unknown or valueless option is rejected', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown option "--nope"/);
  assert.throws(() => parseArgs(['--theme']), /--theme needs a value/);
});
