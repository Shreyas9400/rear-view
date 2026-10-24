// Real wiring of the product pipeline on the phone (browser/WebView only; the logic lives in pipeline.ts and is tested with fakes).

import { WebViewCameraSource } from '../capture/webViewCameraSource';
import type { CapturedFrame } from '../capture/source';
import { AlertStateMachine } from '../core/alert';
import { ApproachEstimator } from '../core/approach';
import { IouTracker } from '../core/tracker';
import { ThermalEstimator } from '../health/thermalEstimator';
import { createStreamingDetector } from '../plugins/nativeDetector';
import { StreamPublisher, type LocalServerApi } from '../server/streamPublisher';
import { FrameFeeder } from '../stream/frameFeeder';
import { FrameProcessor } from '../stream/frameProcessor';
import { LoadController } from './loadController';
import { RearViewPipeline } from './pipeline';

export interface PipelineOptions {
  previewHook?: (f: CapturedFrame) => void;
  /** If given, every accepted frame is also JPEG-encoded for the viewer and published, but only while `viewersWatching()` is true. */
  server?: { api: LocalServerApi; viewersWatching: () => boolean };
}

export interface CreatedPipeline {
  pipeline: RearViewPipeline;
  publisher: StreamPublisher | null;
}

export function createPipeline(o: PipelineOptions = {}): CreatedPipeline {
  const camera = new WebViewCameraSource();
  const detector = createStreamingDetector();
  // JPEG q0.90 is the measured default payload (D-030); the worker packs it so the main thread only calls plugin.submit.
  const feeder = new FrameFeeder(new FrameProcessor(), detector, {
    packFormat: 'jpeg',
    packQuality: 0.9,
    stream: o.server ? { width: 640, quality: 0.6, wanted: o.server.viewersWatching } : undefined,
  });
  const pipeline = new RearViewPipeline({
    camera,
    feeder,
    detector,
    tracker: new IouTracker(),
    approach: new ApproachEstimator(),
    alert: new AlertStateMachine(),
    thermal: new ThermalEstimator(),
    load: new LoadController(),
    now: () => performance.now(),
    previewHook: o.previewHook,
  });
  let publisher: StreamPublisher | null = null;
  if (o.server) {
    const p = new StreamPublisher(o.server.api, () => pipeline.snapshot());
    feeder.onStreamFrame((j) => p.publish(j));
    publisher = p;
  }
  return { pipeline, publisher };
}
