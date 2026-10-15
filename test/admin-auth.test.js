import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { authRoutes, requireAdmin, pkcePair } from '../admin/auth.js';
import { createHash } from 'node:crypto';

const cognito = { domain: 'https://auth.example.com', getClientId: async () => 'client-123' };
const fakeVerifier = { verify: async (t) => { if (t !== 'good') throw new Error('bad token'); return { email: 'a@b.c' }; } };

function makeApp({ verifier = fakeVerifier, fetchImpl } = {}) {
  const app = new Hono();
  app.route('/admin', authRoutes({ cognito, fetchImpl, originOf: () => 'https://admin.example.com' }));
  app.use('/admin', requireAdmin(verifier));
  app.use('/admin/*', requireAdmin(verifier));
  app.get('/admin', (c) => c.text(`hello ${c.get('admin').email}`));
  app.post('/admin/api/thing', (c) => c.json({ ok: true }));
  return app;
}

const cookieValue = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);

describe('pkcePair', () => {
  it('derives an S256 challenge', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('requireAdmin', () => {
  it('redirects HTML requests without a session to login', async () => {
    const res = await makeApp().request('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('returns 401 for API requests without a session', async () => {
    const res = await makeApp().request('/admin/api/thing', { method: 'POST', headers: { 'x-requested-with': 'aws-or-not' } });
    expect(res.status).toBe(401);
  });

  it('allows a valid session', async () => {
    const res = await makeApp().request('/admin', { headers: { cookie: 'session=good' } });
    expect(await res.text()).toBe('hello a@b.c');
  });

  it('requires the CSRF header on mutations', async () => {
    const app = makeApp();
    expect((await app.request('/admin/api/thing', { method: 'POST', headers: { cookie: 'session=good' } })).status).toBe(403);
    expect((await app.request('/admin/api/thing', { method: 'POST', headers: { cookie: 'session=good', 'x-requested-with': 'aws-or-not' } })).status).toBe(200);
  });
});

describe('login flow', () => {
  it('redirects to Cognito with PKCE and completes the callback', async () => {
    let tokenRequest;
    const fetchImpl = async (url, init) => {
      tokenRequest = { url: String(url), body: new URLSearchParams(init.body) };
      return new Response(JSON.stringify({ id_token: 'good', expires_in: 3600 }), { status: 200 });
    };
    const app = makeApp({ fetchImpl });

    const login = await app.request('/admin/login');
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get('location'));
    expect(authorize.origin + authorize.pathname).toBe('https://auth.example.com/oauth2/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('client-123');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://admin.example.com/admin/callback');
    const pkce = cookieValue(login, 'pkce');
    expect(login.headers.getSetCookie().find((c) => c.startsWith('pkce='))).toMatch(/HttpOnly.*Secure.*SameSite=Lax/i);

    const state = authorize.searchParams.get('state');
    const callback = await app.request(`/admin/callback?code=abc&state=${state}`, { headers: { cookie: `pkce=${pkce}` } });
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('http-equiv="refresh"');
    expect(tokenRequest.url).toBe('https://auth.example.com/oauth2/token');
    expect(tokenRequest.body.get('code_verifier')).toBe(pkce.split('.')[1]);
    const session = callback.headers.getSetCookie().find((c) => c.startsWith('session='));
    expect(session).toMatch(/^session=good;/);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Strict/i);
  });

  it('rejects a callback with a mismatched state', async () => {
    const res = await makeApp().request('/admin/callback?code=abc&state=evil', { headers: { cookie: 'pkce=good.verifier' } });
    expect(res.status).toBe(400);
  });

  it('logs out through Cognito', async () => {
    const res = await makeApp().request('/admin/logout');
    const target = new URL(res.headers.get('location'));
    expect(target.pathname).toBe('/logout');
    expect(target.searchParams.get('logout_uri')).toBe('https://admin.example.com/admin/signed-out');
  });
});

describe('real Cognito verifier', () => {
  it('enforces the admins group', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const userPoolId = 'us-east-1_test123';
    const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId: 'client-123', groups: 'admins' });
    verifier.cacheJwks({ keys: [jwk] });
    const sign = (groups) => new SignJWT({ token_use: 'id', 'cognito:groups': groups, email: 'a@b.c' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(`https://cognito-idp.us-east-1.amazonaws.com/${userPoolId}`)
      .setAudience('client-123')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const app = makeApp({ verifier });
    expect((await app.request('/admin', { headers: { cookie: `session=${await sign(['admins'])}` } })).status).toBe(200);
    expect((await app.request('/admin', { headers: { cookie: `session=${await sign(['readers'])}` } })).status).toBe(302);
  });
});
