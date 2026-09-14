'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const catalog = require('../src/fontcatalog');

const REPO = path.join(__dirname, '..');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-catalog-'));
  fs.mkdirSync(path.join(dir, 'fonts'));
  for (const [as, from] of Object.entries(files)) {
    fs.copyFileSync(path.join(REPO, 'fonts', from), path.join(dir, 'fonts', as));
  }
  return dir;
}

// libass matches on the name inside the file and falls back to a system font
// when it does not. A name guessed from the file name is exactly how that
// happens quietly.
test('the family name comes out of the file, not out of its name', () => {
  const dir = project({ 'Whatever-Regular.ttf': 'SpaceGrotesk-Regular.ttf' });
  try {
    const fonts = catalog.scan(path.join(dir, 'fonts'), dir);
    assert.deepStrictEqual(Object.keys(fonts), ['space-grotesk']);
    assert.strictEqual(fonts['space-grotesk'].family, 'Space Grotesk');
    assert.strictEqual(fonts['space-grotesk'].file, 'fonts/Whatever-Regular.ttf');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Two weights of one family land in one folder, and libass picks between them
// on the bold flag alone. The file name is the only place a static instance
// says which of its family it is.
test('the weight comes out of the file name', () => {
  assert.deepStrictEqual(catalog.weightOf('Inter-Regular.ttf'), { weight: 400, style: 'normal' });
  assert.deepStrictEqual(catalog.weightOf('Inter-Bold.ttf'), { weight: 700, style: 'normal' });
  assert.deepStrictEqual(catalog.weightOf('Inter-SemiBold.ttf'), { weight: 600, style: 'normal' });
  assert.deepStrictEqual(catalog.weightOf('Inter-ExtraBold.ttf'), { weight: 800, style: 'normal' });
  assert.deepStrictEqual(catalog.weightOf('Inter-Light.ttf'), { weight: 300, style: 'normal' });
  assert.deepStrictEqual(catalog.weightOf('Inter-BoldItalic.ttf'), { weight: 700, style: 'italic' });
  // Overused Grotesk calls its 400 "Roman", and anything unrecognised is 400.
  assert.deepStrictEqual(catalog.weightOf('OverusedGrotesk-Roman.ttf'), { weight: 400, style: 'normal' });
  assert.deepStrictEqual(catalog.weightOf('Something.otf'), { weight: 400, style: 'normal' });
});

test('keys are the family and the weight, in a shape somebody could type', () => {
  assert.strictEqual(catalog.keyFor('Plus Jakarta Sans', 700, 'normal'), 'plus-jakarta-sans-bold');
  assert.strictEqual(catalog.keyFor('DM Sans', 400, 'normal'), 'dm-sans');
  assert.strictEqual(catalog.keyFor('Fraunces', 400, 'italic'), 'fraunces-italic');
  assert.strictEqual(catalog.labelFor({ family: 'Sora', weight: 700, style: 'normal' }), 'Sora Bold');
  assert.strictEqual(catalog.labelFor({ family: 'Sora', weight: 400, style: 'normal' }), 'Sora');
});

test('a folder that is not there, or holds junk, is simply no fonts', () => {
  assert.deepStrictEqual(catalog.scan('/nowhere/at/all'), {});

  const dir = project({ 'Inter-Regular.ttf': 'Inter-Regular.ttf' });
  try {
    fs.writeFileSync(path.join(dir, 'fonts', 'Broken-Regular.ttf'), 'not a font');
    fs.writeFileSync(path.join(dir, 'fonts', 'notes.txt'), 'ignore me');
    const fonts = catalog.scan(path.join(dir, 'fonts'), dir);
    assert.deepStrictEqual(Object.keys(fonts), ['inter'],
      'a file that will not parse is not a font worth offering');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped folder is the fourteen families the README lists', () => {
  const fonts = catalog.scan(path.join(REPO, 'fonts'), REPO);
  const families = [...new Set(Object.values(fonts).map((f) => f.family))].sort();
  assert.deepStrictEqual(families, [
    'Archivo', 'Bricolage Grotesque', 'DM Sans', 'Figtree', 'Fraunces', 'Inter',
    'JetBrains Mono', 'Manrope', 'Outfit', 'Overused Grotesk', 'Plus Jakarta Sans',
    'Poppins', 'Sora', 'Space Grotesk',
  ]);
  // Regular and Bold of each, so a style can set a title apart from its body.
  for (const family of families) {
    const weights = Object.values(fonts).filter((f) => f.family === family).map((f) => f.weight);
    assert.deepStrictEqual(weights.sort(), [400, 700], `${family} should ship both weights`);
  }

  // And the README's table says the same thing, so it cannot quietly drift.
  const readme = fs.readFileSync(path.join(REPO, 'fonts', 'README.md'), 'utf8');
  for (const [key, font] of Object.entries(fonts)) {
    assert.ok(readme.includes(`\`${key}\``), `${key} is missing from fonts/README.md`);
    assert.ok(readme.includes(`\`${font.family}\``), `${font.family} is missing from fonts/README.md`);
  }
});
