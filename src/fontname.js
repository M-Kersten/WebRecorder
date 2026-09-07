'use strict';

const fs = require('fs');

// Name IDs that carry a family name, in the order libass/fontconfig prefer.
const NAME_ID_FAMILY = 1;          // "Poppins SemiBold"
const NAME_ID_TYPOGRAPHIC = 16;    // "Poppins"

/**
 * Parse the sfnt table directory once: { tag: {offset, length} }.
 */
function readTableDirectory(buf, file) {
  if (buf.length < 12) throw new Error(`${file} is too small to be a font file`);
  const tag = buf.readUInt32BE(0);
  const isTtc = buf.toString('latin1', 0, 4) === 'ttcf';
  // 0x00010000 = TrueType outlines, 'OTTO' = CFF outlines, 'true' = older Mac TT.
  const known = tag === 0x00010000 || tag === 0x4f54544f || tag === 0x74727565;
  if (!known && !isTtc) {
    throw new Error(
      `${file} is not a TrueType/OpenType font (unexpected header). ` +
      'Bundle a .ttf or .otf; .woff/.woff2 are not readable by libass.'
    );
  }
  // For a collection, just read the first face - good enough to name the family.
  const sfntStart = isTtc ? buf.readUInt32BE(12) : 0;
  const numTables = buf.readUInt16BE(sfntStart + 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = sfntStart + 12 + i * 16;
    if (rec + 16 > buf.length) break;
    tables[buf.toString('latin1', rec, rec + 4)] = {
      offset: buf.readUInt32BE(rec + 8),
      length: buf.readUInt32BE(rec + 12),
    };
  }
  return tables;
}

/**
 * Vertical metrics, in em-relative units.
 *
 * `lineSpan` is what libass means by Fontsize: it sizes text so that
 * winAscent+winDescent lands on that many pixels, NOT so that the em square
 * does. Measured against a real render it holds to within a third of a pixel.
 * Dividing a CSS-style px size by it is what makes captions.fontSize mean the
 * same thing as font-size in the browser-rendered title cards.
 */
function readFontMetrics(file) {
  const buf = fs.readFileSync(file);
  const tables = readTableDirectory(buf, file);
  const head = tables.head;
  const os2 = tables['OS/2'];
  if (!head || !os2) {
    // No usable metrics: fall back to treating Fontsize as the em size.
    return { unitsPerEm: 1000, winAscent: 1000, winDescent: 0, lineSpan: 1, capHeight: null };
  }
  const unitsPerEm = buf.readUInt16BE(head.offset + 18) || 1000;
  const winAscent = buf.readUInt16BE(os2.offset + 74);
  const winDescent = buf.readUInt16BE(os2.offset + 76);
  const version = buf.readUInt16BE(os2.offset);
  const capHeight = version >= 2 && os2.offset + 90 <= buf.length
    ? buf.readInt16BE(os2.offset + 88)
    : null;
  const span = (winAscent + winDescent) / unitsPerEm;
  return {
    unitsPerEm,
    winAscent,
    winDescent,
    capHeight,
    lineSpan: span > 0 ? span : 1,
  };
}

/**
 * Read the family names out of an sfnt font's `name` table.
 *
 * This exists because libass matches by the font file's *internal* family name,
 * not by its filename and not by whatever string theme.json declares. When they
 * disagree libass silently falls back to a system face, which looks like the
 * theme being ignored. Reading the real names lets us fail loudly instead.
 *
 * Returns { families: string[], primary: string|null, fullNames: string[] }.
 */
function readFontFamilies(file) {
  const buf = fs.readFileSync(file);
  const tables = readTableDirectory(buf, file);

  const nameOff = tables.name ? tables.name.offset : null;
  const nameLen = tables.name ? tables.name.length : 0;
  if (nameOff === null || nameOff + 6 > buf.length) {
    throw new Error(`${file} has no readable "name" table, so its family name cannot be determined`);
  }

  const count = buf.readUInt16BE(nameOff + 2);
  const storage = nameOff + buf.readUInt16BE(nameOff + 4);

  const families = [];
  const fullNames = [];
  let primary = null;

  for (let i = 0; i < count; i++) {
    const rec = nameOff + 6 + i * 12;
    if (rec + 12 > nameOff + nameLen || rec + 12 > buf.length) break;
    const platformId = buf.readUInt16BE(rec);
    const nameId = buf.readUInt16BE(rec + 6);
    const length = buf.readUInt16BE(rec + 8);
    const offset = buf.readUInt16BE(rec + 10);

    if (nameId !== NAME_ID_FAMILY && nameId !== NAME_ID_TYPOGRAPHIC && nameId !== 4) continue;

    const start = storage + offset;
    if (start + length > buf.length) continue;
    const slice = buf.subarray(start, start + length);
    // Platform 1 is MacRoman (single byte); 0 and 3 are UTF-16BE.
    const value = (platformId === 1 ? slice.toString('latin1') : decodeUtf16be(slice)).trim();
    if (!value) continue;

    if (nameId === 4) {
      if (!fullNames.includes(value)) fullNames.push(value);
      continue;
    }
    if (!families.includes(value)) families.push(value);
    // Prefer the typographic family (16) on a Windows record - that is the
    // short, brand-level name a designer expects to type into theme.json.
    if (primary === null || (nameId === NAME_ID_TYPOGRAPHIC && platformId === 3)) {
      if (nameId === NAME_ID_TYPOGRAPHIC || primary === null) primary = value;
    }
  }

  return { families, primary, fullNames };
}

function decodeUtf16be(slice) {
  let out = '';
  for (let i = 0; i + 1 < slice.length; i += 2) {
    out += String.fromCharCode((slice[i] << 8) | slice[i + 1]);
  }
  return out;
}

module.exports = { readFontFamilies, readFontMetrics, readTableDirectory };
