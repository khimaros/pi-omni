// pi-omni minimal voice web UI.
//
// Flow:
//   tap-to-start (iOS user-gesture requirement) → MicVAD opens mic w/ AEC/NS/AGC
//   and runs Silero v5 via onnxruntime-web → on onSpeechEnd, the library hands
//   us the complete utterance as Float32 @ 16kHz. We int16-encode and ship it
//   to the server as one binary WS frame between audio_start/audio_end.
//   → server runs STT → if non-empty: cancels TTS, sends pi.sendUserMessage,
//     streams TTS PCM back; AudioWorklet plays gaplessly.
//   → on speech-start during playback: we do NOT cancel TTS locally; server
//     decides based on STT result.

const startOverlay = document.getElementById("start-overlay");
const startOrb = document.getElementById("start-orb");
const startGlyph = startOrb.querySelector(".glyph");
const orbEl = document.getElementById("orb");

const HOLD_THRESHOLD_MS = 250;
const PTT_VAD_HANGOVER_MS = 400;
// "live" — VAD runs continuously; "ptt" — VAD only runs while user holds.
// Set on first release of #start-orb based on press duration.
let sessionMode = "pause";
let pttHeld = false;
let pressTs = 0;

function setOrbGlyph(el, name) {
  for (const cls of ["glyph-play", "glyph-wave", "glyph-pause", "glyph-square"]) {
    el.classList.toggle(cls, cls === `glyph-${name}`);
  }
}

// Two-note chime via the existing playerCtx — confirms mic-open / mic-
// close in PTT. Ascending pair ("ready"), descending pair on release.
// Uses a small triangle+sine blend with a soft attack/decay so it cuts
// through but doesn't sound like a system error beep.
function playChime(reverse) {
  if (!playerCtx) return;
  // AudioContext can be created in a suspended state even inside a user
  // gesture (browser-dependent). resume() is idempotent and async; we
  // schedule notes on currentTime, which is valid even while resuming.
  if (playerCtx.state === "suspended") {
    playerCtx.resume().catch(() => {});
  }
  // G5 and C6 — a perfect fourth, clean and unambiguous either way.
  const notes = reverse ? [1046.5, 783.99] : [783.99, 1046.5];
  const noteDur = 0.16;
  const stagger = 0.09;
  const now = playerCtx.currentTime + 0.005;
  for (let i = 0; i < notes.length; i++) {
    const t0 = now + i * stagger;
    const freq = notes[i];
    // Triangle for body + sine for a clean fundamental → "chime-y".
    const oscTri = playerCtx.createOscillator();
    oscTri.type = "triangle";
    oscTri.frequency.value = freq;
    const oscSin = playerCtx.createOscillator();
    oscSin.type = "sine";
    oscSin.frequency.value = freq * 2; // octave above for sparkle
    const g = playerCtx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.14, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + noteDur);
    const gSin = playerCtx.createGain();
    gSin.gain.value = 0.35;
    oscTri.connect(g);
    oscSin.connect(gSin);
    gSin.connect(g);
    g.connect(playerCtx.destination);
    oscTri.start(t0);
    oscSin.start(t0);
    oscTri.stop(t0 + noteDur + 0.04);
    oscSin.stop(t0 + noteDur + 0.04);
  }
}
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const assistantEl = document.getElementById("assistant");
const progressEl = document.getElementById("progress");
const progressBar = progressEl.querySelector(".bar");
const startHint = document.getElementById("start-hint");

// Pre-warm: kick off the big asset downloads as soon as the page loads so the
// browser's HTTP cache has them ready when MicVAD.new() asks. We track aggregate
// progress and only enable "tap to start" once both are in.
const PREFETCH = [
  { url: "/vendor/ort/ort-wasm-simd-threaded.wasm", label: "onnx runtime" },
  { url: "/vendor/vad-web/silero_vad_v5.onnx",       label: "vad model" },
];
const prefetchState = PREFETCH.map(() => ({ loaded: 0, total: 0, done: false }));

