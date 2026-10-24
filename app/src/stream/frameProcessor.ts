// Per-frame work off the main thread (docs/TECHNICAL_DECISIONS.md D-027, D-028). One dedicated Worker takes ownership of the
// frame's ImageBitmap and does, in order: (1) pack: letterbox to 416x416, drop alpha, base64, posted back at once so the
// detector is fed as early as possible; (2) optionally JPEG-encode the same bitmap for the stream. The main thread then only
// calls plugin.submit() with a ready string. This replaces the earlier JPEG-only worker (D-027).
//
// Ownership: process() TRANSFERS the bitmap (no pixel copy); the worker closes it. After a call that returned a job the caller
// must not use or close the bitmap (draw or read from it BEFORE calling). If the worker is busy, process() returns null and
// the caller keeps ownership. One job in flight at a time; a 5 s watchdog replaces a worker that goes silent.

export interface FrameRequest {
  id: number;
  bitmap: ImageBitmap;
  srcW: number;
  srcH: number;
  /** Produce the letterboxed 416x416 frame as a base64 string (raw RGB or a JPEG, see packFormat). */
  pack: boolean;
  /** 'rgb' (default): 519,168 raw bytes (692 KB as base64). 'jpeg': a 416x416 JPEG (tens of KB), decoded natively; lossy (D-030). */
  packFormat?: PackFormat;
  /** JPEG quality 0..1 for packFormat 'jpeg' (default 0.9). */
  packQuality?: number;
  /** Also JPEG-encode the frame at this size (aspect ratio is the caller's responsibility). */
  jpeg: { width: number; height: number; quality: number } | null;
}

export type PackFormat = 'rgb' | 'jpeg';

export type FrameResponse =
  | { id: number; kind: 'pack'; rgb64: string; packMs: number; format?: PackFormat }
  | { id: number; kind: 'jpeg'; bytes: ArrayBuffer; encodeMs: number }
  | { id: number; kind: 'error'; stage: 'pack' | 'jpeg'; message: string };

export interface PackResult {
  rgb64: string;
  /** What the string contains. */
  format: PackFormat;
  /** Time inside the worker (draw + readback + RGB + base64). */
  packMs: number;
  /** Time from process() until the packed string was available on the main thread. */
  roundTripMs: number;
}

export interface JpegResult {
  bytes: Uint8Array;
  encodeMs: number;
  roundTripMs: number;
}

export type FrameErrorCode = 'WORKER_ERROR' | 'PACK_FAILED' | 'JPEG_FAILED' | 'TIMEOUT' | 'DISPOSED';

export class FrameProcessorError extends Error {
  constructor(
    message: string,
    readonly code: FrameErrorCode,
  ) {
    super(message);
    this.name = 'FrameProcessorError';
  }
}

export interface FrameJob {
  /** Resolves null when packing was not requested. */
  pack: Promise<PackResult | null>;
  /** Resolves null when JPEG was not requested. */
  jpeg: Promise<JpegResult | null>;
}

