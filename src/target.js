'use strict';

/**
 * Turning a step into something Playwright can act on.
 *
 * Two things live here that the recorder used to do inline with bare strings.
 *
 * Frames. A CSS selector only ever searches the document it is run against.
 * Playwright's engine does pierce open shadow roots, so a web component is
 * reachable without help, but an iframe is a separate document and nothing in a
 * top-level selector can see inside it. Checkout widgets, chat bubbles, embedded
 * dashboards and most consent walls live in one. A step says which frame it
 * means and the locator is built through frameLocator, which resolves the frame
 * at the moment the step runs rather than when the flow was written.
 *
 * Timeouts. Fifteen seconds was hard-coded in four places, which is generous
 * for a local demo and not nearly enough for a staging box that cold-starts.
 * The budget is now the flow's, and any step can raise its own.
 */

const DEFAULT_TIMEOUT_MS = 15000;

/** How long this step is allowed to wait for its target. */
function timeoutFor(step, flow) {
  if (step && Number.isFinite(step.timeoutMs)) return step.timeoutMs;
  if (flow && Number.isFinite(flow.timeoutMs)) return flow.timeoutMs;
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Normalise whatever `frame` was written as into a list of CSS selectors, one
 * per level of nesting.
 *
 * The `url:` and `name:` shorthands exist because an iframe's own element often
 * has nothing worth selecting on - no id, no test id, a generated class - while
 * its src or name is stable and is what a person would recognise.
 */
function framePath(frame) {
  if (frame === undefined || frame === null || frame === '') return [];
  const list = Array.isArray(frame) ? frame : [frame];
  return list.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('A "frame" must be a CSS selector for the iframe, or "url:..." / "name:..."');
    }
    const value = entry.trim();
    const url = /^url:(.*)$/is.exec(value);
    if (url) return `iframe[src*="${cssString(url[1].trim())}"]`;
    const name = /^name:(.*)$/is.exec(value);
    if (name) return `iframe[name="${cssString(name[1].trim())}"]`;
    return value;
  });
}

/** Escape for use inside a double-quoted CSS attribute value. */
const cssString = (v) => String(v).replace(/[\\"]/g, '\\$&');

/**
 * The thing a step's selector should be looked up in: the page itself, or a
 * FrameLocator chain down to the frame the step named.
 *
 * Both answer locator() the same way, which is the whole reason this works.
 */
function rootFor(page, step) {
  return framePath(step && step.frame)
    .reduce((root, sel) => root.frameLocator(sel), page);
}

/**
 * The locator a step acts on.
 *
 * `.first()` on purpose: a walkthrough points at one thing, and a selector that
 * matches three should still record rather than fail on strict mode. The
 * rehearsal reports the ambiguity instead, before anyone spends four minutes on
 * a render.
 *
 * And first *visible*, by default, which is the part that matters on a real
 * site. A modal, a mobile menu and a desktop menu routinely carry the same
 * markup, so `.save` matches the button in the closed panel as well as the one
 * on screen - and the closed one usually comes first in the document. Plain
 * `.first()` then picks an element nobody can see, waits for it to become
 * visible, and fails on a page where the button was there all along.
 *
 * `{ visible: false }` turns it off, for a step that is waiting for something
 * to be hidden or gone. Filtering for visible there would be asking whether a
 * visible element is invisible, which is answered instantly and wrongly.
 */
function locate(page, step, { visible = true } = {}) {
  if (!step || !step.selector) return null;
  const all = rootFor(page, step).locator(step.selector);
  return visible ? all.filter({ visible: true }).first() : all.first();
}

/** "button.pay" or "button.pay in #checkout", for logs and failures. */
function describeTarget(step) {
  if (!step || !step.selector) return '';
  const frames = framePath(step.frame);
  return frames.length ? `${step.selector} in ${frames.join(' > ')}` : step.selector;
}

/**
 * What kind of handle a selector has on its element, and how long that is
 * likely to last.
 *
 * This exists because the question "is this class name generated" has no
 * reliable answer. Pointed at real sites, capture mode meets `jtyPqk`, `as-1r`
 * and `iObqyc` - two of those are build output and one could be an
 * abbreviation somebody typed, and nothing in the string says which. Rather
 * than pretend to a confidence it does not have, the tool says what the
 * selector is resting on and lets the person decide.
 *
 *   named       a test id, an id, an aria-label, a name attribute. Someone put
 *               it there on purpose and it survives a redesign.
 *   class       a class name. Fine if a person wrote it, worthless if a
 *               bundler did, and there is no telling from here.
 *   positional  a path counting children. Correct right now, and wrong the
 *               moment anything above it moves.
 */
function selectorQuality(selector) {
  const sel = String(selector || '');
  if (!sel) return { grade: 'none', why: '' };
  if (/:nth-of-type\(/.test(sel)) {
    return {
      grade: 'positional',
      why: 'this points at a position on the page rather than at a name, so it ' +
        'breaks as soon as anything above it moves. Worth giving the element a ' +
        'data-testid, or picking something nearby that has one',
    };
  }
  if (/\[data-(testid|test-id|test|cy|qa)=|\[aria-label=|\[name=|#[A-Za-z_]/.test(sel)) {
    return { grade: 'named', why: '' };
  }
  if (/\./.test(sel)) {
    return {
      grade: 'class',
      why: 'this rests on class names, which many sites regenerate on every ' +
        'deploy. If the walkthrough stops working after a release, this is the ' +
        'first place to look',
    };
  }
  return { grade: 'tag', why: 'this matches by tag name alone, which is rarely one thing for long' };
}

module.exports = {
  DEFAULT_TIMEOUT_MS, timeoutFor, framePath, rootFor, locate, describeTarget,
  selectorQuality,
};
