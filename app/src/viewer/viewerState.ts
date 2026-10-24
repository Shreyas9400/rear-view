// Viewer state classification (docs/PROTOCOL_SPEC.md §10). Pure; the viewer page feeds it facts once per tick.
// Safety rule: anything unknown or stale is shown as unavailable. A stale alert is never shown as current,
// and NORMAL is worded "No tracked vehicle", never "all clear".

import { CLOSE } from '../shared/protocol';
import type { AlertLevel, HealthFlags } from '../shared/types';

export type ViewerState = 'LIVE' | 'DELAYED' | 'STALE' | 'DISCONNECTED' | 'DETECTOR_UNAVAILABLE' | 'INVALID_SESSION';

export const THRESH = {
  liveGapMs: 500,
  staleGapMs: 1000,
  lostMsgGapMs: 3000,
  liveAgeMs: 1000,
  liveDetAgeMs: 1500,
} as const;

const INVALID_CODES: readonly number[] = [CLOSE.badToken, CLOSE.badOrigin, CLOSE.revoked, CLOSE.expired];

export interface ViewerFacts {
  nowMs: number;
  socketOpen: boolean;
  closeCode: number | null;
  /** Viewer-clock time the last binary frame / any message arrived; null if none yet. */
  lastFrameAtMs: number | null;
  lastMsgAtMs: number | null;
  /** Offset-corrected age of the newest frame (PROTOCOL_SPEC §9); null if unknown. */
  frameAgeMs: number | null;
  /** FrameMeta.detAgeMs; null if no detection has been computed yet. */
  detAgeMs: number | null;
  /** From the latest status/frame; null if unknown (treated as not ok). */
  health: HealthFlags | null;
  alertLevel: AlertLevel | null;
  ingest: 'connected' | 'disconnected' | null;
}

export interface ViewerView {
  state: ViewerState;
  showBoxes: boolean;
  /** Level to display. Always 'UNAVAILABLE' unless the feed is LIVE or DELAYED. */
  alertLevel: AlertLevel;
  banner: string | null;
  audioCueAllowed: boolean;
}

function view(state: ViewerState, over: Partial<ViewerView>): ViewerView {
  return { state, showBoxes: false, alertLevel: 'UNAVAILABLE', banner: null, audioCueAllowed: false, ...over };
}

export function classifyViewer(f: ViewerFacts): ViewerView {
  if (!f.socketOpen && f.closeCode !== null && INVALID_CODES.includes(f.closeCode)) {
    return view('INVALID_SESSION', { banner: 'Session invalid - open the new link shown on the rear phone' });
  }
  const msgGap = f.lastMsgAtMs === null ? Infinity : f.nowMs - f.lastMsgAtMs;
  if (!f.socketOpen || msgGap >= THRESH.lostMsgGapMs) {
    return view('DISCONNECTED', { banner: 'LINK LOST - reconnecting' });
  }
  const gap = f.lastFrameAtMs === null ? Infinity : f.nowMs - f.lastFrameAtMs;
  if (gap >= THRESH.staleGapMs) {
    return view('STALE', { banner: 'FEED STALE' });
  }

  const h = f.health;
  const detectorDown =
    h === null ||
    h.camera !== 'ok' ||
    h.detector !== 'ok' ||
    f.alertLevel === null ||
    f.alertLevel === 'UNAVAILABLE' ||
    f.ingest !== 'connected' ||
    f.detAgeMs === null ||
    f.detAgeMs + (f.frameAgeMs ?? 0) > THRESH.liveDetAgeMs;
  if (detectorDown) {
    return view('DETECTOR_UNAVAILABLE', { banner: 'DETECTION UNAVAILABLE' });
  }

  const alertLevel = f.alertLevel as AlertLevel;
  const age = f.frameAgeMs;
  if (gap >= THRESH.liveGapMs || age === null || age > THRESH.liveAgeMs) {
    const secs = age === null ? null : Math.round(age / 100) / 10;
    return view('DELAYED', { showBoxes: true, alertLevel, banner: secs === null ? 'DELAYED' : `DELAYED ${secs} s` });
  }
  return view('LIVE', { showBoxes: true, alertLevel, audioCueAllowed: true });
}

/** Audio cue only on a transition into POSSIBLE_APPROACH while LIVE (user must have tapped to enable audio). */
export function shouldPlayApproachCue(prev: ViewerView | null, next: ViewerView): boolean {
  return next.audioCueAllowed && next.alertLevel === 'POSSIBLE_APPROACH' && !(prev?.audioCueAllowed && prev.alertLevel === 'POSSIBLE_APPROACH');
}
