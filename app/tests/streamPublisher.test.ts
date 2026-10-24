import { describe, expect, it } from 'vitest';
import type { PipelineSnapshot } from '../src/pipeline/pipeline';
import { StreamPublisher, type LocalServerApi } from '../src/server/streamPublisher';
import type { StreamJpeg } from '../src/stream/frameFeeder';
import { decodeFrame, encodeFrame } from '../src/stream/frameCodec';
import { OK } from './helpers';

const snap = (over: Partial<PipelineSnapshot> = {}): PipelineSnapshot =>
  ({
    running: true,
    alert: { level: 'VEHICLE_NEARBY', reasons: ['car track 7 confirmed'], trackIds: [7], tMs: 1, health: OK },
    tracks: [{ id: 7, cls: 'car', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, score: 0.8, state: 'confirmed', ageFrames: 9, missedFrames: 0, history: [{ tMs: 1, cx: 0.5, cy: 0.5, h: 0.2 }] }],
    detections: [{ cls: 'car', score: 0.8, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }],
    health: OK,
    detectionsPerSec: 4.56,
    latencyMs: { median: 240, p95: 262.4 },
    modelMs: { median: 163.2, baseline: 90 },
    load: { minGapMs: 250, maxRatePerSec: 4, latencyGapMs: 125, thermalFloorMs: 250, p95Ms: 262, reason: 'thermal cap' },
    counters: { frames: 100, paced: 40, results: 50, outOfOrder: 0, detectorErrors: 0, feeder: { offered: 60, droppedBusy: 3, droppedStopped: 0, packed: 57, replacedWaiting: 0, posted: 57, skippedByDetector: 0, packErrors: 0, postErrors: 0 } },
    lastError: null,
    lastResult: { seq: 40, tCaptureMs: 9_800 },
    nowMs: 10_000,
    ...over,
  }) as PipelineSnapshot;

const jpeg = (seq = 42): StreamJpeg => ({ seq, tCaptureMs: 10_000, tCaptureEpochMs: 1_700_000_000_000, tEncodeMs: 10_020, w: 640, h: 360, quality: 0.6, bytes: new Uint8Array([0xff, 0xd8, 9, 9]) });

function fakeApi() {
  const frames: { seq: number; meta: string; jpeg: string }[] = [];
  const statuses: string[] = [];
  const releases: (() => void)[] = [];
  let hold = false;
  let fail = false;
  const api: LocalServerApi = {
    publishFrame: (o) => {
      frames.push(o);
      if (fail) return Promise.reject(new Error('NOT_RUNNING'));
      return hold ? new Promise<void>((r) => releases.push(r)) : Promise.resolve();
    },
    publishRearStatus: (o) => {
      statuses.push(o.json);
      return Promise.resolve();
    },
  };
  return { api, frames, statuses, releases, hold: (h: boolean) => (hold = h), fail: (f: boolean) => (fail = f) };
}

describe('StreamPublisher', () => {
  it('builds a FrameMeta that survives the RVF1 codec, with the detection lag explicit and track history stripped', () => {
    const { api } = fakeApi();
    const p = new StreamPublisher(api, () => snap());
    const meta = p.buildMeta(jpeg(), snap());
    expect(meta).toMatchObject({ v: 1, seq: 42, w: 640, h: 360, jpegQuality: 0.6, detSeq: 40, detAgeMs: 200 });
    expect(meta.tracks[0]).not.toHaveProperty('history');
    const round = decodeFrame(encodeFrame(meta, new Uint8Array([0xff, 0xd8, 1])));
    expect(round.meta.alert.level).toBe('VEHICLE_NEARBY');
    expect(round.meta.tracks).toHaveLength(1);
  });

  it('has null detSeq/detAgeMs before any detection, and never a negative age', () => {
    const { api } = fakeApi();
    const p = new StreamPublisher(api, () => snap());
    expect(p.buildMeta(jpeg(), snap({ lastResult: null }))).toMatchObject({ detSeq: null, detAgeMs: null });
    expect(p.buildMeta(jpeg(), snap({ lastResult: { seq: 50, tCaptureMs: 10_500 } })).detAgeMs).toBe(0);
  });

  it('publishes meta and base64 JPEG through the plugin; only one call in flight, extras are dropped and counted', async () => {
    const f = fakeApi();
    const p = new StreamPublisher(f.api, () => snap());
    f.hold(true);
    p.publish(jpeg(1));
    p.publish(jpeg(2));
    p.publish(jpeg(3));
    expect(f.frames.map((x) => x.seq)).toEqual([1]);
    expect(f.frames[0]!.jpeg).toBe('/9gJCQ==');
    expect(JSON.parse(f.frames[0]!.meta).seq).toBe(1);
    expect(p.counters().droppedBackpressure).toBe(2);
    f.releases[0]!();
    await Promise.resolve();
    await Promise.resolve();
    p.publish(jpeg(4));
    expect(f.frames.map((x) => x.seq)).toEqual([1, 4]);
    expect(p.counters().published).toBe(1);
  });

  it('survives plugin errors: counts them, frees the slot, keeps the message', async () => {
    const f = fakeApi();
    const p = new StreamPublisher(f.api, () => snap());
    f.fail(true);
    p.publish(jpeg(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(p.counters()).toMatchObject({ errors: 1, lastError: 'NOT_RUNNING' });
    f.fail(false);
    p.publish(jpeg(2));
    expect(f.frames).toHaveLength(2);
  });

  it('sends a rear status with alert, health, rates and drops; capture fps comes from the frame counter', () => {
    const f = fakeApi();
    let frames = 100;
    const p = new StreamPublisher(f.api, () => snap({ counters: { ...snap().counters, frames } }));
    p.publishStatus(1_700_000_000_000, 10_000);
    frames = 115;
    p.publishStatus(1_700_000_001_000, 11_000);
    const second = JSON.parse(f.statuses[1]!);
    expect(second).toMatchObject({ tEpochMs: 1_700_000_001_000, captureFps: 15, inferFps: 4.6, inferP95Ms: 262, modelMs: 163, droppedCapture: 43, droppedBackpressure: 0 });
    expect(second.alert.level).toBe('VEHICLE_NEARBY');
    expect(second.health.thermal).toBe('ok');
    expect(JSON.parse(f.statuses[0]!).captureFps).toBe(0);
  });

  it('copes with NaN rates before the first results', () => {
    const f = fakeApi();
    const p = new StreamPublisher(f.api, () => snap({ detectionsPerSec: NaN, latencyMs: { median: NaN, p95: NaN }, modelMs: { median: NaN, baseline: 90 } }));
    p.publishStatus(1, 1);
    expect(JSON.parse(f.statuses[0]!)).toMatchObject({ inferFps: 0, inferP95Ms: 0, modelMs: 0 });
  });
});
