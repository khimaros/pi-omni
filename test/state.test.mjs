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
  // CLOSE_LIVE owns the mic release; the auto-RELEASE_MIC from withPhase
  // is suppressed when a close action is already in the pipeline so the
  // release doesn't race ahead and pause the mic mid-chime.
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
  // Flush before close. CLOSE_LIVE owns the mic release — no parallel
  // RELEASE_MIC (see "TAP from live closes to paused" for the rationale).
  assert.deepEqual(actionTypes(actions), [
    "WS_FLUSH_VAD",
    "WS_SEND",
    "CLOSE_LIVE",
  ]);
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
    { type: "COMPONENT" }, // thinking_end (real turn marker)
    { type: "LLM_TEXT" },  // produced some text
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

test("stale AGENT_END from cancelled turn does not reset phase while new STT is pending", () => {
  // Real-world race: user holds PTT mid-TTS, releases, server aborts
  // the in-flight turn and starts STT on the new utterance. Late
  // tts_cancel + agent_end from the cancelled turn arrive AFTER
  // CLOSE_DONE has advanced us to "transcribing". They must NOT regress
  // phase to "paused" (restingPhase for sessionMode=pause) — that
  // strands the UI: when the new turn's TRANSCRIPT arrives later we
  // wake back up, but the brief paused flicker stops the arp and the
  // user perceives a "no response" gap. Worse, if the new TRANSCRIPT
  // races a stale agent_end, the second AGENT_END can clobber thinking
  // and we never advance past it.
  const transcribing = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },         // mid-speech: thinking=true, speaking=true
    { type: "HOLD" },              // PTT barge cancels TTS, sessionMode=ptt, phase=recording
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },           // sessionMode=pause, pendingClose=transcribing, phase=paused
    { type: "CLOSE_DONE", hadAudio: true }, // phase=transcribing
  ]).state;
  assert.equal(transcribing.phase, "transcribing");
  assert.equal(transcribing.thinking, true, "old turn's thinking still set");

  // Stale tts_cancel from the cancelled turn — should not flip phase.
  const afterCancel = reduce(transcribing, { type: "TTS_CANCEL" }).state;
  assert.equal(afterCancel.phase, "transcribing");

  // Stale agent_end from the cancelled turn — must NOT regress phase.
  // It also leaves thinking alone since we treat no-activity ends as
  // a no-op (the real new-turn end will clear thinking later).
  const { state: afterAgentEnd, actions } = reduce(afterCancel, { type: "AGENT_END" });
  assert.equal(afterAgentEnd.phase, "transcribing",
    "stale AGENT_END must not regress phase while new STT is pending");
  assert.equal(afterAgentEnd.thinking, true,
    "stale AGENT_END is a no-op — thinking stays until real new-turn end");
  assert.ok(!hasAction(actions, "ARP_STOP"), "arp must keep playing through the stale agent_end");
});

test("barge-in spans LLM completion: HOLD mid-speaking, AGENT_END arrives while held, RELEASE later", () => {
  // User HOLDs during TTS playback (cancelInFlight fires). The server
  // continues to drain the cancelled turn — its agent_end arrives
  // while the user is STILL holding (mid-recording). With my fix, the
  // server suppresses that agent_end so the client never sees it. But
  // if it leaks through (network reorder, server bug), the reducer
  // must not regress the recording phase or strand the UI.
  const recording = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },             // phase=speaking
    { type: "HOLD" },                  // PTT barge — cancelInFlight, phase=recording
    { type: "OPEN_DONE", kind: "ptt" },
  ]).state;
  assert.equal(recording.phase, "recording");
  assert.equal(recording.speaking, false);

  // Stray late events from the cancelled turn while user is still holding.
  const afterStrayTtsEnd = reduce(recording, { type: "TTS_END" }).state;
  assert.equal(afterStrayTtsEnd.phase, "recording");

  const afterStrayDrain = reduce(afterStrayTtsEnd, { type: "WORKLET_DRAINED" }).state;
  assert.equal(afterStrayDrain.phase, "recording");

  const { state: afterStrayAgentEnd } = reduce(afterStrayDrain, { type: "AGENT_END" });
  assert.equal(afterStrayAgentEnd.phase, "recording",
    "late AGENT_END while user is still holding must not regress phase");
  assert.equal(afterStrayAgentEnd.thinking, false);

  // User finally releases; new turn flows normally.
  const released = run([
    { type: "RELEASE" },
    { type: "CLOSE_DONE", hadAudio: true },
  ], afterStrayAgentEnd).state;
  assert.equal(released.phase, "transcribing");

  const next = run([
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
    { type: "TTS_END" },
    { type: "AGENT_END" },
    { type: "WORKLET_DRAINED" },
  ], released).state;
  assert.equal(next.phase, "paused", "new turn must end cleanly at the resting phase");
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
  // Stale AGENT_END (no activity for current turn) is a no-op; thinking
  // stays set until a real end fires for the new turn.
  assert.equal(state.thinking, true);
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

