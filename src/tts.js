'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { probeDuration, generateSilence } = require('./ffmpeg');
const { estimateDuration } = require('./pacing');

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // Rachel, ElevenLabs' stock voice
const DEFAULT_MODEL = 'eleven_multilingual_v2';

/**
 * Narration is generated before the browser starts, never during. That is what
 * lets the recorder hold each step on screen for at least as long as its line
 * takes to say - the durations have to be known up front.
 */

function defaultVoiceSettings() {
  return { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };
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
      voiceSettings: opts.voiceSettings,
    }))
    .digest('hex')
    .slice(0, 32);
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

  const opts = { voiceId, modelId, apiKey, voiceSettings };
  const results = [];
  let hits = 0;
  let misses = 0;

  for (const step of steps) {
    const text = (step.narration || '').trim();
    if (!text) {
      results.push(null);
      continue;
    }

    if (noTts) {
      // Silence long enough to say the line, so blocking and timing match a
      // real run without spending a credit.
      const seconds = estimateDuration(text);
      const file = path.join(cacheDir, `silence-${cacheKey(text, { ...opts, voiceId: 'silence' })}.m4a`);
      if (!fs.existsSync(file)) await generateSilence(seconds, file);
      results.push({ file, durationSec: seconds, cached: false, silent: true });
      continue;
    }

    const file = path.join(cacheDir, `${cacheKey(text, opts)}.mp3`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      hits++;
      results.push({ file, durationSec: await probeDuration(file), cached: true });
      continue;
    }

    misses++;
    log(`  synthesising: "${truncate(text)}"`);
    const audio = await callElevenLabs(text, opts);
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

const truncate = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

module.exports = { synthesizeAll, estimateDuration, cacheKey, defaultVoiceSettings, DEFAULT_VOICE, DEFAULT_MODEL };
