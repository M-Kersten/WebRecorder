'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  hexToAss, buildForceStyle, buildCues, buildSrt, buildAss, srtTime, assTime, wrap, assText,
} = require('../src/captions');

// ASS colours are &HAABBGGRR: alpha first, then blue/green/red, and the alpha
// runs backwards (00 opaque, FF transparent). Both reversals are easy to get
// wrong in a way no error message would ever catch, so pin them down here.
test('hexToAss reverses RGB into BGR', () => {
  assert.strictEqual(hexToAss('#FF0000', 1), '&H000000FF', 'pure red lands in the low byte');
  assert.strictEqual(hexToAss('#00FF00', 1), '&H0000FF00', 'green stays in the middle');
  assert.strictEqual(hexToAss('#0000FF', 1), '&H00FF0000', 'pure blue lands in the high colour byte');
  assert.strictEqual(hexToAss('#6C5CE7', 1), '&H00E75C6C');
});

test('hexToAss inverts alpha', () => {
  assert.strictEqual(hexToAss('#000000', 1), '&H00000000', 'opacity 1 -> alpha 00');
  assert.strictEqual(hexToAss('#000000', 0), '&HFF000000', 'opacity 0 -> alpha FF');
  assert.strictEqual(hexToAss('#000000', 0.55), '&H73000000', '0.55 -> round(0.45*255) = 115 = 0x73');
  assert.strictEqual(hexToAss('#000000', 0.5), '&H80000000');
});

test('hexToAss accepts shorthand and a missing hash, and clamps opacity', () => {
  assert.strictEqual(hexToAss('#F0A', 1), '&H00AA00FF');
  assert.strictEqual(hexToAss('FFFFFF', 1), '&H00FFFFFF');
  assert.strictEqual(hexToAss('#FFFFFF', 5), '&H00FFFFFF');
  assert.strictEqual(hexToAss('#FFFFFF', -2), '&HFFFFFFFF');
});

test('hexToAss rejects nonsense rather than rendering something wrong', () => {
  assert.throws(() => hexToAss('rebeccapurple', 1), /not a hex colour/);
  assert.throws(() => hexToAss('#12345', 1), /not a hex colour/);
});

const FONT = {
  family: 'Inter',
  weight: 400,
  style: 'normal',
  metrics: { lineSpan: 1.4302 },
};
const VIDEO = { width: 1920, height: 1080, fps: 30 };

function parseStyle(s) {
  return Object.fromEntries(s.split(',').map((p) => {
    const at = p.indexOf('=');
    return [p.slice(0, at), p.slice(at + 1)];
  }));
}

test('buildForceStyle names the resolved font, not the theme key', () => {
  const style = parseStyle(buildForceStyle(
    { ...base(), font: 'body' }, FONT, VIDEO
  ));
  assert.strictEqual(style.FontName, 'Inter');
});

test('buildForceStyle converts fontSize through the font line span', () => {
  const style = parseStyle(buildForceStyle({ ...base(), fontSize: 34 }, FONT, VIDEO));
  // 34 CSS px * 1.4302 span = 48.63 ASS units at 1080p.
  assert.strictEqual(style.FontSize, '48.63');
});

test('buildForceStyle scales with video height so a theme is resolution-independent', () => {
  const at1080 = parseStyle(buildForceStyle(base(), FONT, VIDEO));
  const at720 = parseStyle(buildForceStyle(base(), FONT, { width: 1280, height: 720, fps: 30 }));
  assert.ok(Math.abs(Number(at1080.FontSize) / Number(at720.FontSize) - 1.5) < 0.01);
  assert.strictEqual(Number(at1080.MarginV) / Number(at720.MarginV), 1.5);
});

test('a caption background becomes an opaque box painted with OutlineColour', () => {
  // libass BorderStyle 3 paints the box from OutlineColour despite the name;
  // verified against a real render.
  const style = parseStyle(buildForceStyle(
    { ...base(), backgroundColor: '#000000', backgroundOpacity: 0.55 }, FONT, VIDEO
  ));
  assert.strictEqual(style.BorderStyle, '3');
  assert.strictEqual(style.OutlineColour, '&H73000000');
  assert.ok(Number(style.Outline) > 0, 'box needs padding');
});

