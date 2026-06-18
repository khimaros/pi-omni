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
import { ensureAudioRunning } from "./audio.js";
import {
  formatComponent,
  reduceAssistant,
  initialAssistant,
} from "./components.js";
import { createPtt } from "./ptt.js";

// === Tunables (ms) ===========================================================
const HOLD_THRESHOLD_MS = 250;     // press duration that promotes tap → PTT
const CHIME_TAIL_PAUSE_MS = 200;   // silence after chime before next side-effect
// Wait after AudioContext.resume() before scheduling playback. Mobile
// browsers need a moment for the OS audio session to settle after a
// transition (interrupted/suspended → running) before scheduled
// oscillators are reliably audible.
const AUDIO_SESSION_RESUME_MS = 80;
// Max time to wait on a prefetch response body before assuming the
// resource is already cached and moving on. Firefox android can hang
// forever reading a cached response body (see prefetchOne); a hang only
// happens when the cache is already warm, so the timeout is safe.
const PREFETCH_BODY_TIMEOUT_MS = 3000;

// === DOM refs ================================================================
const orbEl = document.getElementById("orb");
const orbDot = orbEl.querySelector(".dot");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const assistantEl = document.getElementById("assistant");
const startHint = document.getElementById("start-hint");

function setStatus(s) { statusEl.textContent = s; }
function setBodyState(name, on) { document.body.classList.toggle(name, on); }
function setMicOn(on) { document.body.classList.toggle("mic-on", on); }
function setTranscript(s) { transcriptEl.textContent = s; }
// Render the assistant slot from the {chip, text} model. Called after
// every assistant-display state update so chip/text changes are
// reflected atomically (chip and text live in the same element so
// "replace chip with text" never leaves a stale chip behind).
let hasHistory = false;
let assistantDisplay = initialAssistant;
function renderAssistant() {
  assistantEl.textContent = "";
  if (assistantDisplay.chip) {
    const chip = document.createElement("span");
    chip.className = "component-chip";
    chip.textContent = assistantDisplay.chip;
    assistantEl.appendChild(chip);
  }
  if (assistantDisplay.text) {
    const span = document.createElement("span");
    span.className = "assistant-text";
    span.textContent = assistantDisplay.text;
    assistantEl.appendChild(span);
  }
}
function updateAssistant(event) {
  assistantDisplay = reduceAssistant(assistantDisplay, event);
  renderAssistant();
}

// === Event log (ring buffer) =================================================
// Captures every dispatched event + resulting phase/flag transitions and
// the actions the reducer emitted, with millisecond timestamps relative
// to page load. Exposed on window.__pilog for in-browser inspection and
// copied to clipboard via the #debug-copy button (visible when body.debug
// is set). Helps diagnose timing races on devices without a debugger.
const LOG_CAP = 200;
const eventLog = [];
const logT0 = performance.now();
function logEvent(entry) {
  eventLog.push(entry);
  if (eventLog.length > LOG_CAP) eventLog.shift();
}
function formatLogLine(e) {
  const t = e.t.toFixed(0).padStart(6);
  const ev = (e.event ?? "").padEnd(18);
  const phase = e.phase ? `→${e.phase}` : "";
  const flags = e.flags ?? "";
  const actions = e.actions?.length ? ` [${e.actions.join(",")}]` : "";
  const extra = e.note ? ` ${e.note}` : "";
  return `${t} ${ev}${phase} ${flags}${actions}${extra}`;
}
if (typeof window !== "undefined") {
  window.__pilog = eventLog;
  // Debug copy button is shown only when the page is loaded with ?debug=1.
  try {
    if (new URLSearchParams(location.search).get("debug") === "1") {
      document.body.classList.add("debug");
    }
  } catch {}
  const debugCopyBtn = document.getElementById("debug-copy");
  debugCopyBtn?.addEventListener("click", async () => {
    const text = eventLog.map(formatLogLine).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      debugCopyBtn.classList.add("copied");
    } catch {
      debugCopyBtn.classList.add("failed");
    }
    setTimeout(() => {
      debugCopyBtn.classList.remove("copied", "failed");
    }, 1200);
  });
}

