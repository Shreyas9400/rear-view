// The product pipeline (docs/ARCHITECTURE.md, D-031): camera -> frame feeder (worker JPEG pack) -> streaming detector -> tracker ->
// approach estimator -> alert state machine, with a latency-driven load controller and health including an inferred thermal state.
// All collaborators are injected, so it runs in Node tests with fakes. Browser/phone wiring is in createPipeline.ts.
//
// Safety rules enforced here (CLAUDE.md): an alert is only ever computed from FRESH results; if the camera or detector is not
// healthy, or results stop arriving, the alert becomes UNAVAILABLE (never the last alert, never "all clear"); tracks are
// dropped when health is lost so stale boxes cannot resurface after recovery.

import type { CapturedFrame } from '../capture/source';
import type { CameraState } from '../capture/cameraHealth';
import { ApproachEstimator } from '../core/approach';
import { AlertStateMachine, type AlertConfig } from '../core/alert';
import { IouTracker } from '../core/tracker';
import { HealthMonitor } from '../health/healthMonitor';
import { ThermalEstimator } from '../health/thermalEstimator';
import type { DetectorHealth, DetectorInitConfig, DetectorResult } from '../inference/detector';
import type { NativeStreamError } from '../inference/streamingDetector';
import type { AlertState, Detection, HealthFlags, Track } from '../shared/types';
import type { FeederCounters } from '../stream/frameFeeder';
import { LoadController, type LoadSnapshot } from './loadController';
import { RollingWindow } from './rollingWindow';

export interface CameraLike {
  onFrame(cb: (f: CapturedFrame) => void): void;
  start(o: { width: number; height: number; fps: number }): Promise<void>;
  stop(): void;
  cameraState(): CameraState;
}

export interface FeederLike {
  /** Takes ownership of the bitmap in every case. */
  offer(f: CapturedFrame): 'packing' | 'dropped';
  counters(): FeederCounters;
  stop(): void;
  /** Resume after stop(); optional so simple fakes need not implement it. */
  start?(): void;
  onError(cb: (e: { stage: 'pack' | 'post'; code?: string; message: string }) => void): void;
}

export interface DetectorLike {
  init(c: DetectorInitConfig): Promise<void>;
  onResult(cb: (r: DetectorResult & { seq: number; tCaptureMs: number }) => void): void;
  onError(cb: (e: NativeStreamError) => void): void;
  health(): DetectorHealth;
  dispose(): Promise<void>;
}

export interface PipelineDeps {
  camera: CameraLike;
  feeder: FeederLike;
  detector: DetectorLike;
  tracker: IouTracker;
  approach: ApproachEstimator;
  alert: AlertStateMachine;
  thermal: ThermalEstimator;
  load: LoadController;
  /** Monotonic clock in ms, the same clock as CapturedFrame.tCaptureMs (performance.now()). */
  now: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  /** Called synchronously with a frame BEFORE it is handed over (the bitmap is still readable), at most every previewEveryMs. */
  previewHook?: (f: CapturedFrame) => void;
}

export interface PipelineConfig {
  capture: { width: number; height: number; fps: number };
  detector: DetectorInitConfig;
  tickMs: number;
  previewEveryMs: number;
}

export const DEFAULT_PIPELINE: PipelineConfig = {
  capture: { width: 1280, height: 720, fps: 15 },
  detector: { accelerator: 'native-cpu', threads: 2, scoreThr: 0.35, nmsIou: 0.45 },
  tickMs: 500,
  previewEveryMs: 200,
};

export interface PipelineCounters {
  frames: number;
  /** Frames closed unprocessed because the load controller's minimum gap had not elapsed. */
  paced: number;
  results: number;
  /** Results ignored because their capture time did not advance. */
  outOfOrder: number;
  detectorErrors: number;
  feeder: FeederCounters;
}

