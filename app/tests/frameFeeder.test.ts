import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedFrame } from '../src/capture/source';
import { StreamingDetector, type ListenerHandle, type NativeStreamApi } from '../src/inference/streamingDetector';
import { FrameFeeder } from '../src/stream/frameFeeder';
import { FrameProcessor, type FrameRequest, type FrameResponse, type WorkerLike } from '../src/stream/frameProcessor';

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: FrameResponse }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  posted: FrameRequest[] = [];
  postMessage(msg: FrameRequest): void {
    this.posted.push(msg);
  }
  terminate(): void {}
  /** Answer the n-th request with a packed frame. */
  pack(n: number, rgb64 = `P${n}`, format: 'rgb' | 'jpeg' = 'rgb'): void {
    this.onmessage?.({ data: { id: this.posted[n]!.id, kind: 'pack', rgb64, packMs: 30, format } });
  }
  jpeg(n: number, bytes = new Uint8Array([0xff, 0xd8, 1, 2]).buffer): void {
    this.onmessage?.({ data: { id: this.posted[n]!.id, kind: 'jpeg', bytes, encodeMs: 12 } });
  }
  packError(n: number): void {
    this.onmessage?.({ data: { id: this.posted[n]!.id, kind: 'error', stage: 'pack', message: 'no 2d' } });
  }
}

function frame(seq: number): CapturedFrame & { closed: () => number } {
  let closed = 0;
  return {
    seq,
    tCaptureMs: 1000 + seq * 100,
    tCaptureEpochMs: 0,
    width: 1280,
    height: 720,
    bitmap: { close: () => void closed++ } as unknown as ImageBitmap,
    closed: () => closed,
  };
}

interface Plugin extends NativeStreamApi {
  submits: { rgb: string; seq: number; format?: string }[];
  releases: (() => void)[];
  hold: boolean;
  failNext: boolean;
}

function fakePlugin(): Plugin {
  const p: Plugin = {
    submits: [],
    releases: [],
    hold: false,
    failNext: false,
    async init(o) {
      return { ready: true, accelerator: 'native-cpu', threads: o.threads ?? 0, compileMs: 1 };
    },
    async startStream() {},
    async stopStream() {},
    async submit(o) {
      p.submits.push({ rgb: o.rgb, seq: o.seq, format: o.format });
      if (p.failNext) {
        p.failNext = false;
        throw Object.assign(new Error('bridge down'), { code: 'SUBMIT_FAILED' });
      }
      if (p.hold) return new Promise((res) => p.releases.push(() => res({ accepted: true, replaced: false })));
      return { accepted: true, replaced: false };
    },
    async addListener(): Promise<ListenerHandle> {
      return { remove: async () => {} };
    },
    async dispose() {},
  };
  return p;
}

