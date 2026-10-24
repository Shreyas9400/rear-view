// Pure view-model for the rear screen. Wording rules (CLAUDE.md): "no warning" must never read as "the road is clear", and an
// unavailable camera/detector must read as unavailable. Thermal is an INFERENCE from model slowdown, not a temperature.

import type { PipelineSnapshot } from '../pipeline/pipeline';

export type Tone = 'neutral' | 'info' | 'warn' | 'unavailable';

export interface StatusView {
  headline: string;
  tone: Tone;
  detail: string;
  disclaimer: string;
  lines: string[];
}

export const DISCLAIMER = 'Experimental research prototype - not a safety system. No warning does not mean the road is clear.';

const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '-');

export function statusView(s: PipelineSnapshot): StatusView {
  let headline: string;
  let tone: Tone;
  switch (s.alert.level) {
    case 'POSSIBLE_APPROACH':
      headline = 'Possible approach (experimental)';
      tone = 'warn';
      break;
    case 'PERSON_CLOSE':
      headline = 'Person close behind (experimental)';
      tone = 'warn';
      break;
    case 'VEHICLE_NEARBY':
      headline = 'Vehicle detected behind';
      tone = 'info';
      break;
    case 'NORMAL':
      headline = 'No tracked vehicle';
      tone = 'neutral';
      break;
    default:
      headline = 'DETECTION UNAVAILABLE';
      tone = 'unavailable';
  }
  const h = s.health;
  const thermal = h.thermal === 'unknown' ? 'unknown' : h.thermal === 'ok' ? 'normal speed' : h.thermal === 'warm' ? 'slowing (inferred)' : 'throttled (inferred)';
  const lines = [
    `Camera: ${h.camera}   Detector: ${h.detector}`,
    `Device speed: ${thermal}`,
    `Detections/s: ${f(s.detectionsPerSec, 1)}   Feed cap: ${f(s.load.maxRatePerSec, 1)}/s`,
    `Latency median/p95: ${f(s.latencyMs.median)} / ${f(s.latencyMs.p95)} ms`,
    `Model median: ${f(s.modelMs.median)} ms (baseline ${f(s.modelMs.baseline)})`,
  ];
  if (s.lastError) lines.push(`Last error: ${s.lastError}`);
  return { headline, tone, detail: s.alert.reasons.join('; '), disclaimer: DISCLAIMER, lines };
}
