import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestStore } from './helpers/dynamo.js';
import { createClock, counterId } from './helpers/clock.js';
import { questions } from './fixtures/questions.js';
import { createGameApp } from '../game/app.js';

let ctx;
let app;
const result = { id: 'pg000001', handle: 'Spot Yak #4242', mode: 'hard', score: 17, tier: 4, answers: [true, false], createdAt: 1 };

beforeAll(async () => {
  ctx = await createTestStore();
  await ctx.store.putResult(result, { onLeaderboard: true });
  const clock = createClock();
  app = createGameApp({
    store: ctx.store, questions, config: { get: async () => ({ hardTimerSeconds: 10 }) },
    now: clock.now, rng: () => 0, newRunId: counterId('run', 8), newResultId: counterId('pgr', 5),
    hashIp: (ip) => ip, generateHandle: () => 'H', assetDir: new URL('../game/assets/', import.meta.url),
    publicOrigin: 'https://example.com',
  });
});
afterAll(async () => { await ctx.cleanup(); });

describe('pages', () => {
  it('renders the landing page with leaderboards and a strict CSP', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Real AWS service, <span>or made up?</span>');
    expect(body).toContain('Real or made up?');
    expect(body).toContain('not affiliated with');
    expect(body).toContain('Spot Yak #4242');
    expect(body).toContain('Senior Solutions Architect');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('renders the play page for a mode, defaulting to normal', async () => {
    expect(await (await app.request('/play?mode=hard')).text()).toContain('data-mode="hard"');
    expect(await (await app.request('/play?mode=<script>')).text()).toContain('data-mode="normal"');
  });

  it('renders the leaderboard page', async () => {
    expect(await (await app.request('/leaderboard')).text()).toContain('Spot Yak #4242');
  });

  it('renders a result page with OG tags and share links', async () => {
    const res = await app.request(`/r/${result.id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<meta property="og:image" content="https://example.com/og/${result.id}.png">`);
    expect(body).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(body).toContain('<meta property="og:title" content="I just scored 17 on AWS or Not?">');
    expect(body).toContain('https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fexample.com%2Fr%2Fpg000001');
    expect(body).toContain('data-copy-image="/og/pg000001.png"');
    // The page shows the card without the baked-in CTA and links to the game instead.
    expect(body).toContain('<img class="card" src="/card/pg000001.png"');
    expect(body).toMatch(/<a class="btn primary big cta" href="\/">/);
    expect(body).toContain('Suspiciously good');
  });

  it('returns 404 for unknown or malformed result ids', async () => {
    expect((await app.request('/r/zzzzzzzz')).status).toBe(404);
    expect((await app.request('/r/../etc')).status).toBe(404);
    expect((await app.request('/og/zzzzzzzz.png')).status).toBe(404);
    expect((await app.request('/og/nope')).status).toBe(404);
  });

  it('serves the OG image as a cacheable PNG', async () => {
    const res = await app.request(`/og/${result.id}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.readUInt32BE(16)).toBe(1200);
  });

  it('serves the CTA-less card for the result page, and distinct bytes from the share card', async () => {
    const page = await app.request(`/card/${result.id}.png`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('image/png');
    const share = await app.request(`/og/${result.id}.png`);
    expect(Buffer.compare(Buffer.from(await page.arrayBuffer()), Buffer.from(await share.arrayBuffer()))).not.toBe(0);
    expect((await app.request('/card/zzzzzzzz.png')).status).toBe(404);
  });

  it('serves client scripts', async () => {
    const res = await app.request('/public/play.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('/api/runs');
  });
});
