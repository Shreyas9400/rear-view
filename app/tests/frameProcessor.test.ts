import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_MS, FrameProcessor, type FrameRequest, type FrameResponse, type WorkerLike } from '../src/stream/frameProcessor';

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: FrameResponse }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  posted: { msg: FrameRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  throwOnPost = false;
  postMessage(msg: FrameRequest, transfer: Transferable[]): void {
    if (this.throwOnPost) throw new Error('DataCloneError');
    this.posted.push({ msg, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(r: FrameResponse): void {
    this.onmessage?.({ data: r });
  }
}

const bitmap = () => ({ close() {} }) as unknown as ImageBitmap;
const packOk = (id: number, rgb64 = 'QUJD', packMs = 20): FrameResponse => ({ id, kind: 'pack', rgb64, packMs });
const jpegOk = (id: number, n = 4, encodeMs = 30): FrameResponse => ({ id, kind: 'jpeg', bytes: new Uint8Array(n).fill(7).buffer, encodeMs });
const JPEG = { width: 640, height: 360, quality: 0.6 };

function make() {
  const workers: FakeWorker[] = [];
  let t = 0;
  const fp = new FrameProcessor(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, () => t);
  return { fp, workers, setTime: (v: number) => (t = v) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FrameProcessor pack stage', () => {
  it('transfers the bitmap and resolves the pack stage as soon as the packed frame arrives', async () => {
    const { fp, workers, setTime } = make();
    const bm = bitmap();
    setTime(100);
    const job = fp.process(bm, 1280, 720, { pack: true })!;
    const posted = workers[0]!.posted[0]!;
    expect(posted.transfer).toEqual([bm]); // ownership moves to the worker
    expect(posted.msg).toMatchObject({ srcW: 1280, srcH: 720, pack: true, jpeg: null });
    expect(fp.isBusy()).toBe(true);
    setTime(160);
    workers[0]!.reply(packOk(posted.msg.id, 'QUJDRA==', 42));
    expect(await job.pack).toEqual({ rgb64: 'QUJDRA==', format: 'rgb', packMs: 42, roundTripMs: 60 });
    expect(await job.jpeg).toBeNull(); // not requested
    expect(fp.isBusy()).toBe(false); // nothing else was requested
  });

  it('asks the worker for the compact JPEG format and reports it back', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: true, packFormat: 'jpeg', packQuality: 0.85 })!;
    expect(workers[0]!.posted[0]!.msg).toMatchObject({ pack: true, packFormat: 'jpeg', packQuality: 0.85 });
    workers[0]!.reply({ id: workers[0]!.posted[0]!.msg.id, kind: 'pack', rgb64: '/9j/4AAQ', packMs: 25, format: 'jpeg' });
    expect(await job.pack).toMatchObject({ rgb64: '/9j/4AAQ', format: 'jpeg' });
  });

  it('reuses one worker across jobs', async () => {
    const { fp, workers } = make();
    for (let i = 0; i < 3; i++) {
      const job = fp.process(bitmap(), 1280, 720, { pack: true })!;
      workers[0]!.reply(packOk(workers[0]!.posted[i]!.msg.id));
      await job.pack;
    }
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toHaveLength(3);
  });

  it('returns null and does NOT consume the bitmap while a job is in flight', async () => {
    const { fp, workers } = make();
    const first = fp.process(bitmap(), 1280, 720, { pack: true })!;
    expect(fp.process(bitmap(), 1280, 720, { pack: true })).toBeNull();
    expect(workers[0]!.posted).toHaveLength(1);
    workers[0]!.reply(packOk(workers[0]!.posted[0]!.msg.id));
    await first.pack;
    expect(fp.isBusy()).toBe(false);
  });

  it('rejects a request that asks for nothing', () => {
    const { fp } = make();
    expect(() => fp.process(bitmap(), 1280, 720, { pack: false })).toThrow('nothing requested');
  });
});

describe('FrameProcessor pack + jpeg', () => {
  it('delivers the packed frame first and the JPEG later; stays busy until both are done', async () => {
    const { fp, workers, setTime } = make();
    setTime(0);
    const job = fp.process(bitmap(), 1280, 720, { pack: true, jpeg: JPEG })!;
    const id = workers[0]!.posted[0]!.msg.id;
    expect(workers[0]!.posted[0]!.msg.jpeg).toEqual(JPEG);

    setTime(55);
    workers[0]!.reply(packOk(id, 'QUJD', 50));
    expect((await job.pack)!.roundTripMs).toBe(55);
    expect(fp.isBusy()).toBe(true); // JPEG still running
    expect(fp.process(bitmap(), 1280, 720, { pack: true })).toBeNull();

    setTime(95);
    workers[0]!.reply(jpegOk(id, 5, 35));
    const j = (await job.jpeg)!;
    expect(Array.from(j.bytes)).toEqual([7, 7, 7, 7, 7]);
    expect(j.encodeMs).toBe(35);
    expect(j.roundTripMs).toBe(95);
    expect(fp.isBusy()).toBe(false);
  });

  it('supports a JPEG-only job', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: false, jpeg: JPEG })!;
    workers[0]!.reply(jpegOk(workers[0]!.posted[0]!.msg.id));
    expect(await job.pack).toBeNull();
    expect(await job.jpeg).not.toBeNull();
    expect(fp.isBusy()).toBe(false);
  });
});

