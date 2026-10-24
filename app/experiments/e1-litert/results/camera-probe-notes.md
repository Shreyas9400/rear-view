# Camera probe and pipeline experiments: raw notes (2026-10-24)

Device: OnePlus 6T, Android 11, WebView `Chrome/155.0.8059.43 wv`, debug APK, USB-powered, battery 14 to 15% throughout. Code: `app/src/selftest/cameraProbe.ts` (built with `VITE_SELFTEST=camera|ablation|isolate`), `app/src/capture/webViewCameraSource.ts`, `app/android/.../bench/BenchActivity.java`. Source of the live pictures: the user asked to use the YouTube video "Highway driving, Edinburgh (rear view camera, driving plate, 4k footage)" by Driving Footage, to be shown on a screen and filmed by the phone's rear camera. A screenshot of the probe overlay showed highway driving footage with cars, consistent with that video, but **I did not see the screen it was filmed from, so the exact source is unconfirmed**. The video was not downloaded and no frame was saved; only the numbers below are kept.

## Permission flow and capture (measured)

- `navigator.permissions.query({name:'camera'})` before first use: `prompt`. The first `getUserMedia` call opened the system dialog (`GrantPermissionsActivity`) within about 0.1 s. After a person tapped Allow the package showed `CAMERA granted=true, flags=USER_SET`. No code in the app handles the dialog: Capacitor's WebChromeClient does it once the manifest declares `CAMERA`.
- `getUserMedia({facingMode:{ideal:'environment'}, 1280x720, 15 fps})` succeeded: track settings `width 1280, height 720, frameRate 15, facingMode environment`. Start (after the permission was granted, with the detector already initialised) 739 ms. `enumerateDevices`: 2 video inputs.
- Baseline, camera only, 10 s: raw camera callbacks 14.9/s, emitted 14.8/s, 1 frame dropped, state `ok`.
- `devicemotion` in the WebView: 171 events in 3 s = **57 Hz**, with `rotationRate` and `acceleration` present. `navigator.wakeLock.request('screen')` worked.

## Full pipeline (camera 15 fps cap + native detector + JPEG 640x360 q0.6 + overlay), 5 x 10 s windows, run 2

| window | detections/s | infer ms | bridge ms | JS pre ms | frame→result median / p95 ms | JPEG median / p95 ms (n) | JPEG KB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2.4 | 169 | 121.4 | 61.3 | 380 / 430 | 80.2 / 214 (59) | 17.4 |
| 2 | 2.4 | 170 | 121.2 | 61.0 | 383 / 402 | 94.1 / 275 (54) | 18.7 |
| 3 | 2.5 | 170 | 120.2 | 59.7 | 379 / 395 | 96.4 / 213 (57) | 18.2 |
| 4 | 2.5 | 167 | 120.5 | 59.5 | 375 / 396 | 87.3 / 182 (61) | 16.8 |
| 5 | 2.5 | 170 | 120.9 | 60.7 | 377 / 414 | 77.4 / 216 (62) | 14.5 |

Vehicles per 10 s window: 67 to 145 car and 1 to 15 truck detections, top scores 0.84 to 0.94. Camera state `ok` and detector health `ok` throughout. A screenshot showed correct boxes on the cars in the footage, and one white SUV carrying both a "car" and a "truck 0.58" box (per-class NMS does not suppress across classes).

## Ablation (9 s windows each; camera always running)

