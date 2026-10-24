package app.smartrearview.rearcam.detector;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * Capacitor plugin "NativeDetector": runs YOLOX-nano through LiteRT on the CPU and returns decoded detections.
 * Contract: docs/ARCHITECTURE.md (Detector), TypeScript sides app/src/inference/{nativeDetector,streamingDetector}.ts.
 *
 * Two ways to use it (never both at once):
 *  - detect(): request/response, one frame, rejected with BUSY while one is running. Simple, but the caller waits for each
 *    result, which leaves the native thread idle between calls and the phone then runs it about 2.5x slower (D-025).
 *  - startStream() / submit() / "detection" events: the caller posts the newest frame and returns immediately; a worker thread
 *    always processes the newest posted frame (older unprocessed ones are replaced, never queued) and emits one event per
 *    result. This keeps the native thread fed. One inference in flight either way.
 *
 * Nothing is logged that contains pixels, and nothing leaves the device.
 */
@CapacitorPlugin(name = "NativeDetector")
public class NativeDetectorPlugin extends Plugin {
    static final String DEFAULT_MODEL_ASSET = "models/yolox_nano.tflite";
    static final String FORMAT_RGB = "rgb";
    static final String FORMAT_JPEG = "jpeg";
    private static final int MAX_BASE64_CHARS = Preprocess.RGB_BYTES / 3 * 4 + 16;

    /** A frame posted to the stream; the base64 is decoded on the worker thread, not on the plugin call thread. */
    private static final class StreamFrame {
        final String rgb64;
        final String format;
        final int srcW;
        final int srcH;
        final double seq;
        final long submittedNs;

        StreamFrame(String rgb64, String format, int srcW, int srcH, double seq) {
            this.rgb64 = rgb64;
            this.format = format;
            this.srcW = srcW;
            this.srcH = srcH;
            this.seq = seq;
            this.submittedNs = System.nanoTime();
        }
    }

    private final ExecutorService exec = Executors.newSingleThreadExecutor(r -> new Thread(r, "native-detector"));
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private volatile LiteRtDetector detector;
    private volatile YoloxDecoder.Options options = new YoloxDecoder.Options();
    private volatile long inferences;
    private volatile long busyRejects;
    private volatile double lastTotalMs;

    private final Object streamLock = new Object();
    private LatestFrameSlot<StreamFrame> slot; // guarded by streamLock
    private Thread streamThread; // guarded by streamLock
    private volatile boolean streaming;
    private volatile long streamProcessed;

    @PluginMethod
    public void init(PluginCall call) {
        final int threads = call.getInt("threads", 2);
        final String asset = call.getString("modelAsset", DEFAULT_MODEL_ASSET);
        if (threads < 1 || threads > 8) {
            call.reject("threads must be 1..8", "BAD_ARGS");
            return;
        }
        final YoloxDecoder.Options o = new YoloxDecoder.Options();
        Double thr = call.getDouble("scoreThr");
        Double iou = call.getDouble("nmsIou");
        if (thr != null) o.scoreThr = thr;
        if (iou != null) o.nmsIou = iou;
        try {
            JSONArray ids = call.getArray("classIds");
            if (ids != null) {
                Set<Integer> s = new HashSet<>();
                for (int i = 0; i < ids.length(); i++) s.add(ids.getInt(i));
                o.classIds = s;
            }
        } catch (JSONException e) {
            call.reject("classIds must be an array of integers", "BAD_ARGS");
            return;
        }
        exec.execute(() -> {
            try {
                stopStreamBlocking(); // never swap the model under a running stream
                LiteRtDetector old = detector;
                detector = null;
                if (old != null) old.close();
                LiteRtDetector d = LiteRtDetector.create(getContext().getAssets(), asset, threads);
                double warmMs;
                try {
                    warmMs = d.warmUp(3);
                } catch (Throwable t) {
                    d.close();
                    throw t;
                }
                detector = d;
                options = o;
                inferences = 0;
                busyRejects = 0;
                streamProcessed = 0;
                JSObject r = new JSObject();
                r.put("ready", true);
                r.put("accelerator", "native-cpu");
                r.put("threads", threads);
                r.put("compileMs", d.compileMs);
                r.put("warmupMs", warmMs);
                call.resolve(r);
            } catch (Throwable t) {
                call.reject("model load failed: " + t.getClass().getSimpleName() + ": " + t.getMessage(), "INIT_FAILED");
            }
        });
    }

    // ---- request/response path -------------------------------------------------------------------------------------

