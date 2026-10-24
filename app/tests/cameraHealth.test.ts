import { describe, expect, it } from 'vitest';
import { CameraHealth, classifyCameraError, STALL_MS } from '../src/capture/cameraHealth';

describe('classifyCameraError', () => {
  it('maps permission errors to denied and everything else to error', () => {
    for (const n of ['NotAllowedError', 'SecurityError', 'PermissionDeniedError']) expect(classifyCameraError(n)).toBe('denied');
    for (const n of ['NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError', undefined]) expect(classifyCameraError(n)).toBe('error');
  });
});

describe('CameraHealth', () => {
  it('is never ok before it has started', () => {
    expect(new CameraHealth().state(0)).toBe('error');
  });

  it('is ok while frames keep arriving and stalled after 1.5 s of silence', () => {
    const h = new CameraHealth();
    h.onStart(1000);
    expect(h.state(1000)).toBe('ok'); // just started, nothing yet, within the grace period
    h.onFrame(1100);
    expect(h.state(1100 + STALL_MS)).toBe('ok');
    expect(h.state(1100 + STALL_MS + 1)).toBe('stalled');
    h.onFrame(3000);
    expect(h.state(3001)).toBe('ok');
  });

  it('stalls when the very first frame never arrives', () => {
    const h = new CameraHealth();
    h.onStart(0);
    expect(h.state(STALL_MS + 1)).toBe('stalled');
  });

  it('reports denied and error failures, and a restart clears them', () => {
    const h = new CameraHealth();
    h.onFailure('denied');
    expect(h.state(0)).toBe('denied');
    h.onFailure('error');
    expect(h.state(0)).toBe('error');
    h.onStart(10);
    h.onFrame(20);
    expect(h.state(30)).toBe('ok');
  });

  it('is not ok after stop', () => {
    const h = new CameraHealth();
    h.onStart(0);
    h.onFrame(10);
    h.onStop();
    expect(h.state(20)).toBe('error');
  });

  it('allows exactly one restart per start', () => {
    const h = new CameraHealth();
    expect(h.canRestart()).toBe(true);
    expect(h.canRestart()).toBe(false);
    h.resetRestarts();
    expect(h.canRestart()).toBe(true);
  });

  it('computes fps over the recent window and ignores a single frame', () => {
    const h = new CameraHealth();
    h.onStart(0);
    expect(h.fps()).toBe(0);
    h.onFrame(0);
    expect(h.fps()).toBe(0);
    for (let i = 1; i <= 10; i++) h.onFrame(i * 100); // 10 fps
    expect(h.fps()).toBeCloseTo(10, 6);
    for (let i = 11; i <= 60; i++) h.onFrame(1000 + (i - 10) * 50); // then 20 fps: the window forgets the old rate
    expect(h.fps()).toBeCloseTo(20, 6);
    expect(h.lastFrameAtMs()).toBe(3500);
  });
});
