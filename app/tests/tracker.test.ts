import { describe, expect, it } from 'vitest';
import { IouTracker } from '../src/core/tracker';
import { det } from './helpers';

const step = (tr: IouTracker, t: number, ds: ReturnType<typeof det>[]) => tr.update(t, ds);

describe('IouTracker', () => {
  it('confirms a track after 3 consecutive hits and keeps its id', () => {
    const tr = new IouTracker();
    let out = step(tr, 0, [det(0.5, 0.5, 0.2)]);
    expect(out[0]!.state).toBe('tentative');
    out = step(tr, 200, [det(0.5, 0.5, 0.2)]);
    expect(out[0]!.state).toBe('tentative');
    out = step(tr, 400, [det(0.5, 0.5, 0.2)]);
    expect(out[0]!.state).toBe('confirmed');
    expect(out[0]!.id).toBe(1);
    expect(out[0]!.ageFrames).toBe(3);
  });

  it('deletes a tentative track at its second missed update in a row (a one-frame blip dies)', () => {
    const tr = new IouTracker();
    step(tr, 0, [det(0.5, 0.5, 0.2)]);
    expect(step(tr, 200, [])).toHaveLength(1); // one miss is tolerated
    expect(step(tr, 400, [])).toHaveLength(0);
  });

  it('confirms a flickering vehicle: 3 hits among the last 5 updates, with misses in between', () => {
    const tr = new IouTracker();
    const seen = [true, false, true, false, true];
    let out = [] as ReturnType<IouTracker['update']>;
    seen.forEach((s, i) => (out = step(tr, i * 200, s ? [det(0.5, 0.5, 0.2)] : [])));
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe('confirmed');
    expect(out[0]!.id).toBe(1);
  });

  it('reports a missed confirmed track at its predicted position for up to 500 ms, then at its last box', () => {
    const tr = new IouTracker();
    for (let i = 0; i < 6; i++) step(tr, i * 200, [det(0.2 + i * 0.05, 0.5, 0.2)]); // moving right at 0.25/s, last seen t=1000
    const last = step(tr, 1000, [det(0.45, 0.5, 0.2)])[0]!;
    const coast = step(tr, 1300, [])[0]!;
    expect(coast.state).toBe('confirmed');
    expect(coast.missedFrames).toBeGreaterThan(0);
    expect(coast.box.x).toBeGreaterThan(last.box.x); // moved on along its velocity
    const stale = step(tr, 1700, [])[0]!; // 700 ms since seen: back to the last real box
    expect(stale.box.x).toBeCloseTo(last.box.x, 6);
  });

  it('keeps the same id through a short gap, marks lost after 1 s, deletes after 2 s', () => {
    const tr = new IouTracker();
    for (let i = 0; i < 4; i++) step(tr, i * 200, [det(0.5, 0.5, 0.2)]); // seen until t=600
    let out = step(tr, 1000, []);
    expect(out[0]!.state).toBe('confirmed');
    expect(out[0]!.missedFrames).toBe(1);
    out = step(tr, 1700, []); // 1100 ms since seen
    expect(out[0]!.state).toBe('lost');
    out = step(tr, 2500, [det(0.5, 0.5, 0.2)]); // 1900 ms since seen: reacquired, same id
    expect(out[0]!.id).toBe(1);
    expect(out[0]!.state).toBe('tentative'); // consecutive hits restart; confirm again after 3
    out = step(tr, 2700, [det(0.5, 0.5, 0.2)]);
    out = step(tr, 2900, [det(0.5, 0.5, 0.2)]);
    expect(out[0]!.state).toBe('confirmed');
  });

  it('does not reuse an id after deletion', () => {
    const tr = new IouTracker();
    for (let i = 0; i < 4; i++) step(tr, i * 200, [det(0.2, 0.5, 0.2)]);
    step(tr, 3500, []); // > 2 s since seen: deleted
    const out = step(tr, 3700, [det(0.2, 0.5, 0.2)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(2);
  });

  it('follows a moving vehicle using velocity prediction', () => {
    const tr = new IouTracker();
    let id = -1;
    for (let i = 0; i < 10; i++) {
      const out = step(tr, i * 200, [det(0.2 + i * 0.05, 0.5, 0.2)]); // 0.25/s, boxes barely overlap with previous
      expect(out).toHaveLength(1);
      if (id < 0) id = out[0]!.id;
      expect(out[0]!.id).toBe(id);
    }
  });

  it('does not swap ids for two separated vehicles', () => {
    const tr = new IouTracker();
    let ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const out = step(tr, i * 200, [det(0.25, 0.5, 0.2), det(0.75, 0.5, 0.2)]);
      const cur = out.map((t) => t.id).sort();
      if (i === 0) ids = cur;
      expect(cur).toEqual(ids);
    }
    expect(ids).toEqual([1, 2]);
  });

  it('bounds history to historyMs', () => {
    const tr = new IouTracker();
    let out = [] as ReturnType<IouTracker['update']>;
    for (let i = 0; i < 40; i++) out = step(tr, i * 200, [det(0.5, 0.5, 0.2)]); // 8 s
    const h = out[0]!.history;
    expect(h[h.length - 1]!.tMs - h[0]!.tMs).toBeLessThanOrEqual(3000);
    expect(h.length).toBeLessThanOrEqual(16);
  });

  it('is deterministic for the same input', () => {
    const run = () => {
      const tr = new IouTracker();
      let out = [] as ReturnType<IouTracker['update']>;
      for (let i = 0; i < 8; i++) out = step(tr, i * 150, [det(0.3 + i * 0.01, 0.5, 0.2), det(0.7, 0.4, 0.15, 'bus')]);
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('reset clears tracks and ids', () => {
    const tr = new IouTracker();
    step(tr, 0, [det(0.5, 0.5, 0.2)]);
    tr.reset();
    expect(step(tr, 0, [det(0.5, 0.5, 0.2)])[0]!.id).toBe(1);
  });
});