async function setup(opts: ConstructorParameters<typeof FrameFeeder>[2] = { packFormat: 'rgb' }) {
  const worker = new FakeWorker();
  const fp = new FrameProcessor(() => worker);
  const plugin = fakePlugin();
  const det = new StreamingDetector(plugin, () => new Uint8Array(0));
  await det.init({ accelerator: 'native-cpu', scoreThr: 0.35, nmsIou: 0.45 });
  const feeder = new FrameFeeder(fp, det, opts);
  return { worker, plugin, det, feeder };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FrameFeeder', () => {
  it('packs in the worker and posts the packed string when the detector is idle', async () => {
    const { worker, plugin, feeder } = await setup();
    const f = frame(1);
    expect(feeder.offer(f)).toBe('packing');
    expect(worker.posted[0]).toMatchObject({ pack: true, packFormat: 'rgb', srcW: 1280, srcH: 720 });
    expect(plugin.submits).toHaveLength(0); // nothing packed yet
    worker.pack(0, 'AAAA');
    await flush();
    expect(plugin.submits).toEqual([{ rgb: 'AAAA', seq: 1, format: undefined }]);
    expect(feeder.counters()).toMatchObject({ offered: 1, packed: 1, posted: 1 });
    expect(f.closed()).toBe(0); // ownership went to the worker, which closes it
  });

  it('asks for the compact JPEG format and forwards it to the plugin', async () => {
    const { worker, plugin, feeder } = await setup({ packFormat: 'jpeg', packQuality: 0.85 });
    feeder.offer(frame(1));
    expect(worker.posted[0]).toMatchObject({ pack: true, packFormat: 'jpeg', packQuality: 0.85 });
    worker.pack(0, '/9j/4AAQ', 'jpeg');
    await flush();
    expect(plugin.submits[0]).toMatchObject({ rgb: '/9j/4AAQ', format: 'jpeg' });
  });

  it('drops and closes a frame while the worker is busy', async () => {
    const { worker, feeder } = await setup();
    feeder.offer(frame(1));
    const f2 = frame(2);
    expect(feeder.offer(f2)).toBe('dropped');
    expect(f2.closed()).toBe(1);
    expect(worker.posted).toHaveLength(1);
    expect(feeder.counters().droppedBusy).toBe(1);
  });

  it('overlaps: frame N+1 is packed while frame N is still being posted, then posted right after', async () => {
    const { worker, plugin, feeder } = await setup();
    plugin.hold = true; // the plugin call for frame 1 stays "in flight"
    feeder.offer(frame(1));
    worker.pack(0, 'ONE');
    await flush();
    expect(plugin.submits.map((s) => s.seq)).toEqual([1]);

    // while frame 1 is being posted the worker is free again: frame 2 is accepted and packed
    expect(feeder.offer(frame(2))).toBe('packing');
    worker.pack(1, 'TWO');
    await flush();
    expect(plugin.submits.map((s) => s.seq)).toEqual([1]); // still only one post in flight: frame 2 waits
    expect(feeder.counters().replacedWaiting).toBe(0);

    plugin.releases.shift()!(); // frame 1's post is acknowledged
    await flush();
    expect(plugin.submits.map((s) => s.seq)).toEqual([1, 2]); // frame 2 goes out immediately
    plugin.releases.shift()!();
    await flush();
    expect(feeder.counters()).toMatchObject({ packed: 2, posted: 2, replacedWaiting: 0 });
  });

  it('keeps only the newest waiting packed frame (latest wins)', async () => {
    const { worker, plugin, feeder } = await setup();
    plugin.hold = true;
    feeder.offer(frame(1));
    worker.pack(0, 'ONE');
    await flush();
    feeder.offer(frame(2));
    worker.pack(1, 'TWO');
    await flush();
    feeder.offer(frame(3));
    worker.pack(2, 'THREE'); // frame 2 is still waiting: it is replaced by frame 3
    await flush();
    expect(feeder.counters().replacedWaiting).toBe(1);
    plugin.releases.shift()!();
    await flush();
    expect(plugin.submits.map((s) => s.seq)).toEqual([1, 3]);
  });

  it('never has two posts in flight', async () => {
    const { worker, plugin, feeder } = await setup();
    plugin.hold = true;
    let maxInFlight = 0;
    const orig = plugin.submit.bind(plugin);
    let inFlight = 0;
    plugin.submit = async (o) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await orig(o);
      } finally {
        inFlight--;
      }
    };
    for (let i = 0; i < 6; i++) {
      feeder.offer(frame(i));
      worker.pack(i, `F${i}`);
      await flush();
      if (plugin.releases.length) plugin.releases.shift()!();
      await flush();
    }
    expect(maxInFlight).toBe(1);
  });

  it('a pack failure is reported, counted, and does not stop later frames', async () => {
    const { worker, plugin, feeder } = await setup();
    const errors: { stage: string; message: string }[] = [];
    feeder.onError((e) => errors.push(e));
    feeder.offer(frame(1));
    worker.packError(0);
    await flush();
    expect(errors).toEqual([{ stage: 'pack', code: 'PACK_FAILED', message: 'no 2d' }]);
    feeder.offer(frame(2));
    worker.pack(1, 'OK');
    await flush();
    expect(plugin.submits.map((s) => s.seq)).toEqual([2]);
    expect(feeder.counters()).toMatchObject({ packErrors: 1, posted: 1 });
  });

  it('a post failure is reported and the waiting frame is still posted', async () => {
    const { worker, plugin, feeder } = await setup();
    const errors: { stage: string; code?: string }[] = [];
    feeder.onError((e) => errors.push(e));
    plugin.hold = true;
    feeder.offer(frame(1));
    worker.pack(0, 'ONE');
    await flush();
    feeder.offer(frame(2));
    worker.pack(1, 'TWO');
    await flush();
    plugin.hold = false;
    plugin.failNext = false;
    // fail frame 1's post by releasing it as a rejection: emulate with a failing plugin on the held call
    plugin.releases.shift()!();
    await flush();
    expect(plugin.submits.map((s) => s.seq)).toEqual([1, 2]);

    plugin.failNext = true;
    feeder.offer(frame(3));
    worker.pack(2, 'THREE');
    await flush();
    expect(errors).toEqual([{ stage: 'post', code: 'SUBMIT_FAILED', message: 'bridge down' }]);
    expect(feeder.counters().postErrors).toBe(1);
  });

  it('stop() discards the waiting frame and closes later offers', async () => {
    const { worker, plugin, feeder } = await setup();
    plugin.hold = true;
    feeder.offer(frame(1));
    worker.pack(0, 'ONE');
    await flush();
    feeder.offer(frame(2));
    worker.pack(1, 'TWO');
    await flush();
    feeder.stop();
    plugin.releases.shift()!();
    await flush();
    expect(plugin.submits.map((s) => s.seq)).toEqual([1]); // frame 2 was discarded
    const f = frame(3);
    expect(feeder.offer(f)).toBe('dropped');
    expect(f.closed()).toBe(1);
  });

  describe('stream JPEG for the viewer', () => {
    it('asks the worker for a 640 wide JPEG with the source aspect ratio and reports it with the capture times', async () => {
      const { worker, feeder } = await setup({ packFormat: 'jpeg', packQuality: 0.9, stream: { width: 640, quality: 0.6 } });
      const got: { seq: number; w: number; h: number; quality: number; tCaptureMs: number; len: number }[] = [];
      feeder.onStreamFrame((j) => got.push({ seq: j.seq, w: j.w, h: j.h, quality: j.quality, tCaptureMs: j.tCaptureMs, len: j.bytes.length }));
      feeder.offer(frame(3));
      expect(worker.posted[0]!.jpeg).toEqual({ width: 640, height: 360, quality: 0.6 });
      worker.pack(0, '/9j/', 'jpeg');
      worker.jpeg(0);
      await flush();
      expect(got).toEqual([{ seq: 3, w: 640, h: 360, quality: 0.6, tCaptureMs: 1300, len: 4 }]);
    });

    it('does not encode when nobody is watching, and starts as soon as someone is', async () => {
      let watching = false;
      const { worker, feeder } = await setup({ packFormat: 'jpeg', stream: { width: 640, quality: 0.6, wanted: () => watching } });
      feeder.offer(frame(1));
      expect(worker.posted[0]!.jpeg).toBeNull();
      worker.pack(0, 'A', 'jpeg');
      await flush();
      watching = true;
      feeder.offer(frame(2));
      expect(worker.posted[1]!.jpeg).toMatchObject({ width: 640 });
    });

    it('detection is posted before the JPEG exists, and a JPEG failure is reported without stopping detection', async () => {
      const { worker, plugin, feeder } = await setup({ packFormat: 'jpeg', stream: { width: 640, quality: 0.6 } });
      const errors: string[] = [];
      feeder.onError((e) => errors.push(e.message));
      feeder.offer(frame(1));
      worker.pack(0, 'A', 'jpeg');
      await flush();
      expect(plugin.submits).toHaveLength(1);
      worker.onmessage?.({ data: { id: worker.posted[0]!.id, kind: 'error', stage: 'jpeg', message: 'no canvas' } });
      await flush();
      expect(errors.join()).toContain('stream jpeg');
    });
  });
});
