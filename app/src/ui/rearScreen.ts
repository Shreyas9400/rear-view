// Rear-phone screen: Start/Stop, camera preview with detection boxes, headline status and health lines.
// Pure DOM; the wording comes from statusText.ts (tested).

import type { CapturedFrame } from '../capture/source';
import { createPipeline } from '../pipeline/createPipeline';
import { LocalServerPlugin, type LocalServerInfo } from '../plugins/localServer';
import type { PipelineSnapshot } from '../pipeline/pipeline';
import { drawQr, encodeQr } from './qr';
import { statusView, DISCLAIMER, type Tone } from './statusText';

const COLORS: Record<Tone, string> = { neutral: '#2b3a2f', info: '#1f3b5c', warn: '#8a2b1a', unavailable: '#555' };
const wakeLockApi = () => (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock;

export function mountRearScreen(root: HTMLElement): void {
  root.innerHTML = '';
  root.style.cssText = 'font-family:sans-serif;background:#111;color:#eee;min-height:100vh;margin:0;padding:8px;box-sizing:border-box';
  const head = document.createElement('div');
  head.style.cssText = 'padding:12px;border-radius:8px;font-size:22px;font-weight:bold;margin-bottom:8px';
  const detail = document.createElement('div');
  detail.style.cssText = 'font-size:13px;margin-bottom:8px;opacity:.85';
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  canvas.style.cssText = 'width:100%;background:#000;border-radius:6px';
  const btn = document.createElement('button');
  btn.style.cssText = 'font-size:18px;padding:12px 24px;margin:8px 0;border-radius:6px';
  const info = document.createElement('pre');
  info.style.cssText = 'font-size:12px;white-space:pre-wrap;margin:4px 0';
  const note = document.createElement('div');
  note.style.cssText = 'font-size:12px;opacity:.8';
  note.textContent = DISCLAIMER;
  const viewerBox = document.createElement('div');
  viewerBox.style.cssText = 'font-size:13px;margin:6px 0;padding:8px;border:1px solid #444;border-radius:6px;word-break:break-all';
  const revokeBtn = document.createElement('button');
  revokeBtn.textContent = 'Revoke viewer access';
  revokeBtn.style.cssText = 'font-size:14px;padding:8px 14px;margin:4px 0;border-radius:6px';
  const qrCanvas = document.createElement('canvas');
  qrCanvas.style.cssText = 'display:none;width:260px;height:260px;image-rendering:pixelated;margin:6px 0;border-radius:4px';
  root.append(head, detail, canvas, btn, viewerBox, qrCanvas, revokeBtn, info, note);
  const ctx = canvas.getContext('2d')!;

  const preview = (f: CapturedFrame) => {
    ctx.drawImage(f.bitmap, 0, 0, canvas.width, canvas.height);
  };
  let viewers = 0;
  let serverInfo: LocalServerInfo | null = null;
  let serverNote = 'Viewer: off';
  let qrUrl = '';
  const { pipeline, publisher } = createPipeline({
    previewHook: preview,
    server: { api: LocalServerPlugin, viewersWatching: () => viewers > 0 },
  });
  const renderViewer = () => {
    if (!serverInfo) {
      viewerBox.textContent = serverNote;
      revokeBtn.style.display = 'none';
      qrCanvas.style.display = 'none';
      return;
    }
    viewerBox.textContent = `iPhone viewer (open in Safari on the same hotspot): ${serverInfo.url}
Viewers connected: ${viewers}. Plain HTTP: anyone on this network who has this link can watch.`;
    viewerBox.style.whiteSpace = 'pre-wrap';
    revokeBtn.style.display = '';
    if (qrUrl !== serverInfo.url) {
      qrUrl = serverInfo.url;
      try {
        drawQr(qrCanvas.getContext('2d')!, encodeQr(serverInfo.url, 'M'), 8);
        qrCanvas.style.display = 'block';
      } catch {
        qrCanvas.style.display = 'none'; // the text link above still works
      }
    }
  };
  renderViewer();
  let lock: { release(): Promise<void> } | null = null;
  let last: PipelineSnapshot | null = null;

  const render = (s: PipelineSnapshot) => {
    last = s;
    const v = statusView(s);
    head.textContent = v.headline;
    head.style.background = COLORS[v.tone];
    detail.textContent = v.detail;
    info.textContent = v.lines.join('\n');
    btn.textContent = s.running ? 'Stop' : 'Start';
    // boxes from the latest result (drawn over the latest preview frame; both are a few hundred ms old at most)
    if (s.running && s.alert.level !== 'UNAVAILABLE') {
      ctx.lineWidth = 2;
      for (const d of s.detections) {
        ctx.strokeStyle = '#ffd400';
        ctx.strokeRect(d.box.x * canvas.width, d.box.y * canvas.height, d.box.w * canvas.width, d.box.h * canvas.height);
      }
    }
  };
  pipeline.onUpdate(render);
  render(pipeline.snapshot());

  let statusTimer: ReturnType<typeof setInterval> | null = null;
  const startServer = async () => {
    try {
      serverInfo = await LocalServerPlugin.start();
      serverNote = '';
    } catch (e) {
      serverInfo = null;
      serverNote = `Viewer unavailable: ${String((e as { message?: string })?.message ?? e)}`;
    }
    renderViewer();
    statusTimer = setInterval(() => {
      void LocalServerPlugin.status().then((s) => {
        viewers = s.viewers ?? 0;
        renderViewer();
      }, () => undefined);
      publisher?.publishStatus(performance.timeOrigin + performance.now(), performance.now());
    }, 1000);
  };
  const stopServer = async () => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    viewers = 0;
    serverInfo = null;
    qrUrl = '';
    serverNote = 'Viewer: off';
    await LocalServerPlugin.stop().catch(() => undefined);
    renderViewer();
  };
  revokeBtn.onclick = () => {
    void LocalServerPlugin.revoke().then((r) => {
      if (serverInfo) serverInfo = { ...serverInfo, token: r.token, url: r.url };
      renderViewer();
    }, () => undefined);
  };

  const start = async () => {
    await startServer();
    try {
      lock = (await wakeLockApi()?.request('screen')) ?? null;
    } catch {
      lock = null; // not fatal; the screen may sleep
    }
    try {
      await pipeline.start();
    } catch {
      /* the error is in the snapshot's lastError and the alert is UNAVAILABLE */
    }
    render(pipeline.snapshot());
  };
  const stop = async () => {
    await pipeline.stop();
    await stopServer();
    await lock?.release().catch(() => undefined);
    lock = null;
  };
  btn.onclick = () => void (pipeline.isRunning() ? stop() : start());

  if (import.meta.env.VITE_PRODUCT_LOG === '1') {
    setInterval(() => {
      if (!last) return;
      const s = pipeline.snapshot();
      console.log(
        `PRODUCT_STATUS ${JSON.stringify({
          running: s.running,
          level: s.alert.level,
          reasons: s.alert.reasons,
          health: s.health,
          tracks: s.tracks.map((t) => ({ id: t.id, state: t.state })),
          det: Math.round(s.detectionsPerSec * 10) / 10,
          latMed: Math.round(s.latencyMs.median),
          latP95: Math.round(s.latencyMs.p95),
          modelMed: Math.round(s.modelMs.median),
          gap: Math.round(s.load.minGapMs),
          loadReason: s.load.reason,
          counters: s.counters,
          viewers,
          stream: publisher?.counters() ?? null,
          err: s.lastError,
        })}`,
      );
    }, 5000);
  }
  if (import.meta.env.VITE_AUTOSTART === '1') void start();
}
