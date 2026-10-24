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

export type SideName = 'left' | 'center' | 'right';

/** Side as the viewer shows it: the camera sees backwards, so a mirror-style view flips left and right (like a rear-view mirror). */
export function displaySide(side: string | null | undefined, mirror: boolean): SideName | null {
  if (side !== 'left' && side !== 'right' && side !== 'center') return null;
  if (!mirror || side === 'center') return side;
  return side === 'left' ? 'right' : 'left';
}

/** Stereo pan for a beep (-1 left .. 1 right) so the sound also comes from the side of the vehicle or person. */
export const panFor = (side: SideName | null): number => (side === 'left' ? -0.8 : side === 'right' ? 0.8 : 0);

/** Headline for a LIVE/DELAYED alert level. NORMAL is never worded as clear or safe. `side` is the side as shown on screen. */
export function levelText(level: string, side?: SideName | null): string {
  const where = side === 'left' ? ' - from the LEFT' : side === 'right' ? ' - from the RIGHT' : side === 'center' ? ' - straight behind' : '';
  switch (level) {
    case 'POSSIBLE_APPROACH':
      return `POSSIBLE APPROACH (experimental)${where}`;
    case 'VEHICLE_CLOSE':
      return `VEHICLE VERY CLOSE (experimental)${side === 'left' ? ' - on the LEFT' : side === 'right' ? ' - on the RIGHT' : side === 'center' ? ' - straight behind' : ''}`;
    case 'PERSON_CLOSE':
      return `PERSON CLOSE BEHIND (experimental)${side === 'left' ? ' - on the LEFT' : side === 'right' ? ' - on the RIGHT' : ''}`;
    case 'VEHICLE_NEARBY':
      return `Vehicle detected behind${side === 'left' ? ' - on the left' : side === 'right' ? ' - on the right' : ''}`;
    case 'NORMAL':
      return 'No tracked vehicle';
    default:
      return 'DETECTION UNAVAILABLE';
  }
}

/** Which token to use: a fresh one from the link wins and is remembered; otherwise the remembered one; otherwise none. */
export function pickToken(hash: string, stored: string | null): { token: string | null; store: string | null } {
  const fromLink = tokenFromHash(hash);
  if (fromLink) return { token: fromLink, store: fromLink };
  const ok = stored !== null && /^[A-Za-z0-9_-]{8,64}$/.test(stored);
  return { token: ok ? stored : null, store: null };
}

/** After which close codes the remembered token must be forgotten (the rear phone no longer accepts it). */
export const FORGET_TOKEN_CODES: readonly number[] = [4401, 4410, 4411];

export interface BeepCurve {
  farH: number;
  nearH: number;
  slowMs: number;
  fastMs: number;
}

/** Box heights (fraction of the frame height) that map to the slowest and the fastest beeping, for vehicles. */
export const BEEP: BeepCurve = { farH: 0.08, nearH: 0.45, slowMs: 1500, fastMs: 100 };
/** For people (D-036): a person's box is taller for the same distance, and beeping starts only once the person counts as close. */
export const BEEP_PERSON: BeepCurve = { farH: 0.3, nearH: 0.75, slowMs: 800, fastMs: 100 };

/**
 * Gap between beeps for the nearest tracked vehicle, from the height of its box. This is a PROXY for closeness (a bigger box
 * means a closer or a larger vehicle), not a measured distance: far or small -> long gaps, close or large -> near-continuous.
 * Unknown height (null) gives a middle value.
 */
export function beepIntervalMs(boxH: number | null, curve: BeepCurve = BEEP): number {
  if (boxH === null || !Number.isFinite(boxH)) return 600;
  const p = Math.min(1, Math.max(0, (boxH - curve.farH) / (curve.nearH - curve.farH)));
  return Math.round(curve.fastMs + (curve.slowMs - curve.fastMs) * Math.pow(1 - p, 1.5));
}

/** Length of one beep: half the gap, between 40 and 140 ms, so the fastest rate sounds almost continuous. */
export const beepLengthMs = (intervalMs: number): number => Math.round(Math.min(140, Math.max(40, intervalMs * 0.6)));

/**
 * Height of the largest confirmed track of the wanted kind (the nearest-looking one), or null if there is none.
 * 'vehicle' = every class except person; 'person' = people only.
 */
export function nearestBoxH(tracks: { state: string; cls?: string; box: { h: number } }[], kind: 'vehicle' | 'person' = 'vehicle'): number | null {
  let best: number | null = null;
  for (const t of tracks) {
    if (t.state !== 'confirmed') continue;
    if ((t.cls === 'person') !== (kind === 'person')) continue;
    if (best === null || t.box.h > best) best = t.box.h;
  }
  return best;
}
