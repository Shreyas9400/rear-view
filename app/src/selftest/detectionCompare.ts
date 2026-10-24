// Compare the detections the model produced for the SAME frame through two payload formats (raw RGB vs JPEG, D-030).
// Pure, so it is unit-tested. A detection is "kept" when its score is at least the decision threshold. Detections are matched
// greedily (highest reference score first) by class and IoU. Scores below the threshold but above the model's own floor are
// still returned by the native side when the test runs with a lower scoreThr, which is what shows threshold crossings.

export interface Det {
  classId: number;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function iou(a: Det, b: Det): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export interface FrameComparison {
  /** Reference (raw) detections at or above the threshold. */
  refKept: number;
  /** Test (JPEG) detections at or above the threshold. */
  testKept: number;
  /** Reference detections whose counterpart in the test is also kept. */
  matchedKept: number;
  /** Reference detection has a counterpart but its test score is below the threshold (dropped by the threshold). */
  lostBelowThreshold: number;
  /** Reference detection has no counterpart at all in the test. */
  lostMissing: number;
  /** Test detection kept, whose reference counterpart was below the threshold (pushed over the line). */
  gainedCrossedUp: number;
  /** Test detection kept with no counterpart in the reference at all. */
  gainedNew: number;
  /** |score difference| of every matched pair (kept or not). */
  dScores: number[];
  /** IoU of every matched pair. */
  ious: number[];
  /** True when the set of kept detections is identical in size and every kept one is matched both ways. */
  sameKeptSet: boolean;
}

export function compareDetections(ref: Det[], test: Det[], thr: number, minIou = 0.5): FrameComparison {
  const refSorted = [...ref].sort((a, b) => b.score - a.score);
  const usedTest = new Set<number>();
  const pairs = new Map<Det, { t: Det; iou: number }>();
  for (const r of refSorted) {
    let bestI = -1;
    let bestIou = minIou;
    test.forEach((t, i) => {
      if (usedTest.has(i) || t.classId !== r.classId) return;
      const v = iou(r, t);
      if (v >= bestIou) {
        bestIou = v;
        bestI = i;
      }
    });
    if (bestI >= 0) {
      usedTest.add(bestI);
      pairs.set(r, { t: test[bestI]!, iou: bestIou });
    }
  }

  const c: FrameComparison = { refKept: 0, testKept: 0, matchedKept: 0, lostBelowThreshold: 0, lostMissing: 0, gainedCrossedUp: 0, gainedNew: 0, dScores: [], ious: [], sameKeptSet: false };
  for (const r of ref) {
    const p = pairs.get(r);
    if (p) {
      c.dScores.push(Math.abs(p.t.score - r.score));
      c.ious.push(p.iou);
    }
    if (r.score < thr) continue;
    c.refKept++;
    if (!p) c.lostMissing++;
    else if (p.t.score >= thr) c.matchedKept++;
    else c.lostBelowThreshold++;
  }
  const refOfTest = new Map<Det, Det>();
  for (const [r, p] of pairs) refOfTest.set(p.t, r);
  for (const t of test) {
    if (t.score < thr) continue;
    c.testKept++;
    const r = refOfTest.get(t);
    if (!r) c.gainedNew++;
    else if (r.score < thr) c.gainedCrossedUp++;
  }
  c.sameKeptSet = c.refKept === c.testKept && c.matchedKept === c.refKept;
  return c;
}

export interface Summary {
  frames: number;
  framesWithRef: number;
  refKept: number;
  testKept: number;
  matchedKept: number;
  lostBelowThreshold: number;
  lostMissing: number;
  gainedCrossedUp: number;
  gainedNew: number;
  framesIdentical: number;
  meanDScore: number;
  p95DScore: number;
  maxDScore: number;
  meanIou: number;
  minIou: number;
}

export function summarise(frames: FrameComparison[]): Summary {
  const sum = (f: (c: FrameComparison) => number) => frames.reduce((a, c) => a + f(c), 0);
  const d = frames.flatMap((c) => c.dScores).sort((a, b) => a - b);
  const i = frames.flatMap((c) => c.ious);
  return {
    frames: frames.length,
    framesWithRef: frames.filter((c) => c.refKept > 0).length,
    refKept: sum((c) => c.refKept),
    testKept: sum((c) => c.testKept),
    matchedKept: sum((c) => c.matchedKept),
    lostBelowThreshold: sum((c) => c.lostBelowThreshold),
    lostMissing: sum((c) => c.lostMissing),
    gainedCrossedUp: sum((c) => c.gainedCrossedUp),
    gainedNew: sum((c) => c.gainedNew),
    framesIdentical: frames.filter((c) => c.sameKeptSet).length,
    meanDScore: d.length ? d.reduce((a, b) => a + b, 0) / d.length : NaN,
    p95DScore: d.length ? d[Math.min(d.length - 1, Math.floor(0.95 * d.length))]! : NaN,
    maxDScore: d.length ? d[d.length - 1]! : NaN,
    meanIou: i.length ? i.reduce((a, b) => a + b, 0) / i.length : NaN,
    minIou: i.length ? Math.min(...i) : NaN,
  };
}
