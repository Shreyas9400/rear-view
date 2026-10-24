package app.smartrearview.rearcam.detector;

/**
 * Model input preparation. The WebView sends the letterboxed 416x416 frame as packed RGB bytes (gray 114 padding already
 * applied, see app/src/core/letterbox.ts); the model wants BGR float32 NHWC, values 0-255, no normalisation.
 */
public final class Preprocess {
    public static final int SIZE = YoloxDecoder.INPUT_SIZE;
    public static final int RGB_BYTES = SIZE * SIZE * 3;
    public static final int FLOATS = SIZE * SIZE * 3;

    private Preprocess() {}

    /** Same conversion from decoded Android pixels (packed ARGB ints, as Bitmap.getPixels returns them). Alpha is ignored. */
    public static void argbToBgrFloat(int[] argb, float[] out) {
        if (argb.length != SIZE * SIZE) throw new IllegalArgumentException("expected " + (SIZE * SIZE) + " pixels, got " + argb.length);
        if (out.length != FLOATS) throw new IllegalArgumentException("output buffer must hold " + FLOATS + " floats");
        for (int i = 0, k = 0; i < argb.length; i++, k += 3) {
            int p = argb[i];
            out[k] = p & 0xff;            // B
            out[k + 1] = (p >> 8) & 0xff;  // G
            out[k + 2] = (p >> 16) & 0xff; // R
        }
    }

    public static void rgbToBgrFloat(byte[] rgb, float[] out) {
        if (rgb.length != RGB_BYTES) throw new IllegalArgumentException("expected " + RGB_BYTES + " bytes, got " + rgb.length);
        if (out.length != FLOATS) throw new IllegalArgumentException("output buffer must hold " + FLOATS + " floats");
        for (int i = 0; i < RGB_BYTES; i += 3) {
            out[i] = rgb[i + 2] & 0xff;     // B
            out[i + 1] = rgb[i + 1] & 0xff; // G
            out[i + 2] = rgb[i] & 0xff;     // R
        }
    }
}
