// Host-side decode for YOLOX-nano raw heads: output [1,3549,85], anchor-major.
// 85 = 4 box (cx,cy,w,h in grid units, NOT decoded) + 1 objectness + 80 classes (sigmoid already applied).
// Decode per the HF model card; anchors ordered by stride 8, 16, 32, each grid row-major (gy outer, gx inner).

import type { Box, Detection, VehicleClass } from '../shared/types';
import { INPUT_SIZE, type Letterbox } from './letterbox';

export const STRIDES = [8, 16, 32] as const;
export const NUM_CLASSES = 80;
export const ROW = 5 + NUM_CLASSES;
export const NUM_ANCHORS = STRIDES.reduce((a, s) => a + (INPUT_SIZE / s) ** 2, 0); // 3549

/** COCO80 ids kept for this project. */
export const VEHICLE_CLASSES: Readonly<Record<number, VehicleClass>> = {
  0: 'person',
  2: 'car',
  3: 'motorcycle',
  5: 'bus',
  7: 'truck',
};

export interface DecodeOptions {
  scoreThr: number;
  nmsIou: number;
  /** Cap on candidates entering NMS (highest score first). */
  maxCandidates?: number;
}

export const DEFAULT_DECODE: DecodeOptions = { scoreThr: 0.35, nmsIou: 0.45, maxCandidates: 200 };

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Per-class NMS, highest score first, deterministic (stable on ties). */
export function nms(dets: Detection[], iouThr: number): Detection[] {
  const order = dets.map((d, i) => ({ d, i })).sort((p, q) => q.d.score - p.d.score || p.i - q.i);
  const kept: Detection[] = [];
  for (const { d } of order) {
    let suppressed = false;
    for (const k of kept) {
      if (k.cls === d.cls && iou(k.box, d.box) > iouThr) { suppressed = true; break; }
    }
    if (!suppressed) kept.push(d);
  }
  return kept;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function decodeYoloxRaw(raw: Float32Array, lb: Letterbox, opts: DecodeOptions = DEFAULT_DECODE): Detection[] {
  if (raw.length !== NUM_ANCHORS * ROW) {
    throw new Error(`decodeYoloxRaw: expected ${NUM_ANCHORS * ROW} floats, got ${raw.length}`);
  }
  const cands: Detection[] = [];
  let a = 0;
  for (const stride of STRIDES) {
    const n = INPUT_SIZE / stride;
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++, a++) {
        const o = a * ROW;
        const obj = raw[o + 4]!;
        // argmax over all 80 classes (as the reference decode), then keep vehicle classes only
        let best = 0;
        let bestScore = -1;
        for (let c = 0; c < NUM_CLASSES; c++) {
          const s = raw[o + 5 + c]!;
          if (s > bestScore) { bestScore = s; best = c; }
        }
        const cls = VEHICLE_CLASSES[best];
        if (!cls) continue;
        const score = obj * bestScore;
        if (score < opts.scoreThr) continue;
        const cx = (raw[o]! + gx) * stride;
        const cy = (raw[o + 1]! + gy) * stride;
        const w = Math.exp(raw[o + 2]!) * stride;
        const h = Math.exp(raw[o + 3]!) * stride;
        // 416-space -> source pixels (undo letterbox) -> normalised
        const x1 = clamp01((cx - w / 2) / lb.ratio / lb.srcW);
        const y1 = clamp01((cy - h / 2) / lb.ratio / lb.srcH);
        const x2 = clamp01((cx + w / 2) / lb.ratio / lb.srcW);
        const y2 = clamp01((cy + h / 2) / lb.ratio / lb.srcH);
        if (x2 <= x1 || y2 <= y1) continue;
        cands.push({ cls, score, box: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } });
      }
    }
  }
  cands.sort((p, q) => q.score - p.score);
  const capped = opts.maxCandidates ? cands.slice(0, opts.maxCandidates) : cands;
  return nms(capped, opts.nmsIou);
}
