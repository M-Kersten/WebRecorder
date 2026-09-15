'use strict';

const { rootFor } = require('./target');

/**
 * Getting the cookie wall out of the first frame.
 *
 * Every recording of a real site opens on a consent dialog, and a walkthrough
 * that begins by fumbling one is not a walkthrough anybody will publish. The
 * honest alternative - click it as a step - puts a banner nobody wants in the
 * video and shifts every narration line by however long the dialog took.
 *
 * So it is dismissed before the clock starts, by name. The list below covers
 * the platforms that put a stable, documented handle on their accept button;
 * it deliberately stops short of guessing from button text, which is how these
 * lists start accepting things that were never consent dialogs at all.
 *
 * Nothing here is required to match. A site without a banner passes through in
 * a few hundred milliseconds.
 */
const KNOWN = [
  // OneTrust, by far the most common, and its "reject" twin for sites that
  // only offer the granular path.
  '#onetrust-accept-btn-handler',
  '#onetrust-reject-all-handler',
  // Cookiebot
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  // Quantcast / TrustArc / Usercentrics / Didomi / Osano / Iubenda / Klaro
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  '#truste-consent-button',
  '[data-testid="uc-accept-all-button"]',
  '#didomi-notice-agree-button',
  '.osano-cm-accept-all',
  '.iubenda-cs-accept-btn',
  '.cm-btn-success',
  // cookieconsent, the open-source one a great many small sites ship
  '.cc-btn.cc-allow',
  '.cc-btn.cc-dismiss',
  // WordPress plugins that are common enough to be worth naming
  '#cookie-law-info-bar #wt-cli-accept-all-btn',
  '.cmplz-accept',
  // Google's own. The glue one is on developers.google.com and the rest of
  // their docs estate; the aria-label appears inside an iframe on search and
  // consent.google.com.
  'button.glue-cookie-notification-bar__accept',
  'button[aria-label="Accept all"]',
];

/**
 * Selectors a flow will actually try: the built-ins unless they were turned
 * off, then whatever the flow added, in that order.
 */
function selectorsFor(dismiss) {
  const d = dismiss || {};
  const own = Array.isArray(d.selectors) ? d.selectors : [];
  return d.builtins === false ? own : [...KNOWN, ...own];
}

/**
 * Click the first banner button that is actually on screen.
 *
 * Visibility is the test, not presence. These scripts leave their markup in the
 * document after the choice has been remembered, so `count()` says yes on a
 * page that has no banner, and clicking a hidden button either throws or
 * activates something the viewer cannot see.
 *
 * It polls rather than waiting on each selector in turn. A banner arrives a
 * beat after the page does, so some waiting is needed; waiting per selector
 * would spend the whole budget sixteen times over on the ordinary case, which
 * is a site with no banner at all. One budget, all selectors, in the order the
 * list gives them.
 *
 * Returns what it clicked, or null. Never throws: a banner that would not go
 * away is a thing to mention in the log, not a reason to abandon a recording.
 */
async function dismissConsent(page, dismiss, options = {}) {
  // 1500ms, because this now runs alongside the settle wait rather than after
  // it: the budget is what a navigation costs, not what it costs on top.
  const { timeoutMs = 1500, pollMs = 150, log = () => {} } = options;
  const selectors = selectorsFor(dismiss);
  if (!selectors.length) return null;

  const frames = Array.isArray(dismiss && dismiss.frames) && dismiss.frames.length
    ? dismiss.frames
    : [null];
  const roots = frames.map((frame) => rootFor(page, frame ? { frame } : null));

  const deadline = Date.now() + timeoutMs;
  do {
    for (const root of roots) {
      for (const selector of selectors) {
        if (!(await visible(root, selector))) continue;
        if (!(await click(root, selector))) continue;
        log(`dismissed a consent dialog (${selector})`);
        // The banner fades, and the page behind it often reflows once the
        // scroll lock comes off. Let that finish before anything is measured.
        await page.waitForTimeout(400).catch(() => {});
        return selector;
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(pollMs).catch(() => {});
  } while (Date.now() < deadline);
  return null;
}

/** isVisible answers now, without waiting, which is what the poll needs. */
async function visible(root, selector) {
  try {
    return await root.locator(selector).first().isVisible();
  } catch {
    return false;   // an invalid selector in somebody's list must not stop the rest
  }
}

async function click(root, selector) {
  try {
    await root.locator(selector).first().click({ timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { KNOWN, selectorsFor, dismissConsent };
