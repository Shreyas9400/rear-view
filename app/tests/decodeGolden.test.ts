/// <reference types="node" />
// Cross-language golden test for decodeYoloxRaw. The same fixture (tests/fixtures/decode-golden.txt) is read by the
// Java port (android/app/src/test/.../YoloxDecoderTest). Regenerate only on purpose: UPDATE_GOLDEN=1 npx vitest run decodeGolden
// then review the diff, because the fixture freezes the reference behaviour that the native decoder must reproduce.
//
// Format (whitespace separated, '#' comments):
//   scenario <name> <srcW> <srcH>
//   anchor <index> <cx> <cy> <w> <h> <obj> <classId> <p>     (raw head values; float32 as 9 significant digits)
//   expect <classId> <score> <x> <y> <w> <h>                  (normalised to the source frame; double precision)
//   end

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeYoloxRaw, VEHICLE_CLASSES } from '../src/core/decode';
import { letterbox416 } from '../src/core/letterbox';
import { BLOCK, emptyRaw, setAnchor } from './helpers';

const FIXTURE = new URL('./fixtures/decode-golden.txt', import.meta.url);

interface Anchor { index: number; cx: number; cy: number; w: number; h: number; obj: number; cls: number; p: number }
interface Scenario { name: string; srcW: number; srcH: number; anchors: Anchor[]; expect: { classId: number; score: number; x: number; y: number; w: number; h: number }[] }

const f32 = (v: number) => Number(Math.fround(v).toPrecision(9));
const CLASS_ID = Object.fromEntries(Object.entries(VEHICLE_CLASSES).map(([id, name]) => [name, Number(id)]));

function anchor(index: number, cx: number, cy: number, w: number, h: number, obj: number, cls: number, p: number): Anchor {
  return { index, cx: f32(cx), cy: f32(cy), w: f32(w), h: f32(h), obj: f32(obj), cls, p: f32(p) };
}

/** Anchor at a stride block / grid cell with a box of (bw x bh) 416-space pixels centred `fx,fy` into the cell. */
function cell(block: 's8' | 's16' | 's32', gx: number, gy: number, bw: number, bh: number, obj: number, cls: number, p: number, fx = 0.5, fy = 0.5): Anchor {
  const stride = block === 's8' ? 8 : block === 's16' ? 16 : 32;
  const n = 416 / stride;
  return anchor(BLOCK[block] + gy * n + gx, fx, fy, Math.log(bw / stride), Math.log(bh / stride), obj, cls, p);
}

function scenarios(): Omit<Scenario, 'expect'>[] {
  const out: Omit<Scenario, 'expect'>[] = [];
  out.push({ name: 'single-car-square', srcW: 416, srcH: 416, anchors: [cell('s32', 6, 6, 100, 50, 0.8, 2, 0.9)] });
  out.push({
    name: 'four-vehicle-classes-and-others',
    srcW: 416,
    srcH: 416,
    anchors: [2, 3, 5, 7, 0, 1].map((cls, k) => cell('s32', k + 1, k, 60, 40, 1, cls, 0.9)),
  });
  out.push({ name: 'letterbox-1280x720', srcW: 1280, srcH: 720, anchors: [cell('s32', 6, 3, 130, 65, 1, 2, 0.9, 0.5, 0.65625)] });
  out.push({
    name: 'nms-cluster',
    srcW: 416,
    srcH: 416,
    anchors: [
      // six overlapping same-class boxes around (100,100), distinct scores
      cell('s8', 12, 12, 60, 40, 0.9, 2, 0.95),
      cell('s8', 13, 12, 60, 40, 0.8, 2, 0.95),
      cell('s8', 12, 13, 62, 42, 0.85, 2, 0.95),
      cell('s8', 11, 12, 58, 40, 0.7, 2, 0.95),
      cell('s8', 12, 11, 60, 38, 0.75, 2, 0.95),
      cell('s8', 13, 13, 61, 41, 0.6, 2, 0.95),
      // same place, different class: must survive
      cell('s16', 6, 6, 60, 40, 0.9, 5, 0.9),
      // far away: must survive
      cell('s32', 10, 10, 50, 50, 0.9, 2, 0.9),
    ],
  });
  out.push({ name: 'clipping-big-box', srcW: 416, srcH: 416, anchors: [anchor(BLOCK.s32, 0.5, 0.5, Math.log(400 / 32), Math.log(400 / 32), 1, 2, 0.9)] });
  out.push({
    name: 'candidate-cap-200',
    srcW: 416,
    srcH: 416,
    anchors: Array.from({ length: 260 }, (_, i) => cell('s8', 1 + (i % 16) * 3, 1 + Math.floor(i / 16) * 3, 12, 12, 0.5 + i * 0.001, 2, 0.9)),
  });
  out.push({
    name: 'equal-scores-first-wins',
    srcW: 416,
    srcH: 416,
    anchors: [cell('s8', 20, 20, 64, 64, 0.8, 2, 0.9), cell('s8', 21, 20, 64, 64, 0.8, 2, 0.9)],
  });
  out.push({
    name: 'threshold-edge',
    srcW: 416,
    srcH: 416,
    anchors: [cell('s32', 2, 2, 40, 40, 0.3499, 2, 1), cell('s32', 5, 2, 40, 40, 0.3501, 2, 1)],
  });
  out.push({ name: 'outside-frame-and-degenerate', srcW: 416, srcH: 416, anchors: [anchor(BLOCK.s32, -30, 0.5, 0, 0, 1, 2, 0.9), anchor(BLOCK.s32 + 40, 0.5, 0.5, -30, -30, 1, 2, 0.9)] });
  out.push({
    name: 'portrait-source',
    srcW: 720,
    srcH: 1280,
    anchors: [cell('s16', 4, 12, 90, 120, 0.95, 7, 0.9), cell('s16', 20, 9, 40, 30, 0.9, 3, 0.8)],
  });
  return out;
}