    @PluginMethod
    public void detect(PluginCall call) {
        if (detector == null) {
            call.reject("not initialised", "NOT_INITIALISED");
            return;
        }
        if (streaming) {
            call.reject("a stream is running; use submit()", "STREAMING");
            return;
        }
        if (!busy.compareAndSet(false, true)) {
            busyRejects++;
            call.reject("inference in progress", "BUSY");
            return;
        }
        final String rgb64 = call.getString("rgb");
        final String format = call.getString("format", FORMAT_RGB);
        final Integer srcW = call.getInt("srcW");
        final Integer srcH = call.getInt("srcH");
        if (!validFrame(rgb64, srcW, srcH) || !validFormat(format)) {
            busy.set(false);
            call.reject("rgb (base64), format (rgb|jpeg), srcW and srcH are required", "BAD_FRAME");
            return;
        }
        exec.execute(() -> {
            try {
                long t0 = System.nanoTime();
                LiteRtDetector d = detector;
                if (d == null) throw new IllegalStateException("detector disposed");
                Decoded dec;
                try {
                    dec = decodePayload(rgb64, format);
                } catch (BadFrame e) {
                    call.reject(e.getMessage(), "BAD_FRAME");
                    return;
                }
                call.resolve(process(d, dec, srcW, srcH, t0, 0));
            } catch (Throwable t) {
                call.reject(t.getClass().getSimpleName() + ": " + t.getMessage(), "INFER_FAILED");
            } finally {
                busy.set(false);
            }
        });
    }

    // ---- streaming path --------------------------------------------------------------------------------------------

    @PluginMethod
    public void startStream(PluginCall call) {
        if (detector == null) {
            call.reject("not initialised", "NOT_INITIALISED");
            return;
        }
        synchronized (streamLock) {
            if (streaming) {
                call.resolve();
                return;
            }
            // Wait out a running detect() so two inferences never overlap.
            if (!busy.compareAndSet(false, true)) {
                call.reject("inference in progress", "BUSY");
                return;
            }
            busy.set(false);
            slot = new LatestFrameSlot<>();
            final LatestFrameSlot<StreamFrame> mySlot = slot;
            streamThread = new Thread(() -> streamLoop(mySlot), "native-detector-stream");
            streamThread.start();
            streaming = true;
        }
        call.resolve();
    }

    @PluginMethod
    public void stopStream(PluginCall call) {
        stopStreamBlocking();
        call.resolve();
    }

    /** Post the newest frame and return at once. A frame not yet taken by the worker is replaced (and counted), never queued. */
    @PluginMethod
    public void submit(PluginCall call) {
        final String rgb64 = call.getString("rgb");
        final String format = call.getString("format", FORMAT_RGB);
        final Integer srcW = call.getInt("srcW");
        final Double seq = call.getDouble("seq");
        final Integer srcH = call.getInt("srcH");
        if (!validFrame(rgb64, srcW, srcH) || !validFormat(format) || seq == null || seq < 0 || seq > 4294967295.0) {
            call.reject("rgb (base64), format (rgb|jpeg), srcW, srcH and seq (uint32) are required", "BAD_FRAME");
            return;
        }
        boolean replaced;
        synchronized (streamLock) {
            if (!streaming || slot == null) {
                call.reject("stream not started", "NOT_STREAMING");
                return;
            }
            replaced = slot.offer(new StreamFrame(rgb64, format, srcW, srcH, seq));
        }
        JSObject r = new JSObject();
        r.put("accepted", true);
        r.put("replaced", replaced);
        call.resolve(r);
    }

