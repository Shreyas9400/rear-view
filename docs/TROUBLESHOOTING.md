# TROUBLESHOOTING

Status: **hypotheses, not confirmed findings.** Last updated 2026-10-22 (Phase 0). "Likely causes" are suspicions until evidence is recorded. Only mark a root cause **CONFIRMED** when supported by logs or measurements, and add the evidence reference. Entry format: symptoms · likely causes · checks · safe fallback.

## Camera permission denied
- **Symptoms:** `NotAllowedError` from `getUserMedia`; `health.camera = denied`.
- **Likely causes:** runtime permission not granted; `CAMERA` missing from the manifest; WebView permission callback not granting; permission revoked in Settings.
- **Checks:** `adb shell dumpsys package <app id> | grep CAMERA`; Settings → App permissions; logcat for permission requests.
- **Fallback:** request permission from a visible tap screen; plugin-level permission request; if the WebView still refuses, native CameraX capture (+6–10 h).

## Camera unavailable in WebView
- **Symptoms:** `NotFoundError`/`NotReadableError`; black preview.
- **Likely causes:** another app holds the camera; `facingMode: 'environment'` unsupported; resolution constraint unsatisfiable; WebView too old.
- **Checks:** `enumerateDevices()` output; try lower constraints; check WebView version; logcat for camera service errors.
- **Fallback:** relax to 480p; reboot the phone; native capture.

## Model fails to load
- **Symptoms:** exception from `loadAndCompile`; `health.detector = failed`.
- **Likely causes:** WASM files not served from the app (path); JSPI unsupported by the WebView; model file missing or corrupted; out of memory; unsupported accelerator.
- **Checks:** network tab/logcat for 404s; file size of the `.tflite` (HF card: 2.2 MB); try `wasm` vs `webgpu`; console error text.
- **Fallback:** Plan B (native LiteRT) or Plan C (other model).

## Unsupported tensor operators
- **Symptoms:** compile/run error naming an op; silent CPU fallback and slow inference.
- **Likely causes:** the runtime lacks an op for the chosen accelerator; FP16 graph not supported on the CPU path (model card reports XNNPACK declines it).
- **Checks:** error text; per-accelerator test matrix (`DEVICE_COMPATIBILITY.md` §3).
- **Fallback:** another accelerator; native runtime; different model.

