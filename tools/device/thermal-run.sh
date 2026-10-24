#!/usr/bin/env bash
# Host-side runner: launch the app on the phone, sample sysfs every few seconds, capture the app's console log, summarise.
#   tools/device/thermal-run.sh <label> [seconds=170] [interval=4]
# Env: ADB (default: $ANDROID_HOME/platform-tools/adb), OUT (default: ./thermal-runs).
# The phone must be UNLOCKED and awake (Android refuses camera access from the background; the PIN is the user's to enter).
# Build the app with the probe you want first (e.g. VITE_SELFTEST=drift), see docs/SESSION_HANDOFF.md.
set -euo pipefail
label="${1:?usage: thermal-run.sh <label> [seconds] [interval]}"
secs="${2:-170}"
every="${3:-4}"
ADB="${ADB:-${ANDROID_HOME:-/d/Android/Sdk}/platform-tools/adb.exe}"
OUT="${OUT:-./thermal-runs}"
here="$(cd "$(dirname "$0")" && pwd)"
# adb.exe and node.exe are Windows programs and need Windows-style local paths; the device paths (/data/...) must NOT be
# rewritten by Git Bash, hence MSYS_NO_PATHCONV and explicit conversion of the local paths.
export MSYS_NO_PATHCONV=1
hereW="$(cygpath -m "$here" 2>/dev/null || echo "$here")"
mkdir -p "$OUT"
samples="$OUT/$label.samples.txt"
console="$OUT/$label.console.log"
CR=$'\r'

battline() {
  "$ADB" shell dumpsys battery | tr -d "$CR" \
    | awk '/level:/{l=$2} /temperature:/{t=$2} /USB powered:/{u=$3} /AC powered:/{a=$3} END{printf "batt=%s batt_temp=%d status=usb:%s/ac:%s", l, t/10, u, a}'
}
sample() { # $1 = seconds since launch
  echo "t=$1s $("$ADB" shell "sh /data/local/tmp/thermal-sample.sh" | tr -d "$CR") $(battline)"
}

"$ADB" push "$hereW/thermal-sample.sh" /data/local/tmp/thermal-sample.sh >/dev/null
LOGPID=""
cleanup() {
  "$ADB" shell rm -f /data/local/tmp/thermal-sample.sh >/dev/null 2>&1 || true
  if [ -n "$LOGPID" ]; then kill "$LOGPID" 2>/dev/null || true; fi
}
trap cleanup EXIT

kg=$("$ADB" shell dumpsys window 2>/dev/null | tr -d "$CR" | grep -o 'isKeyguardShowing=[a-z]*' | head -1)
if [ "$kg" != "isKeyguardShowing=false" ]; then echo "phone is locked or asleep ($kg): unlock it and retry" >&2; exit 2; fi

echo "# label=$label start=$(date -Iseconds) interval=${every}s" > "$samples"
sample -2 >> "$samples"   # before launch: the cool-start state
"$ADB" logcat -c
( "$ADB" logcat -v time -s "Capacitor/Console:I" > "$console" 2>&1 ) & LOGPID=$!
"$ADB" shell am force-stop app.smartrearview.rearcam
"$ADB" shell am start -n app.smartrearview.rearcam/.MainActivity >/dev/null
t0=$(date +%s)
while [ $(( $(date +%s) - t0 )) -lt "$secs" ]; do
  sleep "$every"
  sample $(( $(date +%s) - t0 )) >> "$samples"
done
sleep 15   # let the probe finish and the load end, so the release of the caps is recorded too
sample $(( $(date +%s) - t0 )) >> "$samples"
kill "$LOGPID" 2>/dev/null || true
LOGPID=""
# keep only the probe's own lines: the raw capture also holds LiteRT's chatter (hundreds of KB)
grep -aE "SELFTEST_|PRODUCT_STATUS" "$console" > "$console.tmp" && mv "$console.tmp" "$console"
node "$hereW/summarize-thermal.mjs" "$samples" "$console"
