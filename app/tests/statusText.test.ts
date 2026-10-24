import { describe, expect, it } from 'vitest';
import type { PipelineSnapshot } from '../src/pipeline/pipeline';
import { DISCLAIMER, statusView } from '../src/ui/statusText';

const snap = (level: PipelineSnapshot['alert']['level'], over: Partial<PipelineSnapshot> = {}): PipelineSnapshot =>
  ({
    running: true,
    alert: { level, reasons: ['r1', 'r2'], trackIds: [], tMs: 0, health: { camera: 'ok', detector: 'ok', sensors: 'off', thermal: 'ok' } },
    tracks: [],
    detections: [],
    health: { camera: 'ok', detector: 'ok', sensors: 'off', thermal: 'ok' },
    detectionsPerSec: 5.6,
    latencyMs: { median: 262, p95: 300 },
    modelMs: { median: 163, baseline: 90 },
    load: { minGapMs: 125, maxRatePerSec: 8, latencyGapMs: 125, thermalFloorMs: 125, p95Ms: 300, reason: 'idle' },
    counters: {} as PipelineSnapshot['counters'],
    lastError: null,
    nowMs: 0,
    ...over,
  }) as PipelineSnapshot;

describe('statusView', () => {
  it('maps every level to its wording and tone', () => {
    expect(statusView(snap('NORMAL'))).toMatchObject({ headline: 'No tracked vehicle', tone: 'neutral' });
    expect(statusView(snap('VEHICLE_NEARBY')).tone).toBe('info');
    expect(statusView(snap('POSSIBLE_APPROACH'))).toMatchObject({ headline: 'Possible approach (experimental)', tone: 'warn' });
    expect(statusView(snap('UNAVAILABLE'))).toMatchObject({ headline: 'DETECTION UNAVAILABLE', tone: 'unavailable' });
  });

  it('never says clear or safe in any headline or detail line, and always carries the disclaimer', () => {
    for (const l of ['NORMAL', 'VEHICLE_NEARBY', 'POSSIBLE_APPROACH', 'UNAVAILABLE'] as const) {
      const v = statusView(snap(l));
      expect(v.headline.toLowerCase()).not.toMatch(/clear|safe/);
      expect(v.lines.join(' ').toLowerCase()).not.toMatch(/clear|safe/);
      expect(v.disclaimer).toBe(DISCLAIMER);
    }
  });

  it('labels thermal as inferred and shows errors', () => {
    const v = statusView(snap('NORMAL', { health: { camera: 'ok', detector: 'ok', sensors: 'off', thermal: 'hot' }, lastError: 'boom' }));
    expect(v.lines.join('\n')).toContain('throttled (inferred)');
    expect(v.lines.join('\n')).toContain('Last error: boom');
  });
});
