import { describe, expect, it } from 'vitest';
import { AlertStateMachine, DEFAULT_ALERT } from '../src/core/alert';
import type { ApproachEstimate, HealthFlags } from '../src/shared/types';
import { OK, track } from './helpers';

const growing = (id: number, growth = 0.3, confidence = 0.9): ApproachEstimate => ({ trackId: id, growthRatePerS: growth, ttcProxyS: 1 / growth, confidence });
const flat = (id: number): ApproachEstimate => ({ trackId: id, growthRatePerS: 0, ttcProxyS: null, confidence: 0.9 });

let t = 0;
const next = (sm: AlertStateMachine, o: { tracks?: ReturnType<typeof track>[]; approach?: ApproachEstimate[]; health?: HealthFlags }) =>
  sm.update({ tMs: (t += 200), tracks: o.tracks ?? [], approach: o.approach ?? [], health: o.health ?? OK });

describe('AlertStateMachine', () => {
  it('NORMAL with no tracks, VEHICLE_NEARBY with a confirmed track', () => {
    const sm = new AlertStateMachine();
    expect(next(sm, {}).level).toBe('NORMAL');
    expect(next(sm, { tracks: [track({ id: 1 })], approach: [flat(1)] }).level).toBe('VEHICLE_NEARBY');
  });

  it('tentative and lost tracks do not count as nearby', () => {
    const sm = new AlertStateMachine();
    const s = next(sm, { tracks: [track({ id: 1, state: 'tentative' }), track({ id: 2, state: 'lost' })] });
    expect(s.level).toBe('NORMAL');
  });

  it('enters POSSIBLE_APPROACH only after enterUpdates consecutive qualifying updates', () => {
    const sm = new AlertStateMachine();
    const o = { tracks: [track({ id: 1 })], approach: [growing(1)] };
    expect(next(sm, o).level).toBe('VEHICLE_NEARBY');
    expect(next(sm, o).level).toBe('VEHICLE_NEARBY');
    expect(next(sm, o).level).toBe('POSSIBLE_APPROACH');
  });

  it('a single non-qualifying update resets the consecutive count', () => {
    const sm = new AlertStateMachine();
    const g = { tracks: [track({ id: 1 })], approach: [growing(1)] };
    next(sm, g);
    next(sm, g);
    next(sm, { tracks: [track({ id: 1 })], approach: [flat(1)] });
    expect(next(sm, g).level).toBe('VEHICLE_NEARBY');
  });

  it('requires minimum confidence, growth and track age', () => {
    for (const [approach, age] of [
      [growing(1, 0.3, 0.2), 10],
      [growing(1, 0.05, 0.9), 10],
      [growing(1, 0.3, 0.9), DEFAULT_ALERT.minTrackAgeFrames - 1],
    ] as const) {
      const sm = new AlertStateMachine();
      let level = '';
      for (let i = 0; i < 6; i++) level = next(sm, { tracks: [track({ id: 1, ageFrames: age })], approach: [approach] }).level;
      expect(level).toBe('VEHICLE_NEARBY');
    }
  });

  it('hysteresis: stays in POSSIBLE_APPROACH for exitUpdates quiet updates, then drops', () => {
    const sm = new AlertStateMachine();
    const g = { tracks: [track({ id: 1 })], approach: [growing(1)] };
    for (let i = 0; i < 3; i++) next(sm, g);
    const quiet = { tracks: [track({ id: 1 })], approach: [flat(1)] };
    for (let i = 0; i < DEFAULT_ALERT.exitUpdates - 1; i++) expect(next(sm, quiet).level).toBe('POSSIBLE_APPROACH');
    expect(next(sm, quiet).level).toBe('VEHICLE_NEARBY');
  });

  it('health override: camera or detector not ok gives UNAVAILABLE even with approaching tracks', () => {
    const sm = new AlertStateMachine();
    const g = { tracks: [track({ id: 1 })], approach: [growing(1)] };
    for (let i = 0; i < 3; i++) next(sm, g);
    for (const health of [
      { ...OK, camera: 'stalled' },
      { ...OK, camera: 'denied' },
      { ...OK, detector: 'failed' },
      { ...OK, detector: 'slow' },
    ] as HealthFlags[]) {
      const s = next(sm, { ...g, health });
      expect(s.level).toBe('UNAVAILABLE');
      expect(s.trackIds).toEqual([]);
      expect(s.reasons.length).toBeGreaterThan(0);
    }
  });

  it('never reports NORMAL while unavailable', () => {
    const sm = new AlertStateMachine();
    expect(next(sm, { health: { ...OK, camera: 'error' } }).level).toBe('UNAVAILABLE');
  });

  it('sensor and thermal health do not block alerts in the MVP', () => {
    const sm = new AlertStateMachine();
    const s = next(sm, { tracks: [track({ id: 1 })], approach: [flat(1)], health: { ...OK, sensors: 'missing', thermal: 'unknown' } });
    expect(s.level).toBe('VEHICLE_NEARBY');
  });

  it('after recovery the approach must be re-established (counters were reset)', () => {
    const sm = new AlertStateMachine();
    const g = { tracks: [track({ id: 1 })], approach: [growing(1)] };
    for (let i = 0; i < 3; i++) next(sm, g);
    next(sm, { ...g, health: { ...OK, camera: 'stalled' } });
    expect(next(sm, g).level).toBe('VEHICLE_NEARBY');
  });
});
