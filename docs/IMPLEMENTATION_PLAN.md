# IMPLEMENTATION_PLAN

Status: **M3 and M8 meet their acceptance criteria on synthetic tests; M2 is partly verified (web build/tests pass, APK/CI unverified); all hardware milestones NOT_STARTED.** Last updated 2026-10-22. Milestone completion is recorded only after evidence is entered in `TESTING_AND_VALIDATION.md` and `SESSION_HANDOFF.md`.

Status vocabulary: `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_UNTESTED`, `TESTED`, `BLOCKED`, `DOCUMENTED_AWAITING_REVIEW` (Phase 0 only).

## 1. Principles

- Small, independently verifiable milestones. Each has acceptance criteria, tests and an evidence requirement.
- Estimated engineering time (`Est.`) is a planning figure **[A]**, written before work. **Measured elapsed time** is recorded after work in the `Measured` column; never overwrite an estimate with a measurement.
- Gates G0–G4 and the inference/streaming/thermal fallbacks are preserved (§4, §5).
- The first 6 hours decide the inference runtime (decision DP1). Do not build downstream of an unproven runtime.

## 2. Milestone overview

| ID | Milestone | Status | Needs phone? | Est. (h) | Measured (h) | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| M0 | Phase 0 documentation | DOCUMENTED_AWAITING_REVIEW | No | 3 | — | Phase 0 acceptance |
| M1 | Device inventory | NOT_STARTED | **Yes** | 1–2 | — | **G0** |
| M2 | Repo scaffold, CI debug APK | IMPLEMENTED_UNTESTED (web build + tests pass; APK and CI not verified) | No (APK install needs phone) | 2–3 | — | — |
| M3 | Pure core: types, letterbox, decode, NMS | TESTED (synthetic; real-model golden vectors wait for M4) | No | 3 | — | — |
| M4 | Inference runtime experiment E1 | TESTED for LiteRT.js (2026-10-24): Chrome WASM+threads 4.72/s but WebView only 1.33/s, WebGPU unavailable, threads impossible in the WebView. **DP1 decided: Plan B (native LiteRT), D-022**; native CPU measured the same day at 10 to 34 inferences/s (19/s at 2 threads), so M4 acceptance for CPU is met; GPU untested (needs `litert-gpu`, D-023) | **Yes** | 1–3 | — | **DP1** |
| M5 | Capacitor probe E2 | TESTED on the OnePlus 6T 2026-10-24 (camera permission flow, `getUserMedia` 720p@15, devicemotion 57 Hz, secure context, loopback cleartext all measured; low-light, other resolutions, denial path not tested) | **Yes** | 2 | — | — |
| M6 | Server + hotspot probe E3 | NOT_STARTED | **Yes** (+iPhone) | 3 | — | — |
| M7 | Camera + inference + overlay in app | IN_PROGRESS (2026-10-24: native detector plugin D-024 and `WebViewCameraSource` built; live camera → detector → overlay works on the phone, the serial detector gave only 2.4 to 2.5 detections/s (idle-gap slowdown, D-025), the **pipelined detector D-026 reaches 4.7 to 5.5/s with p95 frame-to-result about 285 ms, meeting the G1 throughput and latency targets in a single run**; G1 is not closed: no 10-minute run, no vehicles-in-view check, JPEG at 3.6 to 4.2/s; scheduler and HealthMonitor NOT_STARTED). **Update D-030: with the compact JPEG payload the slow-state p95 frame-to-result is 295 to 313 ms (target 400 ms met) at 5.6 detections/s in a single run with no vehicles in view; quality with vehicles in view and the 10-minute G1 run remain open.** | **Yes** | 6–8 | — | **G1** |
| M8 | Tracker, approach estimator, alert state machine | TESTED (synthetic; thresholds are placeholders until G3) | No | 5 | — | — |
| M9 | LocalServer plugin, protocol, viewer, QR | NOT_STARTED | **Yes** (+iPhone) | 8–10 | — | **G2** |
| M10 | Sensor logger, diagnostics, replay harness | NOT_STARTED | Partly | 4 | — | — |
| M11 | Recorded-clip evaluation | NOT_STARTED | Clips need a camera | 4–6 | — | **G3** |
| M12 | 30-min thermal/power test, README limits, demo | NOT_STARTED | **Yes** | 4–6 | — | **G4** |

Total is not additive to 48 h because M3/M8/M10 run in parallel with hardware work. Plan B (native inference) adds 8–12 h **[A]**.

**Can proceed without the phone:** M2 (scaffold, CI), M3, M8, parts of M10 (harness on fixtures), documentation. **Blocked until hardware is available:** M1, M4–M7, M9 acceptance, M11 clip capture (if using the rear phone), M12.

## 3. Milestone details

