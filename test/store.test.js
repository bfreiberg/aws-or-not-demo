import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestStore } from './helpers/dynamo.js';
import { ConflictError, DEFAULT_CONFIG } from '../shared/db/store.js';

let ctx;
beforeAll(async () => { ctx = await createTestStore(); });
afterAll(async () => { await ctx.cleanup(); });

const run = (id, extra = {}) => ({
  id, mode: 'normal', handle: 'H', ipHash: 'ip', timerSeconds: null, score: 0, strikes: 0,
  questionNumber: 1, tier: 1, currentQid: 'q1', issuedAt: 1, usedQids: ['q1'], answers: [],
  finished: false, version: 0, createdAt: 1_700_000_000_000, ...extra,
});
const result = (id, score, createdAt, mode = 'normal') => ({
  id, handle: `H${id}`, mode, score, tier: 2, answers: [true, false], createdAt,
});

describe('runs', () => {
  it('round-trips a run', async () => {
    await ctx.store.putRun(run('run-a'));
    expect(await ctx.store.getRun('run-a')).toEqual(run('run-a'));
    expect(await ctx.store.getRun('missing')).toBeNull();
  });

  it('refuses to create a run twice', async () => {
    await ctx.store.putRun(run('run-b'));
    await expect(ctx.store.putRun(run('run-b'))).rejects.toBeInstanceOf(ConflictError);
  });

  it('saves with optimistic locking', async () => {
    await ctx.store.putRun(run('run-c'));
    const saved = await ctx.store.saveRun({ ...run('run-c'), score: 1 }, 0);
    expect(saved.version).toBe(1);
    expect((await ctx.store.getRun('run-c')).score).toBe(1);
    await expect(ctx.store.saveRun({ ...run('run-c'), score: 2 }, 0)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('question stats', () => {
  it('accumulates seen and correct counts', async () => {
    await ctx.store.recordAnswerStat('qs-1', true);
    const totals = await ctx.store.recordAnswerStat('qs-1', false);
    expect(totals).toEqual({ seen: 2, correct: 1 });
    const stats = await ctx.store.getQuestionStats(['qs-1', 'qs-none']);
    expect(stats.get('qs-1')).toEqual({ seen: 2, correct: 1 });
    expect(stats.has('qs-none')).toBe(false);
  });
});

describe('results and leaderboard', () => {
  it('orders by score descending, earliest first on ties, per mode', async () => {
    await ctx.store.putResult(result('lb000001', 5, 1000), { onLeaderboard: true });
    await ctx.store.putResult(result('lb000002', 9, 2000), { onLeaderboard: true });
    await ctx.store.putResult(result('lb000003', 9, 3000), { onLeaderboard: true });
    await ctx.store.putResult(result('lb000004', 7, 4000), { onLeaderboard: false });
    await ctx.store.putResult(result('lb000005', 50, 5000, 'hard'), { onLeaderboard: true });
    const board = await ctx.store.getLeaderboard('normal', 10);
    expect(board.map((r) => r.id)).toEqual(['lb000002', 'lb000003', 'lb000001']);
    expect(await ctx.store.getResult('lb000004')).toEqual(result('lb000004', 7, 4000));
  });

  it('removes an entry from the leaderboard but keeps the result', async () => {
    await ctx.store.putResult(result('rm000001', 30, 1000, 'hard'), { onLeaderboard: true });
    await ctx.store.removeFromLeaderboard('rm000001');
    const board = await ctx.store.getLeaderboard('hard', 10);
    expect(board.map((r) => r.id)).not.toContain('rm000001');
    expect(await ctx.store.getResult('rm000001')).not.toBeNull();
    await expect(ctx.store.removeFromLeaderboard('nope0000')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('daily stats', () => {
  it('aggregates per day and all-time', async () => {
    await ctx.store.recordGame({ day: '2026-10-14', mode: 'hard', score: 4, tier: 1 });
    await ctx.store.recordGame({ day: '2026-10-14', mode: 'hard', score: 12, tier: 3 });
    const rows = await ctx.store.getDays(['2026-10-14', 'ALL', '2026-10-13'], ['hard']);
    const today = rows.find((r) => r.day === '2026-10-14');
    expect(today).toEqual({ day: '2026-10-14', mode: 'hard', games: 2, totalScore: 16, tiers: [1, 0, 1, 0, 0, 0] });
    expect(rows.find((r) => r.day === 'ALL').games).toBe(2);
    expect(rows.find((r) => r.day === '2026-10-13')).toBeUndefined();
  });
});

describe('config', () => {
  it('defaults and updates', async () => {
    expect(await ctx.store.getConfig()).toEqual(DEFAULT_CONFIG);
    await ctx.store.putConfig({ hardTimerSeconds: 15 });
    expect(await ctx.store.getConfig()).toEqual({ hardTimerSeconds: 15 });
  });
});

describe('rate counter', () => {
  it('increments per ip hash and day', async () => {
    expect(await ctx.store.incrementRate('ip-x', '2026-10-14', Date.now())).toBe(1);
    expect(await ctx.store.incrementRate('ip-x', '2026-10-14', Date.now())).toBe(2);
    expect(await ctx.store.incrementRate('ip-x', '2026-10-15', Date.now())).toBe(1);
  });
});
