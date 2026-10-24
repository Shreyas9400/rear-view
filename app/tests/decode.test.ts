import { describe, expect, it } from 'vitest';
import { DEFAULT_DECODE, NUM_ANCHORS, ROW, STRIDES, decodeYoloxRaw, iou, nms } from '../src/core/decode';
import { letterbox416 } from '../src/core/letterbox';
import { BLOCK, emptyRaw, setAnchor } from './helpers';

const sq = letterbox416(416, 416); // ratio 1, no padding

describe('anchor layout', () => {
  it('has 3549 anchors = 52^2 + 26^2 + 13^2', () => {
    expect(NUM_ANCHORS).toBe(3549);
    expect(STRIDES).toEqual([8, 16, 32]);
    expect(52 * 52 + 26 * 26 + 13 * 13).toBe(3549);
  });
  it('throws on a tensor of the wrong length', () => {
    expect(() => decodeYoloxRaw(new Float32Array(10), sq)).toThrow();
  });
});

describe('decodeYoloxRaw', () => {
  it('returns nothing for an all-zero tensor', () => {
    expect(decodeYoloxRaw(emptyRaw(), sq)).toEqual([]);
  });

  it('decodes a stride-32 anchor: cx=(raw+gx)*stride, w=exp(raw)*stride, score=obj*class', () => {
    const raw = emptyRaw();
    const gx = 6, gy = 6;
    setAnchor(raw, BLOCK.s32 + gy * 13 + gx, { cx: 0.5, cy: 0.5, w: Math.log(100 / 32), h: Math.log(50 / 32), obj: 0.8, cls: 2, p: 0.9 });
    const out = decodeYoloxRaw(raw, sq);
    expect(out).toHaveLength(1);
    const d = out[0]!;
    expect(d.cls).toBe('car');
    expect(d.score).toBeCloseTo(0.72, 6);
    // centre (6.5*32, 6.5*32) = (208,208), w=100, h=50 in 416 space
    expect(d.box.x).toBeCloseTo((208 - 50) / 416, 6);
    expect(d.box.y).toBeCloseTo((208 - 25) / 416, 6);
    expect(d.box.w).toBeCloseTo(100 / 416, 6);
    expect(d.box.h).toBeCloseTo(50 / 416, 6);
  });

  it('decodes a stride-8 anchor at the right grid cell', () => {
    const raw = emptyRaw();
    const gx = 2, gy = 3;
    setAnchor(raw, BLOCK.s8 + gy * 52 + gx, { cx: 0.5, cy: 0.5, w: Math.log(4), h: Math.log(2), obj: 1, cls: 7, p: 0.9 });
    const [d] = decodeYoloxRaw(raw, sq);
    expect(d!.cls).toBe('truck');
    // centre ((2.5)*8, (3.5)*8) = (20, 28), w = 4*8 = 32, h = 2*8 = 16
    expect(d!.box.x + d!.box.w / 2).toBeCloseTo(20 / 416, 6);
    expect(d!.box.y + d!.box.h / 2).toBeCloseTo(28 / 416, 6);
    expect(d!.box.w).toBeCloseTo(32 / 416, 6);
  });

  it('decodes a stride-16 anchor', () => {
    const raw = emptyRaw();
    setAnchor(raw, BLOCK.s16 + 5 * 26 + 10, { cx: 0.5, cy: 0.5, w: Math.log(3), h: Math.log(3), obj: 1, cls: 3, p: 0.9 });
    const [d] = decodeYoloxRaw(raw, sq);
    expect(d!.cls).toBe('motorcycle');
    expect(d!.box.x + d!.box.w / 2).toBeCloseTo((10.5 * 16) / 416, 6);
    expect(d!.box.y + d!.box.h / 2).toBeCloseTo((5.5 * 16) / 416, 6);
  });

  it('maps COCO ids 0,2,3,5,7 to person, car, motorcycle, bus, truck and drops other classes (bicycle 1)', () => {
    const raw = emptyRaw();
    const ids = [2, 3, 5, 7, 0 /* person */, 1 /* bicycle */];
    ids.forEach((cls, k) => setAnchor(raw, BLOCK.s32 + k * 13 + k, { cx: 0.5, cy: 0.5, w: 0, h: 0, obj: 1, cls, p: 0.9 }));
    const out = decodeYoloxRaw(raw, sq).map((d) => d.cls).sort();
    expect(out).toEqual(['bus', 'car', 'motorcycle', 'person', 'truck']);
  });

  it('applies the score threshold', () => {
    const raw = emptyRaw();
    setAnchor(raw, BLOCK.s32 + 20, { cx: 0.5, cy: 0.5, w: 0, h: 0, obj: 0.5, cls: 2, p: 0.5 }); // 0.25
    expect(decodeYoloxRaw(raw, sq, { ...DEFAULT_DECODE, scoreThr: 0.35 })).toHaveLength(0);
    expect(decodeYoloxRaw(raw, sq, { ...DEFAULT_DECODE, scoreThr: 0.2 })).toHaveLength(1);
  });

  it('undoes the letterbox for 1280x720 sources and normalises to the source frame', () => {
    const lb = letterbox416(1280, 720); // ratio 0.325, content height 234
    const raw = emptyRaw();
    // centre at (208,117) in 416 space, w=130, h=65  => source px: cx=640, cy=360, w=400, h=200
    setAnchor(raw, BLOCK.s32 + 3 * 13 + 6, { cx: 0.5, cy: 0.656250, w: Math.log(130 / 32), h: Math.log(65 / 32), obj: 1, cls: 2, p: 0.9 });
    const [d] = decodeYoloxRaw(raw, lb);
    expect(d!.box.x + d!.box.w / 2).toBeCloseTo(0.5, 2);
    expect(d!.box.y + d!.box.h / 2).toBeCloseTo(0.5, 2);
    expect(d!.box.w).toBeCloseTo(400 / 1280, 2);
    expect(d!.box.h).toBeCloseTo(200 / 720, 2);
  });

  it('clips boxes to [0,1]', () => {
    const raw = emptyRaw();
    setAnchor(raw, BLOCK.s32, { cx: 0.5, cy: 0.5, w: Math.log(400 / 32), h: Math.log(400 / 32), obj: 1, cls: 2, p: 0.9 });
    const [d] = decodeYoloxRaw(raw, sq);
    expect(d!.box.x).toBeGreaterThanOrEqual(0);
    expect(d!.box.y).toBeGreaterThanOrEqual(0);
    expect(d!.box.x + d!.box.w).toBeLessThanOrEqual(1);
    expect(d!.box.y + d!.box.h).toBeLessThanOrEqual(1);
  });

  it('is deterministic', () => {
    const raw = emptyRaw();
    setAnchor(raw, BLOCK.s32 + 40, { cx: 0.4, cy: 0.6, w: 0.3, h: 0.2, obj: 0.9, cls: 5, p: 0.8 });
    expect(decodeYoloxRaw(raw, sq)).toEqual(decodeYoloxRaw(raw, sq));
  });

  it('rejects the stated row width mismatch (ROW = 85)', () => {
    expect(ROW).toBe(85);
  });
});