// === Reducer state + driver ==================================================
let state = initialState;
function dispatch(event) {
  const prev = state;
  const { state: next, actions } = reduce(prev, event);
  state = next;
  const flags = [
    next.thinking ? "T" : "-",
    next.speaking ? "S" : "-",
    next.gotText ? "G" : "-",
    `m=${next.sessionMode[0]}`,
  ].join("");
  logEvent({
    t: performance.now() - logT0,
    event: event.type,
    phase: prev.phase !== next.phase ? next.phase : null,
    flags,
    actions: actions.map((a) => a.type),
  });
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
    case "OPEN_PTT":      openPtt(); break;
    case "CLOSE_LIVE":    captureOpen = false; closeLive(); break;
    case "CLOSE_PTT":     captureOpen = false; closePtt(); break;
    case "PLAY_CHIME":    playChimeAndPause(action.reverse); break;
    case "RELEASE_MIC":   captureOpen = false; releaseMicAction(); break;
    case "ARP_START":     arp?.start(); break;
    case "ARP_STOP":      arp?.stop(); break;
    case "WS_SEND":       wsSendJson(action.msg); break;
    case "WS_FLUSH_VAD":  flushVad(); break;
    case "WS_FLUSH_PTT":  flushPtt(); break;
    case "WORKLET_RESET": playerNode?.port.postMessage({ type: "reset" }); break;
    case "SHOW_PLACEHOLDER":
      updateAssistant({ type: "placeholder" });
      break;
    default:
      console.warn("[driver] unknown action:", action.type);
  }
}

// === Per-session driver state (NOT in reducer) ===============================
let ws = null;
let wsPromise = null;
let ttsSampleRate = 24000;
let playerCtx = null;
let playerNode = null;
let micVad = null;
let arp = null;
// Single source of truth for "frames count toward an utterance right now".
// Flipped to true synchronously after the open chime resolves, and back
// to false synchronously when a CLOSE_LIVE / CLOSE_PTT / RELEASE_MIC
// action handler runs -- strictly BEFORE the close chime is scheduled or
// any flush action reads its buffer. Frame-producing paths (PTT
// processor, VAD callbacks) consult only this flag, never tear the mic
// hardware down between sessions, so the OS audio-session route stays in
// record+play permanently after the first acquire -- chimes hit a stable
// route every time and need no timing fudge factor.
let captureOpen = false;
// Parallel buffer of VAD-processed frames during a speech segment, used
// for mid-utterance flush when the user pauses live mid-sentence.
let vadBuffer = [];
// Complete utterance handed to us by the VAD library on onSpeechEnd --
// preferred over vadBuffer in the natural-end case (no leading-consonant clip).
let vadEndAudio = null;
let prefetchDone = false;
let started = false;
let startPromise = null;
let holdTimer = null;       // promotes a press to HOLD after HOLD_THRESHOLD_MS

// === Session Management State ================================================
const SESSIONS_KEY = "pi_omni_sessions";
const ACTIVE_SESSION_KEY = "pi_omni_active_session";
let currentSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || "";

// === Prefetch ================================================================
const PREFETCH = [
  { url: "/vendor/ort/ort-wasm-simd-threaded.wasm", label: "onnx runtime" },
  { url: "/vendor/vad-web/silero_vad_v5.onnx",       label: "vad model" },
];
const prefetchState = PREFETCH.map(() => ({ done: false }));