describe('FrameProcessor failures', () => {
  it('a stage error fails the whole job (both stages) but keeps the worker', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: true, jpeg: JPEG })!;
    const a = expect(job.pack).rejects.toMatchObject({ code: 'PACK_FAILED', message: 'no 2d' });
    const b = expect(job.jpeg).rejects.toMatchObject({ code: 'PACK_FAILED' });
    workers[0]!.reply({ id: workers[0]!.posted[0]!.msg.id, kind: 'error', stage: 'pack', message: 'no 2d' });
    await a;
    await b;
    expect(workers[0]!.terminated).toBe(false);
    expect(fp.isBusy()).toBe(false);
    const next = fp.process(bitmap(), 1280, 720, { pack: true })!; // still usable
    workers[0]!.reply(packOk(workers[0]!.posted[1]!.msg.id));
    await expect(next.pack).resolves.not.toBeNull();
  });

  it('a JPEG error after a successful pack rejects only the JPEG stage', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: true, jpeg: JPEG })!;
    const id = workers[0]!.posted[0]!.msg.id;
    workers[0]!.reply(packOk(id));
    await expect(job.pack).resolves.not.toBeNull();
    const j = expect(job.jpeg).rejects.toMatchObject({ code: 'JPEG_FAILED' });
    workers[0]!.reply({ id, kind: 'error', stage: 'jpeg', message: 'blob failed' });
    await j;
    expect(fp.isBusy()).toBe(false);
  });

  it('times out a silent worker, kills it and starts a fresh one next time', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: true })!;
    const assertion = expect(job.pack).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
    await assertion;
    expect(workers[0]!.terminated).toBe(true);
    expect(fp.isBusy()).toBe(false);
    const next = fp.process(bitmap(), 1280, 720, { pack: true })!;
    expect(workers).toHaveLength(2);
    workers[1]!.reply(packOk(workers[1]!.posted[0]!.msg.id));
    await expect(next.pack).resolves.not.toBeNull();
  });

  it('ignores a late answer from a job that already timed out', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: true })!;
    const lateId = workers[0]!.posted[0]!.msg.id;
    const assertion = expect(job.pack).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
    await assertion;
    const next = fp.process(bitmap(), 1280, 720, { pack: true })!;
    workers[0]!.reply(packOk(lateId)); // the old worker answers after being replaced
    expect(fp.isBusy()).toBe(true);
    workers[1]!.reply(packOk(workers[1]!.posted[0]!.msg.id));
    await expect(next.pack).resolves.not.toBeNull();
  });

  it('turns a worker error into rejections and restarts the worker', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: true, jpeg: JPEG })!;
    const a = expect(job.pack).rejects.toMatchObject({ code: 'WORKER_ERROR', message: 'script error' });
    const b = expect(job.jpeg).rejects.toMatchObject({ code: 'WORKER_ERROR' });
    workers[0]!.onerror?.({ message: 'script error' });
    await a;
    await b;
    expect(workers[0]!.terminated).toBe(true);
    fp.process(bitmap(), 1280, 720, { pack: true })!.pack.catch(() => undefined);
    expect(workers).toHaveLength(2);
  });

  it('rejects when posting fails (for example a detached bitmap)', async () => {
    const { fp, workers } = make();
    const first = fp.process(bitmap(), 1280, 720, { pack: true })!;
    workers[0]!.reply(packOk(workers[0]!.posted[0]!.msg.id));
    await first.pack;
    workers[0]!.throwOnPost = true;
    const job = fp.process(bitmap(), 1280, 720, { pack: true })!;
    await expect(job.pack).rejects.toMatchObject({ code: 'WORKER_ERROR', message: 'DataCloneError' });
    expect(fp.isBusy()).toBe(false);
  });

  it('dispose rejects an in-flight job, terminates the worker and refuses further work', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: true })!;
    const assertion = expect(job.pack).rejects.toMatchObject({ code: 'DISPOSED' });
    fp.dispose();
    await assertion;
    expect(workers[0]!.terminated).toBe(true);
    expect(() => fp.process(bitmap(), 1280, 720, { pack: true })).toThrow('processor disposed');
  });

  it('an unobserved stage does not raise an unhandled rejection', async () => {
    const { fp, workers } = make();
    const job = fp.process(bitmap(), 1280, 720, { pack: true, jpeg: JPEG })!;
    void job.pack; // the caller only cares about pack
    workers[0]!.onerror?.({ message: 'boom' });
    await job.pack.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    // reaching here without vitest reporting an unhandled rejection is the assertion
    expect(fp.isBusy()).toBe(false);
  });
});
