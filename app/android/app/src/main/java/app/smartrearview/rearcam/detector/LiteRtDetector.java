package app.smartrearview.rearcam.detector;

import android.content.res.AssetManager;
import com.google.ai.edge.litert.Accelerator;
import com.google.ai.edge.litert.CompiledModel;
import com.google.ai.edge.litert.TensorBuffer;
import java.util.List;

/**
 * One compiled YOLOX-nano model on the LiteRT CPU (XNNPACK) accelerator. infer() is synchronized because the model, its
 * buffers and the BGR scratch array are shared: only one inference runs at a time (docs/ARCHITECTURE.md D-006), whether it
 * comes from the request/response path or the stream worker. CPU only; the GPU path is untested (D-022).
 */
public final class LiteRtDetector implements AutoCloseable {
    /** Raw head output length, 3549 x 85. */
    public static final int OUTPUT_FLOATS = YoloxDecoder.NUM_ANCHORS * YoloxDecoder.ROW;

    public static final class Result {
        public final float[] raw;
        public final double prepMs;
        public final double runMs;
        public final double readMs;

        Result(float[] raw, double prepMs, double runMs, double readMs) {
            this.raw = raw;
            this.prepMs = prepMs;
            this.runMs = runMs;
            this.readMs = readMs;
        }
    }

    private final CompiledModel model;
    private final List<TensorBuffer> inputs;
    private final List<TensorBuffer> outputs;
    private final float[] bgr = new float[Preprocess.FLOATS];
    public final double compileMs;
    public final int threads;

    private LiteRtDetector(CompiledModel model, List<TensorBuffer> in, List<TensorBuffer> out, double compileMs, int threads) {
        this.model = model;
        this.inputs = in;
        this.outputs = out;
        this.compileMs = compileMs;
        this.threads = threads;
    }

    public static LiteRtDetector create(AssetManager assets, String assetPath, int threads) throws Exception {
        long t0 = System.nanoTime();
        CompiledModel.Options o = new CompiledModel.Options(new Accelerator[] {Accelerator.CPU});
        o.setCpuOptions(new CompiledModel.CpuOptions(threads, null, null));
        CompiledModel m = CompiledModel.create(assets, assetPath, o);
        try {
            List<TensorBuffer> in = m.createInputBuffers();
            List<TensorBuffer> out = m.createOutputBuffers();
            return new LiteRtDetector(m, in, out, (System.nanoTime() - t0) / 1e6, threads);
        } catch (Exception | Error e) {
            m.close();
            throw e;
        }
    }

    /**
     * Run a few inferences on a flat gray frame (the letterbox padding value) so the first real frame does not pay the
     * one-time cost of weight packing and cache warm-up (measured: first run about 190 ms against a 71 ms median).
     */
    public double warmUp(int runs) throws Exception {
        long t0 = System.nanoTime();
        byte[] gray = new byte[Preprocess.RGB_BYTES];
        java.util.Arrays.fill(gray, (byte) 114);
        for (int i = 0; i < runs; i++) infer(gray);
        return (System.nanoTime() - t0) / 1e6;
    }

    /** Run one inference on a letterboxed packed-RGB frame (Preprocess.RGB_BYTES long). */
    public synchronized Result infer(byte[] rgb) throws Exception {
        long t0 = System.nanoTime();
        Preprocess.rgbToBgrFloat(rgb, bgr);
        return run(t0);
    }

    /** Same, from decoded Android pixels (Bitmap.getPixels of a 416x416 letterboxed frame), e.g. after JPEG decoding. */
    public synchronized Result inferPixels(int[] argb) throws Exception {
        long t0 = System.nanoTime();
        Preprocess.argbToBgrFloat(argb, bgr);
        return run(t0);
    }

    private Result run(long t0) throws Exception {
        inputs.get(0).writeFloat(bgr);
        long t1 = System.nanoTime();
        model.run(inputs, outputs);
        long t2 = System.nanoTime();
        float[] raw = outputs.get(0).readFloat();
        long t3 = System.nanoTime();
        if (raw.length != OUTPUT_FLOATS) throw new IllegalStateException("model returned " + raw.length + " floats, expected " + OUTPUT_FLOATS);
        return new Result(raw, (t1 - t0) / 1e6, (t2 - t1) / 1e6, (t3 - t2) / 1e6);
    }

    @Override
    public void close() {
        for (TensorBuffer t : inputs) t.close();
        for (TensorBuffer t : outputs) t.close();
        model.close();
    }
}
