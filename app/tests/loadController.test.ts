import { describe, expect, it } from 'vitest';
import { DEFAULT_LOAD, LoadController } from '../src/pipeline/loadController';

/** Feed `n` results of latency `lat` at 5 per second starting at t0; returns the end time. */
function feed(c: LoadController, t0: number, lat: number, n: number, stepMs = 200): number {
  let t = t0;
  for (let i = 0; i < n; i++, t += stepMs) c.onResult(t, lat);
  return t;
}

describe('LoadController', () => {
  it('starts at the fastest allowed feed and does nothing without enough samples', () => {
    const c = new LoadController();
    expect(c.minGapMs(0)).toBe(DEFAULT_LOAD.minGapFloorMs);
    feed(c, 0, 900, 3); // too few samples to act on
    expect(c.minGapMs(2500)).toBe(DEFAULT_LOAD.minGapFloorMs);
  });

  it('raises the gap step by step while the p95 latency is over budget, up to the floor rate, and then says so', () => {
    const c = new LoadController();
    let t = feed(c, 0, 500, 40); // p95 500 ms > 400 ms budget
    const gaps: number[] = [];
    for (let i = 0; i < 12; i++) {
      t += 2000;
      feed(c, t - 1800, 500, 10);
      gaps.push(c.minGapMs(t));
    }
    expect(gaps[0]).toBeCloseTo(125 * 1.25, 6);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
    expect(gaps[gaps.length - 1]).toBe(DEFAULT_LOAD.maxGapMs); // never slower than 3 per second
    expect(c.snapshot(t).reason).toBe('floor rate reached');
    expect(c.snapshot(t).maxRatePerSec).toBeCloseTo(3.003, 2);
  });

  it('lowers the gap again only after latency has been comfortable for the hold time', () => {
    const c = new LoadController();
    let t = feed(c, 0, 500, 40);
    for (let i = 0; i < 4; i++) {
      t += 2000;
      feed(c, t - 1800, 500, 10);
      c.minGapMs(t);
    }
    const raised = c.minGapMs(t + 2000);
    expect(raised).toBeGreaterThan(DEFAULT_LOAD.minGapFloorMs);

    // latency becomes comfortable (p95 250 ms)
    t += 2000;
    t = feed(c, t, 250, 60);
    let g = c.minGapMs(t + 2000);
    expect(g).toBe(raised); // not yet: the 10 s hold has not elapsed since latency became comfortable
    for (let i = 0; i < 12; i++) {
      t += 2000;
      t = feed(c, t, 250, 10);
      g = c.minGapMs(t);
    }
    expect(g).toBeLessThan(raised);
    expect(g).toBeGreaterThanOrEqual(DEFAULT_LOAD.minGapFloorMs);
  });

  it('holds the gap while the p95 is between the relief and budget levels', () => {
    const c = new LoadController();
    let t = feed(c, 0, 500, 40);
    t += 2000;
    feed(c, t - 1800, 500, 10);
    c.minGapMs(t);
    // let the 500 ms samples age out of the 10 s window while latency is now 340 ms (between relief and budget)
    for (let i = 0; i < 8; i++) {
      t += 2000;
      feed(c, t - 1800, 340, 10);
      c.minGapMs(t);
    }
    const settled = c.minGapMs(t);
    expect(settled).toBeGreaterThan(DEFAULT_LOAD.minGapFloorMs);
    let g = settled;
    for (let i = 0; i < 10; i++) {
      t += 2000;
      feed(c, t - 1800, 340, 10);
      g = c.minGapMs(t);
    }
    expect(g).toBe(settled); // neither raised (under budget) nor lowered (not comfortable)
  });

  it('caps the rate when the device looks throttled, and lifts the cap when it recovers', () => {
    const c = new LoadController();
    feed(c, 0, 250, 40);
    expect(c.minGapMs(10_000)).toBe(DEFAULT_LOAD.minGapFloorMs);
    c.setThermal('warm');
    expect(c.minGapMs(10_000)).toBe(DEFAULT_LOAD.warmGapMs);
    c.setThermal('hot');
    expect(c.minGapMs(10_000)).toBe(DEFAULT_LOAD.hotGapMs);
    expect(c.snapshot(10_000).maxRatePerSec).toBe(4);
    c.setThermal('unknown');
    expect(c.minGapMs(10_000)).toBe(DEFAULT_LOAD.minGapFloorMs);
    c.setThermal('ok');
    expect(c.minGapMs(10_000)).toBe(DEFAULT_LOAD.minGapFloorMs);
  });

  it('combines the two: the larger of the latency gap and the thermal floor, never beyond the floor rate', () => {
    const c = new LoadController();
    let t = feed(c, 0, 500, 40);
    c.setThermal('hot');
    for (let i = 0; i < 12; i++) {
      t += 2000;
      feed(c, t - 1800, 500, 10);
      c.minGapMs(t);
    }
    expect(c.minGapMs(t + 2000)).toBe(DEFAULT_LOAD.maxGapMs);
  });

  it('evaluates at most once per evaluation interval and ignores invalid latencies', () => {
    const c = new LoadController();
    feed(c, 0, 600, 40);
    const first = c.minGapMs(8000);
    expect(c.minGapMs(8500)).toBe(first); // same evaluation window: no second step
    c.onResult(9000, NaN);
    c.onResult(9000, -3);
    expect(c.minGapMs(8600)).toBe(first);
    c.reset();
    expect(c.minGapMs(0)).toBe(DEFAULT_LOAD.minGapFloorMs);
  });
});
