'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

/**
 * Work out which Chromium to launch.
 *
 * Playwright normally resolves this itself, but it looks for the exact browser
 * revision its npm version was built against. On a machine with a pre-installed
 * browser of a different revision - CI images and sandboxes usually have one -
 * that lookup fails even though a perfectly good Chromium is sitting there. So:
 * an explicit env var wins, then a browser found under PLAYWRIGHT_BROWSERS_PATH,
 * then Playwright's own resolution.
 */
function resolveExecutablePath() {
  const explicit = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`CHROMIUM_EXECUTABLE_PATH points at ${explicit}, which does not exist`);
    }
    return explicit;
  }

  // Playwright's own copy, if the pinned revision happens to be present.
  try {
    const own = chromium.executablePath();
    if (own && fs.existsSync(own)) return null; // null = let Playwright do it
  } catch {
    // executablePath() throws when nothing is installed; fall through.
  }

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && fs.existsSync(root)) {
    const found = findChromium(root);
    if (found) return found;
  }
  return null;
}

/** Any chromium-* build under the browsers root, newest revision first. */
function findChromium(root) {
  const candidates = fs.readdirSync(root)
    .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
    .sort((a, b) => revision(b) - revision(a));

  for (const dir of candidates) {
    for (const rel of [
      path.join('chrome-linux', 'chrome'),
      path.join('chrome-linux', 'headless_shell'),
      path.join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
      path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join('chrome-win', 'chrome.exe'),
    ]) {
      const candidate = path.join(root, dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // A bare symlink such as <root>/chromium also counts.
  const link = path.join(root, 'chromium');
  if (fs.existsSync(link) && fs.statSync(link).isFile()) return link;
  return null;
}

const revision = (name) => Number(name.match(/(\d+)$/)[1]);

/** chromium.launch, with the executable resolved as above. */
async function launch(options = {}) {
  const executablePath = resolveExecutablePath();
  try {
    return await chromium.launch(executablePath ? { ...options, executablePath } : options);
  } catch (err) {
    if (/Executable doesn't exist/i.test(err.message)) {
      throw new Error(
        `${err.message.split('\n')[0]}\n\n` +
        'No usable Chromium was found. Run "site-tutorial-video setup" to fetch it, ' +
        'or point CHROMIUM_EXECUTABLE_PATH at an existing Chromium binary.'
      );
    }
    throw err;
  }
}

module.exports = { launch, resolveExecutablePath, findChromium };
