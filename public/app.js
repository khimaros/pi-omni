// pi-omni minimal voice web UI.
//
// All state-machine logic lives in ./state.js as a pure reducer. This
// file is the driver: it owns DOM, audio I/O, WS, mic plumbing, and
// timers, and translates between them and the reducer via:
//
//   dispatch(event)  →  reduce(state, event)  →  { state, actions }
//                        ↓                          ↓
//                    applyState (DOM diff)      runAction (I/O)
//
// I/O completions (chime done, mic opened, ws message, worklet drained,
// VAD speech start/end) dispatch follow-up events back into the reducer.

import {
  reduce,
  initialState,
  PHASES,
  ARP_PHASES,
  TARGET_CAPTURE_RATE,
} from "./state.js";

// === Tunables (ms) ===========================================================
const HOLD_THRESHOLD_MS = 250;     // press duration that promotes tap → PTT
const CHIME_TAIL_PAUSE_MS = 200;   // silence after chime before next side-effect
// Wait after stopping the mic before the next audio output can play
// cleanly. micVad.pause() / track.stop() return as soon as JS marks the
// tracks dead, but the OS audio-routing reconfigure continues
// asynchronously — playing anything during that window clips the onset.
const MIC_OFF_SETTLE_MS = 120;

// === DOM refs ================================================================
const startOverlay = document.getElementById("start-overlay");
const startOrb = document.getElementById("start-orb");
const orbEl = document.getElementById("orb");
const orbDot = orbEl.querySelector(".dot");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const assistantEl = document.getElementById("assistant");
const progressEl = document.getElementById("progress");
const progressBar = progressEl.querySelector(".bar");
const startHint = document.getElementById("start-hint");

function setStatus(s) { statusEl.textContent = s; }
function setBodyState(name, on) { document.body.classList.toggle(name, on); }
function setMicOn(on) { document.body.classList.toggle("mic-on", on); }
function setTranscript(s) { transcriptEl.textContent = s; }
function setAssistant(s) { assistantEl.textContent = s; }
function appendAssistant(s) { assistantEl.textContent += s; }

// === Reducer state + driver ==================================================
let state = initialState;
function dispatch(event) {
  const prev = state;
  const { state: next, actions } = reduce(prev, event);
  state = next;
  applyState(prev, next);
  for (const action of actions) runAction(action);
}

// Diff state → DOM. Only updates classes/text that actually changed.
function applyState(prev, next) {
  if (prev.sessionMode !== next.sessionMode) {
    setMicOn(next.sessionMode === "live" || next.sessionMode === "ptt");
  }
  if (prev.phase !== next.phase) {
    for (const p of PHASES) setBodyState(p, p === next.phase);
    setStatus(next.phase);
  }
  if (prev.errorMessage !== next.errorMessage && next.errorMessage) {
    setStatus(`error: ${next.errorMessage}`);
    setBodyState("error", true);
  }
}

function runAction(action) {
  switch (action.type) {
    case "OPEN_LIVE":     openLive(); break;
    case "OPEN_PTT":      openPtt(action.fromLive); break;
    case "CLOSE_LIVE":    closeLive(); break;
    case "CLOSE_PTT":     closePtt(); break;
    case "ARP_START":     arp?.start(); break;
    case "ARP_STOP":      arp?.stop(); break;
    case "WS_SEND":       wsSendJson(action.msg); break;
    case "WS_FLUSH_VAD":  flushVad(); break;
    case "WS_FLUSH_PTT":  flushPtt(); break;
    case "WORKLET_RESET": playerNode?.port.postMessage({ type: "reset" }); break;
    case "HIDE_OVERLAY":  startOverlay.classList.add("hidden"); break;
    default:
      console.warn("[driver] unknown action:", action.type);
  }
}

// === Per-session driver state (NOT in reducer) ===============================
let ws = null;
let ttsSampleRate = 24000;
let playerCtx = null;
let playerNode = null;
let micVad = null;
let arp = null;
// Parallel buffer of VAD-processed frames during a speech segment, used
// for mid-utterance flush when the user pauses live mid-sentence.
let vadBuffer = [];
// Complete utterance handed to us by the VAD library on onSpeechEnd —
// preferred over vadBuffer in the natural-end case (no leading-consonant clip).
let vadEndAudio = null;
// Did the most recent WS_FLUSH_PTT actually have data? Read by closePtt
// to inform the reducer via CLOSE_DONE.hadAudio.
let pttHadAudio = false;

let serverWantsAutoStart = false;
let prefetchDone = false;
let started = false;
let startPromise = null;
let holdTimer = null;       // start-orb hold timer
let mainHoldTimer = null;   // main-orb hold timer

