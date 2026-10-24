# PROTOCOL_SPEC

Status: **viewer protocol implemented (D-032); no ingest listener (superseded: the app publishes through plugin calls).** Originally proposed: Version 1. Last updated 2026-10-22 (Phase 0). Numeric limits marked *(proposed)* are starting values to be confirmed in G2.

> **Plain HTTP and `ws://` do not encrypt traffic.** Anyone who can observe the hotspot traffic can read frames and the session token. The token authenticates, it does not protect confidentiality. See `SECURITY_AND_PRIVACY.md`.

## 1. Overview and versioning

> **Implementation note (D-032):** only the viewer listener exists. The ingest listener, `ingest_hello`/`ingest_welcome`, `ingestToken` and `/ws/ingest` below are **not implemented**; the rear app calls `publishFrame`/`publishRearStatus` on the LocalServer plugin instead. `status` nests the rear fields under `rear`. Static assets are served from `viewer.html` and `assets/*` (hashed file names), not fixed `/viewer.js`/`/viewer.css`.

- Two listeners run inside the Kotlin `LocalServer` plugin on the rear phone:
  - **Viewer listener** — HTTP + WebSocket for the iPhone. Default port `8080`.
  - **Ingest listener** — WebSocket only, for the app's own WebView. Default port `8081`.
- Protocol major version `v = 1`. JSON messages carry `"v":1`. Binary frames carry the magic `RVF1`.
- Compatibility: adding optional fields is compatible within a version; receivers must ignore unknown fields. Removing/renaming/retyping a field, or changing the binary layout, requires a new major version (`v:2`, magic `RVF2`) and a decision-register entry. A `hello` with an unsupported `v` is answered with close code 4426 and `supported:[1]`.

## 2. Network interface binding

- Viewer listener binds **only** to the hotspot interface IPv4 address chosen by the plugin (never `0.0.0.0`, never the cellular interface). If no hotspot/Wi-Fi address exists, the viewer listener does **not** start and the rear UI shows "no network". A debug flag for `0.0.0.0` may exist but is off by default and must be shown in the UI when on.
- Ingest listener binds to `127.0.0.1` only.
- The plugin re-enumerates interfaces on network change; if the address changes, it restarts the viewer listener, revokes the session and regenerates the QR.
- IP discovery: enumerate `NetworkInterface`s, select the hotspot/Wi-Fi interface; display candidates in the rear UI. Hotspot gateway addresses vary by OEM **[Q]**; never hard-code.

## 3. HTTP routes (viewer listener)

| Method and path | Auth | Response |
| --- | --- | --- |
| `GET /` | none | `viewer.html` (no secrets inside), `Cache-Control: no-store` |
| `GET /viewer.js`, `GET /viewer.css` | none | Bundled static assets (fixed allow-list only; no directory serving) |
| `GET /healthz` | none | `{"ok":true,"v":1}` |
| any other path | — | `404` |
| non-GET/HEAD methods | — | `405` |

The viewer page needs no token to load; it reads the token from the URL fragment and sends it in the WebSocket `hello`. The fragment is not transmitted in HTTP requests. No endpoint other than the WebSocket exposes video, detections or status.

## 4. WebSocket endpoints and authentication

| Endpoint | Listener | Client | First message | Origin check |
| --- | --- | --- | --- | --- |
| `/ws/view` | viewer | iPhone Safari | `hello` within 3 s | `Origin` must equal `http://<bound-ip>:<port>`; missing/other → close 4403 |
| `/ws/ingest` | ingest (loopback) | app WebView | `ingest_hello` within 3 s | `Origin` must equal the Capacitor origin (`https://localhost`, **[Q]** confirm in E2); other → close 4403 |

**Tokens.**
- `sessionToken` (viewer): 16 bytes from `SecureRandom`, base64url (22 chars). Created at plugin `start()` and at `revokeSession()`. Held in memory only. Expires after 12 h (proposed) → close 4411.
- `ingestToken`: separate 16-byte random value returned only to the WebView through the plugin call. Rationale: any app on the phone can reach loopback.
- Comparison is constant-time. Tokens are never logged (not even prefixes) and never sent over HTTP paths or query strings.
- **Revocation:** `revokeSession()` generates a new `sessionToken`, closes all viewer sockets with 4410, and the rear UI shows a new QR. The `ingestToken` is regenerated on `start()` only.
- **QR content:** `http://<ip>:<port>/#t=<sessionToken>`.

