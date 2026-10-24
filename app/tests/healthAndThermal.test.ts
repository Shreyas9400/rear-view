import { describe, expect, it } from 'vitest';
import { HealthMonitor, type HealthProviders } from '../src/health/healthMonitor';
import { DEFAULT_THERMAL, ThermalEstimator } from '../src/health/thermalEstimator';
import { RollingWindow } from '../src/pipeline/rollingWindow';

describe('RollingWindow', () => {
  it('keeps only samples inside the window and computes median, p95 and rate', () => {
    const w = new RollingWindow(1000);
    for (let i = 0; i < 10; i++) w.add(i * 100, i + 1); // t = 0..900, v = 1..10
    expect(w.count(900)).toBe(10);
    expect(w.median(900)).toBe(6);
    expect(w.p95(900)).toBe(10);
    expect(w.ratePerSec(900)).toBeCloseTo(10, 6);
    expect(w.count(1450)).toBe(5); // samples older than t = 450 are gone
    expect(w.values(1450)).toEqual([6, 7, 8, 9, 10]);
    expect(w.count(5000)).toBe(0);
    expect(w.median(5000)).toBeNaN();
    expect(w.ratePerSec(5000)).toBe(0);
  });

  it('caps the number of samples', () => {
    const w = new RollingWindow(1e9, 5);
    for (let i = 0; i < 20; i++) w.add(i, i);
    expect(w.values(20)).toEqual([15, 16, 17, 18, 19]);
  });
});

describe('ThermalEstimator (inferred from model slowdown)', () => {
  const feed = (e: ThermalEstimator, t0: number, ms: number, n: number, stepMs = 200) => {
    let t = t0;
    for (let i = 0; i < n; i++, t += stepMs) e.onModelMs(t, ms);
    return t;
  };

  it('is unknown until it has enough samples, never ok by default', () => {
    const e = new ThermalEstimator();
    expect(e.state()).toBe('unknown');
    feed(e, 0, 90, DEFAULT_THERMAL.minSamples - 1);
    expect(e.state()).toBe('unknown');
    feed(e, 10_000, 90, 1);
    expect(e.state()).toBe('ok');
  });

  it('stays ok at the fast reference time and goes warm then hot as the model slows down', () => {
    const e = new ThermalEstimator();
    let t = feed(e, 0, 90, 40);
    expect(e.state()).toBe('ok');
    t = feed(e, t, 120, 80); // 1.33x
    expect(e.state()).toBe('warm');
    t = feed(e, t, 165, 100); // 1.83x: the measured slow state
    expect(e.state()).toBe('hot');
    expect(e.ratio(t)).toBeGreaterThan(1.5);
  });

  it('reports hot straight away when the phone starts in the slow state', () => {
    const e = new ThermalEstimator();
    feed(e, 0, 165, 40);
    expect(e.state()).toBe('hot'); // the reference (90 ms) stops a slow start from becoming its own baseline
  });

  it('uses hysteresis: it does not flap around a threshold', () => {
    const e = new ThermalEstimator();
    let t = feed(e, 0, 90, 40);
    t = feed(e, t, 140, 100); // 1.56x -> hot
    expect(e.state()).toBe('hot');
    t = feed(e, t, 128, 100); // 1.42x: below hotEnter but above hotExit -> still hot
    expect(e.state()).toBe('hot');
    t = feed(e, t, 120, 100); // 1.33x: below hotExit -> warm
    expect(e.state()).toBe('warm');
    t = feed(e, t, 106, 100); // 1.18x: above warmExit -> still warm
    expect(e.state()).toBe('warm');
    feed(e, t, 95, 100); // 1.06x -> ok
    expect(e.state()).toBe('ok');
  });

  it('learns a faster baseline if the phone runs faster than the reference', () => {
    const e = new ThermalEstimator();
    let t = feed(e, 0, 60, 80);
    expect(e.baselineMs()).toBe(60);
    t = feed(e, t, 90, 100); // 1.5x of the learned 60 ms -> hot, even though 90 ms equals the reference
    expect(e.state()).toBe('hot');
    expect(t).toBeGreaterThan(0);
  });

  it('ignores invalid samples and can be reset', () => {
    const e = new ThermalEstimator();
    e.onModelMs(0, NaN);
    e.onModelMs(1, -5);
    e.onModelMs(2, 0);
    expect(e.medianMs(3)).toBeNaN();
    feed(e, 0, 165, 40);
    expect(e.state()).toBe('hot');
    e.reset();
    expect(e.state()).toBe('unknown');
  });
});

describe('HealthMonitor', () => {
  function make(over: Partial<{ camera: 'ok' | 'stalled' | 'denied' | 'error'; det: 'ok' | 'slow' | 'failed'; last: number | null; started: number | null; thermal: 'ok' | 'warm' | 'hot' | 'unknown' }> = {}) {
    const s = { camera: 'ok' as const, det: 'ok' as const, last: 1000 as number | null, started: 0 as number | null, thermal: 'ok' as const, ...over };
    const p: HealthProviders = {
      cameraState: () => s.camera,
      detectorHealth: () => s.det,
      lastResultAtMs: () => s.last,
      startedAtMs: () => s.started,
      thermal: () => s.thermal,
    };
    return { s, mon: new HealthMonitor(p) };
  }

  it('all ok with fresh results; sensors default to off (logged only in the MVP)', () => {
    const { mon } = make();
    expect(mon.read(1500)).toEqual({ camera: 'ok', detector: 'ok', sensors: 'off', thermal: 'ok' });
  });

  it('never reports a detector ok when the pipeline is not running', () => {
    const { mon } = make({ started: null });
    expect(mon.read(0).detector).toBe('failed');
  });

  it('turns slow then failed when results stop arriving, although the detector reports no error', () => {
    const { mon } = make({ last: 1000 });
    expect(mon.read(2999).detector).toBe('ok');
    expect(mon.read(3001).detector).toBe('slow');
    expect(mon.read(6001).detector).toBe('failed');
  });

  it('gives the first result extra time after start, then fails if it never arrives', () => {
    const { mon } = make({ last: null, started: 0 });
    expect(mon.read(3999).detector).toBe('ok');
    expect(mon.read(4001).detector).toBe('slow');
    expect(mon.read(10_001).detector).toBe('failed');
  });

  it('passes through the detector wrapper health, camera state and thermal state', () => {
    expect(make({ det: 'failed' }).mon.read(1100).detector).toBe('failed');
    expect(make({ det: 'slow' }).mon.read(1100).detector).toBe('slow');
    expect(make({ camera: 'denied' }).mon.read(1100).camera).toBe('denied');
    expect(make({ camera: 'stalled' }).mon.read(1100).camera).toBe('stalled');
    expect(make({ thermal: 'hot' }).mon.read(1100).thermal).toBe('hot');
    expect(make({ thermal: 'unknown' }).mon.read(1100).thermal).toBe('unknown');
  });
});
