// Camera probe (milestone M5/E2 + an early look at G1): built only with VITE_SELFTEST=camera or =ablation, never in production.
// Measures, inside the real Capacitor WebView: permission flow, what getUserMedia delivers, capture fps alone and with the
// full pipeline (camera -> native detector + JPEG encode), motion-sensor rate, and shows an on-screen overlay so the result
// can be checked with a screenshot. 'ablation' cycles through configurations to find which stage costs what.
// Output goes to the console (`adb logcat`, lines SELFTEST_CAM_*). Nothing is recorded or uploaded; frames are drawn on
// screen and discarded.

import { WebViewCameraSource } from '../capture/webViewCameraSource';
import type { CapturedFrame } from '../capture/source';
import type { DetectorResult } from '../inference/detector';
import type { NativeDetector } from '../inference/nativeDetector';
import { createNativeDetector, createStreamingDetector, NativeDetectorPlugin } from '../plugins/nativeDetector';
import { letterbox416 } from '../core/letterbox';
import { bytesToBase64 } from '../inference/packFrame';
import { LetterboxRasterizer } from '../inference/rasterize';
import { compareDetections, summarise, type FrameComparison } from './detectionCompare';
import { FrameFeeder } from '../stream/frameFeeder';
import { FrameProcessor } from '../stream/frameProcessor';
import sampleUrl from './sample.png?url';

