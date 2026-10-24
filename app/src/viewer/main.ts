// iPhone Safari viewer (docs/PROTOCOL_SPEC.md, D-032). Loaded from the rear phone's server; the token comes from the URL fragment
// (never sent in an HTTP request), is used once per socket in `hello`, and is not displayed or logged. DOM glue only: the state
// rules are viewerState.ts and the helpers in viewerLogic.ts, both unit tested.

import { decodeFrame } from '../stream/frameCodec';
import type { FrameMeta, HealthFlags } from '../shared/types';
import { classifyViewer, type ViewerFacts, type ViewerView } from './viewerState';
import { beepIntervalMs, beepLengthMs, ClockOffset, frameAgeMs, levelText, nearestBoxH, reconnectDelayMs, shouldReconnect, tokenFromHash } from './viewerLogic';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  canvas: $<HTMLCanvasElement>('video'),
  headline: $('headline'),
  banner: $('banner'),
  detail: $('detail'),
  stats: $('stats'),
  audio: $<HTMLButtonElement>('audio'),
  stage: $('stage'),
};
const ctx = els.canvas.getContext('2d')!;

const token = tokenFromHash(location.hash);
let ws: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: number | undefined;
let closeCode: number | null = null;
let socketOpen = false;
let lastFrameAt: number | null = null;
let lastMsgAt: number | null = null;
let newestMeta: FrameMeta | null = null;
let lastDrawnSeq = -1;
let sessionId: string | null = null;
let ingest: 'connected' | 'disconnected' | null = null;
let rear: { inferFps?: number; inferP95Ms?: number; captureFps?: number; modelMs?: number; health?: HealthFlags } | null = null;
let rearAt = 0;
let framesDrawn = 0;
let pending: { seq: number; meta: FrameMeta; blob: Blob } | null = null;
let decoding = false;
let prevView: ViewerView | null = null;
let prevState = '';
let audioCtx: AudioContext | null = null;
const offset = new ClockOffset();
const pingSent = new Map<number, number>();

function connect(): void {
  if (!token) return;
  closeCode = null;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws/view`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    socketOpen = true;
    lastMsgAt = performance.now();
    sock.send(JSON.stringify({ v: 1, type: 'hello', token, clientId: clientId(), caps: { jpeg: true } }));
  };
  sock.onmessage = (e) => {
    lastMsgAt = performance.now();
    if (typeof e.data === 'string') onText(e.data);
    else onBinary(new Uint8Array(e.data as ArrayBuffer));
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    socketOpen = false;
    closeCode = e.code;
    ws = null;
    if (shouldReconnect(e.code)) {
      reconnectTimer = window.setTimeout(connect, reconnectDelayMs(attempt++, Math.random()));
    }
  };
  sock.onerror = () => undefined; // onclose follows
}

function clientId(): string {
  return 'v-' + Math.random().toString(36).slice(2, 10);
}

function onText(text: string): void {
  let m: { type?: string; [k: string]: unknown };
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  if (m.type === 'welcome') {
    attempt = 0;
    offset.reset();
    const sid = String(m.sessionId);
    if (sid !== sessionId) lastDrawnSeq = -1; // a restarted server restarts the sequence
    sessionId = sid;
    if (typeof m.serverTimeMs === 'number') {
      const now = Date.now();
      offset.add(now, now, m.serverTimeMs); // rough first estimate until a ping measures the round trip
    }
    sendPing();
  } else if (m.type === 'status') {
    ingest = m.ingest === 'connected' ? 'connected' : m.ingest === 'disconnected' ? 'disconnected' : null;
    rear = (m.rear as typeof rear) ?? null;
    rearAt = performance.now();
  } else if (m.type === 'pong') {
    const sent = pingSent.get(m.tClientMs as number);
    pingSent.delete(m.tClientMs as number);
    if (sent !== undefined && typeof m.serverTimeMs === 'number') offset.add(sent, Date.now(), m.serverTimeMs);
  } else if (m.type === 'error') {
    // the close frame that follows carries the code
  }
}

function onBinary(bytes: Uint8Array): void {
  let d;
  try {
    d = decodeFrame(bytes);
  } catch {
    return;
  }
  lastFrameAt = performance.now();
  if (d.meta.seq <= lastDrawnSeq && (pending === null || d.meta.seq <= pending.seq)) return; // not newer than what is shown
  newestMeta = d.meta;
  // keep only the newest undecoded frame
  pending = { seq: d.meta.seq, meta: d.meta, blob: new Blob([d.jpeg as BlobPart], { type: 'image/jpeg' }) };
  void drawPending();
}

async function drawPending(): Promise<void> {
  if (decoding) return;
  decoding = true;
  try {
    while (pending) {
      const p = pending;
      pending = null;
      const img = await decode(p.blob);
      if (img) {
        lastImg = img;
        lastShownMeta = p.meta;
        lastDrawnSeq = p.seq;
        framesDrawn++;
        paint();
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: 'ack', seq: p.seq }));
      }
    }
  } finally {
    decoding = false;
  }
}

function decode(blob: Blob): Promise<HTMLImageElement | ImageBitmap | null> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob).catch(() => null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

let lastImg: HTMLImageElement | ImageBitmap | null = null;
let lastShownMeta: FrameMeta | null = null;
let showBoxesNow = false;

/** Draws the newest decoded frame, and the track boxes only while the state allows them (never over a stale feed). */
function paint(): void {
  if (!lastImg) return;
  if (els.canvas.width !== lastImg.width || els.canvas.height !== lastImg.height) {
    els.canvas.width = lastImg.width;
    els.canvas.height = lastImg.height;
  }
  ctx.drawImage(lastImg, 0, 0);
  const m = lastShownMeta;
  if (!showBoxesNow || !m) return;
  const W = els.canvas.width;
  const H = els.canvas.height;
  ctx.lineWidth = Math.max(2, W / 200);
  ctx.font = `${Math.max(12, W / 40)}px sans-serif`;
  for (const t of m.tracks) {
    if (t.state === 'lost') continue;
    ctx.strokeStyle = t.state === 'confirmed' ? '#ffd400' : '#9aa';
    ctx.setLineDash(t.state === 'confirmed' ? [] : [6, 4]);
    ctx.strokeRect(t.box.x * W, t.box.y * H, t.box.w * W, t.box.h * H);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`${t.cls} #${t.id}`, t.box.x * W + 3, Math.max(14, t.box.y * H - 4));
  }
  ctx.setLineDash([]);
}

