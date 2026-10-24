// Detector health bookkeeping shared by NativeDetector (request/response) and StreamingDetector (pipelined).
// Rules (docs/ARCHITECTURE.md Detector): never 'ok' before a successful init; 3 consecutive failures -> 'failed';
// p95 of the last 20 round trips above 400 ms (with at least 10 samples) -> 'slow'.

import type { DetectorHealth } from './detector';

export const SLOW_P95_MS = 400;
export const CONSECUTIVE_ERRORS_FOR_FAILED = 3;
const LATENCY_WINDOW = 20;
const MIN_SAMPLES_FOR_SLOW = 10;

export class DetectorHealthTracker {
  private ready = false;
  private consecutiveErrors = 0;
  private latencies: number[] = [];

  setReady(ready: boolean): void {
    this.ready = ready;
    if (ready) {
      this.consecutiveErrors = 0;
      this.latencies = [];
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  recordError(): void {
    this.consecutiveErrors++;
  }

  recordSuccess(latencyMs: number): void {
    this.consecutiveErrors = 0;
    this.latencies.push(latencyMs);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  health(): DetectorHealth {
    if (!this.ready || this.consecutiveErrors >= CONSECUTIVE_ERRORS_FOR_FAILED) return 'failed';
    if (this.latencies.length >= MIN_SAMPLES_FOR_SLOW) {
      const s = [...this.latencies].sort((a, b) => a - b);
      if (s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]! > SLOW_P95_MS) return 'slow';
    }
    return 'ok';
  }
}
