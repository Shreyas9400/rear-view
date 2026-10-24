// Latency-driven load controller (docs/TECHNICAL_DECISIONS.md D-029/D-031). It decides the minimum gap between frames handed to
// the detector, from what the pipeline measures: the frame-to-result latency p95, and the inferred thermal state.
//
//  * Latency: if the p95 exceeds the budget the gap is raised step by step (multiplicative increase) down to a floor rate; once the
//    p95 has stayed comfortably under the budget for a while the gap is lowered again (multiplicative decrease).
//  * Thermal: when the device looks throttled the rate is capped (warm: at most 6/s, hot: at most 4/s) because the paced run
//    showed a lower duty cycle keeps the CPU die 4 to 5 C cooler.
//  * Never below the floor rate: the approach heuristic needs about 3 detections per second. If the pipeline cannot deliver even
//    that, the right answer is for health to say so (the HealthMonitor does), not for the controller to go quieter.
//
// HONEST LIMITS: the thresholds are first guesses. Pacing did NOT prevent the thermal step on the test phone (D-029), and in the
// slow state with JPEG the p95 is about 300 ms against the 400 ms budget, so on that phone the controller should mostly sit idle
// and act as a safety net. Its effect has not been measured end to end. Pure; time is passed in.

import type { HealthFlags } from '../shared/types';
import { RollingWindow } from './rollingWindow';

export interface LoadConfig {
  /** p95 frame-to-result budget (ms). */
  budgetP95Ms: number;
  /** p95 below this counts as comfortable (ms). */
  reliefP95Ms: number;
  /** Fastest allowed feed: minimum gap between frames handed to the detector (ms). 125 = 8 per second. */
  minGapFloorMs: number;
  /** Slowest allowed feed: maximum gap (ms). 333 = 3 per second, the floor rate for the approach heuristic. */
  maxGapMs: number;
  warmGapMs: number;
  hotGapMs: number;
  /** How often the control law is evaluated, and how long latency must stay comfortable before the gap is lowered. */
  evalEveryMs: number;
  reliefHoldMs: number;
  raiseFactor: number;
  lowerFactor: number;
  /** Latency window and the number of samples needed before acting on it. */
  windowMs: number;
  minSamples: number;
}

export const DEFAULT_LOAD: LoadConfig = {
  budgetP95Ms: 400,
  reliefP95Ms: 280,
  minGapFloorMs: 125,
  maxGapMs: 333,
  warmGapMs: 167,
  hotGapMs: 250,
  evalEveryMs: 2000,
  reliefHoldMs: 10_000,
  raiseFactor: 1.25,
  lowerFactor: 0.85,
  windowMs: 10_000,
  minSamples: 8,
};

export interface LoadSnapshot {
  minGapMs: number;
  /** Rate cap implied by the gap, frames per second. */
  maxRatePerSec: number;
  latencyGapMs: number;
  thermalFloorMs: number;
  p95Ms: number;
  reason: 'idle' | 'latency high' | 'latency comfortable' | 'thermal cap' | 'floor rate reached';
}

export class LoadController {
  private readonly lat: RollingWindow;
  private latencyGap: number;
  private thermal: HealthFlags['thermal'] = 'unknown';
  private lastEvalAt = -Infinity;
  private comfortableSince: number | null = null;
  private reason: LoadSnapshot['reason'] = 'idle';

  constructor(private readonly cfg: LoadConfig = DEFAULT_LOAD) {
    this.lat = new RollingWindow(cfg.windowMs);
    this.latencyGap = cfg.minGapFloorMs;
  }

  reset(): void {
    this.lat.clear();
    this.latencyGap = this.cfg.minGapFloorMs;
    this.lastEvalAt = -Infinity;
    this.comfortableSince = null;
    this.reason = 'idle';
  }

  onResult(nowMs: number, latencyMs: number): void {
    if (Number.isFinite(latencyMs) && latencyMs >= 0) this.lat.add(nowMs, latencyMs);
  }

  setThermal(state: HealthFlags['thermal']): void {
    this.thermal = state;
  }

  /** Minimum gap between frames to hand over, evaluated lazily at most every evalEveryMs. */
  minGapMs(nowMs: number): number {
    if (nowMs - this.lastEvalAt >= this.cfg.evalEveryMs) {
      this.lastEvalAt = nowMs;
      this.evaluate(nowMs);
    }
    return this.effectiveGap();
  }

  snapshot(nowMs: number): LoadSnapshot {
    const gap = this.effectiveGap();
    return {
      minGapMs: gap,
      maxRatePerSec: 1000 / gap,
      latencyGapMs: this.latencyGap,
      thermalFloorMs: this.thermalFloor(),
      p95Ms: this.lat.p95(nowMs),
      reason: this.reason,
    };
  }

  private thermalFloor(): number {
    if (this.thermal === 'hot') return this.cfg.hotGapMs;
    if (this.thermal === 'warm') return this.cfg.warmGapMs;
    return this.cfg.minGapFloorMs;
  }

  private effectiveGap(): number {
    return Math.min(this.cfg.maxGapMs, Math.max(this.latencyGap, this.thermalFloor()));
  }

  private evaluate(nowMs: number): void {
    const c = this.cfg;
    const enough = this.lat.count(nowMs) >= c.minSamples;
    if (enough) {
      const p95 = this.lat.p95(nowMs);
      if (p95 > c.budgetP95Ms) {
        this.comfortableSince = null;
        if (this.latencyGap >= c.maxGapMs) {
          this.reason = 'floor rate reached';
        } else {
          this.latencyGap = Math.min(c.maxGapMs, this.latencyGap * c.raiseFactor);
          this.reason = 'latency high';
        }
        return;
      }
      if (p95 < c.reliefP95Ms) {
        this.comfortableSince ??= nowMs;
        if (nowMs - this.comfortableSince >= c.reliefHoldMs && this.latencyGap > c.minGapFloorMs) {
          this.latencyGap = Math.max(c.minGapFloorMs, this.latencyGap * c.lowerFactor);
          this.reason = 'latency comfortable';
          return;
        }
      } else {
        this.comfortableSince = null; // between relief and budget: hold
      }
    }
    if (this.thermalFloor() > this.latencyGap && this.thermalFloor() > c.minGapFloorMs) this.reason = 'thermal cap';
    else if (this.reason === 'thermal cap' || this.reason === 'latency comfortable' || this.reason === 'floor rate reached') this.reason = this.latencyGap > c.minGapFloorMs ? this.reason : 'idle';
  }
}