function updateProgress() {
  let loaded = 0;
  let total = 0;
  let allKnown = true;
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
      // Keep the orb disabled and tell the user *what* failed and *where*
      // to look — silent 404s on vendor assets are this app's #1 ghost bug.
      startHint.textContent =
        `failed to load ${failures.map((f) => f.label).join(", ")} — ` +
        `check server logs (vendor asset 404s)`;
      document.body.classList.add("error");
      // Leave .disabled on the orb; do not auto-start.
      return;
    }
    startHint.textContent = "push to talk or click to toggle voice detection";
    startOrb.classList.remove("disabled");
    prefetchDone = true;
    maybeAutoStart();
  }
}

function maybeAutoStart() {
  console.log("[autostart] check serverWantsAutoStart=", serverWantsAutoStart,
              "prefetchDone=", prefetchDone, "started=", started);
  if (!serverWantsAutoStart || !prefetchDone || started) return;
  console.log("[autostart] attempting silent start()");
  // Try silently. iOS Safari and some browsers will refuse without a user
  // gesture; we fall back to the overlay below.
  started = true;
  start()
    .then(() => {
      console.log("[autostart] success");
      sessionMode = "pause";
      setOrbGlyph(orbEl, "pause");
      setStatus("paused");
      startOverlay.classList.add("hidden");
    })
    .catch((e) => {
      console.warn("[autostart] failed:", e?.name, e?.message ?? e);
      // Auto-start failed (likely missing user gesture). Re-enable manual tap.
      started = false;
      startHint.textContent = "push to talk or click to toggle voice detection";
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
    // A prefetch failure (usually 404 on a vendor asset) means MicVAD
    // initialization will also fail. Surface it in the hint and keep the
    // orb disabled so the user isn't left tapping a dead button.
    prefetchState[i].done = true;
    prefetchState[i].failed = true;
    console.error(`[prefetch] failed to load ${PREFETCH[i].label} (${url}):`, e);
    updateProgress();
  }
}

// Fail loudly before we even start prefetching if we're on an insecure
// origin — the audio worklet + getUserMedia both need a secure context, so
// nothing past the start button will work over plain HTTP.
if (!window.isSecureContext) {
  console.error("[start] insecure origin:", location.origin);
  startHint.textContent =
    `insecure origin (${location.origin}) — needs HTTPS or localhost. ` +
    `Tunnel: ssh -L ${location.port}:localhost:${location.port} <host>`;
  document.body.classList.add("error");
  progressEl.classList.add("hidden");
  // Leave .disabled on the orb.
} else {
  progressEl.classList.remove("hidden");
  PREFETCH.forEach((_, i) => prefetchOne(i));
}

const TARGET_CAPTURE_RATE = 16000;

let ws = null;
let ttsSampleRate = 24000;
let playerCtx = null;
let playerNode = null;
let micVad = null;
let speaking = false;
let arp = null;
let thinking = false;
// Server has signaled tts_end (no more PCM coming) but the worklet may
// still be playing buffered audio. Set true on tts_end, consumed on the
// next "drained" message from the worklet — that's when we actually
// leave the speaking phase.
let ttsServerEnded = false;
// Mirrors the worklet's hadAudio flag in the inverse direction: true
// when its playout buffer is empty. Used to handle the race where the
// worklet drains BEFORE the server emits tts_end (so we don't get a
// second drained signal).
let workletEmpty = true;
let serverWantsAutoStart = false;
let prefetchDone = false;
let started = false;

function setStatus(s) { statusEl.textContent = s; }
function setBodyState(name, on) { document.body.classList.toggle(name, on); }
function setTranscript(s) { transcriptEl.textContent = s; }

// Single source of truth for the orb glow + status text. The four phases
// are mutually exclusive; passing `"idle"` clears all of them. Errors and
// disconnect states are handled separately because they overlay arbitrary
// text on top of the phase.
//
// Note: `thinking` (above) is a SEPARATE flag — it means "agent loop is
// still active" (true between transcript and agent_end). It can be true
// while the visible phase is "speaking" (mid-response) or even briefly
// while in a tool-call gap. The glow shown is whatever phase you pass here.
const PHASES = ["listening", "transcribing", "thinking", "synthesizing", "speaking"];
function setPhase(phase) {
  for (const p of PHASES) setBodyState(p, p === phase);
  if (phase) setStatus(phase === "idle" ? "ready" : phase);
}

// Called from either "tts_end" or the worklet "drained" event. Only
// leaves the speaking phase when BOTH happen — server done sending AND
// worklet done playing — so the glow lasts until audio is actually
// heard. No-op if the user already barged in (listening owns the orb).
function maybeEndSpeaking() {
  console.log("[tts] maybeEndSpeaking speaking=", speaking,
              "ttsServerEnded=", ttsServerEnded, "workletEmpty=", workletEmpty);
  if (!speaking || !ttsServerEnded || !workletEmpty) return;
  speaking = false;
  ttsServerEnded = false;
  if (document.body.classList.contains("listening")) return;
  if (thinking) setPhase("thinking");
  else setPhase("idle");
}

// Cute random-pentatonic arpeggiator played while the LLM is thinking.
// Quiet, brief notes ducked under any concurrent audio. Stops as soon as
// the first TTS frame arrives.
class Arpeggiator {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
    this.active = false;
    // C major pentatonic, 4th-5th octaves.
    this.scale = [
      261.63, 293.66, 329.63, 392.0, 440.0,
      523.25, 587.33, 659.25, 783.99,
    ];
    // Feedback-delay "reverb": each note feeds a delay line that loops
    // back into itself at <1 gain so the tail decays naturally.
    // Master gain — single chokepoint so stop() can silence everything
    // (dry notes AND the feedback-delay tail) by ramping one node to 0.
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
    // Slam master to 0 and disconnect from destination. The disconnect is the
    // belt-and-suspenders bit: even if a stray automation later moves the
    // gain, nothing reaches the speakers until start() reconnects.
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
function setAssistant(s) { assistantEl.textContent = s; }
function appendAssistant(s) { assistantEl.textContent += s; }

// Unified state machine. Once the overlay is dismissed, the main orb is
// always in one of three states; clicks toggle live↔pause, and a hold
// (from any non-PTT state) enters PTT for the duration of the press,
// returning to pause on release.
//
//   null  → pre-session (overlay still showing)
//   pause → mic completely off; just listening for the user to do something
//   live  → MicVAD running continuously, server gets VAD-cut utterances
//   ptt   → raw mic open, buffering audio; transient (held only)
let holdTimer = null;
let startPromise = null;

const orbDot = orbEl.querySelector(".dot");

function setStateGlyph() {
  if (sessionMode === "pause") setOrbGlyph(orbEl, "pause");
  else if (sessionMode === "live") setOrbGlyph(orbEl, "wave");
  else if (sessionMode === "ptt") setOrbGlyph(orbEl, "wave");
}

async function enterLive() {
  sessionMode = "live";
  setStateGlyph();
  try {
    await ensureLiveMic();
  } catch (e) {
    console.error("[live] mic init failed:", e);
    setStatus(`mic error: ${e.message ?? e}`);
    setBodyState("error", true);
    sessionMode = "pause";
    setStateGlyph();
    return;
  }
  // VAD load can take a couple of seconds — user may have tapped again
  // to go back to pause while we were waiting.
  if (sessionMode !== "live") return;
  try { micVad?.start(); } catch {}
  setPhase("idle");
}

function enterPause() {
  sessionMode = "pause";
  setStateGlyph();
  try { micVad?.pause(); } catch {}
}

// Called when the hold timer fires (still pressed). Opens the PTT mic,
// plays the open-chime, and switches to ptt state. If VAD was running
// (live state) it gets paused for the duration.
async function enterPtt() {
  const cameFromLive = sessionMode === "live";
  sessionMode = "ptt";
  pttHeld = true;
  setStateGlyph();
  setPhase("listening");
  if (cameFromLive && micVad) { try { micVad.pause(); } catch {} }
  // Wait just long enough for playerCtx (so the chime is audible) — the
  // first ever PTT can fire before start() finishes.
  if (!playerCtx && startPromise) { try { await startPromise; } catch {} }
  if (!pttHeld) return;
  playChime(false);
  try {
    await ensurePttMic();
    if (pttCtx.state === "suspended") { try { await pttCtx.resume(); } catch {} }
  } catch (err) {
    console.error("[ptt] mic init failed:", err);
    pttHeld = false;
    setStatus(`mic error: ${err.message ?? err}`);
    setBodyState("error", true);
    enterPause();
    return;
  }
  pttBuffer = [];
  if (startPromise) { try { await startPromise; } catch {} }
  if (!pttHeld) return;
  wsSendJson({ type: "audio_start" });
}

// Called when the user releases during PTT. Flushes the captured audio
// as one utterance, plays the close-chime, and returns to pause state.
async function exitPtt() {
  pttHeld = false;
  playChime(true);
  if (startPromise) { try { await startPromise; } catch { sessionMode = "pause"; setStateGlyph(); return; } }
  const total = pttBuffer.reduce((n, a) => n + a.length, 0);
  if (total > 0) {
    const flat = new Float32Array(total);
    let off = 0;
    for (const chunk of pttBuffer) { flat.set(chunk, off); off += chunk.length; }
    pttBuffer = [];
    sendUtterance(flat);
    wsSendJson({ type: "audio_end", sampleRate: TARGET_CAPTURE_RATE });
    setPhase("transcribing");
    arp?.start();
  } else {
    setPhase("idle");
  }
  sessionMode = "pause";
  setStateGlyph();
}

// Start orb: same gesture model as the main orb. Tap dismisses the
// overlay and lands in pause; hold begins PTT immediately and the
// release goes through exitPtt(), also ending in pause.
startOrb.addEventListener("pointerdown", (e) => {
  console.log("[start] pointerdown disabled=", startOrb.classList.contains("disabled"),
              "started=", started, "prefetchDone=", prefetchDone);
  if (startOrb.classList.contains("disabled") || started) return;
  e.preventDefault();
  try { startOrb.setPointerCapture(e.pointerId); } catch {}
  startOrb.classList.add("disabled");
  started = true;
  holdTimer = setTimeout(() => { holdTimer = null; enterPtt(); setOrbGlyph(startOrb, "wave"); }, HOLD_THRESHOLD_MS);
  startPromise = start()
    .then(() => { console.log("[start] start() resolved"); })
    .catch((err) => {
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
  // Short release → tap → toggle live/pause, same as the main orb.
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (sessionMode === "pause") {
      enterLive().catch((e) => console.error("[live] failed:", e));
    } else if (sessionMode === "live") {
      enterPause();
    }
    setOrbGlyph(startOrb, "pause");
    if (startPromise) { try { await startPromise; } catch { return; } }
    startOverlay.classList.add("hidden");
    return;
  }
  // Hold past threshold → PTT was entered. Finalize it.
  if (sessionMode === "ptt" && pttHeld) {
    setOrbGlyph(startOrb, "pause");
    await exitPtt();
  }
  startOverlay.classList.add("hidden");
}
startOrb.addEventListener("pointerup", onStartOrbRelease);
startOrb.addEventListener("pointercancel", onStartOrbRelease);

// Main orb: hold-detection timer starts PTT mid-press; short release =
// click = toggle live/pause.
let mainHoldTimer = null;
orbDot.addEventListener("pointerdown", (e) => {
  if (!started || sessionMode === "ptt") return;
  e.preventDefault();
  try { orbDot.setPointerCapture(e.pointerId); } catch {}
  mainHoldTimer = setTimeout(() => { mainHoldTimer = null; enterPtt(); }, HOLD_THRESHOLD_MS);
});

function onMainOrbUp() {
  if (mainHoldTimer) {
    clearTimeout(mainHoldTimer);
    mainHoldTimer = null;
    // Click → toggle.
    if (sessionMode === "pause") {
      enterLive().catch((e) => console.error("[live] failed:", e));
    } else if (sessionMode === "live") {
      enterPause();
    }
    return;
  }
  if (sessionMode === "ptt" && pttHeld) {
    exitPtt();
  }
}
orbDot.addEventListener("pointerup", onMainOrbUp);
orbDot.addEventListener("pointercancel", onMainOrbUp);

async function start() {
  // AudioWorklet + getUserMedia both require a secure context. On plain HTTP
  // (e.g. http://<vm-ip>:port) AudioContext.audioWorklet is undefined and the
  // browser silently refuses mic access. Fail fast with a useful message.
  if (!window.isSecureContext) {
    throw new Error(
      `insecure origin (${location.origin}) — pi-omni-web needs HTTPS or ` +
      `localhost. Tunnel with: ssh -L ${location.port}:localhost:${location.port} <host>`,
    );
  }
  console.log("[start] step 1: AudioContext + worklet");
  playerCtx = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: "interactive",
  });
  // Some browsers create the context in "suspended" state even inside a
  // user gesture. Resume now so the first chime (fired before the mic
  // opens) is actually audible — otherwise oscillators schedule at
  // currentTime=0 and never play.
  try { await playerCtx.resume(); } catch {}
  await playerCtx.audioWorklet.addModule("worklet.js");
  playerNode = new AudioWorkletNode(playerCtx, "pcm-player");
  playerNode.connect(playerCtx.destination);
  playerNode.port.onmessage = (e) => {
    if (e.data?.type === "drained") {
      console.log("[tts] worklet drained, ttsServerEnded=", ttsServerEnded);
      workletEmpty = true;
      maybeEndSpeaking();
    }
  };
  arp = new Arpeggiator(playerCtx);

  console.log("[start] step 2: WebSocket");
  await openWs();

  console.log("[start] step 3: initSession");
  await initSession();
  console.log("[start] all steps complete");
}

async function initMic() {
  // MicVAD (Silero v5 via onnxruntime-web). Library opens its own
  // getUserMedia + AudioContext. We pass through AEC/NS/AGC constraints
  // so the browser strips speaker echo before VAD sees the audio.
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
    // Mirror her/'s SileroVADAnalyzer params (confidence=0.5, ~500ms start,
    // ~200ms stop). v5 frame is 512 samples = 32ms.
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    minSpeechFrames: 16,
    redemptionFrames: 6,
    preSpeechPadFrames: 3,
    onSpeechStart: () => {
      console.log("[vad] onSpeechStart speaking=", speaking, "thinking=", thinking);
      // Ignore VAD entirely while the socket is down — we can't send the
      // utterance anywhere, and starting the arp would leave a "thinking"
      // sound playing with no turn behind it.
      if (!ws || ws.readyState !== 1) return;
      // Barge-in: kill local playback immediately + tell the server to
      // cancel any in-flight TTS / drop late LLM deltas. If STT comes back
      // empty we simply don't start a new turn (bot stays quiet).
      if (speaking) {
        console.warn("[vad] barge-in during speaking — cancelling TTS");
        playerNode.port.postMessage({ type: "reset" });
        speaking = false;
        ttsServerEnded = false;
        workletEmpty = true;
        wsSendJson({ type: "cancel" });
      }
      // Quiet the thinking sound so it doesn't sit under the user's voice;
      // if this turns out to be a misfire, onVADMisfire/empty-STT will
      // resurrect it (we're still waiting on a pending turn).
      arp?.stop();
      setPhase("listening");
      wsSendJson({ type: "audio_start" });
    },
    onSpeechEnd: (audio) => {
      console.log("[vad] onSpeechEnd speaking=", speaking, "thinking=", thinking);
      if (!ws || ws.readyState !== 1) return;
      // audio: Float32Array of the complete utterance @ 16kHz.
      sendUtterance(audio);
      setPhase("transcribing");
      wsSendJson({ type: "audio_end", sampleRate: TARGET_CAPTURE_RATE });
      // Cute "thinking" sound while we wait for STT → LLM → first TTS frame.
      // We don't flip `thinking` here because STT might come back empty — we
      // wait for the server's "transcript" message to commit.
      arp?.start();
    },
    onVADMisfire: () => {
      console.log("[vad] onVADMisfire speaking=", speaking, "thinking=", thinking);
      if (!ws || ws.readyState !== 1) return;
      // Too-short burst — VAD-web emits this instead of onSpeechEnd; we just
      // drop the audio and roll back UI state. If a prior turn is still
      // pending, resume the thinking sound we silenced in onSpeechStart.
      if (speaking) setPhase("speaking");
      else if (thinking) { setPhase("thinking"); arp?.start(); }
      else setPhase("idle");
    },
  });
  micVad.start();
}

