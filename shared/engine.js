export const STRIKES_TO_LOSE = 3;
export const MIN_ANSWER_MS = 400;
export const TIMER_GRACE_MS = 1500;
import { RANKS } from './ranks.js';

export const MAX_TIER = RANKS.length;

// Questions per tier: 4 as Intern, 5 as Associate, then one more per tier. The last tier never ends.
export const TIER_SIZES = Object.freeze(Array.from({ length: MAX_TIER - 1 }, (_, i) => 4 + i));

// First question number (1-based) of each tier: [1, 5, 10, 16, 23, 31].
const TIER_STARTS = TIER_SIZES.reduce((starts, size) => [...starts, starts.at(-1) + size], [1]);

export function tierForQuestion(n) {
  let tier = 1;
  TIER_STARTS.forEach((start, i) => {
    if (n >= start) tier = i + 1;
  });
  return tier;
}

// Requested tier first, then harder tiers, then easier ones.
function tierOrder(tier) {
  const order = [tier];
  for (let t = tier + 1; t <= MAX_TIER; t++) order.push(t);
  for (let t = tier - 1; t >= 1; t--) order.push(t);
  return order;
}

export function pickQuestion(questions, tier, usedIds, rng = Math.random) {
  const used = new Set(usedIds);
  for (const t of tierOrder(tier)) {
    const pool = questions.filter((q) => q.tier === t && !used.has(q.id));
    if (pool.length === 0) continue;
    const wantReal = rng() < 0.5;
    const side = pool.filter((q) => q.real === wantReal);
    const from = side.length > 0 ? side : pool;
    return from[Math.floor(rng() * from.length)];
  }
  return null;
}

export function startRun({ id, mode, handle, ipHash, timerSeconds, now, questions, rng = Math.random }) {
  const first = pickQuestion(questions, 1, [], rng);
  return {
    id,
    mode,
    handle,
    ipHash,
    timerSeconds: mode === 'hard' ? timerSeconds : null,
    score: 0,
    strikes: 0,
    questionNumber: 1,
    tier: 1,
    currentQid: first.id,
    issuedAt: now,
    usedQids: [first.id],
    answers: [],
    timedOutQids: [],
    finished: false,
    version: 0,
    createdAt: now,
  };
}

export function gradeAnswer(run, { qid, guess }, { question, now }) {
  if (run.finished) return { error: 'finished' };
  if (run.currentQid === null || qid !== run.currentQid || question?.id !== qid) return { error: 'stale' };
  const hard = run.mode === 'hard';
  if (!hard && guess === 'timeout') return { error: 'invalid' };

  const elapsed = now - run.issuedAt;
  const timedOut = hard && (guess === 'timeout' || elapsed > run.timerSeconds * 1000 + TIMER_GRACE_MS);
  if (!timedOut && elapsed < MIN_ANSWER_MS) return { error: 'too_fast' };

  const correct = !timedOut && (guess === 'real') === question.real;
  const strikes = run.strikes + (correct ? 0 : 1);
  return {
    correct,
    timedOut,
    run: {
      ...run,
      score: run.score + (correct ? 1 : 0),
      strikes,
      answers: [...run.answers, correct],
      timedOutQids: timedOut ? [...(run.timedOutQids ?? []), qid] : (run.timedOutQids ?? []),
      currentQid: null,
      finished: strikes >= STRIKES_TO_LOSE,
    },
  };
}

export function nextQuestion(run, questions, now, rng = Math.random) {
  if (run.finished || run.currentQid !== null) return run;
  const questionNumber = run.questionNumber + 1;
  const tier = tierForQuestion(questionNumber);
  const question = pickQuestion(questions, tier, run.usedQids, rng);
  if (!question) return { ...run, finished: true };
  return {
    ...run,
    questionNumber,
    tier,
    currentQid: question.id,
    issuedAt: now,
    usedQids: [...run.usedQids, question.id],
  };
}