| config | cam emit/s | detections/s | infer ms | bridge ms | JS pre ms | frame→result median/p95 | JPEG median/p95 ms (per s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B detect only, 15 fps | 14.6 | 2.5 | 168.5 | 115 | 66.6 | 375/403 | n/a |
| C detect + draw | 14.4 | 2.5 | 169.4 | 112 | 61.6 | 369/389 | n/a (draw 0.3 ms) |
| D detect + jpeg | 14.6 | 2.4 | 169.2 | 119.1 | 63.1 | 380/397 | 92.3/274.5 (5.1) |
| E jpeg only | 14.9 | 0 | n/a | n/a | n/a | n/a | 94.6/147.4 (6.8) |
| F full | 14.4 | 2.5 | 170.7 | 119.9 | 57.9 | 377/396 | 100.9/216 (5.8) |
| G detect only, 8 fps cap | 7.2 | 2.4 | 167.2 | 113 | 67.1 | 374/398 | n/a |
| H full, 8 fps cap | 7.4 | 2.4 | 169.7 | 120.1 | 62.4 | 384/391 | 77.1/157.8 (5.6) |
| I detect only, 5 fps cap | 5 | 2.4 | 169 | 112.3 | 61.9 | 372/390 | n/a |
| J detect only, 4 threads | 14.2 | 3.0 | 99.1 | 110.7 | 63.1 | 301/316 | n/a |
| K full, 4 threads | 14.5 | 3.2 | 99.8 | 115.4 | 59.1 | 302/319 | 110/289 (5.5) |
| L detect only, 1 thread | 14.9 | 2.2 | 235.3 | 91.3 | 58.1 | 405/420 | n/a |

Reading: JPEG encoding and the overlay do not change detector throughput; the camera rate does not either (even at 5 fps the detector manages only 2.4/s). Each detector call is simply slow in this pipeline: inference 169 ms (2 threads) against 63 ms in the standalone harness.

## Isolation: detector looping on a fixed image while the camera state changes

| phase | detections/s | infer ms | bridge ms | JS pre ms | cycle median / p95 ms |
| --- | --- | --- | --- | --- | --- |
| 1 no camera | 4.5 | 120.7 | 86 | 32.3 | 255 / 321 |
| 2 camera streaming, frames ignored | 2.9 | 164.7 | 114.9 | 44 | 350 / 366 |
| 3 camera streaming, frames consumed at 15 fps | 3.1 | 161.4 | 112.5 | 44 | 350 / 372 |
| 4 camera stopped again | 2.9 | 153 | 115.5 | 61.4 | 351 / 380 |

The camera session itself is not the cause: phase 4 (camera stopped) is as slow as phases 2 and 3.

## Standalone native harness, idle gap between runs (no WebView, no bridge; 100 timed runs each)

2 threads, model run only (median ms): gap 0 ms 61.5 (earlier runs 62.3, 62.6, 63.4); 20 ms 68.2; 40 ms 78.0; 60 ms 77.7; 80 ms 77.9 (p95 157); **120 ms 154.9; 160 ms 161.6**; also 100 ms 75.5 (p95 180), 200 ms 169.2. Thread priority −8 or −19 on the bench thread did not help (gap 100 ms: 155.0 / 75.8).
4 threads: gap 0 81.5, 60 ms 42.3, 120 ms 83.8, 200 ms 89.1 (earlier runs of the same setting: 34.2 and 37.5).
8 threads: gap 0 59.7 (earlier 27.8 to 29.1), 120 ms 62.4, 200 ms 64.6 (p95 84).

## Pipelined (streaming) detector on the live camera (D-026), 12 s per configuration after a 3 s settle

Run 2026-10-24 12:33 to 12:34, phone unlocked, battery 15%, USB power. Camera delivered **720×1280** (portrait: the phone was held upright), 15 fps. **No vehicles were in view** (no detections in any window), so these numbers measure pipeline cost, not detection quality. Frames are posted without waiting for results; the native worker takes the newest.

| config | detections/s | posted/s | replaced natively/s | skipped while packing/s | infer ms | queue ms | native total ms | bridge ms | JS pre ms | frame→result median / p95 ms | JPEG median / p95 ms (per s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 2 threads, detect only | 5.5 | 5.5 | 0 | 9.1 | 89.2 | 0.2 | 100.3 | 105.7 | 56.5 | 267 / 285 | n/a |
| S2 2 threads, full (JPEG + overlay) | 5.2 | 5.2 | 0 | 9.1 | 89.4 | 0.2 | 101.1 | 109.0 | 53.3 | 268 / 280 | 128.7 / 342.5 (4.2) |
| S3 4 threads, full | 5.1 | 5.1 | 0 | 9.7 | 56.2 | 0.2 | 67.8 | 140.0 | 55.0 | 268 / 279 | 144.2 / 415.9 (3.8) |
| S4 8 threads, full | 5.0 | 5.1 | 0 | 9.2 | 61.4 | 0.2 | 74.2 | 132.7 | 54.9 | 268 / 283 | 213.1 / 428.7 (3.6) |
| S5 8 threads, detect only | 4.7 | 4.7 | 0 | 9.1 | 96.1 | 0.3 | 117.5 | 124.9 | 62.6 | 312 / 383 | n/a |
| S6 4 threads, detect only | 4.9 | 4.9 | 0 | 9.0 | 103.4 | 0.3 | 122.9 | 136.9 | 58.9 | 325 / 388 | n/a |

Reading: throughput is about 5/s whatever the thread count, nothing is replaced natively and the native queue time is about 0.2 ms: **the native side is waiting for frames; the limit is the JavaScript side** (pack about 55 ms plus posting a 692 KB string over the bridge, one frame at a time; about 9 frames/s are skipped while one is being packed or posted). Versus the serial path in the same pipeline (2.4 to 2.5/s, frame→result about 380 ms): throughput about doubled, latency down about 30%. The model still runs at 89 ms with 2 threads (hot back-to-back: 63 ms), so the native thread is only partly kept in the fast mode. JPEG encoding on the main thread got slower while the pipeline runs (129 to 213 ms median, p95 up to 429 ms, 3.6 to 4.2 frames/s), competing with packing for the main thread. The difference between S2/S1 and S5/S6 in latency (268 vs 312 to 325 ms) is unexplained; run-to-run variation is not known (single run each).

## JPEG on the main thread vs in a Worker (D-027), pipelined detector, 2 threads, 12 s per window after a 3 s settle

Run 2026-10-24 12:42 to 12:43, phone unlocked, battery 18%, camera 720×1280 portrait (held upright), **no vehicles in view**. Windows alternate main/worker to limit order effects. "main lag" = how late a 20 ms main-thread timer fires (p95 / max, ms; count of lags over 50 ms in the 12 s).

| window | detections/s | frame→result median / p95 ms | JPEG per s | JPEG round trip median / p95 ms | worker encode median ms | infer ms | JS pre ms | bridge ms | main lag p95 / max | lags > 50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W1 detect only, no JPEG | 6.1 | 262.5 / 278.4 | 0 | n/a | n/a | 91.2 | 56.3 | 97.9 | 66.1 / 77.9 | 66 |
| W2 full, JPEG on MAIN thread | 5.1 | 320.7 / 439.6 | 4.1 | 133.1 / 437.3 | n/a | 104.8 | 55.9 | 120.9 | 65.9 / 82.6 | 55 |
| W3 full, JPEG in WORKER | 4.9 | 380.5 / 452.1 | **9.1** | **40.4 / 100.2** | 35.2 | 166.7 | 59.4 | 125.2 | 68.6 / 90.4 | 55 |
| W4 full, JPEG in WORKER | 4.8 | 380.7 / 444.1 | **9.1** | **38.4 / 101.4** | 34.5 | 164.0 | 59.0 | 129.1 | 63.9 / 87.7 | 56 |
| W5 full, JPEG on MAIN thread | 4.7 | 384.8 / 444.8 | 2.9 | 222.6 / 706.6 | n/a | 163.3 | 60.0 | 135.1 | 70.4 / 83.1 | 57 |
| W6 detect only, no JPEG | 4.7 | 377.9 / 438.4 | 0 | n/a | n/a | 164.2 | 62.6 | 128.7 | 70.0 / 91.5 | 57 |

Reading: (1) the worker takes the encoder from 2.9 to 4.1 frames/s (133 to 223 ms median, p95 437 to 707 ms) to **9.1 frames/s at 40 ms (p95 about 100 ms)**, no errors. (2) Detection throughput did not improve: W6 (no JPEG at all) is as slow as W3/W4 (4.7 vs 4.8 to 4.9). (3) The main thread is blocked 60 to 90 ms about once per posted frame in **every** configuration including W1 and W6 (66 lags over 50 ms in 12 s at 5.5 posts/s): that is frame packing, not JPEG. (4) The model run flips between about 90 to 105 ms (W1, W2) and about 165 ms (W3 to W6) with the feed rate at about 5/s; W6 shows the slow mode returning without any JPEG, so it is the idle-gap effect (D-025) again, not the worker. Single run each; the order of windows may matter.

## Frame packing in a worker (D-028): A/B, same pipelined detector, 2 threads, 12 s windows

Run 2026-10-24 12:54 to 12:56, battery 18% on USB, camera 720×1280 (held upright). "main-pack" = packing inside `StreamingDetector.submit` on the main thread; "WORKER-pack" = `FrameProcessor` (one worker: letterbox + RGB + base64, then optionally JPEG), main thread only calls `plugin.submit`. Vehicles in view from P3 on (counts below; the phone was moved).

| window | detections/s | posted/s | skipped/s | frame→result median / p95 ms | JS pre ms | pack in worker ms | model ms | bridge ms | JPEG per s, round trip median / p95 | main lag p95 / max ms | lags > 50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 main-pack, no jpeg | 5.7 | 5.7 | 9.1 | 263.7 / 285 | 55.8 | n/a | 90.5 | 102.9 | 0 | 61.4 / 160.3 | 55 |
| P2 WORKER-pack, no jpeg | 5.2 | 5.2 | 8.8 | 246.4 / 273.1 | 58.4 | 55.4 | 89.7 | 82.8 | 0 | **5.0 / 32.2** | **0** |
| P3 main-pack + JPEG worker + draw | 5.0 | 5.1 | 9.2 | 267.3 / 389 | 54.2 | n/a | 89.9 | 109.9 | 9.7, 28.8 / 84.5 | 66.7 / 98 | 61 |
| P4 WORKER-pack + JPEG + draw | 4.8 | 4.8 | 9.2 | 380.5 / 442.3 | 62.4 | 59.5 | 164.5 | 129.7 | 4.7, 100.8 / 121.1 | **8.0 / 20** | **0** |
| P5 main-pack + JPEG worker + draw | 4.9 | 4.9 | 9.6 | 372.5 / 428.6 | 55.6 | n/a | 164.0 | 128.5 | 9.6, 45.5 / 100.4 | 58.6 / 73 | 53 |
| P6 WORKER-pack + JPEG + draw | 4.7 | 4.7 | 9.2 | 379.1 / 435.1 | 63.9 | 60.7 | 163.1 | 128.8 | 4.8, 97.8 / 117.4 | **8.4 / 18.8** | **0** |
| P7 WORKER-pack, no jpeg | 4.8 | 4.7 | 9.2 | 382.9 / 442.3 | 61.5 | 58.4 | 164.8 | 126.9 | 0 | **5.3 / 15.1** | **0** |

Reading: worker packing removes the main-thread stalls completely (p95 lag 58 to 67 ms → 5 to 8 ms; 53 to 61 stalls over 50 ms per window → 0). It does **not** raise throughput (about 5 detections/s in both). The packing itself is no faster in the worker (55 to 60 ms), and JPEG after packing in the same worker lowers the JPEG rate to 4.7/s (about 100 ms round trip, because it runs after the pack in a sequential job; main-pack + JPEG worker reaches 9.6/s). The model is fast (90 ms) in P1 to P3 and slow (164 ms) from P4 on whatever the configuration (see the thermal data below).

## Drift test: one detector, same configuration, 12 consecutive 10 s windows, with the submit-acknowledgement time (D-028)

WORKER-pack, no JPEG. Run 1 (13:00, started cool; battery temp 35.1 °C): D01 7.4 detections/s (model 92 ms, pack 36 ms, **submit acknowledgement 74 ms**, frame→result 245 / 255 ms); D02 6.9/s (model 95, pack 34, ack 74); then from D03 on **4.8 to 5.0/s, model 163 to 167 ms, pack 54 to 57 ms, ack 112 to 117 ms, frame→result 374 to 385 ms median (p95 418 to 438)**, unchanged through D12 and after a re-init (D13). Main lag p95 4.4 to 8.7 ms throughout. Run 2 (13:08, started immediately after run 1, phone still hot): slow from the very first window (D01 5.2/s, model 165 ms, ack 115 ms) and flat for all 13 windows.

The feed is serial: a frame is packed (35 to 55 ms), then posted (acknowledged after 74 to 115 ms, mostly moving the 692 KB base64 string through the Capacitor bridge), and the next frame is only packed after that; so the feed is about 1 / (pack + ack + wait for the next camera frame) = 7.4/s when fast and 4.9/s when slow. The native queue time is about 0.1 to 0.8 ms: the native side waits for frames.

## Live CPU state during the run (sysfs, `adb shell`, sampled every 4 to 7 s; 13:08 to 13:11)

- **CPU frequency caps are active while the pipeline runs and lift when it ends.** t = 5 to 87 s: little cores (0 to 3) capped at 1324 MHz (hardware max 1766), big cores (4 to 7) capped at 1459 MHz (hardware max 2803); t = 94 to 136 s: big cap 2323 MHz; t = 143 s onward (probe finished, CPU die temperature falling from 55 to 49 then 45 °C): caps back to 1766 / 2323, then 2803 at t = 182 s.
- **The work ran on the little cores.** In every sample during the run the little cores sat at their capped maximum (1324 MHz, busy) while all four big cores sat at their **minimum 825 MHz (idle)**.
- Temperatures (sysfs `thermal_zone*`): CPU die 52 to 56 °C during the run (53 to 54 °C already at the first sample, 5 s after launch, 5 minutes after the previous run), GPU 46 to 49 °C, `xo-therm-adc` 41 to 46 °C, `quiet-therm-adc` 38 to 40 °C, battery 36 to 37.5 °C. After the run: CPU 43 to 45 °C within 40 s.
- No cooling-device state was readable for most devices (permission denied), so the exact mitigation mechanism is **not identified**; the correlation (caps present while CPU die ≥ about 52 °C and lifted when it fell) is measured, the causal chain is inferred.
- Battery 15 to 18% and the phone was charging over USB during all runs (charging adds heat); screen at normal brightness.

## Cool-start run A (D-029): `tools/device/thermal-run.sh A-cool-62pct-plugged 300 4`, drift probe, 24 windows + re-init

Run 2026-10-24 13:3x. Phone unlocked, **battery 63% on USB** (not the full charge originally planned; the user asked to continue), screen at normal brightness, camera held upright. Raw data: `results/thermal/A-cool-62pct-plugged.{samples.txt,console.log}`. Start state: CPU die 36 to 37 °C at the pre-check, **41 to 43 °C at launch** (the install and process start warmed it a little: slightly above the 40 °C aim), `xo-therm` 35 to 36 °C, battery 32 °C.

| phase | when | detections/s | model ms | pack ms | submit ack ms | frame→result median / p95 ms | big cores | CPU die |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fast | t = 4 to about 118 s (windows D01 to D11) | 6.9 to 7.4 | 89.1 to 90.5 | 30.9 to 36.2 | 71.9 to 75.2 | 234 to 242 / 249 to 295 | busy at their capped 1459 MHz | 55 to 57 °C |
| slow | from about 118 s (windows D12 to D25) | 4.7 to 5.3 | 163.1 to 168.7 | 50.6 to 53.4 | 109.6 to 117.5 | 365 to 377 / 399 to 446 | **idle at 825 MHz** | 52 to 54 °C |

Main-thread lag p95 4.8 to 8.7 ms in every window (the packing worker holds). Re-init (D25) did not restore the fast mode.

Sequence from the samples: t = -2 s caps off (die 43 °C); **t = 4 s caps already on** (little 1324 of 1766 MHz, big 1459 of 2803 MHz; die 51 °C); t = 17 s die 56 °C; big cores at their cap (1416 to 1459 MHz) until t = 115 s; **t = 122 s the big cores are at 825 MHz (idle) and stay so, little cores carry the work at 1324 MHz; caps unchanged**, die falls to 52 to 53 °C; t = 265 s (probe finished) caps lifted to 1766/2803 and the die falls 46 → 43 → 42 °C within 30 s. Battery temperature 32 → 35 °C, `xo-therm` 37 → 44 °C, `quiet-therm` 33 → 38 °C over the run: the heat that matters is the CPU die, and it appears within seconds of the pipeline starting.

Reading: (1) the frequency caps are applied within 4 s of the load starting and do not by themselves explain the step to the slow mode (the fast phase ran under the same caps); (2) the step at about 118 s coincides with the big cluster being taken out of use while the die was still 55 to 57 °C, which looks like a second, time-based mitigation; the earlier hot start had no fast phase at all, a cooler start in the first drift run had about 30 s; so the onset depends on the starting state. (3) Not separated: screen brightness, charging (battery was low and rising), camera ISP. (4) The mitigation rule itself is not identified (cooling-device states are unreadable from the shell).

## Paced run Q (D-029): feed capped at 4 frames/s, otherwise identical to run A

`VITE_SELFTEST=paced`, `thermal-run.sh Q-paced-4ps-63pct-plugged 300 4`, 2026-10-24, battery 63% on USB, start state die 38 °C / `xo-therm` 37 °C (below the 40 °C aim), phone unlocked. Raw: `results/thermal/Q-paced-4ps-63pct-plugged.{samples.txt,console.log}`. One frame per 250 ms is handed to the detector (the others are closed unprocessed).

| phase | when | detections/s | model ms | pack ms | submit ack ms | frame→result median / p95 ms | big cores | CPU die | xo-therm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fast | t = 4 to about 88 s (Q01 to Q08) | 3.5 to 3.7 | 90.0 to 92.4 | 38.9 to 44.5 | 76.5 to 87.0 | 221.6 to 235.9 / 235.3 to 260.7 | 1238 to 1459 MHz (partly busy) | 49 to 56 °C | 40 to 43 °C |
| slow | from about 91 s (Q09 to Q25) | 3.5 to 3.8 | 166.0 to 170.7 | 47.0 to 53.4 | 112.5 to 118.5 | 353.4 to 424.9 / 436.9 to 449.7 | idle at 825 MHz | 50 to 52 °C | 42 to 43 °C |

Caps on from the first sample (little 1324, big 1459 MHz); released at t = 267 s (probe ended), die 45 → 41 °C within 20 s. Main-thread lag p95 3 to 6.5 ms. Compared with run A: die 4 to 5 °C cooler, big cores only partly busy in the fast phase, step **earlier** (91 s against 118 s), same slow-mode numbers. Conclusion: pacing the feed does not prevent the slow mode; the trigger is not the detection duty cycle.

**Correction:** an earlier note (and D-025) concluded the slowdown was "not heat" because `scaling_max_freq` equalled the hardware maximum when checked. That check was taken after the phone had cooled and the live caps are removed then; the conclusion is withdrawn.

No thermal throttling found (earlier note, WITHDRAWN, see the correction above): `scaling_max_freq` equal to hardware maximum, real thermal zones 38.6 to 41.2 °C, battery saver off. `dumpsys thermalservice` returns cached values (identical across hours); do not use it as live data. Its "soc" sensor (type 8) equals the battery percentage, and its status 6 is a low-battery mitigation flag, not a heat reading.
