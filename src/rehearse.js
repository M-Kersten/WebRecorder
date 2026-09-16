'use strict';

const { launch } = require('./browser');
const { rootFor, describeTarget, selectorQuality } = require('./target');
const { runStep, describeStep, settled } = require('./recorder');

/**
 * Walk the flow through once, quickly, and report what would break.
 *
 * A render costs a browser launch, a voice for every line, a recording in real
 * time and an encode. Finding out at the end of all that which selector no
 * longer exists is the single most expensive way to learn it, and it is what
 * happens every time a site ships a redesign.
 *
 * So the flow runs first with nothing attached: no video, no narration, no
 * overlay, no pacing. Each step is timed and counted, and the run stops at the
 * first failure - everything after a step that did not happen is in an unknown
 * state, and reporting guesses about it would be worse than saying so.
 *
 * What it can tell you that static validation cannot: whether the selector
 * matches anything at all, whether it matches more than one thing, how long the
 * page really took, and whether a consent wall is in the way.
 */
async function rehearse(flow, theme, options = {}) {
  const { headless = true, log = () => {}, storageState = null } = options;

  const shot = flow.viewport || { width: 1440, height: 900, deviceScaleFactor: 1 };
  const browser = await launch({ headless });
  const started = Date.now();
  const steps = [];

  try {
    const context = await browser.newContext({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: shot.deviceScaleFactor || 1,
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const at = Date.now();
      const report = {
        index: i,
        action: step.action,
        describe: describeStep(step),
        target: describeTarget(step),
        ok: false,
        ms: 0,
        matches: null,
        notes: [],
      };

      try {
        await runStep(page, step, flow, REHEARSAL, {
          log: (m) => report.notes.push(m),
          overlay: false,
        });
        // Let the page react before asking anything about it.
        //
        // This is not politeness, it is the difference between a rehearsal that
        // means something and one that does not. The recording moves a cursor,
        // draws a ring and waits out a ripple between steps; a rehearsal with
        // none of that is a second quicker per step, and a second is plenty for
        // a site to swap what you just clicked for a hydrated version of
        // itself. Wikipedia does exactly that to its search box, and this
        // rehearsal used to sail past a step the recording then failed on.
        await settled(page, {
          settleMs: Number.isFinite(flow.settleMs) ? flow.settleMs : 600,
          timeout: 4000,
        }).catch(() => {});

        report.ok = true;
        report.matches = await countMatches(page, step);
        if (report.matches > 1) {
          report.notes.push(
            `matches ${report.matches} elements; the recording will use the first`
          );
        }
        // A step that worked and now matches nothing means the page replaced
        // what it acted on - a search box swapped for a live one, a row
        // re-rendered. Normal, and not worth a warning that reads like a fault.
        if (report.matches === 0) report.matches = null;
        // A step that works today is not the same as a step that will work in
        // March. What the selector is resting on is the best predictor there
        // is, and it costs nothing to say.
        const quality = selectorQuality(step.selector);
        report.grade = quality.grade;
        if (quality.why) report.notes.push(quality.why);
      } catch (err) {
        report.error = firstLine(err.message);
        // Why it failed matters more than that it did, and the three reasons
        // want three different fixes: a selector that matches nothing is a
        // rename, one whose element is on the page but laid out away is usually
        // a responsive variant, and one that is simply late wants a waitFor.
        report.matches = await countMatches(page, step);
        if (step.selector && report.matches === 0) {
          report.notes.push('nothing on the page matches this selector');
        } else if (step.selector && report.matches > 0) {
          const how = await describeHidden(page, step);
          const many = `${report.matches} element${report.matches === 1 ? '' : 's'} match`;
          report.notes.push(how
            ? `${many}, but ${how}`
            : `${many}, but none of them were ready in time - a waitFor step ` +
              'before this one may be what it needs');
        }
      }

      report.ms = Date.now() - at;
      steps.push(report);
      log(formatStep(report, i, flow.steps.length));
      if (!report.ok) break;
    }

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }

  const reached = steps.length;
  const failed = steps.find((s) => !s.ok) || null;
  return {
    ok: !failed && reached === flow.steps.length,
    steps,
    failed,
    notReached: flow.steps.length - reached,
    totalMs: Date.now() - started,
  };
}

/**
 * How many elements the step's selector actually matches, right now.
 *
 * Counted after the step rather than before, because that is where the answer
 * is useful: a rehearsal exists to say "this used to be one button and is now
 * three tabs", and after the click is when the page is in the state the next
 * step will meet.
 */
async function countMatches(page, step) {
  if (!step.selector) return null;
  try {
    // rootFor, not locate: locate narrows to the first match, and the count is
    // the whole point.
    return await rootFor(page, step).locator(step.selector).count();
  } catch {
    return null;    // an unparseable selector; the step's own error says so
  }
}

/**
 * Why a matching element could not be acted on.
 *
 * A panel that has not opened and a hamburger that only exists below a
 * breakpoint are both `display: none`, and they want opposite fixes: waiting
 * longer, or recording the site at a different shape. The stylesheet will not
 * say which, so this stops reasoning and runs the experiment - narrow the
 * window, look again, put it back. One reflow, only ever on a failure, and it
 * turns a guess into an answer.
 */
async function describeHidden(page, step) {
  const shown = () => rootFor(page, step).locator(step.selector).first().isVisible()
    .catch(() => false);
  try {
    const how = await rootFor(page, step).locator(step.selector).first().evaluate((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (style.display === 'none') return 'display-none';
      if (style.visibility === 'hidden') return 'visibility-hidden';
      if (box.width === 0 || box.height === 0) return 'no-size';
      return null;
    });
    if (how === 'visibility-hidden') {
      return 'it is on the page and hidden, which usually means something has ' +
        'to reveal it first';
    }
    if (how !== 'display-none' && how !== 'no-size') return null;

    const size = page.viewportSize();
    if (!size || size.width <= 420) return 'it is on the page but not laid out';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const narrow = await shown();
    await page.setViewportSize(size);
    await page.waitForTimeout(150);

    return narrow
      ? 'it appears only at a narrower window - this is the phone layout of the ' +
        'site. Set "viewport" to phone to record that one'
      : 'it is on the page but not laid out, so something has to open it first. ' +
        'A step that opens it, or a waitFor, is what this needs';
  } catch {
    return null;
  }
}

/** Everything off. A rehearsal is about whether the steps work, not how they look. */
const REHEARSAL = {
  cursor: { enabled: false },
  highlight: { enabled: false, borderRadius: 0 },
  hints: { enabled: false, fadeMs: 0 },
};

const firstLine = (s) => String(s).split('\n').find((l) => l.trim()) || String(s);

function formatStep(report, i, total) {
  const n = `[${String(i + 1).padStart(2)}/${total}]`;
  const mark = report.ok ? 'ok  ' : 'FAIL';
  const head = `  ${n} ${mark} ${report.describe}  (${(report.ms / 1000).toFixed(1)}s)`;
  const rest = [];
  if (report.error) rest.push(`         ${report.error}`);
  for (const note of report.notes) rest.push(`         ${note}`);
  return [head, ...rest].join('\n');
}

/** The whole report as text, for the terminal. */
function describeRehearsal(result, flow) {
  const lines = [];
  if (result.ok) {
    lines.push(`All ${result.steps.length} steps ran, in ${(result.totalMs / 1000).toFixed(1)}s.`);
    const slow = result.steps.filter((s) => s.ms > 5000);
    for (const s of slow) {
      lines.push(`  step ${s.index + 1} took ${(s.ms / 1000).toFixed(1)}s; ` +
        'a waitFor on what it is waiting for is steadier than hoping');
    }
    const many = result.steps.filter((s) => s.matches > 1);
    for (const s of many) {
      lines.push(`  step ${s.index + 1}: "${s.target}" matches ${s.matches} elements`);
    }
    const shaky = result.steps.filter((s) => s.grade === 'positional' || s.grade === 'tag');
    if (shaky.length) {
      lines.push('');
      lines.push(`${shaky.length} step${shaky.length === 1 ? '' : 's'} point at a position ` +
        'rather than a name, and will break when the page changes: ' +
        shaky.map((s) => s.index + 1).join(', '));
    }
    const dated = result.steps.filter((s) => s.grade === 'dated');
    if (dated.length) {
      lines.push('');
      lines.push(`${dated.length} step${dated.length === 1 ? '' : 's'} have a date written ` +
        `into the selector and stop working once it passes: ${dated.map((s) => s.index + 1).join(', ')}`);
    }
    return lines.join('\n');
  }
  const f = result.failed;
  lines.push(`Step ${f.index + 1} of ${flow.steps.length} did not work: ${f.describe}`);
  if (f.error) lines.push(`  ${f.error}`);
  for (const note of f.notes) lines.push(`  ${note}`);
  if (result.notReached > 0) {
    lines.push(`  ${result.notReached} later step${result.notReached === 1 ? '' : 's'} ` +
      'were not tried, because the page never reached the state they expect.');
  }
  return lines.join('\n');
}

module.exports = { rehearse, describeRehearsal, REHEARSAL };