### M1 — Device inventory (G0)
- **Objective:** Fill `DEVICE_COMPATIBILITY.md` with real values.
- **Files:** `docs/DEVICE_COMPATIBILITY.md`, optionally `docs/evidence/device-<date>.txt`.
- **Dependencies:** physical phone; optionally USB + `adb`.
- **Steps:** follow the collection procedures in `DEVICE_COMPATIBILITY.md`; record WebView version, `navigator.gpu` later in M5.
- **Acceptance:** every field is a real value or an explicit `UNKNOWN` with a reason; decisions listed in `DEVICE_COMPATIBILITY.md` §Decisions can be made.
- **Tests:** none (inventory). **Evidence:** raw command output saved under `docs/evidence/`.
- **Fallback:** if `adb` is unavailable, use on-device info apps and Chrome `chrome://version`; mark confidence.
- **Hardware:** required.

### M2 — Repo scaffold and CI build
- **Objective:** Buildable skeleton (Vite + TypeScript + Capacitor Android) and a GitHub Actions workflow producing a debug APK.
- **Files:** `app/package.json`, `tsconfig.json`, `vite.config.ts`, `capacitor.config.ts`, `app/src/main.ts`, `.github/workflows/android-debug.yml`, `.gitignore`.
- **Dependencies:** npm, JDK, Android SDK in CI. **Requires explicit user approval before installing dependencies and before any push** (see `CLAUDE.md`).
- **Steps:** init project; add Capacitor Android; add Vitest; add workflow; document build commands in README.
- **Acceptance:** `npm run build` and `npm test` pass locally; CI produces an APK artifact; APK installs on the phone (hardware).
- **Tests:** build; empty-suite test run. **Evidence:** CI run link, APK size.
- **Fallback:** build locally with Android Studio; if all Android builds fail, run M3/M4 as plain web pages.
- **Hardware:** not for build; yes for install.

### M3 — Pure core: types, letterbox, decode, NMS
- **Objective:** Normative types and the model pre/post-processing as pure functions.
- **Files:** `app/src/shared/types.ts`, `app/src/shared/protocol.ts`, `app/src/core/letterbox.ts`, `app/src/core/decode.ts`, `app/tests/decode.test.ts`.
- **Steps:** implement `letterbox416`, `decodeYoloxRaw`, per-class NMS; class filter (COCO 2, 3, 5, 7); coordinate normalisation.
- **Acceptance:** unit tests pass on hand-built tensors incl. golden vectors derived from the model card's formulas; boxes inside [0,1]; deterministic.
- **Tests:** `TESTING_AND_VALIDATION.md` §1–2. **Evidence:** test output.
- **Fallback:** none needed (pure). **Hardware:** no. Real-model golden vectors need M4.

### M4 — Inference runtime experiment E1 → decision DP1
- **Objective:** Determine whether the model runs on the phone via LiteRT.js and at what rate.
- **Files:** `app/experiments/e1-litert/` (throwaway page; not production), results in `docs/DEVICE_COMPATIBILITY.md` matrix.
- **Dependencies:** model file (download requires explicit approval, Apache-2.0 per HF card), `@litertjs/core`.
- **Steps:** (1) desktop Chrome: load model on `webgpu` and `wasm`; print I/O shapes, ms per inference; (2) phone Chrome, served from the laptop over LAN; (3) record success/failure and error text.
- **Acceptance:** for each accelerator: LOADS / FAILS (error recorded), output shape `[1,3549,85]` confirmed, median and p95 ms over ≥100 runs, correctness spot-check against a reference image.
- **Decision DP1 (hour 6):** Plan A if ≥ 3 inferences/s median on phone with a working accelerator; else Plan B (native LiteRT) if the phone's GPU delegate works; else Plan C (CPU-friendly model, to be verified first).
- **Fallback:** §5. **Hardware:** required for the decision (a desktop pass proves nothing about Android).

### M5 — Capacitor probe E2
- **Objective:** Confirm WebView capabilities.
- **Files:** `app/experiments/e2-probe/` or a probe screen in the app.
- **Steps:** log WebView version, `navigator.gpu`, `getUserMedia` 720p success and achieved fps (also dim light), `devicemotion` rate, `https://localhost` secure-context status, mixed-content behaviour for `ws://127.0.0.1`.
- **Acceptance:** values recorded in `DEVICE_COMPATIBILITY.md`; camera permission flow works or the failure is recorded.
- **Fallback:** runtime-permission handling in the plugin; if still refused, CameraX capture in the plugin (+6–10 h). **Hardware:** required.

### M6 — Server and hotspot probe E3
- **Objective:** Prove an iPhone can reach a server on the rear phone, offline.
- **Files:** `app/android/.../LocalServerPlugin.kt` (skeleton), static test page.
- **Steps:** static page + echo WebSocket; test rear-hosted hotspot (preferred) and iPhone-hosted; cellular off on both; record gateway IP, reachability, client isolation.
- **Acceptance:** iPhone Safari loads the page and echo works with no internet; chosen host layout recorded in `TECHNICAL_DECISIONS.md` (D-003).
- **Fallback:** swap hotspot host; NanoHTTPD if Ktor does not build; metadata-only fallback. **Hardware:** phone + iPhone.

