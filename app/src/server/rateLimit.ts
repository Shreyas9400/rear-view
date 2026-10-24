// Rate limits and lockout (docs/PROTOCOL_SPEC.md §13). Time is injected; state is bounded.

export const RATE = {
  failedAuthMax: 5,
  failedAuthWindowMs: 60_000,
  lockoutMs: 60_000,
  connectMax: 10,
  connectWindowMs: 60_000,
  messagesPerSecond: 20,
  maxTrackedIps: 256,
} as const;

/** Per remote IP: failed-auth lockout and new-connection throttling. */
export class AuthGuard {
  private failures = new Map<string, number[]>();
  private connects = new Map<string, number[]>();
  private lockedUntil = new Map<string, number>();

  isLockedOut(ip: string, nowMs: number): boolean {
    const until = this.lockedUntil.get(ip);
    if (until === undefined) return false;
    if (nowMs >= until) {
      this.lockedUntil.delete(ip);
      return false;
    }
    return true;
  }

  /** True if this connection attempt is allowed. Counts the attempt. */
  allowConnect(ip: string, nowMs: number): boolean {
    if (this.isLockedOut(ip, nowMs)) return false;
    const recent = this.prune(this.connects, ip, nowMs, RATE.connectWindowMs);
    if (recent.length >= RATE.connectMax) return false;
    recent.push(nowMs);
    return true;
  }

  /** Returns true if this failure caused (or occurred during) a lockout. */
  recordFailure(ip: string, nowMs: number): boolean {
    const recent = this.prune(this.failures, ip, nowMs, RATE.failedAuthWindowMs);
    recent.push(nowMs);
    if (recent.length >= RATE.failedAuthMax) {
      this.lockedUntil.set(ip, nowMs + RATE.lockoutMs);
      this.failures.delete(ip);
      return true;
    }
    return this.isLockedOut(ip, nowMs);
  }

  trackedIps(): number {
    return new Set([...this.failures.keys(), ...this.connects.keys(), ...this.lockedUntil.keys()]).size;
  }

  private prune(map: Map<string, number[]>, ip: string, nowMs: number, windowMs: number): number[] {
    if (map.size >= RATE.maxTrackedIps && !map.has(ip)) this.evict(nowMs);
    const kept = (map.get(ip) ?? []).filter((t) => nowMs - t < windowMs);
    map.set(ip, kept);
    return kept;
  }

  /** Drop expired entries; if still full, drop the oldest so memory stays bounded. */
  private evict(nowMs: number): void {
    for (const [ip, until] of this.lockedUntil) if (nowMs >= until) this.lockedUntil.delete(ip);
    for (const map of [this.failures, this.connects]) {
      for (const [ip, ts] of map) {
        if (ts.every((t) => nowMs - t >= 60_000)) map.delete(ip);
      }
      while (map.size >= RATE.maxTrackedIps) {
        const first = map.keys().next();
        if (first.done) break;
        map.delete(first.value);
      }
    }
  }
}

/** Per-connection inbound message limiter: at most `limit` messages in any 1 s window. */
export class MessageRateLimiter {
  private stamps: number[] = [];

  constructor(private readonly limit: number = RATE.messagesPerSecond) {}

  /** False means the connection should be closed with CLOSE.rateLimited. */
  allow(nowMs: number): boolean {
    this.stamps = this.stamps.filter((t) => nowMs - t < 1000);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(nowMs);
    return true;
  }
}
