'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { verifyKey, estimateDuration } = require('../src/tts');

/** A stand-in for fetch that answers however the test needs it to. */
const answers = (result) => (url, init) => {
  answers.lastUrl = url;
  answers.lastKey = init && init.headers && init.headers['xi-api-key'];
  return typeof result === 'function' ? result() : Promise.resolve(result);
};

test('a key ElevenLabs accepts comes back accepted', async () => {
  const check = await verifyKey('sk_good', answers({ ok: true, status: 200 }));
  assert.strictEqual(check.state, 'accepted');
  assert.strictEqual(answers.lastKey, 'sk_good', 'sent as the api key header, not in the url');
  assert.ok(!String(answers.lastUrl).includes('sk_good'), 'and never in the url');
});

test('a key it turns down is rejected, and says so', async () => {
  for (const status of [401, 403]) {
    const check = await verifyKey('sk_bad', answers({ ok: false, status }));
    assert.strictEqual(check.state, 'rejected');
    assert.match(check.reason, new RegExp(String(status)));
  }
});

test('an empty box is rejected without asking anyone', async () => {
  const never = () => { throw new Error('should not have been called'); };
  assert.strictEqual((await verifyKey('', never)).state, 'rejected');
  assert.strictEqual((await verifyKey(null, never)).state, 'rejected');
});

// Being offline is not the key's fault. Answering "rejected" here would leave
// somebody on a locked-down network unable to set a key up at all.
test('a network that cannot be reached leaves the verdict open', async () => {
  const offline = await verifyKey('sk_maybe', answers(() => Promise.reject(new Error('fetch failed\nENOTFOUND'))));
  assert.strictEqual(offline.state, 'unchecked');
  assert.strictEqual(offline.reason, 'fetch failed', 'the first line, not a stack');

  const wobbly = await verifyKey('sk_maybe', answers({ ok: false, status: 503 }));
  assert.strictEqual(wobbly.state, 'unchecked');
});

// The recorder holds a step for as long as its line takes to say, so this
// number and the one the storyboard shows have to be the same number.
test('the spoken-length estimate is the shared one', () => {
  const { estimateDuration: shared } = require('../src/pacing');
  assert.strictEqual(estimateDuration, shared);
});

// --- voice settings -----------------------------------------------------

const { voiceSettingsFrom, defaultVoiceSettings, cacheKey, MODELS } = require('../src/tts');

test('style and speed are taken as asked, and the rest keeps its default', () => {
  assert.deepStrictEqual(voiceSettingsFrom({ style: 0.26, speed: 0.9 }), {
    stability: 0.5, similarity_boost: 0.75, style: 0.26, speed: 0.9, use_speaker_boost: true,
  });
  // Nothing set is the voice as it comes.
  assert.deepStrictEqual(voiceSettingsFrom({}), defaultVoiceSettings());
  assert.deepStrictEqual(voiceSettingsFrom({ style: null, speed: '' }), defaultVoiceSettings());
  assert.strictEqual(voiceSettingsFrom({ speed: '0.85' }).speed, 0.85, 'a form sends strings');
});

// A 422 three minutes into a render is a bad way to learn that speed tops out.
test('a value ElevenLabs would refuse is refused here, with the range', () => {
  assert.throws(() => voiceSettingsFrom({ speed: 2 }), /speed has to be between 0.7 and 1.2/);
  assert.throws(() => voiceSettingsFrom({ speed: 0.5 }), /between 0.7 and 1.2/);
  assert.throws(() => voiceSettingsFrom({ style: 1.5 }), /style has to be between 0 and 1/);
  assert.throws(() => voiceSettingsFrom({ stability: -1 }), /between 0 and 1/);
  assert.throws(() => voiceSettingsFrom({ speed: 'quickly' }), /between 0.7 and 1.2/);
});

test('the language is part of what a cached clip was made from', () => {
  const base = { voiceId: 'v', modelId: 'm', voiceSettings: defaultVoiceSettings() };
  const plain = cacheKey('Hallo', base);
  assert.strictEqual(cacheKey('Hallo', base), plain, 'the same request is the same file');
  assert.notStrictEqual(cacheKey('Hallo', { ...base, languageCode: 'nl' }), plain);
  assert.notStrictEqual(
    cacheKey('Hallo', { ...base, languageCode: 'nl' }),
    cacheKey('Hallo', { ...base, languageCode: 'en' })
  );
  assert.notStrictEqual(
    cacheKey('Hallo', { ...base, voiceSettings: voiceSettingsFrom({ speed: 0.9 }) }), plain,
    'and so is the speed it was read at'
  );
});

test('the models on offer say which of them take a language code', () => {
  assert.ok(MODELS.length >= 3);
  assert.ok(MODELS.every((m) => m.id && m.label && typeof m.languageCode === 'boolean'));
  const v3 = MODELS.find((m) => m.id === 'eleven_v3');
  assert.strictEqual(v3.languageCode, true);
  // ElevenLabs ignores language_code on this one, and the help text says so.
  assert.strictEqual(MODELS.find((m) => m.id === 'eleven_multilingual_v2').languageCode, false);
});