test("AGENT_END after a turn with activity but no LLM text emits SHOW_PLACEHOLDER", () => {
  // The model can finish a turn producing only thinking/tool blocks
  // (no user-visible text). Without a marker the UI is left blank and
  // looks broken. Reducer emits a placeholder action so the driver can
  // render "(no response)" in the assistant slot. The COMPONENT event
  // satisfies the new-turn-activity guard (see AGENT_END handler).
  const turn = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" }, // start of LLM turn, gotText reset
    { type: "COMPONENT" },  // thinking_end fires for any real turn
  ]).state;
  const { actions } = reduce(turn, { type: "AGENT_END" });
  assert.ok(hasAction(actions, "SHOW_PLACEHOLDER"),
    "AGENT_END after activity with no LLM_TEXT must emit SHOW_PLACEHOLDER");
});

test("AGENT_END after LLM_TEXT does NOT emit SHOW_PLACEHOLDER", () => {
  const withText = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" }, // any text delta during the turn clears the placeholder
  ]).state;
  const { actions } = reduce(withText, { type: "AGENT_END" });
  assert.ok(!hasAction(actions, "SHOW_PLACEHOLDER"));
});

test("TRANSCRIPT resets the LLM_TEXT-seen flag for the next turn", () => {
  // After a normal turn with text, a NEW turn that ends with no text
  // must still emit the placeholder — the flag is per-turn, not sticky.
  const afterFirstTurn = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" },
    { type: "AGENT_END" },
    // Second turn: no LLM_TEXT this time.
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "COMPONENT" }, // new turn really started (thinking_end)
  ]).state;
  const { actions } = reduce(afterFirstTurn, { type: "AGENT_END" });
  assert.ok(hasAction(actions, "SHOW_PLACEHOLDER"),
    "TRANSCRIPT must reset gotText so the next empty turn still placeholders");
});

