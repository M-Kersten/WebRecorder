'use strict';

const fs = require('fs');
const path = require('path');

const { readJson, ConfigError, validateViewport, validateDismiss } = require('./config');

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
    key: 'flow.narration',
    section: 'Narration',
    label: 'Read out loud',
    help: 'Off makes the video silent and exactly as long, which costs nothing. ' +
      'The switch on the storyboard is this one.',
    type: 'boolean',
  },
  {
    key: 'flow.voiceModel',
    section: 'Narration',
    label: 'Model',
    help: 'v3 is the most expressive, and the one that ignores the most settings: ' +
      'no speed, no similarity, no speaker boost. Changing the model regenerates ' +
      'every line.',
    type: 'select',
    options: require('./tts').MODELS.map((m) => ({ value: m.id, label: m.label })),
  },
  {
    key: 'flow.voiceLanguage',
    section: 'Narration',
    label: 'Language',
    help: 'Two letters, such as nl or en. Pins how numbers and dates are read.',
    type: 'text', maxLength: 8, nullable: true,
    // Greyed out, with this reason, when the chosen model will not use it.
    needs: { setting: 'language_code' },
  },
  {
    key: 'flow.voiceStyle',
    section: 'Narration',
    label: 'Expression',
    help: 'How far the voice leans into its own character. Past about half it ' +
      'starts to wander off the text.',
    type: 'number', min: 0, max: 1, step: 0.05,
    needs: { setting: 'style' },
  },
  {
    key: 'flow.voiceSpeed',
    section: 'Narration',
    label: 'Speed',
    help: 'One is the voice as it comes. Slower gives a walkthrough more room.',
    type: 'number', min: 0.7, max: 1.2, step: 0.05,
    needs: { setting: 'speed' },
  },
  {
    key: 'flow.voiceId',
    section: 'Narration',
    label: 'Voice',
    help: 'Listed in voices.json, beside this project. Changing it regenerates every ' +
      'line at ElevenLabs\u2019 usual cost.',
    type: 'voice', nullable: true,
  },
  {
    key: 'theme.cursor.moveMs',
    section: 'Cursor and ring',
    label: 'Cursor travel time',
    help: 'How long the pointer takes to reach whatever it is about to use. Leave empty to let it follow the distance.',
    type: 'number', unit: 'ms', min: 0, max: 5000, nullable: true,
  },
  {
    key: 'theme.cursor.easing',
    section: 'Cursor and ring',
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
    section: 'Pacing',
    label: 'Typing speed',
    help: 'Pause between keystrokes. Zero fills the field instantly, which does not read as typing.',
    type: 'number', unit: 'ms per key', min: 0, max: 500,
  },
  {
    key: 'theme.cursor.ripple',
    section: 'Cursor and ring',
    label: 'Ripple where a click lands',
    type: 'boolean',
  },
  {
    key: 'theme.highlight.fadeMs',
    section: 'Cursor and ring',
    label: 'Highlight fade',
    help: 'How long the ring takes to appear once the cursor has arrived. It never travels.',
    type: 'number', unit: 'ms', min: 0, max: 3000,
  },

  {
    key: 'flow.settleMs',
    section: 'Pacing',
    label: 'Quiet before a page counts as loaded',
    help: 'How long the page has to stop changing, with nothing still being ' +
      'fetched, before the recording moves on. It is not a fixed pause: a site ' +
      'that is already finished pays exactly this, one still assembling itself ' +
      'pays until it stops.',
    type: 'number', unit: 'ms', min: 0, max: 10000,
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
    key: 'flow.timeoutMs',
    section: 'The site',
    label: 'How long to wait for anything',
    help: 'Before a step gives up on the thing it is pointing at. Fifteen seconds ' +
      'suits a site that is already warm. A staging box that has to start up ' +
      'first needs more, and telling it so here is cheaper than losing a take.',
    type: 'number', unit: 'ms', min: 500, max: 120000,
  },
  {
    key: 'flow.dismiss.builtins',
    section: 'The site',
    label: 'Close cookie banners',
    help: 'Tries the accept buttons of the usual consent platforms, before the ' +
      'clock starts, so the banner never reaches the video and never pushes the ' +
      'narration out of step. Turn it off if your own banner is the thing you ' +
      'want to show.',
    type: 'boolean',
  },
  {
    key: 'flow.viewportPreset',
    section: 'The site',
    label: 'Record the site at',
    help: 'The window the site is shown in, which is not the frame the video is ' +
      'delivered in. A phone-shaped walkthrough of a responsive site is ' +
      'letterboxed onto the style\u2019s background.',
    type: 'select',
    options: [
      { value: '', label: 'The same size as the video' },
      { value: 'desktop', label: 'Desktop, 1920 \u00d7 1080' },
      { value: 'laptop', label: 'Laptop, 1440 \u00d7 900' },
      { value: 'tablet', label: 'Tablet, 1024 \u00d7 1366' },
      { value: 'phone', label: 'Phone, 390 \u00d7 844' },
    ],
  },
  {
    key: 'theme.hints.fadeMs',
    section: 'Fades',
    label: 'Hint fade',
    type: 'number', unit: 'ms', min: 0, max: 3000,
  },
  {
    key: 'theme.transitions.fadeSec',
    section: 'Fades',
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
    key: 'theme.hints.enabled',
    section: 'Type',
    label: 'Hints',
    help: 'The small block of text that goes up beside whatever a step acted on.',
    type: 'boolean',
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
    key: 'theme.captions.enabled',
    section: 'Type',
    label: 'Subtitles',
    help: 'The narration burned in along the bottom. The switch on the storyboard ' +
      'is this one.',
    type: 'boolean',
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
    key: 'theme.intro.audio',
    section: 'Opening card',
    label: 'Sound',
    help: 'A clip from the project\u2019s "audio" folder, played over this card. ' +
      'Longer than the card and it is cut off; shorter and the rest is silence.',
    type: 'sound', nullable: true,
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
    key: 'theme.outro.audio',
    section: 'Closing card',
    label: 'Sound',
    help: 'A clip from the project\u2019s "audio" folder, played over this card. ' +
      'Longer than the card and it is cut off; shorter and the rest is silence.',
    type: 'sound', nullable: true,
  },
  {
    key: 'theme.outro.durationSec',
    section: 'Closing card',
    label: 'How long it shows',
    type: 'number', unit: 'seconds', min: 0.5, max: 20, step: 0.5,
  },

  {
    key: 'theme.music.file',
    section: 'Music',
    label: 'Track',
    help: 'Plays under the whole video, cards included, looped to reach the end.',
    type: 'sound', nullable: true,
  },
  {
    key: 'theme.music.volume',
    section: 'Music',
    label: 'Level',
    help: 'Against the narration, which is 1. It sits under the voice rather than ' +
      'ducking out of its way, so keep it low.',
    type: 'number', min: 0, max: 1, step: 0.01,
  },
  {
    key: 'theme.music.fadeSec',
    section: 'Music',
    label: 'Fade',
    help: 'In at the start and out at the end.',
    type: 'number', unit: 'seconds', min: 0, max: 10, step: 0.1,
  },
  {
    key: 'theme.audio.loudnessLufs',
    section: 'Music',
    label: 'Sound level',
    help: 'Every video is brought to this level, so one is not quiet and the next ' +
      'loud. Streaming sits near -14, broadcast near -23.',
    type: 'number', unit: 'LUFS', min: -40, max: -5, nullable: true,
  },
  {
    key: 'theme.video.master',
    section: 'Frame',
    label: 'Also save a master',
    help: 'A second file with no chroma subsampling, to edit from. The one you hand ' +
      'out stays 4:2:0, which is what players and hardware decoders read.',
    type: 'boolean',
  },
  {
    key: 'theme.video.width',
    section: 'Frame',
    label: 'Width',
    type: 'number', unit: 'px', min: 320, max: 3840, even: true,
  },
  {
    key: 'theme.video.height',
    section: 'Frame',
    label: 'Height',
    type: 'number', unit: 'px', min: 240, max: 2160, even: true,
  },
  {
    key: 'theme.video.fps',
    section: 'Frame',
    label: 'Frames per second',
    type: 'number', unit: 'fps', min: 10, max: 60, integer: true,
  },
];