function sendPing(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const t = Date.now();
  pingSent.set(t, t);
  if (pingSent.size > 20) pingSent.delete(pingSent.keys().next().value as number);
  ws.send(JSON.stringify({ v: 1, type: 'ping', tClientMs: t }));
}

function tone(freq: number, ms: number): void {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  const t0 = audioCtx.currentTime;
  const end = t0 + ms / 1000;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(0.25, t0 + 0.006);
  g.gain.setValueAtTime(0.25, Math.max(t0 + 0.006, end - 0.01));
  g.gain.linearRampToValueAtTime(0.0001, end);
  o.connect(g).connect(audioCtx.destination);
  o.start(t0);
  o.stop(end + 0.01);
}

/**
 * Proximity beeping: while the feed is LIVE and the level is POSSIBLE_APPROACH, beep repeatedly; the gap shrinks as the nearest
 * tracked box grows (a proxy for closeness, not a distance). Silent in every other state, including DELAYED and STALE.
 */
let nextBeepAt = 0;
function beepTick(): void {
  const v = prevView;
  const m = newestMeta;
  if (!audioCtx || !v || !v.audioCueAllowed || v.alertLevel !== 'POSSIBLE_APPROACH' || !m) {
    nextBeepAt = 0;
    return;
  }
  const now = performance.now();
  if (now < nextBeepAt) return;
  const gap = beepIntervalMs(nearestBoxH(m.tracks));
  tone(880, beepLengthMs(gap));
  nextBeepAt = now + gap;
}

els.audio.onclick = () => {
  audioCtx = audioCtx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  void audioCtx.resume();
  tone(660, 150);
  els.audio.textContent = 'Sound on';
};

function facts(now: number): ViewerFacts {
  const m = newestMeta;
  const age = m ? frameAgeMs(Date.now(), offset.offsetMs(), m.tCaptureEpochMs) : null;
  return {
    nowMs: now,
    socketOpen,
    closeCode,
    lastFrameAtMs: lastFrameAt,
    lastMsgAtMs: lastMsgAt,
    frameAgeMs: age,
    detAgeMs: m ? m.detAgeMs : null,
    health: m ? m.alert.health : null,
    alertLevel: m ? m.alert.level : null,
    ingest,
  };
}

function render(): void {
  const now = performance.now();
  const f = facts(now);
  const v = classifyViewer(f);
  if (showBoxesNow !== v.showBoxes) {
    showBoxesNow = v.showBoxes;
    paint();
  }

  els.headline.textContent = token ? (v.state === 'LIVE' || v.state === 'DELAYED' ? levelText(v.alertLevel) : 'DETECTION UNAVAILABLE') : 'No session token - scan the QR code on the rear phone';
  els.banner.textContent = token ? (v.banner ?? '') : '';
  els.stage.dataset.state = token ? v.state : 'INVALID_SESSION';
  els.stage.dataset.level = v.alertLevel;
  const r = rear && now - rearAt < 3000 ? rear : null;
  els.stats.textContent = [
    `State: ${v.state}  Frame age: ${f.frameAgeMs === null ? '-' : Math.round(f.frameAgeMs) + ' ms'}  Frames: ${framesDrawn}`,
    r ? `Detections/s: ${r.inferFps ?? '-'}  Camera fps: ${r.captureFps ?? '-'}  Latency p95: ${r.inferP95Ms ?? '-'} ms` : 'Rear status: -',
  ].join('\n');
  els.detail.textContent = newestMeta && (v.state === 'LIVE' || v.state === 'DELAYED') ? newestMeta.alert.reasons.join('; ') : '';

  if (prevState && prevState !== v.state && (v.state === 'STALE' || v.state === 'DISCONNECTED' || v.state === 'DETECTOR_UNAVAILABLE')) tone(300, 500);
  prevView = v;
  prevState = v.state;

  // socket looks alive but nothing has arrived for too long: force a clean reconnect
  if (ws && socketOpen && lastMsgAt !== null && now - lastMsgAt > 5000) ws.close();
}

// A new link opened in the same tab only changes the fragment: reload so the new token is used.
window.addEventListener('hashchange', () => location.reload());
if (token) connect();
window.setInterval(render, 250);
window.setInterval(beepTick, 30);
window.setInterval(sendPing, 2000);
render();
void reconnectTimer;
