import { describe, expect, it } from 'vitest';
import type { CapturedFrame } from '../src/capture/source';
import { DetectorError } from '../src/inference/detector';
import { NativeDetector, SLOW_P95_MS, type NativeDetectResult, type NativeDetectorApi } from '../src/inference/nativeDetector';
import { bytesToBase64, RGB_BYTES, rgbaToRgb } from '../src/inference/packFrame';

const frame = (seq = 1, width = 1280, height = 720): CapturedFrame => ({
  seq,
  tCaptureMs: seq * 100,
  tCaptureEpochMs: 1_792_670_000_000 + seq * 100,
  width,
  height,
  bitmap: {} as ImageBitmap,
});

const ok = (over: Partial<NativeDetectResult> = {}): NativeDetectResult => ({
  detections: [{ classId: 2, score: 0.8, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }],
  inferMs: 50,
  decodeMs: 1.5,
  nativeTotalMs: 60,
  ...over,
});

const rgbFrame = () => Uint8Array.from({ length: RGB_BYTES }, (_, i) => i % 251);
const codeErr = (code: string, msg = code) => Object.assign(new Error(msg), { code });

interface Fake extends NativeDetectorApi {
  calls: { init: unknown[]; detect: { rgb: string; srcW: number; srcH: number }[]; dispose: number };
  next: () => Promise<NativeDetectResult>;
}

function fakePlugin(): Fake {
  const f: Fake = {
    calls: { init: [], detect: [], dispose: 0 },
    next: async () => ok(),
    async init(o) {
      f.calls.init.push(o);
      return { ready: true, accelerator: 'native-cpu', threads: o.threads ?? 0, compileMs: 20 };
    },
    async detect(o) {
      f.calls.detect.push(o);
      return f.next();
    },
    async dispose() {
      f.calls.dispose++;
    },
  };
  return f;
}

function make(plugin = fakePlugin(), clock?: () => number) {
  const d = new NativeDetector(plugin, () => rgbFrame(), clock);
  return { d, plugin };
}

const CFG = { accelerator: 'native-cpu' as const, scoreThr: 0.35, nmsIou: 0.45 };

describe('NativeDetector lifecycle and health', () => {
  it('is not healthy before init and refuses to detect', async () => {
    const { d } = make();
    expect(d.health()).toBe('failed');
    await expect(d.detect(frame())).rejects.toMatchObject({ code: 'NOT_INITIALISED' });
  });

  it('passes the config to the plugin with 2 threads by default', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    expect(plugin.calls.init).toEqual([{ threads: 2, scoreThr: 0.35, nmsIou: 0.45 }]);
    await d.init({ ...CFG, threads: 4 });
    expect(plugin.calls.init[1]).toMatchObject({ threads: 4 });
    expect(d.health()).toBe('ok');
  });

  it('rejects accelerators other than native-cpu', async () => {
    const { d } = make();
    await expect(d.init({ ...CFG, accelerator: 'webgpu' })).rejects.toMatchObject({ code: 'BAD_ARGS' });
  });

  it('reports failed and keeps the plugin error code when init fails', async () => {
    const plugin = fakePlugin();
    plugin.init = async () => {
      throw codeErr('INIT_FAILED', 'model load failed');
    };
    const { d } = make(plugin);
    await expect(d.init(CFG)).rejects.toMatchObject({ code: 'INIT_FAILED', message: 'model load failed' });
    expect(d.health()).toBe('failed');
  });

  it('dispose makes it unhealthy and calls the plugin', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    await d.dispose();
    expect(plugin.calls.dispose).toBe(1);
    expect(d.health()).toBe('failed');
  });
});

