// Summarise a thermal-run: sysfs samples (thermal-sample.sh) next to the probe's per-window results from the console log.
// usage: node summarize-thermal.mjs <samples.txt> [console.log]
import { readFileSync } from 'node:fs';

const [samplesFile, consoleFile] = process.argv.slice(2);
if (!samplesFile) {
  console.error('usage: node summarize-thermal.mjs <samples.txt> [console.log]');
  process.exit(2);
}

const rows = [];
for (const line of readFileSync(samplesFile, 'utf8').split('\n')) {
  const m = /^t=(-?\d+)s (.*)$/.exec(line.trim());
  if (!m) continue;
  const r = { t: Number(m[1]), cores: [], z: {}, batt: null, battTemp: null, status: '' };
  for (const tok of m[2].split(/\s+/)) {
    let x;
    if ((x = /^c(\d)=(\d+)\/(\d+)\/(\d+)$/.exec(tok))) r.cores[Number(x[1])] = { cur: +x[2], max: +x[3], hw: +x[4] };
    else if ((x = /^([a-z0-9-]+)=(-?\d+)$/.exec(tok)) && !tok.startsWith('batt')) r.z[x[1]] = +x[2];
    else if ((x = /^batt=(\d+)$/.exec(tok))) r.batt = +x[1];
    else if ((x = /^batt_temp=(-?\d+)$/.exec(tok))) r.battTemp = +x[1];
    else if ((x = /^status=(.+)$/.exec(tok))) r.status = x[1];
  }
  if (r.cores.length === 8) rows.push(r);
}
if (!rows.length) {
  console.error('no samples parsed');
  process.exit(1);
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (v, w = 6) => String(Number.isFinite(v) ? Math.round(v) : '-').padStart(w);
console.log('t(s)   littleCap/hw  bigCap/hw   littleCur  bigCur   cpuDie  gpu  xo  quiet  batt%  battC  status');
let firstCap = null;
for (const r of rows) {
  const little = r.cores.slice(0, 4);
  const big = r.cores.slice(4, 8);
  const lc = Math.min(...little.map((c) => c.max));
  const bc = Math.min(...big.map((c) => c.max));
  const capped = lc < little[0].hw || bc < big[0].hw;
  if (capped && firstCap === null) firstCap = r.t;
  const die = Math.max(r.z['cpu0-silver-usr'] ?? 0, r.z['cpu3-gold-usr'] ?? 0, r.z['cpu7-gold-usr'] ?? 0);
  console.log(
    String(r.t).padStart(4), ' ',
    `${f(lc, 5)}/${f(little[0].hw, 4)}`, ' ',
    `${f(bc, 5)}/${f(big[0].hw, 4)}`, ' ',
    f(avg(little.map((c) => c.cur)), 7), ' ', f(avg(big.map((c) => c.cur)), 7), ' ',
    f(die, 6), f(r.z['gpu0-usr'], 5), f(r.z['xo-therm-adc'], 4), f(r.z['quiet-therm-adc'], 6),
    f(r.batt, 6), f(r.battTemp, 6), ' ', r.status,
  );
}
console.log(firstCap === null ? '\nNo frequency cap seen in any sample.' : `\nFirst sample with a frequency cap below the hardware maximum: t=${firstCap}s.`);
const cold = rows[0];
console.log(`Start state: cpu die ${Math.max(cold.z['cpu0-silver-usr'] ?? 0, cold.z['cpu3-gold-usr'] ?? 0)} C, battery ${cold.batt}% ${cold.status}, battery temp ${cold.battTemp} C.`);

if (consoleFile) {
  const wins = [];
  for (const line of readFileSync(consoleFile, 'utf8').split('\n')) {
    const i = line.indexOf('SELFTEST_CAM_STREAM_WINDOW ');
    if (i < 0) continue;
    try {
      wins.push(JSON.parse(line.slice(i + 'SELFTEST_CAM_STREAM_WINDOW '.length)));
    } catch {
      /* truncated line */
    }
  }
  if (wins.length) {
    console.log('\nprobe windows:');
    console.log('window               det/s  model ms  pack ms  ack ms  frame->result med/p95  main lag p95');
    for (const w of wins) {
      console.log(
        String(w.name).padEnd(20), f(w.detectionsPerSec * 10, 5) === '-' ? '' : String(w.detectionsPerSec).padStart(5),
        String(w.inferMs).padStart(9), String(w.packWorkerMs).padStart(8), String(w.postAckMs).padStart(7),
        `${w.frameToResultMs.median}/${w.frameToResultMs.p95}`.padStart(22), String(w.mainThreadLagMs.p95).padStart(13),
      );
    }
  }
}
