// Pre-processing for litert-community/yolox-nano-litert:
// input [1,416,416,3] NHWC, BGR, 0-255, no normalisation, aspect-preserving resize,
// gray 114 padding on the bottom/right (HF model card).

export const INPUT_SIZE = 416;
export const PAD_VALUE = 114;

export interface Letterbox {
  size: number;
  ratio: number;
  srcW: number;
  srcH: number;
  /** Size of the resized content inside the 416x416 canvas. */
  newW: number;
  newH: number;
  padRight: number;
  padBottom: number;
}

export function letterbox416(srcW: number, srcH: number): Letterbox {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error('letterbox416: source size must be positive');
  const ratio = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const newW = Math.min(INPUT_SIZE, Math.round(srcW * ratio));
  const newH = Math.min(INPUT_SIZE, Math.round(srcH * ratio));
  return { size: INPUT_SIZE, ratio, srcW, srcH, newW, newH, padRight: INPUT_SIZE - newW, padBottom: INPUT_SIZE - newH };
}

/**
 * Convert an already-letterboxed 416x416 RGBA image (e.g. canvas getImageData, padded with 114)
 * to a BGR float32 NHWC tensor with values 0-255.
 */
export function rgbaToBgrFloat(rgba: Uint8Array | Uint8ClampedArray, out?: Float32Array): Float32Array {
  const n = INPUT_SIZE * INPUT_SIZE;
  if (rgba.length !== n * 4) throw new Error(`rgbaToBgrFloat: expected ${n * 4} bytes, got ${rgba.length}`);
  const t = out ?? new Float32Array(n * 3);
  if (t.length !== n * 3) throw new Error('rgbaToBgrFloat: output buffer has the wrong length');
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const p = i * 4;
    t[j] = rgba[p + 2]!;     // B
    t[j + 1] = rgba[p + 1]!; // G
    t[j + 2] = rgba[p]!;     // R
  }
  return t;
}
