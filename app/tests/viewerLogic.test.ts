import { describe, expect, it } from 'vitest';
import { FORGET_TOKEN_CODES, BEEP_PERSON, displaySide, panFor, pickToken, beepIntervalMs, beepLengthMs, ClockOffset, frameAgeMs, levelText, nearestBoxH, reconnectDelayMs, shouldReconnect, tokenFromHash } from '../src/viewer/viewerLogic';

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

describe('person beeping and wording (D-036)', () => {
  it('uses a separate curve for people: 800 ms gaps at the close threshold, 100 ms when the person fills the frame', () => {
    expect(beepIntervalMs(0.3, BEEP_PERSON)).toBe(800);
    expect(beepIntervalMs(0.75, BEEP_PERSON)).toBe(100);
    expect(beepIntervalMs(0.5, BEEP_PERSON)).toBeLessThan(beepIntervalMs(0.4, BEEP_PERSON));
    expect(beepIntervalMs(0.3)).toBeLessThan(beepIntervalMs(0.3, BEEP_PERSON)); // the vehicle curve is already fast by 0.3
  });
  it('nearestBoxH separates people from vehicles', () => {
    const t = (cls: string, h: number) => ({ state: 'confirmed', cls, box: { h } });
    const tracks = [t('car', 0.2), t('person', 0.5), t('truck', 0.3), t('person', 0.35)];
    expect(nearestBoxH(tracks)).toBe(0.3);
    expect(nearestBoxH(tracks, 'person')).toBe(0.5);
    expect(nearestBoxH([t('car', 0.2)], 'person')).toBeNull();
  });
  it('words PERSON_CLOSE as a warning without calling anything safe', () => {
    expect(levelText('PERSON_CLOSE')).toBe('PERSON CLOSE BEHIND (experimental)');
    expect(levelText('PERSON_CLOSE').toLowerCase()).not.toMatch(/clear|safe/);
  });
});

describe('direction wording, mirroring and the remembered token', () => {
  it('mirrors left and right like a rear-view mirror, never the centre, and rejects unknown values', () => {
    expect(displaySide('left', true)).toBe('right');
    expect(displaySide('right', true)).toBe('left');
    expect(displaySide('left', false)).toBe('left');
    expect(displaySide('center', true)).toBe('center');
    expect(displaySide(undefined, true)).toBeNull();
    expect(displaySide('up', true)).toBeNull();
  });
  it('pans beeps towards the side', () => {
    expect([panFor('left'), panFor('center'), panFor('right'), panFor(null)]).toEqual([-0.8, 0, 0.8, 0]);
  });
  it('words the side for each level, and still never calls anything clear or safe', () => {
    expect(levelText('POSSIBLE_APPROACH', 'left')).toBe('POSSIBLE APPROACH (experimental) - from the LEFT');
    expect(levelText('POSSIBLE_APPROACH', 'center')).toContain('straight behind');
    expect(levelText('PERSON_CLOSE', 'right')).toBe('PERSON CLOSE BEHIND (experimental) - on the RIGHT');
    expect(levelText('VEHICLE_NEARBY', 'left')).toBe('Vehicle detected behind - on the left');
    expect(levelText('VEHICLE_CLOSE', 'right')).toBe('VEHICLE VERY CLOSE (experimental) - on the RIGHT');
    expect(levelText('VEHICLE_CLOSE')).toBe('VEHICLE VERY CLOSE (experimental)');
    expect(levelText('NORMAL', 'left')).toBe('No tracked vehicle');
    expect(levelText('UNAVAILABLE', 'left')).toBe('DETECTION UNAVAILABLE');
    for (const l of ['NORMAL', 'VEHICLE_NEARBY', 'POSSIBLE_APPROACH', 'VEHICLE_CLOSE', 'PERSON_CLOSE', 'UNAVAILABLE']) for (const sd of ['left', 'right', 'center', null] as const) expect(levelText(l, sd).toLowerCase()).not.toMatch(/clear|safe/);
  });
  it('uses the token from a fresh link and remembers it, else the remembered one, else none', () => {
    expect(pickToken('#t=abcdefgh12345', 'oldtoken1234')).toEqual({ token: 'abcdefgh12345', store: 'abcdefgh12345' });
    expect(pickToken('', 'oldtoken1234')).toEqual({ token: 'oldtoken1234', store: null });
    expect(pickToken('', null)).toEqual({ token: null, store: null });
    expect(pickToken('#junk', 'bad token!')).toEqual({ token: null, store: null });
  });
  it('forgets the token only when the rear phone rejected it', () => {
    expect([...FORGET_TOKEN_CODES]).toEqual([4401, 4410, 4411]);
    expect(FORGET_TOKEN_CODES.includes(4430)).toBe(false);
  });
});
