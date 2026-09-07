'use strict';

const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');

/**
 * Intro/outro cards are rendered as HTML in the browser, not with ffmpeg's
 * drawtext. drawtext cannot do @font-face, gradients or a logo laid out beside
 * text; a page can, and it uses the same bundled fonts the captions do.
 *
 * Fonts and logos are inlined as data URIs rather than file:// URLs. A page
 * loaded via setContent has an opaque origin, and CORS applies to webfonts, so
 * a file:// @font-face would be blocked and silently fall back to a system
 * face - the same class of failure as libass picking the wrong font.
 */

const MIME = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function dataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** CSS string literal: quotes and backslashes only. */
const cssString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Build the card's HTML. `card` is theme.intro or theme.outro.
 */
function buildCardHtml(card, theme) {
  const { width, height } = theme.video;

  // Only embed the fonts this card actually references.
  const used = new Map();
  for (const key of [card.titleFont, card.subtitleFont]) {
    if (key && theme.fonts[key] && !used.has(key)) used.set(key, theme.fonts[key]);
  }
  const faces = [...used.values()].map((font) => `
    @font-face {
      font-family: ${cssString(font.family)};
      src: url(${dataUri(font.path)}) format(${cssString(fontFormat(font.path))});
      font-weight: ${font.weight};
      font-style: ${font.style};
      font-display: block;
    }`).join('\n');

  const stack = (key, fallback) => {
    const font = key && theme.fonts[key];
    return font ? `${cssString(font.family)}, ${fallback}` : fallback;
  };
  const weight = (key) => (key && theme.fonts[key] ? theme.fonts[key].weight : 400);

  const background = Array.isArray(card.backgroundGradient) && card.backgroundGradient.length >= 2
    ? `linear-gradient(135deg, ${card.backgroundGradient.join(', ')})`
    : card.backgroundColor;

  // Scale type off the frame height so one card design works at any resolution.
  const unit = height / 1080;

  const logo = card.logoPath
    ? `<img class="logo" src="${dataUri(card.logoPath)}" alt="">`
    : '';
  const title = card.title
    ? `<h1 class="title">${escapeHtml(card.title)}</h1>`
    : '';
  const subtitle = card.subtitle
    ? `<p class="subtitle">${escapeHtml(card.subtitle)}</p>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  ${faces}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${width}px; height: ${height}px;
    overflow: hidden;
    background: ${background};
  }
  body {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: ${28 * unit}px;
    text-align: center;
    padding: ${80 * unit}px;
    -webkit-font-smoothing: antialiased;
  }
  .logo {
    max-width: ${420 * unit}px; max-height: ${200 * unit}px;
    object-fit: contain;
    margin-bottom: ${20 * unit}px;
  }
  .title {
    font-family: ${stack(card.titleFont, 'system-ui, sans-serif')};
    font-weight: ${weight(card.titleFont)};
    font-size: ${104 * unit}px;
    line-height: 1.08;
    letter-spacing: ${-2 * unit}px;
    color: ${card.titleColor};
  }
  .subtitle {
    font-family: ${stack(card.subtitleFont, 'system-ui, sans-serif')};
    font-weight: ${weight(card.subtitleFont)};
    font-size: ${42 * unit}px;
    line-height: 1.35;
    color: ${card.subtitleColor};
  }
</style></head>
<body>${logo}${title}${subtitle}</body></html>`;
}

function fontFormat(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.otf': return 'opentype';
    case '.woff': return 'woff';
    case '.woff2': return 'woff2';
    default: return 'truetype';
  }
}

/**
 * Render one card to a PNG.
 *
 * `browser` is optional: pass an already-open one to avoid a second launch,
 * otherwise a short-lived instance is used.
 */
async function renderCard(card, theme, outFile, options = {}) {
  const { browser: existing } = options;
  const browser = existing || await launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: theme.video.width, height: theme.video.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.setContent(buildCardHtml(card, theme), { waitUntil: 'load' });
    // Without this the screenshot can land before the embedded face is ready
    // and capture a fallback font instead.
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: outFile, type: 'png' });
  } finally {
    await context.close();
    if (!existing) await browser.close().catch(() => {});
  }
  return outFile;
}

module.exports = { renderCard, buildCardHtml, dataUri };
