// On-device self-test for the native detector (built only with VITE_SELFTEST=1, never in production).
// It exercises the real WebView -> plugin -> LiteRT -> decode path on the model-card sample and prints results to the
// console (read with `adb logcat`, tag Capacitor/Console, lines starting SELFTEST_). No image data leaves the app.
// The sample (src/selftest/sample.png) shows pedestrians, no vehicles, so a diagnostic class override (person) is used to
// check the full coordinate mapping; vehicle decoding itself is covered by the golden fixture tests.

import type { CapturedFrame } from '../capture/source';
import { letterbox416 } from '../core/letterbox';
import { bytesToBase64 } from '../inference/packFrame';
import { LetterboxRasterizer } from '../inference/rasterize';
import { canvasRasterize } from '../inference/nativeDetector';
import { createNativeDetector, NativeDetectorPlugin } from '../plugins/nativeDetector';
import sampleUrl from './sample.png?url';

const log = (tag: string, o: unknown) => console.log(`SELFTEST_${tag} ${JSON.stringify(o)}`);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const r1 = (v: number) => Math.round(v * 10) / 10;
const errInfo = (e: unknown) => ({ code: (e as { code?: string })?.code, message: String((e as { message?: string })?.message ?? e).slice(0, 200) });

export async function run(): Promise<void> {
  try {
    log('START', { ua: navigator.userAgent.slice(0, 160), secure: isSecureContext });
    const img = new Image();
    img.src = sampleUrl;
    await img.decode();
    const bitmap = await createImageBitmap(img);
    const frame: CapturedFrame = { seq: 1, tCaptureMs: 0, tCaptureEpochMs: Date.now(), width: bitmap.width, height: bitmap.height, bitmap };
    const lb = letterbox416(frame.width, frame.height);

    // Phase A: coordinate mapping, with a diagnostic person-class override.
    const init = await NativeDetectorPlugin.init({ threads: 2, classIds: [0] });
    log('INIT', init);
    const rgb64 = bytesToBase64(canvasRasterize(frame, lb));
    const a = await NativeDetectorPlugin.detect({ rgb: rgb64, srcW: frame.width, srcH: frame.height });
    log('PERSONS', {
      count: a.detections.length,
      top: a.detections.slice(0, 6).map((d) => ({ s: r1(d.score * 100) / 100, cx: r1(((d.x + d.w / 2) * 1000)) / 1000, cy: r1(((d.y + d.h / 2) * 1000)) / 1000, w: r1(d.w * 1000) / 1000, h: r1(d.h * 1000) / 1000 })),
    });

    // Phase A2: JPEG payload vs raw RGB payload (D-030): size, native decode cost, and how far the detections move.
    const rast = new LetterboxRasterizer();
    const fmtRows: unknown[] = [];
    for (const q of [0.95, 0.9, 0.8, 0.7]) {
      const jb64 = bytesToBase64(await rast.rasterizeJpeg(frame.bitmap, lb, q));
      const rj = await NativeDetectorPlugin.detect({ rgb: jb64, srcW: frame.width, srcH: frame.height, format: 'jpeg' });
      let maxDScore = 0;
      let maxDPos = 0;
      let unmatched = 0;
      for (const d of a.detections.slice(0, 6)) {
        const cx = d.x + d.w / 2;
        const cy = d.y + d.h / 2;
        let best: (typeof rj.detections)[number] | null = null;
        let bestDist = Infinity;
        for (const e of rj.detections) {
          const dist = Math.hypot(e.x + e.w / 2 - cx, e.y + e.h / 2 - cy);
          if (dist < bestDist) { bestDist = dist; best = e; }
        }
        if (!best || bestDist > 0.02) unmatched++;
        else { maxDScore = Math.max(maxDScore, Math.abs(best.score - d.score)); maxDPos = Math.max(maxDPos, bestDist); }
      }
      const extra = rj as unknown as { decodeInputMs?: number };
      fmtRows.push({ q, payloadKB: Math.round(jb64.length / 1024), detections: rj.detections.length, rawDetections: a.detections.length, maxScoreDiff: Math.round(maxDScore * 1000) / 1000, maxCentreDiff: Math.round(maxDPos * 1000) / 1000, unmatched, nativeDecodeInputMs: r1(extra.decodeInputMs ?? NaN), nativeTotalMs: r1(rj.nativeTotalMs) });
    }
    log('FORMAT', { rawPayloadKB: Math.round(rgb64.length / 1024), rows: fmtRows });

    // Phase B: timings over 60 sequential calls (5 warm-up), bridge cost = round trip - native total.
    const rt: number[] = [];
    const nat: number[] = [];
    const infer: number[] = [];
    const bridge: number[] = [];
    for (let i = 0; i < 65; i++) {
      const t0 = performance.now();
      const r = await NativeDetectorPlugin.detect({ rgb: rgb64, srcW: frame.width, srcH: frame.height });
      const dt = performance.now() - t0;
      if (i >= 5) {
        rt.push(dt);
        nat.push(r.nativeTotalMs);
        infer.push(r.inferMs);
        bridge.push(dt - r.nativeTotalMs);
      }
    }
    log('BRIDGE', {
      calls: rt.length,
      roundTripMs: { median: r1(pct(rt, 50)), p95: r1(pct(rt, 95)), max: r1(pct(rt, 100)) },
      nativeTotalMs: { median: r1(pct(nat, 50)), p95: r1(pct(nat, 95)) },
      inferMs: { median: r1(pct(infer, 50)) },
      bridgeOverheadMs: { median: r1(pct(bridge, 50)), p95: r1(pct(bridge, 95)) },
      throughputPerSec: r1(1000 / pct(rt, 50)),
    });

    // Phase C: JS-side packing cost (letterbox on a canvas + RGBA->RGB + base64), 30 runs.
    const pack: number[] = [];
    for (let i = 0; i < 35; i++) {
      const t0 = performance.now();
      bytesToBase64(canvasRasterize(frame, lb));
      if (i >= 5) pack.push(performance.now() - t0);
    }
    log('PACK', { medianMs: r1(pct(pack, 50)), p95Ms: r1(pct(pack, 95)) });

    // Phase D: one in flight at a time. Two simultaneous calls: exactly one must be rejected with BUSY.
    const settled = await Promise.allSettled([
      NativeDetectorPlugin.detect({ rgb: rgb64, srcW: frame.width, srcH: frame.height }),
      NativeDetectorPlugin.detect({ rgb: rgb64, srcW: frame.width, srcH: frame.height }),
    ]);
    log('BUSY', settled.map((s) => (s.status === 'fulfilled' ? 'ok' : errInfo(s.reason))));
    log('STATUS', await NativeDetectorPlugin.status());

    // Phase E: the real Detector wrapper with the product defaults (vehicles only): the sample has no vehicles.
    const det = createNativeDetector();
    await det.init({ accelerator: 'native-cpu', scoreThr: 0.35, nmsIou: 0.45 });
    const full = await det.detect(frame);
    log('WRAPPER', { health: det.health(), result: full && { seq: full.seq, detections: full.detections.length, preMs: r1(full.preMs), inferMs: r1(full.inferMs), postMs: r1(full.postMs), bridgeMs: r1(full.bridgeMs) } });

    // Phase F: bad input is rejected, not crashed.
    const bad = await Promise.allSettled([
      NativeDetectorPlugin.detect({ rgb: 'AAAA', srcW: 10, srcH: 10 }),
      NativeDetectorPlugin.detect({ rgb: rgb64, srcW: 0, srcH: 10 }),
    ]);
    log('BADINPUT', bad.map((s) => (s.status === 'fulfilled' ? 'ok?!' : errInfo(s.reason))));
    await det.dispose();
    log('DONE', { ok: true });
  } catch (e) {
    log('FATAL', errInfo(e));
  }
}
