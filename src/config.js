'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_TIMEOUT_MS, framePath } = require('./target');

/**
 * Every action the recorder knows, and what each one needs from a step.
 * `required` fields are checked at load time so a typo fails before the browser
 * launches rather than three minutes into a recording.
 */
const ACTIONS = {
  goto:    { required: ['url'] },
  click:   { required: ['selector'] },
  type:    { required: ['selector', 'text'] },
  hover:   { required: ['selector'] },
  scroll:  { required: [] },   // `to` (px) or `selector`; defaults to one viewport down
  wait:    { required: [] },   // `durationMs`, default 1000
  // Hold until something is on screen, rather than for a number somebody
  // guessed. `state` picks which way round: visible, hidden, attached, detached.
  waitFor: { required: ['selector'] },
};

/** What a waitFor step can be waiting for. */
const WAIT_STATES = ['visible', 'hidden', 'attached', 'detached'];

class ConfigError extends Error {}

function readJson(file, what) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError(`No ${what} found at ${file}`);
    }
    throw new ConfigError(`Could not read ${what} at ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
}

/**
 * Allow // and /* *\/ comments so the shipped examples can explain themselves.
 * String-aware, so a "http://..." inside a value survives.
 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

function loadFlow(flowPath) {
  const abs = path.resolve(flowPath);
  const flow = readJson(abs, 'flow file');

  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    throw new ConfigError(`${abs}: expected a JSON object at the top level`);
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    throw new ConfigError(`${abs}: "steps" must be a non-empty array`);
  }

  const known = Object.keys(ACTIONS).join(', ');
  flow.steps.forEach((step, i) => {
    const where = `${abs}: steps[${i}]`;
    if (!step || typeof step !== 'object') {
      throw new ConfigError(`${where} must be an object`);
    }
    const spec = ACTIONS[step.action];
    if (!spec) {
      throw new ConfigError(
        `${where} has unknown action "${step.action}". Known actions: ${known}`
      );
    }
    for (const field of spec.required) {
      if (step[field] === undefined || step[field] === null || step[field] === '') {
        throw new ConfigError(`${where} (action "${step.action}") is missing required field "${field}"`);
      }
    }
    if (step.narration !== undefined && typeof step.narration !== 'string') {
      throw new ConfigError(`${where}: "narration" must be a string`);
    }
    if (step.hint !== undefined && typeof step.hint !== 'string') {
      throw new ConfigError(`${where}: "hint" must be a string`);
    }
    if (step.durationMs !== undefined && !(Number.isFinite(step.durationMs) && step.durationMs >= 0)) {
      throw new ConfigError(`${where}: "durationMs" must be a non-negative number`);
    }
    validateStepTiming(step, where);
    validateFrame(step.frame, where);
    if (step.action === 'waitFor' && step.state !== undefined && !WAIT_STATES.includes(step.state)) {
      throw new ConfigError(
        `${where}: "state" is "${step.state}". Use one of: ${WAIT_STATES.join(', ')}.`
      );
    }
  });

  if (flow.baseUrl !== undefined && typeof flow.baseUrl !== 'string') {
    throw new ConfigError(`${abs}: "baseUrl" must be a string`);
  }

  if (flow.timeoutMs !== undefined && !(Number.isFinite(flow.timeoutMs) && flow.timeoutMs > 0)) {
    throw new ConfigError(`${abs}: "timeoutMs" must be a positive number of milliseconds`);
  }

  const mask = validateMask(flow.mask, abs);
  const auth = validateAuth(flow.auth, abs, known);
  const viewport = validateViewport(flow.viewport, abs);
  const dismiss = validateDismiss(flow.dismiss, abs);

  return {
    name: flow.name || path.basename(abs, path.extname(abs)),
    baseUrl: flow.baseUrl || null,
    // A floor on every step so a one-word narration still reads on screen.
    minStepMs: Number.isFinite(flow.minStepMs) ? flow.minStepMs : 1200,
    // Breathing room after the narration finishes, before the next step fires.
    stepPaddingMs: Number.isFinite(flow.stepPaddingMs) ? flow.stepPaddingMs : 600,
    // Per-keystroke delay for "type" steps, unless a step overrides it.
    typeDelayMs: Number.isFinite(flow.typeDelayMs) ? flow.typeDelayMs : 55,
    // Held after a page has loaded, before its line starts. "load" fires before
    // a site that fetches its own content has anything on screen.
    settleMs: Number.isFinite(flow.settleMs) ? flow.settleMs : 600,
    // How long any one step may wait for its target before giving up. Fifteen
    // seconds suits a site that is already warm; a staging box that cold-starts
    // needs to be told so here rather than failing halfway through a take.
    timeoutMs: Number.isFinite(flow.timeoutMs) ? flow.timeoutMs : DEFAULT_TIMEOUT_MS,
    // The window the site is recorded in, which is not the frame the video is
    // delivered in. A phone-shaped walkthrough of a responsive site is a
    // different recording, not a crop of the desktop one.
    viewport,
    // Consent dialogs, taken down before the clock starts.
    dismiss,
    // Whether the narration is spoken. Off makes the video silent and exactly
    // as long, which is what --no-tts does.
    narration: flow.narration !== false,
    // How the narration is read. Spelled out rather than left undefined, so the
    // settings screen can show what the voice will actually do.
    voiceId: flow.voiceId || null,
    voiceModel: flow.voiceModel || 'eleven_multilingual_v2',
    voiceLanguage: flow.voiceLanguage || null,
    voiceStyle: Number.isFinite(flow.voiceStyle) ? flow.voiceStyle : 0,
    voiceSpeed: Number.isFinite(flow.voiceSpeed) ? flow.voiceSpeed : 1,
    steps: flow.steps,
    mask,
    auth,
    path: abs,
  };
}

const MASK_MODES = ['blur', 'hide', 'text'];

/**
 * Selectors to neutralise before anything is recorded.
 *
 * A walkthrough of a real, logged-in product is a recording of real data: names,
 * avatars, customer rows. This is how you say which parts must not end up in the
 * file you are about to hand out.
 */
function validateMask(mask, abs) {
  if (mask === undefined || mask === null) return [];
  if (!Array.isArray(mask)) {
    throw new ConfigError(`${abs}: "mask" must be an array of { selector, mode } objects`);
  }
  return mask.map((rule, i) => {
    const where = `${abs}: mask[${i}]`;
    if (!rule || typeof rule !== 'object') throw new ConfigError(`${where} must be an object`);
    if (typeof rule.selector !== 'string' || !rule.selector.trim()) {
      throw new ConfigError(`${where} needs a CSS "selector"`);
    }
    const mode = rule.mode || 'blur';
    if (!MASK_MODES.includes(mode)) {
      throw new ConfigError(
        `${where} has mode "${mode}". Use one of: ${MASK_MODES.join(', ')}.\n` +
        '  blur  softens it beyond reading, keeping the layout\n' +
        '  hide  makes it invisible, keeping the space it occupied\n' +
        '  text  swaps its text for something you choose'
      );
    }
    if (mode === 'text' && typeof rule.text !== 'string') {
      throw new ConfigError(`${where} uses mode "text", so it needs a "text" replacement`);
    }
    const radius = Number.isFinite(rule.radius) ? rule.radius : 10;
    if (radius <= 0) throw new ConfigError(`${where}: "radius" must be a positive number of pixels`);
    return { selector: rule.selector.trim(), mode, text: rule.text || '', radius };
  });
}

/**
 * Steps that log in, run once in their own browser before recording starts and
 * never appear in the video. The session they produce is saved and reused, so
 * later runs skip the login entirely.
 */
function validateAuth(auth, abs, knownActions) {
  if (auth === undefined || auth === null) return null;
  if (typeof auth !== 'object' || Array.isArray(auth)) {
    throw new ConfigError(`${abs}: "auth" must be an object with "steps" and optionally "stateFile"`);
  }
  if (!Array.isArray(auth.steps) || !auth.steps.length) {
    throw new ConfigError(`${abs}: auth.steps must be a non-empty array of steps that log in`);
  }
  auth.steps.forEach((step, i) => {
    const where = `${abs}: auth.steps[${i}]`;
    const spec = ACTIONS[step && step.action];
    if (!spec) {
      throw new ConfigError(
        `${where} has unknown action "${step && step.action}". Known actions: ${knownActions}`
      );
    }
    for (const field of spec.required) {
      if (step[field] === undefined || step[field] === null || step[field] === '') {
        throw new ConfigError(`${where} (action "${step.action}") is missing required field "${field}"`);
      }
    }
  });
  if (auth.stateFile !== undefined && typeof auth.stateFile !== 'string') {
    throw new ConfigError(`${abs}: auth.stateFile must be a path to write the saved session to`);
  }
  return {
    steps: auth.steps,
    stateFile: auth.stateFile || '.auth/session.json',
    // How long a saved session is trusted before logging in again.
    maxAgeHours: Number.isFinite(auth.maxAgeHours) ? auth.maxAgeHours : 12,
  };
}

/** A per-step wait budget, and the shorthand `waitFor` on any other action. */
function validateStepTiming(step, where) {
  if (step.timeoutMs !== undefined && !(Number.isFinite(step.timeoutMs) && step.timeoutMs > 0)) {
    throw new ConfigError(`${where}: "timeoutMs" must be a positive number of milliseconds`);
  }
}

/** Which iframe a step means, if any. Delegated so there is one set of rules. */
function validateFrame(frame, where) {
  try {
    framePath(frame);
  } catch (err) {
    throw new ConfigError(`${where}: ${err.message}`);
  }
}

const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  laptop:  { width: 1440, height: 900 },
  tablet:  { width: 1024, height: 1366 },
  phone:   { width: 390, height: 844 },
};

/**
 * The size of the window the site is recorded in.
 *
 * Kept apart from the output frame on purpose. Recording a responsive site at
 * 390 wide and delivering a 1080p file is a normal thing to want - the phone
 * layout, letterboxed on the theme's background - and it is not the same
 * request as "make the video 390 pixels wide". Left unset, the recorder uses
 * the output frame, which is what every flow written so far expects.
 */
function validateViewport(viewport, abs) {
  if (viewport === undefined || viewport === null) return null;
  if (typeof viewport === 'string') {
    const preset = VIEWPORTS[viewport.toLowerCase()];
    if (!preset) {
      throw new ConfigError(
        `${abs}: "viewport" is "${viewport}". Use one of: ${Object.keys(VIEWPORTS).join(', ')}, ` +
        'or an object with width and height.'
      );
    }
    return { ...preset, preset: viewport.toLowerCase(), deviceScaleFactor: 1 };
  }
  if (typeof viewport !== 'object' || Array.isArray(viewport)) {
    throw new ConfigError(`${abs}: "viewport" must be a preset name or a { width, height } object`);
  }
  for (const side of ['width', 'height']) {
    if (!(Number.isFinite(viewport[side]) && viewport[side] >= 200)) {
      throw new ConfigError(`${abs}: viewport.${side} must be a number of at least 200`);
    }
  }
  const dsf = viewport.deviceScaleFactor;
  if (dsf !== undefined && !(Number.isFinite(dsf) && dsf > 0 && dsf <= 3)) {
    throw new ConfigError(`${abs}: viewport.deviceScaleFactor must be between 0 and 3`);
  }
  return {
    width: Math.round(viewport.width),
    height: Math.round(viewport.height),
    deviceScaleFactor: dsf === undefined ? 1 : dsf,
    preset: null,
  };
}

/**
 * Cookie and consent dialogs to take down after every navigation.
 *
 * `true` and `false` are accepted as the whole value because that is the answer
 * most flows want to give, and a checkbox in the window has to write something.
 */
function validateDismiss(dismiss, abs) {
  if (dismiss === undefined || dismiss === null || dismiss === true) {
    return { builtins: true, selectors: [], frames: [] };
  }
  if (dismiss === false) return { builtins: false, selectors: [], frames: [] };
  if (Array.isArray(dismiss)) return validateDismiss({ selectors: dismiss }, abs);
  if (typeof dismiss !== 'object') {
    throw new ConfigError(`${abs}: "dismiss" must be true, false, an array of selectors, or an object`);
  }
  const selectors = dismiss.selectors === undefined ? [] : dismiss.selectors;
  if (!Array.isArray(selectors) || selectors.some((s) => typeof s !== 'string' || !s.trim())) {
    throw new ConfigError(`${abs}: dismiss.selectors must be an array of CSS selectors`);
  }
  const frames = dismiss.frames === undefined ? [] : dismiss.frames;
  if (!Array.isArray(frames)) {
    throw new ConfigError(`${abs}: dismiss.frames must be an array of iframe selectors`);
  }
  frames.forEach((frame, i) => validateFrame(frame, `${abs}: dismiss.frames[${i}]`));
  return {
    builtins: dismiss.builtins !== false,
    selectors: selectors.map((s) => s.trim()),
    frames,
  };
}

module.exports = {
  loadFlow, readJson, stripJsonComments, ConfigError,
  ACTIONS, WAIT_STATES, VIEWPORTS, validateViewport, validateDismiss,
};