/**
 * Which tab a setting belongs to, decided by what it actually changes.
 *
 * A `theme.` key is part of a style, and a style is a file you can have several
 * of; a `flow.` key belongs to this project whichever style it is rendered in.
 * Deriving it rather than tagging each field means the two can never disagree.
 */
for (const field of FIELDS) {
  field.tab = field.key.startsWith('theme.') ? 'style' : 'settings';
}

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = '.secrets.json';

// The one secret that is not a password for the site being recorded. It buys
// spoken narration, so the window offers it whether or not a flow asks for it.
const NARRATION_KEY = 'ELEVENLABS_API_KEY';

function settingsPath(dir) { return path.join(dir, SETTINGS_FILE); }
function secretsPath(dir) { return path.join(dir, SECRETS_FILE); }

const DEFAULT_STYLE = 'theme.json';

/**
 * Read settings.json.
 *
 * The visual settings are kept per style rather than in one pile, because one
 * pile is merged over whichever style you pick and therefore overwrites it.
 * That is what made choosing a different style change almost nothing: the
 * layer captured from the default style won every time.
 *
 * Shape:
 *   { style: "theme-rebels.json",
 *     flow:  { minStepMs: 1800 },
 *     styles: { "theme.json": { ... }, "theme-rebels.json": { ... } } }
 */
