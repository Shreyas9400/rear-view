// Camera health and frame-rate bookkeeping (docs/ARCHITECTURE.md CameraSource): permission denied -> 'denied';
// no frames for 1.5 s -> 'stalled'; track ended / device error -> 'error'. Pure and time-injected, so it is unit-testable.
// Unknown is never 'ok': before the first frame the state is 'error' (not running), never healthy by default.

import type { HealthFlags } from '../shared/types';

export type CameraState = HealthFlags['camera'];

export const STALL_MS = 1500;
const FPS_WINDOW = 30;

export type CameraFailure = 'denied' | 'error';

/** Map a getUserMedia / media error name to a health failure. */
export function classifyCameraError(name: string | undefined): CameraFailure {
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'denied' : 'error';
}

export class CameraHealth {
  private running = false;
  private failure: CameraFailure | null = null;
  private lastFrameMs: number | null = null;
  private startedMs = 0;
  private stamps: number[] = [];
  private restartsUsed = 0;

  constructor(private readonly stallMs: number = STALL_MS) {}

  onStart(nowMs: number): void {
    this.running = true;
    this.failure = null;
    this.startedMs = nowMs;
    this.lastFrameMs = null;
    this.stamps = [];
  }

  onFrame(nowMs: number): void {
    this.lastFrameMs = nowMs;
    this.stamps.push(nowMs);
    if (this.stamps.length > FPS_WINDOW) this.stamps.shift();
  }

  onFailure(kind: CameraFailure): void {
    this.running = false;
    this.failure = kind;
  }

  onStop(): void {
    this.running = false;
  }

  /** The track ended on its own (camera taken by another app, unplugged). One restart attempt is allowed per start. */
  canRestart(): boolean {
    if (this.restartsUsed >= 1) return false;
    this.restartsUsed++;
    return true;
  }

  resetRestarts(): void {
    this.restartsUsed = 0;
  }

  state(nowMs: number): CameraState {
    if (this.failure) return this.failure;
    if (!this.running) return 'error';
    const since = this.lastFrameMs ?? this.startedMs;
    return nowMs - since > this.stallMs ? 'stalled' : 'ok';
  }

  /** Frames per second over the last (up to) 30 emitted frames; 0 with fewer than 2. */
  fps(): number {
    const s = this.stamps;
    if (s.length < 2) return 0;
    const span = s[s.length - 1]! - s[0]!;
    return span > 0 ? ((s.length - 1) * 1000) / span : 0;
  }

  lastFrameAtMs(): number {
    return this.lastFrameMs ?? 0;
  }
}
