// Letterbox a frame to 416x416 (gray 114 padding bottom/right) on a canvas and return it either as packed RGB bytes or as a JPEG.
// Shared by the main-thread rasteriser (src/inference/nativeDetector.ts) and the frame worker (src/stream/frameWorker.ts),
// so both produce identical model input. The canvas is injected so the logic is unit-testable without a browser.

import { INPUT_SIZE, PAD_VALUE, type Letterbox } from '../core/letterbox';
import { rgbaToRgb } from './packFrame';

export interface RasterContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(source: never, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
}

export interface RasterCanvas {
  getContext(kind: '2d', options?: { willReadFrequently?: boolean }): RasterContext | null;
  /** OffscreenCanvas has it; only needed for the JPEG output. */
  convertToBlob?(options: { type: string; quality: number }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

export class LetterboxRasterizer {
  private canvas: RasterCanvas | null = null;
  private ctx: RasterContext | null = null;

  constructor(private readonly createCanvas: () => RasterCanvas = () => new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE) as unknown as RasterCanvas) {}

  /** `source` is an ImageBitmap (or anything drawImage accepts). Returns packed RGB, 416*416*3 bytes. */
  rasterize(source: unknown, lb: Letterbox): Uint8Array {
    const ctx = this.paint(source, lb);
    return rgbaToRgb(ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data);
  }

  /**
   * The same letterboxed 416x416 frame as a JPEG (much smaller than the RGB bytes: this is what crosses the WebView-to-native
   * bridge in the compact path, D-030). JPEG is lossy, so detections can differ slightly from the RGB path.
   */
  async rasterizeJpeg(source: unknown, lb: Letterbox, quality: number): Promise<Uint8Array> {
    this.paint(source, lb);
    const canvas = this.canvas;
    if (!canvas?.convertToBlob) throw new Error('canvas cannot encode JPEG (convertToBlob missing)');
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  }

  private paint(source: unknown, lb: Letterbox): RasterContext {
    if (!this.ctx) {
      const canvas = this.createCanvas();
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2d canvas unavailable');
      this.canvas = canvas;
      this.ctx = ctx;
    }
    const ctx = this.ctx;
    ctx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    ctx.drawImage(source as never, 0, 0, lb.newW, lb.newH);
    return ctx;
  }
}
