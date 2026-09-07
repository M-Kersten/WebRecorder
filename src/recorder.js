'use strict';

const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');
const { buildOverlayScript } = require('./overlay');

/**
 * Drive the flow through a real browser and record it.
 *
 * The timing contract: narration durations are known before this runs, and
 * every step is held on screen for at least as long as its line takes to say.
 * Each step's real start time is recorded as it happens, and those timestamps
 * are what the narration track is later built against - the audio is placed at
 * measured positions, never at guessed ones.
 */
async function record(flow, theme, audio, options = {}) {
  const {
    outDir,
    headless = true,
    log = () => {},
    slowMo = 0,
  } = options;

  const { width, height } = theme.video;
  const videoDir = path.join(outDir, 'raw-video');
  fs.mkdirSync(videoDir, { recursive: true });

  const browser = await launch({
    headless,
    slowMo,
    args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width, height } },
    reducedMotion: 'no-preference',
  });

  // Injected before any page script runs, and re-injected on every navigation.
  await context.addInitScript(buildOverlayScript(theme));

  const page = await context.newPage();
  const timeline = [];
  let videoPath = null;

  try {
    // Let the recorder capture a frame or two before the first action, so the
    // video does not open mid-navigation.
    await page.waitForTimeout(400);
    const t0 = Date.now();
    const now = () => (Date.now() - t0) / 1000;

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const clip = audio[i];
      const startSec = now();
      log(`  [${String(i + 1).padStart(2)}/${flow.steps.length}] ${describe(step)}`);

      await runStep(page, step, flow, theme);

      // Hold long enough for the narration to finish, plus a beat.
      const narrationMs = clip ? clip.durationSec * 1000 : 0;
      const targetMs = Math.max(flow.minStepMs, narrationMs + flow.stepPaddingMs);
      const elapsedMs = (now() - startSec) * 1000;
      const remainingMs = targetMs - elapsedMs;
      if (remainingMs > 0) await page.waitForTimeout(remainingMs);

      timeline.push({ index: i, startSec, endSec: now() });
      if (theme.highlight.enabled) {
        await page.evaluate(() => window.__tutClearHighlight && window.__tutClearHighlight())
          .catch(() => {});
      }
    }

    // A short tail so the last caption is not cut off by the final frame.
    await page.waitForTimeout(700);
    const totalSec = now();

    const video = page.video();
    await context.close();          // close flushes the video file
    videoPath = video ? await video.path() : null;
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error('Playwright did not produce a video file for this run');
    }
    return { videoPath, timeline, totalSec };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runStep(page, step, flow, theme) {
  switch (step.action) {
    case 'goto': {
      await page.goto(resolveUrl(step.url, flow.baseUrl), { waitUntil: 'load' });
      // The overlay remounts itself after navigation; give it a tick.
      await page.waitForFunction(() => window.__tutOverlayReady === true, null, { timeout: 5000 })
        .catch(() => {});
      break;
    }
    case 'click': {
      const target = await point(page, step.selector, theme);
      await moveCursor(page, target, theme);
      if (theme.cursor.enabled) {
        await page.evaluate(() => window.__tutClickPulse && window.__tutClickPulse()).catch(() => {});
      }
      await page.click(step.selector, { timeout: 15000 });
      break;
    }
    case 'hover': {
      const target = await point(page, step.selector, theme);
      await moveCursor(page, target, theme);
      await page.hover(step.selector, { timeout: 15000 });
      break;
    }
    case 'type': {
      const target = await point(page, step.selector, theme);
      await moveCursor(page, target, theme);
      await page.click(step.selector, { timeout: 15000 });
      // A visible per-character delay; instant fills do not read as typing.
      await page.type(step.selector, step.text, { delay: step.delayMs ?? 55 });
      break;
    }
    case 'scroll': {
      if (step.selector) {
        await page.locator(step.selector).first()
          .scrollIntoViewIfNeeded({ timeout: 15000 });
      } else {
        const to = Number.isFinite(step.to) ? step.to : null;
        await page.evaluate((amount) => {
          const y = amount === null ? window.innerHeight * 0.8 : amount;
          window.scrollBy({ top: y, behavior: 'smooth' });
        }, to);
      }
      await page.waitForTimeout(500);
      break;
    }
    case 'wait': {
      await page.waitForTimeout(Number.isFinite(step.durationMs) ? step.durationMs : 1000);
      break;
    }
    default:
      throw new Error(`Unhandled action "${step.action}" (config.js should have caught this)`);
  }
}

/**
 * Centre of the target element, and the highlight ring around it. Returns null
 * when the element cannot be located, so the step still runs without a cursor
 * move rather than failing the whole recording.
 */
async function point(page, selector, theme) {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    throw new Error(`Selector "${selector}" never became visible`);
  }
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return null;

  if (theme.highlight.enabled) {
    await page.evaluate(
      (rect) => window.__tutHighlight && window.__tutHighlight(rect),
      { x: box.x, y: box.y, width: box.width, height: box.height }
    ).catch(() => {});
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function moveCursor(page, target, theme) {
  if (!theme.cursor.enabled || !target) return;
  await page.evaluate(
    ({ x, y }) => window.__tutMoveCursor && window.__tutMoveCursor(x, y),
    target
  ).catch(() => {});
  // Also move the real mouse so hover styles fire under the drawn cursor.
  await page.mouse.move(target.x, target.y).catch(() => {});
}

function resolveUrl(url, baseUrl) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (!baseUrl) {
    throw new Error(`Step url "${url}" is relative but the flow has no "baseUrl"`);
  }
  return new URL(url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function describe(step) {
  switch (step.action) {
    case 'goto': return `goto ${step.url}`;
    case 'type': return `type "${step.text}" into ${step.selector}`;
    case 'wait': return `wait ${step.durationMs ?? 1000}ms`;
    case 'scroll': return `scroll ${step.selector || (step.to ?? 'down')}`;
    default: return `${step.action} ${step.selector || ''}`.trim();
  }
}

module.exports = { record, resolveUrl };
