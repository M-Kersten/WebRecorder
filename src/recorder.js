'use strict';

const fs = require('fs');
const path = require('path');
const { launch } = require('./browser');
const { buildOverlayScript } = require('./overlay');
const { REDACTED } = require('./secrets');
const { readingTimeMs, LEAD_IN_MS, TAIL_MS } = require('./pacing');
const { timeoutFor, locate, describeTarget } = require('./target');
const { dismissConsent } = require('./consent');

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
    storageState = null,
  } = options;

  const { width, height } = theme.video;
  // The window the site is shown in. A flow may ask for a different shape than
  // the video is delivered in - a phone layout inside a 1080p frame - and the
  // mux letterboxes it onto the theme's background afterwards.
  const shot = flow.viewport || { width, height, deviceScaleFactor: 1 };
  const videoDir = path.join(outDir, 'raw-video');
  fs.mkdirSync(videoDir, { recursive: true });

  const browser = await launch({
    headless,
    slowMo,
    args: [
      '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text',
      // What Chromium paints where no document has painted yet. Its own default
      // is white, and that white is the first frame of every recording: one
      // bright flash before the stage colour arrives, on a video that is meant
      // to open on the brand's background.
      `--default-background-color=${argb(theme.video.backgroundColor)}`,
    ],
  });

  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: shot.deviceScaleFactor || 1,
    recordVideo: { dir: videoDir, size: { width: shot.width, height: shot.height } },
    reducedMotion: 'no-preference',
    ...(storageState ? { storageState } : {}),
  });

  // Injected before any page script runs, and re-injected on every navigation.
  // The mask goes in with it, so personal data is neutralised in the very first
  // frame rather than after something has already been captured.
  await context.addInitScript(buildOverlayScript(theme, flow.mask));

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
    await page.waitForTimeout(LEAD_IN_MS);
    const t0 = Date.now();
    const now = () => (Date.now() - t0) / 1000;

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const clip = audio[i];
      const enteredAt = now();
      log(`  [${String(i + 1).padStart(2)}/${flow.steps.length}] ${describeStep(step)}`);

      const stepLog = (m) => log(`       ${m}`);
      const targetRect = await runStep(page, step, flow, theme, { log: stepLog });
      const navigated = await settleAfterNavigation(page, flow, {
        log: stepLog, timeout: timeoutFor(step, flow),
      });

      // A navigation has nothing to look at until it has finished. Timing the
      // line from the moment the address changed means the voice describes a
      // page that is still blank, and everything after it sits a page load
      // early. Every other action is visible as it happens, so it counts from
      // the start.
      const startSec = (step.action === 'goto' || navigated) ? now() : enteredAt;

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
    await page.waitForTimeout(TAIL_MS);
    const totalSec = now();

    const video = page.video();
    await context.close();          // close flushes the video file
    videoPath = video ? await video.path() : null;
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error('Playwright did not produce a video file for this run');
    }
    return trimOpening({ videoPath, timeline, totalSec }, theme, log);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Run one step. Returns the bounding box of whatever it acted on, so a hint can
 * be anchored to it, or null when the step has no target.
 *
 * Every element is reached through a locator rather than a page-level selector
 * string, which is what lets a step name an iframe and have the click land
 * inside it. Every wait is the step's own budget, so a slow environment is
 * something to configure rather than something to lose a take to.
 */