// === Prefetch ================================================================
const PREFETCH = [
  { url: "/vendor/ort/ort-wasm-simd-threaded.wasm", label: "onnx runtime" },
  { url: "/vendor/vad-web/silero_vad_v5.onnx",       label: "vad model" },
];
const prefetchState = PREFETCH.map(() => ({ loaded: 0, total: 0, done: false }));

function updateProgress() {
  let loaded = 0, total = 0, allKnown = true;
  for (const s of prefetchState) {
    loaded += s.loaded;
    if (s.total > 0) total += s.total;
    else allKnown = false;
  }
  if (total > 0) {
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    progressBar.style.width = pct + "%";
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    startHint.textContent = allKnown
      ? `downloading voice model… ${mb(loaded)} / ${mb(total)} MB`
      : `downloading voice model… ${mb(loaded)} MB`;
  }
  if (prefetchState.every((s) => s.done)) {
    progressEl.classList.add("hidden");
    const failures = prefetchState
      .map((s, i) => (s.failed ? PREFETCH[i] : null))
      .filter(Boolean);
    if (failures.length > 0) {
      startHint.textContent =
        `failed to load ${failures.map((f) => f.label).join(", ")} — ` +
        `check server logs (vendor asset 404s)`;
      document.body.classList.add("error");
      return;
    }
    startHint.textContent = "push to talk or tap to toggle voice detection";
    startOrb.classList.remove("disabled");
    prefetchDone = true;
    maybeAutoStart();
  }
}

function maybeAutoStart() {
  if (!serverWantsAutoStart || !prefetchDone || started) return;
  started = true;
  start()
    .then(() => {
      startOverlay.classList.add("hidden");
    })
    .catch((e) => {
      console.warn("[autostart] failed:", e?.message ?? e);
      started = false;
      startHint.textContent = "push to talk or tap to toggle voice detection";
    });
}

async function prefetchOne(i) {
  const { url } = PREFETCH[i];
  try {
    const resp = await fetch(url, { cache: "force-cache" });
    if (!resp.ok || !resp.body) throw new Error(`${resp.status}`);
    const lenHeader = resp.headers.get("Content-Length");
    if (lenHeader) prefetchState[i].total = Number(lenHeader);
    const reader = resp.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      prefetchState[i].loaded += value.byteLength;
      updateProgress();
    }
    prefetchState[i].done = true;
    updateProgress();
  } catch (e) {
    prefetchState[i].done = true;
    prefetchState[i].failed = true;
    console.error(`[prefetch] failed to load ${PREFETCH[i].label} (${url}):`, e);
    updateProgress();
  }
}

if (!window.isSecureContext) {
  console.error("[start] insecure origin:", location.origin);
  startHint.textContent =
    `insecure origin (${location.origin}) — needs HTTPS or localhost. ` +
    `Tunnel: ssh -L ${location.port}:localhost:${location.port} <host>`;
  document.body.classList.add("error");
  progressEl.classList.add("hidden");
} else {
  progressEl.classList.remove("hidden");
  PREFETCH.forEach((_, i) => prefetchOne(i));
}

// === Chime ===================================================================
async function playChime(reverse) {
  if (!playerCtx) return;
  // Await resume — scheduling notes while the context is still ramping
  // up clips the chime's onset, especially when it's been idle for a bit.
  if (playerCtx.state === "suspended") {
    try { await playerCtx.resume(); } catch {}
  }
  // Blend into the arp if it's running.
  const blend = arp?.active === true;
  const dest = blend ? arp.master : playerCtx.destination;
  const reverbSend = blend ? arp.delay : null;
  const peakGain = blend ? 0.10 : 0.22;
  const sineGain = blend ? 0.4 : 0.5;
  const notes = reverse ? [1046.5, 783.99] : [783.99, 1046.5];
  const noteDur = 0.16;
  const stagger = 0.09;
  const leadSec = 0.005;
  const now = playerCtx.currentTime + leadSec;
  for (let i = 0; i < notes.length; i++) {
    const t0 = now + i * stagger;
    const freq = notes[i];
    const oscTri = playerCtx.createOscillator();
    oscTri.type = "triangle";
    oscTri.frequency.value = freq;
    const oscSin = playerCtx.createOscillator();
    oscSin.type = "sine";
    oscSin.frequency.value = freq * 2;
    const g = playerCtx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peakGain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + noteDur);
    const gSin = playerCtx.createGain();
    gSin.gain.value = sineGain;
    oscTri.connect(g);
    oscSin.connect(gSin);
    gSin.connect(g);
    g.connect(dest);
    if (reverbSend) g.connect(reverbSend);
    oscTri.start(t0);
    oscSin.start(t0);
    oscTri.stop(t0 + noteDur + 0.04);
    oscSin.stop(t0 + noteDur + 0.04);
  }
  const totalSec = leadSec + (notes.length - 1) * stagger + noteDur + 0.04;
  await new Promise((r) => setTimeout(r, Math.ceil(totalSec * 1000)));
}

