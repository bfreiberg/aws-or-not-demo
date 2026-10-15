import { timingSafeEqual } from 'node:crypto';

// Paths that bypass origin verification (CloudFront health checks use these too).
const OPEN_PATHS = new Set(['/api/health']);

/**
 * Returns Hono middleware that validates the `x-origin-verify` header against a secret.
 * - When `getSecret` is absent (local dev / tests without ORIGIN_SECRET_ID), the check is off.
 * - `/api/health` is always open.
 * - Missing or wrong header → 403.
 * - Secret load failure → 503 (fail closed).
 * - Verified requests: sets `c.set('viaEdge', true)` so clientIp can trust cloudfront-viewer-address.
 */
export function originVerify({ getSecret } = {}) {
  if (!getSecret) return (_c, next) => next();

  return async (c, next) => {
    if (OPEN_PATHS.has(c.req.path)) return next();

    let secret;
    try {
      secret = await getSecret();
    } catch {
      return c.json({ error: 'service_unavailable' }, 503);
    }

    const header = c.req.header('x-origin-verify');
    if (!header) return c.json({ error: 'forbidden' }, 403);

    // Constant-time compare; buffers must be equal length or timingSafeEqual throws.
    const secretBuf = Buffer.from(secret);
    const headerBuf = Buffer.from(header);
    if (secretBuf.length !== headerBuf.length || !timingSafeEqual(secretBuf, headerBuf)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    c.set('viaEdge', true);
    return next();
  };
}
