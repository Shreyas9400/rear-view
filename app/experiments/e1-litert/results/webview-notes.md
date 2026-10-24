# E1 in the Capacitor WebView: raw notes (2026-10-24)

The first WebView run could not POST its report (cleartext to 127.0.0.1 was blocked, see D-021), so its numbers were captured from `adb logcat` (tag `Capacitor/Console`, lines `E1_TRIAL`). They are copied here verbatim. The JSON files in this folder dated `2026-10-24T05-*` are later diagnostic runs (threads trial only) and contain the environment and loopback results.

Device: OnePlus 6T, Android 11. WebView user agent: `Chrome/155.0.8059.43 Mobile Safari/537.36 ... wv` (`com.google.android.webview`; `dumpsys` had shown 148.0.7778.215 on 2026-10-24 earlier, so the provider updated in between, UNVERIFIED which). Page origin `https://localhost`, `isSecureContext` true, `crossOriginIsolated` false, `SharedArrayBuffer` undefined, `navigator.gpu` present but adapter null, JSPI APIs present, 8 hardware threads.

| Trial | Result |
| --- | --- |
| webgpu, webgpu+jspi | fail: "WebGPU was requested but no WebGPU device is set in the environment." |
| wasm (single thread) | loads (wasm 128 ms, compile 243 ms); 100 runs: median 753.3 ms, p95 778.3 ms, max 801.6 ms, 1.33 inferences/s; output `[1,3549,85]`, no NaN; same person hits as in Chrome |
| wasm+jspi | loads; median 750.0 ms, p95 763.1 ms, max 787.7 ms, 1.33/s |
| wasm+threads | fails: `ReferenceError: SharedArrayBuffer is not defined` |

Header experiment: a `BridgeWebViewClient` subclass added `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin` to every Capacitor local-server response. `fetch(location.href)` from the page showed all three headers present, yet `crossOriginIsolated` stayed false. So this WebView delivers the headers but does not enable cross-origin isolation. The class was removed again (MainActivity is back to the stock one-liner).

Note: the page's `main()` ran twice around the app start (a second `env:` line at the moment the first run switched trials); the second run only produced instant failures ("LiteRT is already loading / loaded") and did not overlap a timed trial, so the timings above are not contaminated. Cause of the double start not investigated.

Loopback test (page at `https://localhost` to the laptop through `adb reverse tcp:8099`): with Android's default cleartext policy, `fetch` (cors and no-cors) and `WebSocket` to `127.0.0.1` all failed and the server logged no request. With a network security config allowing cleartext only to `127.0.0.1` and `localhost`, the same calls reached the server, **with `allowMixedContent` left off**. The WebSocket upgrade request arrived; the test server does not implement WebSocket, so a completed WebSocket session is not yet verified.
