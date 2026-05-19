// Pure state machine for the voice UI. No DOM access, no async, no
// timers — every input is an event, every output is a {state, actions}
// pair where `actions` are pure descriptions of side effects the driver
// (app.js) is responsible for performing.
//
// The driver:
//   - dispatches events into reduce(state, event)
//   - applies the returned state to the DOM (body classes, status text)
//   - executes the returned actions (chime, mic open/close, ws send, ...)
//   - fires follow-up events as those side-effects complete (OPEN_DONE,
//     CLOSE_DONE, WORKLET_DRAINED, etc.)
//
// All of the timing-race bugs we've hit live in the interaction between
// session-mode transitions (open/close mic + chime) and async server
// events (transcript, tts_start, first PCM) — those are exactly the
// transitions enumerated here, which is the point of pulling it out.

export const PHASES = [
  "paused",
  "listening",
  "recording",
  "transcribing",
  "thinking",
  "synthesizing",
  "speaking",
];

// Phases during which the "thinking" arpeggio plays. The reducer emits
// ARP_START / ARP_STOP actions when phase enters / leaves this set.
export const ARP_PHASES = new Set(["transcribing", "thinking", "synthesizing"]);

export const TARGET_CAPTURE_RATE = 16000;

export const initialState = Object.freeze({
  sessionMode: "pause", // "pause" | "live" | "ptt"
  phase: "paused",
  pttHeld: false,
  vadSpeaking: false,
  // TTS in flight from the server's POV. Set true on first tts_start of
  // a turn; cleared when the worklet has drained AND the server has sent
  // tts_end. Subsequent tts_starts within the same turn (sentence-chunked
  // streaming) do NOT flip phase — see TTS_START below.
  speaking: false,
  // LLM loop is active: true between TRANSCRIPT and AGENT_END.
  thinking: false,
  ttsServerEnded: false,
  workletEmpty: true,
  // What phase to advance to once the close sequence (mic-off + chime)
  // finishes. Set by TAP/RELEASE when entering a close. Resolved on
  // CLOSE_DONE: if phase is still "paused" (no server race) we apply it.
  pendingClose: null,
  // What kind of mic-open is in flight. The OPEN_DONE event checks this
  // against sessionMode — if the user toggled away while the open was
  // running, we drop the result and the driver runs the close.
  pendingOpen: null, // null | "live" | "ptt"
  errorMessage: null,
});

// Public entry point. Returns a frozen {state, actions} pair. The state
// is a brand-new object so callers can `===`-compare against the prior
// state if they want.
export function reduce(state, event) {
  const handler = HANDLERS[event.type];
  if (!handler) {
    throw new Error(`unknown event type: ${event.type}`);
  }
  const result = handler(state, event);
  return {
    state: Object.freeze(result.state),
    actions: Object.freeze(result.actions ?? []),
  };
}

// Resting phase per session mode. After any flow that returns to
// baseline (TTS done, empty STT, agent_end with no speech, ...) the
// phase snaps to whichever of these matches the current sessionMode.
function restingPhase(state) {
  if (state.sessionMode === "live") return "listening";
  if (state.sessionMode === "ptt") return "recording";
  return "paused";
}

// Apply a phase change and emit arp transition actions if we crossed
// the ARP_PHASES boundary. No-op (returns state unchanged with no
// actions) if the phase didn't actually change.
function withPhase(state, newPhase, extraActions = []) {
  if (state.phase === newPhase) {
    return { state, actions: extraActions };
  }
  const wasArp = ARP_PHASES.has(state.phase);
  const isArp = ARP_PHASES.has(newPhase);
  const arpActions = [];
  if (!wasArp && isArp) arpActions.push({ type: "ARP_START" });
  else if (wasArp && !isArp) arpActions.push({ type: "ARP_STOP" });
  return {
    state: { ...state, phase: newPhase },
    actions: [...arpActions, ...extraActions],
  };
}

// Barge-in helper: stop local TTS playback and tell the server to halt
// the current synthesis so the user can speak without the assistant
// talking over them. The LLM loop is NOT cancelled here — when the new
// utterance's STT lands, the server's "new prompt arrived mid-turn"
// path aborts the in-flight LLM call and runs the new turn fresh.
// No-op when no TTS is in flight.
function cancelInFlight(state) {
  if (!state.speaking) return { state, actions: [] };
  const next = {
    ...state,
    speaking: false,
    ttsServerEnded: false,
    workletEmpty: true,
  };
  return {
    state: next,
    actions: [
      { type: "WORKLET_RESET" },
      { type: "WS_SEND", msg: { type: "cancel" } },
    ],
  };
}

