'use strict';

const { ConfigError } = require('./config');

/**
 * ${VAR} interpolation for flow files, so a password never has to be written
 * into flow.json and committed alongside it.
 *
 * Only the fields that need it are interpolated - urls and typed text - and the
 * resolved value is deliberately never returned to anything that logs. A step
 * that contained a placeholder is marked, and the console shows dots instead.
 */

// A fresh regex per use. A shared /g regex carries lastIndex between calls, so
// .test() on one silently alternates true and false on identical input.
const PATTERN = String.raw`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`;
const placeholders = () => new RegExp(PATTERN, 'g');

/** Does this string reference an environment variable? */
const hasPlaceholder = (value) => typeof value === 'string' && new RegExp(PATTERN).test(value);

/**
 * Replace every ${VAR} with its value from `env`.
 * Throws naming the variable and where it was used, rather than substituting an
 * empty string and letting the recording fail somewhere less obvious.
 */
function interpolate(value, env, where) {
  if (typeof value !== 'string') return value;
  return value.replace(placeholders(), (_, name) => {
    const found = env[name];
    if (found === undefined || found === '') {
      throw new ConfigError(
        `${where} uses \${${name}}, but that environment variable is not set.\n` +
        `Set it before recording, for example:\n  export ${name}='...'`
      );
    }
    return found;
  });
}

/**
 * Resolve placeholders throughout a flow, in place.
 * Returns the names of the variables that were used, for the run summary.
 */
function resolveFlowSecrets(flow, env = process.env) {
  const used = new Set();

  const take = (value, where) => {
    if (!hasPlaceholder(value)) return value;
    for (const match of value.matchAll(placeholders())) used.add(match[1]);
    return interpolate(value, env, where);
  };

  flow.baseUrl = take(flow.baseUrl, `${flow.path}: baseUrl`);

  flow.steps.forEach((step, i) => {
    const where = `${flow.path}: steps[${i}]`;
    // A step whose typed text came from the environment is treated as secret
    // from here on: it is the password field in all but name.
    if (hasPlaceholder(step.text)) step.secret = true;
    step.text = take(step.text, `${where}.text`);
    step.url = take(step.url, `${where}.url`);
  });

  if (flow.auth && Array.isArray(flow.auth.steps)) {
    flow.auth.steps.forEach((step, i) => {
      const where = `${flow.path}: auth.steps[${i}]`;
      if (hasPlaceholder(step.text)) step.secret = true;
      step.text = take(step.text, `${where}.text`);
      step.url = take(step.url, `${where}.url`);
    });
  }

  return [...used];
}

/** Stand-in for a secret in anything that gets printed. */
const REDACTED = '•••••';

module.exports = { interpolate, resolveFlowSecrets, hasPlaceholder, REDACTED };
