// Experiment E1 (docs/IMPLEMENTATION_PLAN.md M4): can LiteRT.js run litert-community/yolox-nano-litert on this device,
// on which accelerator, and how fast? Throwaway probe. Posts a JSON report to the laptop's /log (local only).

import { loadAndCompile, loadLiteRt, Tensor, unloadLiteRt } from '@litertjs/core';
import { decodeYoloxRaw } from '../../src/core/decode';
import { INPUT_SIZE, letterbox416, PAD_VALUE, rgbaToBgrFloat } from '../../src/core/letterbox';

const WARMUP = 5;
const RUNS = 100;
const out = document.getElementById('out') as HTMLPreElement;
const say = (s: string) => {
  out.textContent += '\n' + s;
  console.log(s);
};

interface Trial { name: string; accelerator: 'webgpu' | 'wasm'; jspi: boolean; threads: boolean }
const ALL_TRIALS: Trial[] = [
  { name: 'webgpu+jspi', accelerator: 'webgpu', jspi: true, threads: false },
  { name: 'webgpu', accelerator: 'webgpu', jspi: false, threads: false },
  { name: 'wasm', accelerator: 'wasm', jspi: false, threads: false },
  { name: 'wasm+jspi', accelerator: 'wasm', jspi: true, threads: false },
  { name: 'wasm+threads', accelerator: 'wasm', jspi: false, threads: true },
];
// ?trials=wasm,wasm+threads limits the run (default: all).
const only = new URLSearchParams(location.search).get('trials');
// In the Capacitor WebView (https) default to the quick diagnostics: threads only (the single-thread timings are already recorded).
const TRIALS = only ? ALL_TRIALS.filter((t) => only.split(',').includes(t.name)) : location.protocol === 'https:' ? ALL_TRIALS.filter((t) => t.name === 'wasm+threads') : ALL_TRIALS;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 600);

async function environment() {
  const env: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    href: location.href,
    isSecureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    jspiApis: typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending !== 'undefined',
    navigatorGpu: 'gpu' in navigator,
  };
  // Did the server (or Capacitor's WebViewClient) actually deliver the isolation headers, and does the engine honour them?
  try {
    const h = (await fetch(location.href, { cache: 'no-store' })).headers;
    env.pageHeaders = Object.fromEntries(['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'content-type'].map((k) => [k, h.get(k)]));
  } catch (e) {
    env.pageHeadersError = errText(e);
  }
  // Loopback reachability from this page (server logs every request, so "no log line" means blocked client-side).
  if (location.protocol === 'https:') {
    const net: Record<string, string> = {};
    try { await fetch('http://127.0.0.1:8099/ping-cors'); net.fetchCors = 'ok'; } catch (e) { net.fetchCors = errText(e); }
    try { await fetch('http://127.0.0.1:8099/ping-nocors', { mode: 'no-cors' }); net.fetchNoCors = 'ok (opaque)'; } catch (e) { net.fetchNoCors = errText(e); }
    net.websocket = await new Promise<string>((res) => {
      try {
        const ws = new WebSocket('ws://127.0.0.1:8099/ping-ws');
        const t = setTimeout(() => res('timeout'), 4000);
        ws.onopen = () => { clearTimeout(t); res('open'); ws.close(); };
        ws.onerror = () => { clearTimeout(t); res('error event'); };
      } catch (e) { res('threw: ' + errText(e)); }
    });
    env.loopbackFromHttpsPage = net;
  }
  if ('gpu' in navigator) {
    try {
      const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<any> } }).gpu;
      const ad = await gpu.requestAdapter();
      if (!ad) env.adapter = null;
      else {
        const info = ad.info ?? (ad.requestAdapterInfo ? await ad.requestAdapterInfo() : {});
        env.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
        env.adapterFeatures = [...ad.features].slice(0, 30);
        env.adapterLimits = { maxBufferSize: ad.limits?.maxBufferSize, maxStorageBufferBindingSize: ad.limits?.maxStorageBufferBindingSize };
      }
    } catch (e) {
      env.adapterError = errText(e);
    }
  }
  return env;
}

async function sampleInput(): Promise<{ tensor: Float32Array; lb: ReturnType<typeof letterbox416>; canvas: HTMLCanvasElement }> {
  const img = new Image();
  img.src = './sample.png';
  await img.decode();
  const lb = letterbox416(img.naturalWidth, img.naturalHeight);
  const canvas = document.getElementById('cv') as HTMLCanvasElement;
  canvas.width = canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = `rgb(${PAD_VALUE},${PAD_VALUE},${PAD_VALUE})`;
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(img, 0, 0, lb.newW, lb.newH);
  const rgba = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  return { tensor: rgbaToBgrFloat(rgba), lb, canvas };
}

/** Sanity check only: best anchors over ALL 80 COCO classes (no vehicle filter, no NMS), boxes normalised to the source image. */
function topAnyClass(raw: Float32Array, lb: ReturnType<typeof letterbox416>, n = 8) {
  const rows: { cls: number; score: number; cx: number; cy: number; w: number; h: number }[] = [];
  let base = 0;
  for (const stride of [8, 16, 32]) {
    const g = INPUT_SIZE / stride;
    for (let i = 0; i < g * g; i++) {
      const o = (base + i) * 85;
      let best = 0;
      let bc = 0;
      for (let c = 0; c < 80; c++) {
        const v = raw[o + 5 + c]!;
        if (v > best) { best = v; bc = c; }
      }
      const score = raw[o + 4]! * best;
      if (score < 0.3) continue;
      const gx = i % g;
      const gy = Math.floor(i / g);
      const f = (v: number) => +v.toFixed(3);
      rows.push({
        cls: bc, score: f(score),
        cx: f((((raw[o]! + gx) * stride) / lb.ratio) / lb.srcW), cy: f((((raw[o + 1]! + gy) * stride) / lb.ratio) / lb.srcH),
        w: f(((Math.exp(raw[o + 2]!) * stride) / lb.ratio) / lb.srcW), h: f(((Math.exp(raw[o + 3]!) * stride) / lb.ratio) / lb.srcH),
      });
    }
    base += g * g;
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, n);
}

