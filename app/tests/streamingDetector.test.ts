import { describe, expect, it } from 'vitest';
import type { CapturedFrame } from '../src/capture/source';
import { SLOW_P95_MS } from '../src/inference/detectorHealth';
import { StreamingDetector, type ListenerHandle, type NativeStreamApi, type NativeStreamError, type NativeStreamResult } from '../src/inference/streamingDetector';
import { bytesToBase64, RGB_BYTES } from '../src/inference/packFrame';

const frame = (seq: number, width = 1280, height = 720): CapturedFrame => ({
  seq,
  tCaptureMs: 1000 + seq * 100,
  tCaptureEpochMs: 1_792_670_000_000 + seq * 100,
  width,
  height,
  bitmap: {} as ImageBitmap,
});

const rgb = new Uint8Array(RGB_BYTES).map((_, i) => i % 251);
const codeErr = (code: string, msg = code) => Object.assign(new Error(msg), { code });
const CFG = { accelerator: 'native-cpu' as const, scoreThr: 0.35, nmsIou: 0.45 };

const result = (seq: number, over: Partial<NativeStreamResult> = {}): NativeStreamResult => ({
  seq,
  detections: [{ classId: 2, score: 0.8, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }],
  inferMs: 60,
  decodeMs: 2,
  nativeTotalMs: 70,
  queueMs: 20,
  ...over,
});

interface Fake extends NativeStreamApi {
  calls: { init: unknown[]; startStream: number; stopStream: number; submit: { rgb: string; srcW: number; srcH: number; seq: number }[]; dispose: number; removed: number };
  submitImpl: (o: { seq: number }) => Promise<{ accepted: boolean; replaced: boolean }>;
  listenerCount: () => number;
  emitDetection: (e: NativeStreamResult) => void;
  emitError: (e: NativeStreamError) => void;
}

function fakePlugin(): Fake {
  const det: ((e: NativeStreamResult) => void)[] = [];
  const err: ((e: NativeStreamError) => void)[] = [];
  const f: Fake = {
    calls: { init: [], startStream: 0, stopStream: 0, submit: [], dispose: 0, removed: 0 },
    submitImpl: async () => ({ accepted: true, replaced: false }),
    listenerCount: () => det.length + err.length,
    emitDetection: (e) => [...det].forEach((cb) => cb(e)),
    emitError: (e) => [...err].forEach((cb) => cb(e)),
    async init(o) {
      f.calls.init.push(o);
      return { ready: true, accelerator: 'native-cpu', threads: o.threads ?? 0, compileMs: 20 };
    },
    async startStream() {
      f.calls.startStream++;
    },
    async stopStream() {
      f.calls.stopStream++;
    },
    async submit(o) {
      f.calls.submit.push(o);
      return f.submitImpl(o);
    },
    async addListener(event: 'detection' | 'detectorError', cb: never): Promise<ListenerHandle> {
      const list = (event === 'detection' ? det : err) as unknown[];
      list.push(cb);
      return {
        remove: async () => {
          f.calls.removed++;
          const i = list.indexOf(cb);
          if (i >= 0) list.splice(i, 1);
        },
      };
    },
    async dispose() {
      f.calls.dispose++;
    },
  };
  return f;
}

function make(plugin = fakePlugin(), rasterize = () => rgb, clock?: () => number) {
  const d = new StreamingDetector(plugin, rasterize, clock);
  return { d, plugin };
}

