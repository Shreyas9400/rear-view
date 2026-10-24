// Capacitor registration of the native detector plugin (Java: app.smartrearview.rearcam.detector.NativeDetectorPlugin).
// Kept separate from src/inference/*.ts so the detector logic has no Capacitor dependency and runs in Node tests.

import { registerPlugin } from '@capacitor/core';
import { NativeDetector } from '../inference/nativeDetector';
import type { NativeDetectorApi } from '../inference/nativeDetector';
import { StreamingDetector } from '../inference/streamingDetector';
import type { NativeStreamApi } from '../inference/streamingDetector';

export interface NativeDetectorStatus {
  ready: boolean;
  threads: number;
  busy: boolean;
  streaming: boolean;
  inferences: number;
  busyRejects: number;
  streamProcessed: number;
  lastNativeTotalMs: number;
}

export interface NativeDetectorPluginApi extends NativeDetectorApi, NativeStreamApi {
  status(): Promise<NativeDetectorStatus>;
}

export const NativeDetectorPlugin = registerPlugin<NativeDetectorPluginApi>('NativeDetector');

/** Request/response detector (one call per frame, waits for the result). Kept for comparison; see D-025. */
export function createNativeDetector(): NativeDetector {
  return new NativeDetector(NativeDetectorPlugin);
}

/** Pipelined detector (post newest frame, results arrive as events). The intended production path, D-026. */
export function createStreamingDetector(): StreamingDetector {
  return new StreamingDetector(NativeDetectorPlugin);
}