function updateProgress() {
  if (prefetchState.every((s) => s.done)) {
    const failures = prefetchState
      .map((s, i) => (s.failed ? PREFETCH[i] : null))
      .filter(Boolean);
    if (failures.length > 0) {
      setStatus(`error: failed to load ${failures.map((f) => f.label).join(", ")}`);
      document.body.classList.add("error");
      return;
    }
    // Hand the status line back to the reducer -- it'll be repainted to
    // the current phase on the next phase change. Set the resting text
    // explicitly here since no phase change fires at prefetch completion.
    setStatus(state.phase);
    startHint.textContent = "push to talk or tap to toggle voice detection";
    if (hasHistory || started) {
      startHint.classList.add("hidden");
    }
    orbEl.classList.remove("disabled");
    prefetchDone = true;
  }
}

async function prefetchOne(i) {
  const { url } = PREFETCH[i];
  try {
    // We only need the side effect of the browser caching the response,
    // so we drain the body to force the download to complete. But on
    // firefox android, reading a *cached* response body can hang forever
    // (neither resolves nor rejects), which strands the UI at
    // "downloading" on every soft refresh. A hang only happens when the
    // resource is already cached -- i.e. the cache is already warm and we
    // don't actually need the body -- so race the read against a timeout
    // and treat the timeout as success. The fetch is left running so a
    // genuine first-load download still completes and populates the cache.
    const resp = await fetch(url, { cache: "force-cache" });
    if (!resp.ok) throw new Error(`${resp.status}`);
    await Promise.race([
      resp.arrayBuffer(),
      new Promise((r) => setTimeout(r, PREFETCH_BODY_TIMEOUT_MS)),
    ]);
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
    `insecure origin (${location.origin}) -- needs HTTPS or localhost. ` +
    `Tunnel: ssh -L ${location.port}:localhost:${location.port} <host>`;
  document.body.classList.add("error");
} else {
  PREFETCH.forEach((_, i) => prefetchOne(i));
  openWs().catch((err) => console.warn("Initial WS connect failed:", err));
}

// === Chime ===================================================================
async function playChime(reverse) {
  if (!playerCtx) return;
  // The mic stays permanently hot now, so playerCtx is normally already
  // running by chime time. This guard remains for two cases: (a) the
  // very first chime, scheduled before the first mic acquire, and (b)
  // an OS-level interrupt (incoming call) that may have parked the
  // context. ensureAudioRunning resumes if needed before we schedule.
  const preState = playerCtx.state;
  await ensureAudioRunning(playerCtx, AUDIO_SESSION_RESUME_MS);
  const postState = playerCtx.state;
  logEvent({
    t: performance.now() - logT0,
    event: `chime-${reverse ? "close" : "open"}`,
    note: `state:${preState}→${postState}`,
  });
  // Blend into the arp if it's running.
  const blend = arp?.active === true;
  const dest = blend ? arp.master : playerCtx.destination;
  const reverbSend = blend ? arp.delay : null;
  const peakGain = blend ? 0.10 : 0.22;
  const sineGain = blend ? 0.4 : 0.5;
  const notes = reverse ? [1046.5, 783.99] : [783.99, 1046.5];
  const noteDur = 0.16;
  const stagger = 0.09;
  // leadSec sits well above the audio thread's quantum so the t0 ramp
  // never lands in the past -- if it did, the 0→peak attack would
  // collapse and the note would start at full gain (or skip entirely).
  // The audio engine itself is kept awake by the keepalive oscillator
  // wired up at start(), so we don't need a per-chime warmup anymore.
  const leadSec = 0.040;
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
//
// The mic track is acquired ONCE (per session-mode kind) on the first
// open and is kept permanently hot from then on. This keeps the OS
// audio session in a stable record+play route across the entire app
// lifetime, eliminating the route renegotiation that previously made
// the open chime fragile on mobile (firefox android).
//
// Capture is gated entirely by the module-level `captureOpen` flag,
// flipped at well-defined points in the lifecycle:
//
//   open:  acquire (once) → ensureAudioRunning → OPEN_DONE → start chime → captureOpen=true
//   close: captureOpen=false (set synchronously by action dispatcher) → end chime → CLOSE_DONE
//
// OPEN_DONE fires BEFORE the start chime so the orb visually transitions
// into the active phase (listening / recording) while the chime is
// playing -- the chime confirms the transition rather than preceding it.
// Capture still doesn't begin until the chime resolves, gated by
// `captureOpen` flipping at the very end.
//
// Frames start being captured the instant the open chime resolves, and
// stop being captured the instant the close action is dispatched
// (strictly before the close chime begins). `release` callbacks are
// retained only so the reducer can model micOpen, but they perform no
// actual hardware teardown.

async function openMicLifecycle({ sessionMode, prepare, acquire, onReady }) {
  if (startPromise) {
    try { await startPromise; }
    catch { dispatch({ type: "OPEN_ERROR", message: "start failed" }); return; }
  }
  try {
    await ensureAudioRunning(playerCtx, AUDIO_SESSION_RESUME_MS);
    if (prepare) await prepare();
    if (state.sessionMode !== sessionMode) return;
    // First-call only: acquire the mic hardware. Subsequent opens are
    // no-ops because the track is kept alive for the lifetime of the
    // page -- see the comment on `captureOpen` for the rationale.
    await acquire();
    if (state.sessionMode !== sessionMode) return;
    dispatch({ type: "OPEN_DONE", kind: sessionMode });
    await playChimeAndPause(false);
    // Re-check: user could have closed during the chime, in which case
    // captureOpen was already flipped to false synchronously and we
    // must not re-flip it.
    if (state.sessionMode !== sessionMode) return;
    onReady?.();
    captureOpen = true;
  } catch (e) {
    console.error(`[${sessionMode}] mic init failed:`, e);
    dispatch({ type: "OPEN_ERROR", message: `mic: ${e.message ?? e}` });
  }
}

async function closeMicLifecycle({ release, getHadAudio = () => true }) {
  // captureOpen was already flipped to false synchronously by the action
  // dispatcher, so any utterance flush in the same action list saw a
  // clean cutoff and the close chime is about to play on a fully gated
  // pipeline.
  await playChimeAndPause(true);
  await release();
  dispatch({ type: "CLOSE_DONE", hadAudio: getHadAudio() });
}

async function openLive() {
  return openMicLifecycle({ sessionMode: "live", acquire: ensureLiveMic });
}

async function openPtt() {
  return openMicLifecycle({
    sessionMode: "ptt",
    acquire: async () => {
      await ensurePttMic();
      if (pttCtx?.state === "suspended") { try { await pttCtx.resume(); } catch {} }
    },
    onReady: () => ptt.reset(),
  });
}

async function closeLive() {
  return closeMicLifecycle({ release: releaseLiveMic });
}

async function closePtt() {
  // getHadAudio is read AFTER the chime/release awaits resolve, so it
  // observes the post-flush value. flush() runs synchronously between
  // CLOSE_PTT and audio_end in the RELEASE reducer's action list -- by
  // the time closeMicLifecycle's first await yields, flush has already
  // populated hadAudio.
  return closeMicLifecycle({
    release: releasePttMic,
    getHadAudio: () => ptt.consumeHadAudio(),
  });
}

// RELEASE_MIC fires from the reducer when a phase transition ends in a
// resting state with the mic still flagged open (e.g. TTS completed in
// pause mode after a barge-in cancel). captureOpen is already false
// (dispatcher flipped it synchronously); we only need to drain the VAD
// buffers and let the reducer settle.
async function releaseMicAction() {
  vadBuffer = [];
  vadEndAudio = null;
  dispatch({ type: "CLOSE_DONE", hadAudio: true });
}

// Close-path release: no hardware teardown. Just drain any in-flight
// VAD scratch state so the next open starts clean.
async function releaseLiveMic() {
  vadBuffer = [];
  vadEndAudio = null;
}

async function releasePttMic() {
  // ptt buffer is reset on the next openPtt's onReady (ptt.reset()).
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
  ptt.flush();
}

// === Pointer handlers ========================================================
// Single gesture target: the main orb handles both first-press
// bring-up and ongoing TAP/HOLD. First press synchronously creates +
// resumes the AudioContext inside the gesture frame (Firefox Android
// and Safari iOS both reject deferred resume() outside a gesture), then
// kicks off the async start() for worklet/WS/VAD setup.
orbDot.addEventListener("pointerdown", (e) => {
  if (orbEl.classList.contains("disabled")) return;
  if (document.body.classList.contains("reconnecting")) return;
  if (state.sessionMode === "ptt") return; // already holding
  e.preventDefault();
  try { orbDot.setPointerCapture(e.pointerId); } catch {}
  if (!started) {
    ensurePlayerCtx();
    started = true;
    startPromise = start().then(() => {
      startHint.classList.add("hidden");
    }).catch((err) => {
      console.error("[start] failed:", err);
      setStatus(`error: ${err.message ?? err}`);
      setBodyState("error", true);
      started = false;
      startHint.classList.remove("hidden");
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      throw err;
    });
  }
  holdTimer = setTimeout(() => { holdTimer = null; dispatch({ type: "HOLD" }); }, HOLD_THRESHOLD_MS);
});

async function onOrbUp() {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
    dispatch({ type: "TAP" });
    return;
  }
  if (state.sessionMode === "ptt") dispatch({ type: "RELEASE" });
}
orbDot.addEventListener("pointerup", onOrbUp);
orbDot.addEventListener("pointercancel", onOrbUp);

// === start() bring-up ========================================================
// Create + sync-resume the player AudioContext. Must be called from a
// real user gesture (pointerdown handler) or mobile browsers will
// leave the context suspended and silently drop chime/TTS playback.
function ensurePlayerCtx() {
  if (playerCtx) return;
  // "playback" (larger output buffer) over "interactive": firefox android
  // underruns the tiny interactive buffer on weak mobile cpus, crackling
  // everything routed through this context (arp tones and tts alike). the
  // extra output latency is harmless on the speaker side.
  playerCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
  // Diagnostic: surface state transitions so we can tell whether mobile
  // Firefox is moving the context to "interrupted" or "suspended" while
  // we sit idle in listening. Logged to #eventlog (visible on device).
  playerCtx.addEventListener("statechange", () => {
    logEvent({
      t: performance.now() - logT0,
      event: "playerCtx-state",
      note: playerCtx.state,
    });
  });
  try { playerCtx.resume(); } catch {}
}

async function start() {
  if (!window.isSecureContext) {
    throw new Error(
      `insecure origin (${location.origin}) -- pi-omni needs HTTPS or ` +
      `localhost. Tunnel with: ssh -L ${location.port}:localhost:${location.port} <host>`,
    );
  }
  ensurePlayerCtx();
  await playerCtx.audioWorklet.addModule("worklet.js");
  playerNode = new AudioWorkletNode(playerCtx, "pcm-player");
  playerNode.connect(playerCtx.destination);
  playerNode.port.onmessage = (e) => {
    if (e.data?.type === "drained") dispatch({ type: "WORKLET_DRAINED" });
  };
  playerNode.port.postMessage({ type: "init", sourceRate: ttsSampleRate });
  arp = new Arpeggiator(playerCtx);
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    await openWs();
  } else if (ws.readyState === WebSocket.CONNECTING) {
    await wsPromise;
  }
  await initSession();
}