test("AGENT_END with no speech (after activity) returns to resting phase (live → listening)", () => {
  const live = run([{ type: "TAP" }, { type: "OPEN_DONE", kind: "live" }]).state;
  const thinking = run([
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "TRANSCRIPT" },
    { type: "COMPONENT" }, // real turn activity
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
    { type: "COMPONENT" },
    { type: "LLM_TEXT" },
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

// ─── stale AGENT_END robustness ────────────────────────────────────
// The server-side TurnLifecycle ought to suppress prior-turn agent_end
// events that race across a barge-in, but the client must also be
// robust to one slipping through: the stale AGENT_END can arrive
// AFTER the new turn's TRANSCRIPT but BEFORE its first LLM_TEXT,
// regressing phase to paused with placeholder fired. The user then
// sees a dim/paused orb while the new turn is in fact streaming text.
// LLM_TEXT (delta or full) is unambiguous evidence the LLM is producing
// for the current turn — it must restore the thinking phase.

test("stale AGENT_END is a no-op; phase + thinking preserved for new turn", () => {
  // PTT round-trip up to "phase=thinking" for the new turn.
  const ptt = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
    { type: "CLOSE_DONE", hadAudio: true }, // → transcribing
    { type: "TRANSCRIPT" },                  // → thinking
  ]).state;
  assert.equal(ptt.phase, "thinking");
  // Stale AGENT_END from the cancelled prior turn slips through.
  const { state: stale, actions: staleActions } = reduce(ptt, { type: "AGENT_END" });
  assert.equal(stale.phase, "thinking",
    "stale AGENT_END (no activity yet) must not regress phase");
  assert.equal(stale.thinking, true, "thinking flag preserved");
  assert.ok(!hasAction(staleActions, "ARP_STOP"), "arp must keep playing");
  // First delta of the real new turn — phase already thinking, just
  // updates gotText/sawTurnActivity.
  const { state, actions } = reduce(stale, { type: "LLM_TEXT" });
  assert.equal(state.phase, "thinking");
  assert.equal(state.gotText, true);
  assert.equal(state.sawTurnActivity, true);
  assert.ok(!hasAction(actions, "ARP_START"), "arp already running, no restart");
});

test("LLM_TEXT while already in thinking is a no-op for phase", () => {
  // Sanity: don't double-fire ARP_START on the normal path.
  const inThinking = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
    { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
  ]).state;
  const { state, actions } = reduce(inThinking, { type: "LLM_TEXT" });
  assert.equal(state.phase, "thinking");
  assert.equal(actionTypes(actions).filter((t) => t === "ARP_START").length, 0);
});

test("LLM_TEXT while speaking does not regress phase", () => {
  // If TTS already started for the new turn (phase=speaking) before
  // a later delta arrives, LLM_TEXT must not drag us back to thinking.
  const speaking = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
    { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
    { type: "COMPONENT" },
    { type: "LLM_TEXT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
  ]).state;
  assert.equal(speaking.phase, "speaking");
  const { state } = reduce(speaking, { type: "LLM_TEXT" });
  assert.equal(state.phase, "speaking");
});

test("LLM_TEXT restores thinking after stale AGENT_END on VAD barge path", () => {
  // Live/VAD analogue of the PTT scenario above. A user bargies in
  // while a turn is streaming; the server's drained prior-turn
  // agent_end may race into the new turn's stream after TRANSCRIPT
  // but before any LLM_TEXT lands.
  const ptt = run([
    { type: "TAP" },                        // pause → live
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },           // first utterance
    { type: "VAD_SPEECH_END" },             // → transcribing
    { type: "TRANSCRIPT" },                 // → thinking, gotText=false
  ]).state;
  assert.equal(ptt.phase, "thinking");
  const { state: stale, actions: staleActions } = reduce(ptt, { type: "AGENT_END" });
  assert.equal(stale.phase, "thinking",
    "stale AGENT_END is a no-op on live path too");
  assert.ok(!hasAction(staleActions, "ARP_STOP"));
  const { state } = reduce(stale, { type: "LLM_TEXT" });
  assert.equal(state.phase, "thinking");
  assert.equal(state.thinking, true);
});

// ─── stale AGENT_END placeholder workaround ────────────────────────
// The server SHOULD suppress prior-turn agent_end via TurnLifecycle
// cancellation, but we've observed it leaking through in production
// (root cause TBD — pi runtime drain ordering). The client-side
// workaround: only emit SHOW_PLACEHOLDER on AGENT_END if the new turn
// has shown SOME activity (a COMPONENT event for thinking/tool, or
// an LLM_TEXT). A bare AGENT_END arriving right after TRANSCRIPT,
// with no activity in between, is almost certainly stale — show no
// placeholder.

test("AGENT_END right after TRANSCRIPT with no activity does NOT fire placeholder", () => {
  // Reproduces user log timing: RELEASE → CLOSE_DONE → ws:transcript →
  // ws:agent_end (40ms later, before any llm_delta).
  const ptt = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
    { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
  ]).state;
  const { actions } = reduce(ptt, { type: "AGENT_END" });
  assert.ok(!hasAction(actions, "SHOW_PLACEHOLDER"),
    "stale agent_end before any new-turn activity must not surface (no response)");
});

