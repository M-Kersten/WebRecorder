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

/** Side margins, as a fraction of frame width. */
const SIDE_MARGIN_RATIO = 0.0625;

/** Horizontal room a caption line has to work with, in pixels. */
function usableWidth(video) {
  return video.width - 2 * sideMargin(video);
}

const sideMargin = (video) => Math.round(video.width * SIDE_MARGIN_RATIO);

/**
 * Turn theme.captions into ASS style fields.
 *
 * Sizes are literal pixels in the output frame: fontSize 34 is 34px whatever
 * the resolution. Scaling them off the frame height instead would seem tidier,
 * but it breaks the moment the video is portrait - a 1080x1920 frame would take
 * its type size from the 1920 side and render captions that swallow the page.
 *
 * How the two background modes map:
 *   backgroundOpacity > 0  ->  BorderStyle 3, an opaque box. libass paints that
 *                              box with OutlineColour (not BackColour, despite
 *                              the name), and `Outline` becomes box padding.
 *                              `outline: true` just pads it more generously.
 *   backgroundOpacity == 0 ->  BorderStyle 1, and `outline` draws a contrasting
 *                              stroke around the glyphs in backgroundColor.
 *
 * The font is needed because libass sizes text so that the font's
 * winAscent+winDescent span equals Fontsize, rather than the em square.
 * Multiplying by that span is what makes fontSize behave like a CSS px size.
 */
function buildForceStyle(captions, font, video) {
  const lineSpan = font && font.metrics ? font.metrics.lineSpan : 1;
  const size = captions.fontSize;
  const boxed = captions.backgroundOpacity > 0;
  const margin = sideMargin(video);

  const style = {
    FontName: font ? font.family : 'Arial',
    FontSize: round2(size * lineSpan),
    PrimaryColour: hexToAss(captions.color, 1),
    SecondaryColour: hexToAss(captions.color, 1),
    OutlineColour: boxed
      ? hexToAss(captions.backgroundColor, captions.backgroundOpacity)
      : hexToAss(captions.backgroundColor, 1),
    BackColour: hexToAss(captions.backgroundColor, captions.backgroundOpacity),
    Bold: font && font.weight >= 600 ? -1 : 0,
    Italic: font && font.style === 'italic' ? -1 : 0,
    BorderStyle: boxed ? 3 : 1,
    // Padding and stroke both scale with the type, not with the frame.
    Outline: boxed
      ? round2(size * (captions.outline ? 0.4 : 0.18))
      : round2(size * (captions.outline ? 0.09 : 0)),
    Shadow: 0,
    Alignment: ALIGNMENT[captions.position] || ALIGNMENT.bottom,
    MarginL: margin,
    MarginR: margin,
    MarginV: Math.round(captions.marginBottom),
  };

  return Object.entries(style).map(([k, v]) => `${k}=${v}`).join(',');
}

/**
 * How many characters fit on one caption line.
 *
 * Two limits, whichever is tighter: what actually fits across the frame at this
 * type size, and the ~42 characters subtitling convention allows regardless of
 * room. Without the first, a narrow portrait frame re-wraps every line inside
 * libass and the caption grows to four lines.
 */
function lineBudget(captions, video) {
  // 0.52em is a fair average advance width for mixed-case text in a sans face.
  const byWidth = Math.floor(usableWidth(video) / (captions.fontSize * 0.52));
  return Math.max(16, Math.min(42, byWidth));
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

function buildSrt(cues, maxChars) {
  return cues
    .map((c) => `${c.index}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${wrap(c.text, maxChars)}\n`)
    .join('\n');
}

function buildAss(cues, styleString, video, maxChars) {
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
      `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${assText(c.text, maxChars)}`
    ),
    '',
  ].join('\n');
}

/** Write both files; returns the paths. */
function writeCaptionFiles(cues, styleString, video, srtPath, assPath, maxChars) {
  fs.writeFileSync(srtPath, buildSrt(cues, maxChars), 'utf8');
  fs.writeFileSync(assPath, buildAss(cues, styleString, video, maxChars), 'utf8');
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

/**
 * Wrap a caption to lines of at most `maxChars`, balanced so they come out
 * roughly even rather than one full line and one short one.
 *
 * The budget is a hard limit. Squeezing text onto fewer lines than it fits on
 * just moves the problem: libass re-wraps anything too wide for the frame, and
 * a caption that was meant to be two lines becomes four.
 */
function wrap(text, maxChars = 42) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';

  const lines = greedyWrap(words, maxChars);
  // Re-wrap at the narrowest width that still needs the same number of lines;
  // that is the most even split available.
  const longest = Math.max(...words.map((w) => w.length));
  for (let target = Math.max(longest, Math.ceil(text.length / lines.length)); target < maxChars; target++) {
    const candidate = greedyWrap(words, target);
    if (candidate.length === lines.length) return candidate.join('\n');
  }
  return lines.join('\n');
}

function greedyWrap(words, maxChars) {
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
  return lines;
}

/** ASS treats { } as override blocks and needs \N for a line break. */
function assText(text, maxChars) {
  return wrap(text, maxChars)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

module.exports = {
  hexToAss,
  lineBudget,
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
