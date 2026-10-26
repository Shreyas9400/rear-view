# Install and first run

> **Experimental research prototype, not a safety system.** Read the warnings in the [README](../README.md) first. Do not test collision scenarios on public roads.

You need two devices on the same local network: a **rear Android phone** that films, detects and serves, and a **viewer** (an iPhone in Safari was tested; any modern browser should work, but only desktop Chromium was also checked). No internet is needed once the app is built.

## 1. What you need

| Item | Notes |
| --- | --- |
| Rear phone | Android 7.0 or newer (API 24). Tested only on a OnePlus 6T (Snapdragon 845, Android 11). A phone that stays cool matters: see [cooling](#6-mounting-power-and-cooling). |
| Viewer | iPhone with Safari (iOS version of the test phone not recorded) or any browser on the same network. |
| Network | The rear phone's own **Wi-Fi hotspot** (the real in-car setup) or any shared Wi-Fi (easiest for a first test at home). |
| Power | A car charger or USB power for the rear phone. The screen stays on while the app runs. |
| To build the app | Node.js (tested v26.7.0; 20 or newer should work, untested), JDK 17 or 21 (tested 21), Android SDK with platform 36 and build tools. |

## 2. Get the app onto the rear phone

### Option A: the signed pre-release APK (easiest)

Download `rearview-v0.5.1.apk` from the [Releases page](https://github.com/Shreyas9400/rear-view/releases), check its SHA-256 against the value in the release notes, copy it to the phone and open it (allow "install unknown apps" for your file manager or browser when asked). Android and Play Protect may warn that the app is from an unknown source: that is expected for a sideloaded APK. If you previously installed a debug build you made yourself, uninstall it first (different signing key).

### Option B: build it yourself

```bash
git clone https://github.com/Shreyas9400/rear-view.git
cd rear-view/app
npm install
npm run build              # type-checks and builds the rear screen and the viewer page
npx cap sync android       # copies the web build into the Android project

cd android
./gradlew assembleDebug    # Windows: gradlew.bat assembleDebug
```

The APK is `app/android/app/build/outputs/apk/debug/app-debug.apk`. On Windows, `tools/device/build-debug.ps1` does the whole sequence.

Install it, either:

- with USB debugging on and the phone connected: `adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk`, or
- by copying the file to the phone and opening it (allow "install unknown apps" for your file manager or browser when asked).

Notes:

- Gradle needs the Android SDK path: set `ANDROID_HOME`, or put `sdk.dir=...` in `app/android/local.properties` (git-ignored).
- If Gradle fails with "Unable to establish loopback connection", run it from a normal terminal instead of a sandboxed one.
- This is a **debug-signed** build. A debug key belongs to the machine that built it, so an APK built on another machine cannot update this one: uninstall the old app first (its saved settings are lost).

## 3. First run on the rear phone

1. Open **Rear-View Assistant**. Allow the **camera** when Android asks (the app asks for nothing else except network access and a multicast permission for the `rearview.local` name).
2. By default the app **starts by itself** whenever it opens. You will see the live preview, a headline such as "No tracked vehicle", and a viewer address and QR code in the panel. Untick "Start automatically when the app opens" to start by hand with the Start button.
3. Keep the screen on and the app in front. If the app goes to the background, the camera stops and the viewer shows "detection unavailable".

## 4. Connect the viewer

1. Put both devices on the same network. For the in-car setup, switch on the **rear phone's hotspot** and join the iPhone to it. For a first test, any shared Wi-Fi works.
2. Open the app on the rear phone so the address and QR code are showing.
3. **First time only:** scan the QR code with the iPhone camera and open the link in Safari. The page remembers its access key.
4. **After that:** open the plain address shown on the rear screen, for example `http://192.168.43.1:8080/`, or bookmark it in Safari. A `rearview.local` name is announced too, but whether it resolves over the hotspot is untested. A Safari bookmark is better than a Home Screen shortcut, which keeps its own separate storage on iOS and would not see the saved key.
5. The viewer reconnects by itself if the link drops (for example when the iPhone screen locks). If it says **session invalid**, someone used "Revoke viewer access" on the rear phone: scan the new QR code.

The address is plain HTTP on a local network. Anyone on that network who has the address and the key can watch. See [docs/SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md).

## 5. Using the viewer

- **Headline and outline:** green = no tracked vehicle (this never means the road is clear); blue/amber = vehicle behind; red pulsing = possible approach, vehicle very close, or person close; grey and dashed = detection unavailable, feed stale or link lost. An arrow on the left or right edge shows the side.
- **Enable sound:** tap once (iOS requires it). Beeps speed up as the box grows and are panned to the side. A higher tone means a person.
- **Mirror:** on by default, so screen-left is the driver's left like a rear-view mirror. Switch it off if your mount shows it the wrong way round.
- **Full screen:** shows only the video with a small status chip; unavailable or stale feeds still show.
- The status line shows state, frame age, detection rate and the nearest box with an approximate distance.

## 6. Mounting, power and cooling

- Mount the phone firmly behind the rear window, camera facing back, with a clear view. Reflections off the glass hurt detection.
- A phone in a rear window gets hot. Without cooling, our test phone slowed the model by about 70% after under a minute; with an attached cooler it did not in our 10-minute run. Use shade, no case, and a cooler if you can.
- Keep it on a charger, but expect the battery to warm up too.

## 7. Calibrate the alert points (recommended)

The default "very close" alert is a box size, and the right size depends on your camera and mount. With the car parked:

1. Put a car where you want the alert to start, behind the rear phone.
2. On the rear phone open **Distance and alert calibration**.
3. Wait until it lists the car as the nearest vehicle, then tap **Set "very close" to the nearest vehicle now**. Do the same for a person with the person button.
4. Optionally enter a measured distance with **Tell the distance of the nearest vehicle** to scale the "about N m" estimate. Estimates assume a car is 1.5 m tall and are rough.

## 8. Troubleshooting

| What you see | Try |
| --- | --- |
| Rear screen shows "camera error" or a black preview | Allow the camera in Android settings; close other camera apps; reopen the app. |
| Viewer cannot load the address | Same network? Is the address on the rear screen the one you typed? Did the hotspot restart (the address can change; reopen the app and use the QR)? |
| "Session invalid" | Scan the QR code on the rear screen again. |
| The viewer says stale or link lost | The rear app may be in the background or the phone asleep. Bring the app to the front. |
| Slow, few detections per second, phone hot | Cool it down. The rear screen shows "Device speed: throttled (inferred)" when the model has slowed. |
| Too many or too few alerts | Calibrate (section 7). Detection is a small model and misses things, especially dark, distant or partly hidden objects. |

More: [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 9. Run the tests

```bash
cd app && npm test                      # TypeScript tests
cd app/android && ./gradlew testDebugUnitTest   # Java tests (server, decoder)
```

## 10. Uninstall

Remove the app like any other Android app. It stores only its settings (calibration, access key, auto-start choice) in its own private storage and writes no video to disk.