test("AGENT_END after COMPONENT but no text DOES fire placeholder", () => {
  // Legitimate empty-answer turn: server emitted thinking_end (component)
  // but the LLM produced no text block. The placeholder is the correct
  // surface for this case.
  const post = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
    { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
    { type: "COMPONENT" },
  ]).state;
  const { actions } = reduce(post, { type: "AGENT_END" });
  assert.ok(hasAction(actions, "SHOW_PLACEHOLDER"),
    "real empty-of-text turn (after activity) should show placeholder");
});

test("AGENT_END after LLM_TEXT does NOT fire placeholder (gotText guard intact)", () => {
  // Pre-existing behavior: any streamed text suppresses placeholder.
  const post = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
    { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" },
  ]).state;
  const { actions } = reduce(post, { type: "AGENT_END" });
  assert.ok(!hasAction(actions, "SHOW_PLACEHOLDER"));
});

test("COMPONENT event sets sawTurnActivity but doesn't change phase", () => {
  const post = run([
    { type: "HOLD" },
    { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" },
    { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
  ]).state;
  const { state, actions } = reduce(post, { type: "COMPONENT" });
  assert.equal(state.phase, "thinking");
  assert.deepEqual(actions, []);
});

test("TRANSCRIPT resets sawTurnActivity for a new turn", () => {
  // Activity from a prior turn must not satisfy the placeholder guard
  // for the next turn — fresh utterance fresh slate.
  const after1 = run([
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
    { type: "COMPONENT" },
    { type: "AGENT_END" }, // turn 1 ends (with activity → placeholder ok)
  ]).state;
  // Start turn 2.
  const t2 = run([
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
  ], after1).state;
  // Stale agent_end leaks from turn 1 before turn 2 has any activity.
  const { actions } = reduce(t2, { type: "AGENT_END" });
  assert.ok(!hasAction(actions, "SHOW_PLACEHOLDER"),
    "turn 1's activity must not satisfy the guard for turn 2's stale agent_end");
});

// ─── post-TTS settle (the stuck-in-thinking bug) ───────────────────
// After the second turn plays its response and the worklet drains,
// the UI was reported stuck in "thinking" forever. Captures the full
// barge-recovery sequence end-to-end and asserts the phase actually
// settles back to paused once AGENT_END arrives.

test("full PTT-barge round-trip settles to paused after TTS + AGENT_END", () => {
  const final = run([
    // First utterance (full turn).
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" }, { type: "COMPONENT" },
    { type: "LLM_TEXT" }, { type: "TTS_START" },
    { type: "PCM_FIRST" }, { type: "TTS_END" }, { type: "WORKLET_DRAINED" },
    { type: "AGENT_END" },
    // Barge: second utterance starts before first is done. Here the
    // first turn has already settled, but the same flow applies.
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" }, { type: "COMPONENT" },
    { type: "LLM_TEXT" }, { type: "TTS_START" },
    { type: "PCM_FIRST" }, { type: "TTS_END" }, { type: "WORKLET_DRAINED" },
    { type: "AGENT_END" },
  ]).state;
  assert.equal(final.phase, "paused", "must settle to paused after final agent_end");
  assert.equal(final.thinking, false);
  assert.equal(final.speaking, false);
});

test("turn settles after WORKLET_DRAINED if AGENT_END arrives before drain", () => {
  // Common ordering: agent_end fires while TTS is still playing the
  // last chunk; the worklet drains a moment later. The handler must
  // clear thinking and the eventual WORKLET_DRAINED must transition
  // to resting (not "thinking").
  const final = run([
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" }, { type: "COMPONENT" },
    { type: "LLM_TEXT" }, { type: "TTS_START" }, { type: "PCM_FIRST" },
    { type: "AGENT_END" },      // agent_end during speaking
    { type: "TTS_END" }, { type: "WORKLET_DRAINED" },
  ]).state;
  assert.equal(final.phase, "paused");
});

test("turn settles if WORKLET_DRAINED arrives before AGENT_END", () => {
  // Reverse ordering: worklet drains first while LLM_TEXT had set
  // thinking=true. maybeEndSpeaking would route to phase=thinking;
  // then AGENT_END clears thinking and must transition to resting.
  const final = run([
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" }, { type: "COMPONENT" },
    { type: "LLM_TEXT" }, { type: "TTS_START" }, { type: "PCM_FIRST" },
    { type: "TTS_END" }, { type: "WORKLET_DRAINED" },
    { type: "AGENT_END" },      // agent_end after drain
  ]).state;
  assert.equal(final.phase, "paused");
});

test("turn stuck in thinking if AGENT_END never arrives (current behavior)", () => {
  // Captures the observed bug. With no AGENT_END, LLM_TEXT's
  // thinking=true sticks and WORKLET_DRAINED routes to thinking.
  // This test documents that the state machine currently REQUIRES
  // AGENT_END to settle. (If we want a timeout-style fallback later,
  // this becomes a regression check.)
  const final = run([
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" }, { type: "COMPONENT" },
    { type: "LLM_TEXT" }, { type: "TTS_START" }, { type: "PCM_FIRST" },
    { type: "TTS_END" }, { type: "WORKLET_DRAINED" },
    // NO AGENT_END
  ]).state;
  assert.equal(final.phase, "thinking",
    "without AGENT_END, current state machine sticks at thinking");
});

// ─── stale AGENT_END must not regress phase (the flicker bug) ───────
// With the server-side trade-off (rearm decays pending; late drained
// ends forward as natural), the client may see an AGENT_END BEFORE
// any new-turn activity. The existing workaround already suppresses
// the (no response) placeholder for this case. It must ALSO leave
// the phase alone (no transcribing → paused regression) so the arp
// doesn't briefly stop during the gap between the stale end and the
// first new-turn delta.

test("stale AGENT_END (no activity yet) does NOT regress phase from thinking", () => {
  const ptt = run([
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" }, // → thinking
  ]).state;
  const { state, actions } = reduce(ptt, { type: "AGENT_END" });
  assert.equal(state.phase, "thinking",
    "stale agent_end must not regress phase — keeps arp running");
  assert.ok(!hasAction(actions, "ARP_STOP"));
  assert.ok(!hasAction(actions, "SHOW_PLACEHOLDER"));
});

test("stale AGENT_END preserves the thinking flag (turn isn't really over)", () => {
  const ptt = run([
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" },
  ]).state;
  const { state } = reduce(ptt, { type: "AGENT_END" });
  assert.equal(state.thinking, true,
    "stale end must not clear thinking — real turn is still in progress");
});

test("real AGENT_END (after activity, no text) still regresses to resting + placeholder", () => {
  // Empty-of-text turn: activity occurred (thinking_end component
  // fired) but no LLM_TEXT — this is a legit empty turn, the existing
  // behavior must continue: phase → resting, placeholder shown.
  const post = run([
    { type: "HOLD" }, { type: "OPEN_DONE", kind: "ptt" },
    { type: "RELEASE" }, { type: "CLOSE_DONE", hadAudio: true },
    { type: "TRANSCRIPT" }, { type: "COMPONENT" },
  ]).state;
  const { state, actions } = reduce(post, { type: "AGENT_END" });
  assert.equal(state.phase, "paused");
  assert.equal(state.thinking, false);
  assert.ok(hasAction(actions, "SHOW_PLACEHOLDER"));
});

// ─── barge-in during transcribing ──────────────────────────────────
// When the user starts speaking again while the previous utterance's
// STT is still running on the server. The client sends audio_start
// (barge-in), new PCM, then audio_end. The server now has two
// concurrent finishUtterance() calls. If the second STT returns
// before the first, the first (stale) result must not clobber the
// second (current) one.

test("VAD_SPEECH_START during transcribing transitions to recording and sends audio_start", () => {
  const transcribing = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" }, // → transcribing
  ]).state;
  assert.equal(transcribing.phase, "transcribing");

  const { state, actions } = reduce(transcribing, { type: "VAD_SPEECH_START" });
  assert.equal(state.phase, "recording");
  assert.equal(state.vadSpeaking, true);
  // Must send audio_start so the server starts collecting new PCM.
  const audioStart = actions.find((a) => a.type === "WS_SEND" && a.msg.type === "audio_start");
  assert.ok(audioStart, "barge-in during transcribing must send audio_start");
  // Arp should stop (transcribing → recording leaves ARP_PHASES).
  assert.ok(hasAction(actions, "ARP_STOP"), "arp must stop on barge-in from transcribing");
});

