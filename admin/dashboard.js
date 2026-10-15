import { RANKS } from '../shared/ranks.js';

export const MIN_SEEN = 20;
export const MODES = ['normal', 'hard'];

const sum = (rows, pick) => rows.reduce((n, row) => n + pick(row), 0);

export function buildDashboard({ days, today, week, stats, questions, leaderboards }) {
  const perMode = {};
  for (const mode of MODES) {
    const rows = days.filter((d) => d.mode === mode);
    const all = rows.find((d) => d.day === 'ALL') ?? { games: 0, totalScore: 0 };
    perMode[mode] = {
      today: sum(rows.filter((d) => d.day === today), (d) => d.games),
      week: sum(rows.filter((d) => week.includes(d.day)), (d) => d.games),
      allTime: all.games,
      avgScore: all.games ? Math.round((10 * all.totalScore) / all.games) / 10 : 0,
      best: leaderboards[mode][0]?.score ?? 0,
    };
  }

  const allTime = days.filter((d) => d.day === 'ALL');
  const rankDistribution = RANKS.map((rank, i) => ({ rank, count: sum(allTime, (d) => d.tiers[i]) }));

  const scored = questions
    .map((q) => ({ q, s: stats.get(q.id) }))
    .filter(({ s }) => s && s.seen >= MIN_SEEN)
    .map(({ q, s }) => ({ id: q.id, name: q.name, real: q.real, seen: s.seen, pct: Math.round((100 * s.correct) / s.seen) }))
    .sort((a, b) => a.pct - b.pct || b.seen - a.seen);

  return {
    perMode,
    rankDistribution,
    hardest: scored.slice(0, 10),
    easiest: scored.slice(-10).reverse(),
    leaderboards,
  };
}
