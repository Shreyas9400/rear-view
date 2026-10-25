// Rough distance from the size of a detection box (docs/TECHNICAL_DECISIONS.md D-041). NOT a measurement: pinhole geometry with
// an ASSUMED real height per class, so a car 1.5 m tall at 3 m and a truck 3 m tall at 6 m look the same. Expect errors of 20-30 %
// or more, larger for partly visible people and for vehicles that fill the frame. Pure.

import type { VehicleClass } from '../shared/types';

/** Assumed real height (m) of each class, crude averages: small cars ~1.4, SUVs ~1.7, vans and trucks 2-4, adults 1.6-1.8. */
export const REAL_HEIGHT_M: Readonly<Record<VehicleClass, number>> = { car: 1.5, motorcycle: 1.5, bus: 3.0, truck: 3.0, person: 1.7 };

/**
 * k = 1 / (2 tan(vFov / 2)): box height as a fraction of the frame = realHeight * k / distance. 1.3 corresponds to about 41 degrees
 * of vertical field of view (a typical phone main camera in 16:9 video). A GUESS until calibrated with a known distance.
 */
export const DEFAULT_K = 1.3;
export const K_MIN = 0.5; // about 90 degrees vertical field of view
export const K_MAX = 3.0; // about 19 degrees

/** Estimated distance in metres, or null when the box is too small or invalid to say anything. */
export function estimateDistanceM(cls: VehicleClass, boxH: number, k: number = DEFAULT_K): number | null {
  if (!Number.isFinite(boxH) || boxH < 0.03 || !Number.isFinite(k) || k <= 0) return null;
  return (REAL_HEIGHT_M[cls] * k) / boxH;
}

/** The k that makes a box of height boxH for class cls sit at distanceM; null if the sample is implausible. */
export function kFromSample(cls: VehicleClass, boxH: number, distanceM: number): number | null {
  if (!Number.isFinite(boxH) || !Number.isFinite(distanceM) || boxH < 0.05 || boxH > 1 || distanceM < 0.5 || distanceM > 50) return null;
  const k = (distanceM * boxH) / REAL_HEIGHT_M[cls];
  return k >= K_MIN && k <= K_MAX ? k : null;
}

/** "about 4.2 m", "about 12 m", "closer than 1 m"; with the honest word "about". */
export function formatDistance(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return '-';
  if (d < 1) return 'closer than 1 m';
  return `about ${d < 10 ? d.toFixed(1) : Math.round(d)} m`;
}
