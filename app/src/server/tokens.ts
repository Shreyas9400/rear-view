// Token handling (docs/PROTOCOL_SPEC.md §4). Pure reference logic; the Kotlin plugin must mirror it.
// Tokens are never logged. JS comparison is only "best effort" constant-time; Kotlin uses MessageDigest.isEqual.

export type RandomBytes = (n: number) => Uint8Array;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 base64url without padding. 16 bytes -> 22 characters. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(bytes.length - i, 3) + 1;
    for (let c = 0; c < chars; c++) out += ALPHABET[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

export function generateToken(random: RandomBytes): string {
  return base64url(random(16));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type TokenCheck = 'ok' | 'bad' | 'expired';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // proposed

/** Viewer session token: created at start, regenerated on revoke, expires after the TTL. */
export class SessionTokens {
  private token: string;
  private issuedAtMs: number;

  constructor(
    private readonly random: RandomBytes,
    private readonly now: () => number,
    private readonly ttlMs: number = SESSION_TTL_MS,
  ) {
    this.token = generateToken(random);
    this.issuedAtMs = now();
  }

  current(): string {
    return this.token;
  }

  /** New token; callers must close all viewer sockets with CLOSE.revoked. */
  revoke(): string {
    this.token = generateToken(this.random);
    this.issuedAtMs = this.now();
    return this.token;
  }

  verify(candidate: unknown): TokenCheck {
    if (typeof candidate !== 'string' || !constantTimeEqual(candidate, this.token)) return 'bad';
    return this.now() - this.issuedAtMs > this.ttlMs ? 'expired' : 'ok';
  }
}

/** `http://<bound-ip>:<port>`, the only Origin accepted on /ws/view. */
export function viewerOrigin(ip: string, port: number): string {
  return `http://${ip}:${port}`;
}

/** Exact match; a missing Origin is rejected. */
export function isAllowedOrigin(origin: string | null | undefined, allowed: string): boolean {
  return typeof origin === 'string' && origin === allowed;
}

/** QR content: the token travels in the fragment, so it is never sent in an HTTP request. */
export function pairingUrl(ip: string, port: number, token: string): string {
  return `${viewerOrigin(ip, port)}/#t=${token}`;
}
