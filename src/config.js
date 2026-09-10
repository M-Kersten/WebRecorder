'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Every action the recorder knows, and what each one needs from a step.
 * `required` fields are checked at load time so a typo fails before the browser
 * launches rather than three minutes into a recording.
 */
const ACTIONS = {
  goto:   { required: ['url'] },
  click:  { required: ['selector'] },
  type:   { required: ['selector', 'text'] },
  hover:  { required: ['selector'] },
  scroll: { required: [] },   // `to` (px) or `selector`; defaults to one viewport down
  wait:   { required: [] },   // `durationMs`, default 1000
};

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
  });

  if (flow.baseUrl !== undefined && typeof flow.baseUrl !== 'string') {
    throw new ConfigError(`${abs}: "baseUrl" must be a string`);
  }

  const mask = validateMask(flow.mask, abs);
  const auth = validateAuth(flow.auth, abs, known);

  return {
    name: flow.name || path.basename(abs, path.extname(abs)),
    baseUrl: flow.baseUrl || null,
    // A floor on every step so a one-word narration still reads on screen.
    minStepMs: Number.isFinite(flow.minStepMs) ? flow.minStepMs : 1200,
    // Breathing room after the narration finishes, before the next step fires.
    stepPaddingMs: Number.isFinite(flow.stepPaddingMs) ? flow.stepPaddingMs : 600,
    // Per-keystroke delay for "type" steps, unless a step overrides it.
    typeDelayMs: Number.isFinite(flow.typeDelayMs) ? flow.typeDelayMs : 55,
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

module.exports = { loadFlow, readJson, stripJsonComments, ConfigError, ACTIONS };
