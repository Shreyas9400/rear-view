// Two-stage frame feeder (docs/TECHNICAL_DECISIONS.md D-030): pack in the worker, post to the native detector, and overlap the
// two so that frame N+1 is being packed while frame N is being posted. Before this, the chain was strictly serial (pack, then
// post, then wait for the next camera frame), which capped the feed at about 1 / (pack + acknowledgement).
//
// Bounded by construction: at most ONE frame being packed (the FrameProcessor is single-flight), ONE frame being posted, and
// ONE packed frame waiting (a newer packed frame replaces an older waiting one: latest-frame-wins). Camera frames that arrive
// while the worker is busy are dropped and their bitmaps closed. The feeder owns every bitmap it is given.

import type { CapturedFrame } from '../capture/source';
import type { PackedFrame, StreamingDetector } from '../inference/streamingDetector';
import type { FrameProcessor, PackFormat } from './frameProcessor';

export interface FeederOptions {
  /** 'rgb' (raw, 692 KB base64) or 'jpeg' (compact, decoded natively; D-030). */
  packFormat: PackFormat;
  /** JPEG quality 0..1 for packFormat 'jpeg'. */
  packQuality?: number;
  /** Also produce a JPEG of every accepted frame for the viewer stream (same worker job, so detection is fed first). */
  /** `wanted` is asked per frame; return false while nobody is watching so the JPEG costs nothing. */
  stream?: { width: number; quality: number; wanted?: () => boolean };
}

export interface StreamJpeg {
  seq: number;
  tCaptureMs: number;
  tCaptureEpochMs: number;
  /** performance.now() on the main thread when the JPEG arrived. */
  tEncodeMs: number;
  w: number;
  h: number;
  quality: number;
  bytes: Uint8Array;
}

export interface FeederCounters {
  offered: number;
  /** Frames dropped because the worker was still busy with the previous frame. */
  droppedBusy: number;
  /** Frames closed because the feeder was stopped (pipeline stopped or not yet started). */
  droppedStopped: number;
  packed: number;
  /** Packed frames replaced in the waiting slot before they could be posted. */
  replacedWaiting: number;
  posted: number;
  /** submitPacked answered 'skipped' (should not happen: the feeder posts one at a time). */
  skippedByDetector: number;
  packErrors: number;
  postErrors: number;
}

export type FeederOutcome = 'packing' | 'dropped';

export class FrameFeeder {
  private posting = false;
  private waiting: PackedFrame | null = null;
  private stopped = false;
  private streamCbs: ((j: StreamJpeg) => void)[] = [];
  private errorCbs: ((e: { stage: 'pack' | 'post'; code?: string; message: string }) => void)[] = [];
  private readonly c: FeederCounters = { offered: 0, droppedBusy: 0, droppedStopped: 0, packed: 0, replacedWaiting: 0, posted: 0, skippedByDetector: 0, packErrors: 0, postErrors: 0 };

  constructor(
    private readonly fp: FrameProcessor,
    private readonly det: StreamingDetector,
    private readonly opts: FeederOptions = { packFormat: 'jpeg', packQuality: 0.9 }, // the compact payload is the measured default (D-030)
  ) {}

  onError(cb: (e: { stage: 'pack' | 'post'; code?: string; message: string }) => void): void {
    this.errorCbs.push(cb);
  }

  onStreamFrame(cb: (j: StreamJpeg) => void): void {
    this.streamCbs.push(cb);
  }

  counters(): FeederCounters {
    return { ...this.c };
  }

  /**
   * Hand over a camera frame. The feeder takes ownership of the bitmap in every case (it is transferred to the worker, or closed
   * if the frame is dropped); the caller must not use it afterwards. Read anything you need from the bitmap BEFORE calling.
   */
  offer(frame: CapturedFrame): FeederOutcome {
    this.c.offered++;
    if (this.stopped) {
      this.c.droppedStopped++;
      frame.bitmap.close();
      return 'dropped';
    }
    const wantStream = !!this.opts.stream && (this.opts.stream.wanted?.() ?? true);
    let job;
    try {
      job = this.fp.process(frame.bitmap, frame.width, frame.height, {
        pack: true,
        packFormat: this.opts.packFormat,
        packQuality: this.opts.packQuality,
        ...(wantStream && this.opts.stream ? { jpeg: { width: this.opts.stream.width, height: Math.max(1, Math.round((this.opts.stream.width * frame.height) / frame.width)), quality: this.opts.stream.quality } } : {}),
      });
    } catch (e) {
      frame.bitmap.close();
      this.c.packErrors++;
      this.emit({ stage: 'pack', code: (e as { code?: string }).code, message: String((e as Error).message) });
      return 'dropped';
    }
    if (!job) {
      frame.bitmap.close();
      this.c.droppedBusy++;
      return 'dropped';
    }
    job.pack.then(
      (p) => {
        if (!p) return;
        this.c.packed++;
        this.onPacked({ rgb64: p.rgb64, format: p.format, seq: frame.seq, srcW: frame.width, srcH: frame.height, tCaptureMs: frame.tCaptureMs, preMs: p.roundTripMs });
      },
      (e: unknown) => {
        this.c.packErrors++;
        this.emit({ stage: 'pack', code: (e as { code?: string }).code, message: String((e as Error).message) });
      },
    );
    if (wantStream && this.opts.stream) {
      const { width, quality } = this.opts.stream;
      job.jpeg.then(
        (j) => {
          if (!j || this.stopped) return;
          const h = Math.max(1, Math.round((width * frame.height) / frame.width));
          const out: StreamJpeg = { seq: frame.seq, tCaptureMs: frame.tCaptureMs, tCaptureEpochMs: frame.tCaptureEpochMs, tEncodeMs: performance.now(), w: width, h, quality, bytes: j.bytes };
          for (const cb of this.streamCbs) cb(out);
        },
        (e: unknown) => {
          this.emit({ stage: 'pack', code: (e as { code?: string }).code, message: `stream jpeg: ${String((e as Error).message)}` });
        },
      );
    }
    return 'packing';
  }

  /** Resume feeding after stop(). */
  start(): void {
    this.stopped = false;
  }

  /** Stop feeding: a waiting packed frame is discarded; frames offered afterwards are closed. Does not dispose the processor or detector. */
  stop(): void {
    this.stopped = true;
    this.waiting = null;
  }

  private onPacked(p: PackedFrame): void {
    if (this.stopped) return;
    if (this.posting) {
      if (this.waiting) this.c.replacedWaiting++;
      this.waiting = p; // newest wins
      return;
    }
    this.post(p);
  }

  private post(p: PackedFrame): void {
    this.posting = true;
    this.det
      .submitPacked(p)
      .then(
        (r) => {
          if (r === 'posted') this.c.posted++;
          else this.c.skippedByDetector++;
        },
        (e: unknown) => {
          this.c.postErrors++;
          this.emit({ stage: 'post', code: (e as { code?: string }).code, message: String((e as Error).message) });
        },
      )
      .finally(() => {
        this.posting = false;
        const next = this.waiting;
        this.waiting = null;
        if (next && !this.stopped) this.post(next);
      });
  }

  private emit(e: { stage: 'pack' | 'post'; code?: string; message: string }): void {
    for (const cb of this.errorCbs) cb(e);
  }
}
