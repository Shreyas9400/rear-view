import { describe, expect, it } from 'vitest';
import type { CapturedFrame } from '../src/capture/source';
import { ApproachEstimator } from '../src/core/approach';
import { AlertStateMachine } from '../src/core/alert';
import { IouTracker } from '../src/core/tracker';
import { ThermalEstimator } from '../src/health/thermalEstimator';
import type { DetectorHealth, DetectorInitConfig, DetectorResult } from '../src/inference/detector';
import type { NativeStreamError } from '../src/inference/streamingDetector';
import { LoadController } from '../src/pipeline/loadController';
import { RearViewPipeline, type CameraLike, type DetectorLike, type FeederLike } from '../src/pipeline/pipeline';
import type { Detection } from '../src/shared/types';
import type { FeederCounters } from '../src/stream/frameFeeder';

class Clock {
  t = 10_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

class FakeCamera implements CameraLike {
  cb: ((f: CapturedFrame) => void) | null = null;
  state: 'ok' | 'stalled' | 'denied' | 'error' = 'ok';
  started: { width: number; height: number; fps: number } | null = null;
  stopped = 0;
  failStart: Error | null = null;
  onFrame(cb: (f: CapturedFrame) => void) {
    this.cb = cb;
  }
  async start(o: { width: number; height: number; fps: number }) {
    if (this.failStart) throw this.failStart;
    this.started = o;
  }
  stop() {
    this.stopped++;
  }
  cameraState() {
    return this.state;
  }
  emit(f: CapturedFrame) {
    this.cb!(f);
  }
}

class FakeFeeder implements FeederLike {
  offered: CapturedFrame[] = [];
  busy = false;
  stops = 0;
  starts = 0;
  start() {
    this.starts++;
  }
  errCbs: ((e: { stage: 'pack' | 'post'; code?: string; message: string }) => void)[] = [];
  offer(f: CapturedFrame) {
    if (this.busy) {
      f.bitmap.close();
      return 'dropped' as const;
    }
    this.offered.push(f);
    return 'packing' as const;
  }
  counters(): FeederCounters {
    return { offered: this.offered.length, droppedBusy: 0, droppedStopped: 0, packed: 0, replacedWaiting: 0, posted: 0, skippedByDetector: 0, packErrors: 0, postErrors: 0 };
  }
  stop() {
    this.stops++;
  }
  onError(cb: (e: { stage: 'pack' | 'post'; code?: string; message: string }) => void) {
    this.errCbs.push(cb);
  }
}

class FakeDetector implements DetectorLike {
  inits: DetectorInitConfig[] = [];
  disposed = 0;
  healthValue: DetectorHealth = 'ok';
  resultCb: ((r: DetectorResult & { seq: number; tCaptureMs: number }) => void) | null = null;
  errorCb: ((e: NativeStreamError) => void) | null = null;
  async init(c: DetectorInitConfig) {
    this.inits.push(c);
  }
  onResult(cb: (r: DetectorResult & { seq: number; tCaptureMs: number }) => void) {
    this.resultCb = cb;
  }
  onError(cb: (e: NativeStreamError) => void) {
    this.errorCb = cb;
  }
  health() {
    return this.healthValue;
  }
  async dispose() {
    this.disposed++;
  }
  result(seq: number, tCaptureMs: number, detections: Detection[], inferMs = 90) {
    this.resultCb!({ seq, tCaptureMs, detections, preMs: 30, inferMs, postMs: 2, bridgeMs: 10 });
  }
}

const frame = (seq: number, tCaptureMs: number) => {
  let closed = 0;
  const f: CapturedFrame & { closed: () => number } = {
    seq,
    tCaptureMs,
    tCaptureEpochMs: 0,
    width: 1280,
    height: 720,
    bitmap: { close: () => void closed++ } as unknown as ImageBitmap,
    closed: () => closed,
  };
  return f;
};

/** A car whose box height grows by `g` per second, centred in the frame. */
const car = (tSec: number, g: number, h0 = 0.1): Detection => {
  const h = h0 * Math.exp(g * tSec);
  const w = h * 1.5;
  return { cls: 'car', score: 0.85, box: { x: 0.5 - w / 2, y: 0.5 - h / 2, w, h } };
};

function make(over: { previewHook?: (f: CapturedFrame) => void } = {}) {
  const clock = new Clock();
  const camera = new FakeCamera();
  const feeder = new FakeFeeder();
  const detector = new FakeDetector();
  const load = new LoadController();
  const thermal = new ThermalEstimator();
  const timers: { fn: () => void; ms: number }[] = [];
  const p = new RearViewPipeline({
    camera,
    feeder,
    detector,
    tracker: new IouTracker(),
    approach: new ApproachEstimator(),
    alert: new AlertStateMachine(),
    thermal,
    load,
    now: clock.now,
    setInterval: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearInterval: () => timers.splice(0, timers.length),
    previewHook: over.previewHook,
  });
  return { p, clock, camera, feeder, detector, load, thermal, timers, tick: () => timers.forEach((t) => t.fn()) };
}

/** Feed `n` growing-car results at 5 per second. */
function growingCar(h: ReturnType<typeof make>, n: number, g: number) {
  const t0 = h.clock.t;
  for (let i = 0; i < n; i++) {
    h.clock.advance(200);
    h.detector.result(i + 1, h.clock.t, [car((h.clock.t - t0) / 1000, g)]);
  }
}

describe('RearViewPipeline lifecycle', () => {
  it('is UNAVAILABLE before it runs, never NORMAL', () => {
    const h = make();
    const s = h.p.snapshot();
    expect(s.running).toBe(false);
    expect(s.alert.level).toBe('UNAVAILABLE');
    expect(s.health.detector).toBe('failed');
  });

  it('start initialises the native detector (2 threads, 0.35) and opens the camera at 1280x720 15 fps', async () => {
    const h = make();
    await h.p.start();
    expect(h.detector.inits).toEqual([{ accelerator: 'native-cpu', threads: 2, scoreThr: 0.35, nmsIou: 0.45 }]);
    expect(h.camera.started).toEqual({ width: 1280, height: 720, fps: 15 });
    expect(h.p.isRunning()).toBe(true);
    expect(h.timers).toHaveLength(1);
  });

  it('a failing camera start is reported, cleans up, and leaves the pipeline stopped', async () => {
    const h = make();
    h.camera.failStart = Object.assign(new Error('NotAllowedError: denied'), { name: 'NotAllowedError' });
    await expect(h.p.start()).rejects.toThrow('denied');
    expect(h.p.isRunning()).toBe(false);
    expect(h.detector.disposed).toBe(1);
    expect(h.p.snapshot().lastError).toContain('start failed');
    expect(h.p.snapshot().alert.level).toBe('UNAVAILABLE');
  });

  it('stop shuts everything down, closes later frames and ends UNAVAILABLE', async () => {
    const h = make();
    await h.p.start();
    await h.p.stop();
    expect(h.camera.stopped).toBeGreaterThanOrEqual(1);
    expect(h.feeder.stops).toBe(1);
    expect(h.detector.disposed).toBe(1);
    const f = frame(1, h.clock.t);
    h.camera.emit(f);
    expect(f.closed()).toBe(1);
    expect(h.feeder.offered).toHaveLength(0);
    expect(h.p.snapshot().alert.level).toBe('UNAVAILABLE');
    expect(h.p.isRunning()).toBe(false);
  });
});

describe('RearViewPipeline restart', () => {
  it('start after stop resumes the feeder, clears old state and works again', async () => {
    const h = make();
    await h.p.start();
    growingCar(h, 10, 0);
    await h.p.stop();
    await h.p.start();
    expect(h.feeder.starts).toBe(2);
    expect(h.p.isRunning()).toBe(true);
    expect(h.p.snapshot().counters.results).toBe(0);
    h.clock.advance(200);
    h.detector.result(1, h.clock.t, []);
    expect(h.p.snapshot().counters.results).toBe(1);
  });
});

describe('RearViewPipeline frame gating', () => {
  it('hands frames to the feeder and paces them by the load controller gap; paced frames are closed', async () => {
    const h = make();
    await h.p.start();
    const f1 = frame(1, h.clock.t);
    h.camera.emit(f1);
    expect(h.feeder.offered).toHaveLength(1);
    h.clock.advance(60); // gap is 125 ms at the start: too soon
    const f2 = frame(2, h.clock.t);
    h.camera.emit(f2);
    expect(f2.closed()).toBe(1);
    expect(h.feeder.offered).toHaveLength(1);
    h.clock.advance(80); // 140 ms since the accepted frame
    h.camera.emit(frame(3, h.clock.t));
    expect(h.feeder.offered).toHaveLength(2);
    expect(h.p.snapshot().counters).toMatchObject({ frames: 3, paced: 1 });
  });

  it('a frame the feeder drops does not count as accepted, so the next frame is not paced away', async () => {
    const h = make();
    await h.p.start();
    h.feeder.busy = true;
    const f1 = frame(1, h.clock.t);
    h.camera.emit(f1);
    expect(f1.closed()).toBe(1);
    h.clock.advance(10);
    h.feeder.busy = false;
    h.camera.emit(frame(2, h.clock.t));
    expect(h.feeder.offered).toHaveLength(1);
  });

  it('calls the preview hook before handing over, at most every 200 ms, and survives a throwing hook', async () => {
    const seen: number[] = [];
    let boom = false;
    const h = make({
      previewHook: (f) => {
        seen.push(f.seq);
        if (boom) throw new Error('canvas gone');
      },
    });
    await h.p.start();
    h.camera.emit(frame(1, h.clock.t));
    h.clock.advance(130);
    h.camera.emit(frame(2, h.clock.t)); // accepted, but the preview is not due yet
    h.clock.advance(130);
    boom = true;
    h.camera.emit(frame(3, h.clock.t));
    expect(seen).toEqual([1, 3]);
    expect(h.feeder.offered.map((f) => f.seq)).toEqual([1, 2, 3]); // detection continued despite the failing hook
  });
});

describe('RearViewPipeline results to alert', () => {
  it('a vehicle that keeps growing goes NORMAL -> VEHICLE_NEARBY -> POSSIBLE_APPROACH -> VEHICLE_CLOSE, with fresh health throughout', async () => {
    const h = make();
    await h.p.start();
    const levels: string[] = [];
    h.p.onUpdate((s) => levels.push(s.alert.level));
    growingCar(h, 35, 0.4);
    const s = h.p.snapshot();
    expect(s.alert.level).toBe('VEHICLE_CLOSE'); // by the end it fills the frame
    expect(s.tracks.some((t) => t.state === 'confirmed')).toBe(true);
    expect(s.detections).toHaveLength(1);
    expect(s.health).toMatchObject({ camera: 'ok', detector: 'ok' });
    expect(levels).toContain('VEHICLE_NEARBY');
    expect(levels.indexOf('VEHICLE_NEARBY')).toBeLessThan(levels.indexOf('POSSIBLE_APPROACH'));
    expect(levels.indexOf('POSSIBLE_APPROACH')).toBeLessThan(levels.indexOf('VEHICLE_CLOSE'));
    expect(s.counters.results).toBe(35);
    expect(s.detectionsPerSec).toBeGreaterThan(4);
  });

  it('a static vehicle never raises POSSIBLE_APPROACH; nothing in view reads "no tracked vehicle", not unavailable', async () => {
    const h = make();
    await h.p.start();
    growingCar(h, 30, 0);
    expect(h.p.snapshot().alert.level).toBe('VEHICLE_NEARBY');
    const h2 = make();
    await h2.p.start();
    for (let i = 0; i < 10; i++) {
      h2.clock.advance(200);
      h2.detector.result(i + 1, h2.clock.t, []);
    }
    expect(h2.p.snapshot().alert.level).toBe('NORMAL');
  });

  it('results that stop arriving turn the alert UNAVAILABLE on the timer, even though the detector reports no error', async () => {
    const h = make();
    await h.p.start();
    growingCar(h, 14, 0.4);
    expect(h.p.snapshot().alert.level).toBe('POSSIBLE_APPROACH');
    h.clock.advance(2500); // no results for 2.5 s
    h.tick();
    const s = h.p.snapshot();
    expect(s.health.detector).toBe('slow');
    expect(s.alert.level).toBe('UNAVAILABLE');
    expect(s.tracks).toEqual([]); // stale boxes are dropped, not shown
    expect(s.detections).toEqual([]);
  });

  it('recovers after the stall without resurrecting old tracks', async () => {
    const h = make();
    await h.p.start();
    growingCar(h, 35, 0.4);
    h.clock.advance(3000);
    h.tick();
    expect(h.p.snapshot().alert.level).toBe('UNAVAILABLE');
    h.clock.advance(200);
    h.detector.result(100, h.clock.t, [car(0, 0, 0.12)]);
    const s = h.p.snapshot();
    expect(s.health.detector).toBe('ok');
    expect(s.alert.level).toBe('NORMAL'); // one tentative track only: not an alert, and not the old approach
    expect(s.tracks.every((t) => t.state === 'tentative')).toBe(true); // history was dropped: nothing is confirmed yet
  });

  it('camera trouble makes the alert UNAVAILABLE immediately on the next tick', async () => {
    const h = make();
    await h.p.start();
    growingCar(h, 10, 0);
    h.camera.state = 'denied';
    h.tick();
    const s = h.p.snapshot();
    expect(s.alert.level).toBe('UNAVAILABLE');
    expect(s.alert.reasons.join(' ')).toContain('camera denied');
    expect(s.health.camera).toBe('denied');
  });

  it('a detector reporting failed makes the alert UNAVAILABLE, and a result that arrives meanwhile does not hide it', async () => {
    const h = make();
    await h.p.start();
    growingCar(h, 10, 0);
    h.detector.healthValue = 'failed';
    h.clock.advance(100);
    h.detector.result(50, h.clock.t, [car(0, 0)]);
    expect(h.p.snapshot().alert.level).toBe('UNAVAILABLE');
  });

  it('ignores results whose capture time does not advance, and results after stop', async () => {
    const h = make();
    await h.p.start();
    h.clock.advance(200);
    h.detector.result(1, h.clock.t, [car(0, 0)]);
    h.detector.result(2, h.clock.t, [car(0, 0)]); // same capture time
    h.detector.result(3, h.clock.t - 50, [car(0, 0)]); // older
    expect(h.p.snapshot().counters).toMatchObject({ results: 1, outOfOrder: 2 });
    await h.p.stop();
    h.detector.result(4, h.clock.t + 1000, [car(0, 0)]);
    expect(h.p.snapshot().counters.results).toBe(1);
  });

  it('measures frame-to-result latency from the capture time and counts detector errors', async () => {
    const h = make();
    await h.p.start();
    for (let i = 0; i < 10; i++) {
      h.clock.advance(200);
      h.detector.result(i + 1, h.clock.t - 260, []); // each result arrives 260 ms after its frame was captured
    }
    expect(h.p.snapshot().latencyMs.median).toBe(260);
    h.detector.errorCb!({ seq: 3, code: 'INFER_FAILED', message: 'boom' });
    const s = h.p.snapshot();
    expect(s.counters.detectorErrors).toBe(1);
    expect(s.lastError).toContain('INFER_FAILED');
  });
});

describe('RearViewPipeline thermal estimate and load control', () => {
  it('reports unknown thermal at first, hot when the model runs at the measured slow-state time, and caps the feed rate', async () => {
    const h = make();
    await h.p.start();
    for (let i = 0; i < 5; i++) {
      h.clock.advance(200);
      h.detector.result(i + 1, h.clock.t, [], 165);
    }
    expect(h.p.snapshot().health.thermal).toBe('unknown');
    for (let i = 5; i < 40; i++) {
      h.clock.advance(200);
      h.detector.result(i + 1, h.clock.t, [], 165);
    }
    h.tick();
    const s = h.p.snapshot();
    expect(s.health.thermal).toBe('hot');
    expect(s.load.minGapMs).toBe(250); // at most 4 frames per second while throttled
    expect(s.modelMs.median).toBe(165);
    expect(s.modelMs.baseline).toBe(90);
  });

  it('thermal state never changes the alert level by itself', async () => {
    const h = make();
    await h.p.start();
    growingCar(h, 40, 0.4);
    for (let i = 0; i < 40; i++) {
      h.clock.advance(200);
      h.detector.result(100 + i, h.clock.t, [car(10 + i * 0.2, 0.4)], 165);
    }
    const s = h.p.snapshot();
    expect(s.health.thermal).toBe('hot');
    expect(s.alert.level).not.toBe('UNAVAILABLE');
  });

  it('raises the gap when the measured latency p95 goes over budget', async () => {
    const h = make();
    await h.p.start();
    for (let i = 0; i < 40; i++) {
      h.clock.advance(200);
      h.detector.result(i + 1, h.clock.t - 600, [], 90); // 600 ms latency
      h.load.minGapMs(h.clock.t);
    }
    expect(h.p.snapshot().load.minGapMs).toBeGreaterThan(125);
  });
});
