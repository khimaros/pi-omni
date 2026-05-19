// Tests for the small turn-lifecycle helper used server-side to decide
// whether an event from the pi runtime should be forwarded to the
// client. Captures the race the user is hitting:
//
//   1. STT completes, server marks the turn active (so the NEW turn's
//      text_delta events will be forwarded).
//   2. Server calls runtime.abort() to halt the prior (cancelled) turn.
//   3. The cancelled turn's `agent_end` fires DURING abort — that goes
//      through end() and would clear `active`.
//   4. abort() returns, server calls runtime.prompt() for the new turn.
//   5. text_delta events fire for the new turn — but `active` is now
//      false, so the handler would drop them silently. User sees
//      transcript but no response.
//
// rearm() is the fix: call it right before runtime.prompt() to re-assert
// active *after* the abort drain has cleared the prior turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnLifecycle } from "../dist/server/turn-lifecycle.js";

test("starts inactive", () => {
  const t = new TurnLifecycle();
  assert.equal(t.isActive, false);
});

test("begin marks active; end clears", () => {
  const t = new TurnLifecycle();
  t.begin();
  assert.equal(t.isActive, true);
  t.end();
  assert.equal(t.isActive, false);
});

test("race: begin → end (stale from cancelled turn) → rearm leaves active", () => {
  // This is the symptom-bearing sequence. Without rearm(), the call
  // graph leaves us inactive when the NEW turn's events arrive.
  const t = new TurnLifecycle();
  t.begin();             // STT completed; new turn provisionally active
  t.end();               // stale agent_end from cancelled prior turn
  assert.equal(t.isActive, false);
  t.rearm();             // server calls this right before runtime.prompt()
  assert.equal(t.isActive, true,
    "rearm must re-assert active so the new turn's events are forwarded");
});

test("rearm is a no-op when already active", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.rearm();
  assert.equal(t.isActive, true);
});

test("end after rearm clears active normally", () => {
  // The genuine end of the new turn (not a stale one) must still work.
  const t = new TurnLifecycle();
  t.begin();
  t.end();     // stale
  t.rearm();   // new turn live
  t.end();     // real end of new turn
  assert.equal(t.isActive, false);
});

// ─── cancellation: drop everything from the cancelled prior turn ───
// When a new utterance arrives while a turn is still streaming, the
// server begins the new utterance (begin()) and then aborts the old
// turn. The old turn's residual events (text_delta, turn_end,
// agent_end) drain DURING abort — before the new turn's prompt runs.
// Those residual events must NOT reach the client (they pollute the
// assistant display and trigger stale TTS). The lifecycle handles this
// by going inactive when begin() replaces an active turn; rearm()
// brings it back active right before the new turn's prompt.

test("begin while already active goes inactive (drops residual events)", () => {
  const t = new TurnLifecycle();
  t.begin();             // prior turn active
  assert.equal(t.isActive, true);
  t.begin();             // new utterance replaces it
  assert.equal(t.isActive, false,
    "must be inactive between begin-replace and rearm so prior events drop");
});

test("end during cancellation window returns 'cancelled' and stays inactive", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.begin();             // pending cancellation, active=false
  // The prior turn's agent_end fires during abort drain.
  assert.equal(t.end(), "cancelled");
  assert.equal(t.isActive, false);
});

test("rearm re-asserts active without clearing pending stale ends", () => {
  // Updated semantics: rearm() does NOT consume the pending stale
  // cancellation. The drained end is on its way and must still
  // classify as "cancelled" when it fires.
  const t = new TurnLifecycle();
  t.begin();
  t.begin();
  t.rearm();
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "cancelled",
    "drained prior-turn agent_end must still be cancelled even after rearm");
  assert.equal(t.end(), "natural",
    "the NEXT end is the new turn's natural end");
});

test("client cancel mid-LLM, then late agent_end after, then new turn", () => {
  // Scenario: user HOLDs during TTS playback (client sends WS cancel).
  // The WS cancel handler must use cancel() not end() — cancel() puts
  // the lifecycle into cancellation-pending so the runtime's drained
  // agent_end (arriving later, during/after STT) classifies as
  // "cancelled" rather than "natural". Otherwise the prior turn's
  // drained agent_end is forwarded to the client and triggers a stale
  // "(no response)" before the new turn's response lands.
  const t = new TurnLifecycle();
  t.begin();                            // turn 1 active
  t.cancel();                           // client WS cancel handler
  assert.equal(t.isActive, false);
  assert.equal(t.end(), "cancelled",    // late agent_end from runtime
    "late agent_end after cancel must classify as 'cancelled' so WS layer drops it");
  // User releases — new utterance starts. Turn 2 begins fresh.
  t.begin();
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "natural");
});

