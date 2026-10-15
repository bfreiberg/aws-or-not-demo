import { createHmac } from 'node:crypto';

export function makeOriginOf(fixedOrigin) {
  return (c) => {
    if (fixedOrigin) return fixedOrigin;
    const host = c.req.header('host') ?? 'localhost';
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return `${local ? 'http' : 'https'}://${host}`;
  };
}

// The rightmost entry is the one appended by the platform's frontend; earlier entries are client-supplied.
export function clientIp(c) {
  // Trust edge-provided client addresses only when the request came through our verified CloudFront origin.
  // x-viewer-ip is set by the distribution's CloudFront Function; cloudfront-viewer-address is the fallback.
  if (c.get?.('viaEdge')) {
    const ip = c.req.header('x-viewer-ip');
    if (ip) return ip.trim();
    const addr = c.req.header('cloudfront-viewer-address');
    if (addr) return parseViewerAddress(addr);
  }
  const forwarded = c.req.header('x-forwarded-for');
  return forwarded ? forwarded.split(',').at(-1).trim() : 'unknown';
}

/**
 * Extracts the IP from a cloudfront-viewer-address value:
 *   - Bracketed IPv6:  [2001:db8::1]:4321  → 2001:db8::1
 *   - IPv4 with port:  203.0.113.5:4321    → 203.0.113.5
 *   - Unbracketed IPv6 with port: 2001:db8::1:4321  → 2001:db8::1
 *     (multiple colons → strip the last :port segment)
 */
function parseViewerAddress(addr) {
  if (addr.startsWith('[')) {
    const close = addr.indexOf(']');
    return close !== -1 ? addr.slice(1, close) : addr;
  }
  const colonCount = (addr.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    // IPv4:port — one colon separates address and port
    return addr.split(':')[0];
  }
  // Unbracketed IPv6 with appended :port — strip the last colon-segment
  return addr.slice(0, addr.lastIndexOf(':'));
}

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export const makeHashIp = (salt) => (ip) => createHmac('sha256', salt).update(ip).digest('base64url').slice(0, 22);

// Memoizes a successful async init; a failure is not cached, so the next call retries.
export function lazy(fn) {
  let promise;
  return () => {
    promise ??= fn().catch((err) => {
      promise = undefined;
      throw err;
    });
    return promise;
  };
}
