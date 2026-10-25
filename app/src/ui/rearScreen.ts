// Rear-phone screen: Start/Stop, camera preview with detection boxes, headline status and health lines.
// Pure DOM; the wording comes from statusText.ts (tested).

import type { CapturedFrame } from '../capture/source';
import { createPipeline } from '../pipeline/createPipeline';
import { LocalServerPlugin, type LocalServerInfo } from '../plugins/localServer';
import type { PipelineSnapshot } from '../pipeline/pipeline';
import { alertOverrides, closeHFromBox, EMPTY_CALIBRATION, parseCalibration, type Calibration } from '../core/calibration';
import { DEFAULT_K, estimateDistanceM, formatDistance, kFromSample } from '../core/distance';
import type { Track } from '../shared/types';
import { drawQr, encodeQr } from './qr';
import { statusView, DISCLAIMER, type Tone } from './statusText';

const COLORS: Record<Tone, string> = { neutral: '#2b3a2f', info: '#1f3b5c', warn: '#8a2b1a', unavailable: '#555' };
const wakeLockApi = () => (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock;

export function mountRearScreen(root: HTMLElement): void {
  root.innerHTML = '';
  root.style.cssText = 'font-family:sans-serif;background:#111;color:#eee;margin:0;padding:0';
  // One window without scrolling the video away: status bar and video share the main column and the video takes the space that
  // is left (aspect ratio kept); buttons, viewer link, QR and numbers sit in a side panel (landscape) or a strip below
  // (portrait) that scrolls on its own if it is too tall.
  const style = document.createElement('style');
  style.textContent = `
    .rv { box-sizing: border-box; height: 100vh; height: 100dvh; display: grid; gap: 8px; padding: 8px; grid-template-rows: minmax(0, 1fr) auto; }
    .rv-main { min-height: 0; display: flex; flex-direction: column; gap: 6px; }
    .rv-head { flex: none; padding: 8px 12px; border-radius: 8px; font-size: clamp(16px, 4.5vmin, 24px); font-weight: bold; }
    .rv-detail { flex: none; font-size: 12px; opacity: .85; min-height: 14px; }
    .rv-video { flex: 1 1 0; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; border-radius: 6px; overflow: hidden; }
    .rv-video canvas { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; }
    .rv-panel { min-height: 0; max-height: 38vh; overflow-y: auto; }
    .rv-panel button { font-size: 16px; padding: 10px 20px; margin: 4px 8px 4px 0; border-radius: 6px; }
    @media (orientation: landscape) {
      .rv { grid-template-rows: minmax(0, 1fr); grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); }
      .rv-panel { max-height: none; }
    }`;
  const wrap = document.createElement('div');
  wrap.className = 'rv';
  const main = document.createElement('div');
  main.className = 'rv-main';
  const panel = document.createElement('div');
  panel.className = 'rv-panel';
  const head = document.createElement('div');
  head.className = 'rv-head';
  const detail = document.createElement('div');
  detail.className = 'rv-detail';
  const videoWrap = document.createElement('div');
  videoWrap.className = 'rv-video';
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  videoWrap.append(canvas);
  videoWrap.style.position = 'relative';
  const btn = document.createElement('button');
  const info = document.createElement('pre');
  info.style.cssText = 'font-size:12px;white-space:pre-wrap;margin:4px 0';
  const note = document.createElement('div');
  note.style.cssText = 'font-size:12px;opacity:.8';
  note.textContent = DISCLAIMER;
  const viewerBox = document.createElement('div');
  viewerBox.style.cssText = 'font-size:13px;margin:6px 0;padding:8px;border:1px solid #444;border-radius:6px;word-break:break-all';
  const revokeBtn = document.createElement('button');
  revokeBtn.textContent = 'Revoke viewer access';
  revokeBtn.style.fontSize = '14px';
  const qrCanvas = document.createElement('canvas');
  qrCanvas.style.cssText = 'display:none;width:min(260px,40vmin);height:min(260px,40vmin);image-rendering:pixelated;margin:6px 0;border-radius:4px';
  main.append(head, detail, videoWrap);
  panel.append(btn, viewerBox, qrCanvas, revokeBtn, info, note);
  wrap.append(main, panel);
  root.append(style, wrap);
  const ctx = canvas.getContext('2d')!;

  const preview = (f: CapturedFrame) => {
    ctx.drawImage(f.bitmap, 0, 0, canvas.width, canvas.height);
  };
  let viewers = 0;
  let serverInfo: LocalServerInfo | null = null;
  let serverNote = 'Viewer: off';
  let qrUrl = '';
  // Calibration of the "close" alert points and the distance scale, kept on this phone (D-041).
  const CAL_KEY = 'rv_calib';
  let calib: Calibration = EMPTY_CALIBRATION;
  try {
    calib = parseCalibration(localStorage.getItem(CAL_KEY));
  } catch {
    /* defaults */
  }
  const saveCalib = () => {
    try {
      localStorage.setItem(CAL_KEY, JSON.stringify(calib));
    } catch {
      /* applies for this session only */
    }
  };
  const { pipeline, publisher } = createPipeline({
    previewHook: preview,
    alertOverrides: alertOverrides(calib),
    distanceScale: () => ({ k: calib.k ?? DEFAULT_K, calibrated: calib.k !== null }),
    server: { api: LocalServerPlugin, viewersWatching: () => viewers > 0 },
  });

  // --- calibration panel ---
  const calDetails = document.createElement('details');
  calDetails.style.cssText = 'font-size:13px;margin:6px 0';
  const calSummary = document.createElement('summary');
  calSummary.textContent = 'Distance and alert calibration';
  const calNearest = document.createElement('div');
  calNearest.style.cssText = 'margin:6px 0;white-space:pre-wrap';
  const calMsg = document.createElement('div');
  calMsg.style.cssText = 'margin:6px 0;opacity:.9';
  const nearestOf = (tracks: Track[], person: boolean): Track | null =>
    tracks.filter((x) => x.state === 'confirmed' && (x.cls === 'person') === person).reduce<Track | null>((a, x) => (a === null || x.box.h > a.box.h ? x : a), null);
  const mkBtn = (label: string, on: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font-size:13px;padding:7px 10px;margin:3px 6px 3px 0;border-radius:6px';
    b.onclick = on;
    return b;
  };
  const applyCalib = (msg: string) => {
    saveCalib();
    pipeline.configureAlert({ vehicleCloseH: 0.35, vehicleExitH: 0.28, personCloseH: 0.3, personExitH: 0.24, ...alertOverrides(calib) });
    calMsg.textContent = msg;
  };
  calDetails.append(
    calSummary,
    calNearest,
    mkBtn('Set "very close" to the nearest vehicle now', () => {
      const v = last ? nearestOf(last.tracks, false) : null;
      const h = v ? closeHFromBox(v.box.h) : null;
      if (!v || h === null) return void (calMsg.textContent = 'No usable confirmed vehicle in view (box between 12% and 95% of the frame needed).');
      calib = { ...calib, vehicleCloseH: h };
      applyCalib(`"Very close" for vehicles now starts at box height ${h.toFixed(2)} (${formatDistance(estimateDistanceM(v.cls, h, calib.k ?? DEFAULT_K))}).`);
    }),
    mkBtn('Set "person close" to the nearest person now', () => {
      const v = last ? nearestOf(last.tracks, true) : null;
      const h = v ? closeHFromBox(v.box.h) : null;
      if (!v || h === null) return void (calMsg.textContent = 'No usable confirmed person in view.');
      calib = { ...calib, personCloseH: h };
      applyCalib(`"Person close" now starts at box height ${h.toFixed(2)}.`);
    }),
    mkBtn('Tell the distance of the nearest vehicle', () => {
      const v = last ? nearestOf(last.tracks, false) : null;
      if (!v) return void (calMsg.textContent = 'No confirmed vehicle in view.');
      const answer = window.prompt('How far is that vehicle from the camera, in metres?', '3');
      const d = answer === null ? NaN : Number(answer.replace(',', '.'));
      const k = kFromSample(v.cls, v.box.h, d);
      if (k === null) return void (calMsg.textContent = 'That distance does not fit this box size; nothing changed.');
      calib = { ...calib, k };
      applyCalib(`Distance scale set from this sample (${v.cls}, box ${v.box.h.toFixed(2)} = ${d} m). Estimates assume a car is 1.5 m tall.`);
    }),
    mkBtn('Reset calibration', () => {
      calib = EMPTY_CALIBRATION;
      applyCalib('Back to the defaults.');
    }),
    calMsg,
  );
  const showNearest = (s: PipelineSnapshot) => {
    const k = calib.k ?? DEFAULT_K;
    const line = (label: string, x: Track | null) => (x ? `${label}: ${x.cls} box ${x.box.h.toFixed(2)}, ${formatDistance(estimateDistanceM(x.cls, x.box.h, k))}` : `${label}: -`);
    calNearest.textContent = [
      line('Nearest vehicle', nearestOf(s.tracks, false)),
      line('Nearest person', nearestOf(s.tracks, true)),
      `Distance scale: ${calib.k === null ? 'rough guess' : 'calibrated'}. "Very close" (vehicle) at box ${(calib.vehicleCloseH ?? 0.35).toFixed(2)}, person close at ${(calib.personCloseH ?? 0.3).toFixed(2)}.`,
    ].join('\n');
  };
  const renderViewer = () => {
    if (!serverInfo) {
      viewerBox.textContent = serverNote;
      revokeBtn.style.display = 'none';
      qrCanvas.style.display = 'none';
      return;
    }
    const base = serverInfo.baseUrl ?? serverInfo.url.split('#')[0];
    const name = serverInfo.hostUrl ? `\nOr by name (no IP needed, if your iPhone resolves it): ${serverInfo.hostUrl}` : '';
    viewerBox.textContent = `iPhone viewer address: ${base}${name}
First time on a device: scan the QR below (it carries the access key); after that just open the address above (bookmark it in Safari).
Viewers connected: ${viewers}. Plain HTTP: anyone on this network who has the address and the key can watch. "Revoke viewer access" invalidates every saved key.`;
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
    // red outline on the preview while a possible approach or a close person is flagged (same colours as the viewer)
    const alarm = s.running && (s.alert.level === 'POSSIBLE_APPROACH' || s.alert.level === 'VEHICLE_CLOSE' || s.alert.level === 'PERSON_CLOSE');
    videoWrap.style.boxShadow = alarm ? 'inset 0 0 0 6px #ff1f1f' : s.running && s.alert.level === 'VEHICLE_NEARBY' ? 'inset 0 0 0 3px #ffb000' : 'none';
    detail.textContent = v.detail;
    info.textContent = v.lines.join('\n');
    if (calDetails.open) showNearest(s);
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
  // Revoking signs every saved viewer out, so it needs a second tap within 4 s (a stray tap must not break the iPhone's connection).
  let revokeArmed: ReturnType<typeof setTimeout> | null = null;
  revokeBtn.onclick = () => {
    if (revokeArmed === null) {
      revokeBtn.textContent = 'Tap again: sign out all saved viewers';
      revokeArmed = setTimeout(() => {
        revokeArmed = null;
        revokeBtn.textContent = 'Revoke viewer access';
      }, 4000);
      return;
    }
    clearTimeout(revokeArmed);
    revokeArmed = null;
    revokeBtn.textContent = 'Revoke viewer access';
    void LocalServerPlugin.revoke().then((r) => {
      if (serverInfo) serverInfo = { ...serverInfo, token: r.token, url: r.url };
      qrUrl = '';
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
  // Start by itself when the app opens (default on): the rear phone sits far from the driver, so nobody should need to tap Start.
  // The preview and the "camera active" state stay visible on this screen. Untick to start manually.
  const AUTO_KEY = 'rv_autostart';
  const readAuto = (): boolean => {
    try {
      return localStorage.getItem(AUTO_KEY) !== '0';
    } catch {
      return true;
    }
  };
  const autoRow = document.createElement('label');
  autoRow.style.cssText = 'display:block;font-size:13px;margin:6px 0';
  const autoBox = document.createElement('input');
  autoBox.type = 'checkbox';
  autoBox.checked = readAuto();
  autoBox.onchange = () => {
    try {
      localStorage.setItem(AUTO_KEY, autoBox.checked ? '1' : '0');
    } catch {
      /* not saved: default applies next time */
    }
  };
  autoRow.append(autoBox, ' Start automatically when the app opens');
  panel.insertBefore(autoRow, viewerBox);
  panel.insertBefore(calDetails, info);
  if (import.meta.env.VITE_AUTOSTART === '1' || autoBox.checked) setTimeout(() => void start(), 800);
}
