#!/system/bin/sh
# Device-side sampler for the thermal / CPU-cap measurements (docs/TECHNICAL_DECISIONS.md D-029).
# Prints ONE line per call: per-core cur/max/hardware-max frequency in MHz and key thermal zones in degrees C.
# (Battery level, temperature and charger state come from `dumpsys battery` on the host: the battery sysfs files are not
# readable from the shell.) Everything here comes from sysfs, which is live, unlike `dumpsys thermalservice`, which is cached.
# Read-only; changes nothing. Run from the host with tools/device/thermal-run.sh.
o=""
for i in 0 1 2 3 4 5 6 7; do
  d=/sys/devices/system/cpu/cpu$i/cpufreq
  c=$(cat $d/scaling_cur_freq 2>/dev/null); m=$(cat $d/scaling_max_freq 2>/dev/null); h=$(cat $d/cpuinfo_max_freq 2>/dev/null)
  o="$o c$i=$((${c:-0}/1000))/$((${m:-0}/1000))/$((${h:-0}/1000))"
done
for z in /sys/class/thermal/thermal_zone*; do
  n=$(cat $z/type 2>/dev/null)
  case "$n" in
    cpu0-silver-usr|cpu3-gold-usr|cpu7-gold-usr|gpu0-usr|xo-therm-adc|quiet-therm-adc) o="$o $n=$(( $(cat $z/temp 2>/dev/null || echo 0) / 1000 ))";;
  esac
done
echo "$o"