async function initMic() {
  if (micVad) return;
  if (!window.vad || !window.vad.MicVAD) {
    throw new Error("vad-web library not loaded");
  }
  setStatus("initializing");
  // Resolves when VAD emits its very first processed frame -- proves the
  // worklet is actually pulling audio, not just hooked up. The open
  // chime is gated on this so the user can't speak before VAD is truly
  // listening.
  let firstFrame;
  const firstFrameReady = new Promise((r) => { firstFrame = r; });
  let firstFrameSeen = false;
  // Let MicVAD own its capture AudioContext. Sharing playerCtx put a mic
  // input on the playback context, which forces mobile browsers into
  // voice-communication mode (lower rate, tiny buffers, output AEC) and
  // makes everything routed through it choppy -- the arp worst of all,
  // since its multi-node envelopes underrun before the cheap pcm copy.
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
    // captureOpen gates all VAD-side events. False outside the open
    // chime → close action window; true only when frames legitimately
    // belong to an active utterance. Mirrors the PTT processor gate.
    onFrameProcessed: (_probs, frame) => {
      if (!firstFrameSeen) { firstFrameSeen = true; firstFrame(); }
      if (captureOpen && state.vadSpeaking) vadBuffer.push(new Float32Array(frame));
    },
    onSpeechStart: () => {
      if (!ws || ws.readyState !== 1 || !captureOpen) return;
      vadBuffer = [];
      vadEndAudio = null;
      dispatch({ type: "VAD_SPEECH_START" });
    },
    onSpeechEnd: (audio) => {
      if (!ws || ws.readyState !== 1 || !captureOpen) return;
      // Drop a speech segment whose start we never accepted: if it began
      // before captureOpen (e.g. talking as you tap "live"), onSpeechStart
      // was gated out, but the library's `audio` still spans the pre-live
      // portion. Without this guard that pre-live speech gets transcribed.
      if (!state.vadSpeaking) return;
      vadEndAudio = audio;
      dispatch({ type: "VAD_SPEECH_END" });
    },
    onVADMisfire: () => {
      if (!ws || ws.readyState !== 1 || !captureOpen) return;
      vadBuffer = [];
      vadEndAudio = null;
      dispatch({ type: "VAD_MISFIRE" });
    },
  });
  await micVad.start();
  await firstFrameReady;
}

