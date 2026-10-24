// HealthMonitor (docs/ARCHITECTURE.md): combines camera state, detector health, result staleness and the inferred thermal state
// into HealthFlags. Rules: unknown is never 'ok'; if results stop arriving the detector is 'slow' then 'failed' even though the
// detector object itself reports nothing wrong (this is what turns a frozen pipeline into an UNAVAILABLE alert).

import type { HealthFlags } from '../shared/types';

export interface HealthProviders {
  cameraState: () => HealthFlags['camera'];
  /** Health from the detector wrapper (errors, round-trip latency). */
  detectorHealth: () => HealthFlags['detector'];
  /** performance.now() of the last detection result, or null if none yet. */
  lastResultAtMs: () => number | null;
  /** performance.now() when the pipeline was started, or null if it is not running. */
  startedAtMs: () => number | null;
  thermal: () => HealthFlags['thermal'];
  /** The MVP only logs sensors; default 'off'. */
  sensors?: () => HealthFlags['sensors'];
}

export interface HealthConfig {
  /** No result for this long while running: detector 'slow'. */
  staleSlowMs: number;
  /** No result for this long: detector 'failed'. */
  staleFailedMs: number;
  /** The first result gets this much more time (model load and warm-up already happened, but the camera start is slow). */
  firstResultFactor: number;
}

export const DEFAULT_HEALTH: HealthConfig = { staleSlowMs: 2000, staleFailedMs: 5000, firstResultFactor: 2 };

export class HealthMonitor {
  constructor(
    private readonly p: HealthProviders,
    private readonly cfg: HealthConfig = DEFAULT_HEALTH,
  ) {}

  read(nowMs: number): HealthFlags {
    return {
      camera: this.p.cameraState(),
      detector: this.detector(nowMs),
      sensors: this.p.sensors ? this.p.sensors() : 'off',
      thermal: this.p.thermal(),
    };
  }

  private detector(nowMs: number): HealthFlags['detector'] {
    const started = this.p.startedAtMs();
    if (started === null) return 'failed'; // not running: never report ok
    const base = this.p.detectorHealth();
    if (base === 'failed') return 'failed';
    const last = this.p.lastResultAtMs();
    const factor = last === null ? this.cfg.firstResultFactor : 1;
    const age = nowMs - (last ?? started);
    if (age > this.cfg.staleFailedMs * factor) return 'failed';
    if (age > this.cfg.staleSlowMs * factor) return 'slow';
    return base;
  }
}
