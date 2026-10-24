import { describe, expect, it } from 'vitest';
import { classifyViewer, shouldPlayApproachCue, type ViewerFacts } from '../src/viewer/viewerState';
import { CLOSE } from '../src/shared/protocol';
import { OK } from './helpers';

const live = (over: Partial<ViewerFacts> = {}): ViewerFacts => ({
  nowMs: 10_000,
  socketOpen: true,
  closeCode: null,
  lastFrameAtMs: 9_900,
  lastMsgAtMs: 9_950,
  frameAgeMs: 300,
  detAgeMs: 200,
  health: OK,
  alertLevel: 'NORMAL',
  ingest: 'connected',
  ...over,
});

describe('classifyViewer', () => {
  it('LIVE when everything is fresh and ok', () => {
    const v = classifyViewer(live());
    expect(v).toMatchObject({ state: 'LIVE', showBoxes: true, alertLevel: 'NORMAL', banner: null, audioCueAllowed: true });
  });

  it('missing sensors or unknown thermal do not block LIVE (MVP logs sensors only)', () => {
    expect(classifyViewer(live({ health: { ...OK, sensors: 'missing', thermal: 'unknown' } })).state).toBe('LIVE');
  });

  it('DELAYED when frames are slow or old, still showing the real level but no audio', () => {
    const slow = classifyViewer(live({ lastFrameAtMs: 9_400, alertLevel: 'POSSIBLE_APPROACH' }));
    expect(slow).toMatchObject({ state: 'DELAYED', alertLevel: 'POSSIBLE_APPROACH', audioCueAllowed: false });
    const old = classifyViewer(live({ frameAgeMs: 1100 }));
    expect(old.state).toBe('DELAYED');
    expect(old.banner).toBe('DELAYED 1.1 s');
    // Spec: detAge = detAgeMs + frame age. At 1.5 s old the boxes are too old to show, so this is not merely DELAYED.
    expect(classifyViewer(live({ frameAgeMs: 1500 })).state).toBe('DETECTOR_UNAVAILABLE');
    expect(classifyViewer(live({ frameAgeMs: null })).state).toBe('DELAYED');
  });

  it('STALE when the socket is alive but no frame for 1 s: alert is UNAVAILABLE, never the last alert', () => {
    const v = classifyViewer(live({ lastFrameAtMs: 8_900, alertLevel: 'POSSIBLE_APPROACH' }));
    expect(v).toMatchObject({ state: 'STALE', showBoxes: false, alertLevel: 'UNAVAILABLE', banner: 'FEED STALE' });
    expect(classifyViewer(live({ lastFrameAtMs: null })).state).toBe('STALE');
  });

  it('DISCONNECTED when the socket closed or nothing arrived for 3 s', () => {
    expect(classifyViewer(live({ socketOpen: false, closeCode: 1006 })).state).toBe('DISCONNECTED');
    expect(classifyViewer(live({ lastMsgAtMs: 6_999 })).state).toBe('DISCONNECTED');
    expect(classifyViewer(live({ lastMsgAtMs: null })).state).toBe('DISCONNECTED');
    expect(classifyViewer(live({ socketOpen: false, closeCode: 1006 })).alertLevel).toBe('UNAVAILABLE');
  });

  it('INVALID_SESSION on auth/origin/revoke/expiry close codes and not for others', () => {
    for (const code of [CLOSE.badToken, CLOSE.badOrigin, CLOSE.revoked, CLOSE.expired]) {
      expect(classifyViewer(live({ socketOpen: false, closeCode: code })).state).toBe('INVALID_SESSION');
    }
    expect(classifyViewer(live({ socketOpen: false, closeCode: CLOSE.slowViewer })).state).toBe('DISCONNECTED');
    expect(classifyViewer(live({ socketOpen: false, closeCode: CLOSE.rateLimited })).state).toBe('DISCONNECTED');
  });

  it('DETECTOR_UNAVAILABLE hides boxes and the alert for every unhealthy or unknown input', () => {
    const cases: Partial<ViewerFacts>[] = [
      { health: { ...OK, detector: 'failed' } },
      { health: { ...OK, detector: 'slow' } },
      { health: { ...OK, camera: 'stalled' } },
      { health: null },
      { alertLevel: 'UNAVAILABLE' },
      { alertLevel: null },
      { ingest: 'disconnected' },
      { ingest: null },
      { detAgeMs: null },
      { detAgeMs: 1400, frameAgeMs: 300 },
    ];
    for (const c of cases) {
      const v = classifyViewer(live(c));
      expect(v, JSON.stringify(c)).toMatchObject({ state: 'DETECTOR_UNAVAILABLE', showBoxes: false, alertLevel: 'UNAVAILABLE', banner: 'DETECTION UNAVAILABLE' });
    }
  });

  it('stale feed wins over a healthy-looking last status', () => {
    expect(classifyViewer(live({ lastFrameAtMs: 5_000, lastMsgAtMs: 9_900 })).state).toBe('STALE');
  });

  it('plays the approach cue only on entry to LIVE POSSIBLE_APPROACH', () => {
    const calm = classifyViewer(live());
    const approach = classifyViewer(live({ alertLevel: 'POSSIBLE_APPROACH' }));
    const delayedApproach = classifyViewer(live({ alertLevel: 'POSSIBLE_APPROACH', frameAgeMs: 2000 }));
    expect(shouldPlayApproachCue(calm, approach)).toBe(true);
    expect(shouldPlayApproachCue(null, approach)).toBe(true);
    expect(shouldPlayApproachCue(approach, approach)).toBe(false);
    expect(shouldPlayApproachCue(calm, delayedApproach)).toBe(false);
    expect(shouldPlayApproachCue(calm, calm)).toBe(false);
  });
});