describe('StreamingDetector lifecycle', () => {
  it('is not healthy before init and refuses to submit', async () => {
    const { d } = make();
    expect(d.health()).toBe('failed');
    await expect(d.submit(frame(1))).rejects.toMatchObject({ code: 'NOT_INITIALISED' });
  });

  it('init sends 2 threads by default, registers two listeners and starts the stream', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    expect(plugin.calls.init).toEqual([{ threads: 2, scoreThr: 0.35, nmsIou: 0.45 }]);
    expect(plugin.listenerCount()).toBe(2);
    expect(plugin.calls.startStream).toBe(1);
    expect(d.health()).toBe('ok');
  });

  it('re-init replaces the listeners instead of stacking them', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    await d.init({ ...CFG, threads: 4 });
    expect(plugin.listenerCount()).toBe(2);
    expect(plugin.calls.init[1]).toMatchObject({ threads: 4 });
  });

  it('rejects other accelerators and cleans up when the native init fails', async () => {
    const { d, plugin } = make();
    await expect(d.init({ ...CFG, accelerator: 'wasm' })).rejects.toMatchObject({ code: 'BAD_ARGS' });
    plugin.startStream = async () => {
      throw codeErr('NOT_INITIALISED', 'no model');
    };
    await expect(d.init(CFG)).rejects.toMatchObject({ code: 'NOT_INITIALISED' });
    expect(plugin.listenerCount()).toBe(0);
    expect(d.health()).toBe('failed');
  });

  it('dispose removes listeners, stops the stream and disposes the model', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    await d.dispose();
    expect(plugin.listenerCount()).toBe(0);
    expect(plugin.calls.stopStream).toBe(1);
    expect(plugin.calls.dispose).toBe(1);
    expect(d.health()).toBe('failed');
    await expect(d.submit(frame(1))).rejects.toMatchObject({ code: 'NOT_INITIALISED' });
  });
});

describe('StreamingDetector submit and results', () => {
  it('posts the packed frame with seq and source size, then maps the result event with timings', async () => {
    let t = 0;
    const rast = () => {
      t += 10; // packing takes 10 ms on the fake clock
      return rgb;
    };
    const { d, plugin } = make(fakePlugin(), rast, () => t);
    await d.init(CFG);
    const got: unknown[] = [];
    d.onResult((r) => got.push(r));

    expect(await d.submit(frame(7, 1280, 720))).toBe('posted');
    expect(plugin.calls.submit).toEqual([{ rgb: bytesToBase64(rgb), srcW: 1280, srcH: 720, seq: 7 }]);
    expect(got).toHaveLength(0); // the result has not arrived yet: submit does not wait for it

    t = 110; // the event arrives 100 ms after the frame was handed over
    plugin.emitDetection(result(7));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      seq: 7,
      tCaptureMs: 1700,
      preMs: 10,
      inferMs: 60,
      postMs: 2,
      queueMs: 20,
      nativeTotalMs: 70,
      detections: [{ cls: 'car', score: 0.8, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }],
    });
    expect((got[0] as { bridgeMs: number }).bridgeMs).toBeCloseTo(10, 6); // 100 - 20 - 70
    expect(d.counters()).toMatchObject({ posted: 1, results: 1, strayEvents: 0 });
  });

  it('finishes reading the bitmap synchronously when called, so the caller may transfer it right afterwards', async () => {
    let rasterised = false;
    const { d } = make(fakePlugin(), () => {
      rasterised = true;
      return rgb;
    });
    await d.init(CFG);
    const p = d.submit(frame(1)); // no await yet
    expect(rasterised).toBe(true); // the frame pixels were already read; only the posting is still pending
    await p;
  });

  it('skips a frame while the previous one is still being posted (backpressure)', async () => {
    const plugin = fakePlugin();
    let release!: () => void;
    plugin.submitImpl = () => new Promise((res) => (release = () => res({ accepted: true, replaced: false })));
    const { d } = make(plugin);
    await d.init(CFG);
    const first = d.submit(frame(1));
    expect(d.isPacking()).toBe(true);
    expect(await d.submit(frame(2))).toBe('skipped');
    expect(plugin.calls.submit).toHaveLength(1);
    release();
    expect(await first).toBe('posted');
    expect(d.isPacking()).toBe(false);
    plugin.submitImpl = async () => ({ accepted: true, replaced: false });
    expect(await d.submit(frame(3))).toBe('posted');
    expect(d.counters()).toMatchObject({ posted: 2, skippedBusy: 1 });
  });

  it('counts frames the native side replaced before processing', async () => {
    const plugin = fakePlugin();
    plugin.submitImpl = async () => ({ accepted: true, replaced: true });
    const { d } = make(plugin);
    await d.init(CFG);
    await d.submit(frame(1));
    await d.submit(frame(2));
    expect(d.counters().replacedNative).toBe(2);
  });

  it('ignores events with no matching submission and forgets older frames when a newer result arrives', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    const seqs: number[] = [];
    d.onResult((r) => seqs.push(r.seq));
    plugin.emitDetection(result(99)); // never submitted
    await d.submit(frame(1));
    await d.submit(frame(2));
    await d.submit(frame(3));
    plugin.emitDetection(result(3)); // frames 1 and 2 were replaced natively; they will never produce results
    plugin.emitDetection(result(2)); // a late/duplicate older event must be ignored
    expect(seqs).toEqual([3]);
    expect(d.counters()).toMatchObject({ results: 1, strayEvents: 2 });
  });

  it('bounds the pending table (oldest entries are forgotten)', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    const seqs: number[] = [];
    d.onResult((r) => seqs.push(r.seq));
    for (let i = 0; i < 20; i++) await d.submit(frame(i));
    plugin.emitDetection(result(2)); // entry 2 was evicted
    plugin.emitDetection(result(19));
    expect(seqs).toEqual([19]);
  });

  it('keeps person and the four vehicle classes and rejects malformed native results', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    const got: { detections: unknown[] }[] = [];
    const errors: NativeStreamError[] = [];
    d.onResult((r) => got.push(r));
    d.onError((e) => errors.push(e));
    await d.submit(frame(1));
    plugin.emitDetection(result(1, { detections: [2, 3, 5, 7, 0, 1].map((classId) => ({ classId, score: 0.9, x: 0.1, y: 0.1, w: 0.1, h: 0.1 })) }));
    expect(got[0]!.detections).toHaveLength(5);

    await d.submit(frame(2));
    plugin.emitDetection(result(2, { detections: [{ classId: 2, score: 2, x: 0, y: 0, w: 0.1, h: 0.1 }] }));
    expect(errors).toEqual([{ seq: 2, code: 'BAD_RESULT', message: expect.any(String) }]);
    expect(got).toHaveLength(1);
  });
});