async function runStep(page, step, flow, theme, options = {}) {
  const { log = () => {}, overlay = true } = options;
  const timeout = timeoutFor(step, flow);

  switch (step.action) {
    case 'goto': {
      const response = await page.goto(resolveUrl(step.url, flow.baseUrl),
        { waitUntil: 'load', timeout });
      // What came back, not just that something did. Playwright resolves goto
      // happily on a 403 or a 404: the navigation worked, the server simply
      // answered with an error page. Everything after it then runs against
      // that error page and reports itself fine - a rehearsal comes back green
      // and a render produces a video of "Access denied".
      checkStatus(response, step);
      // The overlay remounts itself after navigation; give it a tick. Only
      // worth waiting for when one was injected - a rehearsal has no overlay,
      // and waiting for a flag that will never be set spends five seconds on
      // every navigation before giving up.
      if (overlay) {
        await page.waitForFunction(() => window.__tutOverlayReady === true, null, { timeout: 5000 })
          .catch(() => {});
      }
      // The cookie wall comes down while the page is still behind the curtain,
      // so the banner never reaches the video and never pushes the narration
      // out of step. It runs alongside the settle rather than after it: both
      // are waiting for the same page to arrive, and doing them in turn puts
      // two or three seconds of nothing into the video per navigation.
      const settleMs = Number.isFinite(flow.settleMs) ? flow.settleMs : 600;
      await Promise.all([
        flow.dismiss ? dismissConsent(page, flow.dismiss, { log }) : null,
        settled(page, { settleMs, timeout, log }),
      ].filter(Boolean));
      if (overlay) await lowerCurtain(page);
      return null;
    }
    case 'click': {
      const target = await point(page, step, flow, theme);
      await moveCursor(page, target, theme);
      await showHighlight(page, target, theme);
      if (theme.cursor.enabled) {
        await page.evaluate(() => window.__tutClickPulse && window.__tutClickPulse()).catch(() => {});
        // Let the ripple start before the page changes under it.
        await page.waitForTimeout(140);
      }
      await locate(page, step).click({ timeout });
      return target && target.rect;
    }
    case 'hover': {
      const target = await point(page, step, flow, theme);
      await moveCursor(page, target, theme);
      await showHighlight(page, target, theme);
      await locate(page, step).hover({ timeout });
      return target && target.rect;
    }
    case 'type': {
      const target = await point(page, step, flow, theme);
      const field = locate(page, step);
      await moveCursor(page, target, theme);
      await showHighlight(page, target, theme);
      await field.click({ timeout });
      // A visible per-character delay; instant fills do not read as typing.
      await field.pressSequentially(step.text, {
        delay: step.delayMs ?? flow.typeDelayMs ?? 55,
        timeout,
      });
      return target && target.rect;
    }
    case 'scroll': {
      let rect = null;
      if (step.selector) {
        const locator = locate(page, step);
        await locator.scrollIntoViewIfNeeded({ timeout });
        await page.waitForTimeout(400);
        rect = await locator.boundingBox().catch(() => null);
        if (rect && theme.highlight.borderRadius === 'auto') {
          rect.radius = await locator.evaluate((el) => getComputedStyle(el).borderRadius)
            .catch(() => null);
        }
        if (step.highlight !== false) await showHighlight(page, { rect }, theme);
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
    case 'waitFor': {
      // Hold until the page says it is ready, instead of holding for a number
      // somebody guessed once on a fast connection. A saved report, a table
      // that loads after the shell, a spinner that has to go away: all of them
      // are the difference between a walkthrough that works on any site and one
      // that works on the machine it was written on.
      const state = step.state || 'visible';
      // Waiting for something to go is the one case that must look at every
      // match rather than the visible ones: "is the visible spinner hidden yet"
      // answers itself the moment the spinner hides, which is before the page
      // behind it has finished arriving.
      const waiting = locate(page, step, { visible: state === 'visible' });
      try {
        await waiting.waitFor({ state, timeout });
      } catch {
        throw new Error(
          `Waited ${(timeout / 1000).toFixed(0)}s for ${describeTarget(step)} to be ` +
          `${state}, and it never was`
        );
      }
      // Something that has just appeared is usually still arriving. A short
      // beat keeps the next step off the back of an animating layout.
      await page.waitForTimeout(Number.isFinite(step.settleMs) ? step.settleMs : 250);
      if (step.highlight === false || state === 'hidden' || state === 'detached') return null;
      return locate(page, step).boundingBox().catch(() => null);
    }
    default:
      throw new Error(`Unhandled action "${step.action}" (config.js should have caught this)`);
  }
}

/**
 * Take the waiting off the front of the recording.
 *
 * The curtain stops the load being *watched*, but the seconds it covers are
 * still in the file: a real site takes two or three, and a walkthrough that
 * opens on that long a hold of flat colour is a walkthrough nobody sits
 * through. So the head is cut, leaving one short beat for the fade from the
 * intro card to land on.
 *
 * The hard part is not the cut, it is knowing where to make it. Playwright
 * does not say when capture began, and working it out from the video's
 * duration minus the time the recorder measured carries about four hundred
 * milliseconds of slop - which lands on every line of narration, because the
 * timeline has to shift by exactly as much as the trim.
 *
 * So the video is asked instead. Under the curtain the frame is a solid, known
 * colour; the moment the page shows through is the moment the recorder called
 * for the curtain to come down, and that is a timestamp both clocks agree on.
 * Everything else follows from it.
 *
 * The same measurement fixes something that was wrong before any of this: the
 * pipeline placed narration at clock seconds into a file whose zero is not the
 * clock's zero. Measured on a finished file - when the picture changes against
 * when the sound starts - the drift was 0.96s. Nothing in the output said so,
 * because the captions were built from the same timeline and were wrong by
 * exactly the same amount, so they agreed with the voice and both disagreed
 * with the page.
 */
async function trimOpening(result, theme, log = () => {}) {
  const { videoPath, timeline, totalSec } = result;
  const none = { ...result, trimSec: 0 };
  if (theme.video.curtain === false || !timeline.length) return none;

  const ff = require('./ffmpeg');
  const leadInSec = LEAD_IN_MS / 1000;
  // Where the curtain came down, in the recorder's clock. It is lowered at the
  // end of a goto, which is also where that step's own clock starts.
  const dropClock = timeline[0].startSec;

  const dropVideo = await ff.firstFrameUnlike(videoPath, theme.video.backgroundColor, {
    maxSec: Math.min(totalSec + 4, dropClock + 8),
  }).catch(() => null);
  if (dropVideo === null) return none;

  // Where the recorder's zero sits on the video's timeline. Positive because
  // capture normally begins while the page is still being created, before the
  // clock starts; occasionally Playwright starts late and it comes out
  // negative, which is just as usable.
  const head = dropVideo - dropClock;
  if (Math.abs(head) > 5) return none;          // not a measurement worth trusting

  const trimSec = Math.max(0, dropVideo - leadInSec);
  // Everything the recorder timed is in clock seconds; the delivered file is in
  // video seconds starting at the cut. This is the one number between them, and
  // it is what the narration track and the captions are built against.
  const shift = trimSec - head;

  if (trimSec >= 0.2) log(`opening: ${trimSec.toFixed(1)}s of waiting for the page, cut`);
  return {
    videoPath,
    trimSec,
    totalSec: totalSec - shift,
    timeline: timeline.map((t) => ({
      ...t,
      startSec: Math.max(0, t.startSec - shift),
      endSec: Math.max(0, t.endSec - shift),
    })),
  };
}

/**
 * Wait until the page has stopped changing, or until the budget runs out.
 *
 * `load` is not the same question. It fires when the document and its subresources
 * are in, which on anything built this decade is the moment before the real work
 * starts: the shell is up, a fetch is in flight, and the content lands a beat
 * later. A fixed pause is a guess about somebody else's network - too short and
 * the video shows a skeleton, too long and every navigation costs seconds of
 * nothing.
 *
 * So: watch the DOM, and call it settled once `settleMs` has passed with nothing
 * changing. A page that was already finished pays exactly `settleMs`; a page
 * still assembling itself pays until it stops, up to the step's own timeout.
 *
 * Mutations are counted in the page rather than streamed out, because a busy
 * hydration can fire thousands and each one would otherwise be a round trip.
 */
async function settled(page, { settleMs = 600, timeout = 15000, stuckMs = 3000, log = () => {} } = {}) {
  const started = Date.now();
  const installed = await page.evaluate(() => {
    if (window.__tutQuiet) { window.__tutQuiet.at = Date.now(); return true; }
    const state = { at: Date.now() };
    const bump = () => { state.at = Date.now(); };
    state.observer = new MutationObserver(bump);
    state.observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
    window.__tutQuiet = state;
    return true;
  }).catch(() => false);

  // No page to ask - about:blank, or a navigation under way. Fall back to the
  // fixed pause rather than skipping the wait entirely.
  if (!installed) {
    await page.waitForTimeout(settleMs);
    return { quiet: false, ms: settleMs };
  }

  const stop = () => page.evaluate(() => {
    if (!window.__tutQuiet) return;
    window.__tutQuiet.observer.disconnect();
    delete window.__tutQuiet;
  }).catch(() => {});

  try {
    await page.waitForFunction(
      ({ ms, stuck }) => {
        if (!window.__tutQuiet) return false;
        const still = Date.now() - window.__tutQuiet.at;
        // A request in the air is a change that has not happened yet, so the
        // page cannot be finished however still it looks. __tutNet is the
        // injected script's counter; without one (a rehearsal, say) the DOM is
        // the whole answer.
        const net = window.__tutNet;
        if (!net) return still >= ms;
        // Unless it has been in the air for a while and changed nothing. A
        // long poll, a websocket fallback, an analytics beacon that never
        // returns: plenty of sites hold a connection open for the whole visit,
        // and what matters here is the picture, not the network. The network is
        // only ever evidence that the picture is about to move.
        if (net.inflight > 0) return still >= stuck;
        return Date.now() - Math.max(window.__tutQuiet.at, net.at) >= ms;
      },
      { ms: settleMs, stuck: stuckMs },
      { timeout, polling: 100 }
    );
    // Watching every node in the subtree costs something on a busy page, and
    // the recording proper is about to start. Take it off again.
    await stop();
    return { quiet: true, ms: Date.now() - started };
  } catch {
    await stop();
    // Something on the page never stops moving: a carousel, a clock, a spinner
    // that outlived its request. Nothing is wrong with the recording, so say so
    // once and carry on rather than failing a take over an animation.
    log(`the page never stopped changing; recording it as it is after ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { quiet: false, ms: Date.now() - started };
  }
}

/**
 * A step that navigated leaves a fresh curtain up, and the curtain's presence
 * is the signal: only a new document can have one, because only a new document
 * runs the injected script again.
 *
 * Clicking a link is a page load like any other. Without this it would be a
 * load the viewer watches, with the narration for that step already running
 * over it.
 */
async function settleAfterNavigation(page, flow, { log = () => {}, timeout = 15000 } = {}) {
  const up = await page.evaluate(() => !!document.querySelector('[data-tut-curtain]'))
    .catch(() => false);
  if (!up) return false;

  const settleMs = Number.isFinite(flow.settleMs) ? flow.settleMs : 600;
  await Promise.all([
    flow.dismiss ? dismissConsent(page, flow.dismiss, { log }) : null,
    settled(page, { settleMs, timeout, log }),
  ].filter(Boolean));
  await lowerCurtain(page);
  return true;
}

/** Fade the stage away, and wait for the fade so the next step is not behind it. */
async function lowerCurtain(page) {
  const waited = await page.evaluate(
    () => (window.__tutCurtainDown ? window.__tutCurtainDown().then(() => true) : false)
  ).catch(() => false);
  return waited;
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
async function point(page, step, flow, theme) {
  const locator = locate(page, step);
  const timeout = timeoutFor(step, flow);
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(
      `${describeTarget(step)} never became visible within ${(timeout / 1000).toFixed(0)}s`
    );
  }
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return null;

  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  // The ring matches the element's own corners when the theme says "auto".
  // Everything on a modern dashboard is a rounded card, and the radius differs
  // between a small tile, a hero panel and a table row.
  if (theme.highlight.borderRadius === 'auto') {
    rect.radius = await locator.evaluate((el) => getComputedStyle(el).borderRadius)
      .catch(() => null);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, rect };
}

/**
 * Put the ring on the target.
 *
 * Called after the cursor has finished travelling, never before. Showing it
 * first tells the viewer where to look before the pointer gets there, and the
 * eye goes to the ring instead of following the movement that is supposed to
 * carry the explanation.
 */
async function showHighlight(page, target, theme) {
  if (!theme.highlight.enabled || !target || !target.rect) return;
  await page.evaluate((r) => window.__tutHighlight && window.__tutHighlight(r), target.rect)
    .catch(() => {});
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

/**
 * Refuse a page the server did not agree to serve.
 *
 * Loud by default, because the alternative is a walkthrough of an error page
 * that nothing in the pipeline objects to. `allowHttpError` on the step is the
 * way out, for a flow that means to visit a page that answers 401 before
 * logging in.
 */
function checkStatus(response, step) {
  if (!response || step.allowHttpError) return;
  const status = response.status();
  if (status < 400) return;
  throw new Error(
    `${response.url()} answered ${status} ${statusName(status)}.\n` +
    'Recording it would make a video of the error page. If this page is ' +
    'meant to answer that, put "allowHttpError": true on this step.'
  );
}

const STATUS_NAMES = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  408: 'Request Timeout', 410: 'Gone', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout',
};
const statusName = (code) => STATUS_NAMES[code] || (code >= 500 ? 'Server Error' : 'Client Error');

/** #RGB or #RRGGBB as the AARRGGBB Chromium wants, fully opaque. */
function argb(hex) {
  const v = String(hex || '').replace('#', '');
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  return `FF${(full.length === 6 ? full : '0F1115').toUpperCase()}`;
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
    // A step whose text came from the environment is a password field in all
    // but name, so the console gets dots.
    case 'type': return `type "${step.secret ? REDACTED : step.text}" into ${describeTarget(step)}`;
    case 'wait': return `wait ${step.durationMs ?? 1000}ms`;
    case 'scroll': return `scroll to ${step.selector || (step.to ?? 'one screen down')}`;
    case 'waitFor': return `wait for ${describeTarget(step)} to be ${step.state || 'visible'}`;
    default: return `${step.action} ${describeTarget(step)}`.trim();
  }
}

/**
 * Log in once, in a browser of its own, and save the session.
 *
 * Separate from the recording on purpose: the login has no place in the video,
 * and the saved state means later runs skip it entirely. Returns the path to
 * the saved session.
 */
async function authenticate(flow, options = {}) {
  const { headless = true, log = () => {} } = options;
  const stateFile = path.resolve(path.dirname(flow.path), flow.auth.stateFile);

  const browser = await launch({ headless });
  try {
    const context = await browser.newContext({
      viewport: flow.viewport
        ? { width: flow.viewport.width, height: flow.viewport.height }
        : { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    for (let i = 0; i < flow.auth.steps.length; i++) {
      const step = flow.auth.steps[i];
      log(`[${i + 1}/${flow.auth.steps.length}] ${describeStep(step)}`);
      // A minimal theme: no overlay is wanted on a login that is not recorded.
      await runStep(page, step, flow, NO_DECORATION);
    }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    await context.storageState({ path: stateFile });
    // The file holds live session cookies. Treat it like a key, not a config.
    fs.chmodSync(stateFile, 0o600);
    await context.close();
    return stateFile;
  } finally {
    await browser.close().catch(() => {});
  }
}

const NO_DECORATION = {
  cursor: { enabled: false },
  highlight: { enabled: false, borderRadius: 0 },
  hints: { enabled: false, fadeMs: 0 },
};

/** Is a saved session present and recent enough to trust? */
function sessionIsFresh(flow) {
  if (!flow.auth) return false;
  const stateFile = path.resolve(path.dirname(flow.path), flow.auth.stateFile);
  if (!fs.existsSync(stateFile)) return false;
  const ageHours = (Date.now() - fs.statSync(stateFile).mtimeMs) / 3_600_000;
  return ageHours < flow.auth.maxAgeHours;
}

function sessionPath(flow) {
  return path.resolve(path.dirname(flow.path), flow.auth.stateFile);
}

module.exports = {
  record, runStep, resolveUrl, readingTimeMs, describeStep, showHighlight,
  authenticate, sessionIsFresh, sessionPath, settled, lowerCurtain, settleAfterNavigation,
  argb, checkStatus, trimOpening,
};
