'use strict';

const fs = require('fs');
const path = require('path');

const images = require('./images');
const sounds = require('./sounds');

/**
 * Putting a file into the project from the window.
 *
 * The pickers read a folder, which is the right shape - a form has no business
 * naming a path on the machine - but it left everybody a step outside the app:
 * open a file manager, find the folder, drop the file in, come back. So the
 * window writes into those same folders itself, and the folders stay the only
 * thing anything reads from.
 *
 * Everything below is about the name. The bytes are whatever was sent; the
 * name decides where they land, so it is rebuilt rather than trusted: basename
 * only, a known extension for the kind, and anything left over replaced.
 */

const KINDS = {
  image: { dirFor: images.dirFor, match: images.IMAGE_FILE, label: 'picture', maxBytes: 8 * 1024 * 1024 },
  sound: { dirFor: sounds.dirFor, match: sounds.SOUND_FILE, label: 'clip', maxBytes: 48 * 1024 * 1024 },
};

class UploadError extends Error {}

/**
 * A name safe to write, built from the one that was sent.
 *
 * Not a check that passes or fails: a rebuild. Directory separators, `..`,
 * drive letters, control characters and leading dots cannot survive it, because
 * only the characters named here are copied across.
 */
function safeName(raw, kind) {
  const spec = KINDS[kind];
  const sent = String(raw || '');
  const base = path.basename(sent.replace(/\\/g, '/'));
  const ext = path.extname(base).toLowerCase();
  if (!spec.match.test(base)) {
    throw new UploadError(
      `"${base || sent}" is not a ${spec.label} this can use. ` +
      `Try one of: ${String(spec.match).replace(/[/^$i\\]|\.\(|\)\$/g, '').replace(/\|/g, ', ')}.`
    );
  }
  const stem = base.slice(0, base.length - ext.length)
    .replace(/[^A-Za-z0-9 _-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 60);
  return `${stem || 'upload'}${ext}`;
}

/** The name it will actually get, stepping aside rather than overwriting. */
function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)) && n < 999; n++) {
    candidate = `${stem}-${n}${ext}`;
  }
  return candidate;
}

/**
 * Write one file into the folder its kind belongs to.
 *
 * Returns the name it landed under, which is not always the name that was sent:
 * an upload never replaces something already there, because a picker pointing
 * at a file whose contents changed under it is a confusing way to lose work.
 */
function save(projectDir, kind, rawName, bytes) {
  const spec = KINDS[kind];
  if (!spec) throw new UploadError(`There is nowhere to put a "${kind}".`);
  if (!bytes || !bytes.length) throw new UploadError('That file was empty.');
  if (bytes.length > spec.maxBytes) {
    throw new UploadError(
      `That ${spec.label} is ${(bytes.length / 1048576).toFixed(1)} MB, and the limit is ` +
      `${Math.round(spec.maxBytes / 1048576)} MB.`
    );
  }
  const dir = spec.dirFor(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = freeName(dir, safeName(rawName, kind));
  fs.writeFileSync(path.join(dir, name), bytes);
  return name;
}

module.exports = { save, safeName, freeName, KINDS, UploadError };