// First-call only: bring up the VAD + mic track. Subsequent calls are
// no-ops because we never pause the VAD -- frame consumption is gated
// by `captureOpen`, not by the mic being on/off.
async function ensureLiveMic() {
  if (!micVad) await initMic();
}

let pttCtx = null;
let pttStream = null;
let pttSource = null;
let pttNode = null;
const ptt = createPtt({
  sendUtterance: (f32) => sendUtterance(f32),
});

// First-call only: bring up the PTT capture context + mic track. Kept
// alive for the rest of the page lifetime; frame consumption is gated
// by `captureOpen` so no concurrent-release race exists.
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
  await pttCtx.audioWorklet.addModule("worklet.js");
  pttSource = pttCtx.createMediaStreamSource(pttStream);
  pttNode = new AudioWorkletNode(pttCtx, "pcm-capture");
  // captureOpen gates frames on the main thread, mirroring the live VAD
  // path. The node is deliberately NOT connected to destination -- see the
  // pcm-capture comment in worklet.js.
  pttNode.port.onmessage = (e) => { if (captureOpen) ptt.push(e.data); };
  pttSource.connect(pttNode);
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
  // apply the resting phase. Otherwise leave alone -- the session-mode
  // handler that triggered start() owns the phase.
  if (state.phase === "paused" && state.sessionMode !== "pause") {
    // Live or PTT triggered start; their OPEN_DONE will set phase.
    return;
  }
}

