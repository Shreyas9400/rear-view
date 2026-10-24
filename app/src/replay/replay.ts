// Replay harness (M10): runs tracker -> approach -> alert over recorded per-frame detections, deterministically.
// Fixtures contain detections only (no image data). Malformed fixtures fail loudly with the frame index.

import { ApproachEstimator, type ApproachConfig } from '../core/approach';
import { AlertStateMachine, type AlertConfig } from '../core/alert';
import { IouTracker, type TrackerConfig } from '../core/tracker';
import type { AlertLevel, ApproachEstimate, Detection, HealthFlags, Track, VehicleClass } from '../shared/types';

export interface ReplayFrame {
  tMs: number;
  detections: Detection[];
  /** Defaults to all 'ok' (explicit in the result summary). Use to replay camera/detector outages. */
  health?: HealthFlags;
}

export interface ReplayStep {
  tMs: number;
  tracks: Track[];
  approach: ApproachEstimate[];
  level: AlertLevel;
  trackIds: number[];
}

export interface Transition { tMs: number; from: AlertLevel; to: AlertLevel }

export interface ReplaySummary {
  frames: number;
  durationMs: number;
  trackIdsSeen: number[];
  transitions: Transition[];
  /** Time attributed to each level (each step is held until the next frame). */
  msInLevel: Record<AlertLevel, number>;
  /** Number of entries into POSSIBLE_APPROACH. */
  approachEpisodes: number;
  maxLevel: AlertLevel;
}

export interface ReplayResult { steps: ReplayStep[]; summary: ReplaySummary }

export interface ReplayConfig { tracker?: TrackerConfig; approach?: ApproachConfig; alert?: AlertConfig }

const DEFAULT_HEALTH: HealthFlags = { camera: 'ok', detector: 'ok', sensors: 'ok', thermal: 'ok' };
const SEVERITY: Record<AlertLevel, number> = { NORMAL: 0, VEHICLE_NEARBY: 1, POSSIBLE_APPROACH: 2, VEHICLE_CLOSE: 3, PERSON_CLOSE: 4, UNAVAILABLE: 5 };

export function runReplay(frames: ReplayFrame[], cfg: ReplayConfig = {}): ReplayResult {
  const tracker = new IouTracker(cfg.tracker);
  const approach = new ApproachEstimator(cfg.approach);
  const alert = new AlertStateMachine(cfg.alert);

  const steps: ReplayStep[] = [];
  const seen = new Set<number>();
  const transitions: Transition[] = [];
  const msInLevel: Record<AlertLevel, number> = { NORMAL: 0, VEHICLE_NEARBY: 0, POSSIBLE_APPROACH: 0, VEHICLE_CLOSE: 0, PERSON_CLOSE: 0, UNAVAILABLE: 0 };
  let episodes = 0;
  let maxLevel: AlertLevel = 'NORMAL';

  for (const f of frames) {
    const tracks = tracker.update(f.tMs, f.detections);
    const est = approach.update(f.tMs, tracks);
    const state = alert.update({ tMs: f.tMs, tracks, approach: est, health: f.health ?? DEFAULT_HEALTH });
    for (const t of tracks) seen.add(t.id);

    const prev = steps[steps.length - 1];
    if (prev) {
      msInLevel[prev.level] += f.tMs - prev.tMs;
      if (prev.level !== state.level) transitions.push({ tMs: f.tMs, from: prev.level, to: state.level });
    }
    if (state.level === 'POSSIBLE_APPROACH' && (!prev || prev.level !== 'POSSIBLE_APPROACH')) episodes++;
    // 'UNAVAILABLE' is an outage marker, not a severity of road conditions; rank it below approach for the max.
    if (state.level !== 'UNAVAILABLE' && SEVERITY[state.level] > SEVERITY[maxLevel]) maxLevel = state.level;

    steps.push({
      tMs: f.tMs,
      // Strip history so results stay small and comparable.
      tracks: tracks.map((t) => ({ ...t, history: [] })),
      approach: est,
      level: state.level,
      trackIds: state.trackIds,
    });
  }

  return {
    steps,
    summary: {
      frames: frames.length,
      durationMs: frames.length > 1 ? frames[frames.length - 1]!.tMs - frames[0]!.tMs : 0,
      trackIdsSeen: [...seen].sort((a, b) => a - b),
      transitions,
      msInLevel,
      approachEpisodes: episodes,
      maxLevel,
    },
  };
}

const CLASSES: readonly VehicleClass[] = ['car', 'motorcycle', 'bus', 'truck', 'person'];
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const unit = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/** Validates untrusted fixture JSON. Throws Error('frame N: ...') on the first problem. */
export function parseReplayFixture(json: unknown): ReplayFrame[] {
  if (!Array.isArray(json)) throw new Error('fixture must be an array of frames');
  let lastT = -Infinity;
  return json.map((raw: unknown, i) => {
    const at = (m: string) => new Error(`frame ${i}: ${m}`);
    if (!isObj(raw)) throw at('not an object');
    if (typeof raw.tMs !== 'number' || !Number.isFinite(raw.tMs)) throw at('tMs must be a finite number');
    if (raw.tMs <= lastT) throw at('tMs must be strictly increasing');
    lastT = raw.tMs;
    if (!Array.isArray(raw.detections)) throw at('detections must be an array');
    const detections = raw.detections.map((d: unknown, j) => {
      const dAt = (m: string) => new Error(`frame ${i} detection ${j}: ${m}`);
      if (!isObj(d) || !isObj(d.box)) throw dAt('missing box');
      if (!CLASSES.includes(d.cls as VehicleClass)) throw dAt('unknown class');
      if (!unit(d.score)) throw dAt('score must be within 0..1');
      const { x, y, w, h } = d.box;
      if (![x, y, w, h].every(unit)) throw dAt('box values must be within 0..1');
      if ((w as number) <= 0 || (h as number) <= 0) throw dAt('box must have positive size');
      if ((x as number) + (w as number) > 1 + 1e-9 || (y as number) + (h as number) > 1 + 1e-9) throw dAt('box exceeds frame');
      return d as unknown as Detection;
    });
    const frame: ReplayFrame = { tMs: raw.tMs, detections };
    if (raw.health !== undefined) {
      const h = raw.health;
      const allowed: Record<keyof HealthFlags, readonly string[]> = {
        camera: ['ok', 'stalled', 'denied', 'error'],
        detector: ['ok', 'slow', 'failed'],
        sensors: ['ok', 'missing', 'off'],
        thermal: ['ok', 'warm', 'hot', 'unknown'],
      };
      if (!isObj(h) || !Object.entries(allowed).every(([k, vals]) => vals.includes(h[k] as string))) {
        throw at('health must have valid camera, detector, sensors and thermal values');
      }
      frame.health = h as unknown as HealthFlags;
    }
    return frame;
  });
}
