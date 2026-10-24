// iPhone Safari viewer (docs/PROTOCOL_SPEC.md, D-032, D-037). Loaded from the rear phone's server. The token comes from the QR link's
// fragment (never sent in an HTTP request) the first time; it is then remembered in this browser (localStorage) so the plain address
// http://<ip>:8080 works afterwards. It is used once per socket in `hello` and is not displayed or logged. DOM glue only: the state
// rules are viewerState.ts and the helpers in viewerLogic.ts, both unit tested.

import { decodeFrame } from '../stream/frameCodec';
import type { FrameMeta, HealthFlags } from '../shared/types';
import { classifyViewer, type ViewerFacts, type ViewerView } from './viewerState';
import { BEEP_PERSON, beepIntervalMs, beepLengthMs, ClockOffset, displaySide, FORGET_TOKEN_CODES, frameAgeMs, levelText, nearestBoxH, panFor, pickToken, reconnectDelayMs, shouldReconnect } from './viewerLogic';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  canvas: $<HTMLCanvasElement>('video'),
  headline: $('headline'),
  banner: $('banner'),
  detail: $('detail'),
  stats: $('stats'),
  audio: $<HTMLButtonElement>('audio'),
  stage: $('stage'),
  fs: $<HTMLButtonElement>('fs'),
  exitFs: $<HTMLButtonElement>('exitFs'),
  mirror: $<HTMLButtonElement>('mirror'),
  chip: $('chip'),
};
const ctx = els.canvas.getContext('2d')!;

const store = (k: string, v: string | null): void => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private browsing or blocked storage: the link's own token still works for this page */
  }
};
const load = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const picked = pickToken(location.hash, load('rv_token'));
const token = picked.token;
if (picked.store) {
  store('rv_token', picked.store);
  // leave only http://<ip>:<port>/ in the address bar (the fragment never reaches the server anyway)
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* ignore */
  }
}
let mirror = load('rv_mirror') !== '0'; // like a rear-view mirror: left on screen = the driver's left
let lastCloseNote = '';
let connectStartedAt = 0;
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

/** Gives up on a socket that never answered (a phone that slept, a hotspot that dropped): its onclose may take minutes or never come. */
function abandon(sock: WebSocket): void {
  sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
  try {
    sock.close();
  } catch {
    /* already closed */
  }
  if (ws === sock) {
    ws = null;
    socketOpen = false;
  }
}

function reconnectSoon(delayMs: number): void {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, delayMs);
}

