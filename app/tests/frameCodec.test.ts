import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, FrameFormatError } from '../src/stream/frameCodec';
import { CLOSE, LIMITS } from '../src/shared/protocol';
import { fakeJpeg, frameMeta } from './helpers';

function codeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof FrameFormatError) return e.closeCode;
    throw e;
  }
  return undefined;
}

describe('frame codec (RVF1)', () => {
  it('round-trips meta and JPEG bytes', () => {
    const jpeg = fakeJpeg(100);
    jpeg[50] = 7;
    const out = decodeFrame(encodeFrame(frameMeta(42), jpeg));
    expect(out.meta).toEqual(frameMeta(42));
    expect(Array.from(out.jpeg)).toEqual(Array.from(jpeg));
  });

  it('writes the magic and a big-endian metaLen', () => {
    const buf = encodeFrame(frameMeta(1), fakeJpeg());
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe('RVF1');
    const metaLen = new DataView(buf.buffer).getUint32(4, false);
    expect(buf.length).toBe(8 + metaLen + 64);
  });

  it('decodes from a subarray with a non-zero byteOffset', () => {
    const buf = encodeFrame(frameMeta(9), fakeJpeg());
    const padded = new Uint8Array(buf.length + 5);
    padded.set(buf, 5);
    expect(decodeFrame(padded.subarray(5)).meta.seq).toBe(9);
  });

  it('rejects bad magic, truncation, and metaLen out of range with 4400', () => {
    const good = encodeFrame(frameMeta(1), fakeJpeg());
    const badMagic = good.slice();
    badMagic[0] = 0x58;
    expect(codeOf(() => decodeFrame(badMagic))).toBe(CLOSE.malformed);
    expect(codeOf(() => decodeFrame(good.subarray(0, 6)))).toBe(CLOSE.malformed);

    const hugeMeta = good.slice();
    new DataView(hugeMeta.buffer).setUint32(4, LIMITS.metaBytes + 1, false);
    expect(codeOf(() => decodeFrame(hugeMeta))).toBe(CLOSE.malformed);

    const zeroMeta = good.slice();
    new DataView(zeroMeta.buffer).setUint32(4, 0, false);
    expect(codeOf(() => decodeFrame(zeroMeta))).toBe(CLOSE.malformed);

    const overrun = good.slice();
    new DataView(overrun.buffer).setUint32(4, good.length, false);
    expect(codeOf(() => decodeFrame(overrun))).toBe(CLOSE.malformed);
  });

  it('rejects non-JSON meta, wrong version, bad seq and a missing JPEG marker', () => {
    const enc = new TextEncoder();
    const build = (metaText: string, jpeg = fakeJpeg()) => {
      const m = enc.encode(metaText);
      const out = new Uint8Array(8 + m.length + jpeg.length);
      out.set(enc.encode('RVF1'));
      new DataView(out.buffer).setUint32(4, m.length, false);
      out.set(m, 8);
      out.set(jpeg, 8 + m.length);
      return out;
    };
    expect(codeOf(() => decodeFrame(build('{nope')))).toBe(CLOSE.malformed);
    expect(codeOf(() => decodeFrame(build('[1,2]')))).toBe(CLOSE.malformed);
    expect(codeOf(() => decodeFrame(build('{"v":2,"seq":1}')))).toBe(CLOSE.malformed);
    expect(codeOf(() => decodeFrame(build('{"v":1,"seq":-1}')))).toBe(CLOSE.malformed);
    expect(codeOf(() => decodeFrame(build('{"v":1,"seq":1.5}')))).toBe(CLOSE.malformed);
    expect(codeOf(() => decodeFrame(build('{"v":1,"seq":1}', new Uint8Array(10))))).toBe(CLOSE.malformed);
    expect(codeOf(() => decodeFrame(build('{"v":1,"seq":1}')))).toBeUndefined();
  });

  it('rejects oversize JPEG and oversize messages with 1009', () => {
    expect(codeOf(() => encodeFrame(frameMeta(1), fakeJpeg(LIMITS.jpegBytes + 1)))).toBe(CLOSE.messageTooBig);
    expect(codeOf(() => decodeFrame(new Uint8Array(LIMITS.frameMessageBytes + 1)))).toBe(CLOSE.messageTooBig);

    const justOver = encodeFrame(frameMeta(1), fakeJpeg(LIMITS.jpegBytes));
    expect(codeOf(() => decodeFrame(justOver))).toBeUndefined();
  });
});
