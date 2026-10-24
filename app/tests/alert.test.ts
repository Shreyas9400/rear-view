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

describe('AlertStateMachine: people (D-036)', () => {
  const person = (id: number, h: number, over = {}) => track({ id, cls: 'person', box: { x: 0.4, y: 0.3, w: h / 2, h }, ...over });

  it('a person who is far or small does not raise PERSON_CLOSE, and does not count as a nearby vehicle', () => {
    const sm = new AlertStateMachine();
    for (let i = 0; i < 5; i++) {
      const s = next(sm, { tracks: [person(1, 0.15)] });
      expect(s.level).toBe('NORMAL');
      expect(s.reasons.join(' ')).toContain('1 person(s) tracked, not close');
    }
  });

  it('a close person raises PERSON_CLOSE after two updates and names the person track', () => {
    const sm = new AlertStateMachine();
    expect(next(sm, { tracks: [person(1, 0.4)] }).level).toBe('NORMAL');
    const s = next(sm, { tracks: [person(1, 0.4)] });
    expect(s.level).toBe('PERSON_CLOSE');
    expect(s.trackIds).toEqual([1]);
    expect(s.reasons[0]).toContain('person close');
  });

  it('ignores tentative persons, young tracks and low confidence', () => {
    const sm = new AlertStateMachine();
    for (const p of [person(1, 0.5, { state: 'tentative' }), person(2, 0.5, { ageFrames: 1 }), person(3, 0.5, { score: 0.4 })]) {
      next(sm, { tracks: [p] });
      expect(next(sm, { tracks: [p] }).level).toBe('NORMAL');
    }
  });

  it('keeps PERSON_CLOSE with hysteresis (stays down to the exit height) and leaves after four quiet updates', () => {
    const sm = new AlertStateMachine();
    next(sm, { tracks: [person(1, 0.4)] });
    expect(next(sm, { tracks: [person(1, 0.4)] }).level).toBe('PERSON_CLOSE');
    expect(next(sm, { tracks: [person(1, 0.26)] }).level).toBe('PERSON_CLOSE'); // below 0.30 but above the 0.24 exit height
    for (let i = 0; i < 3; i++) expect(next(sm, { tracks: [person(1, 0.1)] }).level).toBe('PERSON_CLOSE');
    expect(next(sm, { tracks: [person(1, 0.1)] }).level).toBe('NORMAL');
  });

  it('beats a vehicle approach but mentions it; vehicles alone behave as before; a growing person never triggers the vehicle approach', () => {
    const sm = new AlertStateMachine();
    const car = track({ id: 9 });
    const both = { tracks: [car, person(1, 0.4)], approach: [growing(9), growing(1)] };
    next(sm, both);
    next(sm, both);
    const s = next(sm, both);
    expect(s.level).toBe('PERSON_CLOSE');
    expect(s.reasons.join(' ')).toContain('vehicle is also growing');

    const sm2 = new AlertStateMachine();
    const walker = { tracks: [person(1, 0.2)], approach: [growing(1)] };
    for (let i = 0; i < 6; i++) expect(next(sm2, walker).level).toBe('NORMAL');
  });

  it('is UNAVAILABLE when health is bad, even with a close person, and forgets person state', () => {
    const sm = new AlertStateMachine();
    next(sm, { tracks: [person(1, 0.5)] });
    next(sm, { tracks: [person(1, 0.5)] });
    const bad = next(sm, { tracks: [person(1, 0.5)], health: { ...OK, detector: 'failed' } });
    expect(bad.level).toBe('UNAVAILABLE');
    expect(next(sm, { tracks: [person(1, 0.5)] }).level).toBe('NORMAL'); // starts counting again after the outage
  });
});
