import { describe, expect, it } from 'vitest';
import { compareDetections, iou, summarise, type Det } from '../src/selftest/detectionCompare';

const d = (classId: number, score: number, x: number, y: number, w = 0.1, h = 0.1): Det => ({ classId, score, x, y, w, h });

describe('iou', () => {
  it('is 1 for identical boxes, 0 for disjoint ones and handles overlap', () => {
    expect(iou(d(2, 1, 0, 0), d(2, 1, 0, 0))).toBeCloseTo(1, 9);
    expect(iou(d(2, 1, 0, 0), d(2, 1, 0.5, 0.5))).toBe(0);
    expect(iou(d(2, 1, 0, 0), d(2, 1, 0.05, 0))).toBeCloseTo(1 / 3, 6);
  });
});

describe('compareDetections', () => {
  const thr = 0.35;

  it('identical detections: everything matched, no loss, no gain', () => {
    const a = [d(2, 0.8, 0.1, 0.1), d(7, 0.5, 0.6, 0.6)];
    const c = compareDetections(a, a.map((x) => ({ ...x })), thr);
    expect(c).toMatchObject({ refKept: 2, testKept: 2, matchedKept: 2, lostBelowThreshold: 0, lostMissing: 0, gainedCrossedUp: 0, gainedNew: 0, sameKeptSet: true });
    expect(c.dScores).toEqual([0, 0]);
  });

  it('records score and box differences for matched pairs', () => {
    const c = compareDetections([d(2, 0.8, 0.1, 0.1)], [d(2, 0.75, 0.101, 0.1)], thr);
    expect(c.matchedKept).toBe(1);
    expect(c.dScores[0]).toBeCloseTo(0.05, 9);
    expect(c.ious[0]).toBeGreaterThan(0.95);
    expect(c.sameKeptSet).toBe(true);
  });

  it('a reference detection that falls below the threshold in the test is lost by the threshold', () => {
    const c = compareDetections([d(2, 0.4, 0.1, 0.1)], [d(2, 0.3, 0.1, 0.1)], thr);
    expect(c).toMatchObject({ refKept: 1, testKept: 0, matchedKept: 0, lostBelowThreshold: 1, lostMissing: 0, sameKeptSet: false });
  });

  it('a reference detection with no counterpart is lost outright', () => {
    const c = compareDetections([d(2, 0.9, 0.1, 0.1)], [], thr);
    expect(c).toMatchObject({ refKept: 1, lostMissing: 1, lostBelowThreshold: 0, sameKeptSet: false });
  });

  it('a sub-threshold reference detection pushed over the line is a crossing, not a new detection', () => {
    const c = compareDetections([d(2, 0.3, 0.1, 0.1)], [d(2, 0.4, 0.1, 0.1)], thr);
    expect(c).toMatchObject({ refKept: 0, testKept: 1, gainedCrossedUp: 1, gainedNew: 0, sameKeptSet: false });
  });

  it('a kept test detection with no reference at all is new', () => {
    const c = compareDetections([], [d(2, 0.6, 0.5, 0.5)], thr);
    expect(c).toMatchObject({ testKept: 1, gainedNew: 1, gainedCrossedUp: 0 });
  });

  it('does not match across classes or below the minimum IoU', () => {
    expect(compareDetections([d(2, 0.8, 0.1, 0.1)], [d(7, 0.8, 0.1, 0.1)], thr)).toMatchObject({ lostMissing: 1, gainedNew: 1 });
    expect(compareDetections([d(2, 0.8, 0.1, 0.1)], [d(2, 0.8, 0.18, 0.1)], thr)).toMatchObject({ lostMissing: 1, gainedNew: 1 });
  });

  it('each test detection is used at most once (greedy by reference score)', () => {
    const c = compareDetections([d(2, 0.9, 0.1, 0.1), d(2, 0.6, 0.102, 0.1)], [d(2, 0.85, 0.1, 0.1)], thr);
    expect(c.matchedKept).toBe(1);
    expect(c.lostMissing).toBe(1);
  });
});

describe('summarise', () => {
  it('adds up counts and computes score and IoU statistics', () => {
    const f1 = compareDetections([d(2, 0.8, 0.1, 0.1)], [d(2, 0.7, 0.1, 0.1)], 0.35);
    const f2 = compareDetections([d(2, 0.4, 0.1, 0.1)], [d(2, 0.3, 0.1, 0.1)], 0.35);
    const f3 = compareDetections([], [], 0.35);
    const s = summarise([f1, f2, f3]);
    expect(s).toMatchObject({ frames: 3, framesWithRef: 2, refKept: 2, testKept: 1, matchedKept: 1, lostBelowThreshold: 1, framesIdentical: 2 });
    expect(s.meanDScore).toBeCloseTo(0.1, 9);
    expect(s.maxDScore).toBeCloseTo(0.1, 9);
    expect(s.minIou).toBeCloseTo(1, 9);
  });

  it('handles no frames', () => {
    expect(summarise([])).toMatchObject({ frames: 0, refKept: 0 });
  });
});
