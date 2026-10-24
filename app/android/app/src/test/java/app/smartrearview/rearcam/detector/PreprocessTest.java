package app.smartrearview.rearcam.detector;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public class PreprocessTest {
    @Test
    public void swapsRgbToBgrAndKeepsTheFullByteRange() {
        byte[] rgb = new byte[Preprocess.RGB_BYTES];
        rgb[0] = 10;            // R of pixel 0
        rgb[1] = 20;            // G
        rgb[2] = (byte) 250;    // B (must not become negative)
        int last = Preprocess.RGB_BYTES - 3;
        rgb[last] = (byte) 255;
        rgb[last + 1] = 0;
        rgb[last + 2] = 1;
        float[] out = new float[Preprocess.FLOATS];
        Preprocess.rgbToBgrFloat(rgb, out);
        assertEquals(250f, out[0], 0);
        assertEquals(20f, out[1], 0);
        assertEquals(10f, out[2], 0);
        assertEquals(1f, out[last], 0);
        assertEquals(0f, out[last + 1], 0);
        assertEquals(255f, out[last + 2], 0);
    }

    @Test
    public void argbConversionMatchesTheRgbConversionAndIgnoresAlpha() {
        int n = Preprocess.SIZE * Preprocess.SIZE;
        byte[] rgb = new byte[Preprocess.RGB_BYTES];
        int[] argb = new int[n];
        for (int i = 0; i < n; i++) {
            int r = (i * 7) & 0xff, g = (i * 13 + 5) & 0xff, b = (i * 31 + 11) & 0xff;
            rgb[3 * i] = (byte) r;
            rgb[3 * i + 1] = (byte) g;
            rgb[3 * i + 2] = (byte) b;
            argb[i] = ((i % 2 == 0 ? 0xff : 0x80) << 24) | (r << 16) | (g << 8) | b; // alpha varies on purpose
        }
        float[] fromRgb = new float[Preprocess.FLOATS];
        float[] fromArgb = new float[Preprocess.FLOATS];
        Preprocess.rgbToBgrFloat(rgb, fromRgb);
        Preprocess.argbToBgrFloat(argb, fromArgb);
        org.junit.Assert.assertArrayEquals(fromRgb, fromArgb, 0f);
    }

    @Test
    public void argbConversionRejectsWrongSizes() {
        try {
            Preprocess.argbToBgrFloat(new int[10], new float[Preprocess.FLOATS]);
            fail();
        } catch (IllegalArgumentException expected) {
            // ok
        }
        try {
            Preprocess.argbToBgrFloat(new int[Preprocess.SIZE * Preprocess.SIZE], new float[10]);
            fail();
        } catch (IllegalArgumentException expected) {
            // ok
        }
    }

    @Test
    public void rejectsWrongSizes() {
        try {
            Preprocess.rgbToBgrFloat(new byte[10], new float[Preprocess.FLOATS]);
            fail();
        } catch (IllegalArgumentException expected) {
            // ok
        }
        try {
            Preprocess.rgbToBgrFloat(new byte[Preprocess.RGB_BYTES], new float[10]);
            fail();
        } catch (IllegalArgumentException expected) {
            // ok
        }
    }
}
