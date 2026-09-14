'use strict';

/**
 * How long a step will be on screen, worked out without running anything.
 *
 * The recorder settles this for real, from measured narration durations and a
 * stopwatch. The storyboard has to show the same numbers before any of that
 * has happened, so the rule lives here once and both sides read it.
 *
 * What comes out is a floor. A step whose own action takes longer than its
 * narration runs long, and nothing here can know that in advance: a page that
 * takes four seconds to load adds four seconds nobody asked for.
 */

/** Words per second. Close to the pace ElevenLabs reads at. */
const SPEAKING_RATE = 2.6;

/** The recorder paints the stage colour and waits before the first action. */
const LEAD_IN_MS = 400;

/** And holds the last frame so the closing caption is not cut off. */
const TAIL_MS = 700;

const wordCount = (text) => String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean).length;

/** Seconds of speech for a line of narration. */
function estimateDuration(text) {
  return Math.max(1.5, wordCount(text) / SPEAKING_RATE);
}

/** Roughly how long a viewer needs to read a hint, at ~3.2 words a second. */
function readingTimeMs(text) {
  return Math.min(9000, Math.max(1800, (wordCount(text) / 3.2) * 1000 + 700));
}

/**
 * The pieces that decide one step's length, kept apart so the storyboard can
 * say which of them is the one doing the deciding.
 */
function breakdownStep(step, flow = {}, theme = null) {
  const narration = String(step.narration || '').trim();
  const hint = String(step.hint || '').trim();
  const minStepMs = Number.isFinite(flow.minStepMs) ? flow.minStepMs : 1200;
  const paddingMs = Number.isFinite(flow.stepPaddingMs) ? flow.stepPaddingMs : 600;
  const hints = (theme && theme.hints) || null;
  const hintShown = !!hint && !!hints && hints.enabled !== false;

  const parts = [{ reason: 'floor', ms: minStepMs, words: 0 }];
  if (narration) {
    parts.push({
      reason: 'narration',
      ms: Math.round(estimateDuration(narration) * 1000) + paddingMs,
      words: wordCount(narration),
    });
  }
  if (hintShown) {
    parts.push({
      reason: 'hint',
      ms: Math.round(readingTimeMs(hint) + (Number.isFinite(hints.fadeMs) ? hints.fadeMs : 0)),
      words: wordCount(hint),
    });
  }
  const decidedBy = parts.reduce((a, b) => (b.ms > a.ms ? b : a));
  return { parts, decidedBy: decidedBy.reason, ms: decidedBy.ms };
}

function estimateStepMs(step, flow = {}, theme = null) {
  return breakdownStep(step, flow, theme).ms;
}

/**
 * Between steps the ring and any hint fade out before the next one starts, and
 * that wait is in the finished file even though it belongs to no step.
 */
function clearMs(step, theme) {
  if (!theme) return 0;
  const hint = String(step.hint || '').trim();
  const hintShown = !!hint && theme.hints && theme.hints.enabled !== false;
  const ringShown = theme.highlight && theme.highlight.enabled !== false;
  if (!hintShown && !ringShown) return 0;
  const fade = theme.hints && Number.isFinite(theme.hints.fadeMs) ? theme.hints.fadeMs : 0;
  return Math.max(200, fade);
}

/** Every step's length, plus what the whole file will come to. */
function estimateFlow(flow, theme = null) {
  const steps = (flow.steps || []).map((step) => estimateStepMs(step, flow, theme));
  const gaps = (flow.steps || []).reduce((sum, step) => sum + clearMs(step, theme), 0);
  let totalMs = LEAD_IN_MS + TAIL_MS + gaps + steps.reduce((a, b) => a + b, 0);
  if (theme && theme.intro && theme.intro.enabled) totalMs += (theme.intro.durationSec || 0) * 1000;
  if (theme && theme.outro && theme.outro.enabled) totalMs += (theme.outro.durationSec || 0) * 1000;
  return { steps, totalMs: Math.round(totalMs) };
}

module.exports = {
  SPEAKING_RATE, LEAD_IN_MS, TAIL_MS,
  estimateDuration, readingTimeMs, breakdownStep, estimateStepMs, estimateFlow, wordCount,
};
