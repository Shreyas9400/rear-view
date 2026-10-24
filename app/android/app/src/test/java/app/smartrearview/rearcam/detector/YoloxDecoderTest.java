package app.smartrearview.rearcam.detector;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

/**
 * Reproduces app/tests/fixtures/decode-golden.txt (written from the TypeScript reference, see app/tests/decodeGolden.test.ts).
 * Run: cd app/android && ./gradlew testDebugUnitTest
 */
public class YoloxDecoderTest {
    private static final double EPS = 1e-9;

    private static final class Anchor {
        int index, cls;
        float cx, cy, w, h, obj, p;
    }

    private static final class Expected {
        int classId;
        double score, x, y, w, h;
    }

    private static final class Scenario {
        String name;
        int srcW, srcH;
        List<Anchor> anchors = new ArrayList<>();
        List<Expected> expect = new ArrayList<>();
    }

    private static List<Scenario> loadGolden() throws IOException {
        // Gradle runs unit tests with the module directory (app/android/app) as the working directory.
        File f = new File("../../tests/fixtures/decode-golden.txt");
        if (!f.exists()) fail("golden fixture not found at " + f.getAbsolutePath());
        List<Scenario> all = new ArrayList<>();
        Scenario cur = null;
        try (BufferedReader r = Files.newBufferedReader(f.toPath(), StandardCharsets.UTF_8)) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String[] p = line.split("\\s+");
                switch (p[0]) {
                    case "scenario":
                        cur = new Scenario();
                        cur.name = p[1];
                        cur.srcW = Integer.parseInt(p[2]);
                        cur.srcH = Integer.parseInt(p[3]);
                        break;
                    case "anchor": {
                        Anchor a = new Anchor();
                        a.index = Integer.parseInt(p[1]);
                        // Float.parseFloat of a 9-significant-digit decimal returns exactly the float32 the TS side stored.
                        a.cx = Float.parseFloat(p[2]);
                        a.cy = Float.parseFloat(p[3]);
                        a.w = Float.parseFloat(p[4]);
                        a.h = Float.parseFloat(p[5]);
                        a.obj = Float.parseFloat(p[6]);
                        a.cls = Integer.parseInt(p[7]);
                        a.p = Float.parseFloat(p[8]);
                        cur.anchors.add(a);
                        break;
                    }
                    case "expect": {
                        Expected e = new Expected();
                        e.classId = Integer.parseInt(p[1]);
                        e.score = Double.parseDouble(p[2]);
                        e.x = Double.parseDouble(p[3]);
                        e.y = Double.parseDouble(p[4]);
                        e.w = Double.parseDouble(p[5]);
                        e.h = Double.parseDouble(p[6]);
                        cur.expect.add(e);
                        break;
                    }
                    case "end":
                        all.add(cur);
                        break;
                    default:
                        fail("unknown fixture line: " + line);
                }
            }
        }
        return all;
    }

    private static float[] rawFor(Scenario s) {
        float[] raw = new float[YoloxDecoder.NUM_ANCHORS * YoloxDecoder.ROW];
        for (Anchor a : s.anchors) {
            int o = a.index * YoloxDecoder.ROW;
            raw[o] = a.cx;
            raw[o + 1] = a.cy;
            raw[o + 2] = a.w;
            raw[o + 3] = a.h;
            raw[o + 4] = a.obj;
            raw[o + 5 + a.cls] = a.p;
        }
        return raw;
    }

    @Test
    public void reproducesEveryGoldenScenario() throws IOException {
        List<Scenario> all = loadGolden();
        assertTrue("fixture should contain the scenarios", all.size() >= 10);
        for (Scenario s : all) {
            List<YoloxDecoder.Detection> got = YoloxDecoder.decode(rawFor(s), s.srcW, s.srcH, new YoloxDecoder.Options());
            assertEquals(s.name + ": detection count", s.expect.size(), got.size());
            for (int i = 0; i < got.size(); i++) {
                YoloxDecoder.Detection d = got.get(i);
                Expected e = s.expect.get(i);
                String at = s.name + " #" + i;
                assertEquals(at + " class", e.classId, d.classId);
                assertEquals(at + " score", e.score, d.score, EPS);
                assertEquals(at + " x", e.x, d.x, EPS);
                assertEquals(at + " y", e.y, d.y, EPS);
                assertEquals(at + " w", e.w, d.w, EPS);
                assertEquals(at + " h", e.h, d.h, EPS);
            }
        }
    }

    @Test
    public void classFilterOverrideSelectsOnlyThoseClasses() throws IOException {
        Scenario s = null;
        for (Scenario c : loadGolden()) if (c.name.equals("four-vehicle-classes-and-others")) s = c;
        assertTrue(s != null);
        YoloxDecoder.Options o = new YoloxDecoder.Options();
        o.classIds = new HashSet<>(Collections.singletonList(0)); // person, diagnostics only
        List<YoloxDecoder.Detection> got = YoloxDecoder.decode(rawFor(s), s.srcW, s.srcH, o);
        assertEquals(1, got.size());
        assertEquals(0, got.get(0).classId);
    }

    @Test
    public void defaultClassesArePersonAndTheFourVehicleClasses() {
        Set<Integer> d = YoloxDecoder.Options.defaultClassIds();
        assertEquals(new HashSet<>(java.util.Arrays.asList(0, 2, 3, 5, 7)), d);
    }

    @Test
    public void emptyTensorGivesNoDetections() {
        float[] raw = new float[YoloxDecoder.NUM_ANCHORS * YoloxDecoder.ROW];
        assertTrue(YoloxDecoder.decode(raw, 416, 416, new YoloxDecoder.Options()).isEmpty());
    }

    @Test
    public void rejectsAWrongLengthTensorAndBadSourceSizes() {
        try {
            YoloxDecoder.decode(new float[10], 416, 416, new YoloxDecoder.Options());
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("expected"));
        }
        for (int[] bad : new int[][] {{0, 416}, {416, 0}, {-1, 5}}) {
            try {
                YoloxDecoder.letterboxRatio(bad[0], bad[1]);
                fail("expected IllegalArgumentException");
            } catch (IllegalArgumentException expected) {
                // ok
            }
        }
    }

    @Test
    public void letterboxRatioMatchesTheReference() {
        assertEquals(1.0, YoloxDecoder.letterboxRatio(416, 416), 0);
        assertEquals(0.325, YoloxDecoder.letterboxRatio(1280, 720), 1e-12);
        assertEquals(416.0 / 1280, YoloxDecoder.letterboxRatio(1280, 1000), 1e-12);
    }

    @Test
    public void anchorCountAndStridesMatchTheModel() {
        assertEquals(3549, YoloxDecoder.NUM_ANCHORS);
        assertEquals(85, YoloxDecoder.ROW);
        assertTrue(YoloxDecoder.Options.defaultClassIds().contains(0)); // person is kept since D-036
        assertFalse(YoloxDecoder.Options.defaultClassIds().contains(1)); // bicycle is not
    }
}
