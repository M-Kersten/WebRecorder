'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('../src/settings');
const { loadTheme, deepMerge } = require('../src/theme');
const { listPlaceholders } = require('../src/secrets');

const REPO = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-settings-'));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

let n = 0;
const tmpFile = () => path.join(work, `settings-${n++}.json`);

test('every field names a real place in the theme or the flow', () => {
  const theme = loadTheme(path.join(REPO, 'theme.json'));
  const flow = { minStepMs: 1, stepPaddingMs: 1, typeDelayMs: 1 };
  const values = settings.readValues(theme, flow);
  for (const field of settings.FIELDS) {
    assert.ok(field.key in values, `${field.key} was not read`);
    assert.ok(['number', 'boolean', 'select', 'color', 'text', 'font', 'voice'].includes(field.type),
      `${field.key} has an unknown type "${field.type}"`);
    assert.ok(field.label && field.section, `${field.key} needs a label and a section`);
    if (field.type === 'select') assert.ok(field.options.length, `${field.key} needs options`);
  }
  // And a couple of the values are the real ones, not undefined.
  assert.strictEqual(values['theme.cursor.easing'], theme.cursor.easing);
  assert.strictEqual(values['flow.minStepMs'], 1);
});

test('a flat form becomes a nested layer', () => {
  const layer = settings.toLayer({
    'theme.cursor.moveMs': '450',
    'theme.cursor.ripple': false,
    'flow.minStepMs': 1800,
  });
  assert.deepStrictEqual(layer, {
    theme: { cursor: { moveMs: 450, ripple: false } },
    flow: { minStepMs: 1800 },
  });
});

// The form should not be able to put whatever it likes into the theme.
test('a key that is not a setting is refused', () => {
  // The form can only reach what FIELDS lists. Everything else in the theme,
  // including anything that takes a file path, stays out of its hands.
  assert.throws(() => settings.toLayer({ 'theme.cursor.image': '/etc/passwd' }), /is not a setting/);
  assert.throws(() => settings.toLayer({ 'theme.intro.logo': 'x.png' }), /is not a setting/);
  assert.throws(() => settings.toLayer({ 'theme.fonts.body.file': 'x.ttf' }), /is not a setting/);
  assert.throws(() => settings.toLayer({ '__proto__.x': 1 }), /is not a setting/);
  assert.throws(() => settings.toLayer({ 'flow.steps': [] }), /is not a setting/);
});

test('numbers are range-checked with the reason spelled out', () => {
  assert.throws(() => settings.toLayer({ 'theme.video.width': 1921 }), /even number of pixels/);
  assert.throws(() => settings.toLayer({ 'theme.video.fps': 200 }), /cannot be above 60/);
  assert.throws(() => settings.toLayer({ 'flow.minStepMs': -5 }), /cannot be below 0/);
  assert.throws(() => settings.toLayer({ 'theme.cursor.moveMs': 'quickly' }), /is not a number/);
  assert.throws(() => settings.toLayer({ 'theme.cursor.easing': 'bouncy' }), /is not one of/);
});

test('an empty travel time means "follow the distance", not zero', () => {
  assert.strictEqual(settings.toLayer({ 'theme.cursor.moveMs': '' }).theme.cursor.moveMs, null);
  // A field that cannot be null is left alone instead of being blanked.
  assert.deepStrictEqual(settings.toLayer({ 'flow.minStepMs': '' }), { theme: {}, flow: {} });
});

// theme.json is meant to be read and edited by hand, and is full of comments
// explaining itself. Writing it back from a form would throw all of that away.
test('saving writes its own file and leaves the theme alone', () => {
  const themeCopy = path.join(work, 'theme.json');
  fs.copyFileSync(path.join(REPO, 'theme.json'), themeCopy);
  const before = fs.readFileSync(themeCopy, 'utf8');
  assert.ok(before.includes('//'), 'the theme has comments to lose');

  const file = tmpFile();
  settings.saveSettings(file, { 'theme.cursor.moveMs': 700 });

  assert.strictEqual(fs.readFileSync(themeCopy, 'utf8'), before, 'the theme is untouched');
  assert.deepStrictEqual(settings.loadSettings(file).theme, { cursor: { moveMs: 700 } });
});

