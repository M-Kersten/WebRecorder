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
    if (step.durationMs !== undefined && !(Number.isFinite(step.durationMs) && step.durationMs >= 0)) {
      throw new ConfigError(`${where}: "durationMs" must be a non-negative number`);
    }
  });

  if (flow.baseUrl !== undefined && typeof flow.baseUrl !== 'string') {
    throw new ConfigError(`${abs}: "baseUrl" must be a string`);
  }

  return {
    name: flow.name || path.basename(abs, path.extname(abs)),
    baseUrl: flow.baseUrl || null,
    // A floor on every step so a one-word narration still reads on screen.
    minStepMs: Number.isFinite(flow.minStepMs) ? flow.minStepMs : 1200,
    // Breathing room after the narration finishes, before the next step fires.
    stepPaddingMs: Number.isFinite(flow.stepPaddingMs) ? flow.stepPaddingMs : 600,
    steps: flow.steps,
    path: abs,
  };
}

module.exports = { loadFlow, readJson, stripJsonComments, ConfigError, ACTIONS };
