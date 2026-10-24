# SECURITY_AND_PRIVACY

Status: **viewer server implemented and unit-tested (D-032); not yet reviewed or tested from an iPhone.** Last updated 2026-10-22 (Phase 0).

## 1. Privacy principles

- **Local-only processing:** all detection runs on the rear phone. No cloud inference, no analytics or crash-reporting SDKs, no remote logging. The only network traffic is between the two phones on the hotspot.
- **No cloud video upload.** Capacitor's generated manifest declares `android.permission.INTERNET`, which Android requires for any socket, including the local server and loopback; its presence does not mean cloud use. The app must make no outbound internet connections (verify with a network capture during G2). Do not add other permissions without a documented reason; add `CAMERA` only in M5. **Status 2026-10-24:** `CAMERA` was added for M5 (video only, no `RECORD_AUDIO`; runtime dialog on first use). The merged manifest declares `INTERNET` and `CAMERA` only: `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC`, which `litert-api` adds for Play AI-pack downloads, are removed (D-023), and cleartext is allowed only to `127.0.0.1` / `localhost` (D-021). The camera probe shows frames on the screen only: nothing is recorded or uploaded. A network capture during a run is still to do.
- **No unnecessary recording.** Live frames exist only in memory and are never written to disk by default.
- **Diagnostic recordings** (short clips for replay testing) are an **explicit opt-in toggle**, labelled on screen while active, stored locally in app storage, and deleted automatically after 7 days (proposed) or on demand via a Delete button. They are never uploaded by the app.
- Other road users' faces and number plates can appear in video. If any clip or screenshot is shared outside the devices, blur them first.

## 2. Data retention and deletion

| Data | Where | Retention |
| --- | --- | --- |
| Live frames | memory only | discarded as soon as replaced |
| Detections/tracks | memory; metadata in frames | not stored |
| Operational log (event type, time, state, confidence, fps, temperature) | app-private rotating file | 30 days or 5 MB cap (proposed), whichever first |
| Sensor log (gyro/accel) | app-private file, **only when logging enabled** | 7 days (proposed); delete on demand |
| Diagnostic video clips | app-private storage, **opt-in** | 7 days (proposed); delete on demand |
| Session/ingest tokens | memory only | until restart, revoke or 12 h expiry |

Logs must never contain: images, tokens (not even prefixes), IP/MAC addresses, device identifiers, location, or number plates. Document any deviation here.

## 3. Camera permission handling

- Camera access is requested only from a visible screen after a user tap.
- A persistent on-screen indicator on the rear phone ("camera active") is always shown while capturing; the viewer shows capture status too.
- Denied or revoked permission sets `health.camera = denied` and the system displays UNAVAILABLE; it never silently continues.

## 4. Authentication and sessions

- **Viewer authentication:** 128-bit random session token (`SecureRandom`, base64url) in the QR URL **fragment**; sent in the WebSocket `hello`; constant-time comparison; expires in 12 h (proposed); can be revoked.
- **Separate ingest credential:** a different 128-bit token known only to the WebView via the plugin call. The viewer token cannot publish frames; the ingest token cannot view them. Rationale: any app on the phone can reach `127.0.0.1`.
- **Revocation:** a Revoke button regenerates the viewer token, closes viewer sockets (4410) and refreshes the QR. Ingest token regenerates on server start.
- Maximum 2 viewers; 1 ingest.

## 5. Network exposure

- **Interface binding:** viewer listener only on the hotspot interface address; never `0.0.0.0`, never cellular; no start if no suitable address. Ingest listener only on `127.0.0.1`.
- **WebSocket Origin validation:** `/ws/view` accepts only `Origin: http://<bound-ip>:<port>`; `/ws/ingest` accepts only the Capacitor origin (confirm during E2). This prevents a malicious web page open in the viewer's browser from hijacking the socket.
- **Public exposure:** none. No port forwarding, no tunnelling, no public endpoint. The viewer HTML has no secrets.
- **Hotspot configuration:** WPA2 or WPA3 with a strong random passphrase (≥ 16 characters), a dedicated hotspot used only for this project, no password sharing, hotspot off when not in use; avoid public or shared Wi-Fi.

## 6. Input validation and limits

