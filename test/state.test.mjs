// Pure-reducer tests for public/state.js. Imports the browser module
// directly — it has no DOM/window deps, so node can run it as-is.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reduce,
  initialState,
  ARP_PHASES,
  TARGET_CAPTURE_RATE,
} from "../public/state.js";

// Apply a sequence of events, returning the final state plus the
// concatenated action stream (with each action tagged with its
// triggering event index, for assertion ergonomics).
function run(events, start = initialState) {
  let state = start;
  const actions = [];
  for (let i = 0; i < events.length; i++) {
    const { state: next, actions: emitted } = reduce(state, events[i]);
    state = next;
    for (const a of emitted) actions.push({ at: i, event: events[i].type, ...a });
  }
  return { state, actions };
}

const actionTypes = (actions) => actions.map((a) => a.type);
const hasAction = (actions, type) => actions.some((a) => a.type === type);

// ─── primitives ─────────────────────────────────────────────────────

test("initial state matches expected shape", () => {
  assert.equal(initialState.sessionMode, "pause");
  assert.equal(initialState.phase, "paused");
  assert.equal(initialState.speaking, false);
  assert.equal(initialState.thinking, false);
  assert.equal(initialState.workletEmpty, true);
  assert.equal(initialState.pendingClose, null);
  assert.equal(initialState.pendingOpen, null);
});

test("unknown event type throws", () => {
  assert.throws(() => reduce(initialState, { type: "BOGUS" }), /unknown event/);
});

test("returned state is frozen", () => {
  const { state } = reduce(initialState, { type: "TAP" });
  assert.throws(() => { state.sessionMode = "ptt"; });
});

// ─── pause ↔ live ───────────────────────────────────────────────────

test("TAP from pause begins opening live (phase stays paused until OPEN_DONE)", () => {
  const { state, actions } = reduce(initialState, { type: "TAP" });
  assert.equal(state.sessionMode, "live");
  assert.equal(state.phase, "paused"); // glow not lit until mic ready
  assert.equal(state.pendingOpen, "live");
  assert.deepEqual(actionTypes(actions), ["OPEN_LIVE"]);
});

test("OPEN_DONE(live) after TAP transitions to listening", () => {
  const { state, actions } = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
  ]);
  assert.equal(state.phase, "listening");
  assert.equal(state.pendingOpen, null);
  // No arp on listening.
  assert.ok(!hasAction(actions, "ARP_START"));
});

test("TAP from live closes to paused with chime + mic close", () => {
  const opened = run([{ type: "TAP" }, { type: "OPEN_DONE", kind: "live" }]).state;
  const { state, actions } = reduce(opened, { type: "TAP" });
  assert.equal(state.sessionMode, "pause");
  assert.equal(state.phase, "paused");
  assert.equal(state.pendingClose, null); // no follow-up needed
  assert.deepEqual(actionTypes(actions), ["CLOSE_LIVE"]);
});

test("CLOSE_DONE after pause-from-live stays in paused (no flush)", () => {
  const opened = run([{ type: "TAP" }, { type: "OPEN_DONE", kind: "live" }]).state;
  const { state } = run([{ type: "TAP" }, { type: "CLOSE_DONE" }], opened);
  assert.equal(state.phase, "paused");
  assert.equal(state.pendingClose, null);
});

test("TAP from live during mid-utterance flushes VAD buffer", () => {
  // Get into live then start a VAD utterance.
  const speaking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
  ]).state;
  assert.equal(speaking.phase, "recording");
  assert.equal(speaking.vadSpeaking, true);

  const { state, actions } = reduce(speaking, { type: "TAP" });
  assert.equal(state.sessionMode, "pause");
  assert.equal(state.phase, "paused"); // glow cleared immediately
  assert.equal(state.vadSpeaking, false);
  assert.equal(state.pendingClose, "transcribing");
  // Flush before close.
  assert.deepEqual(actionTypes(actions), [
    "ARP_STOP", // we were in recording? actually recording is NOT in ARP_PHASES, so no.
    "WS_FLUSH_VAD",
    "WS_SEND",
    "CLOSE_LIVE",
  ].filter((t) => t !== "ARP_STOP")); // recording is not arp, expect no ARP_STOP
});

test("CLOSE_DONE after mid-utterance pause advances to transcribing (and starts arp)", () => {
  const closing = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "TAP" },
  ]).state;
  const { state, actions } = reduce(closing, { type: "CLOSE_DONE" });
  assert.equal(state.phase, "transcribing");
  assert.equal(state.pendingClose, null);
  assert.ok(hasAction(actions, "ARP_START"));
});

