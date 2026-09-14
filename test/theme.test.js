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
  assert.strictEqual(theme.fonts.inter.family, 'Inter');
  assert.strictEqual(theme.fonts['poppins-bold'].family, 'Poppins');
  assert.strictEqual(theme.captions.font, 'inter');
});

// Nothing has to be declared: the fonts folder beside a theme is its catalogue,
// so dropping a .ttf in is all it takes to use it.
test('every font in the folder is offered to every style', () => {
  const theme = loadTheme(path.join(REPO, 'theme.json'));
  const names = fs.readdirSync(path.join(REPO, 'fonts')).filter((f) => /\.(ttf|otf)$/i.test(f));
  assert.strictEqual(Object.keys(theme.fonts).length, names.length);
  for (const key of ['inter', 'inter-bold', 'space-grotesk', 'fraunces-bold', 'jetbrains-mono']) {
    assert.ok(theme.fonts[key], `${key} should be there without being declared`);
  }
  assert.strictEqual(theme.fonts['fraunces-bold'].weight, 700, 'weight read from the file name');
  assert.strictEqual(theme.fonts.fraunces.weight, 400);
});

// A key a style declares is that style's own, whatever the folder holds.
test('a declared font wins over the folder', () => {
  const dir = fs.mkdtempSync(path.join(work, 'project-'));
  fs.mkdirSync(path.join(dir, 'fonts'));
  for (const name of ['Inter-Regular.ttf', 'Inter-Bold.ttf']) {
    fs.copyFileSync(path.join(REPO, 'fonts', name), path.join(dir, 'fonts', name));
  }
  const file = path.join(dir, 'theme.json');
  fs.writeFileSync(file, JSON.stringify({
    fonts: { inter: { file: path.join(REPO, 'fonts', 'Sora-Bold.ttf'), weight: 700 } },
    captions: { font: 'inter' },
  }));

  const theme = loadTheme(file);
  assert.strictEqual(theme.fonts.inter.family, 'Sora', 'the declaration decides');
  assert.strictEqual(theme.fonts['inter-bold'].family, 'Inter', 'and the rest are untouched');
});

// A folder with nothing in it is not an error: a theme that declares its own
// fonts has never needed one.
test('a project with no fonts folder still loads', () => {
  const theme = withTheme({ captions: { enabled: true } });
  assert.deepStrictEqual(theme.fonts, {});
  assert.strictEqual(theme.captions.font, null);
});

test('captions are off unless a theme or a flag turns them on', () => {
  assert.strictEqual(withTheme({}).captions.enabled, false);
  assert.strictEqual(withTheme({ captions: { enabled: true } }).captions.enabled, true);
});

test('hints and fades are on by default', () => {
  const theme = withTheme({});
  assert.strictEqual(theme.hints.enabled, true);
  assert.strictEqual(theme.transitions.enabled, true);
  assert.ok(theme.transitions.fadeSec > 0);
});

test('a cursor image is resolved and checked', () => {
  const png = path.join(REPO, 'assets', 'cursor.png');
  const theme = withTheme({ cursor: { image: png } });
  assert.strictEqual(theme.cursor.imagePath, png);

  assert.throws(
    () => withTheme({ cursor: { image: 'assets/nope.png' } }),
    /cursor\.image points at "assets\/nope\.png"/
  );
});

test('a cursor image the browser cannot draw is rejected with a reason', () => {
  const notAnImage = path.join(work, 'pointer.tiff');
  fs.writeFileSync(notAnImage, 'x');
  assert.throws(() => withTheme({ cursor: { image: notAnImage } }), /which the browser cannot draw/);
});

test('the cursor hotspot must be two fractions', () => {
  assert.doesNotThrow(() => withTheme({ cursor: { hotspot: [0, 0] } }));
  assert.doesNotThrow(() => withTheme({ cursor: { hotspot: [1, 1] } }));
  assert.throws(() => withTheme({ cursor: { hotspot: [0.5] } }), /two numbers between 0 and 1/);
  assert.throws(() => withTheme({ cursor: { hotspot: [0.5, 2] } }), /two numbers between 0 and 1/);
  assert.throws(() => withTheme({ cursor: { hotspot: '0.5,0.5' } }), /two numbers between 0 and 1/);
});