async function playChimeAndPause(reverse) {
  if (startPromise) { try { await startPromise; } catch { return; } }
  await playChime(reverse);
  await new Promise((r) => setTimeout(r, CHIME_TAIL_PAUSE_MS));
}

// === Arpeggiator =============================================================
class Arpeggiator {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
    this.active = false;
    this.scale = [
      261.63, 293.66, 329.63, 392.0, 440.0,
      523.25, 587.33, 659.25, 783.99,
    ];
    this.master = ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(ctx.destination);
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.22;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.55;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.5;
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.master);
  }
  start() {
    if (this.active) return;
    this.active = true;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(1.0, now);
    try { this.master.connect(this.ctx.destination); } catch {}
    const intervalMs = 180;
    const tick = () => {
      if (!this.active) return;
      this.playNote();
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }
  stop() {
    this.active = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0, now);
    try { this.master.disconnect(); } catch {}
  }
  playNote() {
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    const now = this.ctx.currentTime;
    const freq = this.scale[Math.floor(Math.random() * this.scale.length)];
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.08, now + 0.025);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(env);
    env.connect(this.master);
    env.connect(this.delay);
    osc.start(now);
    osc.stop(now + 0.65);
  }
}

// === Open / close composites =================================================
async function openLive() {
  if (startPromise) {
    try { await startPromise; }
    catch { dispatch({ type: "OPEN_ERROR", message: "start failed" }); return; }
  }
  try {
    await playChimeAndPause(false);
    if (state.sessionMode !== "live") return; // user toggled away
    await ensureLiveMic();
    dispatch({ type: "OPEN_DONE", kind: "live" });
  } catch (e) {
    console.error("[live] mic init failed:", e);
    dispatch({ type: "OPEN_ERROR", message: `mic: ${e.message ?? e}` });
  }
}

async function openPtt(fromLive) {
  if (startPromise) {
    try { await startPromise; }
    catch { dispatch({ type: "OPEN_ERROR", message: "start failed" }); return; }
  }
  // Silently pause the live mic if it's running — don't chime, the PTT
  // open chime will play in a moment.
  if (fromLive && micVad) {
    try { await micVad.pause(); } catch {}
    vadBuffer = [];
    vadEndAudio = null;
    await new Promise((r) => setTimeout(r, MIC_OFF_SETTLE_MS));
  }
  try {
    await playChimeAndPause(false);
    if (state.sessionMode !== "ptt") return;
    await ensurePttMic();
    if (pttCtx.state === "suspended") { try { await pttCtx.resume(); } catch {} }
    pttBuffer = [];
    dispatch({ type: "OPEN_DONE", kind: "ptt" });
  } catch (e) {
    console.error("[ptt] mic init failed:", e);
    dispatch({ type: "OPEN_ERROR", message: `mic: ${e.message ?? e}` });
  }
}

async function closeLive() {
  await releaseLiveMic();
  await playChimeAndPause(true);
  dispatch({ type: "CLOSE_DONE", hadAudio: true });
}

async function closePtt() {
  const hadAudio = pttHadAudio;
  pttHadAudio = false;
  await releasePttMic();
  await playChimeAndPause(true);
  dispatch({ type: "CLOSE_DONE", hadAudio });
}

async function releaseLiveMic() {
  if (!micVad) return;
  try { await micVad.pause(); } catch {}
  vadBuffer = [];
  vadEndAudio = null;
  await new Promise((r) => setTimeout(r, MIC_OFF_SETTLE_MS));
}

