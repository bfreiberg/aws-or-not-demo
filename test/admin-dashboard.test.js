import { describe, it, expect } from 'vitest';
import { buildDashboard, MIN_SEEN } from '../admin/dashboard.js';

const questions = [
  { id: 'a', name: 'A', real: true },
  { id: 'b', name: 'B', real: false },
  { id: 'c', name: 'C', real: true },
];

describe('buildDashboard', () => {
  it('aggregates games, averages, ranks and question difficulty', () => {
    const days = [
      { day: '2026-10-14', mode: 'normal', games: 3, totalScore: 30, tiers: [1, 1, 1, 0, 0, 0] },
      { day: '2026-10-12', mode: 'normal', games: 2, totalScore: 10, tiers: [2, 0, 0, 0, 0, 0] },
      { day: 'ALL', mode: 'normal', games: 10, totalScore: 55, tiers: [5, 3, 2, 0, 0, 0] },
      { day: 'ALL', mode: 'hard', games: 4, totalScore: 40, tiers: [0, 1, 1, 1, 1, 0] },
    ];
    const stats = new Map([
      ['a', { seen: MIN_SEEN, correct: 19 }],
      ['b', { seen: 40, correct: 10 }],
      ['c', { seen: MIN_SEEN - 1, correct: 0 }],
    ]);
    const leaderboards = { normal: [{ id: 'x', score: 12 }], hard: [] };
    const d = buildDashboard({
      days, today: '2026-10-14', week: ['2026-10-14', '2026-10-13', '2026-10-12'], stats, questions, leaderboards,
    });
    expect(d.perMode.normal).toEqual({ today: 3, week: 5, allTime: 10, avgScore: 5.5, best: 12 });
    expect(d.perMode.hard).toEqual({ today: 0, week: 0, allTime: 4, avgScore: 10, best: 0 });
    expect(d.rankDistribution.map((r) => r.count)).toEqual([5, 4, 3, 1, 1, 0]);
    expect(d.rankDistribution[0].rank).toBe('Solutions Architect Intern');
    expect(d.hardest.map((q) => q.id)).toEqual(['b', 'a']);
    expect(d.hardest[0]).toEqual({ id: 'b', name: 'B', real: false, seen: 40, pct: 25 });
    expect(d.easiest.map((q) => q.id)).toEqual(['a', 'b']);
  });
});
