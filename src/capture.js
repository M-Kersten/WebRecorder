'use strict';

const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');
const { buildPanelScript } = require('./capture-panel');
const { ConfigError } = require('./config');

/**
 * Record a flow by walking through the site.
 *
 * Writing flow.json by hand means finding a CSS selector for every step, which
 * means devtools open beside the editor for the length of the walkthrough. Here
 * the browser is the editor: use the site, and the steps come out of what you
 * did. Node keeps the list, so it survives every navigation the site makes.
 */
async function capture(options = {}) {
  const {
    url,
    outFile,
    viewport = { width: 1440, height: 900 },
    log = () => {},
    // Headed is the point: you are meant to see and use the site. Tests drive
    // it headless and finish it themselves through onReady.
    headless = false,
    onReady = null,
  } = options;

  if (!url) throw new ConfigError('capture needs a --url to start from');

  const steps = [];
  let finished = null;
  const done = new Promise((resolve) => { finished = resolve; });

  const browser = await launch({ headless });
  const context = await browser.newContext({ viewport });

  // Bindings live on the context, so they survive navigation the same way the
  // panel script does.
  await context.exposeBinding('__tutCaptureAdd', (_source, step) => {
    steps.push(normalise(step));
    log(`  ${steps.length}. ${summarise(steps[steps.length - 1])}`);
    return steps;
  });
  await context.exposeBinding('__tutCaptureList', () => steps);
  await context.exposeBinding('__tutCaptureUpdate', (_source, index, patch) => {
    if (steps[index]) Object.assign(steps[index], patch);
    return steps;
  });
  await context.exposeBinding('__tutCaptureRemove', (_source, index) => {
    if (index >= 0 && index < steps.length) steps.splice(index, 1);
    return steps;
  });
  await context.exposeBinding('__tutCaptureDone', () => { finished('saved'); });

  await context.addInitScript(buildPanelScript());

  const page = await context.newPage();
  // The first step is always getting there.
  steps.push(normalise({ action: 'goto', url }));

  // Any way the browser can go away has to end the wait.
  page.on('close', () => finished('closed'));
  context.on('close', () => finished('closed'));
  browser.on('disconnected', () => finished('closed'));

  await page.goto(url, { waitUntil: 'load' }).catch((err) => {
    throw new ConfigError(`Could not open ${url}\n${err.message.split('\n')[0]}`);
  });

  log('');
  log('  The browser is open. Use the site as you normally would.');
  log('  Every click and everything you type is written down.');
  log('  Fill in narration and hints in the panel, then press "Save flow".');
  log('');

  // A driver that throws must not leave the session waiting forever for a
  // "Save flow" that is never coming.
  if (onReady) {
    try {
      await onReady(page, { steps, finish: () => finished('saved') });
    } catch (err) {
      finished('error');
      await browser.close().catch(() => {});
      throw err;
    }
  }
  const reason = await done;
  await browser.close().catch(() => {});

  const flow = toFlow(steps, url);
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  }
  return { flow, steps, reason };
}

/** Fill in the fields the panel and the flow schema both expect. */
function normalise(step) {
  return {
    action: step.action || 'click',
    ...(step.selector ? { selector: step.selector } : {}),
    ...(step.url ? { url: step.url } : {}),
    ...(step.text !== undefined ? { text: step.text } : {}),
    narration: step.narration || '',
    hint: step.hint || '',
    label: step.label || '',
    ...(step.secret ? { secret: true } : {}),
  };
}

/**
 * Turn the captured list into a flow file: relative urls against a baseUrl,
 * empty narration and hints dropped, and the panel's own bookkeeping removed.
 */
function toFlow(steps, startUrl) {
  const origin = new URL(startUrl).origin;
  const out = steps.map((step) => {
    const clean = { action: step.action };
    if (step.selector) clean.selector = step.selector;
    if (step.url) {
      clean.url = step.url.startsWith(origin) ? step.url.slice(origin.length) || '/' : step.url;
    }
    if (step.text !== undefined) clean.text = step.text;
    if (step.action === 'wait' && step.durationMs === undefined) clean.durationMs = 1500;
    if (step.narration) clean.narration = step.narration;
    if (step.hint) clean.hint = step.hint;
    return clean;
  });

  return {
    name: new URL(startUrl).hostname + ' walkthrough',
    baseUrl: origin,
    minStepMs: 1400,
    stepPaddingMs: 600,
    steps: out,
  };
}

function summarise(step) {
  const what = step.label ? `"${step.label}"` : step.selector || step.url || '';
  return `${step.action} ${what}`.trim();
}

module.exports = { capture, toFlow, normalise };