function build(s: Omit<Scenario, 'expect'>): Scenario {
  const raw = emptyRaw();
  for (const a of s.anchors) setAnchor(raw, a.index, { cx: a.cx, cy: a.cy, w: a.w, h: a.h, obj: a.obj, cls: a.cls, p: a.p });
  const dets = decodeYoloxRaw(raw, letterbox416(s.srcW, s.srcH));
  return { ...s, expect: dets.map((d) => ({ classId: CLASS_ID[d.cls]!, score: d.score, x: d.box.x, y: d.box.y, w: d.box.w, h: d.box.h })) };
}

function serialise(all: Scenario[]): string {
  const lines = ['# Golden vectors for decodeYoloxRaw. See tests/decodeGolden.test.ts. Do not edit by hand.'];
  for (const s of all) {
    lines.push(`scenario ${s.name} ${s.srcW} ${s.srcH}`);
    for (const a of s.anchors) lines.push(`anchor ${a.index} ${a.cx} ${a.cy} ${a.w} ${a.h} ${a.obj} ${a.cls} ${a.p}`);
    for (const e of s.expect) lines.push(`expect ${e.classId} ${e.score} ${e.x} ${e.y} ${e.w} ${e.h}`);
    lines.push('end');
  }
  return lines.join('\n') + '\n';
}

function parse(text: string): Scenario[] {
  const all: Scenario[] = [];
  let cur: Scenario | null = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split(/\s+/);
    if (p[0] === 'scenario') cur = { name: p[1]!, srcW: Number(p[2]), srcH: Number(p[3]), anchors: [], expect: [] };
    else if (p[0] === 'anchor') cur!.anchors.push({ index: Number(p[1]), cx: Number(p[2]), cy: Number(p[3]), w: Number(p[4]), h: Number(p[5]), obj: Number(p[6]), cls: Number(p[7]), p: Number(p[8]) });
    else if (p[0] === 'expect') cur!.expect.push({ classId: Number(p[1]), score: Number(p[2]), x: Number(p[3]), y: Number(p[4]), w: Number(p[5]), h: Number(p[6]) });
    else if (p[0] === 'end') all.push(cur!);
  }
  return all;
}

if (process.env.UPDATE_GOLDEN === '1') writeFileSync(FIXTURE, serialise(scenarios().map(build)));

describe('decodeYoloxRaw golden vectors (shared with the Java port)', () => {
  const fixture = parse(readFileSync(FIXTURE, 'utf8'));

  it('contains every scenario defined here', () => {
    expect(fixture.map((s) => s.name)).toEqual(scenarios().map((s) => s.name));
  });

  for (const s of fixture) {
    it(`reproduces ${s.name}`, () => {
      const raw = emptyRaw();
      for (const a of s.anchors) setAnchor(raw, a.index, { cx: a.cx, cy: a.cy, w: a.w, h: a.h, obj: a.obj, cls: a.cls, p: a.p });
      const got = decodeYoloxRaw(raw, letterbox416(s.srcW, s.srcH));
      expect(got).toHaveLength(s.expect.length);
      got.forEach((d, i) => {
        const e = s.expect[i]!;
        expect(CLASS_ID[d.cls]).toBe(e.classId);
        for (const [a, b] of [[d.score, e.score], [d.box.x, e.x], [d.box.y, e.y], [d.box.w, e.w], [d.box.h, e.h]] as const) {
          expect(a).toBeCloseTo(b, 12);
        }
      });
    });
  }

  it('has the properties the scenarios are meant to exercise', () => {
    const by = Object.fromEntries(fixture.map((s) => [s.name, s]));
    expect(by['four-vehicle-classes-and-others']!.expect.map((e) => e.classId).sort()).toEqual([0, 2, 3, 5, 7]); // person added in D-036; bicycle (1) is still dropped
    expect(by['candidate-cap-200']!.expect).toHaveLength(200);
    expect(by['equal-scores-first-wins']!.expect).toHaveLength(1);
    expect(by['threshold-edge']!.expect).toHaveLength(1);
    // The box left of the frame collapses to zero width after clipping and is dropped. The raw size of -30 yields a
    // width of ~3e-12, which is positive, so the reference decoder keeps it; the native port must do the same.
    const degenerate = by['outside-frame-and-degenerate']!.expect;
    expect(degenerate).toHaveLength(1);
    expect(degenerate[0]!.w).toBeLessThan(1e-9);
    expect(by['nms-cluster']!.expect.length).toBeGreaterThanOrEqual(3);
    expect(by['nms-cluster']!.expect.length).toBeLessThan(8);
  });
});