describe('nms / iou', () => {
  const b = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  it('iou of identical boxes is 1 and disjoint boxes is 0', () => {
    expect(iou(b(0, 0, 0.2, 0.2), b(0, 0, 0.2, 0.2))).toBeCloseTo(1, 9);
    expect(iou(b(0, 0, 0.1, 0.1), b(0.5, 0.5, 0.1, 0.1))).toBe(0);
  });
  it('suppresses overlapping same-class boxes, keeping the higher score', () => {
    const out = nms(
      [
        { cls: 'car', score: 0.6, box: b(0.1, 0.1, 0.3, 0.3) },
        { cls: 'car', score: 0.9, box: b(0.12, 0.1, 0.3, 0.3) },
      ],
      0.45,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBe(0.9);
  });
  it('keeps overlapping boxes of different classes', () => {
    const out = nms(
      [
        { cls: 'car', score: 0.6, box: b(0.1, 0.1, 0.3, 0.3) },
        { cls: 'truck', score: 0.9, box: b(0.1, 0.1, 0.3, 0.3) },
      ],
      0.45,
    );
    expect(out).toHaveLength(2);
  });
  it('keeps same-class boxes that overlap less than the threshold', () => {
    const out = nms(
      [
        { cls: 'car', score: 0.9, box: b(0.0, 0.0, 0.3, 0.3) },
        { cls: 'car', score: 0.8, box: b(0.25, 0.0, 0.3, 0.3) },
      ],
      0.45,
    );
    expect(out).toHaveLength(2);
  });
  it('is stable on equal scores (first wins)', () => {
    const a = { cls: 'car' as const, score: 0.7, box: b(0.1, 0.1, 0.3, 0.3) };
    const c = { cls: 'car' as const, score: 0.7, box: b(0.11, 0.1, 0.3, 0.3) };
    expect(nms([a, c], 0.45)).toEqual([a]);
  });
});
