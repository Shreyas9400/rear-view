// Normative wire and module types. Mirrors docs/PROTOCOL_SPEC.md §6 and docs/ARCHITECTURE.md.

export type VehicleClass = 'car' | 'motorcycle' | 'bus' | 'truck';

/** Normalised 0..1, top-left origin, relative to the source frame / JPEG. */
export interface Box { x: number; y: number; w: number; h: number }

export interface Detection { cls: VehicleClass; score: number; box: Box }

export interface TrackSample { tMs: number; cx: number; cy: number; h: number }

export interface Track {
  id: number;
  cls: VehicleClass;
  box: Box;
  score: number;
  state: 'tentative' | 'confirmed' | 'lost';
  ageFrames: number;
  missedFrames: number;
  history: TrackSample[];
}

export interface ApproachEstimate {
  trackId: number;
  /** Robust slope of ln(box height) per second. A trend only. */
  growthRatePerS: number;
  /** 1/growth when growth > 0, else null. Not a distance or a collision time. */
  ttcProxyS: number | null;
  /** 0..1 */
  confidence: number;
}

export type AlertLevel = 'NORMAL' | 'VEHICLE_NEARBY' | 'POSSIBLE_APPROACH' | 'UNAVAILABLE';

export interface HealthFlags {
  camera: 'ok' | 'stalled' | 'denied' | 'error';
  detector: 'ok' | 'slow' | 'failed';
  sensors: 'ok' | 'missing' | 'off';
  thermal: 'ok' | 'warm' | 'hot' | 'unknown';
}

export interface AlertState {
  level: AlertLevel;
  reasons: string[];
  trackIds: number[];
  tMs: number;
  health: HealthFlags;
}

export interface FrameMeta {
  v: 1;
  seq: number;
  tCaptureMs: number;
  tCaptureEpochMs: number;
  tEncodeMs: number;
  w: number;
  h: number;
  jpegQuality: number;
  detSeq: number | null;
  detAgeMs: number | null;
  detections: Detection[];
  tracks: Track[];
  alert: AlertState;
}
