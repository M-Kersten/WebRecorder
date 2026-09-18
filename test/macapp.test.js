'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const macapp = require('../src/macapp');

/**
 * The window's name in the Dock.
 *
 * macOS reads it from the app bundle owning the process, so a page titled
 * "Qapture" still opens as whatever Playwright's Chromium calls itself. The
 * answer is a cloned bundle, and most of what is worth testing about it is
 * that it gets out of the way: this runs on machines that are not Macs, and a
 * name is never worth failing to open the window over.
 */

test('an executable inside an app bundle is traced back to it', () => {
  assert.strictEqual(
    macapp.appBundle('/p/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    '/p/chromium-1234/chrome-mac/Chromium.app'
  );
  assert.strictEqual(
    macapp.appBundle('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    '/Applications/Google Chrome for Testing.app'
  );
});

test('anything that is not in a bundle is not one', () => {
  for (const bad of [
    '/p/chromium-1234/chrome-linux/chrome',
    'C:\\p\\chrome-win\\chrome.exe',
    '/usr/bin/chromium',
    '/Some.app/MacOS/Chromium',            // no Contents
    '/Some.dir/Contents/MacOS/Chromium',   // not an .app
    '', null, undefined,
  ]) {
    assert.strictEqual(macapp.appBundle(bad), null, JSON.stringify(bad));
  }
});

test('nothing is built anywhere but macOS', () => {
  for (const platform of ['linux', 'win32', 'freebsd']) {
    assert.strictEqual(
      macapp.brandedExecutable('/x/Chromium.app/Contents/MacOS/Chromium', { platform }),
      null, platform
    );
  }
});

// Every way this can go wrong ends the same way, because the caller's next
// move is to launch the browser as it found it.
test('a bundle it cannot build reports null rather than throwing', () => {
  const said = [];
  const log = (line) => said.push(line);
  assert.strictEqual(
    macapp.brandedExecutable('/does/not/exist/Chromium.app/Contents/MacOS/Chromium',
      { platform: 'darwin', log }),
    null
  );
  assert.strictEqual(macapp.brandedExecutable(null, { platform: 'darwin', log }), null);
  assert.strictEqual(macapp.brandedExecutable('', { platform: 'darwin', log }), null);
});

test('forgetting a wrapper that was never built is not a failure', () => {
  assert.strictEqual(macapp.forget(), true);
});

/**
 * The icon file itself, walked the way macOS walks it: 'icns', a total length,
 * then one PNG per size behind a four-character type. A truncated or
 * misaligned container is a blank icon with nothing anywhere saying why, and
 * it is built from an SVG by a script rather than by hand.
 */
test('the shipped icon is an icns macOS can read', () => {
  const data = fs.readFileSync(macapp.ICON);
  assert.strictEqual(data.toString('ascii', 0, 4), 'icns');
  assert.strictEqual(data.readUInt32BE(4), data.length, 'the declared length is the file');

  const sizes = new Set();
  let at = 8;
  while (at < data.length) {
    const type = data.toString('ascii', at, at + 4);
    const length = data.readUInt32BE(at + 4);
    assert.ok(length > 8 && at + length <= data.length, `${type} runs past the end`);
    const png = data.subarray(at + 8, at + length);
    assert.strictEqual(png.toString('ascii', 1, 4), 'PNG', `${type} is not a PNG`);
    // IHDR is the first chunk, so the dimensions sit at a fixed offset.
    assert.strictEqual(png.readUInt32BE(16), png.readUInt32BE(20), `${type} is not square`);
    sizes.add(png.readUInt32BE(16));
    at += length;
  }
  assert.strictEqual(at, data.length, 'the entries do not add up to the file');
  // The ones macOS actually reaches for: the Dock, Cmd-Tab, and Retina.
  for (const size of [16, 32, 128, 256, 512, 1024]) {
    assert.ok(sizes.has(size), `no ${size}px icon`);
  }
});