/** The subset of Worker that the processor uses (so tests can supply a fake). */
export interface WorkerLike {
  postMessage(msg: FrameRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: FrameResponse }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

export const DEFAULT_TIMEOUT_MS = 5000;

const defaultFactory = (): WorkerLike => new Worker(new URL('./frameWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;

interface Stage<T> {
  resolve: (v: T | null) => void;
  reject: (e: Error) => void;
}

interface InFlight {
  id: number;
  t0: number;
  pack: Stage<PackResult> | null;
  jpeg: Stage<JpegResult> | null;
  timer: ReturnType<typeof setTimeout>;
}

export class FrameProcessor {
  private worker: WorkerLike | null = null;
  private inFlight: InFlight | null = null;
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly factory: () => WorkerLike = defaultFactory,
    private readonly now: () => number = () => performance.now(),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /** True from process() until every requested stage has finished. */
  isBusy(): boolean {
    return this.inFlight !== null;
  }

  /** Returns null (bitmap NOT consumed) when busy. Otherwise the bitmap now belongs to the worker. */
  process(bitmap: ImageBitmap, srcW: number, srcH: number, o: { pack: boolean; packFormat?: PackFormat; packQuality?: number; jpeg?: { width: number; height: number; quality: number } }): FrameJob | null {
    if (this.disposed) throw new FrameProcessorError('processor disposed', 'DISPOSED');
    if (this.inFlight) return null;
    if (!o.pack && !o.jpeg) throw new Error('nothing requested');
    const w = this.ensureWorker();
    const id = this.nextId++;

    let packStage: Stage<PackResult> | null = null;
    let jpegStage: Stage<JpegResult> | null = null;
    const pack = o.pack ? new Promise<PackResult | null>((resolve, reject) => (packStage = { resolve, reject })) : Promise.resolve(null);
    const jpeg = o.jpeg ? new Promise<JpegResult | null>((resolve, reject) => (jpegStage = { resolve, reject })) : Promise.resolve(null);
    // A caller that only awaits one stage must not trigger an "unhandled rejection" for the other.
    pack.catch(() => undefined);
    jpeg.catch(() => undefined);

    const timer = setTimeout(() => this.failAll(id, new FrameProcessorError(`no answer within ${this.timeoutMs} ms`, 'TIMEOUT'), true), this.timeoutMs);
    this.inFlight = { id, t0: this.now(), pack: packStage, jpeg: jpegStage, timer };
    try {
      w.postMessage({ id, bitmap, srcW, srcH, pack: o.pack, packFormat: o.packFormat, packQuality: o.packQuality, jpeg: o.jpeg ?? null }, [bitmap]);
    } catch (e) {
      this.failAll(id, new FrameProcessorError(String((e as Error)?.message ?? e), 'WORKER_ERROR'), true);
    }
    return { pack, jpeg };
  }

  dispose(): void {
    this.disposed = true;
    if (this.inFlight) this.failAll(this.inFlight.id, new FrameProcessorError('processor disposed', 'DISPOSED'), false);
    this.killWorker();
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.factory();
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => {
      if (this.inFlight) this.failAll(this.inFlight.id, new FrameProcessorError(e.message ?? 'worker error', 'WORKER_ERROR'), true);
      else this.killWorker();
    };
    this.worker = w;
    return w;
  }

  private onMessage(r: FrameResponse): void {
    const f = this.inFlight;
    if (!f || f.id !== r.id) return; // late answer from a job that already failed
    if (r.kind === 'pack' && f.pack) {
      f.pack.resolve({ rgb64: r.rgb64, format: r.format ?? 'rgb', packMs: r.packMs, roundTripMs: this.now() - f.t0 });
      f.pack = null;
    } else if (r.kind === 'jpeg' && f.jpeg) {
      f.jpeg.resolve({ bytes: new Uint8Array(r.bytes), encodeMs: r.encodeMs, roundTripMs: this.now() - f.t0 });
      f.jpeg = null;
    } else if (r.kind === 'error') {
      // The worker survived (it closed the bitmap); only this job fails.
      this.failAll(f.id, new FrameProcessorError(r.message, r.stage === 'pack' ? 'PACK_FAILED' : 'JPEG_FAILED'), false);
      return;
    }
    if (!f.pack && !f.jpeg) {
      clearTimeout(f.timer);
      this.inFlight = null;
    }
  }

  /** Reject every stage still waiting; optionally discard the worker so the next call starts a fresh one. */
  private failAll(id: number, err: Error, restartWorker: boolean): void {
    const f = this.inFlight;
    if (!f || f.id !== id) return;
    clearTimeout(f.timer);
    this.inFlight = null;
    f.pack?.reject(err);
    f.jpeg?.reject(err);
    if (restartWorker) this.killWorker();
  }

  private killWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
  }
}
