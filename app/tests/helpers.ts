import type { Detection, FrameMeta, HealthFlags, Track, VehicleClass } from '../src/shared/types';
import { NUM_ANCHORS, ROW } from '../src/core/decode';

export const OK: HealthFlags = { camera: 'ok', detector: 'ok', sensors: 'ok', thermal: 'ok' };

/** Offset of the first anchor of each stride block in the [3549,85] output. */
export const BLOCK = { s8: 0, s16: 52 * 52, s32: 52 * 52 + 26 * 26 } as const;

export function emptyRaw(): Float32Array {
  return new Float32Array(NUM_ANCHORS * ROW);
}

export function setAnchor(
  raw: Float32Array,
  index: number,
  a: { cx: number; cy: number; w: number; h: number; obj: number; cls: number; p: number },
): void {
  const o = index * ROW;
  raw[o] = a.cx;
  raw[o + 1] = a.cy;
  raw[o + 2] = a.w;
  raw[o + 3] = a.h;
  raw[o + 4] = a.obj;
  raw[o + 5 + a.cls] = a.p;
}

export function det(cx: number, cy: number, h: number, cls: VehicleClass = 'car', score = 0.8): Detection {
  const w = h * 1.5;
  return { cls, score, box: { x: cx - w / 2, y: cy - h / 2, w, h } };
}

export function track(over: Partial<Track> & { id: number }): Track {
  return {
    cls: 'car',
    box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    score: 0.8,
    state: 'confirmed',
    ageFrames: 10,
    missedFrames: 0,
    history: [],
    ...over,
  };
}

export function frameMeta(seq: number, over: Partial<FrameMeta> = {}): FrameMeta {
  return {
    v: 1,
    seq,
    tCaptureMs: seq * 100,
    tCaptureEpochMs: 1_792_670_000_000 + seq * 100,
    tEncodeMs: seq * 100 + 20,
    w: 640,
    h: 360,
    jpegQuality: 0.6,
    detSeq: seq,
    detAgeMs: 0,
    detections: [],
    tracks: [],
    alert: { level: 'NORMAL', reasons: [], trackIds: [], tMs: seq * 100, health: OK },
    ...over,
  };
}

/** Minimal bytes that start like a JPEG (SOI marker) with `n` total bytes. */
export function fakeJpeg(n = 64): Uint8Array {
  const b = new Uint8Array(n);
  b[0] = 0xff;
  b[1] = 0xd8;
  return b;
}

/** Deterministic "random" bytes for token tests. */
export function seqRandom(start = 1): (n: number) => Uint8Array {
  let c = start;
  return (n) => Uint8Array.from({ length: n }, () => (c = (c * 73 + 41) & 0xff));
}

/** History with box height h(t) = h0 * exp(g * t). */
export function growingHistory(g: number, n = 8, stepMs = 200, h0 = 0.1, t0 = 0) {
  return Array.from({ length: n }, (_, i) => {
    const tMs = t0 + i * stepMs;
    return { tMs, cx: 0.5, cy: 0.5, h: h0 * Math.exp((g * (i * stepMs)) / 1000) };
  });
}
