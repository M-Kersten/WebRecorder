'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * A copy of the browser's app bundle that calls itself Qapture.
 *
 * macOS takes the Dock name, the menu bar title and the icon from the .app
 * bundle owning the process. Nothing on a command line changes that, which is
 * why the window opens as "Chrome for Testing" however the page is titled. The
 * only thing that does change it is owning a bundle, so this makes one: the
 * browser's own, cloned, with its Info.plist rewritten and the Qapture icon
 * dropped in beside it.
 *
 * On APFS the clone is copy-on-write, so a few hundred megabytes of Chromium
 * costs a few kilobytes on disk and about a second to make. Rewriting the
 * Info.plist breaks the bundle's seal, so it is re-signed ad-hoc afterwards.
 *
 * Nothing here throws. A name in the Dock is never worth failing to open the
 * window over, so every path out is either a usable executable or null, and
 * the caller carries on with the browser exactly as it found it.
 */

const NAME = 'Qapture';
const BUNDLE_ID = 'ai.qapture.recorder';
const ICON = path.join(__dirname, '..', 'assets', 'brand', `${NAME}.icns`);

/** The `.app` an executable lives inside, or null if it does not live in one. */
function appBundle(executablePath) {
  if (!executablePath) return null;
  const macos = path.dirname(executablePath);
  const contents = path.dirname(macos);
  const app = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents') return null;
  if (path.extname(app) !== '.app') return null;
  return app;
}

const cacheDir = () => path.join(os.homedir(), 'Library', 'Caches', 'qapture');

/**
 * Which browser a wrapper was built from, written beside it.
 *
 * A Playwright update moves to a new revision in a new folder, and a wrapper
 * cloned from the old one points at a Chromium that is no longer there. The
 * stamp is what notices, rather than a version number nobody would remember to
 * bump.
 */
const stampFile = (target) => path.join(target, 'Contents', 'Resources', '.qapture-source');

function isCurrent(target, source) {
  try {
    return fs.readFileSync(stampFile(target), 'utf8') === source;
  } catch {
    return false;
  }
}

/**
 * Build the wrapper, or return null if anything at all gets in the way.
 *
 * `executablePath` is the browser Playwright would otherwise launch. The
 * return value is the same browser reached through a bundle with our name on
 * it, so it is passed to launch() in place of the original.
 */
function brandedExecutable(executablePath, options = {}) {
  const { log = () => {}, platform = process.platform } = options;
  if (platform !== 'darwin') return null;

  try {
    const source = appBundle(executablePath);
    if (!source || !fs.existsSync(ICON)) return null;

    const target = path.join(cacheDir(), `${NAME}.app`);
    const inner = path.join(target, 'Contents', 'MacOS', path.basename(executablePath));
    if (fs.existsSync(inner) && isCurrent(target, source)) return inner;

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(cacheDir(), { recursive: true });
    clone(source, target);
    if (!fs.existsSync(inner)) throw new Error('the copy has no executable in it');

    const plist = path.join(target, 'Contents', 'Info.plist');
    for (const [key, value] of [
      ['CFBundleName', NAME],
      ['CFBundleDisplayName', NAME],
      ['CFBundleIdentifier', BUNDLE_ID],
      ['CFBundleIconFile', `${NAME}.icns`],
    ]) {
      execFileSync('plutil', ['-replace', key, '-string', value, plist], { stdio: 'ignore' });
    }

    const resources = path.join(target, 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.copyFileSync(ICON, path.join(resources, `${NAME}.icns`));

    // The Info.plist and the icon are both sealed by the outer signature, so
    // it has to be remade. Ad-hoc, and only the outer bundle: the helpers
    // inside were not touched and keep the signatures they came with.
    execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'ignore' });

    fs.writeFileSync(stampFile(target), source, 'utf8');
    log(`the window will open as ${NAME}`);
    return inner;
  } catch (err) {
    log(`could not put this app's own name on the window (${firstLine(err)})`);
    return null;
  }
}

/**
 * Copy the bundle, asking for a clone first.
 *
 * -c is an APFS copy-on-write clone: instant, and it shares the blocks rather
 * than doubling Chromium on disk. It fails on anything that is not APFS, which
 * is what the second attempt is for.
 */
function clone(source, target) {
  try {
    execFileSync('cp', ['-Rc', source, target], { stdio: 'ignore' });
    return;
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
  }
  execFileSync('cp', ['-R', source, target], { stdio: 'ignore' });
}

/** Throw away the built wrapper, so the next launch makes a new one. */
function forget() {
  try {
    fs.rmSync(path.join(cacheDir(), `${NAME}.app`), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const firstLine = (err) => String(err && err.message ? err.message : err).split('\n')[0];

module.exports = { brandedExecutable, appBundle, forget, cacheDir, NAME, BUNDLE_ID, ICON };
