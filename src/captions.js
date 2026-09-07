'use strict';

const fs = require('fs');

/**
 * Captions are a post-process: the recorder never sees them. Restyling means
 * regenerating a subtitle file and re-burning, never re-recording.
 *
 * Two files come out of here:
 *   - captions.srt  a plain sidecar, useful on its own (YouTube, review passes)
 *   - captions.ass  what actually gets burned
 *
 * The .ass exists because an .srt carries no styling, so libass renders it
 * against a fixed 384x288 script canvas and scales up to the frame. Sizes and
 * margins then depend on that internal default rather than on the video, which
 * makes "fontSize: 34" mean different things at different resolutions. Writing
 * the .ass ourselves with PlayRes pinned to the real frame size makes every
 * number in theme.captions a true pixel value. The style mapping is the same
 * force_style mapping either way - see buildForceStyle.
 */

/** Expand #abc, strip the hash. */
function normalizeHex(hex) {
  const raw = String(hex).replace(/^#/, '').trim();
  if (raw.length === 3) return raw.split('').map((c) => c + c).join('').toUpperCase();
  return raw.toUpperCase();
}

/**
 * ASS colours are &HAABBGGRR: alpha first, then blue/green/red - reversed from
 * CSS on both counts. Alpha is inverted too, so 00 is opaque and FF invisible.
 * Easy to get backwards, hence the unit tests.
 *
 * @param {string} hex      "#RRGGBB" or "#RGB"
 * @param {number} opacity  1 = fully opaque, 0 = fully transparent
 */
function hexToAss(hex, opacity = 1) {
  const rgb = normalizeHex(hex);
  if (!/^[0-9A-F]{6}$/.test(rgb)) {
    throw new Error(`hexToAss: "${hex}" is not a hex colour like "#6C5CE7"`);
  }
  const clamped = Math.min(1, Math.max(0, Number(opacity)));
  const alpha = Math.round((1 - clamped) * 255);
  const rr = rgb.slice(0, 2);
  const gg = rgb.slice(2, 4);
  const bb = rgb.slice(4, 6);
  return `&H${byte(alpha)}${bb}${gg}${rr}`;
}

const byte = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// ASS \an-style alignment: 2 = bottom centre, 8 = top centre.
const ALIGNMENT = { bottom: 2, top: 8 };

/**
 * Turn theme.captions into ASS style fields.
 *
 * How the two background modes map:
 *   backgroundOpacity > 0  ->  BorderStyle 3, an opaque box. libass paints that
 *                              box with OutlineColour (not BackColour, despite
 *                              the name), and `Outline` becomes box padding.
 *                              `outline: true` just pads it more generously.
 *   backgroundOpacity == 0 ->  BorderStyle 1, and `outline` draws a contrasting
 *                              stroke around the glyphs in backgroundColor.
 *
 * `video` is needed because libass sizes text so that the font's
 * winAscent+winDescent span equals Fontsize; dividing by that span is what
 * makes fontSize behave like a CSS px size.
 */
function buildForceStyle(captions, font, video) {
  const scale = video && video.height ? video.height / 1080 : 1;
  const lineSpan = font && font.metrics ? font.metrics.lineSpan : 1;

  const px = (v) => v * scale;
  const boxed = captions.backgroundOpacity > 0;

  const style = {
    FontName: font ? font.family : 'Arial',
    // fontSize is authored as a CSS-style px size at 1080p.
    FontSize: round2(px(captions.fontSize) * lineSpan),
    PrimaryColour: hexToAss(captions.color, 1),
    SecondaryColour: hexToAss(captions.color, 1),
    OutlineColour: boxed
      ? hexToAss(captions.backgroundColor, captions.backgroundOpacity)
      : hexToAss(captions.backgroundColor, 1),
    BackColour: hexToAss(captions.backgroundColor, captions.backgroundOpacity),
    Bold: font && font.weight >= 600 ? -1 : 0,
    Italic: font && font.style === 'italic' ? -1 : 0,
    BorderStyle: boxed ? 3 : 1,
    Outline: boxed
      ? round2(px(captions.outline ? 14 : 6))
      : round2(px(captions.outline ? 3 : 0)),
    Shadow: 0,
    Alignment: ALIGNMENT[captions.position] || ALIGNMENT.bottom,
    MarginL: Math.round(px(120)),
    MarginR: Math.round(px(120)),
    MarginV: Math.round(px(captions.marginBottom)),
  };

  return Object.entries(style).map(([k, v]) => `${k}=${v}`).join(',');
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Cues from the recorded timeline. Steps without narration get no caption, and
 * a cue never runs past the end of the video.
 */
function buildCues(steps, timeline, totalSec) {
  const cues = [];
  timeline.forEach((entry, i) => {
    const text = (steps[i] && steps[i].narration || '').trim();
    if (!text) return;
    const start = Math.max(0, entry.startSec);
    // Hold the caption for the narration, then until the step ends.
    const end = Math.min(totalSec, Math.max(start + 0.5, entry.endSec));
    if (end <= start) return;
    cues.push({ index: cues.length + 1, start, end, text });
  });
  return cues;
}

function buildSrt(cues) {
  return cues
    .map((c) => `${c.index}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${wrap(c.text)}\n`)
    .join('\n');
}

function buildAss(cues, styleString, video) {
  const styleOrder = [
    'FontName', 'FontSize', 'PrimaryColour', 'SecondaryColour', 'OutlineColour',
    'BackColour', 'Bold', 'Italic', 'Underline', 'StrikeOut', 'ScaleX', 'ScaleY',
    'Spacing', 'Angle', 'BorderStyle', 'Outline', 'Shadow', 'Alignment',
    'MarginL', 'MarginR', 'MarginV', 'Encoding',
  ];
  const defaults = {
    Underline: 0, StrikeOut: 0, ScaleX: 100, ScaleY: 100,
    Spacing: 0, Angle: 0, Encoding: 1,
  };
  const parsed = Object.fromEntries(
    styleString.split(',').map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    })
  );
  const values = styleOrder.map((key) =>
    parsed[key] !== undefined ? parsed[key] : defaults[key] !== undefined ? defaults[key] : 0
  );

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    // Pinning PlayRes to the frame is what makes theme pixels real pixels.
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    `Format: Name, ${styleOrder.join(', ')}`,
    `Style: Caption,${values.join(',')}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) =>
      `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${assText(c.text)}`
    ),
    '',
  ].join('\n');
}

/** Write both files; returns the paths. */
function writeCaptionFiles(cues, styleString, video, srtPath, assPath) {
  fs.writeFileSync(srtPath, buildSrt(cues), 'utf8');
  fs.writeFileSync(assPath, buildAss(cues, styleString, video), 'utf8');
  return { srtPath, assPath };
}

function srtTime(sec) {
  const { h, m, s, ms } = split(sec);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, '0')}`;
}