// ─── server races past the close ────────────────────────────────────

test("CLOSE_DONE does NOT clobber phase if server already advanced", () => {
  // After TAP-to-pause-while-vad-speaking, the chime is still playing
  // but server raced ahead and sent TRANSCRIPT (→ thinking).
  const closing = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "TAP" }, // pendingClose=transcribing, phase=paused
    { type: "TRANSCRIPT" }, // server raced ahead — phase=thinking
  ]).state;
  assert.equal(closing.phase, "thinking");
  const { state } = reduce(closing, { type: "CLOSE_DONE" });
  // Should stay at thinking, not regress to transcribing.
  assert.equal(state.phase, "thinking");
  assert.equal(state.pendingClose, null);
});

// ─── PTT ────────────────────────────────────────────────────────────

test("HOLD from pause enters PTT immediately (phase=recording, overlay hides)", () => {
  const { state, actions } = reduce(initialState, { type: "HOLD" });
  assert.equal(state.sessionMode, "ptt");
  assert.equal(state.phase, "recording");
  assert.equal(state.pttHeld, true);
  assert.deepEqual(actionTypes(actions), ["OPEN_PTT"]);
  // OPEN_PTT carries fromLive=false from pause.
  const openPtt = actions.find((a) => a.type === "OPEN_PTT");
  assert.equal(openPtt.fromLive, false);
});

test("HOLD from live transitions to PTT with fromLive=true", () => {
  const live = run([{ type: "TAP" }, { type: "OPEN_DONE", kind: "live" }]).state;
  const { state, actions } = reduce(live, { type: "HOLD" });
  assert.equal(state.sessionMode, "ptt");
  assert.equal(state.phase, "recording");
  const openPtt = actions.find((a) => a.type === "OPEN_PTT");
  assert.equal(openPtt.fromLive, true);
});

test("OPEN_DONE(ptt) sends audio_start", () => {
  const { state, actions } = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
  ]);
  assert.equal(state.phase, "recording");
  assert.equal(state.pendingOpen, null);
  const wsSends = actions.filter((a) => a.type === "WS_SEND");
  assert.ok(wsSends.some((a) => a.msg.type === "audio_start"));
});

test("RELEASE during PTT flushes buffer and closes", () => {
  const ptt = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
  ]).state;
  const { state, actions } = reduce(ptt, { type: "RELEASE" });
  assert.equal(state.sessionMode, "pause");
  assert.equal(state.phase, "paused");
  assert.equal(state.pttHeld, false);
  assert.equal(state.pendingClose, "transcribing");
  assert.deepEqual(actionTypes(actions), ["CLOSE_PTT", "WS_FLUSH_PTT", "WS_SEND"]);
});

test("RELEASE during PTT sends audio_end so server runs STT", () => {
  // Mirrors VAD_SPEECH_END: without an audio_end the server never
  // finalizes STT and the UI hangs at "transcribing".
  const ptt = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
  ]).state;
  const { actions } = reduce(ptt, { type: "RELEASE" });
  const endMsg = actions.find((a) => a.type === "WS_SEND" && a.msg?.type === "audio_end");
  assert.ok(endMsg, "RELEASE must emit a WS_SEND audio_end");
  assert.equal(endMsg.msg.sampleRate, TARGET_CAPTURE_RATE);
});

test("CLOSE_DONE with hadAudio=false after empty PTT stays at paused", () => {
  const releasing = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
  ]).state;
  const { state, actions } = reduce(releasing, { type: "CLOSE_DONE", hadAudio: false });
  assert.equal(state.phase, "paused");
  assert.equal(state.pendingClose, null);
  assert.ok(!hasAction(actions, "ARP_START"));
});

test("CLOSE_DONE with hadAudio=true after PTT advances to transcribing", () => {
  const releasing = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
  ]).state;
  const { state, actions } = reduce(releasing, { type: "CLOSE_DONE", hadAudio: true });
  assert.equal(state.phase, "transcribing");
  assert.ok(hasAction(actions, "ARP_START"));
});

// ─── full turn ──────────────────────────────────────────────────────

test("full live-mode turn: vad start/end → transcript → tts → drain → back to listening", () => {
  const { state, actions } = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
    { type: "TTS_END" },
    { type: "AGENT_END" },
    { type: "WORKLET_DRAINED" },
  ]);
  assert.equal(state.sessionMode, "live");
  assert.equal(state.phase, "listening");
  assert.equal(state.speaking, false);
  assert.equal(state.thinking, false);
  // Arp should have started exactly once (on VAD_SPEECH_END → transcribing)
  // and stopped exactly once (on PCM_FIRST → speaking).
  const arpStarts = actions.filter((a) => a.type === "ARP_START").length;
  const arpStops = actions.filter((a) => a.type === "ARP_STOP").length;
  assert.equal(arpStarts, 1);
  assert.equal(arpStops, 1);
});