const log = (tag: string, o: unknown) => console.log(`SELFTEST_CAM_${tag} ${JSON.stringify(o)}`);
const r1 = (v: number) => Math.round(v * 10) / 10;
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : NaN);
const med = (xs: number[]) => r1(pct(xs, 50));
const p95 = (xs: number[]) => r1(pct(xs, 95));
const errInfo = (e: unknown) => ({ name: (e as { name?: string })?.name, message: String((e as { message?: string })?.message ?? e).slice(0, 200) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function motionRate(ms: number) {
  let n = 0;
  let rot = false;
  let acc = false;
  const h = (e: DeviceMotionEvent) => {
    n++;
    if (e.rotationRate && e.rotationRate.alpha !== null) rot = true;
    if (e.acceleration && e.acceleration.x !== null) acc = true;
  };
  window.addEventListener('devicemotion', h);
  await sleep(ms);
  window.removeEventListener('devicemotion', h);
  return { events: n, hz: r1((n * 1000) / ms), hasRotationRate: rot, hasAcceleration: acc };
}

interface Flags { detect: boolean; jpeg: boolean; draw: boolean }

/** The frame handler under test, with switchable stages and per-window metrics. */
class Pipeline {
  flags: Flags = { detect: false, jpeg: false, draw: false };
  private emitted = 0;
  private detDone = 0;
  private skippedBusy = 0;
  private readonly m: Record<'pre' | 'infer' | 'post' | 'bridge' | 'age' | 'jpegMs' | 'jpegKB' | 'drawMs', number[]> = { pre: [], infer: [], post: [], bridge: [], age: [], jpegMs: [], jpegKB: [], drawMs: [] };
  private classCounts: Record<string, number> = {};
  private topScore = 0;
  readonly samples: unknown[] = [];
  private t0 = performance.now();
  private raw0 = 0;
  private jpegCanvas = new OffscreenCanvas(640, 360);
  private jctx = this.jpegCanvas.getContext('2d')!;
  private encBusy = false;

  constructor(private readonly cam: WebViewCameraSource, private det: NativeDetector, private readonly ctx: CanvasRenderingContext2D, private readonly canvas: HTMLCanvasElement) {
    cam.onFrame((f) => this.onFrame(f));
  }

  setDetector(d: NativeDetector): void {
    this.det = d;
  }

  reset(): void {
    this.emitted = this.detDone = this.skippedBusy = 0;
    for (const a of Object.values(this.m)) a.length = 0;
    this.classCounts = {};
    this.topScore = 0;
    this.t0 = performance.now();
    this.raw0 = this.cam.rawCameraFrames();
  }

  snapshot(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const secs = (performance.now() - this.t0) / 1000;
    const out = {
      name, ...extra, seconds: r1(secs),
      rawCameraFps: r1((this.cam.rawCameraFrames() - this.raw0) / secs),
      emittedFps: r1(this.emitted / secs),
      detectionsPerSec: r1(this.detDone / secs),
      framesSkippedBusy: this.skippedBusy,
      preMs: med(this.m.pre), inferMs: med(this.m.infer), postMs: med(this.m.post), bridgeMs: med(this.m.bridge),
      frameToResultMs: { median: med(this.m.age), p95: p95(this.m.age) },
      jpeg: { n: this.m.jpegMs.length, perSec: r1(this.m.jpegMs.length / secs), medianMs: med(this.m.jpegMs), p95Ms: p95(this.m.jpegMs), medianKB: r1(med(this.m.jpegKB)) },
      drawMedianMs: med(this.m.drawMs),
      vehicles: { ...this.classCounts }, topScore: r1(this.topScore * 100) / 100,
      cameraState: this.cam.cameraState(), detectorHealth: this.det.health(),
    };
    this.reset();
    return out;
  }

  private onResult(frame: CapturedFrame, r: DetectorResult): void {
    this.detDone++;
    this.m.pre.push(r.preMs);
    this.m.infer.push(r.inferMs);
    this.m.post.push(r.postMs);
    this.m.bridge.push(r.bridgeMs);
    this.m.age.push(performance.now() - frame.tCaptureMs);
    for (const d of r.detections) {
      this.classCounts[d.cls] = (this.classCounts[d.cls] ?? 0) + 1;
      if (d.score > this.topScore) this.topScore = d.score;
    }
    if (r.detections.length && this.samples.length < 8) {
      this.samples.push({ dets: r.detections.slice(0, 3).map((d) => ({ c: d.cls, s: r1(d.score * 100) / 100, x: r1((d.box.x + d.box.w / 2) * 100) / 100, y: r1((d.box.y + d.box.h / 2) * 100) / 100 })) });
    }
    if (this.flags.draw) {
      const t = performance.now();
      const { ctx, canvas } = this;
      ctx.drawImage(frame.bitmap, 0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 3;
      ctx.font = '14px monospace';
      ctx.strokeStyle = ctx.fillStyle = '#0f0';
      for (const d of r.detections) {
        const x = d.box.x * canvas.width;
        const y = d.box.y * canvas.height;
        ctx.strokeRect(x, y, d.box.w * canvas.width, d.box.h * canvas.height);
        ctx.fillText(`${d.cls} ${d.score.toFixed(2)}`, x + 2, Math.max(12, y - 3));
      }
      this.m.drawMs.push(performance.now() - t);
    }
  }

  private onFrame(frame: CapturedFrame): void {
    this.emitted++;
    const jobs: Promise<unknown>[] = [];
    if (this.flags.detect) {
      if (!this.det.isBusy()) {
        jobs.push(
          this.det.detect(frame).then((r) => (r ? this.onResult(frame, r) : void this.skippedBusy++)).catch((e) => log('DETECT_ERROR', errInfo(e))),
        );
      } else {
        this.skippedBusy++;
      }
    }
    if (this.flags.jpeg && !this.encBusy) {
      this.encBusy = true;
      const t0 = performance.now();
      this.jctx.drawImage(frame.bitmap, 0, 0, 640, 360);
      jobs.push(
        this.jpegCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 }).then((b) => {
          this.m.jpegMs.push(performance.now() - t0);
          this.m.jpegKB.push(b.size / 1024);
        }).catch((e) => log('JPEG_ERROR', errInfo(e))).finally(() => (this.encBusy = false)),
      );
    }
    void Promise.allSettled(jobs).finally(() => frame.bitmap.close());
  }
}

/**
 * Isolation experiment: the detector runs in a loop on a FIXED image (constant workload) while the camera state changes, to
 * tell whether having the camera session open slows the CPU work by itself or whether our frame handling does.
 */
async function runIsolate(): Promise<void> {
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:11px monospace;margin:4px;white-space:pre-wrap';
  document.body.append(pre);
  const say = (s: string) => (pre.textContent = s);

  const img = new Image();
  img.src = sampleUrl;
  await img.decode();
  const bitmap = await createImageBitmap(img);
  const fixed: CapturedFrame = { seq: 0, tCaptureMs: 0, tCaptureEpochMs: 0, width: bitmap.width, height: bitmap.height, bitmap };

  const det = createNativeDetector();
  await det.init({ accelerator: 'native-cpu', scoreThr: 0.35, nmsIou: 0.45 });
  const cam = new WebViewCameraSource();
  const pipe = new Pipeline(cam, det, document.createElement('canvas').getContext('2d')!, document.createElement('canvas'));
  pipe.flags = { detect: false, jpeg: false, draw: false }; // handler only closes bitmaps

  const loop = async (name: string, ms: number) => {
    const infer: number[] = [];
    const bridge: number[] = [];
    const prep: number[] = [];
    const total: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const t = performance.now();
      const r = await det.detect(fixed);
      if (r && performance.now() - t0 > 1500) {
        infer.push(r.inferMs);
        bridge.push(r.bridgeMs);
        prep.push(r.preMs);
        total.push(performance.now() - t);
      }
      say(`${name} ${Math.round((performance.now() - t0) / 1000)} s`);
    }
    log('ISOLATE', { name, n: total.length, perSec: r1((total.length * 1000) / (ms - 1500)), inferMs: med(infer), bridgeMs: med(bridge), preMs: med(prep), cycleMs: { median: med(total), p95: p95(total) }, cameraState: cam.cameraState() });
  };

  await loop('1 no camera', 9_000);
  await cam.start({ width: 1280, height: 720, fps: 15 });
  cam.setMaxFps(0.1); // camera streams but (almost) no bitmaps are created
  await sleep(1000);
  await loop('2 camera streaming, frames ignored', 9_000);
  cam.setMaxFps(15);
  await loop('3 camera streaming, frames consumed 15fps', 9_000);
  cam.stop();
  await sleep(1000);
  await loop('4 camera stopped again', 9_000);
  await det.dispose();
  log('DONE', { ok: true });
}

