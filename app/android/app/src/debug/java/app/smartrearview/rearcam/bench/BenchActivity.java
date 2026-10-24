package app.smartrearview.rearcam.bench;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.os.BatteryManager;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.widget.ScrollView;
import android.widget.TextView;
import com.google.ai.edge.litert.Accelerator;
import com.google.ai.edge.litert.CompiledModel;
import com.google.ai.edge.litert.Environment;
import com.google.ai.edge.litert.TensorBuffer;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

/**
 * THROWAWAY native timing experiment (E1 follow-up, docs/TECHNICAL_DECISIONS.md D-022). Debug builds only (src/debug).
 * Runs litert-community/yolox-nano-litert through LiteRT CompiledModel on CPU (1/2/4/8 threads) and GPU backends,
 * on the bundled model-card sample, and logs one JSON line per trial under tag E1N. Start with:
 *   adb shell am start -n app.smartrearview.rearcam/.bench.BenchActivity
 * Not part of the product; delete once the native detector exists.
 */
public class BenchActivity extends Activity {
    private static final String TAG = "E1N";
    private static final int SIZE = 416;
    private static final int ANCHORS = 3549;
    private static final int ROW = 85;
    private static final int WARMUP = 5;
    private static final int RUNS = 100;

    private TextView out;
    private Environment env;
    private int gapMs = 0;
    private int prio = Integer.MIN_VALUE;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        out = new TextView(this);
        out.setTextSize(11f);
        out.setTypeface(android.graphics.Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this);
        sv.addView(out);
        setContentView(sv);
        new Thread(this::runAll, "e1-native").start();
    }

    private void say(String s) {
        Log.i(TAG, s);
        runOnUiThread(() -> out.append(s + "\n"));
    }

    private void runAll() {
        try {
            float[] input = sampleInput();
            say("E1N_START " + "{\"sdk\":" + android.os.Build.VERSION.SDK_INT + ",\"model\":\"" + android.os.Build.MODEL + "\"}");
            // `--ez gpuonly true`: rerun only the GPU trials, with an Android-context Environment (the first run used none).
            boolean gpuOnly = getIntent().getBooleanExtra("gpuonly", false);
            try {
                Set<Accelerator> av = Environment.create().getAvailableAccelerators();
                say("E1N_ENV availableAccelerators(no context)=" + av);
            } catch (Throwable t) {
                say("E1N_ENV error " + describe(t));
            }
            try {
                env = Environment.create(this);
                say("E1N_ENV availableAccelerators(context)=" + env.getAvailableAccelerators());
            } catch (Throwable t) {
                say("E1N_ENV(context) error " + describe(t));
            }

            List<Trial> trials = new ArrayList<>();
            // Extras for the idle-gap experiment (D-024): --ei gapms N (sleep between timed runs), --es threads "2" (CPU thread
            // counts to run), --ei prio P (android.os.Process thread priority for the bench thread), --ez nogpu true.
            gapMs = getIntent().getIntExtra("gapms", 0);
            String thr = getIntent().getStringExtra("threads");
            boolean noGpu = getIntent().getBooleanExtra("nogpu", false);
            if (getIntent().hasExtra("prio")) {
                prio = getIntent().getIntExtra("prio", 0);
                android.os.Process.setThreadPriority(prio);
            }
            int[] threadList = {1, 2, 4, 8};
            if (thr != null) {
                String[] p = thr.split(",");
                threadList = new int[p.length];
                for (int i = 0; i < p.length; i++) threadList[i] = Integer.parseInt(p[i].trim());
            }
            if (!gpuOnly) for (int th : threadList) trials.add(Trial.cpu(th));
            if (noGpu) {
                for (Trial t : trials) runTrial(t, input);
                say("E1N_DONE");
                return;
            }
            trials.add(Trial.gpu("gpu-auto-default", CompiledModel.GpuOptions.Backend.AUTOMATIC, CompiledModel.GpuOptions.Precision.DEFAULT));
            trials.add(Trial.gpu("gpu-opencl-fp16", CompiledModel.GpuOptions.Backend.OPENCL, CompiledModel.GpuOptions.Precision.FP16));
            trials.add(Trial.gpu("gpu-opencl-default", CompiledModel.GpuOptions.Backend.OPENCL, CompiledModel.GpuOptions.Precision.DEFAULT));
            trials.add(Trial.gpu("gpu-opengl-default", CompiledModel.GpuOptions.Backend.OPENGL, CompiledModel.GpuOptions.Precision.DEFAULT));
            trials.add(Trial.gpu("gpu-webgpu-default", CompiledModel.GpuOptions.Backend.WEBGPU, CompiledModel.GpuOptions.Precision.DEFAULT));
            for (Trial t : trials) runTrial(t, input);
            say("E1N_DONE");
        } catch (Throwable t) {
            say("E1N_FATAL " + describe(t));
        }
    }

    private static final class Trial {
        final String name;
        final CompiledModel.Options options;

        Trial(String name, CompiledModel.Options options) {
            this.name = name;
            this.options = options;
        }

        static Trial cpu(int threads) {
            CompiledModel.Options o = new CompiledModel.Options(new Accelerator[] {Accelerator.CPU});
            o.setCpuOptions(new CompiledModel.CpuOptions(threads, null, null));
            return new Trial("cpu-" + threads + "t", o);
        }

        static Trial gpu(String name, CompiledModel.GpuOptions.Backend backend, CompiledModel.GpuOptions.Precision precision) {
            CompiledModel.Options o = new CompiledModel.Options(new Accelerator[] {Accelerator.GPU});
            o.setGpuOptions(new CompiledModel.GpuOptions(null, null, null, precision, CompiledModel.GpuOptions.BufferStorageType.DEFAULT,
                null, null, null, null, null, null, null, backend, CompiledModel.GpuOptions.Priority.DEFAULT, null));
            return new Trial(name, o);
        }
    }

    private void runTrial(Trial t, float[] input) {
        StringBuilder j = new StringBuilder("{\"trial\":\"" + t.name + "\"");
        CompiledModel model = null;
        List<TensorBuffer> in = null;
        List<TensorBuffer> outb = null;
        try {
            j.append(",\"battTempC0\":").append(batteryTempC());
            long t0 = System.nanoTime();
            model = env != null && getIntent().getBooleanExtra("gpuonly", false)
                ? CompiledModel.create(getAssets(), "models/yolox_nano.tflite", t.options, env)
                : CompiledModel.create(getAssets(), "models/yolox_nano.tflite", t.options);
            j.append(",\"compileMs\":").append(ms(System.nanoTime() - t0));
            in = model.createInputBuffers();
            outb = model.createOutputBuffers();
            j.append(",\"loads\":true");

            float[] last = null;
            for (int i = 0; i < WARMUP; i++) {
                last = once(model, in, outb, input, null);
                if (gapMs > 0) Thread.sleep(gapMs);
            }
            double[] total = new double[RUNS];
            double[] runOnly = new double[RUNS];
            for (int i = 0; i < RUNS; i++) {
                double[] parts = new double[1];
                long s = System.nanoTime();
                last = once(model, in, outb, input, parts);
                total[i] = (System.nanoTime() - s) / 1e6;
                runOnly[i] = parts[0];
                if (gapMs > 0) Thread.sleep(gapMs); // idle gap between inferences, like a real pipeline
            }
            j.append(",\"gapMs\":").append(gapMs).append(",\"prio\":").append(prio == Integer.MIN_VALUE ? "null" : String.valueOf(prio));
            j.append(",\"runs\":").append(RUNS);
            j.append(",\"medianMs\":").append(round1(pct(total, 50)));
            j.append(",\"p95Ms\":").append(round1(pct(total, 95)));
            j.append(",\"maxMs\":").append(round1(pct(total, 100)));
            j.append(",\"runOnlyMedianMs\":").append(round1(pct(runOnly, 50)));
            j.append(",\"inferencesPerSecMedian\":").append(round1(1000.0 / pct(total, 50)));
            j.append(",\"outputLength\":").append(last.length);
            boolean nan = false;
            for (float v : last) if (Float.isNaN(v)) { nan = true; break; }
            j.append(",\"outputHasNaN\":").append(nan);
            j.append(",\"top\":").append(topAnyClass(last));
            j.append(",\"battTempC1\":").append(batteryTempC());
        } catch (Throwable e) {
            j.append(",\"loads\":").append(model != null).append(",\"error\":\"").append(esc(describe(e))).append("\"");
        } finally {
            close(in);
            close(outb);
            if (model != null) model.close();
        }
        j.append("}");
        say("E1N_TRIAL " + j);
    }

    private float[] once(CompiledModel m, List<TensorBuffer> in, List<TensorBuffer> outb, float[] input, double[] runOnlyMs) throws Exception {
        in.get(0).writeFloat(input);
        long s = System.nanoTime();
        m.run(in, outb);
        if (runOnlyMs != null) runOnlyMs[0] = (System.nanoTime() - s) / 1e6;
        return outb.get(0).readFloat();
    }

    private static void close(List<TensorBuffer> l) {
        if (l == null) return;
        for (TensorBuffer t : l) {
            try { t.close(); } catch (Throwable ignored) { }
        }
    }

    /** Letterbox the bundled sample to 416x416 (gray 114 pad bottom/right) and convert to BGR float32 NHWC, 0-255. */
    private float[] sampleInput() throws Exception {
        Bitmap src;
        try (InputStream is = getAssets().open("sample.png")) {
            src = BitmapFactory.decodeStream(is);
        }
        double ratio = Math.min((double) SIZE / src.getWidth(), (double) SIZE / src.getHeight());
        int nw = Math.min(SIZE, (int) Math.round(src.getWidth() * ratio));
        int nh = Math.min(SIZE, (int) Math.round(src.getHeight() * ratio));
        Bitmap canvasBmp = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(canvasBmp);
        c.drawColor(Color.rgb(114, 114, 114));
        Paint p = new Paint(Paint.FILTER_BITMAP_FLAG);
        c.drawBitmap(src, null, new Rect(0, 0, nw, nh), p);
        int[] px = new int[SIZE * SIZE];
        canvasBmp.getPixels(px, 0, SIZE, 0, 0, SIZE, SIZE);
        float[] t = new float[SIZE * SIZE * 3];
        for (int i = 0, k = 0; i < px.length; i++, k += 3) {
            int v = px[i];
            t[k] = v & 0xff;            // B
            t[k + 1] = (v >> 8) & 0xff; // G
            t[k + 2] = (v >> 16) & 0xff; // R
        }
        say("E1N_INPUT src=" + src.getWidth() + "x" + src.getHeight() + " ratio=" + ratio + " new=" + nw + "x" + nh);
        return t;
    }

    /** Sanity check: best anchors over ALL 80 COCO classes (no filter, no NMS), boxes normalised to the source image. */
    private String topAnyClass(float[] raw) {
        int[] strides = {8, 16, 32};
        List<double[]> rows = new ArrayList<>();
        int base = 0;
        double srcW = 1200, srcH = 820;
        double ratio = Math.min(SIZE / srcW, SIZE / srcH);
        for (int stride : strides) {
            int g = SIZE / stride;
            for (int i = 0; i < g * g; i++) {
                int o = (base + i) * ROW;
                float best = 0;
                int bc = 0;
                for (int c = 0; c < 80; c++) {
                    float v = raw[o + 5 + c];
                    if (v > best) { best = v; bc = c; }
                }
                double score = raw[o + 4] * best;
                if (score < 0.3) continue;
                int gx = i % g, gy = i / g;
                rows.add(new double[] {score, bc, ((raw[o] + gx) * stride / ratio) / srcW, ((raw[o + 1] + gy) * stride / ratio) / srcH});
            }
            base += g * g;
        }
        rows.sort((a, b) -> Double.compare(b[0], a[0]));
        StringBuilder s = new StringBuilder("[");
        for (int i = 0; i < Math.min(5, rows.size()); i++) {
            double[] r = rows.get(i);
            if (i > 0) s.append(',');
            s.append(String.format(java.util.Locale.US, "{\"cls\":%d,\"score\":%.3f,\"cx\":%.3f,\"cy\":%.3f}", (int) r[1], r[0], r[2], r[3]));
        }
        return s.append("]").toString();
    }

    private double batteryTempC() {
        Intent i = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        return i == null ? -1 : i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) / 10.0;
    }

    private static double ms(long nanos) { return Math.round(nanos / 1e5) / 10.0; }
    private static double round1(double v) { return Math.round(v * 10.0) / 10.0; }

    private static double pct(double[] xs, int p) {
        double[] s = xs.clone();
        Arrays.sort(s);
        return s[Math.min(s.length - 1, (int) Math.floor(p / 100.0 * s.length))];
    }

    private static String describe(Throwable t) {
        String m = t.getClass().getSimpleName() + ": " + t.getMessage();
        return m.length() > 500 ? m.substring(0, 500) : m;
    }

    private static String esc(String s) { return s.replace("\\", "\\\\").replace("\"", "'").replace("\n", " "); }
}
