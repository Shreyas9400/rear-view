import { describe, expect, it } from 'vitest';
import { beepIntervalMs, beepLengthMs, ClockOffset, frameAgeMs, levelText, nearestBoxH, reconnectDelayMs, shouldReconnect, tokenFromHash } from '../src/viewer/viewerLogic';

describe('tokenFromHash', () => {
  it('reads a base64url token from the fragment', () => {
    expect(tokenFromHash('#t=q3J0u8o2zY9mPpL1hT6VdA')).toBe('q3J0u8o2zY9mPpL1hT6VdA');
    expect(tokenFromHash('#x=1&t=abcdefgh_-12')).toBe('abcdefgh_-12');
  });
  it('rejects missing, short, long or odd tokens', () => {
    for (const h of ['', '#', '#t=', '#t=short', '#t=' + 'a'.repeat(65), '#t=abc def ghi', '#t=abcdefgh<script>', '#token=abcdefghijkl']) {
      expect(tokenFromHash(h)).toBeNull();
    }
  });
});

describe('reconnectDelayMs', () => {
  it('backs off 0.5 s, 1 s, 2 s, then stays at 2 s, with +-20% jitter', () => {
    expect([0, 1, 2, 3, 10].map((a) => reconnectDelayMs(a, 0.5))).toEqual([500, 1000, 2000, 2000, 2000]);
    expect(reconnectDelayMs(0, 0)).toBe(400);
    expect(reconnectDelayMs(2, 0.999)).toBeLessThanOrEqual(2400);
  });
});

describe('ClockOffset', () => {
  it('uses the smallest round trip sample', () => {
    const c = new ClockOffset();
    expect(c.offsetMs()).toBeNull();
    c.add(1000, 1200, 5100); // rtt 200 -> offset 5100 - 1100 = 4000
    c.add(2000, 2020, 6010); // rtt 20 -> offset 6010 - 2010 = 4000 (best)
    c.add(3000, 3400, 7300); // rtt 400, offset 3600 (ignored: worse rtt)
    expect(c.offsetMs()).toBe(4000);
  });
  it('forgets old samples and ignores invalid ones', () => {
    const c = new ClockOffset(2);
    c.add(0, 10, 1005); // offset 1000, rtt 10
    c.add(0, 100, 1100); // 1050, rtt 100
    c.add(0, 200, 1300); // 1200, rtt 200 -> the first sample is dropped
    expect(c.offsetMs()).toBe(1050);
    c.add(10, 5, 0);
    c.add(0, 1, NaN);
    expect(c.offsetMs()).toBe(1050);
    c.reset();
    expect(c.offsetMs()).toBeNull();
  });
});

describe('frameAgeMs', () => {
  it('is the corrected viewer time minus the capture time, never negative, and null when unknown', () => {
    expect(frameAgeMs(10_000, 500, 10_000)).toBe(500);
    expect(frameAgeMs(10_000, -2000, 10_000)).toBe(0);
    expect(frameAgeMs(10_000, null, 9_000)).toBeNull();
    expect(frameAgeMs(10_000, 0, undefined)).toBeNull();
  });
});

describe('reconnect policy and wording', () => {
  it('does not reconnect after an invalid-session close', () => {
    for (const c of [4401, 4403, 4410, 4411]) expect(shouldReconnect(c)).toBe(false);
    for (const c of [1006, 1001, 4429, 4430, 4440, 4408, null]) expect(shouldReconnect(c)).toBe(true);
  });
  it('never words NORMAL as clear or safe', () => {
    for (const l of ['NORMAL', 'VEHICLE_NEARBY', 'POSSIBLE_APPROACH', 'UNAVAILABLE', 'x']) expect(levelText(l).toLowerCase()).not.toMatch(/clear|safe/);
    expect(levelText('NORMAL')).toBe('No tracked vehicle');
    expect(levelText('whatever')).toBe('DETECTION UNAVAILABLE');
  });
});

describe('proximity beeping', () => {
  it('beeps slowly for small boxes and almost continuously for large ones, never faster than the floor', () => {
    expect(beepIntervalMs(0.02)).toBe(1500);
    expect(beepIntervalMs(0.08)).toBe(1500);
    expect(beepIntervalMs(0.45)).toBe(100);
    expect(beepIntervalMs(0.9)).toBe(100);
    expect(beepIntervalMs(null)).toBe(600);
    expect(beepIntervalMs(NaN)).toBe(600);
  });
  it('gets steadily faster as the box grows', () => {
    let prev = Infinity;
    for (let h = 0.05; h <= 0.5; h += 0.02) {
      const v = beepIntervalMs(h);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
    expect(beepIntervalMs(0.2)).toBeLessThan(beepIntervalMs(0.12));
  });
  it('keeps each beep shorter than the gap so beeps stay separate', () => {
    for (const gap of [100, 300, 800, 1500]) expect(beepLengthMs(gap)).toBeLessThan(gap);
    expect(beepLengthMs(100)).toBe(60);
    expect(beepLengthMs(1500)).toBe(140);
  });
  it('uses the largest confirmed track only', () => {
    const t = (state: string, h: number) => ({ state, box: { h } });
    expect(nearestBoxH([t('confirmed', 0.1), t('confirmed', 0.3), t('tentative', 0.6), t('lost', 0.9)])).toBe(0.3);
    expect(nearestBoxH([t('tentative', 0.6)])).toBeNull();
    expect(nearestBoxH([])).toBeNull();
  });
});
