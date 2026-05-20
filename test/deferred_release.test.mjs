import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reduce,
  initialState,
} from "../public/state.js";

// Helper to run a sequence of events
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

test("deferred mic release when pausing during arpeggio", () => {
  // 1. Start in live mode and get into 'thinking' (arp playing)
  const thinking = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "TRANSCRIPT" }, // Transitions to 'thinking'
  ]).state;

  assert.equal(thinking.phase, "thinking");
  assert.equal(thinking.micOpen, true);
  assert.equal(thinking.sessionMode, "live");

  // 2. TAP to pause
  const { state: paused, actions } = reduce(thinking, { type: "TAP" });

  assert.equal(paused.sessionMode, "pause");
  assert.equal(paused.phase, "thinking"); // Phase stays same to keep arp playing
  assert.equal(paused.micOpen, true);     // Mic stays open (deferred release)
  
  // Should play chime but NOT release hardware yet
  assert.ok(actions.some(a => a.type === "PLAY_CHIME"));
  assert.ok(!actions.some(a => a.type === "CLOSE_LIVE"));
  assert.ok(!actions.some(a => a.type === "RELEASE_MIC"));
});

test("instant unpause when mic is already open", () => {
  // 1. Get into the deferred-release state from previous test
  const deferred = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" },
    { type: "TAP" }, // sessionMode=pause, micOpen=true, phase=thinking
  ]).state;

  assert.equal(deferred.sessionMode, "pause");
  assert.equal(deferred.micOpen, true);

  // 2. TAP to unpause
  const { state: unpaused, actions } = reduce(deferred, { type: "TAP" });

  assert.equal(unpaused.sessionMode, "live");
  assert.equal(unpaused.phase, "thinking"); // Stayed in thinking
  
  // Should be instant: skip OPEN_LIVE, just play a chime
  assert.deepEqual(actionTypes(actions), ["PLAY_CHIME"]);
  assert.ok(!actions.some(a => a.type === "OPEN_LIVE"));
});

test("VAD events are ignored when sessionMode is pause (deferred release)", () => {
  const deferred = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" },
    { type: "TAP" }, // sessionMode=pause, micOpen=true, phase=thinking
  ]).state;

  // Simulate VAD start while paused
  const { state: afterVadStart, actions: startActions } = reduce(deferred, { type: "VAD_SPEECH_START" });
  
  // Should be a total no-op (no phase change, no recording, no cancellation)
  assert.equal(afterVadStart.phase, "thinking");
  assert.equal(afterVadStart.vadSpeaking, false);
  assert.deepEqual(actionTypes(startActions), []);

  // Simulate VAD end while paused
  const { state: afterVadEnd, actions: endActions } = reduce(deferred, { type: "VAD_SPEECH_END" });
  assert.deepEqual(actionTypes(endActions), []);
});

test("automatic hardware release once turn ends (auto-cleanup)", () => {
  const deferred = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" }, // Sets sawTurnActivity: true
    { type: "TAP" }, // sessionMode=pause, micOpen=true, phase=thinking
  ]).state;

  // 1. AI finishes its turn (AGENT_END)
  // Since we're in 'thinking' (arp) and have seen activity, AGENT_END
  // will move us back to the resting phase ('paused' because sessionMode=pause).
  const { state: finished, actions } = reduce(deferred, { 
    type: "AGENT_END" 
  });

  assert.equal(finished.sessionMode, "pause");
  assert.equal(finished.phase, "paused");
  
  // Should have triggered the deferred RELEASE_MIC
  assert.ok(actions.some(a => a.type === "RELEASE_MIC"));
  assert.ok(actions.some(a => a.type === "ARP_STOP"));
});

test("CLOSE_DONE correctly clears micOpen", () => {
  const releasing = run([
    { type: "TAP" },
    { type: "OPEN_DONE", kind: "live" },
    { type: "TRANSCRIPT" },
    { type: "LLM_TEXT" },
    { type: "TAP" },
    { type: "AGENT_END" }, // Emits RELEASE_MIC
  ]).state;

  assert.equal(releasing.micOpen, true);

  // Driver finishes release and dispatches CLOSE_DONE
  const { state: closed } = reduce(releasing, { type: "CLOSE_DONE" });
  
  assert.equal(closed.micOpen, false);
});
