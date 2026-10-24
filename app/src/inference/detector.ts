// Detector contract (docs/ARCHITECTURE.md "Module interfaces"). Implementations: NativeDetector (LiteRT CPU in the Kotlin/Java
// plugin, D-022). A LiteRT.js implementation was measured too slow in the WebView and is not planned.

import type { CapturedFrame } from '../capture/source';
import type { Detection, HealthFlags } from '../shared/types';

export type DetectorAccelerator = 'native-cpu' | 'wasm' | 'webgpu';

export interface DetectorInitConfig {
  accelerator: DetectorAccelerator;
  /** CPU threads for 'native-cpu'; default 2 (D-022). */
  threads?: number;
  scoreThr: number;
  nmsIou: number;
  modelUrl?: string;
}

export interface DetectorResult {
  /** Sequence number of the frame these detections were computed on. */
  seq: number;
  detections: Detection[];
  /** Rasterise (letterbox) + pack + encode in the WebView. */
  preMs: number;
  /** Model run on the native side. */
  inferMs: number;
  /** Native decode + NMS. */
  postMs: number;
  /** Round trip minus native time: the WebView-to-native bridge cost (both directions). */
  bridgeMs: number;
  /** Streaming only: time the frame waited in the native slot before inference started. */
  queueMs?: number;
  /** Streaming only: native total for this frame (decode input + model + decode). */
  nativeTotalMs?: number;
  /** Streaming only: how long the plugin.submit() call took to be acknowledged (the frame hand-over across the bridge). */
  postAckMs?: number;
}

export type DetectorHealth = HealthFlags['detector'];

export class DetectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DetectorError';
  }
}

export interface Detector {
  init(c: DetectorInitConfig): Promise<void>;
  /**
   * One inference at a time. Resolves `null` when the frame was dropped because an inference is already in flight
   * (latest-frame-wins: callers must not queue it). Throws DetectorError on failure.
   */
  detect(f: CapturedFrame): Promise<DetectorResult | null>;
  /** True while an inference is in flight, so the caller can skip creating work for a frame that would be dropped. */
  isBusy(): boolean;
  /** Never 'ok' before a successful init. */
  health(): DetectorHealth;
  dispose(): Promise<void>;
}