function openWs(isReconnect = false) {
  wsPromise = new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sessionId = getActiveSessionId();
    const wsUrl = `${proto}://${location.host}/ws${sessionId ? `?sessionId=${sessionId}` : ""}`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    let settled = false;
    ws.addEventListener("open", () => {
      reconnectDelayMs = 500;
      const wasReconnecting = document.body.classList.contains("reconnecting");
      setBodyState("error", false);
      setBodyState("reconnecting", false);
      dispatch({ type: "WS_OPEN" });
      // WS_OPEN doesn't move phase, so applyState won't refresh the status
      // text. Without this, resetSessionState()'s stale "reconnecting" text
      // survives the reopen and gets painted in the lingering phase color
      // (e.g. thinking amber) -- a yellow "reconnecting".
      if (wasReconnecting) setStatus(state.phase);
      settled = true;
      resolve();
    });
    ws.addEventListener("error", () => {
      if (!settled && !isReconnect) {
        settled = true;
        reject(new Error("ws connect failed"));
      }
    });
    const thisWs = ws;
    ws.addEventListener("close", () => {
      if (ws !== thisWs) return; // intentional teardown (switchSession)
      setBodyState("error", true);
      setBodyState("reconnecting", true);
      dispatch({ type: "WS_CLOSE" });
      resetSessionState();
      scheduleReconnect();
    });
    ws.addEventListener("message", onWsMessage);
  });
  return wsPromise;
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
  if (playerNode) {
    playerNode.port.postMessage({ type: "pcm", samples: i16 }, [i16.buffer]);
  }
}

