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

test("begin marks active; end does NOT deactivate (active cleared only by replace)", () => {
  // Active stays true through end() so late drained events from a
  // prior turn (which may fire AFTER the new turn's natural end) can
  // still be forwarded. The only path to active=false is begin()
  // replacing an active turn at the next utterance.
  const t = new TurnLifecycle();
  t.begin();
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "natural");
  assert.equal(t.isActive, true,
    "end() must not deactivate — subsequent events for this turn keep forwarding");
});

test("race: begin → end → rearm leaves active (with non-deactivating end)", () => {
  // After: end() no longer deactivates. This test now mainly asserts
  // rearm idempotency in the post-end state.
  const t = new TurnLifecycle();
  t.begin();
  t.end();               // natural — does NOT deactivate
  assert.equal(t.isActive, true);
  t.rearm();
  assert.equal(t.isActive, true);
});

test("rearm is a no-op when already active", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.rearm();
  assert.equal(t.isActive, true);
});

test("end after rearm classifies as natural", () => {
  // end() no longer deactivates; we just assert classification.
  const t = new TurnLifecycle();
  t.begin();
  t.end();
  t.rearm();
  assert.equal(t.end(), "natural");
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

test("rearm decays one pending stale end (drain assumed by rearm time)", () => {
  // Updated semantics: rearm() optimistically consumes one pending
  // stale. If drain fired during abort, end() already consumed it
  // (pending was 0). If drain hasn't fired yet, the late drained
  // agent_end will classify as natural and be forwarded — frontend
  // workaround handles that gracefully. This is the trade-off that
  // prevents the new turn's natural end from being misclassified as
  // cancelled and stuck-in-thinking.
  const t = new TurnLifecycle();
  t.begin();             // turn 1
  t.begin();             // audio_end → pending=1
  t.rearm();             // decays pending to 0
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "natural",
    "new turn's natural end must classify as natural (no leftover pending)");
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

test("rearm before drained agent_end: late drain forwards as natural (trade-off)", () => {
  // Trade-off note: when drain fires AFTER rearm, the late agent_end
  // classifies as natural and is forwarded. Frontend's sawTurnActivity
  // guard prevents the "(no response)" placeholder in that case.
  const t = new TurnLifecycle();
  t.begin();
  t.begin();
  t.rearm();
  assert.equal(t.end(), "natural",
    "late drain after rearm forwards as natural (workaround handles UI)");
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

test("late drain after rearm: active stays alive for new turn's deltas", () => {
  // Most important invariant: active must stay true through any
  // post-rearm event ordering so the new turn's deltas keep flowing.
  const t = new TurnLifecycle();
  t.begin();
  t.begin();
  t.rearm();
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "natural");
  assert.equal(t.isActive, true,
    "active must remain true so subsequent deltas keep forwarding");
  // New turn's REAL natural end can be received without losing forwarding.
  assert.equal(t.end(), "natural");
  assert.equal(t.isActive, true);
});

test("two barges in a row: both rearm decays clear pending; active stays", () => {
  const t = new TurnLifecycle();
  t.begin();                            // turn 1
  t.begin();                            // barge → pending=1, active=false
  t.rearm();                            // decay → pending=0, active=true
  t.begin();                            // barge → pending=1, active=false
  t.rearm();                            // decay → pending=0, active=true
  assert.equal(t.isActive, true);
  // Any subsequent ends classify as natural.
  assert.equal(t.end(), "natural");
  assert.equal(t.isActive, true);
});

test("client cancel + audio_end + rearm: pending decayed, new turn natural", () => {
  // cancel and the subsequent audio_end refer to the SAME prior turn
  // (one drained end expected). cancel adds 1 pending; begin-while-
  // inactive doesn't double-count. rearm decays the one pending. New
  // turn's natural end classifies as natural.
  const t = new TurnLifecycle();
  t.begin();
  t.cancel();                           // pending=1, active=false
  t.begin();                            // active was false → activate, no extra pending
  t.rearm();                            // decay → pending=0, active=true
  assert.equal(t.end(), "natural");
  assert.equal(t.isActive, true);
});

test("rearm without pending stale cancellation is a clean re-arm", () => {
  // First-prompt path: no prior turn, audio_end begin sets active=true.
  // rearm() should be idempotent and leave no pending cancellation.
  const t = new TurnLifecycle();
  t.begin();
  t.rearm();
  assert.equal(t.end(), "natural");
});

test("if drain never fires, new turn's natural end is still natural (not cancelled)", () => {
  // The bug after fixing the rearm-clears-cancellation issue: when
  // pi-coding-agent's abort returns and the drained prior-turn
  // agent_end NEVER fires (or fires after the new turn ends),
  // pendingStaleEnds stays at 1. The new turn's natural agent_end
  // then incorrectly classifies as "cancelled" and is suppressed —
  // client never sees agent_end → UI sticks in thinking forever.
  const t = new TurnLifecycle();
  t.begin();                            // turn 1
  t.begin();                            // audio_end → pending=1
  t.rearm();                            // abort returned early
  // Note: turn 1's drained agent_end NEVER fires here.
  // Turn 2 runs to completion and emits its natural agent_end.
  assert.equal(t.end(), "natural",
    "new turn's natural end must classify as natural even if prior drain was lost");
});

// ─── concurrent finishUtterance (barge-in during transcribing) ──────
// When the user barges in during transcribing, two audio_end messages
// arrive and two finishUtterance() calls run concurrently. Each
// audio_end calls turn.begin(). If the first STT returns empty, its
// revert() call may undo the wrong begin() because lastBeginAddedStale
// tracks only the most recent begin().

test("two begin()s then first revert: must not corrupt state for second", () => {
  // Simulates: first audio_end → begin(), second audio_end → begin(),
  // first STT returns empty → revert(). The second begin's turn must
  // still be processable.
  const t = new TurnLifecycle();
  t.begin();                            // first audio_end
  t.begin();                            // second audio_end — replaces first
  // First STT returns empty — calls revert(). revert should undo the
  // FIRST begin, not the second. But lastBeginAddedStale was set by
  // the second begin(), so revert() uses the wrong state.
  t.revert();
  // After revert, we need the lifecycle to be in a state where the
  // second finishUtterance (which will call rearm + send to LLM)
  // can proceed correctly.
  assert.equal(t.isActive, true,
    "lifecycle must be active so second utterance's events are forwarded");
  // Second STT completes with text → rearm + end should work.
  t.rearm();
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "natural",
    "second utterance's natural end must classify correctly");
});

test("two begin()s then second revert: lifecycle stays consistent", () => {
  // Variant: second STT returns empty (second was a VAD misfire).
  // First utterance should still be processable.
  const t = new TurnLifecycle();
  t.begin();                            // first audio_end
  t.begin();                            // second audio_end
  // Second STT returns empty first.
  // But revert() doesn't know which begin() it's reverting — it
  // always reverts the most recent one (via lastBeginAddedStale).
  t.revert();
  // First STT completes with text — needs rearm + prompt.
  t.rearm();
  assert.equal(t.isActive, true);
  assert.equal(t.end(), "natural");
});

