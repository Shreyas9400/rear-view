// Alert state machine. Thresholds are PLACEHOLDERS until tuned in gate G3 (docs/TESTING_AND_VALIDATION.md).
// Health override: if camera or detector is not 'ok' the level is UNAVAILABLE regardless of tracks.
// NORMAL means "no tracked vehicle", never "road clear".

import type { AlertState, ApproachEstimate, HealthFlags, Track } from '../shared/types';

export interface AlertConfig {
  approachGrowthThr: number;
  minConfidence: number;
  enterUpdates: number;
  exitUpdates: number;
  minTrackAgeFrames: number;
}

export const DEFAULT_ALERT: AlertConfig = {
  approachGrowthThr: 0.15, // per second, placeholder
  minConfidence: 0.5,
  enterUpdates: 3,
  exitUpdates: 4,
  minTrackAgeFrames: 5,
};

export interface AlertInput {
  tMs: number;
  tracks: Track[];
  approach: ApproachEstimate[];
  health: HealthFlags;
}

export class AlertStateMachine {
  private qualify = new Map<number, number>();
  private approachActive = false;
  private quiet = 0;

  constructor(private readonly cfg: AlertConfig = DEFAULT_ALERT) {}

  reset(): void {
    this.qualify.clear();
    this.approachActive = false;
    this.quiet = 0;
  }

  update(i: AlertInput): AlertState {
    const { health, tMs } = i;
    const reasons: string[] = [];
    if (health.camera !== 'ok') reasons.push(`camera ${health.camera}`);
    if (health.detector !== 'ok') reasons.push(`detector ${health.detector}`);
    if (reasons.length > 0) {
      this.reset();
      return { level: 'UNAVAILABLE', reasons, trackIds: [], tMs, health };
    }

    const confirmed = i.tracks.filter((t) => t.state === 'confirmed');
    const estById = new Map(i.approach.map((e) => [e.trackId, e]));
    const next = new Map<number, number>();
    for (const t of confirmed) {
      const e = estById.get(t.id);
      const ok =
        !!e &&
        e.confidence >= this.cfg.minConfidence &&
        e.growthRatePerS >= this.cfg.approachGrowthThr &&
        t.ageFrames >= this.cfg.minTrackAgeFrames;
      next.set(t.id, ok ? (this.qualify.get(t.id) ?? 0) + 1 : 0);
    }
    this.qualify = next;

    const triggered = [...next].filter(([, n]) => n >= this.cfg.enterUpdates).map(([id]) => id);
    const qualifying = [...next].filter(([, n]) => n > 0).map(([id]) => id);

    if (triggered.length > 0) {
      this.approachActive = true;
      this.quiet = 0;
    } else if (this.approachActive) {
      if (qualifying.length > 0) this.quiet = 0;
      else if (++this.quiet >= this.cfg.exitUpdates) this.approachActive = false;
    }

    if (this.approachActive) {
      const ids = qualifying.length > 0 ? qualifying : confirmed.map((t) => t.id);
      return { level: 'POSSIBLE_APPROACH', reasons: ['tracked vehicle growing in frame (experimental heuristic)'], trackIds: ids, tMs, health };
    }
    if (confirmed.length > 0) {
      return { level: 'VEHICLE_NEARBY', reasons: [`${confirmed.length} tracked vehicle(s)`], trackIds: confirmed.map((t) => t.id), tMs, health };
    }
    return { level: 'NORMAL', reasons: ['no tracked vehicle'], trackIds: [], tMs, health };
  }
}