function connect(): void {
  if (!token || ws) return;
  closeCode = null;
  connectStartedAt = performance.now();
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
    lastCloseNote = `last close ${e.code}`;
    ws = null;
    if (FORGET_TOKEN_CODES.includes(e.code)) store('rv_token', null); // the rear phone no longer accepts it: a new QR is needed
    if (shouldReconnect(e.code)) reconnectSoon(reconnectDelayMs(attempt++, Math.random()));
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
  const W = els.canvas.width;
  const H = els.canvas.height;
  if (mirror) {
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(lastImg, 0, 0);
    ctx.restore();
  } else {
    ctx.drawImage(lastImg, 0, 0);
  }
  const m = lastShownMeta;
  if (!showBoxesNow || !m) return;
  ctx.lineWidth = Math.max(2, W / 200);
  ctx.font = `${Math.max(12, W / 40)}px sans-serif`;
  for (const t of m.tracks) {
    if (t.state === 'lost') continue;
    ctx.strokeStyle = t.state === 'confirmed' ? '#ffd400' : '#9aa';
    ctx.setLineDash(t.state === 'confirmed' ? [] : [6, 4]);
    const bx = (mirror ? 1 - t.box.x - t.box.w : t.box.x) * W; // boxes are mirrored with the picture; the label text is not
    ctx.strokeStyle = t.missedFrames > 0 ? '#ffe680' : ctx.strokeStyle;
    ctx.strokeRect(bx, t.box.y * H, t.box.w * W, t.box.h * H);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`${t.cls} #${t.id}`, bx + 3, Math.max(14, t.box.y * H - 4));
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

function tone(freq: number, ms: number, pan = 0): void {
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
  const panner = pan !== 0 && typeof audioCtx.createStereoPanner === 'function' ? audioCtx.createStereoPanner() : null;
  if (panner) {
    panner.pan.value = pan;
    o.connect(g).connect(panner).connect(audioCtx.destination);
  } else {
    o.connect(g).connect(audioCtx.destination);
  }
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
  const person = v?.alertLevel === 'PERSON_CLOSE';
  const vehicleAlarm = v?.alertLevel === 'POSSIBLE_APPROACH' || v?.alertLevel === 'VEHICLE_CLOSE';
  if (!audioCtx || !v || !v.audioCueAllowed || (!person && !vehicleAlarm) || !m) {
    nextBeepAt = 0;
    return;
  }
  const now = performance.now();
  if (now < nextBeepAt) return;
  // A person close behind has its own, higher tone and its own curve; it wins over a vehicle approach.
  const gap = person ? beepIntervalMs(nearestBoxH(m.tracks, 'person'), BEEP_PERSON) : beepIntervalMs(nearestBoxH(m.tracks));
  tone(person ? 1250 : 880, beepLengthMs(gap), panFor(displaySide(m.alert.side, mirror)));
  nextBeepAt = now + gap;
}

els.audio.onclick = () => {
  audioCtx = audioCtx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  void audioCtx.resume();
  tone(660, 150);
  els.audio.textContent = 'Sound on';
};

/** For calibrating the "close" thresholds: the largest confirmed box (fraction of the frame height) with its class. */
function nearestText(): string {
  const m = newestMeta;
  let best: { cls: string; h: number } | null = null;
  for (const t of m?.tracks ?? []) if (t.state === 'confirmed' && (best === null || t.box.h > best.h)) best = { cls: t.cls, h: t.box.h };
  return best ? `${best.cls} ${best.h.toFixed(2)}` : '-';
}

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

  const shown = v.state === 'LIVE' || v.state === 'DELAYED';
  const side = shown ? displaySide(newestMeta?.alert.side, mirror) : null;
  const headline = token ? (shown ? levelText(v.alertLevel, side) : 'DETECTION UNAVAILABLE') : 'No session - scan the QR code on the rear phone';
  els.headline.textContent = headline;
  els.chip.textContent = headline;
  els.stage.dataset.alert = shown && (v.alertLevel === 'POSSIBLE_APPROACH' || v.alertLevel === 'VEHICLE_CLOSE' || v.alertLevel === 'PERSON_CLOSE') ? '1' : '0';
  els.stage.dataset.side = side ?? '';
  els.banner.textContent = token ? (v.banner ?? '') : '';
  els.stage.dataset.state = token ? v.state : 'INVALID_SESSION';
  els.stage.dataset.level = v.alertLevel;
  const r = rear && now - rearAt < 3000 ? rear : null;
  els.stats.textContent = [
    `State: ${v.state}  Frame age: ${f.frameAgeMs === null ? '-' : Math.round(f.frameAgeMs) + ' ms'}  Frames: ${framesDrawn}${lastCloseNote && v.state !== 'LIVE' ? '  (' + lastCloseNote + ')' : ''}`,
    `Nearest box: ${nearestText()}` + (r ? '  ' : '') + (r ? `Detections/s: ${r.inferFps ?? '-'}  Camera fps: ${r.captureFps ?? '-'}  Latency p95: ${r.inferP95Ms ?? '-'} ms` : 'Rear status: -'),
  ].join('\n');
  els.detail.textContent = newestMeta && (v.state === 'LIVE' || v.state === 'DELAYED') ? newestMeta.alert.reasons.join('; ') : '';

  if (prevState && prevState !== v.state && (v.state === 'STALE' || v.state === 'DISCONNECTED' || v.state === 'DETECTOR_UNAVAILABLE')) tone(300, 500);
  prevView = v;
  prevState = v.state;

  // A socket that looks open but has been silent for 5 s (the server sends a status every second), or one that never finished
  // connecting within 5 s, is dead: drop it and reconnect now instead of waiting for a close event that may never come.
  if (ws && ((socketOpen && lastMsgAt !== null && now - lastMsgAt > 5000) || (!socketOpen && now - connectStartedAt > 5000))) {
    lastCloseNote = socketOpen ? 'silent for 5 s' : 'no answer in 5 s';
    abandon(ws);
    reconnectSoon(300);
  }
}

function wake(): void {
  // back from the lock screen or another app: do not wait for the backoff timer
  if (!token || document.visibilityState === 'hidden') return;
  if (ws && socketOpen && lastMsgAt !== null && performance.now() - lastMsgAt > 3000) abandon(ws);
  if (!ws) {
    attempt = 0;
    reconnectSoon(0);
  }
}
document.addEventListener('visibilitychange', wake);
window.addEventListener('online', wake);
window.addEventListener('pageshow', (e) => {
  if ((e as PageTransitionEvent).persisted) location.reload(); // restored from the back/forward cache: start clean
  else wake();
});

function setFullScreen(on: boolean): void {
  els.stage.classList.toggle('fs', on);
  const el = els.stage as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (on) (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.());
    else if (document.fullscreenElement) void document.exitFullscreen();
  } catch {
    /* iPhone Safari only supports full screen for <video>; the page-level mode above still works */
  }
}
els.fs.onclick = () => setFullScreen(true);
els.exitFs.onclick = () => setFullScreen(false);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) els.stage.classList.remove('fs');
});

function showMirror(): void {
  els.mirror.textContent = `Mirror: ${mirror ? 'on' : 'off'}`;
}
els.mirror.onclick = () => {
  mirror = !mirror;
  store('rv_mirror', mirror ? '1' : '0');
  showMirror();
  paint();
};
showMirror();

// A new link opened in the same tab only changes the fragment: reload so the new token is used.
window.addEventListener('hashchange', () => location.reload());
if (token) connect();
window.setInterval(render, 250);
window.setInterval(beepTick, 30);
window.setInterval(sendPing, 2000);
render();
