'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, ConfigError } = require('./config');
const { readFontFamilies, readFontMetrics } = require('./fontname');

/**
 * Built-in defaults. A theme.json only has to name what it wants to change;
 * everything below fills in. The whole thing stays one plain object so adding
 * --caption-color style overrides later is a small diff.
 */
const DEFAULTS = {
  fonts: {},
  captions: {
    // Off unless asked for: burned-in captions are a deliberate choice, not
    // something every video should carry.
    enabled: false,
    font: null,
    fontSize: 34,
    color: '#FFFFFF',
    backgroundColor: '#000000',
    backgroundOpacity: 0.55,
    position: 'bottom',
    marginBottom: 60,
    outline: true,
  },
  cursor: {
    enabled: true,
    color: '#FFFFFF',
    strokeColor: '#000000',
    size: 28,
    // Point at a .png/.svg to use your own pointer instead of the drawn arrow.
    image: null,
    // Which point of the pointer sits on the target, as a fraction of its box.
    // The default suits a tip-at-top-left arrow.
    hotspot: [0.18, 0.08],
    // null = duration follows the distance travelled.
    moveMs: null,
    easing: 'easeInOut',
    ripple: true,
    rippleColor: null,
    rippleMs: 620,
  },
  highlight: {
    enabled: true,
    color: '#6C5CE7',
    glow: true,
    borderWidth: 3,
    borderRadius: 10,
  },
  hints: {
    enabled: true,
    font: null,
    fontSize: 28,
    color: '#FFFFFF',
    backgroundColor: '#1A1D29',
    backgroundOpacity: 0.94,
    accentColor: '#6C5CE7',
    borderRadius: 12,
    maxWidth: 520,
    padding: 20,
    // "auto" anchors the hint to the element being acted on; the fixed spots
    // are top/bottom crossed with left/center/right.
    position: 'auto',
    offset: 20,
    fadeMs: 260,
  },
  transitions: {
    enabled: true,
    // Fade to and from black at the start and end of every segment.
    fadeSec: 0.4,
  },
  intro: {
    enabled: false,
    durationSec: 3,
    backgroundColor: '#0F1115',
    backgroundGradient: null,
    logo: null,
    title: '',
    titleFont: null,
    subtitle: '',
    subtitleFont: null,
    titleColor: '#FFFFFF',
    subtitleColor: '#A0A6B8',
  },
  outro: {
    enabled: false,
    durationSec: 3,
    backgroundColor: '#0F1115',
    backgroundGradient: null,
    logo: null,
    title: '',
    titleFont: null,
    subtitle: '',
    subtitleFont: null,
    titleColor: '#FFFFFF',
    subtitleColor: '#A0A6B8',
  },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    // Painted behind the page before the first navigation, and used to letterbox
    // a recording that does not fill the frame. Without it the video opens on a
    // flash of blank white while the browser is still on about:blank.
    backgroundColor: '#0F1115',
  },
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

class ThemeError extends ConfigError {}

/** Recursive merge of plain objects; arrays and scalars replace wholesale. */
function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(base[key]) && isPlainObject(value)
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Load and validate a theme file. Fails fast, the way config.js does for
 * flow.json: a missing theme is an error, not a silent fall-back to defaults,
 * so a mistyped --theme path never quietly produces an unbranded video.
 */
function loadTheme(themePath) {
  const abs = path.resolve(themePath);
  if (!fs.existsSync(abs)) {
    throw new ThemeError(
      `No theme file at ${abs}\n` +
      'Copy theme.example.json to theme.json, or pass --theme <path>.'
    );
  }
  const raw = readJson(abs, 'theme file');
  if (!isPlainObject(raw)) {
    throw new ThemeError(`${abs}: expected a JSON object at the top level`);
  }

  const theme = deepMerge(DEFAULTS, raw);
  const baseDir = path.dirname(abs);
  theme.path = abs;
  theme.baseDir = baseDir;

  validateVideo(theme, abs);
  theme.fonts = resolveFonts(theme.fonts, baseDir, abs);
  validateFontRefs(theme, abs);
  validateColors(theme, abs);
  validateCursor(theme, baseDir, abs);
  validateHints(theme, abs);
  validateTransitions(theme, abs);
  validateCards(theme, baseDir, abs);

  // libass takes a single fontsdir, and captions are the only thing it renders,
  // so the caption font's own directory is the one that matters.
  const captionFont = theme.captions.font ? theme.fonts[theme.captions.font] : null;
  theme.fontsDir = captionFont ? path.dirname(captionFont.path) : null;

  return theme;
}

