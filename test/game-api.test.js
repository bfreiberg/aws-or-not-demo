import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestStore } from './helpers/dynamo.js';
import { createClock, counterId } from './helpers/clock.js';
import { questions, byId } from './fixtures/questions.js';
import { createGameApp } from '../game/app.js';
import { LEADERBOARD_DAILY_CAP } from '../game/api.js';
import { dayOf } from '../shared/http.js';

let ctx;
let clock;
let app;

beforeAll(async () => {
  ctx = await createTestStore();
  clock = createClock();
  app = createGameApp({
    store: ctx.store,
    questions,
    config: { get: async () => ({ hardTimerSeconds: 10 }) },
    now: clock.now,
    rng: () => 0,
    newRunId: counterId('run', 8),
    newResultId: counterId('res', 5),
    hashIp: (ip) => `h:${ip}`,
    generateHandle: () => 'Test Otter #1000',
    assetDir: new URL('../game/assets/', import.meta.url),
    publicOrigin: 'https://example.com',
  });
});
afterAll(async () => { await ctx.cleanup(); });

const post = (path, body, headers = {}) => app.request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
});

async function start(mode = 'normal', headers) {
  const res = await post('/api/runs', { mode }, headers);
  expect(res.status).toBe(201);
  return res.json();
}

async function answer(runId, qid, correct, { wait = 1000 } = {}) {
  clock.advance(wait);
  const guess = byId.get(qid).real === correct ? 'real' : 'fake';
  return post(`/api/runs/${runId}/answer`, { qid, guess });
}

async function next(runId) {
  clock.advance(2000);
  return post(`/api/runs/${runId}/next`);
}

async function loseRun(headers) {
  const run = await start('normal', headers);
  let qid = run.question.qid;
  let body;
  for (let i = 0; i < 3; i++) {
    body = await (await answer(run.runId, qid, false)).json();
    if (!body.gameOver) qid = (await (await next(run.runId)).json()).question.qid;
  }
  return { run, body };
}

describe('POST /api/runs', () => {
  it('creates a run and never leaks the answer', async () => {
    const res = await post('/api/runs', { mode: 'normal' });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('"real"');
    expect(JSON.parse(text)).toMatchObject({
      handle: 'Test Otter #1000', mode: 'normal', timerSeconds: null, score: 0, strikes: 0,
      question: { qid: 'r-1-0', name: 'Real 1.0', number: 1, tier: 1, rank: 'Solutions Architect Intern' },
    });
  });

  it('snapshots the hard timer', async () => {
    expect((await start('hard')).timerSeconds).toBe(10);
  });

  it('rejects an invalid mode', async () => {
    expect((await post('/api/runs', { mode: 'insane' })).status).toBe(400);
  });

  it('rejects oversized bodies', async () => {
    expect((await post('/api/runs', JSON.stringify({ mode: 'normal', pad: 'x'.repeat(4096) }))).status).toBe(413);
  });
});

