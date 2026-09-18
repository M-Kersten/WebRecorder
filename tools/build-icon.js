'use strict';

/**
 * Build assets/brand/Qapture.icns from the app icon SVG.
 *
 * macOS reads a bundle's icon out of an .icns, and iconutil only exists on a
 * Mac, so this writes the container directly: 'icns', a total length, then one
 * entry per size as a four-character type, the length including its own
 * header, and a PNG. The PNGs come from the same SVG the window draws its own
 * mark from, rendered in the browser that is already a dependency.
 *
 * Run it after changing the icon:  node tools/build-icon.js
 */
const fs = require('fs');
const path = require('path');

const BRAND = path.join(__dirname, '..', 'assets', 'brand');
const { launch } = require('../src/browser');

const SVG = fs.readFileSync(path.join(BRAND, 'qapture-icon.svg'), 'utf8');
const SIZES = [
  ['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256],
  ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64],
  ['ic13', 256], ['ic14', 512],
];

(async () => {
  const browser = await launch({ headless: true });
  const entries = [];
  const cache = new Map();
  for (const [type, size] of SIZES) {
    if (!cache.has(size)) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(
        `<!doctype html><body style="margin:0">${SVG.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`
      );
      cache.set(size, await page.screenshot({ type: 'png', omitBackground: false }));
      await page.close();
    }
    entries.push([type, cache.get(size)]);
  }
  await browser.close();

  const chunks = entries.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  const out = path.join(BRAND, 'Qapture.icns');
  fs.writeFileSync(out, Buffer.concat([head, body]));
  console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(1) + ' KB', entries.length, 'sizes');
})();