/**
 * Resolve each declared font to an absolute path and reconcile the declared
 * `family` against the name baked into the file. A mismatch here is the exact
 * failure that makes libass silently render a system font instead.
 */
function resolveFonts(fonts, baseDir, abs) {
  if (!isPlainObject(fonts)) {
    throw new ThemeError(`${abs}: "fonts" must be an object keyed by font name`);
  }
  const resolved = {};
  for (const [key, decl] of Object.entries(fonts)) {
    if (!isPlainObject(decl) || typeof decl.file !== 'string' || !decl.file) {
      throw new ThemeError(`${abs}: fonts.${key} needs a "file" path (e.g. "fonts/Inter-Regular.ttf")`);
    }
    const file = path.resolve(baseDir, decl.file);
    if (!fs.existsSync(file)) {
      throw new ThemeError(
        `${abs}: fonts.${key} points at "${decl.file}", which does not exist.\n` +
        `Looked for: ${file}`
      );
    }

    let names;
    try {
      names = readFontFamilies(file);
    } catch (err) {
      throw new ThemeError(`${abs}: fonts.${key} - ${err.message}`);
    }

    const declared = typeof decl.family === 'string' && decl.family.trim()
      ? decl.family.trim()
      : null;

    if (declared && !names.families.includes(declared)) {
      throw new ThemeError(
        `${abs}: fonts.${key} declares family "${declared}", but ${path.basename(file)} ` +
        `calls itself ${names.families.map((f) => `"${f}"`).join(' / ') || '(nothing readable)'}.\n` +
        'libass matches on the name inside the file, so it would silently fall back to a ' +
        `system font. Set "family" to ${names.primary ? `"${names.primary}"` : 'the name above'} ` +
        'or drop the field and let it be read from the file.'
      );
    }

    const family = declared || names.primary;
    if (!family) {
      throw new ThemeError(`${abs}: fonts.${key} - could not determine a family name for ${file}`);
    }

    resolved[key] = {
      key,
      family,
      file: decl.file,
      path: file,
      weight: Number.isFinite(decl.weight) ? decl.weight : 400,
      style: typeof decl.style === 'string' ? decl.style : 'normal',
      internalFamilies: names.families,
      metrics: readFontMetrics(file),
    };
  }
  return resolved;
}

/** Every `font`/`titleFont`/`subtitleFont` must name a key that actually exists. */
function validateFontRefs(theme, abs) {
  const refs = [
    ['captions.font', theme.captions.font],
    ['hints.font', theme.hints.font],
    ['intro.titleFont', theme.intro.titleFont],
    ['intro.subtitleFont', theme.intro.subtitleFont],
    ['outro.titleFont', theme.outro.titleFont],
    ['outro.subtitleFont', theme.outro.subtitleFont],
  ];
  const known = Object.keys(theme.fonts);
  for (const [where, key] of refs) {
    // An unset font reference is allowed: libass and the browser each pick a
    // sensible default. Only a reference to a key that does not exist is wrong.
    if (key === null || key === undefined || key === '') continue;
    if (typeof key !== 'string') {
      throw new ThemeError(`${abs}: ${where} must be a font key from "fonts", or null`);
    }
    if (!theme.fonts[key]) {
      throw new ThemeError(
        `${abs}: ${where} refers to font "${key}", which is not declared in "fonts".\n` +
        `Declared fonts: ${known.length ? known.join(', ') : '(none)'}`
      );
    }
  }
}

