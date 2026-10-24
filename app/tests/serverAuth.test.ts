import { describe, expect, it } from 'vitest';
import { authorizeIngest, authorizeViewer } from '../src/server/handshake';
import { AuthGuard, MessageRateLimiter, RATE } from '../src/server/rateLimit';
import {
  base64url,
  constantTimeEqual,
  generateToken,
  isAllowedOrigin,
  pairingUrl,
  SESSION_TTL_MS,
  SessionTokens,
  viewerOrigin,
} from '../src/server/tokens';
import { CLOSE, LIMITS } from '../src/shared/protocol';
import { seqRandom } from './helpers';

describe('tokens', () => {
  it('base64url matches RFC 4648 vectors without padding', () => {
    const b = (s: string) => base64url(new TextEncoder().encode(s));
    expect(b('')).toBe('');
    expect(b('f')).toBe('Zg');
    expect(b('fo')).toBe('Zm8');
    expect(b('foo')).toBe('Zm9v');
    expect(base64url(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
  });

  it('generates 22-character URL-safe tokens that differ per call', () => {
    const r = seqRandom();
    const a = generateToken(r);
    const b = generateToken(r);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });

  it('constantTimeEqual compares content and length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('verifies, expires after 12 h and revokes', () => {
    let now = 1000;
    const t = new SessionTokens(seqRandom(), () => now);
    const first = t.current();
    expect(t.verify(first)).toBe('ok');
    expect(t.verify('wrong')).toBe('bad');
    expect(t.verify(undefined)).toBe('bad');
    now += SESSION_TTL_MS;
    expect(t.verify(first)).toBe('ok');
    now += 1;
    expect(t.verify(first)).toBe('expired');
    expect(t.verify('wrong')).toBe('bad');

    const second = t.revoke();
    expect(second).not.toBe(first);
    expect(t.verify(first)).toBe('bad');
    expect(t.verify(second)).toBe('ok');
  });

  it('builds the origin and the QR URL with the token in the fragment only', () => {
    expect(viewerOrigin('192.168.43.1', 8080)).toBe('http://192.168.43.1:8080');
    expect(pairingUrl('192.168.43.1', 8080, 'TOK')).toBe('http://192.168.43.1:8080/#t=TOK');
    expect(isAllowedOrigin('http://192.168.43.1:8080', 'http://192.168.43.1:8080')).toBe(true);
    expect(isAllowedOrigin('http://192.168.43.1:8081', 'http://192.168.43.1:8080')).toBe(false);
    expect(isAllowedOrigin(null, 'http://x:1')).toBe(false);
    expect(isAllowedOrigin(undefined, 'http://x:1')).toBe(false);
  });
});

describe('rate limits', () => {
  it('locks out an IP after 5 failures in 60 s, then releases', () => {
    const g = new AuthGuard();
    for (let i = 0; i < 4; i++) expect(g.recordFailure('1.1.1.1', i * 1000)).toBe(false);
    expect(g.recordFailure('1.1.1.1', 5000)).toBe(true);
    expect(g.isLockedOut('1.1.1.1', 5001)).toBe(true);
    expect(g.isLockedOut('2.2.2.2', 5001)).toBe(false);
    expect(g.isLockedOut('1.1.1.1', 5000 + RATE.lockoutMs)).toBe(false);
  });

  it('ages failures out of the window', () => {
    const g = new AuthGuard();
    for (let i = 0; i < 4; i++) g.recordFailure('1.1.1.1', i);
    expect(g.recordFailure('1.1.1.1', 61_000)).toBe(false);
  });

  it('limits new connections to 10 per minute per IP', () => {
    const g = new AuthGuard();
    for (let i = 0; i < 10; i++) expect(g.allowConnect('1.1.1.1', i)).toBe(true);
    expect(g.allowConnect('1.1.1.1', 100)).toBe(false);
    expect(g.allowConnect('2.2.2.2', 100)).toBe(true);
    expect(g.allowConnect('1.1.1.1', 60_001)).toBe(true);
  });

  it('keeps tracked IP state bounded under an address sweep', () => {
    const g = new AuthGuard();
    for (let i = 0; i < 5000; i++) g.allowConnect(`10.0.${i >> 8}.${i & 255}`, i);
    expect(g.trackedIps()).toBeLessThanOrEqual(RATE.maxTrackedIps + 1);
  });

  it('closes a connection above 20 messages per second', () => {
    const m = new MessageRateLimiter();
    for (let i = 0; i < 20; i++) expect(m.allow(i)).toBe(true);
    expect(m.allow(500)).toBe(false);
    expect(m.allow(1100)).toBe(true);
  });
});

describe('handshake', () => {
  const origin = 'http://192.168.43.1:8080';
  const mk = (over: Partial<Parameters<typeof authorizeViewer>[0]> = {}) => {
    const tokens = new SessionTokens(seqRandom(), () => 0);
    return {
      guard: new AuthGuard(),
      tokens,
      allowedOrigin: origin,
      origin,
      remoteIp: '192.168.43.20',
      token: tokens.current(),
      viewerCount: 0,
      nowMs: 0,
      ...over,
    };
  };

  it('accepts a correct viewer', () => {
    expect(authorizeViewer(mk())).toEqual({ ok: true });
  });

  it('rejects a wrong or missing origin with 4403 before looking at the token', () => {
    const base = mk({ origin: 'http://evil.example' });
    expect(authorizeViewer(base)).toMatchObject({ ok: false, code: CLOSE.badOrigin });
    expect(authorizeViewer(mk({ origin: undefined }))).toMatchObject({ code: CLOSE.badOrigin });
    // a wrong origin must not consume failed-auth budget
    expect(base.guard.isLockedOut(base.remoteIp, 0)).toBe(false);
  });

  it('rejects a wrong token with 4401 and locks out on the 5th failure with 4429', () => {
    const base = mk({ token: 'nope' });
    for (let i = 0; i < 4; i++) expect(authorizeViewer(base)).toMatchObject({ code: CLOSE.badToken });
    expect(authorizeViewer(base)).toMatchObject({ code: CLOSE.rateLimited });
    // even the right token is refused while locked out
    expect(authorizeViewer({ ...base, token: base.tokens.current() })).toMatchObject({ code: CLOSE.rateLimited });
    // and works again afterwards
    expect(authorizeViewer({ ...base, token: base.tokens.current(), nowMs: RATE.lockoutMs + 10 })).toEqual({ ok: true });
  });

  it('rejects an expired session with 4411', () => {
    let now = 0;
    const tokens = new SessionTokens(seqRandom(), () => now);
    const base = mk({ tokens, token: tokens.current() });
    expect(authorizeViewer(base)).toEqual({ ok: true });
    now = SESSION_TTL_MS + 1;
    expect(authorizeViewer(base)).toMatchObject({ ok: false, code: CLOSE.expired });
  });

  it('rejects a revoked token with 4401', () => {
    const base = mk();
    const old = base.tokens.current();
    base.tokens.revoke();
    expect(authorizeViewer({ ...base, token: old })).toMatchObject({ code: CLOSE.badToken });
  });

  it('enforces the viewer limit', () => {
    expect(authorizeViewer(mk({ viewerCount: LIMITS.maxViewers }))).toMatchObject({ code: CLOSE.viewerLimit });
    expect(authorizeViewer(mk({ viewerCount: LIMITS.maxViewers - 1 }))).toEqual({ ok: true });
  });

  it('authorises ingest only with the ingest token and the app origin', () => {
    const i = { guard: new AuthGuard(), ingestToken: 'INGEST', allowedOrigin: 'https://localhost', origin: 'https://localhost', remoteIp: '127.0.0.1', token: 'INGEST', nowMs: 0 };
    expect(authorizeIngest(i)).toEqual({ ok: true });
    expect(authorizeIngest({ ...i, token: 'viewer-token' })).toMatchObject({ code: CLOSE.badToken });
    expect(authorizeIngest({ ...i, origin: 'http://localhost' })).toMatchObject({ code: CLOSE.badOrigin });
  });
});
