import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuestionStatsRecorder } from '../game/question-stats.js';
import { createGameApp } from '../game/app.js';
import { startRun } from '../shared/engine.js';
import { ConflictError, createStore } from '../shared/db/store.js';
import { questions } from './fixtures/questions.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(setImmediate);

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

function setup() {
  const run = startRun({
    id: 'run00001', mode: 'normal', handle: 'Test Otter', ipHash: 'test-ip', timerSeconds: 10,
    now: 1000, questions, rng: () => 0,
  });
  const store = {
    getRun: vi.fn(async () => structuredClone(run)),
    saveRun: vi.fn(async (value) => ({ ...value, version: value.version + 1 })),
    recordAnswerStat: vi.fn(async () => ({ seen: 4, correct: 3 })),
    getQuestionStats: vi.fn(async () => new Map([[run.currentQid, { seen: 4, correct: 3 }]])),
    getResult: vi.fn(async () => null),
    finalizeResult: vi.fn(async () => {}),
  };
  const app = createGameApp({
    store, questions, now: () => 2000, rng: () => 0,
    newResultId: () => 'result01', publicOrigin: 'https://example.com',
  });
  const answer = (guess = 'real') => app.request('/api/runs/run00001/answer', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ qid: run.currentQid, guess }),
  });
  return { run, store, app, answer };
}

describe('answer feedback without waiting for statistics', () => {
  it('returns full feedback while the statistics write is still pending', async () => {
    const { answer, store } = setup();
    const pending = deferred();
    store.recordAnswerStat.mockReturnValue(pending.promise);
    try {
      const response = await answer();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        correct: true, timedOut: false, real: true, explanation: 'Explanation 1.0', score: 1, strikes: 0,
      });
      expect(store.recordAnswerStat).toHaveBeenCalledTimes(1);
      expect(store.getQuestionStats).not.toHaveBeenCalled();
    } finally {
      pending.resolve({ seen: 4, correct: 3 });
      await settle();
    }
  }, 1000);

  it.each(['reject', 'throw'])('keeps an accepted answer successful when recording statistics fails by %s', async (failure) => {
    const { answer, store } = setup();
    if (failure === 'reject') store.recordAnswerStat.mockRejectedValue(new Error('Stats unavailable'));
    else store.recordAnswerStat.mockImplementation(() => { throw new Error('Stats unavailable'); });
    const response = await answer();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ correct: true, score: 1, strikes: 0 });
    await settle();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('question stats update failed'));
  });

  it('finishes the game despite a pending statistics write', async () => {
    const { run, answer, store } = setup();
    run.strikes = 2;
    const pending = deferred();
    store.recordAnswerStat.mockReturnValue(pending.promise);
    try {
      const response = await answer('fake');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ correct: false, strikes: 3, gameOver: true, resultId: 'result01' });
      expect(store.finalizeResult).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve({ seen: 4, correct: 3 });
      await settle();
    }
  }, 1000);

  it('does not schedule statistics if saving the answer conflicts', async () => {
    const { answer, store } = setup();
    store.saveRun.mockRejectedValue(new ConflictError('Already answered'));
    expect((await answer()).status).toBe(409);
    await settle();
    expect(store.recordAnswerStat).not.toHaveBeenCalled();
  });
});

describe('optional percentage endpoint', () => {
  it('returns the aggregate percentage separately from grading', async () => {
    const { app, store, run } = setup();
    const response = await app.request(`/api/questions/${run.currentQid}/stats`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pctCorrect: 75 });
    expect(store.getQuestionStats).toHaveBeenCalledWith([run.currentQid], { abortSignal: expect.any(AbortSignal) });
    expect(store.recordAnswerStat).not.toHaveBeenCalled();
  });

  it('returns no percentage when statistics are unavailable', async () => {
    const { app, store, run } = setup();
    store.getQuestionStats.mockRejectedValue(new Error('Read failed'));
    const response = await app.request(`/api/questions/${run.currentQid}/stats`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pctCorrect: null });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('question stats read failed'));
  });

  it.each([undefined, { seen: 0, correct: 0 }])('returns no percentage before any observations', async (stat) => {
    const { app, store, run } = setup();
    store.getQuestionStats.mockResolvedValue(new Map([[run.currentQid, stat]]));
    expect(await (await app.request(`/api/questions/${run.currentQid}/stats`)).json()).toEqual({ pctCorrect: null });
  });

  it('rejects unknown question IDs without reading the database', async () => {
    const { app, store } = setup();
    expect((await app.request('/api/questions/unknown/stats')).status).toBe(404);
    expect(store.getQuestionStats).not.toHaveBeenCalled();
  });
});

describe('bounded background statistics', () => {
  it('drops updates at capacity and releases slots only when writes settle', async () => {
    const pending = deferred();
    const store = { recordAnswerStat: vi.fn(() => pending.promise) };
    const record = createQuestionStatsRecorder(store);
    for (let i = 0; i < 40; i++) record('q1', true);
    await settle();
    expect(store.recordAnswerStat).toHaveBeenCalledTimes(32);
    expect(console.warn).toHaveBeenCalledTimes(8);
    const options = store.recordAnswerStat.mock.calls[0][2];
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);

    pending.resolve({ seen: 32, correct: 32 });
    await settle();
    record('q2', false);
    await settle();
    expect(store.recordAnswerStat).toHaveBeenCalledTimes(33);
  });

  it('releases a slot after rejection and handles the failure', async () => {
    const store = { recordAnswerStat: vi.fn().mockRejectedValue(new Error('Throttled')) };
    const record = createQuestionStatsRecorder(store);
    record('q1', true);
    await settle();
    record('q2', false);
    await settle();
    expect(store.recordAnswerStat).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('aborts overdue writes and makes their capacity available again', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const store = {
      recordAnswerStat: vi.fn((_qid, _correct, { abortSignal }) => new Promise((resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      })),
    };
    const record = createQuestionStatsRecorder(store);
    for (let i = 0; i < 32; i++) record('q1', true);
    await settle();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(1000);
    controller.abort(new Error('Deadline exceeded'));
    await settle();
    expect(console.warn).toHaveBeenCalledTimes(32);

    store.recordAnswerStat.mockResolvedValue({ seen: 1, correct: 1 });
    record('q2', true);
    await settle();
    expect(store.recordAnswerStat).toHaveBeenCalledTimes(33);
  });

  it('passes abort signals through to DynamoDB for both writes and reads', async () => {
    const abortSignal = AbortSignal.abort();
    const send = vi.fn()
      .mockResolvedValueOnce({ Attributes: { seen: 1, correct: 1 } })
      .mockResolvedValueOnce({ Responses: { stats: [] } });
    const store = createStore({ doc: { send }, tableName: 'stats' });
    await store.recordAnswerStat('q1', true, { abortSignal });
    await store.getQuestionStats(['q1'], { abortSignal });
    for (const [, options] of send.mock.calls) expect(options.abortSignal).toBe(abortSignal);
  });
});