function validateColors(theme, abs) {
  const fields = [
    ['captions.color', theme.captions.color],
    ['captions.backgroundColor', theme.captions.backgroundColor],
    ['cursor.color', theme.cursor.color],
    ['cursor.strokeColor', theme.cursor.strokeColor],
    ['highlight.color', theme.highlight.color],
    ['video.backgroundColor', theme.video.backgroundColor],
    ['hints.color', theme.hints.color],
    ['hints.backgroundColor', theme.hints.backgroundColor],
    ['hints.accentColor', theme.hints.accentColor],
  ];
  if (theme.cursor.rippleColor !== null && theme.cursor.rippleColor !== undefined) {
    fields.push(['cursor.rippleColor', theme.cursor.rippleColor]);
  }
  for (const card of ['intro', 'outro']) {
    fields.push(
      [`${card}.backgroundColor`, theme[card].backgroundColor],
      [`${card}.titleColor`, theme[card].titleColor],
      [`${card}.subtitleColor`, theme[card].subtitleColor],
    );
    const grad = theme[card].backgroundGradient;
    if (grad !== null && grad !== undefined) {
      if (!Array.isArray(grad) || grad.length < 2) {
        throw new ThemeError(`${abs}: ${card}.backgroundGradient must be an array of at least two hex colors`);
      }
      grad.forEach((c, i) => fields.push([`${card}.backgroundGradient[${i}]`, c]));
    }
  }
  for (const [where, value] of fields) {
    if (typeof value !== 'string' || !HEX.test(value)) {
      throw new ThemeError(`${abs}: ${where} must be a hex color like "#6C5CE7" (got ${JSON.stringify(value)})`);
    }
  }

  const op = theme.captions.backgroundOpacity;
  if (!(Number.isFinite(op) && op >= 0 && op <= 1)) {
    throw new ThemeError(`${abs}: captions.backgroundOpacity must be between 0 and 1 (got ${JSON.stringify(op)})`);
  }
  if (!['bottom', 'top'].includes(theme.captions.position)) {
    throw new ThemeError(`${abs}: captions.position must be "bottom" or "top" (got ${JSON.stringify(theme.captions.position)})`);
  }
  if (!(Number.isFinite(theme.captions.fontSize) && theme.captions.fontSize > 0)) {
    throw new ThemeError(`${abs}: captions.fontSize must be a positive number`);
  }
}

const EASINGS = ['linear', 'easeOut', 'easeInOut'];

function validateCursor(theme, baseDir, abs) {
  const c = theme.cursor;
  if (c.image) {
    if (typeof c.image !== 'string') {
      throw new ThemeError(`${abs}: cursor.image must be a path to a .png/.svg, or null`);
    }
    const imagePath = path.resolve(baseDir, c.image);
    if (!fs.existsSync(imagePath)) {
      throw new ThemeError(
        `${abs}: cursor.image points at "${c.image}", which does not exist.\nLooked for: ${imagePath}`
      );
    }
    const ext = path.extname(imagePath).toLowerCase();
    if (!['.png', '.svg', '.gif', '.webp', '.jpg', '.jpeg'].includes(ext)) {
      throw new ThemeError(
        `${abs}: cursor.image is "${ext}", which the browser cannot draw. Use .png (with ` +
        'transparency) or .svg.'
      );
    }
    c.imagePath = imagePath;
  }

  if (!Array.isArray(c.hotspot) || c.hotspot.length !== 2 ||
      !c.hotspot.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new ThemeError(
      `${abs}: cursor.hotspot must be two numbers between 0 and 1, as a fraction of the ` +
      'pointer image - [0, 0] is its top-left corner. A plain arrow is about [0.18, 0.08].'
    );
  }
  if (c.moveMs !== null && !(Number.isFinite(c.moveMs) && c.moveMs >= 0)) {
    throw new ThemeError(`${abs}: cursor.moveMs must be a non-negative number, or null to follow the distance`);
  }
  if (!EASINGS.includes(c.easing)) {
    throw new ThemeError(`${abs}: cursor.easing must be one of ${EASINGS.join(', ')} (got ${JSON.stringify(c.easing)})`);
  }
  if (!(Number.isFinite(c.rippleMs) && c.rippleMs > 0)) {
    throw new ThemeError(`${abs}: cursor.rippleMs must be a positive number`);
  }
  if (!(Number.isFinite(c.size) && c.size > 0)) {
    throw new ThemeError(`${abs}: cursor.size must be a positive number`);
  }
}

const HINT_POSITIONS = [
  'auto',
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

function validateHints(theme, abs) {
  const h = theme.hints;
  if (!HINT_POSITIONS.includes(h.position)) {
    throw new ThemeError(
      `${abs}: hints.position must be one of ${HINT_POSITIONS.join(', ')} ` +
      `(got ${JSON.stringify(h.position)})`
    );
  }
  if (!(Number.isFinite(h.backgroundOpacity) && h.backgroundOpacity >= 0 && h.backgroundOpacity <= 1)) {
    throw new ThemeError(`${abs}: hints.backgroundOpacity must be between 0 and 1`);
  }
  for (const [name, value] of [['fontSize', h.fontSize], ['maxWidth', h.maxWidth],
    ['padding', h.padding], ['borderRadius', h.borderRadius], ['offset', h.offset],
    ['fadeMs', h.fadeMs]]) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new ThemeError(`${abs}: hints.${name} must be a non-negative number (got ${JSON.stringify(value)})`);
    }
  }
}