function handleControl(msg) {
  logEvent({
    t: performance.now() - logT0,
    event: `ws:${msg.type}`,
    note: msg.type === "status" ? msg.message
        : msg.type === "transcript" ? JSON.stringify((msg.text ?? "").slice(0, 40))
        : msg.type === "component" ? JSON.stringify(msg.component)
        : msg.type === "llm_delta" ? `+${(msg.text ?? "").length}b`
        : msg.type === "llm_text" ? `${(msg.text ?? "").length}b`
        : "",
  });
  switch (msg.type) {
    case "hello":
      ttsSampleRate = msg.ttsSampleRate ?? 24000;
      if (playerNode) {
        playerNode.port.postMessage({ type: "init", sourceRate: ttsSampleRate });
      }
      if (typeof msg.orbGlyph === "string" && msg.orbGlyph !== "") {
        orbEl.classList.remove("orb-glyph-css", "glyph-play", "glyph-wave", "glyph-pause", "glyph-square");
        document.querySelector("#orb .glyph").textContent = msg.orbGlyph;
      }
      if (typeof msg.sessionId === "string" && msg.sessionId !== "") {
        setActiveSessionId(msg.sessionId);
        renderSessionsUI();
      }
      if (typeof msg.lastUserText === "string" && msg.lastUserText !== "") {
        setTranscript(msg.lastUserText);
        hasHistory = true;
      } else {
        setTranscript("");
      }
      if (typeof msg.lastAssistantText === "string" && msg.lastAssistantText !== "") {
        updateAssistant({ type: "reset" });
        updateAssistant({ type: "text", text: msg.lastAssistantText });
        hasHistory = true;
      } else {
        updateAssistant({ type: "reset" });
      }
      if (hasHistory) {
        saveSession(getActiveSessionId());
        renderSessionsUI();
        startHint.classList.add("hidden");
      }
      break;
    case "status":
      if (msg.message === "empty transcription") dispatch({ type: "STATUS_EMPTY" });
      break;
    case "transcript":
      saveSession(getActiveSessionId());
      setTranscript(msg.text ?? "");
      updateAssistant({ type: "reset" });
      dispatch({ type: "TRANSCRIPT" });
      break;
    case "llm_delta":
      if (typeof msg.text === "string" && msg.text.length > 0) {
        updateAssistant({ type: "delta", text: msg.text });
        dispatch({ type: "LLM_TEXT" });
      }
      break;
    case "llm_text":
      if (typeof msg.text === "string" && msg.text.length > 0) {
        updateAssistant({ type: "text", text: msg.text });
        dispatch({ type: "LLM_TEXT" });
      }
      break;
    case "component":
      if (msg.component) {
        updateAssistant({ type: "component", value: formatComponent(msg.component) });
        dispatch({ type: "COMPONENT" });
      }
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

// === Session Management (localStorage) =======================================

function getActiveSessionId() { return currentSessionId; }

function setActiveSessionId(id) {
  currentSessionId = id || "";
  if (currentSessionId) localStorage.setItem(ACTIVE_SESSION_KEY, currentSessionId);
  else localStorage.removeItem(ACTIVE_SESSION_KEY);
}

function switchSession(id) {
  // cancel any pending reconnect so we don't race
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // tear down the old socket without triggering auto-reconnect
  if (ws) {
    const old = ws;
    ws = null;
    try { old.close(); } catch {}
  }
  // mic track stays hot across session switches -- captureOpen gates
  // any frames produced before the user opens the new session.
  captureOpen = false;
  started = false;
  // reset client-side UI state
  setActiveSessionId(id);
  hasHistory = false;
  setTranscript("");
  updateAssistant({ type: "reset" });
  startHint.textContent = "push to talk or tap to toggle voice detection";
  if (prefetchDone) {
    startHint.classList.remove("hidden");
  }
  setBodyState("error", false);
  setBodyState("reconnecting", false);
  dispatch({ type: "WS_CLOSE" });
  renderSessionsUI();
  // open fresh connection -- server assigns a new session when id is empty
  openWs(false).catch(() => scheduleReconnect());
}

function getStoredSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveSession(id) {
  if (!id) return;
  let list = getStoredSessions();
  // Filter out any existing matching ID to move it to the top
  list = list.filter((s) => s.id !== id);
  list.unshift({ id, timestamp: Date.now() });
  // Keep only the last 10 sessions
  list = list.slice(0, 10);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
}

function deleteSession(id) {
  if (!id) return;
  let list = getStoredSessions();
  list = list.filter((s) => s.id !== id);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderSessionsUI() {
  const dropdown = document.getElementById("sessions-dropdown");
  const listEl = document.getElementById("sessions-list");
  if (!listEl) return;

  const currentId = getActiveSessionId();
  const list = getStoredSessions();

  listEl.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.style.fontSize = "12px";
    empty.style.color = "var(--dim)";
    empty.style.padding = "8px 4px";
    empty.textContent = "no recent sessions";
    listEl.appendChild(empty);
    return;
  }

  for (const s of list) {
    const row = document.createElement("div");
    row.className = "session-row";

    const btn = document.createElement("button");
    btn.className = "session-item";
    if (s.id === currentId) {
      btn.classList.add("active");
    }

    const idSpan = document.createElement("span");
    idSpan.className = "session-id";
    idSpan.textContent = s.id.substring(0, 8); // show truncated session ID

    const timeSpan = document.createElement("span");
    timeSpan.className = "session-time";
    timeSpan.textContent = formatRelativeTime(s.timestamp);

    btn.appendChild(idSpan);
    btn.appendChild(timeSpan);

    btn.addEventListener("click", () => {
      switchSession(s.id);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "session-delete";
    delBtn.setAttribute("aria-label", "Delete Session");
    delBtn.innerHTML = "&times;";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isActive = (s.id === currentId);
      deleteSession(s.id);
      if (isActive) {
        switchSession("");
      } else {
        renderSessionsUI();
      }
    });

    row.appendChild(btn);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  }
}

// Wire up UI event listeners
const sessionsBtn = document.getElementById("sessions-btn");
const sessionsDropdown = document.getElementById("sessions-dropdown");
const newSessionBtn = document.getElementById("new-session-btn");

if (sessionsBtn && sessionsDropdown && newSessionBtn) {
  sessionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sessionsDropdown.classList.toggle("hidden");
    if (!sessionsDropdown.classList.contains("hidden")) {
      renderSessionsUI();
    }
  });

  newSessionBtn.addEventListener("click", () => {
    switchSession("");
  });

  document.addEventListener("click", (e) => {
    if (!sessionsDropdown.classList.contains("hidden") && !sessionsDropdown.contains(e.target) && e.target !== sessionsBtn) {
      sessionsDropdown.classList.add("hidden");
    }
  });

  // Render initially
  renderSessionsUI();
}