function loadSettings(file, styleFile = null) {
  const abs = path.resolve(file);
  const blank = { theme: {}, flow: {}, style: DEFAULT_STYLE, styles: {} };
  if (!fs.existsSync(abs)) return blank;

  const raw = readJson(abs, 'settings file');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${abs}: expected a JSON object at the top level`);
  }

  const styles = raw.styles && typeof raw.styles === 'object' && !Array.isArray(raw.styles)
    ? { ...raw.styles }
    : {};
  // A file written before styles were separate holds one theme layer that
  // applied to every style. It was only ever captured from the default one,
  // so that is where it belongs.
  if (raw.theme && !styles[DEFAULT_STYLE]) styles[DEFAULT_STYLE] = raw.theme;

  const style = typeof raw.style === 'string' && raw.style ? path.basename(raw.style) : DEFAULT_STYLE;
  const wanted = styleFile ? path.basename(styleFile) : style;

  return { theme: styles[wanted] || {}, flow: raw.flow || {}, style, styles };
}

/**
 * Put the window's flow settings onto a flow that has already been validated.
 *
 * A plain Object.assign is wrong for two of these. `dismiss` arrives from the
 * form as `{ builtins: false }` and would replace the whole validated object,
 * taking the flow's own consent selectors with it. And the form writes a
 * viewport *preset name*, which the flow needs as a size.
 *
 * Both places that merge a layer - the render and the check - go through here,
 * so there is one answer rather than two that drift.
 */
function applyFlowLayer(flow, layer) {
  const { viewportPreset, dismiss, ...rest } = layer || {};
  Object.assign(flow, rest);

  if (dismiss !== undefined) {
    flow.dismiss = validateDismiss(
      { ...(flow.dismiss || {}), ...(typeof dismiss === 'object' ? dismiss : {}) },
      'settings'
    );
  }
  if (viewportPreset !== undefined) {
    flow.viewport = validateViewport(viewportPreset || null, 'settings');
  }
  return flow;
}

/** Everything in settings.json, untouched, for a save to merge into. */
function readRaw(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return {};
  const raw = readJson(abs, 'settings file');
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** Merge `patch` into `base`, objects all the way down, without sharing nodes. */
function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
    out[key] = plain(value) && plain(out[key]) ? mergeDeep(out[key], value) : value;
  }
  return out;
}

/**
 * Which narration fields the chosen model will actually act on.
 *
 * The API takes every setting for every model and quietly ignores the ones that
 * model does not implement, so a control that does nothing looks exactly like
 * one that works. Returns { key: reason } for the fields to grey out.
 */
function inertFields(modelId) {
  const tts = require('./tts');
  const id = modelId || tts.DEFAULT_MODEL;
  const model = tts.MODELS.find((m) => m.id === id);
  const label = model ? model.label : id;
  const out = {};
  for (const field of FIELDS) {
    if (!field.needs) continue;
    const name = field.needs.setting;
    const live = name === 'language_code'
      ? tts.takesLanguageCode(id)
      : tts.modelSupport(id).includes(name);
    if (live) continue;
    out[field.key] = name === 'language_code'
      ? `${label} has no language code. It follows the text instead.`
      : `${label} does not use this. Changing it will not change the voice.`;
  }
  return out;
}

/**
 * The same answer for every model, so the window can grey a control the moment
 * somebody picks a different model rather than after a save and a reload.
 *
 * Sent rather than worked out in the page, because which model ignores what is
 * a fact about ElevenLabs, and there should be one copy of it.
 */
function inertByModel() {
  const { MODELS } = require('./tts');
  const out = {};
  for (const model of MODELS) out[model.id] = inertFields(model.id);
  return out;
}

/** Pull the current value of every field out of a loaded theme and flow. */
function readValues(theme, flow) {
  const values = {};
  for (const field of FIELDS) {
    const [root, ...rest] = field.key.split('.');
    const source = root === 'theme' ? theme : flow;
    values[field.key] = rest.reduce((o, k) => (o == null ? undefined : o[k]), source);
  }
  // The form asks for a preset name; the flow holds the size it resolved to.
  // A viewport written as an explicit width and height has no preset, and
  // reading back as "the same size as the video" would quietly discard it on
  // the next save, so it is left blank and the select shows nothing chosen.
  values['flow.viewportPreset'] = (flow && flow.viewport && flow.viewport.preset) || '';
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

  if (field.type === 'sound') {
    const name = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!name) return field.nullable ? null : undefined;
    const known = context.sounds || [];
    if (!known.includes(name)) {
      throw new ConfigError(
        `${field.label}: there is no clip called "${name}" in the audio folder` +
        (known.length ? `. It holds: ${known.join(', ')}.` : ', which is empty or missing.')
      );
    }
    return name;
  }

  if (field.type === 'voice') {
    const id = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!id) return field.nullable ? null : undefined;
    const known = context.voiceIds || [];
    if (!known.includes(id)) {
      throw new ConfigError(
        `${field.label}: "${id}" is not in voices.json. ` +
        (known.length ? `It lists: ${known.join(', ')}.` : 'That file lists no voices yet.')
      );
    }
    return id;
  }

  if (field.type === 'font') {
    const key = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!key) return field.nullable ? null : undefined;
    const known = context.fontKeys || [];
    if (!known.includes(key)) {
      // A whole font folder listed back is a wall of text. A handful is enough
      // to show the shape of a key.
      const some = known.slice(0, 8).join(', ');
      const rest = known.length > 8 ? `, and ${known.length - 8} more` : '';
      throw new ConfigError(
        `${field.label}: there is no font called "${key}"` +
        (known.length ? `. This style has: ${some}${rest}.` : ' in this style.')
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

/**
 * Write what the form changed, and nothing else.
 *
 * A form posts only the fields on the tab somebody is looking at, so the rest
 * of the file has to survive: saving a colour must not wipe the pacing, and
 * saving the pacing must not wipe every style.
 */
function saveSettings(file, values, context = {}) {
  const layer = toLayer(values, context);
  const raw = readRaw(file);

  const styles = raw.styles && typeof raw.styles === 'object' && !Array.isArray(raw.styles)
    ? { ...raw.styles }
    : {};
  if (raw.theme && !styles[DEFAULT_STYLE]) styles[DEFAULT_STYLE] = raw.theme;

  const out = {
    style: typeof raw.style === 'string' && raw.style ? path.basename(raw.style) : DEFAULT_STYLE,
    flow: mergeDeep(raw.flow || {}, layer.flow),
    styles,
  };
  if (Object.keys(layer.theme).length) {
    const key = path.basename(context.styleFile || out.style);
    styles[key] = mergeDeep(styles[key] || {}, layer.theme);
  }
  if (context.style) out.style = path.basename(context.style);

  fs.writeFileSync(path.resolve(file), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return out;
}

/** Remember which style the next video is made in. */
function saveStyleChoice(file, styleFile) {
  const raw = readRaw(file);
  raw.style = path.basename(styleFile);
  delete raw.theme;                      // migrated by loadSettings already
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return raw.style;
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
  applyFlowLayer,
  inertFields,
  inertByModel,
  FIELDS, SETTINGS_FILE, SECRETS_FILE, NARRATION_KEY, DEFAULT_STYLE,
  settingsPath, secretsPath,
  loadSettings, saveSettings, saveStyleChoice, readValues, toLayer, mergeDeep,
  loadSecrets, saveSecrets, applySecrets,
};
