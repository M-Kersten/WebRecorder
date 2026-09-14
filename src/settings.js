'use strict';

const fs = require('fs');
const path = require('path');

const { readJson, ConfigError } = require('./config');

/**
 * The settings a person can change from the app window.
 *
 * These live in their own file rather than being written back into theme.json.
 * That file is meant to be read and edited by hand and is full of comments
 * explaining itself; re-serialising it from a form would throw all of that away.
 * So settings.json is a thin layer merged over the theme and the flow at load
 * time, and theme.json stays the document it is.
 *
 * FIELDS is the single list both the window and the validator read, so adding a
 * setting is one entry rather than a change in three places.
 */

const FIELDS = [
  {
    key: 'theme.cursor.moveMs',
    section: 'Movement',
    label: 'Cursor travel time',
    help: 'How long the pointer takes to reach whatever it is about to use. Leave empty to let it follow the distance.',
    type: 'number', unit: 'ms', min: 0, max: 5000, nullable: true,
  },
  {
    key: 'theme.cursor.easing',
    section: 'Movement',
    label: 'How it moves',
    type: 'select',
    options: [
      { value: 'easeInOut', label: 'Ease in and out' },
      { value: 'easeOut', label: 'Fast, then settle' },
      { value: 'linear', label: 'Steady' },
    ],
  },
  {
    key: 'flow.typeDelayMs',
    section: 'Movement',
    label: 'Typing speed',
    help: 'Pause between keystrokes. Zero fills the field instantly, which does not read as typing.',
    type: 'number', unit: 'ms per key', min: 0, max: 500,
  },
  {
    key: 'theme.cursor.ripple',
    section: 'Movement',
    label: 'Ripple where a click lands',
    type: 'boolean',
  },
  {
    key: 'theme.highlight.fadeMs',
    section: 'Movement',
    label: 'Highlight fade',
    help: 'How long the ring takes to appear once the cursor has arrived. It never travels.',
    type: 'number', unit: 'ms', min: 0, max: 3000,
  },

  {
    key: 'flow.minStepMs',
    section: 'Pacing',
    label: 'Shortest a step can be',
    help: 'A floor, so a step with a two-word line still stays on screen long enough to see.',
    type: 'number', unit: 'ms', min: 0, max: 20000,
  },
  {
    key: 'flow.stepPaddingMs',
    section: 'Pacing',
    label: 'Pause after each step',
    help: 'Added once the narration for a step has finished.',
    type: 'number', unit: 'ms', min: 0, max: 10000,
  },
  {
    key: 'theme.hints.fadeMs',
    section: 'Pacing',
    label: 'Hint fade',
    type: 'number', unit: 'ms', min: 0, max: 3000,
  },
  {
    key: 'theme.transitions.fadeSec',
    section: 'Pacing',
    label: 'Fade between segments',
    help: 'Each part of the video fades in from and out to black. Zero cuts straight.',
    type: 'number', unit: 'seconds', min: 0, max: 3, step: 0.05,
  },

  {
    key: 'theme.highlight.color',
    section: 'Colours',
    label: 'Highlight ring',
    help: 'The ring drawn around whatever is being pointed at.',
    type: 'color',
  },
  {
    key: 'theme.cursor.color',
    section: 'Colours',
    label: 'Pointer',
    type: 'color',
  },
  {
    key: 'theme.cursor.strokeColor',
    section: 'Colours',
    label: 'Pointer outline',
    help: 'Keeps the pointer visible over light and dark parts of the page alike.',
    type: 'color',
  },
  {
    key: 'theme.cursor.rippleColor',
    section: 'Colours',
    label: 'Click ripple',
    help: 'Leave empty to use the highlight colour.',
    type: 'color', nullable: true,
  },
  {
    key: 'theme.hints.backgroundColor',
    section: 'Colours',
    label: 'Hint background',
    type: 'color',
  },
  {
    key: 'theme.hints.color',
    section: 'Colours',
    label: 'Hint text',
    type: 'color',
  },
  {
    key: 'theme.video.backgroundColor',
    section: 'Colours',
    label: 'Behind the page',
    help: 'Painted before the site loads, and used to fill any space the page does not cover.',
    type: 'color',
  },

  {
    key: 'theme.hints.font',
    section: 'Type',
    label: 'Hints',
    type: 'font', nullable: true,
  },
  {
    key: 'theme.hints.fontSize',
    section: 'Type',
    label: 'Hint size',
    type: 'number', unit: 'px', min: 10, max: 120,
  },
  {
    key: 'theme.captions.font',
    section: 'Type',
    label: 'Subtitles',
    type: 'font', nullable: true,
  },
  {
    key: 'theme.captions.fontSize',
    section: 'Type',
    label: 'Subtitle size',
    type: 'number', unit: 'px', min: 10, max: 120,
  },
  {
    key: 'theme.captions.color',
    section: 'Type',
    label: 'Subtitle text',
    type: 'color',
  },
  {
    key: 'theme.captions.backgroundColor',
    section: 'Type',
    label: 'Subtitle background',
    type: 'color',
  },

  {
    key: 'theme.intro.enabled',
    section: 'Opening card',
    label: 'Start with a title card',
    type: 'boolean',
  },
  {
    key: 'theme.intro.title',
    section: 'Opening card',
    label: 'Title',
    type: 'text', maxLength: 120,
  },
  {
    key: 'theme.intro.subtitle',
    section: 'Opening card',
    label: 'Subtitle',
    type: 'text', maxLength: 160,
  },
  {
    key: 'theme.intro.titleFont',
    section: 'Opening card',
    label: 'Title font',
    type: 'font', nullable: true,
  },
  {
    key: 'theme.intro.subtitleFont',
    section: 'Opening card',
    label: 'Subtitle font',
    type: 'font', nullable: true,
  },
  {
    key: 'theme.intro.titleColor',
    section: 'Opening card',
    label: 'Title colour',
    type: 'color',
  },
  {
    key: 'theme.intro.subtitleColor',
    section: 'Opening card',
    label: 'Subtitle colour',
    type: 'color',
  },
  {
    key: 'theme.intro.backgroundColor',
    section: 'Opening card',
    label: 'Background',
    type: 'color',
  },
  {
    key: 'theme.intro.durationSec',
    section: 'Opening card',
    label: 'How long it shows',
    type: 'number', unit: 'seconds', min: 0.5, max: 20, step: 0.5,
  },

  {
    key: 'theme.outro.enabled',
    section: 'Closing card',
    label: 'End with a card',
    type: 'boolean',
  },
  {
    key: 'theme.outro.title',
    section: 'Closing card',
    label: 'Title',
    type: 'text', maxLength: 120,
  },
  {
    key: 'theme.outro.subtitle',
    section: 'Closing card',
    label: 'Subtitle',
    type: 'text', maxLength: 160,
  },
  {
    key: 'theme.outro.titleFont',
    section: 'Closing card',
    label: 'Title font',
    type: 'font', nullable: true,
  },
  {
    key: 'theme.outro.subtitleFont',
    section: 'Closing card',
    label: 'Subtitle font',
    type: 'font', nullable: true,
  },
  {
    key: 'theme.outro.titleColor',
    section: 'Closing card',
    label: 'Title colour',
    type: 'color',
  },
  {
    key: 'theme.outro.subtitleColor',
    section: 'Closing card',
    label: 'Subtitle colour',
    type: 'color',
  },
  {
    key: 'theme.outro.backgroundColor',
    section: 'Closing card',
    label: 'Background',
    type: 'color',
  },
  {
    key: 'theme.outro.durationSec',
    section: 'Closing card',
    label: 'How long it shows',
    type: 'number', unit: 'seconds', min: 0.5, max: 20, step: 0.5,
  },

  {
    key: 'theme.video.width',
    section: 'Video',
    label: 'Width',
    type: 'number', unit: 'px', min: 320, max: 3840, even: true,
  },
  {
    key: 'theme.video.height',
    section: 'Video',
    label: 'Height',
    type: 'number', unit: 'px', min: 240, max: 2160, even: true,
  },
  {
    key: 'theme.video.fps',
    section: 'Video',
    label: 'Frames per second',
    type: 'number', unit: 'fps', min: 10, max: 60, integer: true,
  },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = '.secrets.json';

// The one secret that is not a password for the site being recorded. It buys
// spoken narration, so the window offers it whether or not a flow asks for it.
const NARRATION_KEY = 'ELEVENLABS_API_KEY';

function settingsPath(dir) { return path.join(dir, SETTINGS_FILE); }
function secretsPath(dir) { return path.join(dir, SECRETS_FILE); }

/** Read settings.json, or an empty layer when there is none. */
function loadSettings(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { theme: {}, flow: {} };
  const raw = readJson(abs, 'settings file');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${abs}: expected a JSON object at the top level`);
  }
  return { theme: raw.theme || {}, flow: raw.flow || {} };
}

/** Pull the current value of every field out of a loaded theme and flow. */
function readValues(theme, flow) {
  const values = {};
  for (const field of FIELDS) {
    const [root, ...rest] = field.key.split('.');
    const source = root === 'theme' ? theme : flow;
    values[field.key] = rest.reduce((o, k) => (o == null ? undefined : o[k]), source);
  }
  return values;
}

/**
 * Turn a flat { "theme.cursor.moveMs": 400 } map into the nested layer, after
 * checking every value. Unknown keys are refused rather than written through:
 * this file is edited by a form, and a form should not be able to put anything
 * it likes into the theme.
 */
function toLayer(values, context = {}) {
  const layer = { theme: {}, flow: {} };
  for (const [key, raw] of Object.entries(values || {})) {
    const field = BY_KEY.get(key);
    if (!field) throw new ConfigError(`"${key}" is not a setting this tool has`);
    const value = coerce(field, raw, context);
    if (value === undefined) continue;

    const [root, ...rest] = key.split('.');
    let node = layer[root];
    for (const part of rest.slice(0, -1)) node = node[part] = node[part] || {};
    node[rest[rest.length - 1]] = value;
  }
  return layer;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function coerce(field, raw, context = {}) {
  if (field.type === 'boolean') return !!raw;

  if (field.type === 'text') {
    const text = raw === null || raw === undefined ? '' : String(raw);
    if (field.maxLength && text.length > field.maxLength) {
      throw new ConfigError(`${field.label} is longer than ${field.maxLength} characters`);
    }
    return text;
  }

  if (field.type === 'color') {
    const text = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!text) {
      if (field.nullable) return null;
      return undefined;                     // leave it as it was
    }
    if (!HEX.test(text)) {
      throw new ConfigError(
        `${field.label}: "${text}" is not a colour. Use a hex value such as #6C5CE7.`
      );
    }
    return text.toUpperCase();
  }

  if (field.type === 'font') {
    const key = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!key) return field.nullable ? null : undefined;
    const known = context.fontKeys || [];
    if (!known.includes(key)) {
      throw new ConfigError(
        `${field.label}: there is no font called "${key}"` +
        (known.length ? `. This theme has: ${known.join(', ')}.` : ' in this theme.')
      );
    }
    return key;
  }

  if (field.type === 'select') {
    const allowed = field.options.map((o) => o.value);
    if (!allowed.includes(raw)) {
      throw new ConfigError(`${field.label}: "${raw}" is not one of ${allowed.join(', ')}`);
    }
    return raw;
  }

  // number
  if (raw === null || raw === '' || raw === undefined) {
    if (field.nullable) return null;
    return undefined;                       // leave it as it was
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    throw new ConfigError(`${field.label}: "${raw}" is not a number`);
  }
  if (field.integer && !Number.isInteger(number)) {
    throw new ConfigError(`${field.label} must be a whole number`);
  }
  if (field.even && number % 2 !== 0) {
    throw new ConfigError(`${field.label} must be an even number of pixels; H.264 requires it`);
  }
  if (field.min !== undefined && number < field.min) {
    throw new ConfigError(`${field.label} cannot be below ${field.min}`);
  }
  if (field.max !== undefined && number > field.max) {
    throw new ConfigError(`${field.label} cannot be above ${field.max}`);
  }
  return number;
}

