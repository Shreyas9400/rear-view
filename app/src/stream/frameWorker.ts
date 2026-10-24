// Worker half of FrameProcessor. Browser-only; the request/response protocol is unit-tested through FrameProcessor with a fake
// worker and the rasterising logic through LetterboxRasterizer with a fake canvas. This file is exercised on the device.

import { letterbox416 } from '../core/letterbox';
import { bytesToBase64 } from '../inference/packFrame';
import { LetterboxRasterizer } from '../inference/rasterize';
import type { FrameRequest, FrameResponse } from './frameProcessor';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<FrameRequest>) => void) | null;
  postMessage(msg: FrameResponse, transfer: Transferable[]): void;
};

const rasterizer = new LetterboxRasterizer();
let jpegCanvas: OffscreenCanvas | null = null;
let jpegCtx: OffscreenCanvasRenderingContext2D | null = null;

scope.onmessage = async (e: MessageEvent<FrameRequest>) => {
  const { id, bitmap, srcW, srcH, pack, packFormat, packQuality, jpeg } = e.data;
  let stage: 'pack' | 'jpeg' = 'pack';
  try {
    if (pack) {
      const t0 = performance.now();
      const lb = letterbox416(srcW, srcH);
      const format = packFormat === 'jpeg' ? 'jpeg' : 'rgb';
      const bytes = format === 'jpeg' ? await rasterizer.rasterizeJpeg(bitmap, lb, packQuality ?? 0.9) : rasterizer.rasterize(bitmap, lb);
      const rgb64 = bytesToBase64(bytes);
      scope.postMessage({ id, kind: 'pack', rgb64, packMs: performance.now() - t0, format }, []); // feed the detector first
    }
    if (jpeg) {
      stage = 'jpeg';
      const t0 = performance.now();
      if (!jpegCanvas || jpegCanvas.width !== jpeg.width || jpegCanvas.height !== jpeg.height) {
        jpegCanvas = new OffscreenCanvas(jpeg.width, jpeg.height);
        jpegCtx = jpegCanvas.getContext('2d');
      }
      if (!jpegCtx) throw new Error('2d context unavailable in worker');
      jpegCtx.drawImage(bitmap, 0, 0, jpeg.width, jpeg.height);
      const blob = await jpegCanvas.convertToBlob({ type: 'image/jpeg', quality: jpeg.quality });
      const bytes = await blob.arrayBuffer();
      scope.postMessage({ id, kind: 'jpeg', bytes, encodeMs: performance.now() - t0 }, [bytes]);
    }
  } catch (err) {
    scope.postMessage({ id, kind: 'error', stage, message: String((err as Error)?.message ?? err).slice(0, 200) }, []);
  } finally {
    bitmap.close();
  }
};