function validateTransitions(theme, abs) {
  const t = theme.transitions;
  if (!(Number.isFinite(t.fadeSec) && t.fadeSec >= 0)) {
    throw new ThemeError(`${abs}: transitions.fadeSec must be a non-negative number of seconds`);
  }
  if (t.fadeSec > 3) {
    throw new ThemeError(`${abs}: transitions.fadeSec of ${t.fadeSec}s is longer than any segment wants; keep it under 3`);
  }
}

function validateCards(theme, baseDir, abs) {
  for (const card of ['intro', 'outro']) {
    const c = theme[card];
    if (!c.enabled) continue;
    if (!(Number.isFinite(c.durationSec) && c.durationSec > 0)) {
      throw new ThemeError(`${abs}: ${card}.durationSec must be a positive number`);
    }
    if (c.logo) {
      const logoPath = path.resolve(baseDir, c.logo);
      if (!fs.existsSync(logoPath)) {
        throw new ThemeError(
          `${abs}: ${card}.logo points at "${c.logo}", which does not exist.\nLooked for: ${logoPath}`
        );
      }
      c.logoPath = logoPath;
    }
    if (!c.title && !c.subtitle && !c.logo) {
      throw new ThemeError(`${abs}: ${card} is enabled but has no title, subtitle or logo to show`);
    }
  }
}

function validateVideo(theme, abs) {
  const { width, height, fps } = theme.video;
  for (const [name, value] of [['width', width], ['height', height], ['fps', fps]]) {
    if (!(Number.isInteger(value) && value > 0)) {
      throw new ThemeError(`${abs}: video.${name} must be a positive integer (got ${JSON.stringify(value)})`);
    }
  }
  // libx264 with yuv420p needs even dimensions; catch it here rather than in a
  // wall of ffmpeg output halfway through the run.
  if (width % 2 || height % 2) {
    throw new ThemeError(`${abs}: video.width and video.height must both be even (H.264 requirement)`);
  }
}

/** Human-readable dump for --print-theme. */
function describeTheme(theme) {
  const lines = [`theme: ${theme.path}`];
  lines.push(`  video: ${theme.video.width}x${theme.video.height} @ ${theme.video.fps}fps ` +
    `on ${theme.video.backgroundColor}`);
  const fontKeys = Object.keys(theme.fonts);
  lines.push(`  fonts: ${fontKeys.length ? '' : '(none declared)'}`);
  for (const key of fontKeys) {
    const f = theme.fonts[key];
    lines.push(`    ${key}: "${f.family}" <- ${f.path}`);
  }
  const capFont = theme.captions.font ? `"${theme.fonts[theme.captions.font].family}"` : '(libass default)';
  lines.push(`  captions: ${theme.captions.enabled ? 'on' : 'off'}, ${capFont} ` +
    `${theme.captions.fontSize}px ${theme.captions.color} at ${theme.captions.position}`);
  const cur = theme.cursor;
  lines.push(`  cursor: ${cur.enabled
    ? `on, ${cur.imagePath ? path.basename(cur.imagePath) : cur.color} ${cur.size}px, ` +
      `${cur.easing}${cur.ripple ? ', ripple' : ''}`
    : 'off'}`);
  lines.push(`  highlight: ${theme.highlight.enabled ? `on, ${theme.highlight.color}` : 'off'}`);
  const hintFont = theme.hints.font ? `"${theme.fonts[theme.hints.font].family}"` : '(system)';
  lines.push(`  hints: ${theme.hints.enabled
    ? `on, ${hintFont} ${theme.hints.fontSize}px at ${theme.hints.position}`
    : 'off'}`);
  lines.push(`  transitions: ${theme.transitions.enabled ? `fade ${theme.transitions.fadeSec}s` : 'off'}`);
  for (const card of ['intro', 'outro']) {
    const c = theme[card];
    lines.push(`  ${card}: ${c.enabled ? `on, ${c.durationSec}s, "${c.title}" / "${c.subtitle}"` : 'off'}`);
  }
  if (theme.fontsDir) lines.push(`  fontsdir (libass): ${theme.fontsDir}`);
  return lines.join('\n');
}

module.exports = { loadTheme, describeTheme, deepMerge, DEFAULTS, ThemeError };
