import { describe, expect, it } from 'vitest';
import { alertOverrides, closeHFromBox, EMPTY_CALIBRATION, EXIT_RATIO, parseCalibration } from '../src/core/calibration';
import { DEFAULT_K, estimateDistanceM, formatDistance, kFromSample } from '../src/core/distance';
import { AlertStateMachine, DEFAULT_ALERT } from '../src/core/alert';
import { OK, track } from './helpers';

describe('estimateDistanceM', () => {
  it('uses height * k / box height: a car filling 35% of the frame is about 5.6 m away with the default guess', () => {
    expect(estimateDistanceM('car', 0.35)).toBeCloseTo((1.5 * DEFAULT_K) / 0.35, 6);
    expect(estimateDistanceM('car', 0.35)!).toBeGreaterThan(5);
    expect(estimateDistanceM('car', 0.35)!).toBeLessThan(6);
  });
  it('doubles the distance for half the box, and a truck (3 m) reads twice as far as a car at the same box', () => {
    expect(estimateDistanceM('car', 0.2)! / estimateDistanceM('car', 0.4)!).toBeCloseTo(2, 6);
    expect(estimateDistanceM('truck', 0.3)! / estimateDistanceM('car', 0.3)!).toBeCloseTo(2, 6);
  });
  it('says nothing for tiny or invalid boxes', () => {
    expect(estimateDistanceM('car', 0.01)).toBeNull();
    expect(estimateDistanceM('car', NaN)).toBeNull();
    expect(estimateDistanceM('car', 0.3, 0)).toBeNull();
  });
});

describe('kFromSample', () => {
  it('turns a known distance into a scale, and the estimate then reproduces that distance', () => {
    const k = kFromSample('car', 0.5, 3)!; // a car at 3 m fills half the frame
    expect(k).toBeCloseTo((3 * 0.5) / 1.5, 6);
    expect(estimateDistanceM('car', 0.5, k)).toBeCloseTo(3, 6);
  });
  it('rejects implausible samples (box too small, absurd distance, k outside any real lens)', () => {
    expect(kFromSample('car', 0.02, 3)).toBeNull();
    expect(kFromSample('car', 0.5, 0.1)).toBeNull();
    expect(kFromSample('car', 0.5, 200)).toBeNull();
    expect(kFromSample('car', 0.9, 20)).toBeNull(); // k = 12
    expect(kFromSample('car', 1.2, 3)).toBeNull();
  });
});

describe('formatDistance', () => {
  it('always says "about", and never a false precision', () => {
    expect(formatDistance(4.23)).toBe('about 4.2 m');
    expect(formatDistance(12.4)).toBe('about 12 m');
    expect(formatDistance(0.6)).toBe('closer than 1 m');
    expect(formatDistance(null)).toBe('-');
  });
});

describe('calibration', () => {
  it('parses saved JSON defensively', () => {
    expect(parseCalibration(null)).toEqual(EMPTY_CALIBRATION);
    expect(parseCalibration('not json')).toEqual(EMPTY_CALIBRATION);
    expect(parseCalibration('{"k":1.1,"vehicleCloseH":0.5,"personCloseH":0.3}')).toEqual({ k: 1.1, vehicleCloseH: 0.5, personCloseH: 0.3 });
    expect(parseCalibration('{"k":99,"vehicleCloseH":0.01,"personCloseH":"x"}')).toEqual(EMPTY_CALIBRATION);
  });
  it('accepts only plausible close heights', () => {
    expect(closeHFromBox(0.4)).toBe(0.4);
    expect(closeHFromBox(0.05)).toBeNull();
    expect(closeHFromBox(0.99)).toBeNull();
  });
  it('turns a calibration into alert overrides with the exit height at 80 %, only for the values that were set', () => {
    expect(alertOverrides(EMPTY_CALIBRATION)).toEqual({});
    expect(alertOverrides({ k: null, vehicleCloseH: 0.5, personCloseH: null })).toEqual({ vehicleCloseH: 0.5, vehicleExitH: 0.5 * EXIT_RATIO });
    expect(alertOverrides({ k: 1, vehicleCloseH: null, personCloseH: 0.4 })).toEqual({ personCloseH: 0.4, personExitH: 0.4 * EXIT_RATIO });
  });
});

describe('AlertStateMachine.configure', () => {
  let t = 0;
  const next = (sm: AlertStateMachine, tracks: ReturnType<typeof track>[]) => sm.update({ tMs: (t += 200), tracks, approach: [], health: OK });
  const car = (h: number) => track({ id: 1, box: { x: 0.3, y: 0.2, w: h * 1.5, h } });

  it('moves the "very close" point live: a 0.5 car is only nearby until the point is lowered to 0.4', () => {
    const sm = new AlertStateMachine();
    sm.configure({ vehicleCloseH: 0.6, vehicleExitH: 0.48 });
    next(sm, [car(0.5)]);
    expect(next(sm, [car(0.5)]).level).toBe('VEHICLE_NEARBY');
    sm.configure({ vehicleCloseH: 0.4, vehicleExitH: 0.32 });
    next(sm, [car(0.5)]);
    expect(next(sm, [car(0.5)]).level).toBe('VEHICLE_CLOSE');
  });
  it('leaves everything else at the defaults and does not change the shared default object', () => {
    const sm = new AlertStateMachine();
    sm.configure({ vehicleCloseH: 0.9 });
    expect(DEFAULT_ALERT.vehicleCloseH).toBe(0.35);
  });
});