/**
 * Pipelined detector on the live camera (D-026): frames are posted without waiting for results; the native worker always takes
 * the newest. Compares thread counts and with/without JPEG + overlay. Same metrics as the serial probes for comparison.
 */
async function runStream(plan: 'ab' | 'drift' | 'paced' | 'slowab' = 'ab'): Promise<void> {
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:11px monospace;margin:4px;white-space:pre-wrap';
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  canvas.style.cssText = 'width:100%;max-width:480px;background:#000';
  document.body.append(canvas, pre);
  const ctx = canvas.getContext('2d')!;
  const say = (s: string) => (pre.textContent = s);
  try {
    await (navigator as unknown as { wakeLock: { request(t: string): Promise<unknown> } }).wakeLock.request('screen');
  } catch { /* not available */ }

  const cam = new WebViewCameraSource();
  await cam.start({ width: 1280, height: 720, fps: 15 });
  log('STARTED', { settings: cam.settings(), cameraState: cam.cameraState() });

  const latestCanvas = new OffscreenCanvas(480, 270);
  const lctx = latestCanvas.getContext('2d')!;
  const fp = new FrameProcessor();
  const JPEG = { width: 640, height: 360, quality: 0.6 };

  type PackMode = 'main' | 'worker';
  type JpegMode = 'none' | 'worker';
  interface Flags { pack: PackMode; jpeg: JpegMode; draw: boolean; feed?: 'serial' | 'feeder'; format?: 'rgb' | 'jpeg' }
  let det = createStreamingDetector();
  let flags: Flags = { pack: 'main', jpeg: 'none', draw: false };
  let enabled = false;
  let skipped = 0;
  // Paced plan: deliberately feed fewer frames (one per minGapMs) to cap the CPU load; not counted as "skipped".
  let feeder: FrameFeeder | null = null; // overlapped pack/post feeder (D-030), used when flags.feed === 'feeder'
  let minGapMs = 0;
  let lastAcceptedAt = -Infinity;
  let posted0 = 0;
  let replaced0 = 0;
  let t0 = performance.now();
  let raw0 = 0;
  const m: Record<'pre' | 'infer' | 'bridge' | 'queue' | 'native' | 'age' | 'packWorker' | 'jpegMs' | 'jpegEncMs' | 'jpegKB' | 'lag' | 'ack', number[]> = { pre: [], infer: [], bridge: [], queue: [], native: [], age: [], packWorker: [], jpegMs: [], jpegEncMs: [], jpegKB: [], lag: [], ack: [] };
  let classCounts: Record<string, number> = {};
  let topScore = 0;
  let results = 0;
  let errors = 0;

  // Main-thread responsiveness: a 20 ms timer; how late it fires is how long the main thread was busy.
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (enabled) m.lag.push(Math.max(0, now - lastTick - 20));
    lastTick = now;
  }, 20);

  const wire = () => {
    det.onResult((r) => {
      results++;
      m.pre.push(r.preMs);
      m.infer.push(r.inferMs);
      m.bridge.push(r.bridgeMs);
      m.queue.push(r.queueMs ?? 0);
      m.native.push(r.nativeTotalMs ?? 0);
      m.ack.push(r.postAckMs ?? 0);
      m.age.push(performance.now() - r.tCaptureMs);
      for (const d of r.detections) {
        classCounts[d.cls] = (classCounts[d.cls] ?? 0) + 1;
        if (d.score > topScore) topScore = d.score;
      }
      if (flags.draw) {
        ctx.drawImage(latestCanvas, 0, 0);
        ctx.lineWidth = 3;
        ctx.font = '14px monospace';
        ctx.strokeStyle = ctx.fillStyle = '#0f0';
        for (const d of r.detections) {
          const x = d.box.x * canvas.width;
          const y = d.box.y * canvas.height;
          ctx.strokeRect(x, y, d.box.w * canvas.width, d.box.h * canvas.height);
          ctx.fillText(`${d.cls} ${d.score.toFixed(2)}`, x + 2, Math.max(12, y - 3));
        }
      }
    });
    det.onError((e) => log('STREAM_ERROR', e));
  };

  const logErr = (tag: string) => (e: unknown) => {
    errors++;
    log(tag, { code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 160) });
  };

  cam.onFrame((frame) => {
    if (!enabled) {
      frame.bitmap.close();
      return;
    }
    // 1) everything that reads the bitmap on the main thread, before ownership may move to the worker
    if (flags.draw) lctx.drawImage(frame.bitmap, 0, 0, 480, 270);

    if (flags.pack === 'main') {
      // main-thread pack inside submit(): the pixels are read synchronously during the call
      let submitJob: Promise<unknown> = Promise.resolve();
      if (!det.isPacking()) submitJob = det.submit(frame).catch(logErr('SUBMIT_ERROR'));
      else skipped++;
      if (flags.jpeg === 'worker' && !fp.isBusy()) {
        const job = fp.process(frame.bitmap, frame.width, frame.height, { pack: false, jpeg: JPEG });
        if (job) {
          void job.jpeg.then((r) => r && (m.jpegMs.push(r.roundTripMs), m.jpegEncMs.push(r.encodeMs), m.jpegKB.push(r.bytes.length / 1024)), logErr('JPEG_ERROR'));
          return; // the bitmap now belongs to the worker
        }
      }
      void submitJob.finally(() => frame.bitmap.close());
      return;
    }

    // pack in the worker: the main thread only posts the ready string
    if (minGapMs > 0 && performance.now() - lastAcceptedAt < minGapMs) {
      frame.bitmap.close(); // paced: this frame is deliberately not processed
      return;
    }
    if (feeder) {
      feeder.offer(frame); // the feeder owns the bitmap from here (transfers it to the worker or closes it)
      return;
    }
    if (det.isPacking() || fp.isBusy()) {
      skipped++;
      frame.bitmap.close();
      return;
    }
    const job = fp.process(frame.bitmap, frame.width, frame.height, { pack: true, packFormat: flags.format ?? 'rgb', packQuality: 0.9, jpeg: flags.jpeg === 'worker' ? JPEG : undefined });
    if (!job) {
      frame.bitmap.close();
      return;
    }
    lastAcceptedAt = performance.now();
    void job.pack
      .then((p) => {
        if (!p) return undefined;
        m.packWorker.push(p.packMs);
        return det.submitPacked({ rgb64: p.rgb64, format: p.format, seq: frame.seq, srcW: frame.width, srcH: frame.height, tCaptureMs: frame.tCaptureMs, preMs: p.roundTripMs });
      })
      .catch(logErr('SUBMIT_ERROR'));
    void job.jpeg.then((r) => r && (m.jpegMs.push(r.roundTripMs), m.jpegEncMs.push(r.encodeMs), m.jpegKB.push(r.bytes.length / 1024)), logErr('JPEG_ERROR'));
  });

  const window = async (name: string, threads: number, f: Flags, ms: number, reinit = true) => {
    if (reinit) {
      enabled = false;
      await det.dispose().catch(() => undefined);
      det = createStreamingDetector();
      wire();
      await det.init({ accelerator: 'native-cpu', threads, scoreThr: 0.35, nmsIou: 0.45 });
    }
    flags = f;
    feeder?.stop();
    feeder = f.feed === 'feeder' ? new FrameFeeder(fp, det, { packFormat: f.format ?? 'rgb', packQuality: 0.9 }) : null;
    enabled = true;
    await sleep(reinit ? 3000 : 1500); // settle
    for (const a of Object.values(m)) a.length = 0;
    classCounts = {};
    topScore = 0;
    results = 0;
    skipped = 0;
    errors = 0;
    posted0 = det.counters().posted;
    replaced0 = det.counters().replacedNative;
    t0 = performance.now();
    raw0 = cam.rawCameraFrames();
    while (performance.now() - t0 < ms) {
      await sleep(250);
      say(`${name}  ${Math.round((performance.now() - t0) / 1000)} s  camera ${r1(cam.stats().fps)} fps  det ${det.health()}`);
    }
    const secs = (performance.now() - t0) / 1000;
    const c = det.counters();
    log('STREAM_WINDOW', {
      name, threads, flags: f, seconds: r1(secs),
      rawCameraFps: r1((cam.rawCameraFrames() - raw0) / secs),
      postedPerSec: r1((c.posted - posted0) / secs),
      detectionsPerSec: r1(results / secs),
      replacedNativePerSec: r1((c.replacedNative - replaced0) / secs),
      skippedPerSec: r1(skipped / secs),
      preMs: med(m.pre), packWorkerMs: med(m.packWorker), postAckMs: med(m.ack), inferMs: med(m.infer), queueMs: med(m.queue), nativeTotalMs: med(m.native), bridgeMs: med(m.bridge),
      frameToResultMs: { median: med(m.age), p95: p95(m.age) },
      jpeg: { n: m.jpegMs.length, perSec: r1(m.jpegMs.length / secs), medianMs: med(m.jpegMs), p95Ms: p95(m.jpegMs), workerEncodeMedianMs: med(m.jpegEncMs), medianKB: r1(med(m.jpegKB)) },
      errors,
      feeder: feeder?.counters(),
      mainThreadLagMs: { median: med(m.lag), p95: p95(m.lag), max: r1(Math.max(0, ...m.lag)), over50ms: m.lag.filter((x) => x > 50).length },
      vehicles: { ...classCounts }, topScore: r1(topScore * 100) / 100,
      cameraState: cam.cameraState(), detectorHealth: det.health(),
    });
  };

  if (plan === 'ab') {
    // Alternating order so a slow drift in the phone's state does not favour one side.
    await window('P1 main-pack, no jpeg', 2, { pack: 'main', jpeg: 'none', draw: false }, 12_000);
    await window('P2 WORKER-pack, no jpeg', 2, { pack: 'worker', jpeg: 'none', draw: false }, 12_000);
    await window('P3 main-pack + jpeg worker + draw', 2, { pack: 'main', jpeg: 'worker', draw: true }, 12_000);
    await window('P4 WORKER-pack + jpeg + draw', 2, { pack: 'worker', jpeg: 'worker', draw: true }, 12_000);
    await window('P5 main-pack + jpeg worker + draw', 2, { pack: 'main', jpeg: 'worker', draw: true }, 12_000);
    await window('P6 WORKER-pack + jpeg + draw', 2, { pack: 'worker', jpeg: 'worker', draw: true }, 12_000);
    await window('P7 WORKER-pack, no jpeg', 2, { pack: 'worker', jpeg: 'none', draw: false }, 12_000);
  } else if (plan === 'slowab') {
    // D-030: heat-soak the phone into the slow state, then compare feeding strategies and payload formats IN that state, in
    // alternating order (A B C D C B A). serial = pack, then post, one after the other; feeder = overlapped pack/post.
    const A: Flags = { pack: 'worker', jpeg: 'none', draw: false, feed: 'serial', format: 'rgb' };
    const B: Flags = { ...A, feed: 'feeder', format: 'rgb' };
    const C: Flags = { ...A, feed: 'feeder', format: 'jpeg' };
    const D: Flags = { ...A, feed: 'serial', format: 'jpeg' };
    await window('SOAK serial rgb (heat soak, 140 s)', 2, A, 140_000);
    await window('A serial rgb', 2, A, 16_000, false);
    await window('B feeder rgb', 2, B, 16_000, false);
    await window('C feeder jpeg', 2, C, 16_000, false);
    await window('D serial jpeg', 2, D, 16_000, false);
    await window('C2 feeder jpeg', 2, C, 16_000, false);
    await window('B2 feeder rgb', 2, B, 16_000, false);
    await window('A2 serial rgb', 2, A, 16_000, false);
  } else if (plan === 'drift') {
    // Drift test: ONE detector, same configuration, 24 consecutive 10 s windows with no re-init (about 4 minutes), then a re-init.
    // Run it with tools/device/thermal-run.sh to sample CPU caps and temperatures at the same time (D-029).
    const cfg: Flags = { pack: 'worker', jpeg: 'none', draw: false };
    await window('D01 (fresh init)', 2, cfg, 10_000);
    for (let i = 2; i <= 24; i++) await window('D' + String(i).padStart(2, '0') + ' (no re-init)', 2, cfg, 10_000, false);
    await window('D25 (re-init)', 2, cfg, 10_000);
  } else {
    // Paced test (D-029): the same drift structure, but only one frame per 250 ms (4 per second at most) is fed to the detector,
    // to see whether a lower average CPU load keeps the big cores in use and avoids the step to the slow mode.
    minGapMs = 250;
    const cfg: Flags = { pack: 'worker', jpeg: 'none', draw: false };
    await window('Q01 paced 4/s (fresh init)', 2, cfg, 10_000);
    for (let i = 2; i <= 24; i++) await window('Q' + String(i).padStart(2, '0') + ' paced 4/s', 2, cfg, 10_000, false);
    await window('Q25 paced 4/s (re-init)', 2, cfg, 10_000);
  }
  enabled = false;
  cam.stop();
  fp.dispose();
  await det.dispose();
  log('DONE', { ok: true });
  say('done');
}

