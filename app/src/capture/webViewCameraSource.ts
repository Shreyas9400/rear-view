// Rear camera through getUserMedia in the Capacitor WebView (docs/ARCHITECTURE.md CameraSource, milestone M5/M7).
// Emits at most `fps` frames per second as ImageBitmaps (the consumer closes them) and never queues: a camera frame
// that arrives while the previous bitmap is still being created is counted as dropped.
// Status: IMPLEMENTED, exercised on the OnePlus 6T by the camera probe (src/selftest/cameraProbe.ts); browser-only,
// so the Node unit tests cover CameraHealth, not this class.

import type { CameraSource, CapturedFrame } from './source';
import { CameraHealth, classifyCameraError, type CameraState } from './cameraHealth';

export interface CameraSettings {
  width?: number;
  height?: number;
  frameRate?: number;
  facingMode?: string;
}

export class WebViewCameraSource implements CameraSource {
  private readonly health = new CameraHealth();
  private cb: ((f: CapturedFrame) => void) | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private opts = { width: 1280, height: 720, fps: 15 };
  private seq = 0;
  private dropped = 0;
  private cameraFrames = 0;
  private lastEmitMediaS = -Infinity;
  private busy = false;
  private active = false;
  private frameHandle = 0;
  private lastError: string | null = null;

  onFrame(cb: (f: CapturedFrame) => void): void {
    this.cb = cb;
  }

  async start(o: { width: number; height: number; fps: number }): Promise<void> {
    this.opts = { ...o };
    this.health.resetRestarts();
    await this.open();
  }

  stop(): void {
    this.active = false;
    this.health.onStop();
    this.closeStream();
  }

  /** Camera state for HealthFlags.camera. Evaluates the stall rule at call time. */
  cameraState(): CameraState {
    return this.health.state(performance.now());
  }

  stats(): { fps: number; dropped: number; lastFrameAtMs: number } {
    return { fps: this.health.fps(), dropped: this.dropped, lastFrameAtMs: this.health.lastFrameAtMs() };
  }

  /** Change the emit rate cap without reopening the camera (the camera itself keeps delivering at its own rate). */
  setMaxFps(fps: number): void {
    if (!(fps > 0)) throw new Error('fps must be positive');
    this.opts = { ...this.opts, fps };
  }

  /** Raw frames delivered by the camera, before the fps cap (probe diagnostics). */
  rawCameraFrames(): number {
    return this.cameraFrames;
  }

  lastErrorMessage(): string | null {
    return this.lastError;
  }

  /** What the browser actually gave us (the constraints are only requests). */
  settings(): CameraSettings | null {
    const t = this.stream?.getVideoTracks()[0];
    if (!t) return null;
    const s = t.getSettings();
    return { width: s.width, height: s.height, frameRate: s.frameRate, facingMode: s.facingMode };
  }

  private async open(): Promise<void> {
    this.lastError = null;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.health.onFailure('error');
      this.lastError = 'mediaDevices.getUserMedia is unavailable';
      throw new Error(this.lastError);
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: this.opts.width },
          height: { ideal: this.opts.height },
          frameRate: { ideal: this.opts.fps },
        },
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      this.health.onFailure(classifyCameraError(name));
      this.lastError = `${name ?? 'Error'}: ${(e as { message?: string }).message ?? ''}`.slice(0, 200);
      throw e;
    }
    this.stream = stream;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.onTrackEnded());
    await video.play();

    this.active = true;
    this.seq = 0;
    this.lastEmitMediaS = -Infinity;
    this.health.onStart(performance.now());
    this.scheduleNext();
  }

  private onTrackEnded(): void {
    if (!this.active) return;
    this.closeStream();
    if (this.health.canRestart()) {
      this.open().catch(() => undefined); // failure is recorded in health by open()
    } else {
      this.active = false;
      this.health.onFailure('error');
      this.lastError = 'camera track ended and the restart budget is used up';
    }
  }

  private scheduleNext(): void {
    const v = this.video;
    if (!v || !this.active) return;
    if (typeof v.requestVideoFrameCallback === 'function') {
      this.frameHandle = v.requestVideoFrameCallback((_now, meta) => this.onCameraFrame(meta.mediaTime));
    } else {
      this.frameHandle = requestAnimationFrame(() => this.onCameraFrame(v.currentTime));
    }
  }

  private onCameraFrame(mediaTimeS: number): void {
    if (!this.active || !this.video) return;
    this.cameraFrames++;
    const minGapS = 1 / this.opts.fps;
    if (mediaTimeS - this.lastEmitMediaS >= minGapS - 0.004 && !this.busy) {
      this.lastEmitMediaS = mediaTimeS;
      this.busy = true;
      const tCapture = performance.now();
      const video = this.video;
      createImageBitmap(video)
        .then((bitmap) => {
          this.health.onFrame(performance.now());
          const frame: CapturedFrame = {
            seq: this.seq++ >>> 0,
            tCaptureMs: tCapture,
            tCaptureEpochMs: performance.timeOrigin + tCapture,
            width: bitmap.width,
            height: bitmap.height,
            bitmap,
          };
          if (this.cb) this.cb(frame);
          else bitmap.close();
        })
        .catch(() => {
          this.dropped++;
        })
        .finally(() => {
          this.busy = false;
        });
    } else {
      this.dropped++;
    }
    this.scheduleNext();
  }

  private closeStream(): void {
    const v = this.video as (HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }) | null;
    if (v?.cancelVideoFrameCallback && this.frameHandle) v.cancelVideoFrameCallback(this.frameHandle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }
}
