'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

const tts = require('../src/tts');
const { verifyKey, estimateDuration } = tts;

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

// --- how a line is handed over ------------------------------------------

const { polishLine, synthesizeAll } = require('../src/tts');

// ElevenLabs reads prosody off the punctuation. A line with no full stop is an
// unfinished clause, and the voice ends it suspended, as though drawing breath
// for whatever comes next. Nobody types a full stop into a one-line box.
test('a line is handed over as a finished sentence', () => {
  assert.strictEqual(polishLine('Your hours are top left'), 'Your hours are top left.');
  assert.strictEqual(polishLine('  spaces   collapse  '), 'spaces collapse.');

  // Punctuation that already ends a sentence is left alone.
  assert.strictEqual(polishLine('Already done.'), 'Already done.');
  assert.strictEqual(polishLine('Right?'), 'Right?');
  assert.strictEqual(polishLine('Klaar!'), 'Klaar!');
  assert.strictEqual(polishLine('Wacht even...'), 'Wacht even...');

  // A comma, colon or dash at the end is the written form of the very thing
  // this is here to stop, and the next line is seconds away.
  assert.strictEqual(polishLine('Let us look at this,'), 'Let us look at this.');
  assert.strictEqual(polishLine('Three things:'), 'Three things.');
  assert.strictEqual(polishLine('Kijk hier -'), 'Kijk hier.');

  assert.strictEqual(polishLine(''), '');
  assert.strictEqual(polishLine(null), '');
  assert.strictEqual(polishLine('  -  '), '', 'punctuation alone is not a line');
});

/** Run a synthesis with the network stubbed, and return the request bodies. */
async function capture(steps, options = {}) {
  const os = require('os');
  const fsp = require('fs');
  const pathp = require('path');
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'tutvid-tts-'));
  const sent = [];
  const real = global.fetch;
  global.fetch = (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve({
      ok: true,
      status: 200,
      // A second of silence, so probeDuration has something real to read.
      arrayBuffer: () => Promise.resolve(fsp.readFileSync(SILENCE).buffer),
    });
  };
  try {
    const result = await synthesizeAll(steps, { apiKey: 'sk_test', cacheDir: dir, ...options });
    return { sent, result };
  } finally {
    global.fetch = real;
    fsp.rmSync(dir, { recursive: true, force: true });
  }
}

// One mp3 of silence, so the stub can hand back something ffprobe will read.
const SILENCE = (() => {
  const os = require('os');
  const fsp = require('fs');
  const pathp = require('path');
  const { execFileSync } = require('child_process');
  const file = pathp.join(fsp.mkdtempSync(pathp.join(os.tmpdir(), 'tutvid-sil-')), 's.mp3');
  execFileSync(require('../src/ffmpeg').binaries().ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
    '-t', '1', file,
  ]);
  return file;
})();

// Each line used to go over on its own, with nothing around it, so the model
// read every one as the opening of something.
test('a line is told what was said before it, and not what comes after', async () => {
  const { sent } = await capture([
    { narration: 'This is your portal' },
    { action: 'wait' },
    { narration: 'Your hours are top left' },
    { narration: 'And the registration is below' },
  ]);

  assert.strictEqual(sent.length, 3);
  assert.strictEqual(sent[0].body.text, 'This is your portal.');
  assert.ok(!('previous_text' in sent[0].body), 'the first line has nothing before it');

  assert.strictEqual(sent[1].body.previous_text, 'This is your portal.',
    'and it is the polished line, the one that was actually read');
  assert.strictEqual(sent[2].body.previous_text, 'Your hours are top left.');

  // next_text exists, and is deliberately not used: it is for chunks that get
  // butted together, and these land seconds apart at measured timestamps.
  assert.ok(sent.every((r) => !('next_text' in r.body)));
});

test('two lines that read the same in different places are different clips', async () => {
  const { sent } = await capture([
    { narration: 'Here.' },
    { narration: 'Look at this.' },
    { narration: 'Here.' },
  ]);
  // Same words, different context, so neither is a cache hit on the other.
  assert.strictEqual(sent.length, 3);
  assert.strictEqual(sent[0].body.previous_text, undefined);
  assert.strictEqual(sent[2].body.previous_text, 'Look at this.');
});

test('the same walkthrough twice costs nothing the second time', async () => {
  const os = require('os');
  const fsp = require('fs');
  const pathp = require('path');
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'tutvid-tts-'));
  const steps = [{ narration: 'One.' }, { narration: 'Two.' }];
  try {
    const first = await capture(steps, { cacheDir: dir });
    assert.strictEqual(first.sent.length, 2);
    const again = await capture(steps, { cacheDir: dir });
    assert.strictEqual(again.sent.length, 0, 'nothing was asked for twice');
    assert.ok(again.result.every((clip) => clip.cached));
  } finally {
    fsp.rmSync(dir, { recursive: true, force: true });
  }
});

test('the voice, the model and the language all reach the request', async () => {
  const { sent } = await capture([{ narration: 'Hallo daar' }], {
    voiceId: 'nl_tom', modelId: 'eleven_v3', languageCode: 'nl',
    voiceSettings: voiceSettingsFrom({ style: 0.26, speed: 0.9 }),
  });
  assert.match(sent[0].url, /\/nl_tom$/);
  assert.strictEqual(sent[0].body.model_id, 'eleven_v3');
  assert.strictEqual(sent[0].body.language_code, 'nl');
  assert.strictEqual(sent[0].body.voice_settings.style, 0.26);
  // And speed does not, because v3 has none. It used to be sent anyway: the
  // request was accepted, the clip came back at the ordinary pace, and the only
  // sign that the setting had done nothing was that the video sounded the same.
  assert.strictEqual(sent[0].body.voice_settings.speed, undefined);
});