**Handshake.** Client opens the socket → sends `hello` (or `ingest_hello`) → server validates origin, version, token, connection limits → replies `welcome` (or closes with a code). Binary frames sent before authentication cause close 4401.

## 5. Messages

All JSON messages: `{"v":1,"type":"<name>", ...}`. UTF-8 text frames, max 16 KiB *(proposed)*.

| `type` | From → to | Fields |
| --- | --- | --- |
| `hello` | viewer → server | `token` (string), `clientId` (random string chosen by viewer), `caps` (`{jpeg:true}`) |
| `welcome` | server → viewer | `sessionId` (random, changes when the server restarts), `serverTimeMs` (rear wall clock, epoch ms), `stream` (`{w,h,targetFps}`), `limits` (`{maxFrameBytes}`), `statusEveryMs` (1000) |
| `ingest_hello` | WebView → server | `token` (ingest token) |
| `ingest_welcome` | server → WebView | `sessionId`, `limits` |
| `rear_status` | WebView → server, 1 Hz | `tEpochMs`, `alert` (`AlertState`), `health` (`HealthFlags`), `captureFps`, `inferFps`, `inferP95Ms`, `droppedCapture`, `droppedBackpressure` |
| `status` | server → viewer, 1 Hz | `serverTimeMs`, `ingest` (`"connected"` or `"disconnected"`), `lastFrameAgeMs` (server clock; `null` if none), `viewers`, plus the latest `rear_status` fields (`alert`, `health`, rates, drops) or `null` if none received for > 2 s |
| `ack` | viewer → server | `seq` (last drawn frame) |
| `ping` | viewer → server | `tClientMs` |
| `pong` | server → viewer | `tClientMs` (echo), `serverTimeMs` |
| `error` | server → client | `code` (number), `msg` (short string); sent before close where possible |

## 6. Types

```ts
export type VehicleClass = 'car' | 'motorcycle' | 'bus' | 'truck';
export interface Box { x: number; y: number; w: number; h: number } // normalised 0..1, top-left origin, relative to the JPEG
export interface Detection { cls: VehicleClass; score: number; box: Box }
export interface TrackSample { tMs: number; cx: number; cy: number; h: number }
export interface Track {
  id: number; cls: VehicleClass; box: Box; score: number;
  state: 'tentative' | 'confirmed' | 'lost';
  ageFrames: number; missedFrames: number; history: TrackSample[]; // history omitted on the wire to the viewer (bounded)
}
export type AlertLevel = 'NORMAL' | 'VEHICLE_NEARBY' | 'POSSIBLE_APPROACH' | 'UNAVAILABLE';
export interface HealthFlags {
  camera: 'ok' | 'stalled' | 'denied' | 'error';
  detector: 'ok' | 'slow' | 'failed';
  sensors: 'ok' | 'missing' | 'off';
  thermal: 'ok' | 'warm' | 'hot' | 'unknown';
}
export interface AlertState { level: AlertLevel; reasons: string[]; trackIds: number[]; tMs: number; health: HealthFlags }
export interface FrameMeta {
  v: 1;
  seq: number;              // uint32, +1 per CAPTURED frame (gaps = dropped frames)
  tCaptureMs: number;       // rear WebView performance.now() at capture (monotonic, same-device deltas only)
  tCaptureEpochMs: number;  // performance.timeOrigin + performance.now() at capture (cross-device latency)
  tEncodeMs: number;        // performance.now() when JPEG finished
  w: number; h: number;     // JPEG pixel size
  jpegQuality: number;
  detSeq: number | null;    // seq of the frame the detections were computed on; null if no detection yet
  detAgeMs: number | null;  // tCaptureMs(this) - tCaptureMs(detSeq frame)
  detections: Detection[];
  tracks: Track[];          // wire form: history stripped
  alert: AlertState;
}
```

Detections lag the picture (inference ≈ 5 per second, video ≈ 8–10 fps). `detSeq`/`detAgeMs` make the lag explicit; the viewer draws the newest boxes and must not present them as belonging to the exact frame.

## 7. Binary frame format (rear → server → viewer)

```
offset  size  field
0       4     magic: ASCII "RVF1"
4       4     metaLen: uint32, big-endian
8       N     meta: UTF-8 JSON FrameMeta (N = metaLen)
8+N     M     JPEG bytes (baseline JPEG), to the end of the message
```