let reconnectTimer = null;
let reconnectDelayMs = 500;

// Tear down all per-session transient state on disconnect. We keep the
// AudioContext + worklet (creating a new one needs a user gesture on iOS)
// but flush its buffer; everything else gets reset and is rebuilt on
// reconnect by initSession().
function resetSessionState() {
  if (speaking) {
    try { playerNode?.port.postMessage({ type: "reset" }); } catch {}
    speaking = false;
  }
  thinking = false;
  for (const p of PHASES) setBodyState(p, false);
  arp?.stop();
  // Drop any pending utterance/transcript UI hints from the dead session.
  setStatus("reconnecting");
  // Leave micVad running across reconnects. destroy() would force a fresh
  // getUserMedia (which needs a user gesture), and pause()/start() can leave
  // the internal AudioContext suspended on some browsers. Its callbacks send
  // via wsSendJson which is a no-op while the socket is down; on reconnect
  // they land on the new socket automatically.
}

// Re-establish the per-session pieces that resetSessionState() tore down.
async function initSession() {
  // micVad is only spun up for live mode (it opens its own getUserMedia
  // and runs Silero continuously; we don't want that overhead during a
  // pure PTT session). The live-mode entry path calls ensureLiveMic()
  // explicitly. On reconnect, re-init only if we were already in live.
  if (sessionMode === "live" && !micVad) await initMic();
  setPhase("idle");
}