test('cursor easing and timings are checked', () => {
  assert.doesNotThrow(() => withTheme({ cursor: { easing: 'easeOut', moveMs: 500 } }));
  assert.doesNotThrow(() => withTheme({ cursor: { moveMs: null } }), 'null means follow the distance');
  assert.throws(() => withTheme({ cursor: { easing: 'bouncy' } }), /cursor\.easing must be one of/);
  assert.throws(() => withTheme({ cursor: { moveMs: -1 } }), /cursor\.moveMs/);
  assert.throws(() => withTheme({ cursor: { rippleMs: 0 } }), /cursor\.rippleMs must be a positive number/);
});

test('an unset rippleColor is allowed and falls back to the highlight colour', () => {
  const theme = withTheme({ cursor: { rippleColor: null } });
  assert.strictEqual(theme.cursor.rippleColor, null);
  assert.throws(() => withTheme({ cursor: { rippleColor: 'teal' } }), /cursor\.rippleColor must be a hex/);
});

test('hint position must be one this tool knows how to place', () => {
  for (const spot of ['auto', 'top-left', 'top-center', 'top-right',
    'bottom-left', 'bottom-center', 'bottom-right']) {
    assert.doesNotThrow(() => withTheme({ hints: { position: spot } }), spot);
  }
  assert.throws(() => withTheme({ hints: { position: 'middle' } }), /hints\.position must be one of/);
});

test('hint numbers and colours are checked', () => {
  assert.throws(() => withTheme({ hints: { fontSize: -2 } }), /hints\.fontSize/);
  assert.throws(() => withTheme({ hints: { backgroundOpacity: 2 } }), /hints\.backgroundOpacity/);
  assert.throws(() => withTheme({ hints: { accentColor: 'purple' } }), /hints\.accentColor must be a hex/);
});

test('a hint font reference is checked like every other font reference', () => {
  assert.throws(
    () => withTheme({ fonts: { body: { file: INTER } }, hints: { font: 'nope' } }),
    /hints\.font refers to font "nope"/
  );
});

test('fade length is sanity-checked against segment length', () => {
  assert.doesNotThrow(() => withTheme({ transitions: { fadeSec: 0 } }), 'zero disables it');
  assert.throws(() => withTheme({ transitions: { fadeSec: -1 } }), /non-negative/);
  assert.throws(() => withTheme({ transitions: { fadeSec: 5 } }), /longer than any segment wants/);
});

test('the stage background colour is validated', () => {
  assert.strictEqual(withTheme({}).video.backgroundColor, '#0F1115');
  assert.throws(() => withTheme({ video: { backgroundColor: 'black' } }), /video\.backgroundColor must be a hex/);
});

test('the shipped example themes all load', () => {
  for (const file of ['theme.example.json', 'theme.json', 'theme-social.json']) {
    assert.doesNotThrow(() => loadTheme(path.join(REPO, file)), file);
  }
});

test('the hint accent defaults to none and is validated', () => {
  assert.strictEqual(withTheme({}).hints.accent, 'none');
  assert.doesNotThrow(() => withTheme({ hints: { accent: 'bar' } }));
  assert.throws(() => withTheme({ hints: { accent: 'stripe' } }), /hints\.accent must be one of none, bar/);
});

test('the hint border colour is optional and derived when unset', () => {
  assert.strictEqual(withTheme({}).hints.borderColor, null);
  assert.doesNotThrow(() => withTheme({ hints: { borderColor: '#333333' } }));
  assert.throws(() => withTheme({ hints: { borderColor: 'grey' } }), /hints\.borderColor must be a hex/);
});

test('Overused Grotesk is bundled as two static weights of one family', () => {
  const theme = loadTheme(path.join(REPO, 'theme-rebels.json'));
  const roman = theme.fonts['overused-grotesk'];
  const bold = theme.fonts['overused-grotesk-bold'];
  assert.strictEqual(roman.family, 'Overused Grotesk');
  assert.strictEqual(bold.family, 'Overused Grotesk');
  // Its 400 is called Roman; there is no file called Regular.
  assert.match(roman.file, /Roman/);
  assert.strictEqual(roman.weight, 400);
  assert.strictEqual(bold.weight, 700);
  // Same family name in one folder, so libass picks between them on the bold
  // flag alone. That is what the weight on each declaration is for.
  assert.strictEqual(theme.captions.font, 'overused-grotesk');
});
