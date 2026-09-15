'use strict';

const { launch } = require('./browser');
const { rootFor, describeTarget } = require('./target');
const { runStep, describeStep } = require('./recorder');

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
        });
        report.ok = true;
        report.matches = await countMatches(page, step);
        if (report.matches > 1) {
          report.notes.push(
            `matches ${report.matches} elements; the recording will use the first`
          );
        }
      } catch (err) {
        report.error = firstLine(err.message);
        // Why it failed matters more than that it did. A selector that matches
        // nothing is a rename; one that matches something invisible is usually
        // a panel that has not opened yet, and wants a waitFor in front of it.
        report.matches = await countMatches(page, step);
        if (report.matches === 0 && step.selector) {
          report.notes.push('nothing on the page matches this selector');
        } else if (report.matches > 0 && step.selector) {
          report.notes.push(
            `${report.matches} element${report.matches === 1 ? '' : 's'} match, ` +
            'but none of them were ready in time - a waitFor step before this one may be what it needs'
          );
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