export interface PipelineSnapshot {
  running: boolean;
  /** Always set: UNAVAILABLE when the pipeline is not running or not healthy. */
  alert: AlertState;
  tracks: Track[];
  detections: Detection[];
  health: HealthFlags;
  detectionsPerSec: number;
  latencyMs: { median: number; p95: number };
  modelMs: { median: number; baseline: number };
  load: LoadSnapshot;
  counters: PipelineCounters;
  lastError: string | null;
  /** The frame the current detections/tracks were computed on (for the stream's detSeq/detAgeMs); null before the first result. */
  lastResult: { seq: number; tCaptureMs: number } | null;
  nowMs: number;
}

export class RearViewPipeline {
  private running = false;
  private startedAt: number | null = null;
  private lastResultAt: number | null = null;
  private lastCaptureMs = -Infinity;
  private lastResultSeq: number | null = null;
  private lastAcceptedAt = -Infinity;
  private lastPreviewAt = -Infinity;
  private unhealthy = true;
  private tracks: Track[] = [];
  private detections: Detection[] = [];
  private alertState: AlertState;
  private lastError: string | null = null;
  private timer: unknown = null;
  private subscribers: ((s: PipelineSnapshot) => void)[] = [];
  private readonly health: HealthMonitor;
  private readonly latency = new RollingWindow(10_000);
  private readonly rate = new RollingWindow(5_000);
  private readonly c: Omit<PipelineCounters, 'feeder'> = { frames: 0, paced: 0, results: 0, outOfOrder: 0, detectorErrors: 0 };

  constructor(
    private readonly d: PipelineDeps,
    private readonly cfg: PipelineConfig = DEFAULT_PIPELINE,
  ) {
    this.health = new HealthMonitor({
      cameraState: () => d.camera.cameraState(),
      detectorHealth: () => d.detector.health(),
      lastResultAtMs: () => this.lastResultAt,
      startedAtMs: () => this.startedAt,
      thermal: () => d.thermal.state(),
    });
    // Before anything runs the alert is UNAVAILABLE, never NORMAL.
    this.alertState = this.d.alert.update({ tMs: d.now(), tracks: [], approach: [], health: this.health.read(d.now()) });
    d.detector.onResult((r) => this.onResult(r));
    d.detector.onError((e) => {
      this.c.detectorErrors++;
      this.lastError = `detector: ${e.code} ${e.message}`.slice(0, 200);
    });
    d.feeder.onError((e) => {
      this.lastError = `feeder (${e.stage}): ${e.code ?? ''} ${e.message}`.slice(0, 200);
    });
  }

  onUpdate(cb: (s: PipelineSnapshot) => void): void {
    this.subscribers.push(cb);
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.resetState();
    this.d.feeder.start?.();
    try {
      await this.d.detector.init(this.cfg.detector);
      this.d.camera.onFrame((f) => this.onFrame(f));
      await this.d.camera.start(this.cfg.capture);
    } catch (e) {
      this.lastError = `start failed: ${String((e as Error)?.message ?? e)}`.slice(0, 200);
      this.d.camera.stop();
      await this.d.detector.dispose().catch(() => undefined);
      this.publish();
      throw e;
    }
    this.startedAt = this.d.now();
    this.running = true;
    const setI = this.d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = setI(() => this.tick(), this.cfg.tickMs);
    this.tick();
  }