test("client cancel then audio_end then drained prior agent_end", () => {
  // The real-world race from the user's 01:56:58 log:
  //   1. turn 1 streaming (thinking only — no text yet).
  //   2. user presses PTT → client sends WS cancel.
  //   3. user releases → client sends audio_end.
  //   4. server begins new utterance, runs STT.
  //   5. abort() drains turn 1 — its natural agent_end arrives during
  //      the STT window.
  //   6. STT returns text; rearm; prompt; new turn runs.
  // Without cancel() preserving cancellation-pending across the
  // audio_end's begin(), step 5's end() would classify as "natural"
  // and the stale agent_end would be forwarded.
  const t = new TurnLifecycle();
  t.begin();                            // turn 1 active
  t.cancel();                           // WS cancel (PTT press)
  t.begin();                            // audio_end (PTT release)
  assert.equal(t.end(), "cancelled",
    "drained prior-turn end after client cancel must NOT classify as natural");
  t.rearm();                            // pre-prompt for new turn
  assert.equal(t.end(), "natural");
});

test("cancel is a no-op when no turn is active", () => {
  const t = new TurnLifecycle();
  t.cancel();
  assert.equal(t.isActive, false);
  // Subsequent begin/end behaves normally — cancel didn't leave state.
  t.begin();
  assert.equal(t.end(), "natural");
});

test("cancel without follow-up audio_end still drains correctly", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.cancel();
  assert.equal(t.end(), "cancelled");
  // Next turn (whenever it arrives) begins fresh.
  t.begin();
  assert.equal(t.end(), "natural");
});

test("prior turn naturally completes DURING STT for the barge utterance", () => {
  // Real-world race the user hit on device:
  //   t=0      turn 1 begins streaming (text_delta…)
  //   t=4s     user barges; audio_end arrives → begin() (commit cancel)
  //   t=4.1s   prior turn naturally fires agent_end DURING the STT
  //            window — finishUtterance hasn't reached its old begin()
  //            yet. Without commit-at-audio_end, this end() classifies
  //            as 'natural' → WS agent_end forwarded → client shows
  //            "(no response)" before the new turn's text ever lands.
  //   t=5s     STT completes; finishUtterance proceeds; rearm; prompt.
  //   t=8s     new turn's natural end.
  const t = new TurnLifecycle();
  t.begin();                            // turn 1 starts
  t.begin();                            // audio_end → commit cancellation
  assert.equal(t.end(), "cancelled",
    "prior turn's natural agent_end during STT window must be suppressed");
  t.rearm();                            // pre-prompt
  assert.equal(t.end(), "natural");     // new turn ends cleanly
});

test("revert: empty STT path restores the prior turn's active state", () => {
  // The server commits to cancellation at audio_end (before STT runs)
  // so the prior turn's events are dropped during the STT window. But
  // if STT returns empty, no new turn will run — the prior turn must
  // be RESTORED so its remaining events reach the client.
  const t = new TurnLifecycle();
  t.begin();                            // turn 1 active
  t.begin();                            // audio_end → commit cancellation
  assert.equal(t.isActive, false);
  t.revert();                           // STT empty — undo
  assert.equal(t.isActive, true, "revert must re-activate the prior turn");
  assert.equal(t.end(), "natural",
    "prior turn's eventual agent_end must classify as 'natural'");
});

test("revert: fresh utterance with empty STT leaves the lifecycle idle", () => {
  // No prior turn was active; audio_end's begin() set active=true
  // optimistically. Empty STT must walk it back to inactive — not
  // leave a phantom 'active' state for ghost events to be forwarded.
  const t = new TurnLifecycle();
  t.begin();                            // audio_end with no prior turn
  assert.equal(t.isActive, true);
  t.revert();
  assert.equal(t.isActive, false,
    "revert with no cancellation must leave us idle, not stranded-active");
});

test("client cancel arrives between begin-replace and abort drain", () => {
  // Stress: user HOLDs (sends WS cancel) AFTER releasing the previous
  // PTT but BEFORE the server-side abort has drained. The order on
  // the server is: begin() (from finishUtterance) → end() (from WS
  // cancel arriving) → eventual rearm. The cancel-driven end falls
  // inside the cancellation window, so it returns "cancelled" — and
  // rearm still leaves us correctly active for the new turn.
  const t = new TurnLifecycle();
  t.begin();              // prior turn
  t.begin();              // new utterance arrived; cancellation pending
  assert.equal(t.end(), "cancelled");
  t.rearm();
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "natural");
});

