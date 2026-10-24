// Approach heuristic: robust slope of ln(box height) over a short window.
// For a vehicle approaching along the camera axis, apparent height ~ 1/distance, so
// d(ln h)/dt ~ closing speed / distance. This is a TREND only: it assumes roughly constant closing
// speed, motion along the camera axis and a non-rotating camera, and it is NOT a distance or a
// validated collision time (docs/TECHNICAL_DECISIONS.md D-010).

import type { ApproachEstimate, Track } from '../shared/types';

export interface ApproachConfig {
  windowMs: number;
  minSamples: number;
  minSpanMs: number;
  /** Growth below this (per second) gives no TTC proxy. */
  minGrowthForTtc: number;
}

export const DEFAULT_APPROACH: ApproachConfig = {
  windowMs: 1500,
  minSamples: 4,
  minSpanMs: 500,
  minGrowthForTtc: 0.01,
};

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const m = n >> 1;
  return n % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function theilSen(t: number[], y: number[]): { slope: number; intercept: number } {
  const slopes: number[] = [];
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      const dt = t[j]! - t[i]!;
      if (dt !== 0) slopes.push((y[j]! - y[i]!) / dt);
    }
  }
  const slope = median(slopes);
  const intercept = median(y.map((yi, i) => yi - slope * t[i]!));
  return { slope, intercept };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class ApproachEstimator {
  constructor(private readonly cfg: ApproachConfig = DEFAULT_APPROACH) {}

  update(tMs: number, tracks: Track[]): ApproachEstimate[] {
    const out: ApproachEstimate[] = [];
    for (const tr of tracks) {
      if (tr.state !== 'confirmed') continue;
      const samples = tr.history.filter((s) => s.tMs >= tMs - this.cfg.windowMs && s.h > 0);
      const span = samples.length > 1 ? samples[samples.length - 1]!.tMs - samples[0]!.tMs : 0;
      if (samples.length < this.cfg.minSamples || span < this.cfg.minSpanMs) {
        out.push({ trackId: tr.id, growthRatePerS: 0, ttcProxyS: null, confidence: 0 });
        continue;
      }
      const t0 = samples[0]!.tMs;
      const ts = samples.map((s) => (s.tMs - t0) / 1000);
      const ys = samples.map((s) => Math.log(s.h));
      const { slope, intercept } = theilSen(ts, ys);
      const mad = median(ys.map((y, i) => Math.abs(y - (intercept + slope * ts[i]!))));
      const confidence = clamp01(
        Math.min(1, samples.length / 8) * Math.min(1, span / 1000) * (1 - Math.min(1, mad / 0.15)),
      );
      out.push({
        trackId: tr.id,
        growthRatePerS: slope,
        ttcProxyS: slope > this.cfg.minGrowthForTtc ? 1 / slope : null,
        confidence,
      });
    }
    return out;
  }
}