- Strict message parsing; reject unknown types before auth; size limits: text 16 KiB, binary 600 KiB, `metaLen` ≤ 16 KiB, JPEG ≤ 512 KiB.
- Static file serving uses a fixed allow-list; no directory traversal.
- Rate limits: 5 failed auths per IP per 60 s → 60 s lockout; 10 connection attempts per IP per minute; 20 viewer messages per second.
- Queue limits: `bufferedAmount` cap 256 KiB; per-viewer one-slot buffer, 2 unacked frames (see `PROTOCOL_SPEC.md`).

## 7. Plain-HTTP risks (acknowledged)

HTTP and `ws://` are **not encrypted**. Anyone who can observe hotspot traffic (another device with the passphrase on a shared-key network, a compromised client, or a malicious access point if the phone joins one) can read video frames and the session token. Mitigations: strong WPA2/WPA3 passphrase, dedicated hotspot, short-lived revocable token, binding and origin checks. The token authenticates a viewer; it does not make the channel confidential or tamper-proof.

## 8. Threat model

| Threat | Likelihood **[A]** | Impact | Controls | Residual risk |
| --- | --- | --- | --- | --- |
| Unauthorised device joins hotspot and views stream | Low if passphrase is strong | Video exposure | Token required, max 2 viewers, lockout | Medium if passphrase leaks |
| Passive sniffing of HTTP | Low–medium | Token and video disclosure | WPA2/3, short token life | **Accepted for prototype** |
| Token guessing | Very low | Viewer access | 128-bit token, lockout, rate limits | Negligible |
| Another app on the phone connects to ingest | Low | Fake frames or alerts injected | Separate ingest token, loopback only, origin check | Low |
| Cross-site WebSocket hijack from a page in the viewer browser | Low | Unauthorised stream access | Origin validation, token in hello | Low |
| Malformed or oversize messages (DoS) | Low | Crash/slow | Limits, validation, rate limits | Low–medium |
| Stale video presented as live | **Medium** | **Misleading driver** | Stale/lost watchdog, bounded queues, UNAVAILABLE states | Reduced, not eliminated |
| Detector miss or false alarm | **High** | Driver misled | Disclaimers; experimental labelling; never "all clear" | **High inherent**; this is not a safety system |
| Battery/thermal failure | Medium | Device damage/shutdown | G4 test, degrade rules, stop criteria | Medium |
| Privacy of bystanders in clips | Medium if recording | Personal data | No recording by default, opt-in clips, auto-delete, blur before sharing | Low–medium |

## 9. Future security improvements (not in the MVP)

HTTPS with a self-signed certificate and a documented trust step; per-session ephemeral keys derived at QR scan; certificate or key pinning; encrypted payload over WebSocket; explicit viewer authorisation prompt on the rear phone; audit of manifest permissions; dependency vulnerability scanning in CI.

## 10. Review checklist before any release outside personal testing

Manifest permissions reviewed; no secrets in the APK; no logging of tokens; security tests (`TESTING_AND_VALIDATION.md` §9) pass; hotspot guidance given to users; limitations stated in the README.

## 11. Implementation status (2026-10-24)
Implemented and covered by JUnit over loopback sockets: token auth, Origin check (4403), lockout and connect limits, binary-before-auth (4401), hello timeout (4408), version (4426), viewer limit (4430), revoke (4410), ack stall (4440), rate limit (4429), asset allow-list and traversal rejection, no token in the page or `/healthz`. **Changed from the design:** no loopback ingest socket and no ingest token (D-032), which removes the "another app on the phone connects to ingest" threat. **Not done:** HTTPS, QR, an outbound-traffic capture, expiry test over 12 h. The viewer URL (with token) is shown on the rear screen and in no log; device-test builds log only counters.

## 12. Change 2026-10-24 (D-037): long-lived, remembered viewer token
The viewer token now survives app restarts (30 days after each server start, until "Revoke viewer access") and is stored in the rear phone's app-private preferences and in the iPhone browser's localStorage, so the address can stay constant. This raises the value of a leaked token and lowers the effort for the user; revoke after sharing a link or losing a phone. Plain HTTP unchanged (token visible to a hotspot sniffer).

## 13. Change 2026-10-24 (D-040): automatic start and a name responder
The rear app starts the camera by itself when opened (default on, can be turned off), which departs from "camera only after a tap" in section 3; the visible preview remains. The manifest gains CHANGE_WIFI_MULTICAST_STATE (normal permission) for the rearview.local responder, which answers only queries for that one name and sends nothing else; the responder discloses the phone's IPv4 address to devices on the same network, which already see the server.
