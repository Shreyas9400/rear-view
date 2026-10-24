package app.smartrearview.rearcam.detector;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Host-side decode + per-class NMS for litert-community/yolox-nano-litert raw heads [1,3549,85].
 *
 * This is a line-for-line port of app/src/core/decode.ts, which is the reference. The two are kept in step by the shared
 * golden fixture app/tests/fixtures/decode-golden.txt (read by tests/decodeGolden.test.ts and by YoloxDecoderTest).
 * Arithmetic is done in double on purpose: JavaScript widens float32 reads to double, and Java float arithmetic would differ.
 * No Android classes here, so it runs in plain JVM unit tests.
 */
public final class YoloxDecoder {
    public static final int INPUT_SIZE = 416;
    public static final int NUM_CLASSES = 80;
    public static final int ROW = 5 + NUM_CLASSES;
    public static final int NUM_ANCHORS = 52 * 52 + 26 * 26 + 13 * 13; // 3549
    private static final int[] STRIDES = {8, 16, 32};

    /** COCO80 ids kept by default: person 0 (D-036), car 2, motorcycle 3, bus 5, truck 7. */
    public static final int[] VEHICLE_CLASS_IDS = {0, 2, 3, 5, 7};

    /** One detection, normalised 0..1 to the source frame (top-left origin). */
    public static final class Detection {
        public final int classId;
        public final double score;
        public final double x;
        public final double y;
        public final double w;
        public final double h;

        public Detection(int classId, double score, double x, double y, double w, double h) {
            this.classId = classId;
            this.score = score;
            this.x = x;
            this.y = y;
            this.w = w;
            this.h = h;
        }
    }

    public static final class Options {
        public double scoreThr = 0.35;
        public double nmsIou = 0.45;
        /** Cap on candidates entering NMS (highest score first); 0 or less means no cap. */
        public int maxCandidates = 200;
        /** Diagnostic override only. The product keeps the person and four vehicle classes. */
        public Set<Integer> classIds = defaultClassIds();

        public static Set<Integer> defaultClassIds() {
            Set<Integer> s = new HashSet<>();
            for (int id : VEHICLE_CLASS_IDS) s.add(id);
            return s;
        }
    }

    private YoloxDecoder() {}

    /** Same as letterbox416().ratio in TypeScript. */
    public static double letterboxRatio(int srcW, int srcH) {
        if (!(srcW > 0) || !(srcH > 0)) throw new IllegalArgumentException("source size must be positive");
        return Math.min(INPUT_SIZE / (double) srcW, INPUT_SIZE / (double) srcH);
    }

    public static List<Detection> decode(float[] raw, int srcW, int srcH, Options opts) {
        if (raw.length != NUM_ANCHORS * ROW) {
            throw new IllegalArgumentException("expected " + (NUM_ANCHORS * ROW) + " floats, got " + raw.length);
        }
        final double ratio = letterboxRatio(srcW, srcH);
        final boolean[] keep = new boolean[NUM_CLASSES];
        for (int id : opts.classIds) {
            if (id >= 0 && id < NUM_CLASSES) keep[id] = true;
        }

        List<Detection> cands = new ArrayList<>();
        int a = 0;
        for (int stride : STRIDES) {
            int n = INPUT_SIZE / stride;
            for (int gy = 0; gy < n; gy++) {
                for (int gx = 0; gx < n; gx++, a++) {
                    int o = a * ROW;
                    double obj = raw[o + 4];
                    // argmax over all 80 classes (as the reference decode), then keep the wanted classes only
                    int best = 0;
                    double bestScore = -1;
                    for (int c = 0; c < NUM_CLASSES; c++) {
                        double s = raw[o + 5 + c];
                        if (s > bestScore) {
                            bestScore = s;
                            best = c;
                        }
                    }
                    if (!keep[best]) continue;
                    double score = obj * bestScore;
                    if (score < opts.scoreThr) continue;
                    double cx = ((double) raw[o] + gx) * stride;
                    double cy = ((double) raw[o + 1] + gy) * stride;
                    double w = Math.exp((double) raw[o + 2]) * stride;
                    double h = Math.exp((double) raw[o + 3]) * stride;
                    // 416-space -> source pixels (undo letterbox) -> normalised
                    double x1 = clamp01((cx - w / 2) / ratio / srcW);
                    double y1 = clamp01((cy - h / 2) / ratio / srcH);
                    double x2 = clamp01((cx + w / 2) / ratio / srcW);
                    double y2 = clamp01((cy + h / 2) / ratio / srcH);
                    if (x2 <= x1 || y2 <= y1) continue;
                    cands.add(new Detection(best, score, x1, y1, x2 - x1, y2 - y1));
                }
            }
        }
        // List.sort is stable, matching Array.prototype.sort in the reference.
        cands.sort((p, q) -> Double.compare(q.score, p.score));
        List<Detection> capped = opts.maxCandidates > 0 && cands.size() > opts.maxCandidates ? cands.subList(0, opts.maxCandidates) : cands;
        return nms(capped, opts.nmsIou);
    }

    /** Per-class NMS, highest score first, deterministic (stable on ties). Input must already be sorted by score. */
    static List<Detection> nms(List<Detection> sorted, double iouThr) {
        List<Detection> kept = new ArrayList<>();
        for (Detection d : sorted) {
            boolean suppressed = false;
            for (Detection k : kept) {
                if (k.classId == d.classId && iou(k, d) > iouThr) {
                    suppressed = true;
                    break;
                }
            }
            if (!suppressed) kept.add(d);
        }
        return kept;
    }

    static double iou(Detection a, Detection b) {
        double x1 = Math.max(a.x, b.x);
        double y1 = Math.max(a.y, b.y);
        double x2 = Math.min(a.x + a.w, b.x + b.w);
        double y2 = Math.min(a.y + a.h, b.y + b.h);
        double inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        double union = a.w * a.h + b.w * b.h - inter;
        return union > 0 ? inter / union : 0;
    }

    private static double clamp01(double v) {
        return Math.min(1, Math.max(0, v));
    }
}