describe('NativeDetector.detect', () => {
  it('sends the packed frame and the source size, and maps the result', async () => {
    const { d, plugin } = make();
    await d.init(CFG);
    const r = await d.detect(frame(7, 1280, 720));
    expect(plugin.calls.detect).toHaveLength(1);
    expect(plugin.calls.detect[0]).toMatchObject({ srcW: 1280, srcH: 720 });
    expect(plugin.calls.detect[0]!.rgb).toBe(bytesToBase64(rgbFrame()));
    expect(r).toMatchObject({ seq: 7, preMs: expect.any(Number), inferMs: 50, postMs: 1.5 });
    expect(r!.detections).toEqual([{ cls: 'car', score: 0.8, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }]);
  });

  it('maps person and the four vehicle class ids and silently drops others', async () => {
    const plugin = fakePlugin();
    const mk = (classId: number) => ({ classId, score: 0.9, x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
    plugin.next = async () => ok({ detections: [2, 3, 5, 7, 0, 1].map(mk) });
    const { d } = make(plugin);
    await d.init(CFG);
    const r = await d.detect(frame());
    expect(r!.detections.map((x) => x.cls)).toEqual(['car', 'motorcycle', 'bus', 'truck', 'person']);
  });

  it('measures the bridge cost as round trip minus native time', async () => {
    let t = 0;
    const plugin = fakePlugin();
    plugin.next = async () => {
      t += 100; // the "round trip" takes 100 ms on this fake clock
      return ok({ nativeTotalMs: 60 });
    };
    const { d } = make(plugin, () => t);
    await d.init(CFG);
    const r = await d.detect(frame());
    expect(r!.bridgeMs).toBeCloseTo(40, 6);
  });

  it('drops a frame while one is in flight without calling the plugin again', async () => {
    const plugin = fakePlugin();
    let release!: () => void;
    plugin.next = () => new Promise<NativeDetectResult>((res) => (release = () => res(ok())));
    const { d } = make(plugin);
    await d.init(CFG);
    const first = d.detect(frame(1));
    expect(d.isBusy()).toBe(true);
    expect(await d.detect(frame(2))).toBeNull();
    expect(plugin.calls.detect).toHaveLength(1);
    release();
    expect((await first)!.seq).toBe(1);
    expect(d.isBusy()).toBe(false);
    plugin.next = async () => ok(); // the earlier fake never resolves on its own; the next frame must work normally
    expect(await d.detect(frame(3))).not.toBeNull();
  });

  it('treats a native BUSY rejection as a dropped frame, not a failure', async () => {
    const plugin = fakePlugin();
    plugin.next = async () => {
      throw codeErr('BUSY');
    };
    const { d } = make(plugin);
    await d.init(CFG);
    for (let i = 0; i < 5; i++) expect(await d.detect(frame(i))).toBeNull();
    expect(d.health()).toBe('ok');
    expect(d.isBusy()).toBe(false);
  });

  it('turns failed after 3 consecutive errors and recovers after a success', async () => {
    const plugin = fakePlugin();
    let fail = true;
    plugin.next = async () => {
      if (fail) throw codeErr('INFER_FAILED', 'boom');
      return ok();
    };
    const { d } = make(plugin);
    await d.init(CFG);
    for (let i = 0; i < 2; i++) await expect(d.detect(frame())).rejects.toBeInstanceOf(DetectorError);
    expect(d.health()).toBe('ok');
    await expect(d.detect(frame())).rejects.toMatchObject({ code: 'INFER_FAILED', message: 'boom' });
    expect(d.health()).toBe('failed');
    fail = false;
    await d.detect(frame());
    expect(d.health()).toBe('ok');
  });

  it('counts rasteriser failures as errors', async () => {
    const plugin = fakePlugin();
    const d = new NativeDetector(plugin, () => {
      throw new Error('bitmap closed');
    });
    await d.init(CFG);
    await expect(d.detect(frame())).rejects.toMatchObject({ code: 'RASTERIZE_FAILED', message: 'bitmap closed' });
    expect(plugin.calls.detect).toHaveLength(0);
    expect(d.isBusy()).toBe(false);
  });

  it('rejects malformed native results', async () => {
    const bad: Partial<NativeDetectResult>[] = [
      { detections: undefined as never },
      { detections: [{ classId: 2, score: 1.5, x: 0, y: 0, w: 0.1, h: 0.1 }] },
      { detections: [{ classId: 2, score: 0.5, x: NaN, y: 0, w: 0.1, h: 0.1 }] },
      { detections: [{ classId: 2, score: 0.5, x: 0.95, y: 0, w: 0.1, h: 0.1 }] },
      { detections: [{ classId: 2, score: 0.5, x: 0, y: 0, w: 0, h: 0.1 }] },
      { detections: [{ classId: 2.5, score: 0.5, x: 0, y: 0, w: 0.1, h: 0.1 }] },
    ];
    for (const b of bad) {
      const plugin = fakePlugin();
      plugin.next = async () => ok(b);
      const { d } = make(plugin);
      await d.init(CFG);
      await expect(d.detect(frame())).rejects.toMatchObject({ code: 'BAD_RESULT' });
    }
  });

  it('reports slow when the p95 round trip exceeds the budget, only after enough samples', async () => {
    let t = 0;
    let step = SLOW_P95_MS + 100;
    const plugin = fakePlugin();
    plugin.next = async () => {
      t += step;
      return ok();
    };
    const { d } = make(plugin, () => t);
    await d.init(CFG);
    for (let i = 0; i < 9; i++) await d.detect(frame(i));
    expect(d.health()).toBe('ok'); // fewer than 10 samples: not enough evidence
    await d.detect(frame(9));
    expect(d.health()).toBe('slow');
    step = 50;
    for (let i = 0; i < 20; i++) await d.detect(frame(i));
    expect(d.health()).toBe('ok');
  });
});

describe('frame packing', () => {
  it('drops the alpha channel', () => {
    const rgba = new Uint8ClampedArray(416 * 416 * 4);
    rgba.set([1, 2, 3, 255, 4, 5, 6, 255]);
    const rgb = rgbaToRgb(rgba);
    expect(Array.from(rgb.subarray(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rgb).toHaveLength(RGB_BYTES);
  });

  it('rejects wrong sizes', () => {
    expect(() => rgbaToRgb(new Uint8Array(10))).toThrow();
    expect(() => rgbaToRgb(new Uint8Array(416 * 416 * 4), new Uint8Array(5))).toThrow();
  });

  it('encodes base64 like Buffer, including large inputs and padding', () => {
    for (const n of [0, 1, 2, 3, 4, 100, 0x8000 - 1, 0x8000, 0x8000 + 1, RGB_BYTES]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
      expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
    }
  });

  it('a full frame encodes to 692,224 characters (the size the plugin accepts)', () => {
    expect(bytesToBase64(new Uint8Array(RGB_BYTES))).toHaveLength(692224);
  });
});