    private void streamLoop(LatestFrameSlot<StreamFrame> mySlot) {
        try {
            StreamFrame f;
            while ((f = mySlot.take()) != null) {
                try {
                    long t0 = System.nanoTime();
                    LiteRtDetector d = detector;
                    if (d == null) throw new IllegalStateException("detector disposed");
                    Decoded dec;
                    try {
                        dec = decodePayload(f.rgb64, f.format);
                    } catch (BadFrame e) {
                        notifyError(f.seq, "BAD_FRAME", e.getMessage());
                        continue;
                    }
                    double queueMs = (t0 - f.submittedNs) / 1e6;
                    JSObject r = process(d, dec, f.srcW, f.srcH, t0, queueMs);
                    r.put("seq", f.seq);
                    r.put("replacedTotal", mySlot.replacedCount());
                    streamProcessed++;
                    notifyListeners("detection", r);
                } catch (Throwable t) {
                    notifyError(f.seq, "INFER_FAILED", t.getClass().getSimpleName() + ": " + t.getMessage());
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void notifyError(double seq, String code, String message) {
        JSObject e = new JSObject();
        e.put("seq", seq);
        e.put("code", code);
        e.put("message", message);
        notifyListeners("detectorError", e);
    }

    private void stopStreamBlocking() {
        Thread t;
        synchronized (streamLock) {
            if (!streaming) return;
            streaming = false;
            if (slot != null) slot.close();
            slot = null;
            t = streamThread;
            streamThread = null;
        }
        if (t != null) {
            try {
                t.join(3000); // an inference in progress finishes first (about 0.2 s)
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    // ---- shared ----------------------------------------------------------------------------------------------------

    private static boolean validFrame(String rgb64, Integer srcW, Integer srcH) {
        return rgb64 != null && rgb64.length() <= MAX_BASE64_CHARS && srcW != null && srcH != null && srcW >= 1 && srcH >= 1 && srcW <= 16384 && srcH <= 16384;
    }

    private static boolean validFormat(String format) {
        return FORMAT_RGB.equals(format) || FORMAT_JPEG.equals(format);
    }

    /** The frame is malformed (wrong size, not a decodable JPEG). Reported to the caller as BAD_FRAME, never fatal. */
    private static final class BadFrame extends Exception {
        BadFrame(String message) {
            super(message);
        }
    }

    /** A decoded payload: either packed RGB bytes or decoded ARGB pixels (JPEG path). */
    private static final class Decoded {
        byte[] rgb;
        int[] argb;
    }

    /**
     * Turn the base64 payload into model input material. "rgb": 416x416x3 packed bytes. "jpeg": a 416x416 JPEG (the web side
     * letterboxes first, so the decoded size must be exactly 416x416). JPEG is lossy: its effect on detections is measured on
     * the device (docs/TECHNICAL_DECISIONS.md D-030).
     */
    private static Decoded decodePayload(String payload64, String format) throws BadFrame {
        byte[] raw;
        try {
            raw = Base64.decode(payload64, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            throw new BadFrame("payload is not valid base64");
        }
        Decoded d = new Decoded();
        if (FORMAT_JPEG.equals(format)) {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inPreferredConfig = Bitmap.Config.ARGB_8888;
            o.inScaled = false;
            Bitmap b = BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
            if (b == null) throw new BadFrame("payload is not a decodable JPEG");
            try {
                if (b.getWidth() != Preprocess.SIZE || b.getHeight() != Preprocess.SIZE) {
                    throw new BadFrame("jpeg must be " + Preprocess.SIZE + "x" + Preprocess.SIZE + ", got " + b.getWidth() + "x" + b.getHeight());
                }
                d.argb = new int[Preprocess.SIZE * Preprocess.SIZE];
                b.getPixels(d.argb, 0, Preprocess.SIZE, 0, 0, Preprocess.SIZE, Preprocess.SIZE);
            } finally {
                b.recycle();
            }
        } else {
            if (raw.length != Preprocess.RGB_BYTES) throw new BadFrame("frame must be " + Preprocess.RGB_BYTES + " bytes, got " + raw.length);
            d.rgb = raw;
        }
        return d;
    }

    /** Infer + decode one frame and build the result object (timings in ms). `t0` is when processing of this frame began. */
    private JSObject process(LiteRtDetector d, Decoded dec, int srcW, int srcH, long t0, double queueMs) throws Exception {
        long t1 = System.nanoTime();
        LiteRtDetector.Result res = dec.rgb != null ? d.infer(dec.rgb) : d.inferPixels(dec.argb);
        long t2 = System.nanoTime();
        List<YoloxDecoder.Detection> dets = YoloxDecoder.decode(res.raw, srcW, srcH, options);
        long t3 = System.nanoTime();

        JSArray arr = new JSArray();
        for (YoloxDecoder.Detection x : dets) {
            JSObject j = new JSObject();
            j.put("classId", x.classId);
            j.put("score", x.score);
            j.put("x", x.x);
            j.put("y", x.y);
            j.put("w", x.w);
            j.put("h", x.h);
            arr.put(j);
        }
        JSObject r = new JSObject();
        r.put("detections", arr);
        r.put("queueMs", queueMs);
        r.put("decodeInputMs", (t1 - t0) / 1e6);
        r.put("prepMs", res.prepMs);
        r.put("inferMs", res.runMs);
        r.put("readMs", res.readMs);
        r.put("decodeMs", (t3 - t2) / 1e6);
        r.put("nativeTotalMs", (t3 - t0) / 1e6);
        lastTotalMs = (t3 - t0) / 1e6;
        inferences++;
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        LiteRtDetector d = detector;
        r.put("ready", d != null);
        r.put("threads", d == null ? 0 : d.threads);
        r.put("busy", busy.get());
        r.put("streaming", streaming);
        r.put("inferences", inferences);
        r.put("busyRejects", busyRejects);
        r.put("streamProcessed", streamProcessed);
        r.put("lastNativeTotalMs", lastTotalMs);
        call.resolve(r);
    }

    @PluginMethod
    public void dispose(PluginCall call) {
        exec.execute(() -> {
            stopStreamBlocking();
            LiteRtDetector d = detector;
            detector = null;
            if (d != null) d.close();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        exec.execute(() -> {
            stopStreamBlocking();
            LiteRtDetector d = detector;
            detector = null;
            if (d != null) d.close();
        });
        exec.shutdown();
    }
}