async function runTrial(t: Trial, input: Float32Array, lb: ReturnType<typeof letterbox416>, canvas: HTMLCanvasElement) {
  const r: Record<string, unknown> = { trial: t.name, accelerator: t.accelerator, jspi: t.jspi, threads: t.threads };
  let model: Awaited<ReturnType<typeof loadAndCompile>> | undefined;
  try {
    unloadLiteRt();
  } catch { /* nothing loaded yet */ }
  try {
    const t0 = performance.now();
    await loadLiteRt('./wasm/', { jspi: t.jspi, threads: t.threads });
    r.wasmLoadMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    model = await loadAndCompile('./models/yolox_nano.tflite', { accelerator: t.accelerator });
    r.compileMs = Math.round(performance.now() - t1);
    r.loads = true;
    r.inputs = model.getInputDetails().map((d) => ({ name: d.name, dtype: String(d.dtype), shape: Array.from(d.shape) }));
    r.outputs = model.getOutputDetails().map((d) => ({ name: d.name, dtype: String(d.dtype), shape: Array.from(d.shape) }));
  } catch (e) {
    r.loads = false;
    r.error = errText(e);
    return r;
  }

  try {
    const once = async () => {
      const tin = new Tensor(input, [1, INPUT_SIZE, INPUT_SIZE, 3]);
      const res = await model!.run(tin);
      const host = await res[0]!.moveTo('wasm');
      const data = host.toTypedArray() as Float32Array;
      const copy = Float32Array.from(data);
      tin.delete();
      for (const x of res) if (x !== host) x.delete();
      host.delete();
      return copy;
    };
    let last = new Float32Array(0);
    for (let i = 0; i < WARMUP; i++) last = await once();
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const s = performance.now();
      last = await once();
      ms.push(performance.now() - s);
    }
    const sum = ms.reduce((a, b) => a + b, 0);
    r.runs = RUNS;
    r.medianMs = +pct(ms, 50).toFixed(1);
    r.p95Ms = +pct(ms, 95).toFixed(1);
    r.maxMs = +Math.max(...ms).toFixed(1);
    r.meanMs = +(sum / ms.length).toFixed(1);
    r.inferencesPerSecMedian = +(1000 / pct(ms, 50)).toFixed(2);

    r.outputLength = last.length;
    r.outputHasNaN = last.some((v) => Number.isNaN(v));
    const dets = last.length === 3549 * 85 ? decodeYoloxRaw(last, lb) : [];
    r.topAnyClass = last.length === 3549 * 85 ? topAnyClass(last, lb) : [];
    r.detections = dets.slice(0, 12).map((d) => ({ cls: d.cls, score: +d.score.toFixed(3), box: { x: +d.box.x.toFixed(3), y: +d.box.y.toFixed(3), w: +d.box.w.toFixed(3), h: +d.box.h.toFixed(3) } }));
    r.detectionCount = dets.length;

    const ctx = canvas.getContext('2d')!;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0f0';
    for (const d of dets) ctx.strokeRect(d.box.x * lb.srcW * lb.ratio, d.box.y * lb.srcH * lb.ratio, d.box.w * lb.srcW * lb.ratio, d.box.h * lb.srcH * lb.ratio);
  } catch (e) {
    r.runError = errText(e);
  } finally {
    try { model.delete(); } catch { /* ignore */ }
  }
  return r;
}

async function main() {
  out.textContent = 'running...';
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), warmup: WARMUP, runs: RUNS };
  report.environment = await environment();
  say('env: ' + JSON.stringify(report.environment));
  const { tensor, lb, canvas } = await sampleInput();
  report.sample = { srcW: lb.srcW, srcH: lb.srcH, ratio: lb.ratio };
  const trials: unknown[] = [];
  for (const t of TRIALS) {
    say(`trial ${t.name} ...`);
    const r = await runTrial(t, tensor, lb, canvas);
    trials.push(r);
    say(JSON.stringify(r));
    console.log('E1_TRIAL ' + JSON.stringify({ ...r, topAnyClass: undefined, detections: undefined }));
  }
  report.trials = trials;
  // In the Capacitor WebView the page origin is https://localhost, so reaching the laptop's server (adb reverse) is itself
  // a mixed-content test (https page -> http://127.0.0.1). The result is recorded; logcat has the same data either way.
  const inApp = location.protocol === 'https:';
  const target = inApp ? 'http://127.0.0.1:8099/log' : '/log';
  console.log('E1_REPORT ' + JSON.stringify(report));
  try {
    await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    say('report posted to ' + target);
  } catch (e) {
    say('post to ' + target + ' failed: ' + errText(e));
  }
}

document.getElementById('run')!.addEventListener('click', () => void main());
const params = new URLSearchParams(location.search);
if (params.get('auto') === '1' || location.protocol === 'https:') void main();
