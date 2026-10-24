# E1 native LiteRT (CompiledModel) timing: raw notes (2026-10-24)

Harness: `app/android/app/src/debug/java/app/smartrearview/rearcam/bench/BenchActivity.java` (debug builds only, throwaway). Library: `com.google.ai.edge.litert:litert:2.3.0` (Apache-2.0). Same model (sha256 `3a621c40…970e4`) and the model-card sample, letterboxed on Android with a bilinear `Canvas.drawBitmap`. Per trial: 5 warm-up + 100 timed runs; each timed run = `writeFloat` (519,168 floats) + `run` + `readFloat` (301,665 floats). Device: OnePlus 6T, Android 11, USB-powered, battery 11%, screen on, no GPU debug layers configured (`settings get global gpu_debug_*` all null). Captured from `adb logcat -s E1N`.

| Trial | compile ms | median ms (end-to-end) | p95 ms | max ms | run-only median ms | inferences/s (median) | battery °C before → after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cpu, 1 thread | 23.8 | 96.1 | 98.9 | 100.6 | 95.2 | **10.4** | 35.2 → 35.4 |
| cpu, 2 threads | 17.9 | 51.6 | 52.1 | 52.3 | 50.5 | **19.4** | 35.4 → 35.6 |
| cpu, 4 threads | 17.9 | 37.5 | 102.2 | 107.4 | 35.7 | **26.6** | 35.6 → 35.7 |
| cpu, 8 threads | 21.6 | 29.1 | 107.1 | 114.2 | 27.9 | **34.4** | 35.7 → 35.9 |
| GPU: auto / opencl fp16 / opencl default / opengl / webgpu | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

GPU: every backend failed with `LiteRtException: Failed to compile model`, with or without an Android-context `Environment`. `Environment.getAvailableAccelerators()` = `[CPU]` only. Logcat shows LiteRT trying `libLiteRtGpuAccelerator.so`, `libLiteRtClGlAccelerator.so`, `libLiteRtOpenClAccelerator.so`, `libLiteRtWebGpuAccelerator.so`, `libLiteRtVulkanAccelerator.so` and registering "GPU accelerator could not be loaded". The `litert:2.3.0` AAR contains only `libLiteRt.so` (CPU); the GPU accelerator libraries are in the separate artifact `com.google.ai.edge.litert:litert-gpu:2.3.0` (4,695,499 bytes), **not downloaded** (needs approval). So this says nothing yet about whether the Adreno 630 GPU path works.

Correctness: all CPU trials produced identical output; top anchors over all 80 classes: class 0 (person) with scores 0.615, 0.606, 0.567, 0.500, 0.431 at about (0.281, 0.752), matching the LiteRT.js WASM run (0.282, 0.751; scores 0.65…). Small score differences are expected from the different image resampling (Android bilinear vs browser canvas). No NaN. `outputLength` 301,665 = 3549 × 85. No vehicle image tested.

Observation: 4 and 8 threads have a median far below their p95 (about 37 / 29 ms median vs about 102 / 107 ms p95), i.e. an occasional run about 3x slower. Likely threads landing on the efficiency cores of the 4+4 big.LITTLE Snapdragon 845 **[inferred, not verified]**. 1 and 2 threads are tight (p95 within 3% of median).

Artifact sizes fetched from Google Maven: `litert-2.3.0.aar` 7,640,140 bytes, `litert-api-2.3.0.aar` 945,619 bytes. sha256: litert `9508c6e9142646f0f2bc1fe68b3925fb470ee7ddd29114540339a04a8ab189dc`, litert-api `20f630e9ed0b4f0564da616fd3d6406f3013cacad7d492cbe2963330f519256b`. Transitive (from the POMs, resolved by Gradle): `com.google.android.play:ai-delivery:0.1.1-alpha01` (219,522 bytes), `guava:33.5.0-android` (2,932,219), `kotlinx-coroutines-guava` (about 18 KB), `androidx.lifecycle:lifecycle-runtime`. arm64-v8a native library `libLiteRt.so` 5.6 MB.
