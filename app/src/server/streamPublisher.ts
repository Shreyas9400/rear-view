// Rear side of the viewer stream (docs/PROTOCOL_SPEC.md §5-7, D-032): turns the pipeline's newest state plus each stream JPEG
// into a FrameMeta and hands it to the native LocalServer through plugin calls; sends a 1 Hz rear_status. At most one frame call
// is in flight: a frame that arrives meanwhile is dropped and counted (the viewer wants the newest, not a backlog).

import { bytesToBase64 } from '../inference/packFrame';
import type { PipelineSnapshot } from '../pipeline/pipeline';
import type { FrameMeta, Track } from '../shared/types';
import type { StreamJpeg } from '../stream/frameFeeder';

export interface LocalServerApi {
  publishFrame(o: { seq: number; meta: string; jpeg: string }): Promise<void>;
  publishRearStatus(o: { json: string }): Promise<void>;
}

export interface PublisherCounters {
  published: number;
  droppedBackpressure: number;
  errors: number;
  lastError: string | null;
}

const stripHistory = (t: Track): Omit<Track, 'history'> => {
  const { history: _history, ...rest } = t;
  return rest;
};

export class StreamPublisher {
  private inFlight = false;
  private readonly c: PublisherCounters = { published: 0, droppedBackpressure: 0, errors: 0, lastError: null };
  private lastStatus: { atMs: number; frames: number } | null = null;

  constructor(
    private readonly api: LocalServerApi,
    private readonly getSnapshot: () => PipelineSnapshot,
  ) {}

  counters(): PublisherCounters {
    return { ...this.c };
  }

  /** Builds the wire metadata for a JPEG from the pipeline's newest state. Exposed for tests. */
  buildMeta(j: StreamJpeg, s: PipelineSnapshot): FrameMeta {
    const det = s.lastResult;
    return {
      v: 1,
      seq: j.seq,
      tCaptureMs: j.tCaptureMs,
      tCaptureEpochMs: j.tCaptureEpochMs,
      tEncodeMs: j.tEncodeMs,
      w: j.w,
      h: j.h,
      jpegQuality: j.quality,
      detSeq: det ? det.seq : null,
      detAgeMs: det ? Math.max(0, j.tCaptureMs - det.tCaptureMs) : null,
      detections: s.detections,
      tracks: s.tracks.map(stripHistory) as unknown as Track[],
      alert: s.alert,
    };
  }

  publish(j: StreamJpeg): void {
    if (this.inFlight) {
      this.c.droppedBackpressure++;
      return;
    }
    this.inFlight = true;
    let meta: string;
    let jpeg: string;
    try {
      meta = JSON.stringify(this.buildMeta(j, this.getSnapshot()));
      jpeg = bytesToBase64(j.bytes);
    } catch (e) {
      this.inFlight = false;
      this.fail(e);
      return;
    }
    this.api.publishFrame({ seq: j.seq, meta, jpeg }).then(
      () => {
        this.c.published++;
        this.inFlight = false;
      },
      (e: unknown) => {
        this.inFlight = false;
        this.fail(e);
      },
    );
  }

  /** Call about once per second. */
  publishStatus(epochNowMs: number, nowMs: number): void {
    const s = this.getSnapshot();
    const frames = s.counters.frames;
    const prev = this.lastStatus;
    const captureFps = prev && nowMs > prev.atMs ? ((frames - prev.frames) * 1000) / (nowMs - prev.atMs) : 0;
    this.lastStatus = { atMs: nowMs, frames };
    const rear = {
      tEpochMs: epochNowMs,
      alert: s.alert,
      health: s.health,
      captureFps: round1(captureFps),
      inferFps: round1(s.detectionsPerSec),
      // frame-to-result latency p95 (the model's own time is in modelMs)
      inferP95Ms: Number.isFinite(s.latencyMs.p95) ? Math.round(s.latencyMs.p95) : 0,
      modelMs: Number.isFinite(s.modelMs.median) ? Math.round(s.modelMs.median) : 0,
      droppedCapture: s.counters.paced + s.counters.feeder.droppedBusy,
      droppedBackpressure: this.c.droppedBackpressure,
    };
    this.api.publishRearStatus({ json: JSON.stringify(rear) }).catch((e: unknown) => this.fail(e));
  }

  private fail(e: unknown): void {
    this.c.errors++;
    this.c.lastError = String((e as { message?: string })?.message ?? e).slice(0, 160);
  }
}

const round1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
