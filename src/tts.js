'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { probeDuration, generateSilence } = require('./ffmpeg');
const { estimateDuration } = require('./pacing');

const API_ROOT = 'https://api.elevenlabs.io/v1';
const API_BASE = `${API_ROOT}/text-to-speech`;
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // Rachel, ElevenLabs' stock voice
const DEFAULT_MODEL = 'eleven_multilingual_v2';

/**
 * The models worth offering, and whether they take a language code. Kept here
 * rather than in the settings list so one place knows what ElevenLabs has.
 */
/**
 * The models, and what each of them actually listens to.
 *
 * This table exists because the API accepts every setting for every model and
 * silently ignores the ones that model does not implement. Ask v3 to read at
 * 0.85 speed and you get a 200, a clip, a bill, and a voice reading at exactly
 * the pace it always does. Nothing anywhere says so.
 *
 * ElevenLabs' own documentation is where these come from: "Speed is not
 * available for the Eleven v3 model", and the same for Similarity and Speaker
 * Boost. language_code is "not supported for multilingual_v2 models".
 *
 * Two things follow. The window can grey out a control the chosen model will
 * ignore instead of offering it and doing nothing. And a setting that is going
 * to be ignored is dropped before the request, which keeps it out of the cache
 * key - otherwise moving a slider that changes nothing invalidates the cache
 * and buys a fresh, identical clip at full price.
 */
const MODELS = [
  {
    id: 'eleven_multilingual_v2',
    label: 'Multilingual v2',
    languageCode: false,
    supports: ['stability', 'similarity_boost', 'style', 'speed', 'use_speaker_boost'],
  },
  {
    id: 'eleven_v3',
    label: 'v3',
    languageCode: true,
    supports: ['stability', 'style'],
  },
  {
    id: 'eleven_turbo_v2_5',
    label: 'Turbo v2.5',
    languageCode: true,
    supports: ['stability', 'similarity_boost', 'style', 'speed', 'use_speaker_boost'],
  },
  {
    id: 'eleven_flash_v2_5',
    label: 'Flash v2.5',
    languageCode: true,
    supports: ['stability', 'similarity_boost', 'style', 'speed', 'use_speaker_boost'],
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/** What this model listens to. An unknown id is assumed to take everything. */
function modelSupport(modelId) {
  const model = BY_ID.get(modelId);
  return model ? model.supports : MODELS[0].supports;
}

/** Does this model read the top-level language_code? */
function takesLanguageCode(modelId) {
  const model = BY_ID.get(modelId);
  return model ? model.languageCode : true;
}

/**
 * The voice settings this model will actually act on, and the names of the ones
 * that were dropped because it will not.
 *
 * Dropped, not sent-and-ignored, so the cache key only ever covers things that
 * can change the sound.
 */
function settingsForModel(voiceSettings, modelId) {
  const allowed = modelSupport(modelId);
  const kept = {};
  const dropped = [];
  for (const [name, value] of Object.entries(voiceSettings || {})) {
    if (allowed.includes(name)) kept[name] = value;
    else dropped.push(name);
  }
  return { settings: kept, dropped };
}

/** The ones a person set deliberately, for a warning worth reading. */
const DEFAULTS_BY_NAME = { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1, use_speaker_boost: true };
const wasSetDeliberately = (name, value) => DEFAULTS_BY_NAME[name] !== value;

/**
 * Narration is generated before the browser starts, never during. That is what
 * lets the recorder hold each step on screen for at least as long as its line
 * takes to say - the durations have to be known up front.
 */

function defaultVoiceSettings() {
  return { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1, use_speaker_boost: true };
}

/** What ElevenLabs will accept, so a typo is caught before it costs a request. */
const SETTING_RANGE = {
  stability: [0, 1],
  similarity_boost: [0, 1],
  style: [0, 1],
  speed: [0.7, 1.2],
};

/**
 * Build the voice_settings body from whatever was asked for, leaving out
 * anything nobody set. A value outside the range ElevenLabs accepts comes back
 * as a sentence rather than as a 422 three minutes into a render.
 */
function voiceSettingsFrom(overrides = {}) {
  const settings = defaultVoiceSettings();
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null || value === undefined || value === '') continue;
    const range = SETTING_RANGE[name];
    if (!range) { settings[name] = value; continue; }
    const number = Number(value);
    if (!Number.isFinite(number) || number < range[0] || number > range[1]) {
      throw new Error(
        `Voice ${name.replace(/_/g, ' ')} has to be between ${range[0]} and ${range[1]} (got ${value}).`
      );
    }
    settings[name] = number;
  }
  return settings;
}

