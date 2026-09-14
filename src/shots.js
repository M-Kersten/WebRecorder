'use strict';

const fs = require('fs');
const path = require('path');

/**
 * One screenshot per recorded step, so the storyboard can show what each step
 * is looking at instead of a CSS selector.
 *
 * They live beside the flow file rather than inside it: flow.json stays a
 * readable, hand-editable list of actions, and a manifest lines the images up
 * with the steps. The manifest is written at save time, after any step the
 * recorder decided to drop has already gone, so the two can never drift.
 */

const DIR_NAME = '.thumbs';
const MANIFEST = '.storyboard.json';
const SAFE_NAME = /^[A-Za-z0-9_-]+\.jpg$/;

const dirFor = (flowFile) => path.join(path.dirname(path.resolve(flowFile)), DIR_NAME);
const manifestFor = (flowFile) => path.join(path.dirname(path.resolve(flowFile)), MANIFEST);

/** The image filenames for a flow's steps, `null` where a step has none. */
function readManifest(flowFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestFor(flowFile), 'utf8'));
    if (!Array.isArray(raw.shots)) return [];
    return raw.shots.map((name) => (typeof name === 'string' && SAFE_NAME.test(name) ? name : null));
  } catch {
    return [];
  }
}

/**
 * Point the manifest at the images these steps ended up with, and delete every
 * file no step refers to any more. Re-recording a walkthrough should not leave
 * the previous one's screenshots on disk.
 */
function writeManifest(flowFile, shots) {
  const names = shots.map((name) => (typeof name === 'string' && SAFE_NAME.test(name) ? name : null));
  fs.mkdirSync(path.dirname(manifestFor(flowFile)), { recursive: true });
  fs.writeFileSync(manifestFor(flowFile), `${JSON.stringify({ shots: names }, null, 2)}\n`, 'utf8');
  prune(flowFile, names);
  return names;
}

function prune(flowFile, keep) {
  const dir = dirFor(flowFile);
  if (!fs.existsSync(dir)) return;
  const wanted = new Set(keep.filter(Boolean));
  for (const name of fs.readdirSync(dir)) {
    if (SAFE_NAME.test(name) && !wanted.has(name)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

/**
 * Resolve one image for serving. Returns null for anything that is not a plain
 * filename sitting in the thumbnail folder, so a manifest cannot be talked into
 * handing out an arbitrary file.
 */
function fileFor(flowFile, name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) return null;
  const file = path.join(dirFor(flowFile), name);
  return fs.existsSync(file) ? file : null;
}

/**
 * Photograph what the page looks like right now.
 *
 * Failure is silent on purpose: a missed screenshot costs a thumbnail, and
 * losing a recorded step because a navigation was in flight would cost the
 * walkthrough.
 */
async function grab(page, flowFile, seq, clip = null) {
  const dir = dirFor(flowFile);
  const name = `${seq}.jpg`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: path.join(dir, name),
      type: 'jpeg',
      quality: 50,
      ...(clip || await besidePanel(page)),
    });
    return name;
  } catch {
    return null;
  }
}

/**
 * A camera for one session, which measures once and then holds still.
 *
 * Every picture has to come out the same size. The storyboard lays them in a
 * row at a fixed width, so a shot taken a moment before the panel finished
 * mounting is cropped differently from the rest and its step reads as though
 * it were a different shape from its neighbours.
 */
function shooter(flowFile) {
  let clip = null;
  return async function take(page, seq) {
    if (!clip) {
      const measured = await besidePanel(page);
      if (measured.clip) clip = measured;
    }
    return grab(page, flowFile, seq, clip);
  };
}

/**
 * The part of the window the recording panel is not covering.
 *
 * Cropping rather than hiding is the point. Playwright can hide an element for
 * the length of a screenshot, but that means the panel blinks out from under
 * whoever is mid-click, several times a session. This changes nothing on the
 * page: the panel already squeezes the site by giving <html> a right margin, so
 * whatever <html> still occupies is exactly the part that is not panel.
 */
async function besidePanel(page) {
  // The panel squeezes the page as it mounts. Measuring before that happens
  // gives the whole window, which is a different picture from every shot after
  // it, so give it a moment to arrive.
  await page.waitForFunction(
    () => parseFloat(getComputedStyle(document.documentElement).marginRight) > 0,
    null,
    { timeout: 2000 }
  ).catch(() => {});

  const clip = await page.evaluate(() => ({
    x: 0,
    y: 0,
    width: Math.min(window.innerWidth, Math.max(320, Math.round(
      document.documentElement.getBoundingClientRect().right
    ))),
    height: window.innerHeight,
  })).catch(() => null);
  return clip ? { clip } : {};
}

module.exports = {
  dirFor, manifestFor, readManifest, writeManifest, fileFor, grab, shooter,
  DIR_NAME, MANIFEST,
};