test('a missing settings file is an empty layer, not an error', () => {
  assert.deepStrictEqual(settings.loadSettings(path.join(work, 'nope.json')),
    { theme: {}, flow: {}, style: 'theme.json', styles: {} });
});

test('the layer only moves what it names', () => {
  const theme = loadTheme(path.join(REPO, 'theme-rebels.json'));
  const merged = deepMerge(theme, { cursor: { moveMs: 900 } });
  assert.strictEqual(merged.cursor.moveMs, 900);
  assert.strictEqual(merged.cursor.easing, theme.cursor.easing);
  assert.strictEqual(merged.highlight.color, theme.highlight.color);
  assert.strictEqual(merged.intro.title, theme.intro.title);
});

// --- passwords ---------------------------------------------------------

test('secrets are stored, cleared, and locked down', () => {
  const dir = fs.mkdtempSync(path.join(work, 'secrets-'));
  settings.saveSecrets(dir, { PORTAL_PASSWORD: 'hunter2', PORTAL_EMAIL: 'a@b.test' });
  assert.deepStrictEqual(settings.loadSecrets(dir), {
    PORTAL_PASSWORD: 'hunter2', PORTAL_EMAIL: 'a@b.test',
  });

  if (process.platform !== 'win32') {
    const mode = fs.statSync(settings.secretsPath(dir)).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  }

  settings.saveSecrets(dir, { PORTAL_EMAIL: '' });
  assert.deepStrictEqual(Object.keys(settings.loadSecrets(dir)), ['PORTAL_PASSWORD']);
});

test('a name that is not a variable name is refused', () => {
  const dir = fs.mkdtempSync(path.join(work, 'secrets-bad-'));
  assert.throws(() => settings.saveSecrets(dir, { 'not a name': 'x' }), /not a usable variable name/);
});

// A value in the environment is the deliberate one: a CI secret or something
// exported in a shell should not be replaced by something typed months ago.
test('the environment wins over a saved password', () => {
  const dir = fs.mkdtempSync(path.join(work, 'secrets-env-'));
  settings.saveSecrets(dir, { FROM_FILE: 'file-value', ALSO_IN_ENV: 'file-value' });

  const env = { ALSO_IN_ENV: 'env-value' };
  const applied = settings.applySecrets(dir, env);

  assert.strictEqual(env.FROM_FILE, 'file-value');
  assert.strictEqual(env.ALSO_IN_ENV, 'env-value', 'the environment was not overwritten');
  assert.deepStrictEqual(applied, ['FROM_FILE']);
});

test('the flow says which passwords to ask for', () => {
  const flow = {
    baseUrl: 'https://${HOST}',
    steps: [{ action: 'type', text: '${PORTAL_PASSWORD}' }, { action: 'click' }],
    auth: { steps: [{ action: 'type', text: '${PORTAL_EMAIL}' }] },
  };
  assert.deepStrictEqual(listPlaceholders(flow).sort(),
    ['HOST', 'PORTAL_EMAIL', 'PORTAL_PASSWORD']);
  assert.deepStrictEqual(listPlaceholders({ steps: [{ action: 'click' }] }), [],
    'a flow that signs in nowhere asks for nothing');
});

// --- colours, type and card text ---------------------------------------

test('colours are taken as hex, upper-cased, and checked', () => {
  const layer = settings.toLayer({ 'theme.highlight.color': '#e6007e' });
  assert.strictEqual(layer.theme.highlight.color, '#E6007E');
  assert.strictEqual(settings.toLayer({ 'theme.hints.color': '#fff' }).theme.hints.color, '#FFF');

  assert.throws(() => settings.toLayer({ 'theme.highlight.color': 'bright pink' }),
    /is not a colour. Use a hex value/);
  assert.throws(() => settings.toLayer({ 'theme.cursor.color': '#12345' }), /is not a colour/);
});

test('an empty colour means the default where one is allowed, and nothing where it is not', () => {
  // The click ripple falls back to the highlight colour.
  assert.strictEqual(settings.toLayer({ 'theme.cursor.rippleColor': '' }).theme.cursor.rippleColor, null);
  // The ring itself has no "unset", so leave it as it was rather than blanking it.
  assert.deepStrictEqual(settings.toLayer({ 'theme.highlight.color': '  ' }), { theme: {}, flow: {} });
});

