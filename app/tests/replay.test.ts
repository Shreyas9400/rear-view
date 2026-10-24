import { describe, expect, it } from 'vitest';
import { parseReplayFixture, runReplay, type ReplayFrame } from '../src/replay/replay';
import { det, OK } from './helpers';

/** 10 fps for `seconds`, one car whose box height follows h0 * exp(g * t). */
function carFrames(g: number, seconds = 4, h0 = 0.1): ReplayFrame[] {
  return Array.from({ length: seconds * 10 + 1 }, (_, i) => {
    const tMs = i * 100;
    return { tMs, detections: [det(0.5, 0.5, h0 * Math.exp((g * tMs) / 1000))] };
  });
}

describe('runReplay', () => {
  it('a steadily growing car produces exactly one approach episode', () => {
    const r = runReplay(carFrames(0.4));
    expect(r.summary.approachEpisodes).toBe(1);
    expect(r.summary.maxLevel).toBe('POSSIBLE_APPROACH');
    expect(r.summary.trackIdsSeen).toEqual([1]);
    expect(r.summary.transitions.map((t) => t.to)).toEqual(['VEHICLE_NEARBY', 'POSSIBLE_APPROACH']);
  });

  it('a static car never raises an approach indication', () => {
    const r = runReplay(carFrames(0));
    expect(r.summary.approachEpisodes).toBe(0);
    expect(r.summary.maxLevel).toBe('VEHICLE_NEARBY');
  });

  it('a shrinking (receding) car never raises an approach indication', () => {
    const r = runReplay(carFrames(-0.4, 4, 0.5));
    expect(r.summary.approachEpisodes).toBe(0);
  });

  it('no detections stays NORMAL ("no tracked vehicle")', () => {
    const frames = Array.from({ length: 20 }, (_, i) => ({ tMs: i * 100, detections: [] }));
    const r = runReplay(frames);
    expect(r.summary.maxLevel).toBe('NORMAL');
    expect(r.summary.transitions).toEqual([]);
  });

  it('a detector outage replays as UNAVAILABLE even while tracks exist, and is not counted as the max level', () => {
    const frames = carFrames(0.4).map((f, i) => (i >= 10 && i < 20 ? { ...f, health: { ...OK, detector: 'failed' as const } } : f));
    const r = runReplay(frames);
    expect(r.steps[12]!.level).toBe('UNAVAILABLE');
    expect(r.summary.msInLevel.UNAVAILABLE).toBe(1000);
    expect(r.summary.transitions.some((t) => t.to === 'UNAVAILABLE')).toBe(true);
  });

  it('is deterministic and does not mutate its input', () => {
    const frames = carFrames(0.4);
    const copy = JSON.parse(JSON.stringify(frames));
    const a = runReplay(frames);
    const b = runReplay(frames);
    expect(b).toEqual(a);
    expect(frames).toEqual(copy);
  });

  it('time in each level adds up to the covered duration', () => {
    const r = runReplay(carFrames(0.4));
    const total = Object.values(r.summary.msInLevel).reduce((a, b) => a + b, 0);
    expect(total).toBe(r.summary.durationMs);
  });

  it('keeps result steps free of track history', () => {
    const r = runReplay(carFrames(0.4));
    expect(r.steps.every((s) => s.tracks.every((t) => t.history.length === 0))).toBe(true);
  });
});

describe('parseReplayFixture', () => {
  const good = { tMs: 0, detections: [{ cls: 'car', score: 0.7, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] };

  it('accepts a valid fixture, with optional health', () => {
    const out = parseReplayFixture([good, { tMs: 100, detections: [], health: OK }]);
    expect(out).toHaveLength(2);
    expect(out[1]!.health).toEqual(OK);
  });

  it('fails loudly with the frame index', () => {
    const cases: [unknown, RegExp][] = [
      [{}, /array/],
      [[1], /frame 0: not an object/],
      [[{ tMs: 'x', detections: [] }], /frame 0: tMs/],
      [[good, { tMs: 0, detections: [] }], /frame 1: tMs must be strictly increasing/],
      [[{ tMs: 0 }], /frame 0: detections/],
      [[{ tMs: 0, detections: [{ ...good.detections[0], cls: 'boat' }] }], /frame 0 detection 0: unknown class/],
      [[{ tMs: 0, detections: [{ ...good.detections[0], score: 1.5 }] }], /score/],
      [[{ tMs: 0, detections: [{ ...good.detections[0], box: { x: 0.9, y: 0, w: 0.3, h: 0.1 } }] }], /exceeds frame/],
      [[{ tMs: 0, detections: [{ ...good.detections[0], box: { x: 0, y: 0, w: 0, h: 0.1 } }] }], /positive size/],
      [[{ tMs: 0, detections: [], health: { camera: 'ok' } }], /health/],
    ];
    for (const [input, re] of cases) expect(() => parseReplayFixture(input)).toThrow(re);
  });
});