/**
 * Raw RGB vs JPEG payload on the SAME live frames (D-030): every camera frame is letterboxed once and sent to the detector as raw
 * RGB and as JPEG at several qualities; detections are compared with detectionCompare.ts. The native score floor is lowered to 0.2
 * so threshold crossings around the decision threshold 0.35 are visible. Needs vehicles in view to say anything about vehicles.
 */
async function runJpegCompare(): Promise<void> {
  const THR = 0.35;
  const FLOOR = 0.2;
  const QS = [0.95, 0.9, 0.8];
  const DURATION_MS = 120_000;

  const pre = document.createElement('pre');
  pre.style.cssText = 'font:11px monospace;margin:4px;white-space:pre-wrap';
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  canvas.style.cssText = 'width:100%;max-width:480px;background:#000';
  document.body.append(canvas, pre);
  const ctx = canvas.getContext('2d')!;
  const say = (s: string) => (pre.textContent = s);
  try {
    await (navigator as unknown as { wakeLock: { request(t: string): Promise<unknown> } }).wakeLock.request('screen');
  } catch { /* not available */ }

  await NativeDetectorPlugin.init({ threads: 2, scoreThr: FLOOR, nmsIou: 0.45 });
  const cam = new WebViewCameraSource();
  await cam.start({ width: 1280, height: 720, fps: 15 });
  log('STARTED', { settings: cam.settings(), cameraState: cam.cameraState(), thr: THR, floor: FLOOR, qualities: QS });

  const rast = new LetterboxRasterizer();
  const per: Record<string, FrameComparison[]> = Object.fromEntries(QS.map((q) => [String(q), []]));
  const kb: Record<string, number[]> = Object.fromEntries(QS.map((q) => [String(q), []]));
  const rawKb: number[] = [];
  const classKept: Record<number, number> = {};
  let borderline = 0; // raw detections whose score is within 0.1 above the threshold: the ones a small change can flip
  let frames = 0;
  let busy = false;
  let errors = 0;
  const t0 = performance.now();

  cam.onFrame(async (frame) => {
    if (busy || performance.now() - t0 > DURATION_MS) {
      frame.bitmap.close();
      return;
    }
    busy = true;
    try {
      const lb = letterbox416(frame.width, frame.height);
      const rawB64 = bytesToBase64(rast.rasterize(frame.bitmap, lb));
      const raw = await NativeDetectorPlugin.detect({ rgb: rawB64, srcW: frame.width, srcH: frame.height });
      rawKb.push(rawB64.length / 1024);
      for (const d of raw.detections) {
        if (d.score >= THR) {
          classKept[d.classId] = (classKept[d.classId] ?? 0) + 1;
          if (d.score < THR + 0.1) borderline++;
        }
      }
      let jpg90: typeof raw.detections = [];
      for (const q of QS) {
        const b64 = bytesToBase64(await rast.rasterizeJpeg(frame.bitmap, lb, q));
        const res = await NativeDetectorPlugin.detect({ rgb: b64, srcW: frame.width, srcH: frame.height, format: 'jpeg' });
        per[String(q)]!.push(compareDetections(raw.detections, res.detections, THR));
        kb[String(q)]!.push(b64.length / 1024);
        if (q === 0.9) jpg90 = res.detections;
      }
      frames++;
      // overlay: raw boxes green, JPEG q0.90 boxes red (thicker underneath so both stay visible)
      ctx.drawImage(frame.bitmap, 0, 0, canvas.width, canvas.height);
      const box = (d: (typeof raw.detections)[number], colour: string, w: number) => {
        ctx.strokeStyle = colour;
        ctx.lineWidth = w;
        ctx.strokeRect(d.x * canvas.width, d.y * canvas.height, d.w * canvas.width, d.h * canvas.height);
      };
      for (const d of jpg90) if (d.score >= THR) box(d, '#f33', 4);
      for (const d of raw.detections) if (d.score >= THR) box(d, '#3f3', 2);
      if (frames % 10 === 0) {
        const s = summarise(per['0.9']!);
        log('JPEGCMP_PROGRESS', { frames, refKept: s.refKept, lostBelowThreshold: s.lostBelowThreshold, lostMissing: s.lostMissing, gained: s.gainedCrossedUp + s.gainedNew });
      }
      say(`frame ${frames}  ${Math.round((performance.now() - t0) / 1000)} s of ${DURATION_MS / 1000}`);
    } catch (e) {
      errors++;
      log('JPEGCMP_ERROR', errInfo(e));
    } finally {
      frame.bitmap.close();
      busy = false;
    }
  });

  while (performance.now() - t0 < DURATION_MS + 3000) await sleep(500);
  cam.stop();
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  for (const q of QS) {
    const s = summarise(per[String(q)]!);
    log('JPEGCMP_SUMMARY', {
      quality: q, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'number' ? r3(v) : v])),
      medianPayloadKB: r1(med(kb[String(q)]!)),
    });
  }
  log('JPEGCMP_CONTEXT', { frames, errors, rawMedianPayloadKB: r1(med(rawKb)), keptByClassId: classKept, borderlineRawDetections: borderline });
  await NativeDetectorPlugin.dispose();
  log('DONE', { ok: true });
  say('done');
}