test('no background falls back to a glyph stroke', () => {
  const on = parseStyle(buildForceStyle(
    { ...base(), backgroundOpacity: 0, outline: true }, FONT, VIDEO
  ));
  assert.strictEqual(on.BorderStyle, '1');
  assert.ok(Number(on.Outline) > 0);

  const off = parseStyle(buildForceStyle(
    { ...base(), backgroundOpacity: 0, outline: false }, FONT, VIDEO
  ));
  assert.strictEqual(off.Outline, '0');
});

test('position picks the ASS alignment', () => {
  assert.strictEqual(parseStyle(buildForceStyle({ ...base(), position: 'bottom' }, FONT, VIDEO)).Alignment, '2');
  assert.strictEqual(parseStyle(buildForceStyle({ ...base(), position: 'top' }, FONT, VIDEO)).Alignment, '8');
});

test('a bold font sets the ASS bold flag', () => {
  const bold = { ...FONT, weight: 700 };
  assert.strictEqual(parseStyle(buildForceStyle(base(), bold, VIDEO)).Bold, '-1');
  assert.strictEqual(parseStyle(buildForceStyle(base(), FONT, VIDEO)).Bold, '0');
});

test('timecodes format for both subtitle flavours', () => {
  assert.strictEqual(srtTime(0), '00:00:00,000');
  assert.strictEqual(srtTime(3661.5), '01:01:01,500');
  assert.strictEqual(assTime(3661.5), '1:01:01.50');
  // A value that rounds to a full second must carry, not emit ",1000".
  assert.strictEqual(srtTime(1.9997), '00:00:02,000');
});

test('cues skip steps with no narration and stay inside the video', () => {
  const steps = [{ narration: 'One' }, {}, { narration: 'Three' }];
  const timeline = [
    { startSec: 0, endSec: 2 },
    { startSec: 2, endSec: 3 },
    { startSec: 3, endSec: 99 },
  ];
  const cues = buildCues(steps, timeline, 6);
  assert.strictEqual(cues.length, 2);
  assert.deepStrictEqual(cues.map((c) => c.text), ['One', 'Three']);
  assert.strictEqual(cues[1].end, 6, 'clamped to the video length');
  assert.deepStrictEqual(cues.map((c) => c.index), [1, 2], 'renumbered after the skip');
});

test('long narration wraps to two lines', () => {
  const text = 'This is a fairly long line of narration that would otherwise run right across the frame';
  assert.strictEqual(wrap(text).split('\n').length, 2);
});

test('ASS override characters in narration are escaped', () => {
  assert.strictEqual(assText('use {braces} here'), 'use \\{braces\\} here');
  assert.ok(assText('one two').indexOf('\\N') === -1);
  assert.ok(assText('a'.repeat(40) + ' ' + 'b'.repeat(40)).includes('\\N'));
});

test('the generated .ass pins PlayRes to the real frame size', () => {
  const cues = buildCues([{ narration: 'Hi' }], [{ startSec: 0, endSec: 2 }], 5);
  const ass = buildAss(cues, buildForceStyle(base(), FONT, VIDEO), VIDEO);
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /PlayResY: 1080/);
  assert.match(ass, /^Style: Caption,Inter,/m);
  assert.match(ass, /^Dialogue: 0,0:00:00\.00,0:00:02\.00,Caption,,0,0,0,,Hi$/m);
});

test('the .srt sidecar is well formed', () => {
  const cues = buildCues([{ narration: 'Hello' }], [{ startSec: 1, endSec: 3 }], 5);
  assert.strictEqual(buildSrt(cues), '1\n00:00:01,000 --> 00:00:03,000\nHello\n');
});

function base() {
  return {
    enabled: true,
    font: 'body',
    fontSize: 34,
    color: '#FFFFFF',
    backgroundColor: '#000000',
    backgroundOpacity: 0.55,
    position: 'bottom',
    marginBottom: 60,
    outline: true,
  };
}
