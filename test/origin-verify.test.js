import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { originVerify } from '../shared/origin-verify.js';

/**
 * Minimal test app that wires up originVerify then exposes:
 *   GET /api/health  → always open
 *   GET /protected   → requires origin header; returns { viaEdge } from context
 */
function makeApp(getSecret) {
  const app = new Hono();
  app.use('*', originVerify({ getSecret }));
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/protected', (c) => c.json({ viaEdge: c.get('viaEdge') ?? false }));
  return app;
}

describe('originVerify middleware', () => {
  describe('when getSecret is absent (local dev)', () => {
    const app = makeApp(undefined);

    it('lets all requests through without a header', async () => {
      const res = await app.request('/protected');
      expect(res.status).toBe(200);
    });

    it('does not set viaEdge', async () => {
      const res = await app.request('/protected');
      expect((await res.json()).viaEdge).toBe(false);
    });

    it('keeps /api/health open', async () => {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
    });
  });

  describe('when getSecret is provided', () => {
    const SECRET = 'super-secret-token';
    const app = makeApp(async () => SECRET);

    it('keeps /api/health open without the header', async () => {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
    });

    it('returns 403 when the header is missing', async () => {
      const res = await app.request('/protected');
      expect(res.status).toBe(403);
    });

    it('returns 403 when the header is wrong', async () => {
      const res = await app.request('/protected', {
        headers: { 'x-origin-verify': 'wrong-secret-value' },
      });
      expect(res.status).toBe(403);
    });

    it('returns 403 when the header has a different length (padding attack)', async () => {
      const res = await app.request('/protected', {
        headers: { 'x-origin-verify': SECRET + 'x' },
      });
      expect(res.status).toBe(403);
    });

    it('passes when the header matches the secret', async () => {
      const res = await app.request('/protected', {
        headers: { 'x-origin-verify': SECRET },
      });
      expect(res.status).toBe(200);
    });

    it('sets viaEdge on a verified request', async () => {
      const res = await app.request('/protected', {
        headers: { 'x-origin-verify': SECRET },
      });
      expect((await res.json()).viaEdge).toBe(true);
    });
  });

  describe('fail-closed: secret load failure', () => {
    const brokenApp = makeApp(async () => { throw new Error('SM unavailable'); });

    it('returns 503 when the secret cannot be loaded', async () => {
      const res = await brokenApp.request('/protected');
      expect(res.status).toBe(503);
    });

    it('still keeps /api/health open even when secret is unavailable', async () => {
      const res = await brokenApp.request('/api/health');
      expect(res.status).toBe(200);
    });
  });
});