describe('malformed JSON bodies', () => {
  it('returns 400 for malformed JSON to POST /api/runs', async () => {
    const res = await post('/api/runs', '{bad');
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed JSON to POST /api/runs/:id/answer', async () => {
    const run = await start();
    const res = await post(`/api/runs/${run.runId}/answer`, '{bad');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/runs/:id/answer and /next', () => {
  it('grades, reports stats, then issues the next question', async () => {
    const run = await start();
    const res = await answer(run.runId, run.question.qid, true);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ correct: true, timedOut: false, real: true, explanation: 'Explanation 1.0', score: 1, strikes: 0 });
    expect(body.pctCorrect).toBeGreaterThanOrEqual(0);
    expect(body.question).toBeUndefined();

    const nextRes = await next(run.runId);
    expect(nextRes.status).toBe(200);
    expect((await nextRes.json()).question).toMatchObject({ number: 2, tier: 1 });
  });

  it('rejects a second answer before /next', async () => {
    const run = await start();
    await answer(run.runId, run.question.qid, true);
    expect((await answer(run.runId, run.question.qid, true)).status).toBe(409);
  });

  it('/next is idempotent while a question is pending', async () => {
    const run = await start();
    const res = await next(run.runId);
    expect((await res.json()).question.qid).toBe(run.question.qid);
  });

  it('rejects answers faster than 400ms', async () => {
    const run = await start();
    expect((await answer(run.runId, run.question.qid, true, { wait: 100 })).status).toBe(429);
  });

  it('returns 404 for unknown runs', async () => {
    expect((await post('/api/runs/doesnotexist1/answer', { qid: 'r-1-0', guess: 'real' })).status).toBe(404);
  });

  it('times out late answers in hard mode', async () => {
    const run = await start('hard');
    const body = await (await answer(run.runId, run.question.qid, true, { wait: 12_000 })).json();
    expect(body).toMatchObject({ correct: false, timedOut: true, strikes: 1 });
  });

  it('ends the run on the third strike and creates a leaderboard result', async () => {
    const { run, body } = await loseRun({ 'x-forwarded-for': '9.9.9.1' });
    expect(body).toMatchObject({ gameOver: true, strikes: 3, rank: 'Solutions Architect Intern' });
    expect(body.resultId).toMatch(/^res\d{5}$/);
    const result = await ctx.store.getResult(body.resultId);
    expect(result).toMatchObject({ handle: 'Test Otter #1000', mode: 'normal', score: 0, tier: 1, answers: [false, false, false] });
    // The three questions that ended the run, by name, in the order they were missed.
    expect(result.misses).toHaveLength(3);
    // Each miss records the truth, so the card can show whether the player called a real service fake or vice versa.
    expect(result.misses.every((m) => questions.some((q) => q.name === m.name && q.real === m.real))).toBe(true);
    const board = await ctx.store.getLeaderboard('normal', 50);
    expect(board.map((r) => r.id)).toContain(body.resultId);
    // /next on a cleanly finished run returns 200 with gameOver (I5-b)
    const nextRes = await next(run.runId);
    expect(nextRes.status).toBe(200);
    const nextBody = await nextRes.json();
    expect(nextBody).toMatchObject({ gameOver: true, resultId: body.resultId });
  });

  it('keeps results off the leaderboard past the daily cap', async () => {
    // Use 9.9.9.3 (not .1 or .2) so this test has its own isolated rate counter
    for (let i = 0; i < LEADERBOARD_DAILY_CAP; i++) {
      await ctx.store.incrementRate('h:9.9.9.3', dayOf(clock.now()), clock.now());
    }
    const { body } = await loseRun({ 'x-forwarded-for': '9.9.9.3' });
    expect(await ctx.store.getResult(body.resultId)).not.toBeNull();
    const board = await ctx.store.getLeaderboard('normal', 50);
    expect(board.map((r) => r.id)).not.toContain(body.resultId);
  });

  it('no XFF still lands on leaderboard even after 25 pre-increments of the unknown hash (I3)', async () => {
    // Pre-increment the 'unknown' hash 25 times (past the daily cap)
    for (let i = 0; i < 25; i++) {
      await ctx.store.incrementRate('h:unknown', dayOf(clock.now()), clock.now());
    }
    // A run started without x-forwarded-for should use null ipHash, skipping the rate counter
    const { body } = await loseRun(); // no headers => clientIp returns 'unknown'
    expect(body.gameOver).toBe(true);
    expect(body.resultId).toBeTruthy();
    const board = await ctx.store.getLeaderboard('normal', 50);
    expect(board.map((r) => r.id)).toContain(body.resultId);
  });

  it('recovers a half-finished finalize: putResult throws once, then /next returns 200 with the same resultId (I5-a)', async () => {
    let thrown = false;
    const wrappedStore = {
      ...ctx.store,
      putResult: async (...args) => {
        if (!thrown) { thrown = true; throw new Error('boom'); }
        return ctx.store.putResult(...args);
      },
    };
    const wrappedApp = createGameApp({
      store: wrappedStore,
      questions,
      config: { get: async () => ({ hardTimerSeconds: 10 }) },
      now: clock.now,
      rng: () => 0,
      newRunId: counterId('wrun', 7),
      newResultId: counterId('wres', 4),
      hashIp: (ip) => `h:${ip}`,
      generateHandle: () => 'Test Otter #1000',
      assetDir: new URL('../game/assets/', import.meta.url),
      publicOrigin: 'https://example.com',
    });
    const wpost = (path, body, headers = {}) => wrappedApp.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });

    // Start a run
    clock.advance(1000);
    const startRes = await wpost('/api/runs', { mode: 'normal' }, { 'x-forwarded-for': '9.9.9.4' });
    expect(startRes.status).toBe(201);
    const run = await startRes.json();

    // Answer wrong 3 times; putResult throws on the 3rd strike
    let qid = run.question.qid;
    let thirdRes;
    for (let i = 0; i < 3; i++) {
      clock.advance(1000);
      const guess = byId.get(qid).real ? 'fake' : 'real';
      const res = await wpost(`/api/runs/${run.runId}/answer`, { qid, guess }, { 'x-forwarded-for': '9.9.9.4' });
      if (i < 2) {
        const b = await res.json();
        clock.advance(2000);
        const nr = await wpost(`/api/runs/${run.runId}/next`, {}, { 'x-forwarded-for': '9.9.9.4' });
        qid = (await nr.json()).question.qid;
      } else {
        thirdRes = res;
      }
    }
    // 3rd-strike answer returns 500 because putResult threw
    expect(thirdRes.status).toBe(500);

    // /next on the same run should recover: getResult=null => finalize runs again => putResult succeeds
    const daysBefore = await ctx.store.getDays(['ALL'], ['normal']);
    const gamesBefore = daysBefore[0]?.games ?? 0;

    clock.advance(2000);
    const recoveryRes = await wpost(`/api/runs/${run.runId}/next`);
    expect(recoveryRes.status).toBe(200);
    const recoveryBody = await recoveryRes.json();
    expect(recoveryBody).toMatchObject({ gameOver: true });
    expect(recoveryBody.resultId).toBeTruthy();

    // resultId in the response must match what was persisted on the run
    const savedRun = await ctx.store.getRun(run.runId);
    expect(recoveryBody.resultId).toBe(savedRun.resultId);

    expect(await ctx.store.getResult(recoveryBody.resultId)).not.toBeNull();

    // finalize ran exactly once (failure + recovery = 1 game recorded, not 2)
    const daysAfter = await ctx.store.getDays(['ALL'], ['normal']);
    expect((daysAfter[0]?.games ?? 0) - gamesBefore).toBe(1);
  });

  it('/next twice after game over does not double-count DAY#ALL games (I5-c)', async () => {
    const beforeDays = await ctx.store.getDays(['ALL'], ['normal']);
    const gamesBefore = beforeDays[0]?.games ?? 0;

    const { run } = await loseRun({ 'x-forwarded-for': '9.9.9.5' });

    const afterOnce = await ctx.store.getDays(['ALL'], ['normal']);
    expect((afterOnce[0]?.games ?? 0) - gamesBefore).toBe(1);

    // Call /next twice more on the finished run
    await next(run.runId);
    await next(run.runId);

    const afterTwice = await ctx.store.getDays(['ALL'], ['normal']);
    expect((afterTwice[0]?.games ?? 0) - gamesBefore).toBe(1); // still only 1
  });
});
