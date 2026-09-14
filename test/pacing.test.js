'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  estimateDuration, readingTimeMs, breakdownStep, estimateStepMs, estimateFlow,
  LEAD_IN_MS, TAIL_MS,
} = require('../src/pacing');

const FLOW = { minStepMs: 1400, stepPaddingMs: 600 };
const THEME = { hints: { enabled: true, fadeMs: 260 }, highlight: { enabled: true } };

test('a longer line takes longer to say, with a floor under short ones', () => {
  assert.ok(estimateDuration('word '.repeat(30)) > estimateDuration('word '.repeat(5)));
  assert.strictEqual(estimateDuration('Go'), 1.5, 'a two-word line still gets some air');
  assert.strictEqual(estimateDuration(''), 1.5);
  assert.strictEqual(estimateDuration(null), 1.5, 'no narration is not a crash');
});

test('a hint is given time to read, within reason', () => {
  assert.strictEqual(readingTimeMs('Go'), 1800, 'never flashed past');
  assert.strictEqual(readingTimeMs('word '.repeat(200)), 9000, 'never held forever');
  assert.ok(readingTimeMs('word '.repeat(20)) > readingTimeMs('word '.repeat(4)));
});

// The whole point of this module: the storyboard shows a number before
// anything has run, and the recorder must then produce that number.
test('a step is as long as the longest thing asking for time', () => {
  const bare = { action: 'click' };
  assert.strictEqual(estimateStepMs(bare, FLOW, THEME), 1400, 'the floor wins when nothing else asks');
  assert.strictEqual(breakdownStep(bare, FLOW, THEME).decidedBy, 'floor');

  const talking = { action: 'click', narration: 'word '.repeat(20) };
  assert.strictEqual(breakdownStep(talking, FLOW, THEME).decidedBy, 'narration');
  assert.ok(estimateStepMs(talking, FLOW, THEME) > 1400);

  // A hint nobody has time to read is worse than no hint.
  const hinted = { action: 'click', narration: 'Here.', hint: 'word '.repeat(25) };
  assert.strictEqual(breakdownStep(hinted, FLOW, THEME).decidedBy, 'hint');
});

test('a hint the theme does not draw asks for no time', () => {
  const step = { action: 'click', hint: 'word '.repeat(25) };
  const off = { hints: { enabled: false, fadeMs: 260 }, highlight: { enabled: true } };
  assert.strictEqual(estimateStepMs(step, FLOW, off), 1400);
  assert.ok(estimateStepMs(step, FLOW, THEME) > 1400);
});

test('the whole file is the steps plus what happens around them', () => {
  const flow = { ...FLOW, steps: [{ action: 'click' }, { action: 'click' }] };
  const plain = estimateFlow(flow, THEME);
  assert.strictEqual(plain.steps.length, 2);
  // Two floors, the two ring fade-outs, and the lead-in and tail.
  assert.strictEqual(plain.totalMs, LEAD_IN_MS + TAIL_MS + 1400 * 2 + 260 * 2);

  const carded = estimateFlow(flow, {
    ...THEME,
    intro: { enabled: true, durationSec: 3 },
    outro: { enabled: true, durationSec: 2 },
  });
  assert.strictEqual(carded.totalMs, plain.totalMs + 5000, 'the cards are part of the running time');
});

test('a flow with no pacing set still gets sensible numbers', () => {
  const { totalMs, steps } = estimateFlow({ steps: [{ action: 'goto', url: '/' }] }, null);
  assert.strictEqual(steps[0], 1200, 'config.js defaults to a 1200ms floor');
  assert.strictEqual(totalMs, LEAD_IN_MS + TAIL_MS + 1200, 'no theme means no ring to fade');
});