// ─── sentence-chunked TTS: arp must not bounce between sentences ───

test("subsequent TTS_START within a turn does NOT flip phase or restart arp", () => {
  const midTurn = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" }, // sentence 1
    { type: "PCM_FIRST" }, // phase=speaking
  ]).state;
  assert.equal(midTurn.phase, "speaking");
  assert.equal(midTurn.speaking, true);

  // Sentence 2 begins — server emits another TTS_START.
  const { state, actions } = reduce(midTurn, { type: "TTS_START" });
  assert.equal(state.phase, "speaking"); // unchanged
  assert.equal(state.speaking, true);
  assert.ok(!hasAction(actions, "ARP_START"));
  assert.ok(!hasAction(actions, "ARP_STOP"));
});

// ─── barge-in ──────────────────────────────────────────────────────

test("VAD_SPEECH_START during TTS playback cancels and goes to recording", () => {
  const speaking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
  ]).state;
  assert.equal(speaking.phase, "speaking");

  const { state, actions } = reduce(speaking, { type: "VAD_SPEECH_START" });
  assert.equal(state.phase, "recording");
  assert.equal(state.speaking, false);
  assert.equal(state.workletEmpty, true);
  assert.ok(hasAction(actions, "WORKLET_RESET"));
  const cancel = actions.find((a) => a.type === "WS_SEND" && a.msg.type === "cancel");
  assert.ok(cancel);
  const audioStart = actions.find((a) => a.type === "WS_SEND" && a.msg.type === "audio_start");
  assert.ok(audioStart);
});

test("HOLD during TTS playback cancels and goes to recording (PTT barge-in)", () => {
  // Mirrors VAD_SPEECH_START barge-in: pressing PTT mid-speech must
  // cancel server TTS, reset the local worklet, and clear speaking
  // flags. Without this, held audio keeps playing over the user's
  // utterance and the server keeps generating the turn we interrupted.
  const speaking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
  ]).state;
  assert.equal(speaking.phase, "speaking");

  const { state, actions } = reduce(speaking, { type: "HOLD" });
  assert.equal(state.sessionMode, "ptt");
  assert.equal(state.phase, "recording");
  assert.equal(state.speaking, false);
  assert.equal(state.workletEmpty, true);
  assert.ok(hasAction(actions, "WORKLET_RESET"));
  const cancel = actions.find((a) => a.type === "WS_SEND" && a.msg?.type === "cancel");
  assert.ok(cancel, "HOLD during TTS must send a cancel to the server");
});

test("HOLD during thinking opens PTT without cancelling — server aborts LLM on new prompt", () => {
  // No TTS is playing yet, so there's nothing local to cancel. The
  // LLM stays alive; the server-side "new prompt mid-turn" path will
  // abort it once our PTT utterance lands. thinking flag is preserved.
  const thinking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
  ]).state;
  assert.equal(thinking.thinking, true);

  const { state, actions } = reduce(thinking, { type: "HOLD" });
  assert.equal(state.sessionMode, "ptt");
  assert.equal(state.phase, "recording");
  assert.equal(state.thinking, true, "thinking preserved — server handles LLM abort");
  assert.ok(!hasAction(actions, "WORKLET_RESET"));
  assert.ok(!actions.some((a) => a.type === "WS_SEND" && a.msg?.type === "cancel"));
});

test("HOLD during synthesizing cancels TTS but leaves thinking alive", () => {
  // synthesizing has speaking=true (TTS_START set it). Cancel TTS so
  // any first-chunk audio is suppressed, but don't pre-empt the LLM.
  const synth = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
  ]).state;
  assert.equal(synth.phase, "synthesizing");
  assert.equal(synth.speaking, true);
  assert.equal(synth.thinking, true);

  const { state, actions } = reduce(synth, { type: "HOLD" });
  assert.equal(state.phase, "recording");
  assert.equal(state.speaking, false);
  assert.equal(state.thinking, true, "thinking preserved on barge-in");
  assert.ok(hasAction(actions, "WORKLET_RESET"));
  const cancel = actions.find((a) => a.type === "WS_SEND" && a.msg?.type === "cancel");
  assert.ok(cancel);
});

test("VAD_SPEECH_START during thinking does not cancel — server handles it on new prompt", () => {
  const thinking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
  ]).state;
  const { state, actions } = reduce(thinking, { type: "VAD_SPEECH_START" });
  assert.equal(state.phase, "recording");
  assert.equal(state.thinking, true);
  assert.ok(!actions.some((a) => a.type === "WS_SEND" && a.msg?.type === "cancel"));
});

