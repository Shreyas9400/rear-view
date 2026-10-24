// IoU tracker with constant-velocity centre prediction. Pure; no platform dependencies.
// States: tentative (< minHits consecutive hits) -> confirmed -> lost (no match > lostAfterMs) -> deleted (> deleteAfterMs).
// A tentative track that misses a frame is deleted immediately (suppresses single-frame blips).

import type { Box, Detection, Track, TrackSample } from '../shared/types';
import { iou } from './decode';

export interface TrackerConfig {
  iouThr: number;
  minHits: number;
  lostAfterMs: number;
  deleteAfterMs: number;
  historyMs: number;
}

export const DEFAULT_TRACKER: TrackerConfig = {
  iouThr: 0.3,
  minHits: 3,
  lostAfterMs: 1000,
  deleteAfterMs: 2000,
  historyMs: 3000,
};

interface Internal {
  id: number;
  cls: Track['cls'];
  box: Box;
  score: number;
  state: Track['state'];
  hits: number;
  ageFrames: number;
  missedFrames: number;
  lastSeenMs: number;
  vx: number; // normalised units per second
  vy: number;
  history: TrackSample[];
}

const center = (b: Box) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 });

function predicted(t: Internal, tMs: number): Box {
  const dt = Math.min(1, Math.max(0, (tMs - t.lastSeenMs) / 1000));
  return { x: t.box.x + t.vx * dt, y: t.box.y + t.vy * dt, w: t.box.w, h: t.box.h };
}

export class IouTracker {
  private tracks: Internal[] = [];
  private nextId = 1;

  constructor(private readonly cfg: TrackerConfig = DEFAULT_TRACKER) {}

  reset(): void {
    this.tracks = [];
    this.nextId = 1;
  }

  update(tMs: number, dets: Detection[]): Track[] {
    const pairs: { ti: number; di: number; v: number }[] = [];
    this.tracks.forEach((t, ti) => {
      const pb = predicted(t, tMs);
      dets.forEach((d, di) => {
        const v = iou(pb, d.box);
        if (v >= this.cfg.iouThr) pairs.push({ ti, di, v });
      });
    });
    pairs.sort((a, b) => b.v - a.v || a.ti - b.ti || a.di - b.di);

    const trackUsed = new Set<number>();
    const detUsed = new Set<number>();
    for (const p of pairs) {
      if (trackUsed.has(p.ti) || detUsed.has(p.di)) continue;
      trackUsed.add(p.ti);
      detUsed.add(p.di);
      this.applyMatch(this.tracks[p.ti]!, dets[p.di]!, tMs);
    }

    const survivors: Internal[] = [];
    this.tracks.forEach((t, ti) => {
      if (!trackUsed.has(ti)) {
        t.ageFrames += 1;
        t.missedFrames += 1;
        t.hits = 0; // "consecutive" hits
        if (t.state === 'tentative') return; // deleted immediately
        const sinceSeen = tMs - t.lastSeenMs;
        if (sinceSeen > this.cfg.deleteAfterMs) return;
        if (sinceSeen > this.cfg.lostAfterMs) t.state = 'lost';
      }
      survivors.push(t);
    });

    dets.forEach((d, di) => {
      if (detUsed.has(di)) return;
      const c = center(d.box);
      survivors.push({
        id: this.nextId++,
        cls: d.cls,
        box: d.box,
        score: d.score,
        state: this.cfg.minHits <= 1 ? 'confirmed' : 'tentative',
        hits: 1,
        ageFrames: 1,
        missedFrames: 0,
        lastSeenMs: tMs,
        vx: 0,
        vy: 0,
        history: [{ tMs, cx: c.cx, cy: c.cy, h: d.box.h }],
      });
    });

    this.tracks = survivors;
    return this.tracks.map(toTrack);
  }

  private applyMatch(t: Internal, d: Detection, tMs: number): void {
    const prev = center(t.box);
    const now = center(d.box);
    const dt = (tMs - t.lastSeenMs) / 1000;
    if (dt > 0) {
      t.vx = 0.5 * t.vx + 0.5 * ((now.cx - prev.cx) / dt);
      t.vy = 0.5 * t.vy + 0.5 * ((now.cy - prev.cy) / dt);
    }
    t.box = d.box;
    t.score = d.score;
    t.cls = d.cls;
    t.hits += 1;
    t.ageFrames += 1;
    t.missedFrames = 0;
    t.lastSeenMs = tMs;
    t.history.push({ tMs, cx: now.cx, cy: now.cy, h: d.box.h });
    const cutoff = tMs - this.cfg.historyMs;
    while (t.history.length > 0 && t.history[0]!.tMs < cutoff) t.history.shift();
    if (t.hits >= this.cfg.minHits) t.state = 'confirmed';
    else if (t.state === 'lost') t.state = 'tentative';
  }
}

function toTrack(t: Internal): Track {
  return {
    id: t.id,
    cls: t.cls,
    box: { ...t.box },
    score: t.score,
    state: t.state,
    ageFrames: t.ageFrames,
    missedFrames: t.missedFrames,
    history: t.history.map((s) => ({ ...s })),
  };
}
