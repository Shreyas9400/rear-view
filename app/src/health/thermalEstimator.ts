// health.thermal INFERRED from how much slower the model runs than its fast baseline (docs/TECHNICAL_DECISIONS.md D-029).
// The app has no temperature access: on the OnePlus 6T the OS caps CPU frequency and moves work to the slow cores under sustained
// load, and every stage then runs 1.5 to 1.8x slower (model 90 ms -> 165 ms). That slowdown is the signal. This is an estimate of
// "the device is thermally limited", NOT a temperature, and it can also be triggered by other load; it reports 'unknown' until it
// has enough samples, never 'ok' by default.

import type { HealthFlags } from '../shared/types';
import { RollingWindow } from '../pipeline/rollingWindow';

export type ThermalState = HealthFlags['thermal'];

export interface ThermalConfig {
  /** Model run time (ms) expected on this phone when NOT throttled. Measured on the OnePlus 6T with 2 threads: about 90 ms. */
  referenceModelMs: number;
  /** Window for the current model-time median. */
  windowMs: number;
  /** Samples needed before reporting anything but 'unknown'. */
  minSamples: number;
  /** Ratio (current median / baseline) to enter or leave 'warm' and 'hot'; the exit ratios are lower (hysteresis). */
  warmEnter: number;
  warmExit: number;
  hotEnter: number;
  hotExit: number;
  /** How often a median is recorded into the baseline history, and how long that history is kept. */
  baselineEveryMs: number;
  baselineKeepMs: number;
}

export const DEFAULT_THERMAL: ThermalConfig = {
  referenceModelMs: 90,
  windowMs: 15_000,
  minSamples: 15,
  warmEnter: 1.25,
  warmExit: 1.15,
  hotEnter: 1.5,
  hotExit: 1.35,
  baselineEveryMs: 5_000,
  baselineKeepMs: 10 * 60_000,
};

export class ThermalEstimator {
  private readonly recent: RollingWindow;
  private hist: { t: number; m: number }[] = [];
  private lastRecordedAt = -Infinity;
  private current: ThermalState = 'unknown';

  constructor(private readonly cfg: ThermalConfig = DEFAULT_THERMAL) {
    this.recent = new RollingWindow(cfg.windowMs);
  }

  reset(): void {
    this.recent.clear();
    this.hist = [];
    this.lastRecordedAt = -Infinity;
    this.current = 'unknown';
  }

  /** Feed the native model run time (ms) of each result. */
  onModelMs(nowMs: number, ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.recent.add(nowMs, ms);
    if (this.recent.count(nowMs) < this.cfg.minSamples) return;
    const m = this.recent.median(nowMs);
    if (nowMs - this.lastRecordedAt >= this.cfg.baselineEveryMs) {
      this.lastRecordedAt = nowMs;
      this.hist.push({ t: nowMs, m });
      const cut = nowMs - this.cfg.baselineKeepMs;
      this.hist = this.hist.filter((h) => h.t >= cut);
    }
    this.current = this.classify(m);
  }

  state(): ThermalState {
    return this.current;
  }

  /** Fast-state model time: the reference, or lower if this phone has been seen running faster in the last 10 minutes. */
  baselineMs(): number {
    return Math.min(this.cfg.referenceModelMs, ...this.hist.map((h) => h.m));
  }

  /** Current model-time median over the window (NaN when empty). */
  medianMs(nowMs: number): number {
    return this.recent.median(nowMs);
  }

  ratio(nowMs: number): number {
    return this.recent.median(nowMs) / this.baselineMs();
  }

  private classify(median: number): ThermalState {
    const r = median / this.baselineMs();
    const c = this.cfg;
    switch (this.current) {
      case 'hot':
        if (r >= c.hotExit) return 'hot';
        return r >= c.warmExit ? 'warm' : 'ok';
      case 'warm':
        if (r >= c.hotEnter) return 'hot';
        return r >= c.warmExit ? 'warm' : 'ok';
      default:
        if (r >= c.hotEnter) return 'hot';
        return r >= c.warmEnter ? 'warm' : 'ok';
    }
  }
}
