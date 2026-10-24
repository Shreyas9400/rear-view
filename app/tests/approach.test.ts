import { describe, expect, it } from 'vitest';
import { ApproachEstimator, theilSen } from '../src/core/approach';
import { growingHistory, track } from './helpers';

const est = new ApproachEstimator();
const run = (history: ReturnType<typeof growingHistory>, state: 'confirmed' | 'tentative' = 'confirmed') =>
  est.update(history[history.length - 1]!.tMs, [track({ id: 1, state, history })]);

describe('theilSen', () => {
  it('recovers an exact line and ignores one outlier', () => {
    const t = [0, 1, 2, 3, 4, 5, 6];
    const y = t.map((x) => 2 * x + 1);
    expect(theilSen(t, y).slope).toBeCloseTo(2, 9);
    y[3] = 100;
    expect(theilSen(t, y).slope).toBeCloseTo(2, 9);
  });
});

describe('ApproachEstimator', () => {
  it('growing box: positive growth, TTC proxy about 1/growth, high confidence', () => {
    const [e] = run(growingHistory(0.3));
    expect(e!.growthRatePerS).toBeCloseTo(0.3, 3);
    expect(e!.ttcProxyS).toBeCloseTo(1 / 0.3, 1);
    expect(e!.confidence).toBeGreaterThan(0.7);
  });

  it('static box: growth about 0 and no TTC proxy', () => {
    const [e] = run(growingHistory(0));
    expect(Math.abs(e!.growthRatePerS)).toBeLessThan(1e-9);
    expect(e!.ttcProxyS).toBeNull();
  });

  it('shrinking box: negative growth and no TTC proxy', () => {
    const [e] = run(growingHistory(-0.3));
    expect(e!.growthRatePerS).toBeLessThan(-0.25);
    expect(e!.ttcProxyS).toBeNull();
  });

  it('is robust to a single outlier box', () => {
    const h = growingHistory(0.3);
    h[4] = { ...h[4]!, h: h[4]!.h * 2 };
    const [e] = run(h);
    expect(e!.growthRatePerS).toBeGreaterThan(0.2);
    expect(e!.growthRatePerS).toBeLessThan(0.4);
  });

  it('too few samples or too short a span gives zero confidence', () => {
    expect(run(growingHistory(0.3, 3))[0]!.confidence).toBe(0);
    expect(run(growingHistory(0.3, 6, 50))[0]!.confidence).toBe(0); // 250 ms span
  });

  it('only estimates confirmed tracks', () => {
    expect(run(growingHistory(0.3), 'tentative')).toHaveLength(0);
  });

  it('noisy history lowers confidence', () => {
    const clean = run(growingHistory(0.3))[0]!.confidence;
    const noisy = growingHistory(0.3).map((s, i) => ({ ...s, h: s.h * (i % 2 ? 1.25 : 0.8) }));
    expect(run(noisy)[0]!.confidence).toBeLessThan(clean);
  });

  it('works with uneven frame intervals', () => {
    const ts = [0, 130, 330, 480, 700, 850, 1100, 1250];
    const h = ts.map((tMs) => ({ tMs, cx: 0.5, cy: 0.5, h: 0.1 * Math.exp((0.3 * tMs) / 1000) }));
    expect(run(h)[0]!.growthRatePerS).toBeCloseTo(0.3, 3);
  });

  it('exposes only a trend, never a distance', () => {
    const [e] = run(growingHistory(0.3));
    expect(Object.keys(e!).sort()).toEqual(['confidence', 'growthRatePerS', 'trackId', 'ttcProxyS']);
  });
});
