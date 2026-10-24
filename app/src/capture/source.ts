// Capture interfaces (docs/ARCHITECTURE.md "Module interfaces"). Implemented by CameraSource (M5/M7) and FileVideoSource.

export interface CapturedFrame {
  seq: number; // uint32, +1 per captured frame
  tCaptureMs: number; // performance.now()
  tCaptureEpochMs: number;
  width: number;
  height: number;
  bitmap: ImageBitmap; // consumer closes
}

export interface CameraSource {
  start(o: { width: number; height: number; fps: number }): Promise<void>;
  stop(): void;
  onFrame(cb: (f: CapturedFrame) => void): void;
  stats(): { fps: number; dropped: number; lastFrameAtMs: number };
}
