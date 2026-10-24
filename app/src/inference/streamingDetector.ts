// Pipelined detector on the native "NativeDetector" plugin (docs/TECHNICAL_DECISIONS.md D-025/D-026).
// Instead of waiting for each result (which leaves the native thread idle and makes the phone run it ~2.5x slower), the caller
// posts the newest frame and returns; the native worker always processes the newest posted frame and emits one event per
// result. One frame is packed/posted at a time here (backpressure), and the native slot replaces, never queues.

import type { CapturedFrame } from '../capture/source';
import { letterbox416 } from '../core/letterbox';
import type { DetectorHealth, DetectorInitConfig, DetectorResult } from './detector';
import { DetectorError } from './detector';
import { DetectorHealthTracker } from './detectorHealth';
import { canvasRasterize, codeOf, mapNativeDetections, messageOf, type NativeDetectResult, type Rasterizer } from './nativeDetector';
import { bytesToBase64 } from './packFrame';

export interface NativeStreamResult extends NativeDetectResult {
  seq: number;
  queueMs: number;
  replacedTotal?: number;
}

export interface NativeStreamError {
  seq: number | null;
  code: string;
  message: string;
}

export interface ListenerHandle {
  remove(): Promise<void>;
}

/** Wire shape of the plugin's streaming half (NativeDetectorPlugin.java). */
export interface NativeStreamApi {
  init(o: { threads?: number; scoreThr?: number; nmsIou?: number; classIds?: number[]; modelAsset?: string }): Promise<{ ready: boolean; accelerator: string; threads: number; compileMs: number; warmupMs?: number }>;
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  submit(o: { rgb: string; srcW: number; srcH: number; seq: number; format?: 'rgb' | 'jpeg' }): Promise<{ accepted: boolean; replaced: boolean }>;
  addListener(event: 'detection', cb: (e: NativeStreamResult) => void): Promise<ListenerHandle>;
  addListener(event: 'detectorError', cb: (e: NativeStreamError) => void): Promise<ListenerHandle>;
  dispose(): Promise<void>;
}

/** A frame packed elsewhere (FrameProcessor): letterboxed RGB as base64 plus what the detector needs to map the result back. */
export interface PackedFrame {
  rgb64: string;
  /** 'rgb' (default) or 'jpeg': what the string contains. */
  format?: 'rgb' | 'jpeg';
  seq: number;
  srcW: number;
  srcH: number;
  tCaptureMs: number;
  /** Packing time the caller measured (frame handed over until the packed string was ready). */
  preMs: number;
}

export type SubmitOutcome = 'posted' | 'skipped';

export interface StreamCounters {
  /** Frames posted to the native slot. */
  posted: number;
  /** Frames skipped because the previous frame was still being packed or posted. */
  skippedBusy: number;
  /** Posted frames the native side replaced before processing them. */
  replacedNative: number;
  /** Results received. */
  results: number;
  /** Events ignored because no matching submission was pending. */
  strayEvents: number;
}

const MAX_PENDING = 16;

interface Pending {
  tSubmit: number;
  postAckMs?: number;
  preMs: number;
  tCaptureMs: number;
}

export class StreamingDetector {
  private readonly hp = new DetectorHealthTracker();
  private readonly pending = new Map<number, Pending>();
  private packing = false;
  private handles: ListenerHandle[] = [];
  private resultCbs: ((r: DetectorResult & { seq: number; tCaptureMs: number }) => void)[] = [];
  private errorCbs: ((e: NativeStreamError) => void)[] = [];
  private readonly c: StreamCounters = { posted: 0, skippedBusy: 0, replacedNative: 0, results: 0, strayEvents: 0 };