test("rearm before drained agent_end keeps stale-end pending (fixed)", () => {
  // Was a bug captured for the real-world race where pi-coding-agent's
  // abort() returns before drained agent_end fires. Now fixed: rearm()
  // preserves pendingStaleEnds, so the drained end still classifies
  // as cancelled even when rearm has already happened.
  const t = new TurnLifecycle();
  t.begin();                    // turn 1
  t.begin();                    // audio_end → cancellation pending
  t.rearm();                    // abort returned before drain
  assert.equal(t.end(), "cancelled",
    "drained agent_end after early rearm is still suppressed");
});

test("correct sequence: drain BEFORE rearm classifies as cancelled", () => {
  const t = new TurnLifecycle();
  t.begin();                    // turn 1
  t.begin();                    // audio_end → cancellation pending
  assert.equal(t.end(), "cancelled",
    "drained agent_end fires first → cancelled, suppressed");
  t.rearm();                    // re-arm for new turn
  assert.equal(t.end(), "natural"); // new turn end is real
});

// ─── late drain race (the real bug) ──────────────────────────────────
// Observed in production: pi-coding-agent's `await session.abort()`
// returns BEFORE the runtime's drained agent_end actually fires
// through subscribe. Server log:
//   audio_end → turn.begin (isActive=true)
//   rearmTurn (isActive=false)          ← rearm BEFORE drain
//   ...message_end events drain...
//   turn.end → natural (forward=true)   ← stale agent_end forwarded
// Then new turn's text_delta events arrive but onLlmDelta drops them
// because end() cleared active. User sees no response.
//
// Fix: rearm() re-asserts active but must NOT clear pending stale
// cancellations — those are consumed only by the matching end()
// calls that follow.

test("late drain after rearm still classifies as cancelled (single barge)", () => {
  const t = new TurnLifecycle();
  t.begin();                            // turn 1 active
  t.begin();                            // audio_end → cancellation pending
  t.rearm();                            // abort returned early
  assert.equal(t.isActive, true,
    "rearm must re-assert active so new turn's deltas forward");
  assert.equal(t.end(), "cancelled",
    "the late drained agent_end must STILL classify as cancelled");
  assert.equal(t.isActive, true,
    "active must remain true so new turn's deltas keep forwarding");
  // Eventually the new turn ends naturally.
  assert.equal(t.end(), "natural");
  assert.equal(t.isActive, false);
});

test("two barges in a row: both stale ends classify as cancelled", () => {
  const t = new TurnLifecycle();
  t.begin();                            // turn 1
  t.begin();                            // barge → turn 2 begins, cancel pending
  t.rearm();                            // abort #1 returns early
  t.begin();                            // barge → turn 3 begins, second cancel pending
  t.rearm();                            // abort #2 returns early
  assert.equal(t.isActive, true);
  // Late drained agent_end #1 (from turn 1)
  assert.equal(t.end(), "cancelled");
  assert.equal(t.isActive, true);
  // Late drained agent_end #2 (from turn 2)
  assert.equal(t.end(), "cancelled");
  assert.equal(t.isActive, true);
  // Turn 3's real natural end.
  assert.equal(t.end(), "natural");
});

test("client cancel + audio_end + late drain: single pending stale end", () => {
  // cancel and the subsequent audio_end refer to the SAME prior turn,
  // which will produce exactly ONE drained agent_end — so only one
  // pending stale is queued (cancel adds it; begin-while-inactive does
  // not double-count).
  const t = new TurnLifecycle();
  t.begin();                            // turn 1
  t.cancel();                           // WS cancel (PTT press) → pending=1
  t.begin();                            // audio_end (active=false now) → just activates
  t.rearm();                            // abort returned early
  assert.equal(t.end(), "cancelled",
    "turn 1's eventual drained agent_end");
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "natural",
    "new turn's natural end");
});

test("rearm without pending stale cancellation is a clean re-arm", () => {
  // First-prompt path: no prior turn, audio_end begin sets active=true.
  // rearm() should be idempotent and leave no pending cancellation.
  const t = new TurnLifecycle();
  t.begin();
  t.rearm();
  assert.equal(t.end(), "natural");
});