describe('StreamingDetector.submitPacked (frame packed by a worker)', () => {
  const packed = (seq: number, over = {}) => ({ rgb64: 'QUJD', seq, srcW: 1280, srcH: 720, tCaptureMs: 1000 + seq * 100, preMs: 48, ...over });

  it('posts the ready string without touching the rasteriser, and maps the result with the caller\'s preMs', async () => {
    let t = 0;
    let rasterised = false;
    const { d, plugin } = make(fakePlugin(), () => {
      rasterised = true;
      return rgb;
    }, () => t);
    await d.init(CFG);
    const got: { preMs: number; seq: number; tCaptureMs: number; bridgeMs: number }[] = [];
    d.onResult((r) => got.push(r));

    t = 1000;
    expect(await d.submitPacked(packed(5))).toBe('posted');
    expect(rasterised).toBe(false);
    expect(plugin.calls.submit).toEqual([{ rgb: 'QUJD', srcW: 1280, srcH: 720, seq: 5 }]);

    t = 1100; // the event arrives 100 ms after posting
    plugin.emitDetection(result(5));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ seq: 5, tCaptureMs: 1500, preMs: 48 });
    expect(got[0]!.bridgeMs).toBeCloseTo(10, 6); // 100 - queue 20 - native 70
  });

  it('measures how long the submit call took to be acknowledged', async () => {
    let t = 0;
    const plugin = fakePlugin();
    plugin.submitImpl = async () => {
      t += 37; // the bridge hand-over takes 37 ms on the fake clock
      return { accepted: true, replaced: false };
    };
    const { d } = make(plugin, () => rgb, () => t);
    await d.init(CFG);
    const got: { postAckMs?: number }[] = [];
    d.onResult((r) => got.push(r));
    await d.submitPacked(packed(1));
    plugin.emitDetection(result(1));
    expect(got[0]!.postAckMs).toBe(37);
  });

  it('shares the backpressure flag with submit(): skipped while a post is in flight', async () => {
    const plugin = fakePlugin();
    let release!: () => void;
    plugin.submitImpl = () => new Promise((res) => (release = () => res({ accepted: true, replaced: false })));
    const { d } = make(plugin);
    await d.init(CFG);
    const first = d.submitPacked(packed(1));
    expect(d.isPacking()).toBe(true);
    expect(await d.submitPacked(packed(2))).toBe('skipped');
    expect(await d.submit(frame(3))).toBe('skipped');
    expect(plugin.calls.submit).toHaveLength(1);
    release();
    expect(await first).toBe('posted');
    expect(d.counters()).toMatchObject({ posted: 1, skippedBusy: 2 });
  });

  it('refuses before init, and a failed post throws with the plugin code and frees the slot', async () => {
    const plugin = fakePlugin();
    const { d } = make(plugin);
    await expect(d.submitPacked(packed(1))).rejects.toMatchObject({ code: 'NOT_INITIALISED' });
    await d.init(CFG);
    plugin.submitImpl = async () => {
      throw codeErr('NOT_STREAMING', 'stream not started');
    };
    await expect(d.submitPacked(packed(2))).rejects.toMatchObject({ code: 'NOT_STREAMING' });
    expect(d.isPacking()).toBe(false);
  });
});

