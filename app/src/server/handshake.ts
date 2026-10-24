// Handshake decision (docs/PROTOCOL_SPEC.md §4): pure function from request facts to "accept" or a close code.
// Order: lockout -> origin -> token -> viewer limit. Failed tokens count toward the per-IP lockout.

import { CLOSE, LIMITS } from '../shared/protocol';
import type { AuthGuard } from './rateLimit';
import { constantTimeEqual, isAllowedOrigin, type SessionTokens } from './tokens';

export type HandshakeResult = { ok: true } | { ok: false; code: number; reason: string };

const fail = (code: number, reason: string): HandshakeResult => ({ ok: false, code, reason });

export interface ViewerHandshake {
  guard: AuthGuard;
  tokens: SessionTokens;
  allowedOrigin: string;
  origin: string | null | undefined;
  remoteIp: string;
  token: string;
  viewerCount: number;
  nowMs: number;
}

export function authorizeViewer(i: ViewerHandshake): HandshakeResult {
  if (i.guard.isLockedOut(i.remoteIp, i.nowMs)) return fail(CLOSE.rateLimited, 'locked out');
  if (!isAllowedOrigin(i.origin, i.allowedOrigin)) return fail(CLOSE.badOrigin, 'origin not allowed');
  const check = i.tokens.verify(i.token);
  if (check === 'bad') {
    const locked = i.guard.recordFailure(i.remoteIp, i.nowMs);
    return locked ? fail(CLOSE.rateLimited, 'locked out') : fail(CLOSE.badToken, 'invalid token');
  }
  if (check === 'expired') return fail(CLOSE.expired, 'session expired');
  if (i.viewerCount >= LIMITS.maxViewers) return fail(CLOSE.viewerLimit, 'viewer limit reached');
  return { ok: true };
}

export interface IngestHandshake {
  guard: AuthGuard;
  ingestToken: string;
  allowedOrigin: string;
  origin: string | null | undefined;
  remoteIp: string;
  token: string;
  nowMs: number;
}

/** A new authenticated ingest connection replaces the old one (old closed with CLOSE.ingestReplaced). */
export function authorizeIngest(i: IngestHandshake): HandshakeResult {
  if (i.guard.isLockedOut(i.remoteIp, i.nowMs)) return fail(CLOSE.rateLimited, 'locked out');
  if (!isAllowedOrigin(i.origin, i.allowedOrigin)) return fail(CLOSE.badOrigin, 'origin not allowed');
  if (!constantTimeEqual(i.token, i.ingestToken)) {
    const locked = i.guard.recordFailure(i.remoteIp, i.nowMs);
    return locked ? fail(CLOSE.rateLimited, 'locked out') : fail(CLOSE.badToken, 'invalid token');
  }
  return { ok: true };
}