async function ensureLiveMic() {
  if (!micVad) await initMic();
}

// Raw PTT capture: a parallel getUserMedia + ScriptProcessor that
// buffers Float32 frames while the user holds the main orb. Bypasses
// VAD entirely so utterances of any length get transcribed (MicVAD's
// minSpeechFrames threshold would drop short presses). Lazy-initialized
// on first PTT press so non-PTT sessions never touch the mic.
let pttCtx = null;
let pttStream = null;
let pttSource = null;
let pttProcessor = null;
let pttBuffer = [];

async function ensurePttMic() {
  if (pttCtx) return;
  // 16kHz native: most browsers honor this directly; the few that clamp
  // to a higher rate would produce wrong-rate PCM, but Chrome/Firefox/
  // Safari all support 16k since ~2020.
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
  // ScriptProcessor is deprecated but universally available; for the
  // brief PTT capture windows the main-thread cost is negligible.
  pttProcessor = pttCtx.createScriptProcessor(2048, 1, 1);
  pttProcessor.onaudioprocess = (e) => {
    if (!pttHeld) return;
    // The input Float32Array is reused by the audio engine — copy.
    pttBuffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  pttSource.connect(pttProcessor);
  pttProcessor.connect(pttCtx.destination);
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
      setStatus("reconnecting");
      setBodyState("error", true);
      resetSessionState();
      scheduleReconnect();
    });
    ws.addEventListener("message", onWsMessage);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000); // cap 10s
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
  } else {
    const i16 = new Int16Array(ev.data);
    // First PCM frame after a synth/drain gap: audible playback begins
    // now. Stop the thinking arp and flip from the "synth" glow to
    // "speaking" (no-ops if we're already in speaking — e.g. mid-stream
    // between sentences). The listening class is the barge-in case;
    // don't clobber it.
    if (workletEmpty) {
      arp?.stop();
      if (speaking && !document.body.classList.contains("listening")) {
        setPhase("speaking");
      }
    }
    workletEmpty = false;
    playerNode.port.postMessage({ type: "pcm", samples: i16 }, [i16.buffer]);
  }
}