/**
 * Cache key covers everything that can change the audio: the text, the voice,
 * the model and the voice settings. Change any of them and you get a new file;
 * change none and the run costs nothing.
 */
function cacheKey(text, opts) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      text,
      voiceId: opts.voiceId,
      modelId: opts.modelId,
      languageCode: opts.languageCode || null,
      previousText: opts.previousText || null,
      voiceSettings: opts.voiceSettings,
    }))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Terminal punctuation, because its absence is heard.
 *
 * ElevenLabs reads prosody off the punctuation. A line handed over without a
 * full stop is an unfinished clause, and the voice ends it suspended, as though
 * it were drawing breath for whatever comes next. Nobody types a full stop into
 * a one-line box, so one is added here rather than asked for.
 */
function polishLine(text) {
  let line = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!line) return '';

  // A closing quote or bracket can sit after the punctuation that matters, so
  // set it aside and put it back.
  const tail = (line.match(/[)\]}"'\u2019\u201d\u00bb]+$/) || [''])[0];
  if (tail) line = line.slice(0, -tail.length);

  // A comma, colon, semicolon or dash at the end is the written form of exactly
  // what this is meant to stop: it tells the voice to hang, and the next line
  // is seconds away. Every line here is heard on its own, so it ends.
  line = line.replace(/[\s,;:\u2013\u2014-]+$/, '');
  if (!line) return '';
  if (!/[.!?\u2026]$/.test(line)) line += '.';
  return line + tail;
}