async function releasePttMic() {
  if (!pttCtx) return;
  try { pttProcessor?.disconnect(); } catch {}
  try { pttSource?.disconnect(); } catch {}
  try { pttStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { pttCtx.close(); } catch {}
  pttCtx = null;
  pttStream = null;
  pttSource = null;
  pttProcessor = null;
  await new Promise((r) => setTimeout(r, MIC_OFF_SETTLE_MS));
}

// === Utterance flush =========================================================
function flushVad() {
  // Prefer the library-provided complete utterance (clean leading edge)
  // when available. Fall back to the parallel-buffered frames for the
  // mid-utterance pause case.
  if (vadEndAudio) {
    sendUtterance(vadEndAudio);
    vadEndAudio = null;
    vadBuffer = [];
    return;
  }
  if (vadBuffer.length === 0) return;
  const total = vadBuffer.reduce((n, a) => n + a.length, 0);
  const flat = new Float32Array(total);
  let off = 0;
  for (const c of vadBuffer) { flat.set(c, off); off += c.length; }
  vadBuffer = [];
  sendUtterance(flat);
}

function flushPtt() {
  const total = pttBuffer.reduce((n, a) => n + a.length, 0);
  if (total === 0) { pttHadAudio = false; return; }
  const flat = new Float32Array(total);
  let off = 0;
  for (const chunk of pttBuffer) { flat.set(chunk, off); off += chunk.length; }
  pttBuffer = [];
  sendUtterance(flat);
  pttHadAudio = true;
}

// === Pointer handlers ========================================================
startOrb.addEventListener("pointerdown", (e) => {
  if (startOrb.classList.contains("disabled") || started) return;
  if (document.body.classList.contains("reconnecting")) return;
  e.preventDefault();
  try { startOrb.setPointerCapture(e.pointerId); } catch {}
  startOrb.classList.add("disabled");
  started = true;
  holdTimer = setTimeout(() => { holdTimer = null; dispatch({ type: "HOLD" }); }, HOLD_THRESHOLD_MS);
  startPromise = start().catch((err) => {
    console.error("[start] failed:", err);
    setStatus(`error: ${err.message ?? err}`);
    setBodyState("error", true);
    startOrb.classList.remove("disabled");
    started = false;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    throw err;
  });
});

async function onStartOrbRelease() {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (startPromise) { try { await startPromise; } catch { return; } }
    dispatch({ type: "TAP" });
    return;
  }
  if (state.sessionMode === "ptt") dispatch({ type: "RELEASE" });
}
startOrb.addEventListener("pointerup", onStartOrbRelease);
startOrb.addEventListener("pointercancel", onStartOrbRelease);

orbDot.addEventListener("pointerdown", (e) => {
  if (!started || state.sessionMode === "ptt") return;
  if (document.body.classList.contains("reconnecting")) return;
  e.preventDefault();
  try { orbDot.setPointerCapture(e.pointerId); } catch {}
  mainHoldTimer = setTimeout(() => { mainHoldTimer = null; dispatch({ type: "HOLD" }); }, HOLD_THRESHOLD_MS);
});

function onMainOrbUp() {
  if (mainHoldTimer) {
    clearTimeout(mainHoldTimer);
    mainHoldTimer = null;
    dispatch({ type: "TAP" });
    return;
  }
  if (state.sessionMode === "ptt") dispatch({ type: "RELEASE" });
}
orbDot.addEventListener("pointerup", onMainOrbUp);
orbDot.addEventListener("pointercancel", onMainOrbUp);

// === start() bring-up ========================================================
async function start() {
  if (!window.isSecureContext) {
    throw new Error(
      `insecure origin (${location.origin}) — pi-omni-web needs HTTPS or ` +
      `localhost. Tunnel with: ssh -L ${location.port}:localhost:${location.port} <host>`,
    );
  }
  playerCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  try { await playerCtx.resume(); } catch {}
  await playerCtx.audioWorklet.addModule("worklet.js");
  playerNode = new AudioWorkletNode(playerCtx, "pcm-player");
  playerNode.connect(playerCtx.destination);
  playerNode.port.onmessage = (e) => {
    if (e.data?.type === "drained") dispatch({ type: "WORKLET_DRAINED" });
  };
  arp = new Arpeggiator(playerCtx);
  await openWs();
  await initSession();
}

async function initMic() {
  if (micVad) return;
  if (!window.vad || !window.vad.MicVAD) {
    throw new Error("vad-web library not loaded");
  }
  setStatus("loading VAD model…");
  micVad = await window.vad.MicVAD.new({
    model: "v5",
    baseAssetPath: "/vendor/vad-web/",
    onnxWASMBasePath: "/vendor/ort/",
    additionalAudioConstraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    minSpeechFrames: 16,
    redemptionFrames: 6,
    preSpeechPadFrames: 3,
    onFrameProcessed: (_probs, frame) => {
      if (state.vadSpeaking) vadBuffer.push(new Float32Array(frame));
    },
    onSpeechStart: () => {
      if (!ws || ws.readyState !== 1) return;
      vadBuffer = [];
      vadEndAudio = null;
      dispatch({ type: "VAD_SPEECH_START" });
    },
    onSpeechEnd: (audio) => {
      if (!ws || ws.readyState !== 1) return;
      vadEndAudio = audio;
      dispatch({ type: "VAD_SPEECH_END" });
    },
    onVADMisfire: () => {
      if (!ws || ws.readyState !== 1) return;
      vadBuffer = [];
      vadEndAudio = null;
      dispatch({ type: "VAD_MISFIRE" });
    },
  });
  await micVad.start();
}

