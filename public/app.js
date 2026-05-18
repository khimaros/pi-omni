// pi-omni minimal voice web UI.
//
// Flow:
//   tap-to-start (iOS user-gesture requirement) → either a quick tap toggles
//   live mode (MicVAD opens mic w/ AEC/NS/AGC and runs Silero v5 via
//   onnxruntime-web) or a hold enters PTT (raw mic via ScriptProcessor).
//   In live, onSpeechEnd hands us the complete utterance as Float32 @ 16kHz;
//   in PTT, the buffered frames are concatenated on release. Either way we
//   int16-encode and ship one binary WS frame between audio_start/audio_end.
//   → server runs STT → if non-empty: cancels TTS, sends pi.sendUserMessage,
//     streams TTS PCM back; AudioWorklet plays gaplessly.
//   → on speech-start during playback: we cancel local playback immediately
//     and tell the server to drop the in-flight turn.

const startOverlay = document.getElementById("start-overlay");
const startOrb = document.getElementById("start-orb");
const orbEl = document.getElementById("orb");

// Tunable UX timings (ms). Centralized so they're easy to adjust.
//   HOLD_THRESHOLD_MS    — orb-hold duration that promotes a tap to PTT.
//   CHIME_TAIL_PAUSE_MS  — silence inserted after a chime finishes so the
//                          following side-effect (audio_start, arp, phase
//                          flip) doesn't step on the chime tail.
const HOLD_THRESHOLD_MS = 250;
const CHIME_TAIL_PAUSE_MS = 200;
// Wait after stopping the mic before the next audio output can play
// cleanly. micVad.pause() / track.stop() return as soon as JS marks the
// tracks dead, but the OS audio-routing reconfigure continues
// asynchronously — playing anything during that window clips the onset.
const MIC_OFF_SETTLE_MS = 120;
// "live" — VAD runs continuously; "ptt" — VAD only runs while user holds.
// Set on first release of #start-orb based on press duration.
let sessionMode = "pause";
let pttHeld = false;

// Both orbs always render the waveform glyph. The bar color is driven by
// CSS off `body.mic-on` (set in applySessionMode) + :hover.
function setMicOn(on) {
  document.body.classList.toggle("mic-on", on);
}

