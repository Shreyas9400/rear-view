// Frame packing for the WebView -> native bridge: letterboxed RGBA -> packed RGB bytes -> base64.
// Capacitor passes JSON strings, so the frame travels as base64 (about 692 KB for a 416x416 RGB frame).

import { INPUT_SIZE } from '../core/letterbox';

export const RGB_BYTES = INPUT_SIZE * INPUT_SIZE * 3;

/** Drop the alpha channel: RGBA (4 bytes per pixel) -> RGB (3 bytes per pixel). */
export function rgbaToRgb(rgba: Uint8Array | Uint8ClampedArray, out?: Uint8Array): Uint8Array {
  const n = INPUT_SIZE * INPUT_SIZE;
  if (rgba.length !== n * 4) throw new Error(`rgbaToRgb: expected ${n * 4} bytes, got ${rgba.length}`);
  const rgb = out ?? new Uint8Array(RGB_BYTES);
  if (rgb.length !== RGB_BYTES) throw new Error('rgbaToRgb: output buffer has the wrong length');
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    rgb[k] = rgba[j]!;
    rgb[k + 1] = rgba[j + 1]!;
    rgb[k + 2] = rgba[j + 2]!;
  }
  return rgb;
}

/** Standard base64 (with padding, no line breaks), built in chunks to avoid huge argument lists. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}
