import { describe, expect, it } from 'vitest';
import { INPUT_SIZE, letterbox416, rgbaToBgrFloat } from '../src/core/letterbox';

describe('letterbox416', () => {
  it('landscape 1280x720 pads the bottom only', () => {
    const lb = letterbox416(1280, 720);
    expect(lb.ratio).toBeCloseTo(0.325, 6);
    expect(lb.newW).toBe(416);
    expect(lb.newH).toBe(234);
    expect(lb.padRight).toBe(0);
    expect(lb.padBottom).toBe(182);
  });
  it('portrait 720x1280 pads the right only', () => {
    const lb = letterbox416(720, 1280);
    expect(lb.newH).toBe(416);
    expect(lb.newW).toBe(234);
    expect(lb.padRight).toBe(182);
    expect(lb.padBottom).toBe(0);
  });
  it('square input has no padding', () => {
    const lb = letterbox416(640, 640);
    expect(lb.padRight).toBe(0);
    expect(lb.padBottom).toBe(0);
    expect(lb.ratio).toBeCloseTo(0.65, 6);
  });
  it('rejects non-positive sizes', () => {
    expect(() => letterbox416(0, 10)).toThrow();
    expect(() => letterbox416(10, -1)).toThrow();
  });
});

describe('rgbaToBgrFloat', () => {
  it('swaps R and B, drops alpha, keeps 0-255 range, NHWC order', () => {
    const n = INPUT_SIZE * INPUT_SIZE;
    const rgba = new Uint8ClampedArray(n * 4);
    rgba.set([10, 20, 30, 255], 0); // pixel 0: R=10 G=20 B=30
    rgba.set([200, 100, 50, 255], 4); // pixel 1
    const t = rgbaToBgrFloat(rgba);
    expect(t.length).toBe(n * 3);
    expect(Array.from(t.slice(0, 6))).toEqual([30, 20, 10, 50, 100, 200]);
  });
  it('rejects wrong-sized input', () => {
    expect(() => rgbaToBgrFloat(new Uint8Array(10))).toThrow();
  });
});
