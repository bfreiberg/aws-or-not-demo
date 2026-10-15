import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOriginOf } from '../shared/http.js';
import { originVerify } from '../shared/origin-verify.js';
import { authRoutes, requireAdmin } from './auth.js';
import { adminRoutes } from './routes.js';

const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
};

const publicRoot = relative(process.cwd(), fileURLToPath(new URL('./public', import.meta.url)));

export function createAdminApp({ store, questions, verifier, cognito, fetchImpl, now, publicOrigin, getOriginSecret }) {
  const app = new Hono();
  const originOf = makeOriginOf(publicOrigin);

  // Origin verification must run first so spoofed requests never reach any handler.
  app.use('*', originVerify({ getSecret: getOriginSecret }));
  app.use(secureHeaders({ contentSecurityPolicy: CSP, referrerPolicy: 'no-referrer' }));
  app.get('/', (c) => c.redirect('/admin'));
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  // Revalidate on every load (cheap with Last-Modified), so a deploy never leaves browsers on stale JS/CSS.
  app.use('/admin/public/*', async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set('Cache-Control', 'no-cache');
  });
  app.use('/admin/public/*', serveStatic({
    root: publicRoot,
    rewriteRequestPath: (p) => p.replace(/^\/admin\/public/, ''),
  }));
  app.use('/admin/api/*', bodyLimit({ maxSize: 2 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }));

  // Unauthenticated: login flow. Registered before the guard so it short-circuits.
  app.route('/admin', authRoutes({ cognito, fetchImpl, originOf }));

  const guard = requireAdmin(verifier);
  app.use('/admin/*', guard);
  app.route('/admin', adminRoutes({ store, questions, now }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: 'invalid' }, err.status);
    console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack, path: c.req.path }));
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