test("barge-in during transcribing: full cycle returns to listening", () => {
  // User speaks, VAD ends (transcribing), user speaks again (barge),
  // second VAD ends (transcribing again), first STT's TRANSCRIPT
  // arrives, then second STT's TRANSCRIPT arrives, then the second
  // turn plays its response and settles.
  const { state, actions } = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    // First utterance.
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },        // → transcribing
    // Barge-in during STT.
    { type: "VAD_SPEECH_START" },       // → recording (barge)
    { type: "VAD_SPEECH_END" },         // → transcribing (second utterance)
    // First STT returns — stale TRANSCRIPT, but still processes.
    { type: "TRANSCRIPT" },             // → thinking
    // Second STT returns — real TRANSCRIPT for the new utterance.
    { type: "TRANSCRIPT" },             // resets gotText/sawTurnActivity
    // Normal turn lifecycle for the second (current) utterance.
    { type: "COMPONENT" },
    { type: "LLM_TEXT" },
    { type: "TTS_START" },
    { type: "PCM_FIRST" },
    { type: "TTS_END" },
    { type: "AGENT_END" },
    { type: "WORKLET_DRAINED" },
  ]);
  assert.equal(state.phase, "listening");
  assert.equal(state.thinking, false);
  assert.equal(state.speaking, false);
});