- Limits *(proposed)*: `metaLen` ≤ 16 KiB; JPEG ≤ 512 KiB; total message ≤ 600 KiB. Violations → close 1009 (message too big) or 4400 (malformed).
- The server validates magic, `metaLen` bounds and that `meta.v == 1`, and forwards the **bytes unchanged**.
- Default stream: 640×360, JPEG quality ≈ 0.6, target 8–10 fps (≈ 25–45 KB/frame **[A]**).

## 8. Flow control, queues and backpressure

- **Publisher (WebView):** before each send, if `socket.bufferedAmount` > 256 KiB, drop the frame and increment `droppedBackpressure`. At most one frame encoding at a time.
- **Server, per viewer:** one-slot buffer holding only the newest frame; **credit window of 2 unacknowledged frames**. When credit is available, send the slot's frame; a newer frame replaces an unsent older one. If no `ack` for > 5 s while frames are being offered, close with 4440 (slow/ack timeout).
- **Viewer:** render only the newest received message; ignore any frame with `seq` ≤ last drawn (unless `sessionId` changed); send `ack` after drawing.
- Text messages are never queued behind more than one binary frame (send `status`/`pong` immediately).
- Result: a slow link reduces frame rate; latency stays near two frames plus network.

## 9. Time, ping/pong and clock offset

- `tCaptureMs` (monotonic) is for same-device deltas. `tCaptureEpochMs` and `serverTimeMs` come from the rear phone's wall clock (WebView `timeOrigin + now()` and `System.currentTimeMillis()`), so cross-device age is computable.
- Viewer sends `ping` every 2 s *(proposed)*. Offset estimate: `offset = serverTimeMs − (tSend + tRecv)/2`, keep the sample with the smallest round trip over the last 10. **Frame age at viewer** = `(Date.now() + offset) − tCaptureEpochMs`.
- Wall-clock steps on the rear phone can distort the estimate; ground-truth latency in G2 uses the two-screen photo method (`TESTING_AND_VALIDATION.md`).

## 10. Viewer states (how the viewer distinguishes conditions)

Definitions use `gap` = time since the last binary frame arrived, `msgGap` = time since any message arrived, `age` = offset-corrected frame age, `detAge` = `detAgeMs` plus frame age.

| State | Condition | Viewer behaviour |
| --- | --- | --- |
| **LIVE (healthy)** | `gap` < 500 ms, `age` ≤ 1000 ms, `detAge` ≤ 1500 ms, `health` all `ok`, `ingest = connected` | Draw video and boxes; show alert level; proximity beeping while POSSIBLE_APPROACH (D-035) |
| **DELAYED** | `gap` < 1000 ms and (`gap` ≥ 500 ms or `age` > 1000 ms) | Draw video with a visible "DELAYED n s" banner; alert level shown but marked delayed; no audio cue |
| **STALE** | `gap` ≥ 1000 ms while `msgGap` < 3000 ms (socket alive, no frames) | Freeze-frame dimmed with "FEED STALE"; alert shown as UNAVAILABLE; never show the last alert as current |
| **DISCONNECTED (LOST)** | socket closed, or `msgGap` ≥ 3000 ms | "LINK LOST — reconnecting"; alert UNAVAILABLE; automatic reconnect (§11) |
| **DETECTOR UNAVAILABLE** | `health.detector ≠ ok`, or `health.camera ≠ ok`, or `alert.level = UNAVAILABLE`, or `detAge` > 1500 ms | Video (if any) shown; boxes hidden; "DETECTION UNAVAILABLE"; no all-clear wording |
| **INVALID SESSION** | close code 4401, 4403, 4410 or 4411 | Stop reconnecting; "Session invalid — rescan the QR code on the rear phone" |

Global rules: the `NORMAL` level is displayed as "No tracked vehicle" and a permanent line states "Experimental — not a safety system; no warning does not mean the road is clear". A state change to STALE/LOST/UNAVAILABLE may play a distinct tone after the user has tapped to enable audio.

## 11. Reconnection strategy (viewer)

- On close (other than the invalid-session codes), retry after 0.5 s, 1 s, 2 s, then every 2 s, ±20 % jitter, indefinitely.
- On reconnect: reopen `/ws/view`, send `hello` with the same token (token stays in the URL fragment), reset watchdogs and clock offset, reset the "last drawn seq" if `sessionId` changed.
- If the page was reloaded, the token is read from the fragment again. If the network address changed, the QR must be rescanned.