// Two-note chime via the existing playerCtx — confirms mic-open / mic-
// close in PTT. Ascending pair ("ready"), descending pair on release.
// Uses a small triangle+sine blend with a soft attack/decay so it cuts
// through but doesn't sound like a system error beep.
// Returns a promise that resolves when the chime has finished playing,
// so callers can serialize against it (e.g. don't start recording until
// the open-chime is done).
async function playChime(reverse) {
  if (!playerCtx) return;
  // AudioContext can be suspended either because it was just created or
  // because the browser auto-suspended it after a quiet period. Either
  // way, await the resume — scheduling notes on currentTime while the
  // context is still ramping up clips the chime's onset.
  if (playerCtx.state === "suspended") {
    try { await playerCtx.resume(); } catch {}
  }
  // If the arpeggio is running (e.g. user pauses while the LLM is
  // thinking), blend the chime into its mix: route through the arp's
  // master + feedback-delay reverb so the chime sits in the same acoustic
  // space, and drop the volume so the arp stays audible underneath.
  const blend = arp?.active === true;
  const dest = blend ? arp.master : playerCtx.destination;
  const reverbSend = blend ? arp.delay : null;
  const peakGain = blend ? 0.10 : 0.22;
  const sineGain = blend ? 0.4 : 0.5;
  // G5 and C6 — a perfect fourth, both in C-major pentatonic so the
  // chime sits in key with the arp when blended.
  const notes = reverse ? [1046.5, 783.99] : [783.99, 1046.5];
  const noteDur = 0.16;
  const stagger = 0.09;
  const leadSec = 0.005;
  const now = playerCtx.currentTime + leadSec;
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
  // Last note ends at: leadSec + (notes.length-1)*stagger + noteDur + 0.04.
  const totalSec = leadSec + (notes.length - 1) * stagger + noteDur + 0.04;
  return new Promise((r) => setTimeout(r, Math.ceil(totalSec * 1000)));
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
    startHint.textContent = "push to talk or tap to toggle voice detection";
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
      applySessionMode();
      startOverlay.classList.add("hidden");
    })
    .catch((e) => {
      console.warn("[autostart] failed:", e?.name, e?.message ?? e);
      // Auto-start failed (likely missing user gesture). Re-enable manual tap.
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
// Parallel buffer of VAD-processed frames while a speech segment is in
// progress, so that enterPause() can flush a partial utterance to the
// server if the user pauses mid-sentence.
let vadSpeaking = false;
let vadBuffer = [];
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

// Single source of truth for the orb glow + status text. The phases below
// are mutually exclusive; passing `"paused"` clears all glows (it's the
// resting state in pause mode and has no body class of its own). Errors
// and disconnect states are handled separately because they overlay
// arbitrary text on top of the phase.
//
// Note: `thinking` (above) is a SEPARATE flag — it means "agent loop is
// still active" (true between transcript and agent_end). It can be true
// while the visible phase is "speaking" (mid-response) or even briefly
// while in a tool-call gap. The glow shown is whatever phase you pass here.
const PHASES = ["listening", "recording", "transcribing", "thinking", "synthesizing", "speaking"];
// Phases during which the "thinking" arpeggio plays — entering any of them
// from a non-arp phase starts it, leaving the set stops it.
const ARP_PHASES = new Set(["transcribing", "thinking", "synthesizing"]);
// Phase machine for the LLM/audio pipeline:
//   paused → listening → recording → transcribing → thinking →
//   synthesizing → speaking → listening (live) / paused (pause).
// "listening" is the live-mode resting state (mic open, no voice);
// "recording" fires when VAD picks up speech or while PTT is held.
//
// Chimes are NOT driven from here — they're tied to user-driven session
// mode transitions (pause ↔ live ↔ ptt) and live alongside those handlers
// so they can be awaited synchronously before the next side-effect.
let prevPhase = null;
function setPhase(phase) {
  for (const p of PHASES) setBodyState(p, p === phase);
  const prev = prevPhase;
  prevPhase = phase;
  refreshStatus();
  if (prev === phase) return;
  const wasArp = ARP_PHASES.has(prev);
  const isArp = ARP_PHASES.has(phase);
  if (!wasArp && isArp) arp?.start();
  else if (wasArp && !isArp) arp?.stop();
}

// The resting phase depends on session mode: in live the mic is always
// open so the resting state is "listening"; in pause everything is off
// and we show "paused". Used after any flow returns to baseline (utterance
// finished with no LLM reply, TTS done, etc). PTT never reaches here —
// its handlers (enterPtt/exitPtt) own the phase explicitly.
function restingPhase() {
  return sessionMode === "live" ? "listening" : "paused";
}

// Status text mirrors the current phase 1:1 — phase names ARE the
// user-visible labels. Called from setPhase (phase change) and
// applySessionMode (sessionMode change, which only matters if no phase
// has been set yet — e.g. immediately after autostart).
function refreshStatus() {
  setStatus(prevPhase || "paused");
}

// Plays a chime and resolves after the chime tail has cleared + a short
// pause, so callers can serialize follow-ups (audio_start, the next phase
// transition, the thinking arp) behind the cue. Waits for the audio graph
// to be up first — otherwise the very first chime after a cold refresh
// can be partially garbled.
async function playChimeAndPause(reverse) {
  if (startPromise) { try { await startPromise; } catch { return; } }
  await playChime(reverse);
  await new Promise((r) => setTimeout(r, CHIME_TAIL_PAUSE_MS));
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
  // If VAD barge-in already moved us to recording, leave it alone.
  if (document.body.classList.contains("recording")) return;
  if (thinking) setPhase("thinking");
  else setPhase(restingPhase());
}

// Cute random-pentatonic arpeggiator played while the LLM is thinking.
// Quiet, brief notes ducked under any concurrent audio. Lifecycle is
// driven by setPhase via ARP_PHASES.
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
// always in one of three session modes; clicks toggle live↔pause, and a
// hold (from any non-PTT mode) enters PTT for the duration of the press,
// returning to pause on release. Pre-overlay-dismiss, sessionMode is
// already "pause" — the started flag is what gates user interaction.
//
//   pause → mic completely off; just listening for the user to do something
//   live  → MicVAD running continuously, server gets VAD-cut utterances
//   ptt   → raw mic open, buffering audio; transient (held only)
let holdTimer = null;
let startPromise = null;

const orbDot = orbEl.querySelector(".dot");

// Syncs the UI to the current sessionMode: toggles body.mic-on (which
// drives the active-wave bar color in CSS) and refreshes the status text.
// Call after every sessionMode mutation.
function applySessionMode() {
  setMicOn(sessionMode === "live" || sessionMode === "ptt");
  refreshStatus();
}

async function enterLive() {
  sessionMode = "live";
  applySessionMode();
  // Chime first, mic second. Running getUserMedia in parallel with the
  // chime causes the audio device to reconfigure mid-chime on some
  // browsers, clipping the onset. Serializing also keeps the order
  // intuitive: cue plays → mic opens → ready to listen.
  await playChimeAndPause(false);
  if (sessionMode !== "live") return;
  try {
    await ensureLiveMic();
  } catch (e) {
    console.error("[live] mic init failed:", e);
    setStatus(`mic error: ${e.message ?? e}`);
    setBodyState("error", true);
    sessionMode = "pause";
    applySessionMode();
    return;
  }
  if (sessionMode !== "live") return;
  setPhase("listening");
}

async function enterPause() {
  // If the user was mid-utterance when they paused, flush what we've
  // captured so the turn can complete instead of getting silently dropped.
  // The leading consonant may be slightly clipped — we don't include the
  // VAD pre-speech pad here — but the bulk of the utterance survives.
  let nextPhase = "paused";
  if (vadSpeaking && vadBuffer.length > 0 && ws?.readyState === 1) {
    const total = vadBuffer.reduce((n, a) => n + a.length, 0);
    const flat = new Float32Array(total);
    let off = 0;
    for (const c of vadBuffer) { flat.set(c, off); off += c.length; }
    sendUtterance(flat);
    wsSendJson({ type: "audio_end", sampleRate: TARGET_CAPTURE_RATE });
    nextPhase = "transcribing";
  }
  sessionMode = "pause";
  applySessionMode();
  // Clear the prior listening/recording glow immediately so it doesn't
  // bleed through the close chime. Flip to "transcribing" (which starts
  // the arp) only AFTER the chime is done — audio_end above already
  // kicked off server-side STT in parallel.
  setPhase("paused");
  await releaseLiveMic();
  await playChimeAndPause(true);
  // Only advance to "transcribing" if the server hasn't already moved us
  // past it. A fast STT+LLM+TTS round-trip can land transcript/tts_start/
  // speaking before the chime finishes; setting transcribing now would
  // clobber that and restart the arp under live TTS audio.
  if (nextPhase !== "paused" && prevPhase === "paused") setPhase(nextPhase);
}

async function releaseLiveMic() {
  if (!micVad) return;
  // pause() stops the mic tracks (so the browser drops the recording
  // indicator) but keeps the worker, model, and AudioContext loaded —
  // resuming via start() is fast and never re-downloads the model.
  try { await micVad.pause(); } catch {}
  vadSpeaking = false;
  vadBuffer = [];
  await new Promise((r) => setTimeout(r, MIC_OFF_SETTLE_MS));
}

// Called when the hold timer fires (still pressed). Opens the PTT mic and
// switches to ptt state. The open-chime + mic-open run in parallel, but
// audio_start is held off until both complete so the chime can't bleed
// into the captured utterance. If VAD was running (live state) it gets
// released for the duration.
async function enterPtt() {
  sessionMode = "ptt";
  pttHeld = true;
  applySessionMode();
  setPhase("recording");
  // If this is the first PTT (start-orb path), the overlay is still
  // covering the main orb — hide it now so the recording glow is visible
  // while the user is still holding, not just after they release.
  startOverlay.classList.add("hidden");
  releaseLiveMic();
  if (startPromise) { try { await startPromise; } catch {} }
  if (!pttHeld) return;
  // Chime first, mic second — see comment in enterLive for rationale.
  await playChimeAndPause(false);
  if (!pttHeld) return;
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
  if (!pttHeld) return;
  pttBuffer = [];
  wsSendJson({ type: "audio_start" });
}

// Called when the user releases during PTT. Flushes the captured audio
// as one utterance and returns to pause state. The close-chime plays
// while the visible state is still "recording"; we wait for it to clear
// before transitioning to the next phase (and starting the arp) so the
// chime tail doesn't get stepped on. audio_end is sent immediately so
// the server can begin STT in parallel with the chime.
async function exitPtt() {
  pttHeld = false;
  if (startPromise) { try { await startPromise; } catch { sessionMode = "pause"; applySessionMode(); return; } }
  const total = pttBuffer.reduce((n, a) => n + a.length, 0);
  let nextPhase;
  if (total > 0) {
    const flat = new Float32Array(total);
    let off = 0;
    for (const chunk of pttBuffer) { flat.set(chunk, off); off += chunk.length; }
    pttBuffer = [];
    sendUtterance(flat);
    wsSendJson({ type: "audio_end", sampleRate: TARGET_CAPTURE_RATE });
    nextPhase = "transcribing";
  } else {
    nextPhase = "paused";
  }
  sessionMode = "pause";
  applySessionMode();
  // Clear the recording glow immediately so it doesn't linger through
  // the close chime. Flip to "transcribing" (which starts the arp) only
  // AFTER the chime is done — audio_end above kicked off STT already.
  setPhase("paused");
  await releasePttMic();
  await playChimeAndPause(true);
  // See enterPause: skip the placeholder if the server already raced past it.
  if (nextPhase !== "paused" && prevPhase === "paused") setPhase(nextPhase);
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

// Start orb: same gesture model as the main orb. Tap dismisses the
// overlay and lands in pause; hold begins PTT immediately and the
// release goes through exitPtt(), also ending in pause.
startOrb.addEventListener("pointerdown", (e) => {
  console.log("[start] pointerdown disabled=", startOrb.classList.contains("disabled"),
              "started=", started, "prefetchDone=", prefetchDone);
  if (startOrb.classList.contains("disabled") || started) return;
  if (document.body.classList.contains("reconnecting")) return;
  e.preventDefault();
  try { startOrb.setPointerCapture(e.pointerId); } catch {}
  startOrb.classList.add("disabled");
  started = true;
  holdTimer = setTimeout(() => { holdTimer = null; enterPtt(); }, HOLD_THRESHOLD_MS);
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
    // Wait for start() (playerCtx + worklet + WS) before opening the VAD
    // mic. On mobile, MicVAD.new() racing with playerCtx setup breaks
    // getUserMedia and live mode silently fails to start. Pre-PTT this
    // was naturally serialized because initMic ran inside start().
    if (startPromise) { try { await startPromise; } catch { return; } }
    if (sessionMode === "pause") {
      enterLive().catch((e) => console.error("[live] failed:", e));
    } else if (sessionMode === "live") {
      enterPause();
    }
    startOverlay.classList.add("hidden");
    return;
  }
  // Hold past threshold → PTT was entered. Finalize it.
  if (sessionMode === "ptt" && pttHeld) {
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
  if (document.body.classList.contains("reconnecting")) return;
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
    onFrameProcessed: (_probs, frame) => {
      // Buffer every frame VAD emits during a speech segment so enterPause()
      // can flush a partial utterance if the user pauses mid-sentence.
      if (vadSpeaking) vadBuffer.push(new Float32Array(frame));
    },
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
      vadSpeaking = true;
      vadBuffer = [];
      setPhase("recording");
      wsSendJson({ type: "audio_start" });
    },
    onSpeechEnd: (audio) => {
      console.log("[vad] onSpeechEnd speaking=", speaking, "thinking=", thinking);
      vadSpeaking = false;
      vadBuffer = [];
      if (!ws || ws.readyState !== 1) return;
      // audio: Float32Array of the complete utterance @ 16kHz.
      sendUtterance(audio);
      setPhase("transcribing");
      wsSendJson({ type: "audio_end", sampleRate: TARGET_CAPTURE_RATE });
    },
    onVADMisfire: () => {
      console.log("[vad] onVADMisfire speaking=", speaking, "thinking=", thinking);
      vadSpeaking = false;
      vadBuffer = [];
      if (!ws || ws.readyState !== 1) return;
      // Too-short burst — VAD-web emits this instead of onSpeechEnd; we just
      // drop the audio and roll back UI state.
      if (speaking) setPhase("speaking");
      else if (thinking) setPhase("thinking");
      else setPhase(restingPhase());
    },
  });
  await micVad.start();
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
  // setPhase isn't called here (we leave status as "reconnecting"), so stop
  // the arp explicitly and reset prevPhase so the next setPhase doesn't see
  // a stale transition.
  arp?.stop();
  prevPhase = null;
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
  // Only set a phase here if nothing else has — on reconnect, resetSessionState
  // wipes prevPhase so we need to restore. On initial bring-up, the session-
  // mode handler that triggered start() (enterPtt, enterLive, or nothing for
  // a passive autostart) already owns the phase.
  if (!prevPhase) setPhase(restingPhase());
}

async function ensureLiveMic() {
  // First call lazily loads the model + worker + AudioContext. Subsequent
  // calls (after enterPause → releaseLiveMic → micVad.pause()) just resume
  // the existing instance via micVad.start(), which re-acquires the mic
  // stream without re-downloading any assets.
  if (!micVad) await initMic();
  else await micVad.start();
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
      setBodyState("reconnecting", false);
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
      setBodyState("reconnecting", true);
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
    // now. Flip from the "synth" glow to "speaking" (which stops the arp
    // via setPhase). No-op if we're already in speaking — e.g. mid-stream
    // between sentences. The listening class is the barge-in case; don't
    // clobber it.
    if (workletEmpty) {
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
      // Empty STT for THIS utterance: server won't commit a turn. Return
      // to the resting phase (which stops the thinking arp via setPhase).
      if (msg.message === "empty transcription") {
        setPhase(restingPhase());
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
      // Only flip to "synthesizing" on the FIRST tts_start of a turn. In
      // sentence-chunked mode the server emits one tts_start per HTTP
      // request, so subsequent sentences within the same turn would
      // bounce speaking → synthesizing → speaking and briefly restart
      // the arp in the inter-sentence gap. While speaking is already
      // true, stay in the speaking phase — new PCM frames just keep
      // flowing.
      if (!speaking) setPhase("synthesizing");
      speaking = true;
      ttsServerEnded = false;
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
      if (!speaking) setPhase(restingPhase());
      break;
    case "error":
      thinking = false;
      for (const p of PHASES) setBodyState(p, false);
      setBodyState("error", true);
      setStatus(`error: ${msg.message}`);
      arp?.stop();
      prevPhase = null;
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