## WebGPU unavailable
- **Symptoms:** `navigator.gpu` undefined or `requestAdapter()` returns null.
- **Likely causes:** WebView version too old; Android < 12; GPU vendor not enabled (Chrome's default is for Qualcomm/ARM GPUs); WebView doesn't expose it.
- **Checks:** log WebView version and `navigator.gpu` in E2; compare with Chrome on the same phone.
- **Fallback:** WASM (check it loads); native runtime.

## WebAssembly inference too slow
- **Symptoms:** < 3 inferences/s; p95 > 400 ms; high CPU.
- **Likely causes:** CPU-only on an old SoC; reference kernels instead of XNNPACK (model card: about 20× slower than GPU); single-threaded WASM; thermal throttling.
- **Checks:** per-stage timings (pre/infer/post); thread availability; temperature during the run.
- **Fallback:** native GPU path; lower inference rate; different model.

## Native GPU delegate unavailable
- **Symptoms:** delegate creation fails; fallback to CPU.
- **Likely causes:** no OpenCL/compatible driver; unsupported ops for that GPU; old Android.
- **Checks:** logcat for delegate errors; `libOpenCL.so` presence; run the model card's sample.
- **Fallback:** Plan C (CPU-friendly INT8 model) with a lower rate.

## Android build failure
- **Symptoms:** Gradle errors; CI red; APK missing.
- **Likely causes:** JDK/AGP/Gradle mismatch; SDK platform missing; Capacitor sync not run; signing config.
- **Checks:** full Gradle log (`--stacktrace`); versions in `android/build.gradle`; `npx cap sync`.
- **Fallback:** CI debug APK; Android Studio on a laptop; plain-web detector demo.

## HTTP server fails to start
- **Symptoms:** plugin `start()` rejects; port in use; no viewer URL.
- **Likely causes:** port occupied; no hotspot/Wi-Fi address (by design the viewer listener will not start); missing network permission; library incompatibility with the Android API level.
- **Checks:** logcat; list interfaces via `getNetworkInfo()`; try another port.
- **Fallback:** another port; NanoHTTPD; rear-screen-only mode.

## WebSocket connection rejected
- **Symptoms:** close codes 4401 / 4403 / 4408 / 4426 / 4429 / 4430.
- **Likely causes:** see `PROTOCOL_SPEC.md` §12: bad or expired token; wrong origin (page opened via a different host name than the bound IP); hello timeout; version mismatch; lockout; too many viewers.
- **Checks:** close code and `error` message; compare the page origin with the bound address; revoke and rescan.
- **Fallback:** Revoke and rescan; wait out a lockout; close other viewers.

## QR URL uses the wrong network address
- **Symptoms:** iPhone times out; QR shows an address from the wrong interface (e.g. cellular).
- **Likely causes:** multiple interfaces; hotspot started after the server; gateway differs from the assumption.
- **Checks:** the interface list in the rear UI; `adb shell ip addr`.
- **Fallback:** start the hotspot first; restart the server; choose the interface manually.

## iPhone cannot reach the server
- **Symptoms:** Safari spins or shows "cannot connect".
- **Likely causes:** iPhone not on the hotspot; client isolation (if the iPhone hosts); wrong IP/port; iOS using cellular for a "no internet" Wi-Fi; server not bound to this interface.
- **Checks:** `GET /healthz` in Safari; ping equivalent; turn cellular off; verify both phones' IPs and subnet.
- **Fallback:** swap hotspot host; re-enter the URL manually; rescan QR.

## Viewer shows stale frames
- **Symptoms:** STALE/DELAYED banner; frozen image.
- **Likely causes:** rear app paused or screen locked; inference/encode stalls; Wi-Fi congestion; viewer not acking; thermal throttling; `ingest` disconnected.
- **Checks:** `status` fields (`ingest`, `lastFrameAgeMs`, drop counters); rear HUD fps; temperature.
- **Fallback:** foreground the rear app; reduce stream fps/resolution; restart the server.

## Detection boxes are misaligned
- **Symptoms:** boxes offset or scaled wrongly.
- **Likely causes:** letterbox padding not removed (pad is bottom/right); BGR vs RGB channel order; wrong aspect handling between 1280×720 capture and 640×360 JPEG; boxes belong to an earlier `detSeq` (lag); canvas CSS scaling.
- **Checks:** run the decode test on a synthetic frame with a known box; draw the 416 letterboxed input for inspection (diagnostic mode); compare `detAgeMs`.
- **Fallback:** hide boxes when `detAgeMs` is large; verify with a static test image.

## Inference latency increases
- **Symptoms:** p95 ms rising over time.
- **Likely causes:** thermal throttling; memory pressure/GC; accumulated tensors not freed; background tasks.
- **Checks:** plot latency vs temperature/time; memory trend; dispose of tensors and bitmaps.
- **Fallback:** cap inference rate; restart pipeline; cool the phone.

## Device overheats
- **Symptoms:** high battery temperature; throttling; dim screen; shutdown.
- **Likely causes:** sun on a parked car, charging under load, hotspot radio, 100 % CPU/GPU.
- **Checks:** `dumpsys battery` temperature; `dumpsys thermalservice`; compare with hotspot off.
- **Fallback:** lower inference/stream rates; dim the screen; shade or ventilate; stop the test. **Stop immediately if the phone is unsafely hot.**

## Memory usage grows continuously
- **Symptoms:** `meminfo` rising; eventual crash or reload.
- **Likely causes:** unclosed `ImageBitmap`; tensors/blob URLs not released; unbounded logs or history arrays.
- **Checks:** heap snapshots in desktop Chrome via `chrome://inspect`; `adb shell dumpsys meminfo <app id>` over time.
- **Fallback:** close bitmaps promptly; bound arrays; restart on a threshold.

## Rule for recording findings
Add a dated entry with the evidence reference under the relevant heading; label it CONFIRMED only with evidence, otherwise LIKELY or RULED OUT.
