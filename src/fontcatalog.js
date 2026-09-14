'use strict';

const fs = require('fs');
const path = require('path');

const { readFontFamilies } = require('./fontname');

/**
 * Every font sitting in a project's `fonts` folder, offered to every style.
 *
 * Without this a style can only use what its own file happens to declare, so
 * adding a face to the project means hand-editing JSON before it turns up in a
 * dropdown. The folder is the catalogue: drop a .ttf in and it is there.
 *
 * Family names are read out of the files rather than guessed from their names.
 * libass matches on the name inside the file, so a guess that is close but
 * wrong is exactly the failure that renders a system font instead.
 */

const FONT_FILE = /\.(ttf|otf|ttc)$/i;

// Reading twenty-odd font files is a few megabytes. The window loads themes
// often, and the folder rarely changes, so remember it until it does.
const cache = new Map();

/** A key a person could plausibly type: "Plus Jakarta Sans Bold" -> plus-jakarta-sans-bold. */
function keyFor(family, weight, style) {
  const parts = [family];
  if (weight >= 600) parts.push('bold');
  if (style === 'italic') parts.push('italic');
  return parts.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Weight and slant from the file name. The name is the only place a static
 * instance says which of its family it is; the OS/2 bits agree, and when they
 * do not it is the file name a person will have gone looking for.
 */
function weightOf(name) {
  const base = name.replace(FONT_FILE, '');
  const style = /italic|oblique/i.test(base) ? 'italic' : 'normal';
  if (/black|heavy/i.test(base)) return { weight: 900, style };
  if (/extrabold|ultrabold/i.test(base)) return { weight: 800, style };
  if (/bold/i.test(base)) return { weight: 700, style };
  if (/semibold|demibold/i.test(base)) return { weight: 600, style };
  if (/medium/i.test(base)) return { weight: 500, style };
  if (/thin|hairline/i.test(base)) return { weight: 100, style };
  if (/extralight|ultralight/i.test(base)) return { weight: 200, style };
  if (/light/i.test(base)) return { weight: 300, style };
  return { weight: 400, style };
}

/**
 * Read a folder of fonts into theme-shaped declarations, keyed by family and
 * weight. `dir` is where the fonts are; `from` is what `file` should be
 * relative to, since a theme resolves its font paths against its own folder.
 */
function scan(dir, from = path.dirname(dir)) {
  const abs = path.resolve(dir);
  let stamp;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) return {};
    stamp = `${stat.mtimeMs}:${path.resolve(from)}`;
  } catch {
    return {};
  }

  const hit = cache.get(abs);
  if (hit && hit.stamp === stamp) return { ...hit.fonts };

  const fonts = {};
  for (const name of fs.readdirSync(abs).filter((f) => FONT_FILE.test(f)).sort()) {
    const file = path.join(abs, name);
    let family;
    try {
      family = readFontFamilies(file).primary;
    } catch {
      // A file that will not parse is not a font worth offering. It is only a
      // problem if a style actually names it, and that fails loudly later.
      continue;
    }
    if (!family) continue;
    const { weight, style } = weightOf(name);
    const key = keyFor(family, weight, style);
    if (fonts[key]) continue;                        // first one wins, sorted by name
    fonts[key] = {
      file: path.relative(path.resolve(from), file).split(path.sep).join('/'),
      family,
      weight,
      style,
    };
  }

  cache.set(abs, { stamp, fonts });
  return { ...fonts };
}

/** A label for a dropdown: "Plus Jakarta Sans Bold". */
function labelFor(font) {
  const bits = [font.family];
  if (font.weight >= 600) bits.push('Bold');
  if (font.style === 'italic') bits.push('Italic');
  return bits.join(' ');
}

module.exports = { scan, keyFor, weightOf, labelFor, FONT_FILE };
