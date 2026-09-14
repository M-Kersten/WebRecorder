'use strict';

const fs = require('fs');
const path = require('path');

const { readJson, ConfigError } = require('./config');

/**
 * The voices a project can narrate in, as a list you write yourself.
 *
 * Deliberately a file rather than a live call to ElevenLabs. Their API can list
 * every voice on an account with a preview of each, and that is a better
 * shopping experience, but it needs a working key before the dropdown has
 * anything in it and it puts the network in the way of opening a window. A list
 * of IDs you have already decided on opens instantly and works offline.
 */

const FILE = 'voices.json';

/** The stock voice everything falls back to, so a dropdown is never empty. */
const FALLBACK = [{ id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (English, calm)' }];

const file = (dir) => path.join(dir, FILE);

/**
 * Read the list beside a project. A missing file is not an error: it means
 * nobody has chosen yet, and the stock voice is a fine place to start.
 */
function loadVoices(dir) {
  const abs = file(dir);
  if (!fs.existsSync(abs)) return FALLBACK.slice();

  const raw = readJson(abs, 'voices file');
  if (!Array.isArray(raw)) {
    throw new ConfigError(`${abs}: expected a list of { "id": "...", "name": "..." } entries`);
  }

  const seen = new Set();
  const voices = raw.map((entry, i) => {
    const where = `${abs}: voices[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigError(`${where} must be an object with an "id" and a "name"`);
    }
    const id = String(entry.id == null ? '' : entry.id).trim();
    const name = String(entry.name == null ? '' : entry.name).trim();
    if (!id) throw new ConfigError(`${where} needs an ElevenLabs voice "id"`);
    // A name is what tells two IDs apart in a dropdown. Falling back to the ID
    // beats refusing to open the window over a missing label.
    if (seen.has(id)) throw new ConfigError(`${where}: "${id}" is listed twice`);
    seen.add(id);
    return { id, name: name || id };
  });

  return voices.length ? voices : FALLBACK.slice();
}

module.exports = { loadVoices, FILE, FALLBACK };
