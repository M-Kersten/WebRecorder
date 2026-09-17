'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The pictures a project can use, read from an `assets` folder beside it.
 *
 * A folder rather than a path typed into a form, for the same reason the fonts
 * and the audio work that way: the settings screen is a form, and a form has no
 * business pointing the renderer at an arbitrary file on the machine. Drop a
 * logo in and it turns up in the dropdown.
 */

const IMAGE_FILE = /\.(png|jpe?g|svg|webp|gif)$/i;
const DIR_NAME = 'assets';

const dirFor = (baseDir) => path.join(baseDir, DIR_NAME);

/** A name worth reading: "rebels-logo.png" -> "Rebels logo". */
function labelFor(file) {
  return path.basename(file).replace(IMAGE_FILE, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase()) || path.basename(file);
}

/**
 * Every picture in the folder, as `{ file, label }`, sorted by name.
 *
 * Nested one level deep as well, because a project that has a brand folder
 * keeps its logos in it, and `assets/brand/logo.svg` should be as reachable as
 * `assets/logo.svg`. Deeper than that is somebody's build output.
 */
function scan(baseDir) {
  const dir = dirFor(baseDir);
  const out = [];
  const read = (at, prefix) => {
    let names;
    try {
      if (!fs.statSync(at).isDirectory()) return;
      names = fs.readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(at, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        if (!prefix) read(full, name);
      } else if (IMAGE_FILE.test(name)) {
        out.push({ file: rel, label: labelFor(name) });
      }
    }
  };
  read(dir, '');
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The name inside the folder, whichever way it was written.
 *
 * A theme stores a logo as the path it reads, "assets/logo.png"; the pickers
 * and everything downstream of them deal in names inside that folder. One
 * function, so the two spellings cannot drift apart.
 */
const bare = (name) => String(name == null ? '' : name).replace(new RegExp(`^${DIR_NAME}/`), '');

/**
 * Resolve one picture. Returns null for anything that climbs out of the folder,
 * so a theme cannot be talked into reading elsewhere on the machine.
 */
function fileFor(baseDir, name) {
  if (typeof name !== 'string' || !name) return null;
  if (!IMAGE_FILE.test(name)) return null;
  if (name.includes('\\') || path.isAbsolute(name)) return null;
  const dir = dirFor(baseDir);
  const file = path.resolve(dir, name);
  // resolve() collapses any .. before this check, so the check is the real one.
  if (file !== dir && !file.startsWith(dir + path.sep)) return null;
  return fs.existsSync(file) ? file : null;
}

module.exports = { scan, fileFor, dirFor, labelFor, bare, IMAGE_FILE, DIR_NAME };