// The "speaking → end" check. Both TTS_END and WORKLET_DRAINED call into
// this: speaking ends only when BOTH have happened.
function maybeEndSpeaking(state) {
  if (!state.speaking || !state.ttsServerEnded || !state.workletEmpty) {
    return { state, actions: [] };
  }
  const next = { ...state, speaking: false, ttsServerEnded: false };
  // Barge-in case: a fresh VAD speech-start already moved us to recording.
  if (state.phase === "recording") {
    return { state: next, actions: [] };
  }
  if (next.thinking) return withPhase(next, "thinking");
  return withPhase(next, restingPhase(next));
}

const HANDLERS = {
  // ─── user input ───────────────────────────────────────────────────

  TAP(state) {
    if (state.sessionMode === "ptt") return { state, actions: [] };
    if (state.sessionMode === "pause") {
      // Begin opening live mode. Phase stays paused (no glow) until the
      // mic is actually open — OPEN_DONE flips us to listening.
      return {
        state: { ...state, sessionMode: "live", pendingOpen: "live" },
        actions: [{ type: "OPEN_LIVE" }],
      };
    }
    // sessionMode === "live": close to pause.
    const wasVadSpeaking = state.vadSpeaking;
    const flushActions = wasVadSpeaking
      ? [
          { type: "WS_FLUSH_VAD" },
          { type: "WS_SEND", msg: { type: "audio_end", sampleRate: TARGET_CAPTURE_RATE } },
        ]
      : [];
    // If a turn is in flight server-side (transcribing/thinking/synthesizing
    // or speaking), the user pressing pause only closes the mic — the
    // turn continues. Leaving the phase alone keeps the arp playing
    // through to its natural end (PCM_FIRST → speaking) and the closing
    // handlers (TTS_END+drained, AGENT_END) settle to "paused" via
    // restingPhase since sessionMode is now "pause".
    const midTurn = ARP_PHASES.has(state.phase) || state.phase === "speaking";
    const next = {
      ...state,
      sessionMode: "pause",
      vadSpeaking: false,
      pendingClose: wasVadSpeaking ? "transcribing" : null,
    };
    if (midTurn) {
      return {
        state: next,
        actions: [...flushActions, { type: "CLOSE_LIVE" }],
      };
    }
    return withPhase(next, "paused", [...flushActions, { type: "CLOSE_LIVE" }]);
  },

  HOLD(state) {
    if (state.sessionMode === "ptt") return { state, actions: [] };
    // Whether coming from pause or live, we end up in PTT. From live we
    // must silently pause the VAD mic first; the driver bundles that
    // into OPEN_PTT. Any in-flight server turn (thinking / synthesizing
    // / speaking) gets cancelled — symmetric with VAD barge-in.
    const fromLive = state.sessionMode === "live";
    const { state: cancelled, actions: cancelActions } = cancelInFlight(state);
    const next = {
      ...cancelled,
      sessionMode: "ptt",
      pttHeld: true,
      vadSpeaking: false,
      pendingOpen: "ptt",
    };
    return withPhase(next, "recording", [
      ...cancelActions,
      { type: "OPEN_PTT", fromLive },
    ]);
  },

  RELEASE(state) {
    if (state.sessionMode !== "ptt") return { state, actions: [] };
    // WS_FLUSH_PTT ships the buffered PCM utterance; the audio_end
    // message tells the server "no more audio coming, run STT now." On
    // an empty PTT (very short press, no captured frames) the server
    // treats audio_end as a no-op (empty-utterance status), so we
    // always emit it. CLOSE_DONE later resolves transcribing vs paused
    // via the driver-supplied hadAudio flag.
    const next = {
      ...state,
      sessionMode: "pause",
      pttHeld: false,
      pendingClose: "transcribing",
    };
    return withPhase(next, "paused", [
      { type: "CLOSE_PTT" },
      { type: "WS_FLUSH_PTT" },
      { type: "WS_SEND", msg: { type: "audio_end", sampleRate: TARGET_CAPTURE_RATE } },
    ]);
  },

  // ─── driver async completions ────────────────────────────────────

  OPEN_DONE(state, { kind }) {
    if (state.pendingOpen !== kind || state.sessionMode !== kind) {
      // User toggled away while opening — driver will run the close.
      return { state: { ...state, pendingOpen: null }, actions: [] };
    }
    const next = { ...state, pendingOpen: null };
    if (kind === "live") return withPhase(next, "listening");
    if (kind === "ptt") {
      return {
        state: next,
        actions: [{ type: "WS_SEND", msg: { type: "audio_start" } }],
      };
    }
    return { state: next, actions: [] };
  },

  OPEN_ERROR(state, { message }) {
    const next = {
      ...state,
      sessionMode: "pause",
      pendingOpen: null,
      pttHeld: false,
      errorMessage: message,
    };
    return withPhase(next, "paused");
  },

  CLOSE_DONE(state, { hadAudio = true } = {}) {
    const target = state.pendingClose;
    const next = { ...state, pendingClose: null };
    // Only advance if we're still at "paused" — the server may have
    // raced ahead (transcript / tts_start / pcm_first) while the mic-
    // close + chime were running. In that case the more advanced phase
    // wins and we don't downgrade.
    if (state.phase !== "paused") return { state: next, actions: [] };
    if (!target || target === "paused") return { state: next, actions: [] };
    if (!hadAudio) return { state: next, actions: [] };
    return withPhase(next, target);
  },

  // ─── VAD ─────────────────────────────────────────────────────────

  VAD_SPEECH_START(state) {
    // Barge-in: cancel any in-flight server turn (TTS playback OR LLM
    // loop) before opening the new utterance.
    const { state: cancelled, actions: cancelActions } = cancelInFlight(state);
    const next = { ...cancelled, vadSpeaking: true };
    return withPhase(next, "recording", [
      ...cancelActions,
      { type: "WS_SEND", msg: { type: "audio_start" } },
    ]);
  },

  VAD_SPEECH_END(state) {
    const next = { ...state, vadSpeaking: false };
    return withPhase(next, "transcribing", [
      { type: "WS_FLUSH_VAD" },
      { type: "WS_SEND", msg: { type: "audio_end", sampleRate: TARGET_CAPTURE_RATE } },
    ]);
  },

  VAD_MISFIRE(state) {
    const next = { ...state, vadSpeaking: false };
    if (next.speaking) return withPhase(next, "speaking");
    if (next.thinking) return withPhase(next, "thinking");
    return withPhase(next, restingPhase(next));
  },

  // ─── server messages ─────────────────────────────────────────────

  TRANSCRIPT(state) {
    // If the user has already begun a new utterance (barge-in landed us
    // in recording), a late TRANSCRIPT from the previous turn must not
    // clobber the recording phase. Track thinking so AGENT_END can
    // still resolve cleanly when it arrives.
    const next = { ...state, thinking: true };
    if (state.phase === "recording") return { state: next, actions: [] };
    return withPhase(next, "thinking");
  },

  TTS_START(state) {
    // Only flip to synthesizing on the FIRST tts_start of a turn. In
    // sentence-chunked streaming the server emits one per HTTP request;
    // letting subsequent ones flip phase would bounce speaking →
    // synthesizing → speaking and restart the arp in inter-sentence gaps.
    const wasSpeaking = state.speaking;
    const next = { ...state, speaking: true, ttsServerEnded: false };
    if (wasSpeaking) return { state: next, actions: [] };
    return withPhase(next, "synthesizing");
  },

  TTS_CANCEL(state) {
    const next = {
      ...state,
      speaking: false,
      ttsServerEnded: false,
      workletEmpty: true,
    };
    return { state: next, actions: [{ type: "WORKLET_RESET" }] };
  },

  TTS_END(state) {
    const next = { ...state, ttsServerEnded: true };
    return maybeEndSpeaking(next);
  },

  AGENT_END(state) {
    const next = { ...state, thinking: false };
    if (next.speaking) return { state: next, actions: [] };
    return withPhase(next, restingPhase(next));
  },

  STATUS_EMPTY(state) {
    return withPhase(state, restingPhase(state));
  },

  // ─── worklet / PCM ───────────────────────────────────────────────

  PCM_FIRST(state) {
    // Driver fires this when a PCM frame arrives while workletEmpty=true.
    const next = { ...state, workletEmpty: false };
    if (next.speaking && next.phase !== "recording") {
      return withPhase(next, "speaking");
    }
    return { state: next, actions: [] };
  },

  WORKLET_DRAINED(state) {
    const next = { ...state, workletEmpty: true };
    return maybeEndSpeaking(next);
  },

  // ─── ws lifecycle ────────────────────────────────────────────────

  WS_OPEN(state) {
    return { state: { ...state, errorMessage: null }, actions: [] };
  },

  WS_CLOSE(state) {
    // Tear down transient state. Phase stays where it is so the resume
    // path can decide (initSession sets it on reconnect if nothing else
    // has). Arp must stop because the turn that owned it is dead.
    const next = {
      ...state,
      speaking: false,
      thinking: false,
      ttsServerEnded: false,
      workletEmpty: true,
    };
    const actions = ARP_PHASES.has(state.phase) ? [{ type: "ARP_STOP" }] : [];
    if (state.speaking) actions.unshift({ type: "WORKLET_RESET" });
    return { state: next, actions };
  },

  ERROR(state, { message }) {
    return {
      state: { ...state, thinking: false, errorMessage: message },
      actions: ARP_PHASES.has(state.phase) ? [{ type: "ARP_STOP" }] : [],
    };
  },
};
