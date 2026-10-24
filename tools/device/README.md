# Device measurement tools (OnePlus 6T and similar Android phones)

Read-only helpers for the thermal / CPU-cap measurements in `docs/TECHNICAL_DECISIONS.md` D-029. They need `adb` and a phone with USB debugging authorised. They change nothing on the phone (the sampler is pushed to `/data/local/tmp` for the run and removed afterwards).

| File | What it does |
| --- | --- |
| `thermal-sample.sh` | Runs on the phone: one line with each core's current / max / hardware-max frequency (MHz) and key thermal-zone temperatures (°C), all from live sysfs. (`dumpsys thermalservice` is cached and must not be used.) |
| `thermal-run.sh <label> [seconds] [interval]` | On the host: checks the phone is unlocked, samples before launch, launches the app, samples every few seconds, captures the app's console log, samples again after the load ends, then prints a summary. |
| `summarize-thermal.mjs` | Summary table (caps vs hardware maximum, die/GPU/skin temperatures, battery, charger state, first sample with a cap) plus the probe's per-window results. |

## Cool-start protocol (the planned run, see `docs/SESSION_HANDOFF.md`)

Why: all runs so far were on USB charging at 15 to 18% battery with a bright screen, started on a warm phone, so the heat sources are not separated.

1. Charge the phone to 100%, unplug the cable if you can (USB debugging over a cable needs it plugged in; wireless adb is the alternative), turn the screen off, leave it for at least 15 minutes.
2. Build the probe: `cd app && VITE_SELFTEST=drift npm run build && npx cap sync android`, then `gradlew assembleDebug` in a terminal and `adb install -r`.
3. Plug in, unlock, keep the phone awake. Check the **start state** the runner prints: CPU die should be at most about 40 °C and `xo-therm` at most about 37 °C. If it is higher, wait and retry: a start from 53 °C makes the result meaningless.
4. `OUT=./thermal-runs bash tools/device/thermal-run.sh A-cool-full-plugged 300 4`
5. Let it cool to the same start state again (15 minutes or more), set the display brightness to minimum yourself, and repeat as `B-cool-full-plugged-dim`.
6. Optional: the same unplugged over wireless adb, as `C-cool-full-unplugged`.

Read the result as: when does the first frequency cap appear (seconds into the run), how large is the cap, do the big cores take part, how do detections per second and model time follow it, and what changes between A, B and C.

Reference (production app idle, 2026-10-24, battery 17% on USB): CPU die 38 to 41 °C, GPU 38 to 39 °C, `xo-therm` 36 to 37 °C, `quiet-therm` 35 °C, no frequency caps.

Under Git Bash the scripts set `MSYS_NO_PATHCONV=1` so `/data/...` device paths are not rewritten, and convert local paths with `cygpath` for the Windows `adb.exe`/`node.exe`.