function saveSettings(file, values, context = {}) {
  const layer = toLayer(values, context);
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(layer, null, 2)}\n`, 'utf8');
  return layer;
}

/**
 * Passwords, kept out of the flow file.
 *
 * Written 0600 and listed in .gitignore. Nothing ever reads a value back out to
 * the window: it is told which names are set, never what they are.
 */
function loadSecrets(dir) {
  const file = secretsPath(dir);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSecrets(dir, updates) {
  const current = loadSecrets(dir);
  for (const [name, value] of Object.entries(updates || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ConfigError(`"${name}" is not a usable variable name`);
    }
    if (value === '' || value === null) delete current[name];
    else current[name] = String(value);
  }
  const file = secretsPath(dir);
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  try { fs.chmodSync(file, 0o600); } catch { /* Windows has no mode to set */ }
  return Object.keys(current);
}

/**
 * Put saved passwords into the environment for this run.
 * A variable already set in the environment wins, so a CI or shell value is
 * never quietly replaced by something typed into a window months ago.
 */
function applySecrets(dir, env = process.env) {
  const saved = loadSecrets(dir);
  const applied = [];
  for (const [name, value] of Object.entries(saved)) {
    if (env[name] === undefined || env[name] === '') {
      env[name] = value;
      applied.push(name);
    }
  }
  return applied;
}

module.exports = {
  FIELDS, SETTINGS_FILE, SECRETS_FILE, NARRATION_KEY,
  settingsPath, secretsPath,
  loadSettings, saveSettings, readValues, toLayer,
  loadSecrets, saveSecrets, applySecrets,
};
