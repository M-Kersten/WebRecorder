'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadTheme, deepMerge, DEFAULTS } = require('../src/theme');
const { readFontFamilies, readFontMetrics } = require('../src/fontname');

const REPO = path.join(__dirname, '..');
const INTER = path.join(REPO, 'fonts', 'Inter-Regular.ttf');
const POPPINS = path.join(REPO, 'fonts', 'Poppins-Bold.ttf');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-theme-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

let n = 0;
/** Write a theme file in a temp dir and load it. */
function withTheme(obj) {
  const file = path.join(work, `theme-${n++}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return loadTheme(file);
}

test('a missing theme file is an error, not a silent default', () => {
  assert.throws(
    () => loadTheme(path.join(work, 'does-not-exist.json')),
    /No theme file at .*does-not-exist\.json/
  );
});

test('a partial theme fills in from the defaults', () => {
  const theme = withTheme({ captions: { fontSize: 50 } });
  assert.strictEqual(theme.captions.fontSize, 50);
  assert.strictEqual(theme.captions.color, DEFAULTS.captions.color, 'untouched fields survive');
  assert.strictEqual(theme.video.width, 1920);
  assert.strictEqual(theme.highlight.color, '#6C5CE7');
});

test('font files are resolved to absolute paths relative to the theme file', () => {
  const theme = withTheme({ fonts: { body: { file: INTER } } });
  assert.strictEqual(theme.fonts.body.path, INTER);
  assert.ok(path.isAbsolute(theme.fonts.body.path));
});

test('a missing font file names the key that is wrong', () => {
  assert.throws(
    () => withTheme({ fonts: { body: { family: 'Inter', file: 'fonts/Nope.ttf' } } }),
    /fonts\.body points at "fonts\/Nope\.ttf", which does not exist/
  );
});

// This is the failure the whole font-name check exists for: libass matches on
// the name inside the file and quietly renders a system font when it does not
// match, so the video comes out unbranded with no error anywhere.
test('a family name that disagrees with the file is rejected', () => {
  assert.throws(
    () => withTheme({ fonts: { body: { family: 'Intr', file: INTER } } }),
    /declares family "Intr", but Inter-Regular\.ttf calls itself "Inter"/
  );
});

test('the family name is read from the file when not declared', () => {
  const theme = withTheme({ fonts: { h: { file: POPPINS }, b: { file: INTER } } });
  assert.strictEqual(theme.fonts.h.family, 'Poppins');
  assert.strictEqual(theme.fonts.b.family, 'Inter');
});

test('a font reference to an undeclared key is rejected, and says what exists', () => {
  assert.throws(
    () => withTheme({ fonts: { body: { file: INTER } }, captions: { font: 'boddy' } }),
    /captions\.font refers to font "boddy".*Declared fonts: body/s
  );
  assert.throws(
    () => withTheme({ fonts: { body: { file: INTER } }, intro: { enabled: true, title: 'x', titleFont: 'heading' } }),
    /intro\.titleFont refers to font "heading"/
  );
});

test('an unset font reference is fine', () => {
  const theme = withTheme({ captions: { font: null } });
  assert.strictEqual(theme.captions.font, null);
  assert.strictEqual(theme.fontsDir, null);
});

test('fontsDir points at the caption font, which is what libass is given', () => {
  const theme = withTheme({ fonts: { body: { file: INTER } }, captions: { font: 'body' } });
  assert.strictEqual(theme.fontsDir, path.dirname(INTER));
});

test('colours must be hex', () => {
  assert.throws(() => withTheme({ highlight: { color: 'purple' } }), /must be a hex colour|must be a hex color/);
  assert.throws(() => withTheme({ captions: { color: '#12345' } }), /captions\.color must be a hex/);
  assert.doesNotThrow(() => withTheme({ highlight: { color: '#abc' } }), 'shorthand is allowed');
});

test('caption opacity and position are range-checked', () => {
  assert.throws(() => withTheme({ captions: { backgroundOpacity: 1.5 } }), /between 0 and 1/);
  assert.throws(() => withTheme({ captions: { position: 'middle' } }), /"bottom" or "top"/);
  assert.doesNotThrow(() => withTheme({ captions: { position: 'top', backgroundOpacity: 0 } }));
});

test('video dimensions must be even, because H.264 requires it', () => {
  assert.throws(() => withTheme({ video: { width: 1921, height: 1080, fps: 30 } }), /must both be even/);
  assert.throws(() => withTheme({ video: { width: 1920, height: 1080, fps: 0 } }), /positive integer/);
});

test('a gradient needs at least two colours, all of them valid', () => {
  assert.throws(
    () => withTheme({ intro: { enabled: true, title: 'x', backgroundGradient: ['#000000'] } }),
    /at least two hex colors|at least two hex colours/
  );
  assert.throws(
    () => withTheme({ intro: { enabled: true, title: 'x', backgroundGradient: ['#000000', 'red'] } }),
    /backgroundGradient\[1\]/
  );
});

test('an enabled card with nothing to show is rejected', () => {
  assert.throws(
    () => withTheme({ outro: { enabled: true, title: '', subtitle: '' } }),
    /outro is enabled but has no title, subtitle or logo/
  );
});

test('a missing logo file is reported with the path that was tried', () => {
  assert.throws(
    () => withTheme({ intro: { enabled: true, title: 'x', logo: 'assets/missing.png' } }),
    /intro\.logo points at "assets\/missing\.png"/
  );
});

test('a disabled card is not validated', () => {
  assert.doesNotThrow(() => withTheme({ intro: { enabled: false, durationSec: -5, logo: 'nope.png' } }));
});

test('deepMerge replaces arrays wholesale rather than merging them', () => {
  const merged = deepMerge({ a: { b: [1, 2, 3], c: 1 } }, { a: { b: [9] } });
  assert.deepStrictEqual(merged.a.b, [9]);
  assert.strictEqual(merged.a.c, 1);
});

test('the loaded theme stays one plain object, so CLI overrides stay a small diff', () => {
  const theme = withTheme({ captions: { fontSize: 40 } });
  const copy = JSON.parse(JSON.stringify(theme));
  assert.strictEqual(copy.captions.fontSize, 40);
  assert.strictEqual(copy.video.fps, 30);
});

test('font family names match what fontconfig reports', () => {
  assert.deepStrictEqual(readFontFamilies(INTER).families, ['Inter']);
  assert.deepStrictEqual(readFontFamilies(POPPINS).families, ['Poppins']);
});

test('font line span is the winAscent+winDescent ratio libass sizes text by', () => {
  // Inter: (2269 + 660) / 2048. Verified against a real libass render.
  assert.ok(Math.abs(readFontMetrics(INTER).lineSpan - 1.4302) < 0.001);
  assert.ok(Math.abs(readFontMetrics(POPPINS).lineSpan - 1.7620) < 0.001);
});

test('a file that is not a font is rejected before it reaches libass', () => {
  const fake = path.join(work, 'fake.ttf');
  fs.writeFileSync(fake, 'this is not a font');
  assert.throws(() => withTheme({ fonts: { body: { file: fake } } }), /not a TrueType\/OpenType font|too small/);
});

test('the shipped theme.example.json loads', () => {
  const theme = loadTheme(path.join(REPO, 'theme.example.json'));
  assert.strictEqual(theme.fonts.heading.family, 'Poppins');
  assert.strictEqual(theme.fonts.body.family, 'Inter');
  assert.strictEqual(theme.captions.font, 'body');
});