function assTime(sec) {
  const { h, m, s, ms } = split(sec);
  // ASS uses one-digit hours and centiseconds.
  return `${h}:${pad(m)}:${pad(s)}.${String(Math.floor(ms / 10)).padStart(2, '0')}`;
}

function split(sec) {
  const total = Math.max(0, sec);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  let whole = Math.floor(total);
  // A 999.6ms rounding can push to 1000; carry it rather than emit ",1000".
  const carried = ms === 1000 ? 1 : 0;
  return {
    h: Math.floor((whole + carried) / 3600),
    m: Math.floor(((whole + carried) % 3600) / 60),
    s: (whole + carried) % 60,
    ms: carried ? 0 : ms,
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** Keep captions to two shortish lines rather than one long one. */
function wrap(text, maxChars = 42) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  // Anything longer than two lines covers too much of the page.
  if (lines.length > 2) {
    const mid = Math.ceil(lines.length / 2);
    return [lines.slice(0, mid).join(' '), lines.slice(mid).join(' ')].join('\n');
  }
  return lines.join('\n');
}

/** ASS treats { } as override blocks and needs \N for a line break. */
function assText(text) {
  return wrap(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

module.exports = {
  hexToAss,
  normalizeHex,
  buildForceStyle,
  buildCues,
  buildSrt,
  buildAss,
  writeCaptionFiles,
  srtTime,
  assTime,
  wrap,
  assText,
};