describe('StreamingDetector errors and health', () => {
  it('a rejected submit throws a DetectorError with the plugin code and frees the slot', async () => {
    const plugin = fakePlugin();
    plugin.submitImpl = async () => {
      throw codeErr('NOT_STREAMING', 'stream not started');
    };
    const { d } = make(plugin);
    await d.init(CFG);
    await expect(d.submit(frame(1))).rejects.toMatchObject({ code: 'NOT_STREAMING', message: 'stream not started' });
    expect(d.isPacking()).toBe(false);
    // a late event for that frame is stray, not a result
    d.onResult(() => {
      throw new Error('should not be called');
    });
    plugin.emitDetection(result(1));
    expect(d.counters().strayEvents).toBe(1);
  });

  it('counts rasteriser failures', async () => {
    const { d } = make(fakePlugin(), () => {
      throw new Error('bitmap closed');
    });
    await d.init(CFG);
    await expect(d.submit(frame(1))).rejects.toMatchObject({ code: 'RASTERIZE_FAILED' });
    expect(d.isPacking()).toBe(false);
  });

  it('native error events reach onError, count toward failed health after 3, and a success recovers', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    const errors: NativeStreamError[] = [];
    d.onError((e) => errors.push(e));
    for (let i = 1; i <= 3; i++) {
      await d.submit(frame(i));
      plugin.emitError({ seq: i, code: 'INFER_FAILED', message: 'boom' });
    }
    expect(errors).toHaveLength(3);
    expect(d.health()).toBe('failed');
    await d.submit(frame(10));
    plugin.emitDetection(result(10));
    expect(d.health()).toBe('ok');
  });

  it('reports slow when the p95 submit-to-result time exceeds the budget, after enough samples', async () => {
    let t = 0;
    const { d, plugin } = make(fakePlugin(), () => rgb, () => t);
    await d.init(CFG);
    for (let i = 0; i < 12; i++) {
      t = i * 1000;
      await d.submit(frame(i));
      t += SLOW_P95_MS + 100;
      plugin.emitDetection(result(i));
      if (i < 9) expect(d.health()).toBe('ok');
    }
    expect(d.health()).toBe('slow');
  });
});
