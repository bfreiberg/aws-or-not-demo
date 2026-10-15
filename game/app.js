import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originVerify } from '../shared/origin-verify.js';
import { apiRoutes } from './api.js';
import { pageRoutes } from './pages.js';
import { notFoundPage } from './views.js';

export const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  fontSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
};

// serveStatic resolves `root` against the working directory, which differs between local runs and the runtime.
const publicRoot = relative(process.cwd(), fileURLToPath(new URL('./public', import.meta.url)));

export function createGameApp(deps) {
  const { getOriginSecret } = deps ?? {};
  const app = new Hono();
  // Origin verification must run first so spoofed requests never reach any handler.
  app.use('*', originVerify({ getSecret: getOriginSecret }));
  app.use(secureHeaders({ contentSecurityPolicy: CSP, crossOriginResourcePolicy: 'cross-origin' }));
  // Revalidate on every load (cheap with Last-Modified), so a deploy never leaves browsers on stale JS/CSS.
  app.use('/public/*', async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set('Cache-Control', 'no-cache');
  });
  app.use('/public/*', serveStatic({
    root: publicRoot,
    rewriteRequestPath: (p) => p.replace(/^\/public/, ''),
  }));
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.use('/api/*', bodyLimit({ maxSize: 2 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }));
  app.route('/api', apiRoutes(deps));
  app.route('/', pageRoutes(deps));
  app.notFound((c) => c.html(notFoundPage(), 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: 'invalid' }, err.status);
    console.error(JSON.stringify({ level: 'error', message: err.message, stack: err.stack, path: c.req.path }));
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