test("barge-in via HOLD stops the arpeggio (was thinking/synthesizing)", () => {
  // thinking is in ARP_PHASES — entering recording must emit ARP_STOP.
  const thinking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
  ]).state;
  assert.ok(ARP_PHASES.has(thinking.phase));
  const { actions } = reduce(thinking, { type: "HOLD" });
  assert.ok(hasAction(actions, "ARP_STOP"), "HOLD from thinking must stop the arp");

  const synth = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
  ]).state;
  assert.equal(synth.phase, "synthesizing");
  const { actions: a2 } = reduce(synth, { type: "HOLD" });
  assert.ok(hasAction(a2, "ARP_STOP"), "HOLD from synthesizing must stop the arp");
});

test("barge-in via VAD_SPEECH_START stops the arpeggio (was thinking)", () => {
  const thinking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
  ]).state;
  const { actions } = reduce(thinking, { type: "VAD_SPEECH_START" });
  assert.ok(hasAction(actions, "ARP_STOP"), "VAD barge-in from thinking must stop the arp");
});

test("stale TRANSCRIPT during recording (post-barge via VAD) does not clobber phase", () => {
  // User started speaking again while the previous utterance's STT was
  // still running on the server. The late TRANSCRIPT lands while we're
  // in recording — it must update thinking flag but leave phase alone.
  const recording = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" }, // phase=transcribing
    { type: "VAD_SPEECH_START" }, // barge-in mid-STT → phase=recording
  ]).state;
  assert.equal(recording.phase, "recording");

  const { state, actions } = reduce(recording, { type: "TRANSCRIPT" });
  assert.equal(state.phase, "recording", "stale TRANSCRIPT must not flip recording → thinking");
  assert.equal(state.thinking, true, "thinking flag still set so AGENT_END can resolve");
  assert.ok(!hasAction(actions, "ARP_START"), "no arp should start while user is speaking");
});

test("stale TRANSCRIPT during PTT recording does not clobber phase", () => {
  // Same race via PTT: HOLD during transcribing → recording, then the
  // old STT lands.
  const recording = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" }, // phase=transcribing
    { type: "HOLD" }, // phase=recording, sessionMode=ptt
    { type: "OPEN_DONE", kind: "ptt" },
  ]).state;
  assert.equal(recording.phase, "recording");

  const { state } = reduce(recording, { type: "TRANSCRIPT" });
  assert.equal(state.phase, "recording");
  assert.equal(state.thinking, true);
});

test("AGENT_END arriving after an interrupt does not flip phase back", () => {
  // After a HOLD-driven barge-in, the server's in-flight AGENT_END may
  // arrive late. We're now in PTT/recording — that must not be
  // clobbered by the stale AGENT_END from the cancelled turn.
  const post = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "HOLD" }, // PTT barge-in cancels the LLM
    { type: "OPEN_DONE", kind: "ptt" },
  ]).state;
  assert.equal(post.phase, "recording");

  const { state } = reduce(post, { type: "AGENT_END" });
  assert.equal(state.phase, "recording");
  assert.equal(state.thinking, false);
});

test("WORKLET_DRAINED while still in recording (post-barge) does not clobber phase", () => {
  const bargeIn = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
    { type: "VAD_SPEECH_START" }, // barge — speaking flipped to false, workletEmpty=true
    { type: "TTS_END" }, // late tts_end from the cancelled turn
  ]).state;
  // maybeEndSpeaking sees speaking=false, so noop.
  assert.equal(bargeIn.phase, "recording");
});

// ─── pause during in-flight turn ───────────────────────────────────

test("TAP during thinking in live keeps the arp running until the turn ends naturally", () => {
  // Live → vad-end → transcript → thinking (arp on).
  const thinking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
  ]).state;
  assert.equal(thinking.phase, "thinking");
  assert.equal(thinking.thinking, true);

  // User presses pause mid-turn. Mic should close, but the LLM/TTS
  // pipeline continues server-side — the arp must keep playing through
  // thinking → synthesizing → speaking and only stop at the natural
  // exit (PCM_FIRST → speaking), exactly as if no pause had happened.
  const { state, actions } = reduce(thinking, { type: "TAP" });
  assert.equal(state.sessionMode, "pause");
  assert.equal(state.phase, "thinking", "phase should not regress to paused mid-turn");
  assert.ok(!actionTypes(actions).includes("ARP_STOP"), "arp must not stop on user pause mid-turn");
});