### M7 — Camera + inference + overlay in app (G1)
- **Objective:** Live capture, detection and on-screen boxes on the rear phone.
- **Files:** `app/src/capture/*`, `app/src/inference/*`, `app/src/ui/rearScreen.ts`, `app/src/health/healthMonitor.ts`.
- **Steps:** CameraSource, Detector (chosen runtime), latest-frame-wins scheduling, overlay, metrics HUD (inferences/s, p95, drops, memory, battery temperature if available).
- **Acceptance (G1, proposed targets):** 10 min continuous, median ≥ 3 inferences/s (feasibility threshold only), p95 < 400 ms, dropped capture frames < 5 %, memory growth < 50 MB, temperature reported and stable.
- **Tests:** on-device run; log saved. **Fallback:** Plan B/C (§5). **Hardware:** required.

### M8 — Tracker, approach estimator, alert state machine
- **Objective:** Pure logic with full unit tests.
- **Files:** `app/src/core/tracker.ts`, `approach.ts`, `alert.ts`, tests and fixtures.
- **Acceptance:** all transition and synthetic-sequence tests pass; health override verified; placeholder thresholds documented as such.
- **Hardware:** no. **Fallback:** simplify approach to a growth flag.

### M9 — LocalServer plugin, protocol, viewer, QR (G2)
- **Objective:** Implement `PROTOCOL_SPEC.md`.
- **Files:** Kotlin plugin, `app/src/plugins/localServer.ts`, `app/src/stream/*`, `app/src/viewer/*`, `app/src/ui/qr.ts`, protocol tests.
- **Acceptance (G2, proposed targets):** iPhone connects via QR, offline; capture-to-display median < 500 ms, p95 < 1 s; "FEED STALE" within 1.5 s of forced stall; reconnect < 10 s; bounded lag under throttling; wrong token rejected; security tests pass.
- **Fallback:** boxes/alerts on the rear screen; metadata-only to iPhone. **Hardware:** phone + iPhone.

### M10 — Sensor logger, diagnostics, replay harness
- **Objective:** Log-only sensors; opt-in diagnostics; laptop replay of recorded detections and `FileVideoSource`.
- **Files:** `app/src/sensors/*`, `tools/replay/*`, `docs` updates.
- **Acceptance:** achieved gyro/accel rate reported; replay reproduces tracker output deterministically from fixtures; no image data in logs.
- **Hardware:** sensors need the phone; harness does not.

### M11 — Recorded-clip evaluation (G3)
- **Objective:** Measure tracking and approach-alert behaviour on labelled clips.
- **Prerequisite:** clips recorded safely (parked, or a passenger driving; never test while driving alone), labelled by timestamp.
- **Acceptance:** per-scenario results (stationary vehicles, overtaking, turns, low light, occlusion) recorded; alert threshold chosen from a sweep; false approach alerts per hour on negative clips reported; no alert while health is not OK.
- **Fallback:** report limited results honestly; do not tune on the test set.

### M12 — Thermal/power test (G4) and demo
- **Objective:** 30-minute stationary test with the power bank and hotspot on; README limitations; supervised stationary demo.
- **Acceptance (G4, proposed):** fps within 20 % of start, no shutdown/thermal kill, charge level not falling. Controlled vehicle testing only if stable and an observer is present.
- **Hardware:** required.

## 4. Gates (proposed targets until measured)

Authoritative numbers live in `TESTING_AND_VALIDATION.md` §Gates. Summary: **G0** inventory recorded; **G1** 10-min camera+inference; **G2** iPhone stream latency and stale-feed; **G3** recorded-clip behaviour; **G4** 30-min stationary power/thermal.

## 5. Decision points and fallbacks (preserved)

Decision points are named DP1–DP6 here; they are distinct from the numbered register entries (D-001 …) in `TECHNICAL_DECISIONS.md`, where their outcomes are recorded.

| Decision | When | Options |
| --- | --- | --- |
| DP1 Inference runtime | After M4 (hour ≈ 6) | **A:** LiteRT.js (WebGPU or WASM). **B:** native Kotlin LiteRT plugin running the same model on GPU (+8–12 h). **C:** CPU-friendly INT8 model; candidates unverified; check format, ops and licence first (+6–10 h) |
| DP2 Hotspot host | After M6 | Rear phone (preferred) or iPhone |
| DP3 Server library | After M1/M6 | Ktor (if minimum API fits) or NanoHTTPD |
| DP4 Streaming degrade | During G2 | Lower resolution/fps/quality; metadata-only; rear-screen-only |
| DP5 Thermal degrade | During G1/G4 | Cap inference to 2–3/s, lower stream rate, dim screen, add airflow; stop if unsafe. **Triggered early (2026-10-24, D-029): the OnePlus 6T caps CPU frequency and moves work to the little cores within about 30 s of the camera pipeline (CPU die 52 to 56 °C); every stage then runs 1.5 to 1.8× slower. G1 targets must be shown in that state; build a thermally aware load controller (live sysfs temperatures if readable by the app, else latency-based).** |
| DP6 Android build | M2 | CI debug APK → local Android Studio → plain-web detector demo |

If no detector works, ship the stream and UI with "detection unavailable" shown and stop; do not fake detections.

## 6. Cut list (do not build without a documented decision)

WebRTC, SAM/segmentation, metric distance, cloud services, databases, gyro-based fusion, re-identification, recording by default.
