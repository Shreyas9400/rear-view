// Alert state machine. Thresholds are PLACEHOLDERS until tuned in gate G3 (docs/TESTING_AND_VALIDATION.md).
// Health override: if camera or detector is not 'ok' the level is UNAVAILABLE regardless of tracks.
// NORMAL means "no tracked vehicle", never "road clear".

import type { AlertState, ApproachEstimate, HealthFlags, Side, Track } from '../shared/types';

/** Side of the image a track is on (image coordinates, not mirrored). */
export function sideOf(t: Track): Side {
  const cx = t.box.x + t.box.w / 2;
  return cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center';
}

const largest = (ts: Track[]): Track | null => ts.reduce<Track | null>((a, t) => (a === null || t.box.h > a.box.h ? t : a), null);

export interface AlertConfig {
  approachGrowthThr: number;
  minConfidence: number;
  enterUpdates: number;
  exitUpdates: number;
  minTrackAgeFrames: number;
  /** A confirmed person whose box is at least this tall (fraction of frame height) counts as close. PLACEHOLDER, untuned (D-036). */
  personCloseH: number;
  /** Once PERSON_CLOSE, a person stays close down to this height (hysteresis). */
  personExitH: number;
  personEnterUpdates: number;
  personExitUpdates: number;
  personMinAgeFrames: number;
  /** After the last confirmed vehicle disappears, keep VEHICLE_NEARBY this long so a flickering box does not flicker the level. */
  nearbyHoldMs: number;
}

export const DEFAULT_ALERT: AlertConfig = {
  approachGrowthThr: 0.15, // per second, placeholder
  minConfidence: 0.5,
  enterUpdates: 3,
  exitUpdates: 4,
  minTrackAgeFrames: 5,
  personCloseH: 0.3,
  personExitH: 0.24,
  personEnterUpdates: 2,
  personExitUpdates: 4,
  personMinAgeFrames: 3,
  nearbyHoldMs: 1500,
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
  private personQualify = 0;
  private personActive = false;
  private personQuiet = 0;
  private lastNearby: { tMs: number; ids: number[]; side: Side | null } | null = null;

  constructor(private readonly cfg: AlertConfig = DEFAULT_ALERT) {}

  reset(): void {
    this.qualify.clear();
    this.approachActive = false;
    this.quiet = 0;
    this.personQualify = 0;
    this.personActive = false;
    this.personQuiet = 0;
    this.lastNearby = null;
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

    const confirmedAll = i.tracks.filter((t) => t.state === 'confirmed');
    // Vehicles drive the approach/nearby levels; people have their own "close" rule below.
    const confirmed = confirmedAll.filter((t) => t.cls !== 'person');
    const persons = confirmedAll.filter((t) => t.cls === 'person');
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

    // Person close: a confirmed person with a tall enough box, for enterUpdates in a row; leaves after exitUpdates quiet updates.
    const closeH = this.personActive ? this.cfg.personExitH : this.cfg.personCloseH;
    const close = persons.filter((t) => t.box.h >= closeH && t.ageFrames >= this.cfg.personMinAgeFrames && t.score >= this.cfg.minConfidence);
    if (close.length > 0) {
      this.personQualify++;
      this.personQuiet = 0;
      if (this.personQualify >= this.cfg.personEnterUpdates) this.personActive = true;
    } else {
      this.personQualify = 0;
      if (this.personActive && ++this.personQuiet >= this.cfg.personExitUpdates) this.personActive = false;
    }
    if (this.personActive) {
      const ids = close.length > 0 ? close.map((t) => t.id) : persons.map((t) => t.id);
      const reasons = ['person close behind the vehicle (experimental, box size is only a proxy for distance)'];
      if (this.approachActive) reasons.push('a tracked vehicle is also growing in frame');
      const main = largest((close.length > 0 ? close : persons).filter((t) => ids.includes(t.id)));
      return { level: 'PERSON_CLOSE', reasons, trackIds: ids, side: main ? sideOf(main) : null, tMs, health };
    }

    if (this.approachActive) {
      const ids = qualifying.length > 0 ? qualifying : confirmed.map((t) => t.id);
      const main = largest(confirmed.filter((t) => ids.includes(t.id)));
      const side = main ? sideOf(main) : null;
      return { level: 'POSSIBLE_APPROACH', reasons: ['tracked vehicle growing in frame (experimental heuristic)'], trackIds: ids, side, tMs, health };
    }
    if (confirmed.length > 0) {
      const main = largest(confirmed);
      const side = main ? sideOf(main) : null;
      this.lastNearby = { tMs, ids: confirmed.map((t) => t.id), side };
      return { level: 'VEHICLE_NEARBY', reasons: [`${confirmed.length} tracked vehicle(s)`], trackIds: confirmed.map((t) => t.id), side, tMs, health };
    }
    if (this.lastNearby && tMs - this.lastNearby.tMs <= this.cfg.nearbyHoldMs) {
      return { level: 'VEHICLE_NEARBY', reasons: ['tracked vehicle just lost (holding)'], trackIds: this.lastNearby.ids, side: this.lastNearby.side, tMs, health };
    }
    const reason = persons.length > 0 ? `no tracked vehicle; ${persons.length} person(s) tracked, not close` : 'no tracked vehicle';
    return { level: 'NORMAL', reasons: [reason], trackIds: [], tMs, health };
  }
}