  async stop(): Promise<void> {
    if (!this.running && this.startedAt === null) return;
    this.running = false;
    this.startedAt = null;
    if (this.timer !== null) (this.d.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
    this.d.camera.stop();
    this.d.feeder.stop();
    await this.d.detector.dispose().catch(() => undefined);
    this.d.tracker.reset();
    this.tracks = [];
    this.detections = [];
    this.alertState = this.d.alert.update({ tMs: this.d.now(), tracks: [], approach: [], health: this.health.read(this.d.now()) });
    this.unhealthy = true;
    this.publish();
  }

  /** Change alert thresholds while running (calibration). */
  configureAlert(over: Partial<AlertConfig>): void {
    this.d.alert.configure(over);
  }

  snapshot(): PipelineSnapshot {
    const now = this.d.now();
    const health = this.health.read(now);
    return {
      running: this.running,
      alert: this.alertState,
      tracks: this.tracks,
      detections: this.detections,
      health,
      detectionsPerSec: this.rate.ratePerSec(now),
      latencyMs: { median: this.latency.median(now), p95: this.latency.p95(now) },
      modelMs: { median: this.d.thermal.medianMs(now), baseline: this.d.thermal.baselineMs() },
      load: this.d.load.snapshot(now),
      counters: { ...this.c, feeder: this.d.feeder.counters() },
      lastError: this.lastError,
      lastResult: this.lastResultSeq === null ? null : { seq: this.lastResultSeq, tCaptureMs: this.lastCaptureMs },
      nowMs: now,
    };
  }

  private resetState(): void {
    this.d.tracker.reset();
    this.d.alert.reset();
    this.d.thermal.reset();
    this.d.load.reset();
    this.latency.clear();
    this.rate.clear();
    this.c.frames = this.c.paced = this.c.results = this.c.outOfOrder = this.c.detectorErrors = 0;
    this.lastResultAt = null;
    this.lastCaptureMs = -Infinity;
    this.lastResultSeq = null;
    this.lastAcceptedAt = -Infinity;
    this.lastPreviewAt = -Infinity;
    this.tracks = [];
    this.detections = [];
    this.lastError = null;
    this.unhealthy = true;
  }

  private onFrame(frame: CapturedFrame): void {
    if (!this.running) {
      frame.bitmap.close();
      return;
    }
    this.c.frames++;
    const now = this.d.now();
    if (now - this.lastAcceptedAt < this.d.load.minGapMs(now)) {
      this.c.paced++;
      frame.bitmap.close();
      return;
    }
    if (this.d.previewHook && now - this.lastPreviewAt >= this.cfg.previewEveryMs) {
      this.lastPreviewAt = now;
      try {
        this.d.previewHook(frame); // reads the bitmap synchronously, before ownership moves to the worker
      } catch {
        /* a preview failure must never stop detection */
      }
    }
    if (this.d.feeder.offer(frame) === 'packing') this.lastAcceptedAt = now;
  }

  private onResult(r: DetectorResult & { seq: number; tCaptureMs: number }): void {
    if (!this.running) return;
    const now = this.d.now();
    if (r.tCaptureMs <= this.lastCaptureMs) {
      this.c.outOfOrder++;
      return;
    }
    this.lastCaptureMs = r.tCaptureMs;
    this.lastResultSeq = r.seq;
    this.lastResultAt = now;
    this.c.results++;
    this.rate.add(now, 1);
    const latency = now - r.tCaptureMs;
    this.latency.add(now, latency);
    this.d.load.onResult(now, latency);
    this.d.thermal.onModelMs(now, r.inferMs);

    const health = this.health.read(now);
    this.d.load.setThermal(health.thermal);
    this.detections = r.detections;
    this.tracks = this.d.tracker.update(r.tCaptureMs, r.detections);
    const approach = this.d.approach.update(r.tCaptureMs, this.tracks);
    this.alertState = this.d.alert.update({ tMs: r.tCaptureMs, tracks: this.tracks, approach, health });
    this.unhealthy = health.camera !== 'ok' || health.detector !== 'ok';
    this.publish();
  }

  /** Runs on a timer so that a frozen pipeline is noticed even though no results arrive. */
  private tick(): void {
    const now = this.d.now();
    const health = this.health.read(now);
    this.d.load.setThermal(health.thermal);
    const bad = health.camera !== 'ok' || health.detector !== 'ok';
    if (bad) {
      if (!this.unhealthy) {
        // entering an unhealthy state: forget everything so stale tracks cannot resurface after recovery
        this.d.tracker.reset();
        this.tracks = [];
        this.detections = [];
      }
      this.alertState = this.d.alert.update({ tMs: now, tracks: [], approach: [], health });
    }
    this.unhealthy = bad;
    this.publish();
  }

  private publish(): void {
    if (!this.subscribers.length) return;
    const s = this.snapshot();
    for (const cb of this.subscribers) cb(s);
  }
}
