import { describe, it, expect } from 'vitest';
import {
  tierForQuestion, pickQuestion, startRun, gradeAnswer, nextQuestion,
  STRIKES_TO_LOSE, MIN_ANSWER_MS, TIMER_GRACE_MS, TIER_SIZES, MAX_TIER,
} from '../shared/engine.js';
import { questions, byId, seq } from './fixtures/questions.js';

const T0 = 1_000_000;
const newRun = (mode = 'normal', timerSeconds = 10) =>
  startRun({ id: 'run1', mode, handle: 'H', ipHash: 'ip', timerSeconds, now: T0, questions, rng: () => 0 });
const grade = (run, guess, elapsed = 1000, qid = run.currentQid) =>
  gradeAnswer(run, { qid, guess }, { question: byId.get(qid), now: run.issuedAt + elapsed });
const correctGuess = (run) => (byId.get(run.currentQid).real ? 'real' : 'fake');
const wrongGuess = (run) => (byId.get(run.currentQid).real ? 'fake' : 'real');

describe('TIER_SIZES', () => {
  it('grows by one question per tier, starting at 4', () => {
    expect(TIER_SIZES).toEqual([4, 5, 6, 7, 8]);
    expect(MAX_TIER).toBe(6);
  });
});

describe('tierForQuestion', () => {
  it.each([[1, 1], [4, 1], [5, 2], [9, 2], [10, 3], [15, 3], [16, 4], [22, 4], [23, 5], [30, 5], [31, 6], [100, 6]])(
    'question %i is tier %i', (n, tier) => expect(tierForQuestion(n)).toBe(tier),
  );
});

describe('pickQuestion', () => {
  it('picks a real question when rng < 0.5', () => {
    expect(pickQuestion(questions, 2, [], seq(0.1, 0)).id).toBe('r-2-0');
  });

  it('picks a fake question when rng >= 0.5', () => {
    expect(pickQuestion(questions, 2, [], seq(0.9, 0)).id).toBe('f-2-0');
  });

  it('excludes used ids and falls back to the other side', () => {
    expect(pickQuestion(questions, 2, ['r-2-0', 'r-2-1', 'r-2-2'], seq(0.1, 0)).id).toBe('f-2-0');
  });

  it('borrows from the next tier up when a tier is exhausted', () => {
    const used = questions.filter((q) => q.tier === 2).map((q) => q.id);
    expect(pickQuestion(questions, 2, used, seq(0.1, 0)).id).toBe('r-3-0');
  });

  it('the last tier borrows from lower tiers', () => {
    const used = questions.filter((q) => q.tier === 6).map((q) => q.id);
    expect(pickQuestion(questions, 6, used, seq(0.1, 0)).id).toBe('r-5-0');
  });

  it('returns null when everything is used', () => {
    expect(pickQuestion(questions, 1, questions.map((q) => q.id), Math.random)).toBeNull();
  });
});

describe('startRun', () => {
  it('starts at question 1, tier 1, with the first question issued', () => {
    const run = newRun();
    expect(run).toMatchObject({
      id: 'run1', mode: 'normal', score: 0, strikes: 0, questionNumber: 1, tier: 1,
      currentQid: 'r-1-0', issuedAt: T0, usedQids: ['r-1-0'], answers: [], finished: false,
      version: 0, createdAt: T0, timerSeconds: null,
    });
  });

  it('snapshots the timer only in hard mode', () => {
    expect(newRun('hard', 7).timerSeconds).toBe(7);
  });
});

describe('gradeAnswer', () => {
  it('scores a correct answer and clears the current question', () => {
    const run = newRun();
    const res = grade(run, correctGuess(run));
    expect(res.correct).toBe(true);
    expect(res.run).toMatchObject({ score: 1, strikes: 0, answers: [true], currentQid: null, finished: false });
  });

  it('adds a strike for a wrong answer', () => {
    const run = newRun();
    const res = grade(run, wrongGuess(run));
    expect(res.run.timedOutQids).toEqual([]);
    expect(res.correct).toBe(false);
    expect(res.run).toMatchObject({ score: 0, strikes: 1, answers: [false] });
  });

  it('rejects a qid that is not the current question', () => {
    const run = newRun();
    expect(grade(run, 'real', 1000, 'f-1-0')).toEqual({ error: 'stale' });
  });

  it('rejects answers when no question is pending', () => {
    const run = { ...newRun(), currentQid: null };
    expect(gradeAnswer(run, { qid: 'r-1-0', guess: 'real' }, { question: byId.get('r-1-0'), now: T0 + 1000 }))
      .toEqual({ error: 'stale' });
  });

  it('rejects answers faster than the minimum answer time', () => {
    const run = newRun();
    expect(grade(run, 'real', MIN_ANSWER_MS - 1)).toEqual({ error: 'too_fast' });
  });

  it('rejects timeout guesses in normal mode', () => {
    expect(grade(newRun(), 'timeout')).toEqual({ error: 'invalid' });
  });

  it('counts a timeout guess as a strike in hard mode', () => {
    const run = newRun('hard');
    const res = grade(run, 'timeout', 10_000);
    expect(res).toMatchObject({ correct: false, timedOut: true });
    expect(res.run.strikes).toBe(1);
    expect(res.run.timedOutQids).toEqual([run.currentQid]);
  });

  it('counts a late correct answer as a strike in hard mode', () => {
    const run = newRun('hard', 10);
    const res = grade(run, correctGuess(run), 10_000 + TIMER_GRACE_MS + 1);
    expect(res).toMatchObject({ correct: false, timedOut: true });
  });

  it('accepts a correct answer within the grace period', () => {
    const run = newRun('hard', 10);
    expect(grade(run, correctGuess(run), 10_000 + TIMER_GRACE_MS).correct).toBe(true);
  });

  it('finishes the run on the third strike', () => {
    let run = newRun();
    for (let i = 0; i < STRIKES_TO_LOSE; i++) {
      run = grade(run, wrongGuess(run)).run;
      if (i < STRIKES_TO_LOSE - 1) run = nextQuestion(run, questions, run.issuedAt + 2000, () => 0);
    }
    expect(run.finished).toBe(true);
    expect(grade({ ...run, currentQid: 'r-1-0' }, 'real')).toEqual({ error: 'finished' });
  });
});

describe('nextQuestion', () => {
  it('issues the next question with a fresh clock', () => {
    const run = newRun();
    const graded = grade(run, correctGuess(run)).run;
    const next = nextQuestion(graded, questions, T0 + 5000, () => 0);
    expect(next).toMatchObject({ questionNumber: 2, tier: 1, issuedAt: T0 + 5000 });
    expect(next.currentQid).not.toBeNull();
    expect(next.usedQids).toHaveLength(2);
  });

  it('is a no-op while a question is pending', () => {
    const run = newRun();
    expect(nextQuestion(run, questions, T0 + 5000, () => 0)).toBe(run);
  });

  it('moves to tier 2 at question 5', () => {
    let run = newRun();
    for (let i = 0; i < 4; i++) {
      run = grade(run, correctGuess(run)).run;
      run = nextQuestion(run, questions, run.issuedAt + 2000, () => 0);
    }
    expect(run).toMatchObject({ questionNumber: 5, tier: 2 });
  });

  it('finishes the run when the pool is exhausted', () => {
    const run = { ...newRun(), currentQid: null, usedQids: questions.map((q) => q.id) };
    expect(nextQuestion(run, questions, T0, () => 0).finished).toBe(true);
  });
});