  constructor(
    private readonly plugin: NativeStreamApi,
    private readonly rasterize: Rasterizer = canvasRasterize,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async init(c: DetectorInitConfig): Promise<void> {
    if (c.accelerator !== 'native-cpu') throw new DetectorError(`unsupported accelerator '${c.accelerator}'`, 'BAD_ARGS');
    this.hp.setReady(false);
    await this.removeListeners();
    this.pending.clear();
    try {
      await this.plugin.init({ threads: c.threads ?? 2, scoreThr: c.scoreThr, nmsIou: c.nmsIou });
      this.handles.push(await this.plugin.addListener('detection', (e) => this.onDetection(e)));
      this.handles.push(await this.plugin.addListener('detectorError', (e) => this.onNativeError(e)));
      await this.plugin.startStream();
    } catch (e) {
      await this.removeListeners();
      throw new DetectorError(messageOf(e), codeOf(e) ?? 'INIT_FAILED');
    }
    this.hp.setReady(true);
  }

  onResult(cb: (r: DetectorResult & { seq: number; tCaptureMs: number }) => void): void {
    this.resultCbs.push(cb);
  }

  onError(cb: (e: NativeStreamError) => void): void {
    this.errorCbs.push(cb);
  }

  /** True while a frame is being packed or posted; the caller should not hand over another frame (it would be skipped). */
  isPacking(): boolean {
    return this.packing;
  }

  health(): DetectorHealth {
    return this.hp.health();
  }

  counters(): StreamCounters {
    return { ...this.c };
  }

  /**
   * Pack the frame on THIS thread and post it to the native slot; resolves as soon as the native side has accepted it (not
   * when the result is ready, that arrives through onResult). Returns 'skipped' if the previous frame is still being packed or
   * posted. Does not close the bitmap. **Contract:** the frame's pixels are read synchronously during this call (before the
   * first await), so the caller may hand the bitmap to another owner (for example transfer it to the frame worker) as soon as
   * the call has returned its promise. Pinned by a unit test. Packing here blocks the main thread for about 55 ms; prefer
   * FrameProcessor + submitPacked in the product (D-028).
   */
  async submit(f: CapturedFrame): Promise<SubmitOutcome> {
    if (!this.hp.isReady()) throw new DetectorError('not initialised', 'NOT_INITIALISED');
    if (this.packing) {
      this.c.skippedBusy++;
      return 'skipped';
    }
    this.packing = true;
    try {
      const t0 = this.now();
      let b64: string;
      try {
        b64 = bytesToBase64(this.rasterize(f, letterbox416(f.width, f.height)));
      } catch (e) {
        this.hp.recordError();
        throw new DetectorError(messageOf(e), 'RASTERIZE_FAILED');
      }
      return await this.post(b64, { seq: f.seq, srcW: f.width, srcH: f.height, tCaptureMs: f.tCaptureMs, preMs: this.now() - t0 });
    } finally {
      this.packing = false;
    }
  }

  /**
   * Post a frame that was already packed elsewhere (the frame worker): the main thread only does the plugin call. Same
   * backpressure and result handling as submit(); `preMs` is the packing time the caller measured.
   */
  async submitPacked(p: PackedFrame): Promise<SubmitOutcome> {
    if (!this.hp.isReady()) throw new DetectorError('not initialised', 'NOT_INITIALISED');
    if (this.packing) {
      this.c.skippedBusy++;
      return 'skipped';
    }
    this.packing = true;
    try {
      return await this.post(p.rgb64, p);
    } finally {
      this.packing = false;
    }
  }

  private async post(rgb64: string, m: { seq: number; srcW: number; srcH: number; tCaptureMs: number; preMs: number; format?: 'rgb' | 'jpeg' }): Promise<SubmitOutcome> {
    this.pending.set(m.seq, { tSubmit: this.now(), preMs: m.preMs, tCaptureMs: m.tCaptureMs });
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as number);
    try {
      const tPost = this.now();
      const ack = await this.plugin.submit({ rgb: rgb64, srcW: m.srcW, srcH: m.srcH, seq: m.seq, ...(m.format === 'jpeg' ? { format: 'jpeg' as const } : {}) });
      const entry = this.pending.get(m.seq);
      if (entry) entry.postAckMs = this.now() - tPost;
      this.c.posted++;
      if (ack.replaced) this.c.replacedNative++;
    } catch (e) {
      this.pending.delete(m.seq);
      this.hp.recordError();
      throw new DetectorError(messageOf(e), codeOf(e) ?? 'SUBMIT_FAILED');
    }
    return 'posted';
  }

  async dispose(): Promise<void> {
    this.hp.setReady(false);
    await this.removeListeners();
    this.pending.clear();
    try {
      await this.plugin.stopStream();
    } finally {
      await this.plugin.dispose();
    }
  }

  private onDetection(e: NativeStreamResult): void {
    const p = this.pending.get(e.seq);
    if (!p) {
      this.c.strayEvents++;
      return;
    }
    // Native processes frames in increasing seq order, so anything older than this result will never come back.
    for (const k of [...this.pending.keys()]) if (k <= e.seq) this.pending.delete(k);
    let detections;
    try {
      detections = mapNativeDetections(e);
    } catch (err) {
      this.hp.recordError();
      this.emitError({ seq: e.seq, code: 'BAD_RESULT', message: messageOf(err) });
      return;
    }
    const roundTrip = this.now() - p.tSubmit;
    this.hp.recordSuccess(roundTrip);
    this.c.results++;
    const out = {
      seq: e.seq,
      tCaptureMs: p.tCaptureMs,
      detections,
      preMs: p.preMs,
      inferMs: e.inferMs,
      postMs: e.decodeMs,
      bridgeMs: Math.max(0, roundTrip - e.queueMs - e.nativeTotalMs),
      queueMs: e.queueMs,
      nativeTotalMs: e.nativeTotalMs,
      postAckMs: p.postAckMs,
    };
    for (const cb of this.resultCbs) cb(out);
  }

  private onNativeError(e: NativeStreamError): void {
    if (e.seq !== null) this.pending.delete(e.seq);
    this.hp.recordError();
    this.emitError(e);
  }

  private emitError(e: NativeStreamError): void {
    for (const cb of this.errorCbs) cb(e);
  }

  private async removeListeners(): Promise<void> {
    const hs = this.handles;
    this.handles = [];
    for (const h of hs) {
      try {
        await h.remove();
      } catch {
        /* already removed */
      }
    }
  }
}