async function callElevenLabs(text, opts) {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(opts.voiceId)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': opts.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: opts.modelId,
      voice_settings: opts.voiceSettings,
      // Pins the language for the model and for how it reads numbers and
      // dates. eleven_multilingual_v2 ignores it; v3 and the turbo models
      // honour it, which is what stops a Dutch line being read as English.
      ...(opts.languageCode ? { language_code: opts.languageCode } : {}),
      // What was said before, so the line does not start cold. `next_text` is
      // deliberately left out: it exists for chunks that will be butted
      // together, and these are not. They land seconds apart at measured
      // timestamps, so telling the model that something follows immediately is
      // what makes it lean forward into a sentence nobody has reached yet.
      ...(opts.previousText ? { previous_text: opts.previousText } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('ElevenLabs rejected the API key (401). Check ELEVENLABS_API_KEY.');
    }
    if (res.status === 429) {
      throw new Error('ElevenLabs rate limit or quota reached (429). Try --no-tts while iterating.');
    }
    throw new Error(`ElevenLabs returned ${res.status}: ${detail.slice(0, 400)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Produce one audio clip per step that has narration.
 *
 * Returns an array the same length as `steps`; entries are null where a step
 * has no line to read. Each entry is { file, durationSec, cached }.
 */
async function synthesizeAll(steps, options = {}) {
  const {
    noTts = false,
    cacheDir = path.join(process.cwd(), '.tts-cache'),
    voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE,
    modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL,
    apiKey = process.env.ELEVENLABS_API_KEY,
    voiceSettings = defaultVoiceSettings(),
    languageCode = process.env.ELEVENLABS_LANGUAGE || null,
    log = () => {},
  } = options;

  fs.mkdirSync(cacheDir, { recursive: true });

  const narrated = steps.filter((s) => (s.narration || '').trim());
  if (!noTts && narrated.length && !apiKey) {
    throw new Error(
      'ELEVENLABS_API_KEY is not set, so narration cannot be generated.\n' +
      'Set it, or run with --no-tts to use timed silence instead (free, and the ' +
      'pacing comes out identical).'
    );
  }

  // Settings this model will ignore are dropped rather than sent. Sending them
  // costs nothing at the API and everything in the cache: a slider that changes
  // nothing would still change the key, and the next run would pay for a clip
  // identical to the one it already had.
  const { settings: usable, dropped } = settingsForModel(voiceSettings, modelId);
  const deliberate = dropped.filter((name) => wasSetDeliberately(name, voiceSettings[name]));
  if (deliberate.length) {
    const label = (BY_ID.get(modelId) || {}).label || modelId;
    log(`  ${label} does not use ${deliberate.join(' or ')}; ` +
      `${deliberate.length === 1 ? 'that setting is' : 'those settings are'} being ignored`);
  }
  if (languageCode && !takesLanguageCode(modelId)) {
    const label = (BY_ID.get(modelId) || {}).label || modelId;
    log(`  ${label} has no language code; it follows the text instead, so "${languageCode}" is being ignored`);
  }

  const opts = {
    voiceId,
    modelId,
    apiKey,
    voiceSettings: usable,
    languageCode: takesLanguageCode(modelId) ? (languageCode || null) : null,
  };
  const results = [];
  let hits = 0;
  let misses = 0;

  // What was said before this line, so each one is read as part of a
  // walkthrough rather than as an island.
  let previousText = null;

  for (const step of steps) {
    const raw = (step.narration || '').trim();
    if (!raw) {
      results.push(null);
      continue;
    }
    const text = polishLine(raw);
    const here = { ...opts, previousText };
    previousText = text;

    if (noTts) {
      // Silence long enough to say the line, so blocking and timing match a
      // real run without spending a credit.
      const seconds = estimateDuration(text);
      const file = path.join(cacheDir, `silence-${cacheKey(text, { ...here, voiceId: 'silence' })}.m4a`);
      if (!fs.existsSync(file)) await generateSilence(seconds, file);
      results.push({ file, durationSec: seconds, cached: false, silent: true });
      continue;
    }

    const file = path.join(cacheDir, `${cacheKey(text, here)}.mp3`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      hits++;
      results.push({ file, durationSec: await probeDuration(file), cached: true });
      continue;
    }

    misses++;
    log(`  synthesising: "${truncate(text)}"`);
    const audio = await callElevenLabs(text, here);
    // Write via a temp name so an interrupted run cannot leave a truncated
    // file in the cache that later runs would treat as a hit.
    const tmp = `${file}.part`;
    fs.writeFileSync(tmp, audio);
    fs.renameSync(tmp, file);
    results.push({ file, durationSec: await probeDuration(file), cached: false });
  }

  if (!noTts && narrated.length) {
    log(`  narration: ${hits} cached, ${misses} generated`);
  }
  return results;
}

/**
 * Will ElevenLabs accept this key?
 *
 * Worth one round trip. Without it a mistyped key is discovered three minutes
 * into a render, after the browser has already walked the whole site. A network
 * that cannot be reached is not the key's fault, so that answers "unchecked"
 * rather than "rejected" and the key is still saved.
 */
async function verifyKey(apiKey, fetchImpl = fetch) {
  if (!apiKey) return { state: 'rejected', reason: 'There is nothing there to check.' };
  let res;
  try {
    res = await fetchImpl(`${API_ROOT}/user`, { headers: { 'xi-api-key': apiKey } });
  } catch (err) {
    return { state: 'unchecked', reason: firstLine(err.message) };
  }
  if (res.status === 401 || res.status === 403) {
    return { state: 'rejected', reason: `ElevenLabs turned it down (${res.status}).` };
  }
  if (!res.ok) return { state: 'unchecked', reason: `ElevenLabs answered ${res.status}.` };
  return { state: 'accepted', reason: '' };
}

const firstLine = (text) => String(text || '').split('\n')[0];
const truncate = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

module.exports = {
  synthesizeAll, estimateDuration, cacheKey, defaultVoiceSettings, voiceSettingsFrom,
  polishLine, verifyKey, MODELS, DEFAULT_VOICE, DEFAULT_MODEL,
  modelSupport, settingsForModel, takesLanguageCode,
};
