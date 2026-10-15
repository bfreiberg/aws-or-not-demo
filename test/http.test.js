import { describe, it, expect } from 'vitest';
import { makeOriginOf, clientIp, dayOf, makeHashIp, lazy } from '../shared/http.js';
import { createConfigCache } from '../shared/config-cache.js';

const ctx = (headers) => ({ req: { header: (name) => headers[name.toLowerCase()] } });
const edgeCtx = (headers) => ({
    get: (key) => (key === 'viaEdge' ? true : undefined),
    req: { header: (name) => headers[name.toLowerCase()] },
  });

describe('http helpers', () => {
  it('derives the public origin', () => {
    expect(makeOriginOf()(ctx({ host: 'abc.lambda-url.aws' }))).toBe('https://abc.lambda-url.aws');
    expect(makeOriginOf()(ctx({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
    expect(makeOriginOf('https://fixed.example')(ctx({ host: 'x' }))).toBe('https://fixed.example');
  });

  it('uses the rightmost x-forwarded-for entry', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }))).toBe('1.2.3.4');
    expect(clientIp(ctx({}))).toBe('unknown');
  });

  it('prefers x-viewer-ip (set by the CloudFront Function) when viaEdge is set', () => {
    expect(clientIp(edgeCtx({ 'x-viewer-ip': '198.51.100.7', 'cloudfront-viewer-address': '203.0.113.5:4321', 'x-forwarded-for': '6.6.6.6' }))).toBe('198.51.100.7');
  });

  it('ignores x-viewer-ip when viaEdge is not set', () => {
    expect(clientIp(ctx({ 'x-viewer-ip': '198.51.100.7', 'x-forwarded-for': '5.5.5.5' }))).toBe('5.5.5.5');
  });

  it('uses cloudfront-viewer-address when viaEdge is set', () => {

    // IPv4 with port
    expect(clientIp(edgeCtx({ 'cloudfront-viewer-address': '203.0.113.5:4321' }))).toBe('203.0.113.5');
    // Bracketed IPv6 with port
    expect(clientIp(edgeCtx({ 'cloudfront-viewer-address': '[2001:db8::1]:4321' }))).toBe('2001:db8::1');
    // Unbracketed IPv6 with port appended
    expect(clientIp(edgeCtx({ 'cloudfront-viewer-address': '2001:db8::1:4321' }))).toBe('2001:db8::1');
    // Falls back to XFF when cloudfront-viewer-address is missing
    expect(clientIp(edgeCtx({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }))).toBe('1.2.3.4');
  });

  it('ignores cloudfront-viewer-address when viaEdge is not set', () => {
    // viaEdge absent → XFF used even if cloudfront-viewer-address is present
    expect(clientIp(ctx({ 'cloudfront-viewer-address': '203.0.113.5:4321', 'x-forwarded-for': '5.5.5.5' }))).toBe('5.5.5.5');
  });

  it('formats days in UTC', () => {
    expect(dayOf(Date.UTC(2026, 9, 14, 23, 59))).toBe('2026-10-14');
  });

  it('hashes ips with a salt', () => {
    const a = makeHashIp('salt-a');
    expect(a('1.2.3.4')).toBe(a('1.2.3.4'));
    expect(a('1.2.3.4')).not.toBe(makeHashIp('salt-b')('1.2.3.4'));
    expect(a('1.2.3.4')).not.toContain('1.2.3.4');
  });

  it('lazy memoizes success and retries after failure', async () => {
    let calls = 0;
    const flaky = lazy(async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; });
    await expect(flaky()).rejects.toThrow('boom');
    expect(await flaky()).toBe('ok');
    expect(await flaky()).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('createConfigCache', () => {
  it('caches for ttl and reloads after', async () => {
    let t = 0;
    let loads = 0;
    const cache = createConfigCache(async () => ({ hardTimerSeconds: ++loads }), { ttlMs: 1000, now: () => t });
    expect((await cache.get()).hardTimerSeconds).toBe(1);
    t = 999;
    expect((await cache.get()).hardTimerSeconds).toBe(1);
    t = 1001;
    expect((await cache.get()).hardTimerSeconds).toBe(2);
  });
});
