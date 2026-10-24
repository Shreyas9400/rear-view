// Pure helpers for the iPhone viewer page (docs/PROTOCOL_SPEC.md §9, §11). No DOM, so they run in Node tests.

/** Token from a URL fragment such as "#t=abc_DEF-123". Returns null unless it is 8..64 base64url characters. */
export function tokenFromHash(hash: string): string | null {
  const m = /^#(?:.*&)?t=([A-Za-z0-9_-]{8,64})(?:&.*)?$/.exec(hash);
  return m ? m[1]! : null;
}

/** Reconnect delay: 0.5 s, 1 s, 2 s, then 2 s, each +-20 % jitter (`rand` in [0,1)). */
export function reconnectDelayMs(attempt: number, rand: number): number {
  const base = [500, 1000, 2000][Math.min(attempt, 2)]!;
  return Math.round(base * (0.8 + 0.4 * rand));
}

/**
 * Rear-clock offset estimate from ping/pong: offset = serverTimeMs - (tSend + tRecv) / 2, using the sample with the smallest
 * round trip among the last `keep` samples (a small round trip bounds the error).
 */
export class ClockOffset {
  private samples: { rtt: number; offset: number }[] = [];

  constructor(private readonly keep = 10) {}

  add(tSendMs: number, tRecvMs: number, serverTimeMs: number): void {
    const rtt = tRecvMs - tSendMs;
    if (!Number.isFinite(rtt) || rtt < 0 || !Number.isFinite(serverTimeMs)) return;
    this.samples.push({ rtt, offset: serverTimeMs - (tSendMs + tRecvMs) / 2 });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  /** null until the first sample. */
  offsetMs(): number | null {
    if (!this.samples.length) return null;
    let best = this.samples[0]!;
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    return best.offset;
  }

  reset(): void {
    this.samples = [];
  }
}

/** Age of a frame on the viewer's corrected clock; null if the offset or capture time is unknown. */
export function frameAgeMs(viewerNowEpochMs: number, offsetMs: number | null, tCaptureEpochMs: number | null | undefined): number | null {
  if (offsetMs === null || typeof tCaptureEpochMs !== 'number' || !Number.isFinite(tCaptureEpochMs)) return null;
  return Math.max(0, viewerNowEpochMs + offsetMs - tCaptureEpochMs);
}

/** Close codes after which the viewer must stop reconnecting and ask for a new QR (PROTOCOL_SPEC §10/§11). */
export const NO_RECONNECT_CODES: readonly number[] = [4401, 4403, 4410, 4411];
export const shouldReconnect = (code: number | null): boolean => code === null || !NO_RECONNECT_CODES.includes(code);

/** Headline for a LIVE/DELAYED alert level. NORMAL is never worded as clear or safe. */
export function levelText(level: string): string {
  switch (level) {
    case 'POSSIBLE_APPROACH':
      return 'POSSIBLE APPROACH (experimental)';
    case 'VEHICLE_NEARBY':
      return 'Vehicle detected behind';
    case 'NORMAL':
      return 'No tracked vehicle';
    default:
      return 'DETECTION UNAVAILABLE';
  }
}

/** Box heights (fraction of the frame height) that map to the slowest and the fastest beeping. */
export const BEEP = { farH: 0.08, nearH: 0.45, slowMs: 1500, fastMs: 100 } as const;

/**
 * Gap between beeps for the nearest tracked vehicle, from the height of its box. This is a PROXY for closeness (a bigger box
 * means a closer or a larger vehicle), not a measured distance: far or small -> long gaps, close or large -> near-continuous.
 * Unknown height (null) gives a middle value.
 */
export function beepIntervalMs(boxH: number | null): number {
  if (boxH === null || !Number.isFinite(boxH)) return 600;
  const p = Math.min(1, Math.max(0, (boxH - BEEP.farH) / (BEEP.nearH - BEEP.farH)));
  return Math.round(BEEP.fastMs + (BEEP.slowMs - BEEP.fastMs) * Math.pow(1 - p, 1.5));
}

/** Length of one beep: half the gap, between 40 and 140 ms, so the fastest rate sounds almost continuous. */
export const beepLengthMs = (intervalMs: number): number => Math.round(Math.min(140, Math.max(40, intervalMs * 0.6)));

/** Height of the largest confirmed track (the nearest-looking vehicle), or null if there is none. */
export function nearestBoxH(tracks: { state: string; box: { h: number } }[]): number | null {
  let best: number | null = null;
  for (const t of tracks) if (t.state === 'confirmed' && (best === null || t.box.h > best)) best = t.box.h;
  return best;
}
