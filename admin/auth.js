import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { createHash, randomBytes } from 'node:crypto';

export const CSRF_HEADER = 'aws-or-not';

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authRoutes({ cognito, fetchImpl = fetch, originOf }) {
  const r = new Hono();
  const redirectUri = (c) => `${originOf(c)}/admin/callback`;

  r.get('/login', async (c) => {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString('base64url');
    setCookie(c, 'pkce', `${state}.${verifier}`, {
      httpOnly: true, secure: true, sameSite: 'Lax', path: '/admin/callback', maxAge: 600,
    });
    const url = new URL('/oauth2/authorize', cognito.domain);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: await cognito.getClientId(),
      redirect_uri: redirectUri(c),
      scope: 'openid email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return c.redirect(url.toString());
  });

  r.get('/callback', async (c) => {
    const [state, verifier] = (getCookie(c, 'pkce') ?? '').split('.');
    deleteCookie(c, 'pkce', { path: '/admin/callback', secure: true });
    const code = c.req.query('code');
    if (!state || !verifier || !code || state !== c.req.query('state')) return c.text('Login failed', 400);

    const res = await fetchImpl(new URL('/oauth2/token', cognito.domain), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: await cognito.getClientId(),
        code,
        redirect_uri: redirectUri(c),
        code_verifier: verifier,
      }).toString(),
    });
    if (!res.ok) return c.text('Login failed', 400);
    const { id_token: idToken, expires_in: expiresIn = 3600 } = await res.json();

    setCookie(c, 'session', idToken, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/admin', maxAge: expiresIn });
    // Meta refresh instead of a 302: browsers don't send a SameSite=Strict cookie on a redirect chain
    // that began on the Cognito domain, so a 302 would bounce straight back to login.
    return c.html(html`<!doctype html><meta http-equiv="refresh" content="0;url=/admin"><p>Signed in. <a href="/admin">Continue</a></p>`);
  });

  r.get('/logout', async (c) => {
    deleteCookie(c, 'session', { path: '/admin', secure: true });
    const url = new URL('/logout', cognito.domain);
    url.search = new URLSearchParams({ client_id: await cognito.getClientId(), logout_uri: `${originOf(c)}/admin/signed-out` }).toString();
    return c.redirect(url.toString());
  });

  r.get('/signed-out', (c) => c.html(html`<!doctype html><p>Signed out. <a href="/admin/login">Sign in again</a></p>`));

  return r;
}

export function requireAdmin(verifier) {
  return async (c, next) => {
    try {
      const token = getCookie(c, 'session');
      if (!token) throw new Error('no session');
      c.set('admin', await verifier.verify(token));
    } catch {
      return c.req.path.startsWith('/admin/api/') ? c.json({ error: 'unauthorized' }, 401) : c.redirect('/admin/login');
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-requested-with') !== CSRF_HEADER) {
      return c.json({ error: 'csrf' }, 403);
    }
    await next();
  };
}