test('a model that does have speed is sent it', async () => {
  const { sent } = await capture([{ narration: 'Hallo daar' }], {
    voiceId: 'nl_tom', modelId: 'eleven_multilingual_v2',
    voiceSettings: voiceSettingsFrom({ style: 0.26, speed: 0.9 }),
  });
  assert.strictEqual(sent[0].body.voice_settings.speed, 0.9);
  assert.strictEqual(sent[0].body.voice_settings.style, 0.26);
  // Multilingual v2 is the one with no language code, so it is not sent one.
  assert.strictEqual(sent[0].body.language_code, undefined);
});

/**
 * Which settings the chosen model actually acts on.
 *
 * The API takes every setting for every model and quietly ignores the ones that
 * model does not implement, which makes a slider that does nothing look exactly
 * like one that works. ElevenLabs' own docs: "Speed is not available for the
 * Eleven v3 model", and the same for Similarity and Speaker Boost.
 */
test('v3 does not take speed, similarity or speaker boost', () => {
  const support = tts.modelSupport('eleven_v3');
  assert.ok(support.includes('stability'));
  assert.ok(support.includes('style'));
  assert.ok(!support.includes('speed'), 'v3 has no speed control');
  assert.ok(!support.includes('similarity_boost'));
  assert.ok(!support.includes('use_speaker_boost'));
  // The models that do take everything still do.
  assert.ok(tts.modelSupport('eleven_multilingual_v2').includes('speed'));
  assert.ok(tts.modelSupport('eleven_turbo_v2_5').includes('speed'));
});

test('multilingual v2 is the one with no language code', () => {
  assert.strictEqual(tts.takesLanguageCode('eleven_multilingual_v2'), false);
  assert.strictEqual(tts.takesLanguageCode('eleven_v3'), true);
  assert.strictEqual(tts.takesLanguageCode('eleven_flash_v2_5'), true);
  // An id this build has never heard of is given the benefit of the doubt
  // rather than having half its settings stripped.
  assert.strictEqual(tts.takesLanguageCode('eleven_something_new'), true);
});

test('a setting the model ignores is dropped, not sent and ignored', () => {
  const asked = { stability: 0.4, similarity_boost: 0.75, style: 0.3, speed: 0.8, use_speaker_boost: true };
  const { settings, dropped } = tts.settingsForModel(asked, 'eleven_v3');
  assert.deepStrictEqual(settings, { stability: 0.4, style: 0.3 });
  assert.deepStrictEqual(dropped.sort(), ['similarity_boost', 'speed', 'use_speaker_boost']);
});

test('dropping it keeps the cache honest, which is the whole point', () => {
  // Two runs that differ only in a setting v3 ignores must hit the same clip.
  // Otherwise moving that slider buys a fresh, identical file at full price.
  const base = { voiceId: 'v', modelId: 'eleven_v3', languageCode: 'nl' };
  const slow = tts.settingsForModel({ stability: 0.5, speed: 0.8 }, 'eleven_v3').settings;
  const fast = tts.settingsForModel({ stability: 0.5, speed: 1.2 }, 'eleven_v3').settings;
  assert.strictEqual(
    tts.cacheKey('Hallo.', { ...base, voiceSettings: slow }),
    tts.cacheKey('Hallo.', { ...base, voiceSettings: fast })
  );

  // And on a model that does use speed, they must not.
  const m2 = { voiceId: 'v', modelId: 'eleven_multilingual_v2', languageCode: null };
  const s2 = tts.settingsForModel({ stability: 0.5, speed: 0.8 }, m2.modelId).settings;
  const f2 = tts.settingsForModel({ stability: 0.5, speed: 1.2 }, m2.modelId).settings;
  assert.notStrictEqual(
    tts.cacheKey('Hallo.', { ...m2, voiceSettings: s2 }),
    tts.cacheKey('Hallo.', { ...m2, voiceSettings: f2 })
  );
});

test('a run says out loud which of your settings the model is ignoring', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-tts-inert-'));
  const lines = [];
  await tts.synthesizeAll([{ narration: 'Hallo daar.' }], {
    noTts: true,
    cacheDir: dir,
    modelId: 'eleven_v3',
    voiceSettings: { stability: 0.5, style: 0.2, speed: 0.85, use_speaker_boost: true },
    log: (l) => lines.push(l),
  });
  const said = lines.join('\n');
  assert.match(said, /v3 does not use/);
  assert.match(said, /speed/);
  // use_speaker_boost was left at its default, so nobody asked for it and
  // nobody needs telling about it.
  assert.ok(!/speaker/i.test(said), said);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a language code on a model with none is called out too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-tts-lang-'));
  const lines = [];
  await tts.synthesizeAll([{ narration: 'Hallo daar.' }], {
    noTts: true,
    cacheDir: dir,
    modelId: 'eleven_multilingual_v2',
    languageCode: 'nl',
    log: (l) => lines.push(l),
  });
  assert.match(lines.join('\n'), /Multilingual v2 has no language code/);
  fs.rmSync(dir, { recursive: true, force: true });
});
