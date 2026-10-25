# An old Android phone as a rear-view assistant (open-source, experimental)

> **This is a research prototype, not a safety system.** It is not certified, not validated, and it misses things. Do not rely on it for driving decisions. A missing warning does not mean the road is clear, and the app never says so.

I took an old Android phone, stuck it in the rear window, and made it do three things on its own: watch what is behind the car with a small neural network, decide whether something is close or coming closer, and stream the picture with boxes and alerts over its own Wi-Fi hotspot to an iPhone in the cabin. No cloud, no account, no app to install on the iPhone (it is a web page in Safari).

It started as a question: how much of a "rear-vehicle approach warning" can an old phone do, locally, with no special hardware? This repo is the answer so far, with the numbers and the failures written down.

## What it does today

- **Rear phone (Android, Capacitor app):** camera, then a YOLOX-nano detector (LiteRT, CPU), then a tracker, then an alert logic. The same phone runs a small HTTP and WebSocket server.
- **Viewer (any browser, tested on iPhone Safari):** live video with boxes, a status headline, a red pulsing outline for urgent alerts, a mirror (rear-view-mirror) option, a video-only full-screen mode, and beeps that speed up as something gets closer, panned to the side it is on.
- **Alerts:** vehicle nearby, possible approach (a bounding-box growth trend, nothing more), vehicle very close, person close behind, and "detection unavailable". Stale or lost feeds and unhealthy cameras or detectors show as unavailable, never as "all clear".
- **Connecting:** scan a QR code once; after that the iPhone just opens the address (the key is remembered). The rear app starts by itself when opened. A `rearview.local` name is announced as a best effort.
- **Distance:** an approximate "about N m" derived from box size and typical vehicle heights, with a calibration panel. It is a rough guide, not a measurement; the phone's proximity sensor is not used.

## How it works (one paragraph)

Camera frames are letterboxed to 416 x 416 and JPEG-packed in a web worker, handed to a native LiteRT detector that always works on the newest frame, then decoded and tracked in TypeScript. A small alert state machine turns tracks into levels with hysteresis. The same frames, boxes and alert state go out over a WebSocket to the viewer, which keeps only the newest frame, acknowledges what it drew, and shows a stale or lost state when the data stops. Thermal throttling is inferred from the model getting slower, and a load controller lowers the feed rate when latency grows.

## What we measured (one OnePlus 6T, USB powered, in a room)

| Setup | Model time | Detections per second | Frame to result (p95) |
| --- | --- | --- | --- |
| No cooling, after about 40 s | 163 to 174 ms | 3.5 to 3.8 | about 260 ms |
| With an attached cooler, 10 minutes, iPhone watching | 90 to 95 ms | 6.4 to 7.5 | 168 to 176 ms |

- Without cooling the phone's CPU speed drops after under a minute; with a cooler it did not in our runs. The cause of the slowdown is not fully identified.
- On the iPhone the viewer showed state LIVE with a frame age of 100 to 200 ms (user-reported, one session).
- 318 TypeScript tests and a Java test suite pass. Decoder behaviour is pinned by a shared golden fixture so the Java and TypeScript decoders cannot drift apart.

## What it cannot do (please read)

- **No ground truth.** We have not scored the alerts against labelled footage. We do not know how often "possible approach" is right.
- **It only knows people, cars, motorcycles, buses and trucks.** Walls, poles, kerbs, bikes, animals and low obstacles raise nothing. Something very close to the lens may leave the picture.
- **Distance is a guess.** Box size depends on the vehicle, the lens and the mount. "Very close" starts at an untuned box size that you are meant to calibrate for your own setup.
- **It cannot tell whether you or the car behind is moving.** Both look the same in the picture. It warns on closeness either way.
- **Heat is the weak point of a phone in a rear window**, and in a hot car it will be worse than in our room tests.
- **Plain HTTP on a local hotspot.** The access key is long-lived and can be read by anyone who can sniff that network. See `docs/SECURITY_AND_PRIVACY.md`.
- Tested on one phone and one iPhone. Hotspot mode and in-car use were only lightly tried. Do not test collision scenarios on public roads.

## Try it

```bash
git clone <this repo>
cd app
npm install
npm test                 # TypeScript tests
npm run build            # builds the rear app and the viewer page
```

Android build and install (Android SDK and JDK needed): `tools/device/build-debug.ps1`, then install the debug APK on the rear phone. Open the app, scan the QR code once with the iPhone camera, and bookmark the address in Safari. `docs/` explains the design, decisions, protocol, tests, and the many things that went wrong along the way.

## Tinkering with other hardware

The phone is one choice, not the design. What is phone-specific is small: the camera source, the native detector and the HTTP server. The rest (tracker, approach and alert logic, the wire protocol in `docs/PROTOCOL_SPEC.md`, and the viewer page) is plain TypeScript or HTML and runs anywhere. Natural experiments:

- **Another Android device** (an old tablet, a cheaper phone, an Android box with a camera): should run the app as it is in principle, but only the OnePlus 6T has been tested.
- **Raspberry Pi 4 or 5 with a camera** (and optionally a Coral USB accelerator): run the TypeScript core in Node, add a camera source (V4L2 or ffmpeg) and a detector (a small ONNX or TFLite runtime), and serve the existing viewer by following the protocol spec. Better cooling and 12 V car power are the attraction.
- **An IP or RTSP camera plus any small computer:** same as above with ffmpeg as the capture source.
- **Microcontroller cameras (ESP32-CAM):** too small to run this detector, but fine as the camera that streams frames to something that does.
- **Real distance:** an ultrasonic, radar or depth sensor next to the camera would give what a single camera cannot.

If you try one of these, please open an issue with your numbers.

## Roadmap (nothing here is promised)

Multiple cameras; sensors (GPS speed, accelerometer, gyro) to tell your own motion from the other vehicle's; a recorded-clip evaluation harness with ground truth; tuned thresholds from real distances; HTTPS; a lighter or better model; a Home-screen-friendly viewer.

## Credits and licences

Detector model: Megvii YOLOX-Nano (Apache-2.0), LiteRT conversion by `litert-community/yolox-nano-litert`. Inference runtime: Google LiteRT (Apache-2.0). App shell: Capacitor (MIT). Tooling: Vite, Vitest, TypeScript. This project was built with substantial help from Claude Code (an AI coding assistant); the decisions, measurements and mistakes are recorded in `docs/TECHNICAL_DECISIONS.md` and `docs/TESTING_AND_VALIDATION.md`. **Licence: Apache-2.0** (see `LICENSE`; third-party attributions are in `NOTICE`).

## Help wanted

Real in-car footage with distances and labels; other phones and thermal results; Safari and iOS versions; a safer way to start the rear app without touching it; and honest reviews of the security design.
