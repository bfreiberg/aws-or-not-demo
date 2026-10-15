import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ConflictError } from '../shared/db/store.js';
import { dayOf } from '../shared/http.js';
import { buildDashboard, MODES } from './dashboard.js';
import { dashboardPage, configPage } from './views.js';

const DAY_MS = 86_400_000;
const invalid = (result, c) => (result.success ? undefined : c.json({ error: 'invalid' }, 400));

export function adminRoutes({ store, questions, now }) {
  const r = new Hono();
  const qids = questions.map((q) => q.id);

  r.get('/', async (c) => {
    const t = now();
    const week = Array.from({ length: 7 }, (_, i) => dayOf(t - i * DAY_MS));
    const [days, stats, normal, hard] = await Promise.all([
      store.getDays([...week, 'ALL'], MODES),
      store.getQuestionStats(qids),
      store.getLeaderboard('normal', 50),
      store.getLeaderboard('hard', 50),
    ]);
    const data = buildDashboard({ days, today: week[0], week, stats, questions, leaderboards: { normal, hard } });
    return c.html(dashboardPage(data, c.get('admin')));
  });

  r.get('/config', async (c) => c.html(configPage(await store.getConfig(), c.get('admin'))));

  r.post(
    '/api/config',
    zValidator('json', z.object({ hardTimerSeconds: z.number().int().min(3).max(60) }), invalid),
    async (c) => {
      const { hardTimerSeconds } = c.req.valid('json');
      await store.putConfig({ hardTimerSeconds });
      console.log(JSON.stringify({ level: 'info', message: 'config updated', hardTimerSeconds, by: c.get('admin')?.email }));
      return c.json({ ok: true });
    },
  );

  r.post(
    '/api/leaderboard/:id/remove',
    zValidator('param', z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8}$/) }), invalid),
    async (c) => {
      const { id } = c.req.valid('param');
      try {
        await store.removeFromLeaderboard(id);
      } catch (err) {
        if (err instanceof ConflictError) return c.json({ error: 'not_found' }, 404);
        throw err;
      }
      console.log(JSON.stringify({ level: 'info', message: 'leaderboard entry removed', id, by: c.get('admin')?.email }));
      return c.json({ ok: true });
    },
  );

  return r;
}
