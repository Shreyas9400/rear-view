import { describe, expect, it } from 'vitest';
import { letterbox416 } from '../src/core/letterbox';
import { LetterboxRasterizer, type RasterCanvas, type RasterContext } from '../src/inference/rasterize';
import { RGB_BYTES } from '../src/inference/packFrame';

function fakeCanvas() {
  const calls: unknown[][] = [];
  let created = 0;
  const rgba = new Uint8ClampedArray(416 * 416 * 4);
  rgba.set([10, 20, 30, 255, 40, 50, 60, 255]); // first two pixels
  const ctx: RasterContext = {
    fillStyle: '',
    fillRect: (...a) => void calls.push(['fillRect', ctx.fillStyle, ...a]),
    drawImage: (...a: unknown[]) => void calls.push(['drawImage', ...a]),
    getImageData: (...a) => {
      calls.push(['getImageData', ...a]);
      return { data: rgba };
    },
  };
  const canvas: RasterCanvas = { getContext: () => ctx };
  return { calls, created: () => created, factory: () => (created++, canvas) };
}

describe('LetterboxRasterizer', () => {
  it('fills the gray 114 pad, draws the frame at its letterboxed size and returns packed RGB', () => {
    const c = fakeCanvas();
    const r = new LetterboxRasterizer(c.factory);
    const bitmap = { tag: 'bitmap' };
    const lb = letterbox416(1280, 720); // content 416 x 234
    const out = r.rasterize(bitmap, lb);
    expect(c.calls).toEqual([
      ['fillRect', 'rgb(114,114,114)', 0, 0, 416, 416],
      ['drawImage', bitmap, 0, 0, 416, 234],
      ['getImageData', 0, 0, 416, 416],
    ]);
    expect(out).toHaveLength(RGB_BYTES);
    expect(Array.from(out.subarray(0, 6))).toEqual([10, 20, 30, 40, 50, 60]); // alpha dropped
  });

  it('creates its canvas once and reuses it', () => {
    const c = fakeCanvas();
    const r = new LetterboxRasterizer(c.factory);
    r.rasterize({}, letterbox416(1280, 720));
    r.rasterize({}, letterbox416(720, 1280));
    expect(c.created()).toBe(1);
    expect(c.calls.filter((x) => x[0] === 'drawImage').map((x) => x.slice(4))).toEqual([[416, 234], [234, 416]]);
  });

  it('rasterizeJpeg paints the same letterboxed frame and returns the encoded bytes', async () => {
    const calls: unknown[][] = [];
    const ctx: RasterContext = {
      fillStyle: '',
      fillRect: (...a) => void calls.push(['fillRect', ctx.fillStyle, ...a]),
      drawImage: (...a: unknown[]) => void calls.push(['drawImage', ...a]),
      getImageData: () => {
        throw new Error('JPEG output must not read pixels back');
      },
    };
    const canvas: RasterCanvas = {
      getContext: () => ctx,
      convertToBlob: async (o) => {
        calls.push(['convertToBlob', o.type, o.quality]);
        return { arrayBuffer: async () => Uint8Array.of(0xff, 0xd8, 0xff, 0xd9).buffer };
      },
    };
    const r = new LetterboxRasterizer(() => canvas);
    const bitmap = { tag: 'bitmap' };
    const out = await r.rasterizeJpeg(bitmap, letterbox416(1280, 720), 0.9);
    expect(Array.from(out)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(calls).toEqual([
      ['fillRect', 'rgb(114,114,114)', 0, 0, 416, 416],
      ['drawImage', bitmap, 0, 0, 416, 234],
      ['convertToBlob', 'image/jpeg', 0.9],
    ]);
  });

  it('rasterizeJpeg fails clearly when the canvas cannot encode', async () => {
    const c = fakeCanvas();
    const r = new LetterboxRasterizer(c.factory);
    await expect(r.rasterizeJpeg({}, letterbox416(416, 416), 0.9)).rejects.toThrow('convertToBlob missing');
  });

  it('throws when no 2d context is available', () => {
    const r = new LetterboxRasterizer(() => ({ getContext: () => null }));
    expect(() => r.rasterize({}, letterbox416(416, 416))).toThrow('2d canvas unavailable');
  });
});