export async function run(mode: 'camera' | 'ablation' | 'isolate' | 'stream' | 'drift' | 'paced' | 'slowab' | 'jpegcmp' = 'camera'): Promise<void> {
  if (mode === 'jpegcmp') {
    try {
      log('START', { mode });
      await runJpegCompare();
    } catch (e) {
      log('FATAL', errInfo(e));
    }
    return;
  }
  if (mode === 'stream' || mode === 'drift' || mode === 'paced' || mode === 'slowab') {
    try {
      log('START', { mode });
      await runStream(mode === 'drift' ? 'drift' : mode === 'paced' ? 'paced' : mode === 'slowab' ? 'slowab' : 'ab');
    } catch (e) {
      log('FATAL', errInfo(e));
    }
    return;
  }
  if (mode === 'isolate') {
    try {
      log('START', { mode });
      await runIsolate();
    } catch (e) {
      log('FATAL', errInfo(e));
    }
    return;
  }
  try {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:11px monospace;margin:4px;white-space:pre-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 270;
    canvas.style.cssText = 'width:100%;max-width:480px;background:#000';
    document.body.append(canvas, pre);
    const say = (s: string) => (pre.textContent = s);

    let wake = false;
    try {
      await (navigator as unknown as { wakeLock: { request(t: string): Promise<unknown> } }).wakeLock.request('screen');
      wake = true;
    } catch { /* not available */ }
    let camPerm = 'unavailable';
    try {
      camPerm = (await navigator.permissions.query({ name: 'camera' as PermissionName })).state;
    } catch { /* not supported */ }
    log('START', { mode, ua: navigator.userAgent.slice(0, 150), secure: isSecureContext, mediaDevices: !!navigator.mediaDevices, wakeLock: wake, cameraPermissionBefore: camPerm });

    say('measuring motion sensors (3 s)...');
    log('MOTION', await motionRate(3000));

    let det = createNativeDetector();
    await det.init({ accelerator: 'native-cpu', scoreThr: 0.35, nmsIou: 0.45 });
    log('DETECTOR', { health: det.health() });

    const cam = new WebViewCameraSource();
    const pipe = new Pipeline(cam, det, canvas.getContext('2d')!, canvas);

    const tStart = performance.now();
    try {
      await cam.start({ width: 1280, height: 720, fps: 15 });
    } catch (e) {
      log('START_FAILED', { ...errInfo(e), cameraState: cam.cameraState(), lastError: cam.lastErrorMessage() });
      say('camera start failed: ' + JSON.stringify(errInfo(e)));
      return;
    }
    log('STARTED', { startMs: r1(performance.now() - tStart), settings: cam.settings(), cameraState: cam.cameraState() });
    try {
      log('DEVICES', { videoInputs: (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length });
    } catch (e) {
      log('DEVICES_ERROR', errInfo(e));
    }

    const phase = async (name: string, flags: Flags, ms: number, extra: Record<string, unknown> = {}, settleMs = 1500) => {
      pipe.flags = flags;
      await sleep(settleMs); // let in-flight work from the previous configuration drain
      pipe.reset();
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        await sleep(250);
        say(`${name}  ${Math.round((performance.now() - t0) / 1000)} s  camera ${r1(cam.stats().fps)} fps  state ${cam.cameraState()}  det ${det.health()}`);
      }
      log('WINDOW', pipe.snapshot(name, { flags, ...extra }));
    };

    if (mode === 'camera') {
      await phase('baseline-camera-only', { detect: false, jpeg: false, draw: false }, 10_000, {}, 500);
      for (let w = 1; w <= 5; w++) await phase(`full-${w}`, { detect: true, jpeg: true, draw: true }, 10_000);
    } else {
      const F = (detect: boolean, jpeg: boolean, draw: boolean): Flags => ({ detect, jpeg, draw });
      await phase('A camera-only 15fps', F(false, false, false), 6_000, { camFps: 15, threads: 2 }, 500);
      await phase('B detect-only 15fps', F(true, false, false), 9_000, { camFps: 15, threads: 2 });
      await phase('C detect+draw 15fps', F(true, false, true), 9_000, { camFps: 15, threads: 2 });
      await phase('D detect+jpeg 15fps', F(true, true, false), 9_000, { camFps: 15, threads: 2 });
      await phase('E jpeg-only 15fps', F(false, true, false), 9_000, { camFps: 15, threads: 2 });
      await phase('F full 15fps', F(true, true, true), 9_000, { camFps: 15, threads: 2 });
      cam.setMaxFps(8);
      await phase('G detect-only 8fps', F(true, false, false), 9_000, { camFps: 8, threads: 2 });
      await phase('H full 8fps', F(true, true, true), 9_000, { camFps: 8, threads: 2 });
      cam.setMaxFps(5);
      await phase('I detect-only 5fps', F(true, false, false), 9_000, { camFps: 5, threads: 2 });
      cam.setMaxFps(15);
      pipe.flags = F(false, false, false);
      await det.dispose();
      det = createNativeDetector();
      await det.init({ accelerator: 'native-cpu', threads: 4, scoreThr: 0.35, nmsIou: 0.45 });
      pipe.setDetector(det);
      await phase('J detect-only 15fps 4 threads', F(true, false, false), 9_000, { camFps: 15, threads: 4 });
      await phase('K full 15fps 4 threads', F(true, true, true), 9_000, { camFps: 15, threads: 4 });
      pipe.flags = F(false, false, false);
      await det.dispose();
      det = createNativeDetector();
      await det.init({ accelerator: 'native-cpu', threads: 1, scoreThr: 0.35, nmsIou: 0.45 });
      pipe.setDetector(det);
      await phase('L detect-only 15fps 1 thread', F(true, false, false), 9_000, { camFps: 15, threads: 1 });
    }
    log('SAMPLES', pipe.samples);
    log('TOTALS', { cameraStats: cam.stats(), cameraState: cam.cameraState(), detectorHealth: det.health() });
    cam.stop();
    await det.dispose();
    log('DONE', { ok: true });
    say('done');
  } catch (e) {
    log('FATAL', errInfo(e));
  }
}
