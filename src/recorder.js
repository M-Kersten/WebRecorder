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
    // Paint the stage colour before anything else. The recorder starts on
    // about:blank, which is white, so without this the video opens on a flash
    // of white before the first page loads.
    await page.setContent(
      `<!doctype html><html><body style="margin:0;height:100vh;background:${theme.video.backgroundColor}"></body></html>`,
      { waitUntil: 'load' }
    ).catch(() => {});
    // Let the recorder capture a frame or two before the first action, so the
    // video does not open mid-navigation.
    await page.waitForTimeout(400);
    const t0 = Date.now();
    const now = () => (Date.now() - t0) / 1000;

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const clip = audio[i];
      const startSec = now();
      log(`  [${String(i + 1).padStart(2)}/${flow.steps.length}] ${describeStep(step)}`);

      const targetRect = await runStep(page, step, flow, theme);

      // The hint goes up once the action has happened, so it explains what the
      // viewer is looking at rather than covering it on the way in.
      const hint = (step.hint || '').trim();
      if (hint && theme.hints.enabled) {
        await page.evaluate(
          ({ text, rect }) => window.__tutShowHint && window.__tutShowHint(text, rect),
          { text: hint, rect: targetRect }
        ).catch(() => {});
      }

      // Hold long enough for the narration to finish, plus a beat.
      const narrationMs = clip ? clip.durationSec * 1000 : 0;
      let targetMs = Math.max(flow.minStepMs, narrationMs + flow.stepPaddingMs);
      // A hint nobody has time to read is worse than no hint, so give a silent
      // step enough room to read it at a comfortable pace.
      if (hint && theme.hints.enabled) {
        targetMs = Math.max(targetMs, readingTimeMs(hint) + theme.hints.fadeMs);
      }
      const elapsedMs = (now() - startSec) * 1000;
      const remainingMs = targetMs - elapsedMs;
      if (remainingMs > 0) await page.waitForTimeout(remainingMs);

      timeline.push({ index: i, startSec, endSec: now() });

      await clearDecorations(page, theme, !!hint);
    }

    // A short tail so the last caption is not cut off by the final frame, and
    // so the closing fade has something to fade out of.
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

/**
 * Run one step. Returns the bounding box of whatever it acted on, so a hint can
 * be anchored to it, or null when the step has no target.
 */
async function runStep(page, step, flow, theme) {
  switch (step.action) {
    case 'goto': {
      await page.goto(resolveUrl(step.url, flow.baseUrl), { waitUntil: 'load' });
      // The overlay remounts itself after navigation; give it a tick.
      await page.waitForFunction(() => window.__tutOverlayReady === true, null, { timeout: 5000 })
        .catch(() => {});
      return null;
    }
    case 'click': {
      const target = await point(page, step.selector, theme);
      await moveCursor(page, target, theme);
      if (theme.cursor.enabled) {
        await page.evaluate(() => window.__tutClickPulse && window.__tutClickPulse()).catch(() => {});
        // Let the ripple start before the page changes under it.
        await page.waitForTimeout(140);
      }
      await page.click(step.selector, { timeout: 15000 });
      return target && target.rect;
    }
    case 'hover': {
      const target = await point(page, step.selector, theme);
      await moveCursor(page, target, theme);
      await page.hover(step.selector, { timeout: 15000 });
      return target && target.rect;
    }
    case 'type': {
      const target = await point(page, step.selector, theme);
      await moveCursor(page, target, theme);
      await page.click(step.selector, { timeout: 15000 });
      // A visible per-character delay; instant fills do not read as typing.
      await page.type(step.selector, step.text, { delay: step.delayMs ?? 55 });
      return target && target.rect;
    }
    case 'scroll': {
      let rect = null;
      if (step.selector) {
        const locator = page.locator(step.selector).first();
        await locator.scrollIntoViewIfNeeded({ timeout: 15000 });
        await page.waitForTimeout(400);
        rect = await locator.boundingBox().catch(() => null);
        if (rect && theme.highlight.enabled && step.highlight !== false) {
          await page.evaluate((r) => window.__tutHighlight && window.__tutHighlight(r), rect)
            .catch(() => {});
        }
      } else {
        const to = Number.isFinite(step.to) ? step.to : null;
        await page.evaluate((amount) => {
          const y = amount === null ? window.innerHeight * 0.8 : amount;
          window.scrollBy({ top: y, behavior: 'smooth' });
        }, to);
      }
      await page.waitForTimeout(500);
      return rect;
    }
    case 'wait': {
      await page.waitForTimeout(Number.isFinite(step.durationMs) ? step.durationMs : 1000);
      return null;
    }
    default:
      throw new Error(`Unhandled action "${step.action}" (config.js should have caught this)`);
  }
}

/** Roughly how long a viewer needs to read a hint, at ~3.2 words a second. */
function readingTimeMs(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(9000, Math.max(1800, (words / 3.2) * 1000 + 700));
}

/**
 * Take the ring and the hint down between steps, and wait out their fades so
 * the next step does not start over the top of them.
 */
async function clearDecorations(page, theme, hadHint) {
  const cleared = [];
  if (theme.highlight.enabled) {
    cleared.push(page.evaluate(() => window.__tutClearHighlight && window.__tutClearHighlight()));
  }
  if (hadHint && theme.hints.enabled) {
    cleared.push(page.evaluate(() => window.__tutHideHint && window.__tutHideHint()));
  }
  if (!cleared.length) return;
  await Promise.all(cleared.map((p) => p.catch(() => {})));
  await page.waitForTimeout(Math.max(200, theme.hints.fadeMs));
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

  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  if (theme.highlight.enabled) {
    await page.evaluate((r) => window.__tutHighlight && window.__tutHighlight(r), rect)
      .catch(() => {});
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, rect };
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

/** One line describing a step, for the live log and for --check. */
function describeStep(step) {
  switch (step.action) {
    case 'goto': return `goto ${step.url}`;
    case 'type': return `type "${step.text}" into ${step.selector}`;
    case 'wait': return `wait ${step.durationMs ?? 1000}ms`;
    case 'scroll': return `scroll to ${step.selector || (step.to ?? 'one screen down')}`;
    default: return `${step.action} ${step.selector || ''}`.trim();
  }
}

module.exports = { record, resolveUrl, readingTimeMs, describeStep };
