'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The audio a project can use, read from an `audio` folder beside it.
 *
 * A folder rather than a path typed into a form, for the same reason the fonts
 * work that way: the settings screen is a form, and a form has no business
 * pointing the renderer at an arbitrary file on the machine. Drop a clip in and
 * it turns up in the dropdowns.
 */

const SOUND_FILE = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;
const DIR_NAME = 'audio';

const dirFor = (baseDir) => path.join(baseDir, DIR_NAME);

/** A name worth reading: "brand-sting.mp3" -> "Brand sting". */
function labelFor(file) {
  return path.basename(file).replace(SOUND_FILE, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase()) || path.basename(file);
}

/** Every clip in the folder, as `{ file, label }`, sorted by name. */
function scan(baseDir) {
  const dir = dirFor(baseDir);
  let names;
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => SOUND_FILE.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ file: name, label: labelFor(name) }));
}

/**
 * Resolve one clip for playing. Returns null for anything that is not a plain
 * file name in the folder, so a theme cannot be talked into reading elsewhere
 * on the machine.
 */
function fileFor(baseDir, name) {
  if (typeof name !== 'string' || !name || name !== path.basename(name)) return null;
  if (!SOUND_FILE.test(name)) return null;
  const file = path.join(dirFor(baseDir), name);
  return fs.existsSync(file) ? file : null;
}

module.exports = { scan, fileFor, dirFor, labelFor, SOUND_FILE, DIR_NAME };