// ─── empty + error edges ───────────────────────────────────────────

test("STATUS_EMPTY in live returns to listening", () => {
  const live = run([{ type: "TAP" }, { type: "OPEN_DONE", kind: "live" }]).state;
  // Simulate a misfire we sent through to STT that came back empty.
  const transcribing = reduce(live, { type: "VAD_SPEECH_END" }).state;
  const { state } = reduce(transcribing, { type: "STATUS_EMPTY" });
  assert.equal(state.phase, "listening");
});

test("AGENT_END with no speech returns to resting phase (live → listening)", () => {
  const live = run([{ type: "TAP" }, { type: "OPEN_DONE", kind: "live" }]).state;
  const thinking = run([
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
  ], live).state;
  const { state } = reduce(thinking, { type: "AGENT_END" });
  assert.equal(state.phase, "listening");
  assert.equal(state.thinking, false);
});

test("AGENT_END while speaking does NOT change phase", () => {
  const speaking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
  ]).state;
  const { state } = reduce(speaking, { type: "AGENT_END" });
  assert.equal(state.phase, "speaking");
  assert.equal(state.thinking, false);
});

test("TTS_CANCEL resets speaking flags and resets worklet", () => {
  const speaking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
  ]).state;
  const { state, actions } = reduce(speaking, { type: "TTS_CANCEL" });
  assert.equal(state.speaking, false);
  assert.equal(state.ttsServerEnded, false);
  assert.equal(state.workletEmpty, true);
  assert.equal(state.phase, "speaking"); // phase unchanged; new turn will set it
  assert.ok(hasAction(actions, "WORKLET_RESET"));
});

test("WS_CLOSE wipes transient flags and stops arp if running", () => {
  const arping = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" }, // phase=transcribing, arp on
  ]).state;
  assert.ok(ARP_PHASES.has(arping.phase));
  const { state, actions } = reduce(arping, { type: "WS_CLOSE" });
  assert.equal(state.thinking, false);
  assert.equal(state.speaking, false);
  assert.ok(hasAction(actions, "ARP_STOP"));
});

test("OPEN_ERROR returns to pause with errorMessage set", () => {
  const opening = reduce(initialState, { type: "TAP" }).state;
  const { state } = reduce(opening, { type: "OPEN_ERROR", message: "permission denied" });
  assert.equal(state.sessionMode, "pause");
  assert.equal(state.phase, "paused");
  assert.equal(state.errorMessage, "permission denied");
});

test("OPEN_DONE for stale open (user toggled away) is ignored", () => {
  // User opens live, then immediately toggles back to pause before
  // OPEN_DONE arrives.
  const opening = reduce(initialState, { type: "TAP" }).state;
  // User taps again to go back — but pendingOpen is "live" and
  // sessionMode is "live", so TAP would close it. Drive that:
  const closing = reduce(opening, { type: "TAP" }).state;
  assert.equal(closing.sessionMode, "pause");

  // Late OPEN_DONE arrives.
  const { state } = reduce(closing, { type: "OPEN_DONE", kind: "live" });
  assert.equal(state.phase, "paused"); // unchanged
  assert.equal(state.pendingOpen, null);
});

// ─── VAD misfire variants ──────────────────────────────────────────

test("VAD_MISFIRE after barge-in cancel goes to thinking (LLM loop still active)", () => {
  // Barge-in cleared `speaking` (TTS was cancelled) but left thinking=true.
  // A subsequent misfire should not flip back to speaking — there's nothing
  // to speak. Thinking is the right surface: the server may retry.
  const post = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
    { type: "VAD_SPEECH_START" }, // barge
  ]).state;
  const { state } = reduce(post, { type: "VAD_MISFIRE" });
  assert.equal(state.phase, "thinking");
});

test("VAD_MISFIRE while idle returns to listening", () => {
  const live = run([{ type: "TAP" }, { type: "OPEN_DONE", kind: "live" }]).state;
  const recording = reduce(live, { type: "VAD_SPEECH_START" }).state;
  const { state } = reduce(recording, { type: "VAD_MISFIRE" });
  assert.equal(state.phase, "listening");
});

// ─── audio_end always rides the right sample rate ──────────────────

test("VAD_SPEECH_END action carries the configured capture rate", () => {
  const live = run([{ type: "TAP" }, { type: "OPEN_DONE", kind: "live" }]).state;
  const { actions } = reduce(live, { type: "VAD_SPEECH_END" });
  const endMsg = actions.find((a) => a.type === "WS_SEND" && a.msg.type === "audio_end");
  assert.equal(endMsg.msg.sampleRate, TARGET_CAPTURE_RATE);
});
