// User calibration of the distance estimate and the "close" alert points (D-041). Pure; the rear screen persists it as JSON.

import { K_MAX, K_MIN } from './distance';

export interface Calibration {
  /** Distance scale k (see distance.ts); null = the default guess. */
  k: number | null;
  /** Box height (fraction of the frame) at which a vehicle counts as "very close"; null = the default. */
  vehicleCloseH: number | null;
  /** Same for a person. */
  personCloseH: number | null;
}

export const EMPTY_CALIBRATION: Calibration = { k: null, vehicleCloseH: null, personCloseH: null };

/** A close point is taken from a real box; below 0.12 it would fire constantly, above 0.95 never. */
export const CLOSE_MIN = 0.12;
export const CLOSE_MAX = 0.95;
/** The alert is kept until the box has shrunk to this fraction of the close height (hysteresis). */
export const EXIT_RATIO = 0.8;

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** Reads saved JSON defensively: unknown or out-of-range values fall back to the defaults. */
export function parseCalibration(json: string | null | undefined): Calibration {
  if (!json) return { ...EMPTY_CALIBRATION };
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return { k: num(o.k, K_MIN, K_MAX), vehicleCloseH: num(o.vehicleCloseH, CLOSE_MIN, CLOSE_MAX), personCloseH: num(o.personCloseH, CLOSE_MIN, CLOSE_MAX) };
  } catch {
    return { ...EMPTY_CALIBRATION };
  }
}

/** The close height to use when a real vehicle or person stands where the alert should start. Null if the box is implausible. */
export function closeHFromBox(boxH: number): number | null {
  return num(boxH, CLOSE_MIN, CLOSE_MAX);
}

/** AlertConfig overrides for a calibration (only the values that were set). */
export function alertOverrides(c: Calibration): { vehicleCloseH?: number; vehicleExitH?: number; personCloseH?: number; personExitH?: number } {
  const o: { vehicleCloseH?: number; vehicleExitH?: number; personCloseH?: number; personExitH?: number } = {};
  if (c.vehicleCloseH !== null) {
    o.vehicleCloseH = c.vehicleCloseH;
    o.vehicleExitH = c.vehicleCloseH * EXIT_RATIO;
  }
  if (c.personCloseH !== null) {
    o.personCloseH = c.personCloseH;
    o.personExitH = c.personCloseH * EXIT_RATIO;
  }
  return o;
}
