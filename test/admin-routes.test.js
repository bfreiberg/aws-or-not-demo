import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestStore } from './helpers/dynamo.js';
import { createClock } from './helpers/clock.js';
import { questions } from './fixtures/questions.js';
import { createAdminApp } from '../admin/app.js';

let ctx;
let app;
const auth = { cookie: 'session=good', 'x-requested-with': 'aws-or-not', 'content-type': 'application/json' };

beforeAll(async () => {
  ctx = await createTestStore();
  await ctx.store.putResult({ id: 'ad000001', handle: 'Spot Yak #1', mode: 'normal', score: 9, tier: 2, answers: [], createdAt: 1 }, { onLeaderboard: true });
  await ctx.store.recordGame({ day: '2026-10-14', mode: 'normal', score: 9, tier: 2 });
  app = createAdminApp({
    store: ctx.store,
    questions,
    verifier: { verify: async (t) => { if (t !== 'good') throw new Error('bad'); return { email: 'admin@example.com' }; } },
    cognito: { domain: 'https://auth.example.com', getClientId: async () => 'client' },
    now: createClock(Date.UTC(2026, 9, 14, 12)).now,
    publicOrigin: 'https://admin.example.com',
  });
});
afterAll(async () => { await ctx.cleanup(); });

describe('admin routes', () => {
  it('redirects the root to /admin', async () => {
    expect((await app.request('/')).headers.get('location')).toBe('/admin');
  });

  it('protects the dashboard', async () => {
    expect((await app.request('/admin')).status).toBe(302);
  });

  it('renders the dashboard', async () => {
    const res = await app.request('/admin', { headers: { cookie: 'session=good' } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('admin@example.com');
    expect(body).toContain('Spot Yak #1');
    expect(body).toContain('data-remove="ad000001"');
    expect(body).toContain('Solutions Architect');
  });

  it('validates and saves the hard timer', async () => {
    for (const bad of [2, 61, 4.5, 'x']) {
      const res = await app.request('/admin/api/config', { method: 'POST', headers: auth, body: JSON.stringify({ hardTimerSeconds: bad }) });
      expect(res.status).toBe(400);
    }
    const ok = await app.request('/admin/api/config', { method: 'POST', headers: auth, body: JSON.stringify({ hardTimerSeconds: 15 }) });
    expect(ok.status).toBe(200);
    expect(await ctx.store.getConfig()).toEqual({ hardTimerSeconds: 15 });
    expect(await (await app.request('/admin/config', { headers: { cookie: 'session=good' } })).text()).toContain('value="15"');
  });

  it('removes a leaderboard entry', async () => {
    const res = await app.request('/admin/api/leaderboard/ad000001/remove', { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect((await ctx.store.getLeaderboard('normal', 10)).map((r) => r.id)).not.toContain('ad000001');
    expect((await app.request('/admin/api/leaderboard/zz000000/remove', { method: 'POST', headers: auth })).status).toBe(404);
  });

  it('returns 400 for malformed JSON on /admin/api/config', async () => {
    const res = await app.request('/admin/api/config', {
      method: 'POST',
      headers: { cookie: 'session=good', 'x-requested-with': 'aws-or-not', 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
  });
});