test("barge-in during transcribing: second TRANSCRIPT resets turn tracking", () => {
  // When two TRANSCRIPTs arrive (from concurrent STT), each one must
  // reset gotText and sawTurnActivity so the final AGENT_END applies
  // placeholder logic to the SECOND (current) turn, not the first.
  const afterBarge = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },        // → transcribing
    { type: "VAD_SPEECH_START" },       // barge → recording
    { type: "VAD_SPEECH_END" },         // → transcribing
    // First (stale) STT returns.
    { type: "TRANSCRIPT" },             // → thinking, resets gotText
    { type: "COMPONENT" },              // sawTurnActivity=true (from stale turn)
    // Second (current) STT returns.
    { type: "TRANSCRIPT" },             // MUST reset sawTurnActivity
  ]).state;
  assert.equal(afterBarge.gotText, false, "second TRANSCRIPT must reset gotText");
  assert.equal(afterBarge.sawTurnActivity, false,
    "second TRANSCRIPT must reset sawTurnActivity so stale activity doesn't satisfy placeholder guard");
});

test("barge-in during transcribing: AGENT_END from first (stale) turn is no-op", () => {
  // The first utterance's LLM finishes (AGENT_END) while the second
  // utterance is still processing. This stale AGENT_END must not
  // regress phase or stop the arp.
  const thinking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "VAD_SPEECH_START" },
    { type: "VAD_SPEECH_END" },
    { type: "VAD_SPEECH_START" },       // barge during transcribing
    { type: "VAD_SPEECH_END" },         // → transcribing (second)
    { type: "TRANSCRIPT" },             // first STT → thinking
    // Stale AGENT_END from first turn's LLM completing.
    { type: "AGENT_END" },
    // Second STT → TRANSCRIPT resets state for second turn.
    { type: "TRANSCRIPT" },
  ]).state;
  assert.equal(thinking.phase, "thinking");
  assert.equal(thinking.thinking, true);
  assert.equal(thinking.sawTurnActivity, false,
    "second TRANSCRIPT must clear sawTurnActivity regardless of stale AGENT_END");
});

