// Detector backed by the native "NativeDetector" Capacitor plugin (LiteRT on the CPU, D-022).
// The plugin and the rasteriser are injected so the logic is testable in Node without a phone.

import type { CapturedFrame } from '../capture/source';
import { letterbox416, type Letterbox } from '../core/letterbox';
import type { Detection, VehicleClass } from '../shared/types';
import { DetectorError, type Detector, type DetectorHealth, type DetectorInitConfig, type DetectorResult } from './detector';
import { DetectorHealthTracker } from './detectorHealth';
import { bytesToBase64 } from './packFrame';
import { LetterboxRasterizer } from './rasterize';

/** Wire shape of the plugin, mirrored by NativeDetectorPlugin.java. */
export interface NativeDetectResult {
  detections: { classId: number; score: number; x: number; y: number; w: number; h: number }[];
  inferMs: number;
  decodeMs: number;
  nativeTotalMs: number;
}

export interface NativeDetectorApi {
  init(o: { threads?: number; scoreThr?: number; nmsIou?: number; classIds?: number[]; modelAsset?: string }): Promise<{ ready: boolean; accelerator: string; threads: number; compileMs: number; warmupMs?: number }>;
  detect(o: { rgb: string; srcW: number; srcH: number; format?: 'rgb' | 'jpeg' }): Promise<NativeDetectResult>;
  dispose(): Promise<void>;
}

/** Produce the letterboxed 416x416 frame as packed RGB (gray 114 padding bottom/right). */
export type Rasterizer = (frame: CapturedFrame, lb: Letterbox) => Uint8Array;

/** COCO80 ids kept by the project (same as app/src/core/decode.ts VEHICLE_CLASSES). */
const CLASS_BY_ID: Readonly<Record<number, VehicleClass>> = { 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck' };

export { SLOW_P95_MS } from './detectorHealth';

const shared = new LetterboxRasterizer();

/** Default rasteriser on the main thread (browser/WebView only; the logic is unit-tested via LetterboxRasterizer). */
export const canvasRasterize: Rasterizer = (frame, lb) => shared.rasterize(frame.bitmap, lb);

export const codeOf = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined);
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e));

const inUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -1e-9 && v <= 1 + 1e-9;

/** Validate the native payload (it crosses a process-like boundary) and keep only vehicle classes. Throws DetectorError('BAD_RESULT'). */
export function mapNativeDetections(res: { detections?: NativeDetectResult['detections'] } | null | undefined): Detection[] {
  if (!res || !Array.isArray(res.detections)) throw new DetectorError('native result has no detections array', 'BAD_RESULT');
  const out: Detection[] = [];
  for (const d of res.detections) {
    const ok = d && Number.isInteger(d.classId) && inUnit(d.score) && inUnit(d.x) && inUnit(d.y) && inUnit(d.w) && inUnit(d.h) && d.w > 0 && d.h > 0 && d.x + d.w <= 1 + 1e-9 && d.y + d.h <= 1 + 1e-9;
    if (!ok) throw new DetectorError('native result contains an invalid detection', 'BAD_RESULT');
    const cls = CLASS_BY_ID[d.classId];
    if (cls) out.push({ cls, score: d.score, box: { x: d.x, y: d.y, w: d.w, h: d.h } });
  }
  return out;
}

export class NativeDetector implements Detector {
  private busy = false;
  private readonly hp = new DetectorHealthTracker();

  constructor(
    private readonly plugin: NativeDetectorApi,
    private readonly rasterize: Rasterizer = canvasRasterize,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async init(c: DetectorInitConfig): Promise<void> {
    if (c.accelerator !== 'native-cpu') throw new DetectorError(`unsupported accelerator '${c.accelerator}'`, 'BAD_ARGS');
    this.hp.setReady(false);
    try {
      await this.plugin.init({ threads: c.threads ?? 2, scoreThr: c.scoreThr, nmsIou: c.nmsIou });
    } catch (e) {
      throw new DetectorError(messageOf(e), codeOf(e) ?? 'INIT_FAILED');
    }
    this.hp.setReady(true);
  }

  isBusy(): boolean {
    return this.busy;
  }

  health(): DetectorHealth {
    return this.hp.health();
  }

  async detect(f: CapturedFrame): Promise<DetectorResult | null> {
    if (!this.hp.isReady()) throw new DetectorError('not initialised', 'NOT_INITIALISED');
    if (this.busy) return null;
    this.busy = true;
    try {
      const t0 = this.now();
      let b64: string;
      try {
        b64 = bytesToBase64(this.rasterize(f, letterbox416(f.width, f.height)));
      } catch (e) {
        this.hp.recordError();
        throw new DetectorError(messageOf(e), 'RASTERIZE_FAILED');
      }
      const t1 = this.now();

      let res: NativeDetectResult;
      try {
        res = await this.plugin.detect({ rgb: b64, srcW: f.width, srcH: f.height });
      } catch (e) {
        if (codeOf(e) === 'BUSY') return null; // native side is still working: drop this frame, not a failure
        this.hp.recordError();
        throw new DetectorError(messageOf(e), codeOf(e) ?? 'INFER_FAILED');
      }
      const t2 = this.now();

      let detections: Detection[];
      try {
        detections = mapNativeDetections(res);
      } catch (e) {
        this.hp.recordError();
        throw e;
      }
      this.hp.recordSuccess(t2 - t1);
      return {
        seq: f.seq,
        detections,
        preMs: t1 - t0,
        inferMs: res.inferMs,
        postMs: res.decodeMs,
        bridgeMs: Math.max(0, t2 - t1 - res.nativeTotalMs),
      };
    } finally {
      this.busy = false;
    }
  }

  async dispose(): Promise<void> {
    this.hp.setReady(false);
    await this.plugin.dispose();
  }
}
