// Recorded-clip source for diagnostics and replay. Same interface as the camera; no queue of its own:
// a frame is produced only when the browser delivers one and the target fps allows it, and the consumer owns the bitmap.
// Status: IMPLEMENTED_UNTESTED (needs a browser; not covered by the Node unit tests).

import type { CameraSource, CapturedFrame } from './source';

export class FileVideoSource implements CameraSource {
  private video: HTMLVideoElement | null = null;
  private cb: ((f: CapturedFrame) => void) | null = null;
  private seq = 0;
  private dropped = 0;
  private lastFrameAtMs = 0;
  private lastEmitMediaS = -Infinity;
  private recent: number[] = [];
  private running = false;
  private busy = false;

  /** `url` is a file/blob/object URL. Nothing is uploaded or recorded. */
  constructor(private readonly url: string) {}

  onFrame(cb: (f: CapturedFrame) => void): void {
    this.cb = cb;
  }

  async start(o: { width: number; height: number; fps: number }): Promise<void> {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
      throw new Error('FileVideoSource needs requestVideoFrameCallback');
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    this.video = video;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('cannot load or decode the video file (unsupported codec?)'));
      video.src = this.url;
    });
    await video.play();

    this.running = true;
    this.seq = 0;
    this.dropped = 0;
    this.lastEmitMediaS = -Infinity;
    const minGapS = 1 / o.fps;

    const onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (!this.running) return;
      if (meta.mediaTime - this.lastEmitMediaS >= minGapS - 1e-6 && !this.busy) {
        this.lastEmitMediaS = meta.mediaTime;
        this.busy = true;
        createImageBitmap(video, { resizeWidth: o.width, resizeHeight: o.height })
          .then((bitmap) => this.emit(bitmap, o.width, o.height))
          .catch(() => this.dropped++)
          .finally(() => (this.busy = false));
      } else {
        this.dropped++;
      }
      video.requestVideoFrameCallback(onVideoFrame);
    };
    video.requestVideoFrameCallback(onVideoFrame);
  }

  stop(): void {
    this.running = false;
    this.video?.pause();
    this.video?.removeAttribute('src');
    this.video?.load();
    this.video = null;
  }

  stats(): { fps: number; dropped: number; lastFrameAtMs: number } {
    const w = this.recent;
    const fps = w.length > 1 ? ((w.length - 1) * 1000) / (w[w.length - 1]! - w[0]!) : 0;
    return { fps, dropped: this.dropped, lastFrameAtMs: this.lastFrameAtMs };
  }

  private emit(bitmap: ImageBitmap, width: number, height: number): void {
    const t = performance.now();
    this.lastFrameAtMs = t;
    this.recent.push(t);
    if (this.recent.length > 30) this.recent.shift();
    if (!this.cb) {
      bitmap.close();
      return;
    }
    this.cb({
      seq: this.seq++ >>> 0,
      tCaptureMs: t,
      tCaptureEpochMs: performance.timeOrigin + t,
      width,
      height,
      bitmap,
    });
  }
}