function handleControl(msg) {
  switch (msg.type) {
    case "hello":
      ttsSampleRate = msg.ttsSampleRate ?? 24000;
      playerNode.port.postMessage({ type: "init", sourceRate: ttsSampleRate });
      serverWantsAutoStart = !!msg.autoStart;
      if (typeof msg.orbGlyph === "string" && msg.orbGlyph !== "") {
        // Server-configured text override: drop the CSS-glyph children
        // and let raw text fill the slot instead.
        orbEl.classList.remove("orb-glyph-css", "glyph-play", "glyph-wave", "glyph-pause", "glyph-square");
        document.querySelector("#orb .glyph").textContent = msg.orbGlyph;
      }
      maybeAutoStart();
      break;
    case "status":
      // Empty STT for THIS utterance: server won't commit a turn. Go
      // back to idle and stop the thinking sound.
      if (msg.message === "empty transcription") {
        setPhase("idle");
        arp?.stop();
      }
      // Other status messages are server-side breadcrumbs — don't
      // overwrite the phase-driven status text.
      break;
    case "transcript":
      setTranscript(msg.text ?? "");
      // New turn committed — server is about to call pi.sendUserMessage,
      // so the LLM phase has effectively started.
      thinking = true;
      setPhase("thinking");
      // New turn — clear last reply.
      setAssistant("");
      break;
    case "llm_delta":
      if (typeof msg.text === "string") appendAssistant(msg.text);
      break;
    case "llm_text":
      // Block-mode (no streaming): full assistant text at end of turn.
      if (typeof msg.text === "string") setAssistant(msg.text);
      break;
    case "tts_start":
      console.log("[tts] tts_start (synth phase — waiting for first PCM)");
      speaking = true;
      ttsServerEnded = false;
      // The server has only kicked off the TTS HTTP request — in block
      // (non-sentence-streaming) mode several seconds can pass before
      // the first PCM frame. Show a distinct "synth" glow until then;
      // the speaking phase and arp-stop both fire on first PCM below.
      setPhase("synthesizing");
      break;
    case "tts_cancel":
      console.log("[tts] tts_cancel");
      // Server committed to a new turn — drop in-flight playback locally.
      playerNode.port.postMessage({ type: "reset" });
      speaking = false;
      ttsServerEnded = false;
      workletEmpty = true;
      // Don't change phase here; the new turn's STT/thinking will set it.
      break;
    case "tts_end":
      console.log("[tts] tts_end (server) — waiting for worklet drain");
      // Mark that the server is done sending PCM. The phase transition
      // happens on the worklet's "drained" message so the speaking glow
      // lasts until the audio is actually heard. If the worklet already
      // drained (rare — short utterance, server is slow to emit tts_end)
      // we still need to advance now.
      ttsServerEnded = true;
      maybeEndSpeaking();
      break;
    case "agent_end":
      thinking = false;
      if (!speaking) setPhase("idle");
      break;
    case "error":
      thinking = false;
      for (const p of PHASES) setBodyState(p, false);
      setBodyState("error", true);
      setStatus(`error: ${msg.message}`);
      arp?.stop();
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