async function ensureLiveMic() {
  if (!micVad) await initMic();
  else await micVad.start();
}

let pttCtx = null;
let pttStream = null;
let pttSource = null;
let pttProcessor = null;
let pttBuffer = [];

async function ensurePttMic() {
  if (pttCtx) return;
  pttCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: TARGET_CAPTURE_RATE,
  });
  pttStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  pttSource = pttCtx.createMediaStreamSource(pttStream);
  pttProcessor = pttCtx.createScriptProcessor(2048, 1, 1);
  pttProcessor.onaudioprocess = (e) => {
    if (!state.pttHeld) return;
    pttBuffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  pttSource.connect(pttProcessor);
  pttProcessor.connect(pttCtx.destination);
}

// === WebSocket ===============================================================
let reconnectTimer = null;
let reconnectDelayMs = 500;

function resetSessionState() {
  // Local DOM/transport cleanup. The reducer handles its own state via WS_CLOSE.
  setStatus("reconnecting");
}

async function initSession() {
  if (state.sessionMode === "live" && !micVad) await initMic();
  // If reducer hasn't been told a phase yet (initial bring-up or post-reset),
  // apply the resting phase. Otherwise leave alone — the session-mode
  // handler that triggered start() owns the phase.
  if (state.phase === "paused" && state.sessionMode !== "pause") {
    // Live or PTT triggered start; their OPEN_DONE will set phase.
    return;
  }
}

function openWs(isReconnect = false) {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    let settled = false;
    ws.addEventListener("open", () => {
      reconnectDelayMs = 500;
      setBodyState("error", false);
      setBodyState("reconnecting", false);
      dispatch({ type: "WS_OPEN" });
      settled = true;
      resolve();
    });
    ws.addEventListener("error", () => {
      if (!settled && !isReconnect) {
        settled = true;
        reject(new Error("ws connect failed"));
      }
    });
    ws.addEventListener("close", () => {
      setBodyState("error", true);
      setBodyState("reconnecting", true);
      dispatch({ type: "WS_CLOSE" });
      resetSessionState();
      scheduleReconnect();
    });
    ws.addEventListener("message", onWsMessage);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await openWs(true);
      await initSession();
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

function onWsMessage(ev) {
  if (typeof ev.data === "string") {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleControl(msg);
    return;
  }
  // Binary: PCM frame.
  const i16 = new Int16Array(ev.data);
  if (state.workletEmpty) dispatch({ type: "PCM_FIRST" });
  playerNode.port.postMessage({ type: "pcm", samples: i16 }, [i16.buffer]);
}

function handleControl(msg) {
  switch (msg.type) {
    case "hello":
      ttsSampleRate = msg.ttsSampleRate ?? 24000;
      playerNode.port.postMessage({ type: "init", sourceRate: ttsSampleRate });
      serverWantsAutoStart = !!msg.autoStart;
      if (typeof msg.orbGlyph === "string" && msg.orbGlyph !== "") {
        orbEl.classList.remove("orb-glyph-css", "glyph-play", "glyph-wave", "glyph-pause", "glyph-square");
        document.querySelector("#orb .glyph").textContent = msg.orbGlyph;
      }
      maybeAutoStart();
      break;
    case "status":
      if (msg.message === "empty transcription") dispatch({ type: "STATUS_EMPTY" });
      break;
    case "transcript":
      setTranscript(msg.text ?? "");
      setAssistant("");
      dispatch({ type: "TRANSCRIPT" });
      break;
    case "llm_delta":
      if (typeof msg.text === "string") appendAssistant(msg.text);
      break;
    case "llm_text":
      if (typeof msg.text === "string") setAssistant(msg.text);
      break;
    case "tts_start":
      dispatch({ type: "TTS_START" });
      break;
    case "tts_cancel":
      dispatch({ type: "TTS_CANCEL" });
      break;
    case "tts_end":
      dispatch({ type: "TTS_END" });
      break;
    case "agent_end":
      dispatch({ type: "AGENT_END" });
      break;
    case "error":
      dispatch({ type: "ERROR", message: msg.message });
      break;
  }
}

function sendUtterance(f32) {
  if (!ws || ws.readyState !== 1) return;
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let v = Math.round(f32[i] * 32768);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    i16[i] = v;
  }
  ws.send(i16.buffer);
}

function wsSendJson(obj) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}