test('a font has to be one the project has', () => {
  const context = { fontKeys: ['poppins-bold', 'inter'] };
  assert.strictEqual(settings.toLayer({ 'theme.intro.titleFont': 'poppins-bold' }, context)
    .theme.intro.titleFont, 'poppins-bold');
  assert.strictEqual(settings.toLayer({ 'theme.captions.font': '' }, context)
    .theme.captions.font, null);

  assert.throws(() => settings.toLayer({ 'theme.intro.titleFont': 'Comic Sans' }, context),
    /there is no font called "Comic Sans". This style has: poppins-bold, inter/);

  // A fonts folder listed back in full is a wall of text, so it is trimmed.
  const many = { fontKeys: Array.from({ length: 28 }, (_, i) => `face-${i}`) };
  assert.throws(() => settings.toLayer({ 'theme.captions.font': 'nope' }, many),
    /face-0, face-1, face-2, face-3, face-4, face-5, face-6, face-7, and 20 more/);
});

test('card text is kept as typed, within a length', () => {
  const layer = settings.toLayer({
    'theme.intro.title': 'Q Portal',
    'theme.outro.subtitle': '',
  });
  assert.strictEqual(layer.theme.intro.title, 'Q Portal');
  assert.strictEqual(layer.theme.outro.subtitle, '', 'clearing a subtitle is allowed');
  assert.throws(() => settings.toLayer({ 'theme.intro.title': 'x'.repeat(200) }), /longer than 120/);
});

