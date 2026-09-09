'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { binaries, checkToolchain } = require('./ffmpeg');
const { resolveExecutablePath } = require('./browser');

/**
 * Get the machine ready before anybody is shown a window.
 *
 * Both things this needs are heavy downloads that used to be somebody else's
 * problem: ffmpeg came with a "brew install this" message, Chromium with a
 * "run npx playwright install". Neither is an instruction to put in front of a
 * colleague who just wants to record their screen. ffmpeg now ships with the
 * project, and the browser is fetched here, once, with visible progress.
 */

/** What is present right now. Fast, no downloads. */
async function inspect() {
  const report = {
    ffmpeg: { ok: true, path: null, bundled: false, error: null },
    browser: { ok: true, path: null },
    narration: !!process.env.ELEVENLABS_API_KEY,
  };

  const bins = binaries();
  report.ffmpeg.path = bins.ffmpeg;
  report.ffmpeg.bundled = bins.bundled;
  try {
    await checkToolchain();
  } catch (err) {
    report.ffmpeg.ok = false;
    report.ffmpeg.error = err.message;
  }

  const browser = findBrowser();
  report.browser.ok = !!browser;
  report.browser.path = browser;
  return report;
}

/**
 * A Chromium this machine can actually launch, or null.
 *
 * resolveExecutablePath returns null both when it found Playwright's own copy
 * and when it found nothing at all, so that alone cannot answer the question.
 */
function findBrowser() {
  try {
    const explicit = resolveExecutablePath();
    if (explicit && fs.existsSync(explicit)) return explicit;
  } catch {
    return null;
  }
  try {
    const own = require('playwright').chromium.executablePath();
    if (own && fs.existsSync(own)) return own;
  } catch {
    // Nothing installed: executablePath() throws rather than returning null.
  }
  return null;
}

/** The Playwright CLI that downloads browsers. */
function installerPath() {
  for (const pkg of ['playwright', 'playwright-core']) {
    try {
      const cli = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'cli.js');
      if (fs.existsSync(cli)) return cli;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

/** Download Chromium, streaming progress to `log`. */
function installBrowser(log = () => {}) {
  const cli = installerPath();
  if (!cli) {
    return Promise.reject(new Error(
      'The Playwright installer is missing. Run "npm install" in this folder first.'
    ));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      // The container this may run in sets this to stop npm doing the download
      // for us; here the download is the entire point.
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const onData = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) log(`  ${trimmed}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => reject(new Error(`Could not start the browser download: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(
        `The browser download did not finish (exit ${code}).\n` +
        `${tail.trim().split('\n').slice(-6).join('\n')}`
      ));
    });
  });
}

/**
 * Check, and fetch whatever is missing.
 *
 * Returns the report. Throws only when something is missing that cannot be
 * fixed here, so the caller can say so once rather than failing later in the
 * middle of a recording.
 */
async function ensureReady(options = {}) {
  const { log = () => {}, installBrowsers = true } = options;
  let report = await inspect();

  if (!report.browser.ok && installBrowsers) {
    log('Setting up the browser. This happens once and takes a few minutes.');
    await installBrowser(log);
    report = await inspect();
    if (!report.browser.ok) {
      throw new Error(
        'The browser still is not there after downloading it. ' +
        'Check that this machine can reach the internet.'
      );
    }
    log('Browser ready.');
  }

  return report;
}

/** One-line-per-item summary for the terminal. */
function describe(report) {
  const lines = [];
  lines.push(report.ffmpeg.ok
    ? `  video tools   ready${report.ffmpeg.bundled ? ' (bundled with the project)' : ` (${report.ffmpeg.path})`}`
    : `  video tools   MISSING\n${indent(report.ffmpeg.error)}`);
  lines.push(report.browser.ok
    ? `  browser       ready`
    : '  browser       MISSING');
  lines.push(report.narration
    ? '  narration     ready (ELEVENLABS_API_KEY is set)'
    : '  narration     off (no ELEVENLABS_API_KEY, videos will be silent)');
  return lines.join('\n');
}

const indent = (text) => String(text || '').split('\n').map((l) => `      ${l}`).join('\n');

module.exports = { inspect, ensureReady, describe, findBrowser, installerPath, installBrowser };