## 12. Close codes and errors

| Code | Meaning |
| --- | --- |
| 1000 / 1001 | Normal close / server shutting down |
| 1009 | Message too big |
| 4400 | Malformed message or frame |
| 4401 | Invalid or missing token, or binary before auth |
| 4403 | Origin not allowed |
| 4408 | `hello` not received within 3 s |
| 4409 | Ingest already connected (older connection is closed; new one wins — documented behaviour, see note) |
| 4410 | Session revoked |
| 4411 | Session expired |
| 4426 | Unsupported protocol version |
| 4429 | Rate limited or lockout |
| 4430 | Viewer limit reached |
| 4440 | Slow viewer / ack timeout |

Note on 4409: a new authenticated ingest connection replaces the old one (the old one is closed with 4409), so an app restart reconnects cleanly.

## 13. Rate limits and limits *(proposed)*

| Item | Limit |
| --- | --- |
| Failed authentications | 5 per remote IP per 60 s → lockout 60 s, close 4429 |
| New connection attempts | 10 per remote IP per minute |
| Viewer → server messages | 20 per second (`ack` + `ping` + others); excess → close 4429 |
| Viewers | max 2 concurrent (4430 beyond) |
| Ingest connections | 1 (new replaces old) |
| Text message size | 16 KiB |
| Binary message size | 600 KiB; `metaLen` ≤ 16 KiB; JPEG ≤ 512 KiB |
| Unauthenticated socket lifetime | 3 s |
| Server → viewer in-flight | 1 frame sending, credit 2 unacked |

## 14. Illustrative examples

`hello` (viewer → server):
```json
{"v":1,"type":"hello","token":"q3J0u8o2zY9mPpL1hT6VdA","clientId":"c-7f31a9","caps":{"jpeg":true}}
```
`welcome`:
```json
{"v":1,"type":"welcome","sessionId":"s-4b9e12","serverTimeMs":1792670000123,"stream":{"w":640,"h":360,"targetFps":10},"limits":{"maxFrameBytes":524288},"statusEveryMs":1000}
```
Frame `meta` (inside a binary message):
```json
{"v":1,"seq":10432,"tCaptureMs":523401.7,"tCaptureEpochMs":1792670000091.4,"tEncodeMs":523421.0,"w":640,"h":360,"jpegQuality":0.6,
 "detSeq":10430,"detAgeMs":201.5,
 "detections":[{"cls":"car","score":0.71,"box":{"x":0.42,"y":0.38,"w":0.18,"h":0.22}}],
 "tracks":[{"id":7,"cls":"car","box":{"x":0.42,"y":0.38,"w":0.18,"h":0.22},"score":0.71,"state":"confirmed","ageFrames":18,"missedFrames":0}],
 "alert":{"level":"VEHICLE_NEARBY","reasons":["car track 7 confirmed"],"trackIds":[7],"tMs":523400.1,
          "health":{"camera":"ok","detector":"ok","sensors":"missing","thermal":"unknown"}}}
```
`status`:
```json
{"v":1,"type":"status","serverTimeMs":1792670001120,"ingest":"connected","lastFrameAgeMs":95,"viewers":1,
 "alert":{"level":"NORMAL","reasons":[],"trackIds":[],"tMs":524400.0,"health":{"camera":"ok","detector":"ok","sensors":"missing","thermal":"unknown"}},
 "health":{"camera":"ok","detector":"ok","sensors":"missing","thermal":"unknown"},
 "captureFps":14.8,"inferFps":4.6,"inferP95Ms":310,"droppedCapture":12,"droppedBackpressure":0}
```
`error` then close:
```json
{"v":1,"type":"error","code":4401,"msg":"invalid token"}
```
`ack`, `ping`, `pong`:
```json
{"v":1,"type":"ack","seq":10432}
{"v":1,"type":"ping","tClientMs":1792670001000}
{"v":1,"type":"pong","tClientMs":1792670001000,"serverTimeMs":1792670001102}
```

## 15. Required protocol tests

See `TESTING_AND_VALIDATION.md` §Protocol and §Security: handshake success/failure, unauthenticated binary, oversize frames, malformed header, origin mismatch, rate limiting, viewer limit, slow-viewer behaviour (queue never grows), revoke, expiry, reconnect, version mismatch.