test('every colour and font field points at something the theme really has', () => {
  const theme = loadTheme(path.join(REPO, 'theme-rebels.json'));
  const values = settings.readValues(theme, {});
  for (const field of settings.FIELDS.filter((f) => ['color', 'font'].includes(f.type))) {
    const value = values[field.key];
    if (value === null || value === undefined) {
      assert.ok(field.nullable, `${field.key} came back empty but is not nullable`);
      continue;
    }
    if (field.type === 'color') assert.match(String(value), /^#[0-9A-Fa-f]{3,6}$/, field.key);
    else assert.ok(theme.fonts[value], `${field.key} names a font the theme does not have`);
  }
});

// --- the voice ----------------------------------------------------------

const { loadVoices } = require('../src/voices');

test('a voice has to be one the project lists', () => {
  const context = { voiceIds: ['abc123', 'def456'] };
  assert.deepStrictEqual(
    settings.toLayer({ 'flow.voiceId': 'def456' }, context),
    { theme: {}, flow: { voiceId: 'def456' } }
  );

  // The dropdown is built from voices.json, so anything else arrived by
  // another route and should not reach the synthesiser.
  assert.throws(() => settings.toLayer({ 'flow.voiceId': 'made-up' }, context),
    /not in voices.json/);
  assert.throws(() => settings.toLayer({ 'flow.voiceId': 'made-up' }, context),
    /abc123, def456/);
});

test('choosing nothing means the stock voice, not a broken one', () => {
  assert.deepStrictEqual(
    settings.toLayer({ 'flow.voiceId': '' }, { voiceIds: ['abc123'] }),
    { theme: {}, flow: { voiceId: null } }
  );
});

test('a project with no voices.json still offers one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-voices-'));
  try {
    const voices = loadVoices(dir);
    assert.strictEqual(voices.length, 1);
    assert.ok(voices[0].id && voices[0].name, 'so the dropdown is never empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the list is read as written, comments and all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-voices-'));
  try {
    fs.writeFileSync(path.join(dir, 'voices.json'), `
      // the ones we use
      [
        { "id": "aaa", "name": "Sanne (Dutch)" },
        { "id": "bbb", "name": "  Tom (Dutch, low)  " }
      ]
    `);
    assert.deepStrictEqual(loadVoices(dir), [
      { id: 'aaa', name: 'Sanne (Dutch)' },
      { id: 'bbb', name: 'Tom (Dutch, low)' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a voices.json that cannot be used says which entry is wrong', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutvid-voices-'));
  const write = (text) => fs.writeFileSync(path.join(dir, 'voices.json'), text);
  try {
    write('{ "aaa": "Sanne" }');
    assert.throws(() => loadVoices(dir), /list of/);

    write('[{ "name": "Sanne" }]');
    assert.throws(() => loadVoices(dir), /voices\[0\] needs an ElevenLabs voice "id"/);

    write('[{ "id": "aaa", "name": "One" }, { "id": "aaa", "name": "Again" }]');
    assert.throws(() => loadVoices(dir), /"aaa" is listed twice/);

    // An id with no name is still usable: the id is the label.
    write('[{ "id": "aaa" }]');
    assert.deepStrictEqual(loadVoices(dir), [{ id: 'aaa', name: 'aaa' }]);

    // And an empty list is nothing chosen, not nothing available.
    write('[]');
    assert.strictEqual(loadVoices(dir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- styles are kept apart ----------------------------------------------

// One pile of visual settings, merged over whichever style you picked, meant
// the pile always won. Choosing a style changed almost nothing, which looked
// like the styles not applying at all.
test('each style keeps its own visual settings', () => {
  const file = tmpFile();
  settings.saveSettings(file, { 'theme.highlight.color': '#E6007E' }, { styleFile: 'theme-rebels.json' });
  settings.saveSettings(file, { 'theme.highlight.color': '#00FF00' }, { styleFile: 'theme.json' });

  assert.deepStrictEqual(settings.loadSettings(file, 'theme-rebels.json').theme,
    { highlight: { color: '#E6007E' } });
  assert.deepStrictEqual(settings.loadSettings(file, 'theme.json').theme,
    { highlight: { color: '#00FF00' } });
  assert.deepStrictEqual(settings.loadSettings(file, 'theme-social.json').theme, {},
    'a style nobody has edited is the file as written');
});

test('saving one tab does not wipe what the other holds', () => {
  const file = tmpFile();
  settings.saveSettings(file, { 'theme.highlight.color': '#E6007E' }, { styleFile: 'theme-rebels.json' });
  settings.saveSettings(file, { 'flow.minStepMs': 1800 });
  settings.saveSettings(file, { 'theme.cursor.ripple': false }, { styleFile: 'theme-rebels.json' });

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(written.flow.minStepMs, 1800, 'the pacing survived a style save');
  assert.deepStrictEqual(written.styles['theme-rebels.json'],
    { highlight: { color: '#E6007E' }, cursor: { ripple: false } },
    'and the style kept what it already had');
});

// A settings.json from before the split holds one theme layer that applied to
// everything. It was only ever captured from the default style.
test('a settings file from before the split becomes the default style', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    theme: { highlight: { color: '#123456' } },
    flow: { minStepMs: 1700 },
  }));

  assert.deepStrictEqual(settings.loadSettings(file, 'theme.json').theme,
    { highlight: { color: '#123456' } });
  assert.deepStrictEqual(settings.loadSettings(file, 'theme-rebels.json').theme, {},
    'and stops overriding every other style');
  assert.strictEqual(settings.loadSettings(file).flow.minStepMs, 1700);

  // Writing anything moves it into the new shape rather than leaving both.
  settings.saveSettings(file, { 'flow.stepPaddingMs': 500 });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!('theme' in written), 'the old key is gone');
  assert.strictEqual(written.styles['theme.json'].highlight.color, '#123456');
});

test('the style the storyboard renders in is remembered', () => {
  const file = tmpFile();
  assert.strictEqual(settings.loadSettings(file).style, 'theme.json', 'the default, to begin with');

  settings.saveStyleChoice(file, 'theme-rebels.json');
  assert.strictEqual(settings.loadSettings(file).style, 'theme-rebels.json');
  assert.deepStrictEqual(settings.loadSettings(file).theme, {},
    'and loadSettings reads that style unless told otherwise');

  // A path is reduced to a file name: this names a style, not a place on disk.
  settings.saveStyleChoice(file, '/somewhere/else/theme-social.json');
  assert.strictEqual(settings.loadSettings(file).style, 'theme-social.json');
});

test('every field says which tab it belongs on, from what it changes', () => {
  for (const field of settings.FIELDS) {
    const expected = field.key.startsWith('theme.') ? 'style' : 'settings';
    assert.strictEqual(field.tab, expected, `${field.key} is on the wrong tab`);
  }
  const styleSections = new Set(settings.FIELDS.filter((f) => f.tab === 'style').map((f) => f.section));
  const other = new Set(settings.FIELDS.filter((f) => f.tab === 'settings').map((f) => f.section));
  for (const section of styleSections) {
    assert.ok(!other.has(section), `"${section}" cannot be on both tabs`);
  }
});
