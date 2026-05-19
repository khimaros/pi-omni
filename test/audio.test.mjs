// Tests for the audio-session recovery helper. The fake AudioContext
// records resume() calls and can be driven through state transitions
// the same way mobile browsers do (running → suspended/interrupted
// when a capture context closes, then back to running on resume).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureAudioRunning } from "../public/audio.js";

function fakeCtx(initialState) {
  const ctx = {
    state: initialState,
    resumeCalls: 0,
    async resume() {
      this.resumeCalls += 1;
      this.state = "running";
    },
  };
  return ctx;
}

function recordingSleep() {
  const calls = [];
  const fn = (ms) => { calls.push(ms); return Promise.resolve(); };
  fn.calls = calls;
  return fn;
}

test("running context: no resume, no sleep", async () => {
  const ctx = fakeCtx("running");
  const sleep = recordingSleep();
  await ensureAudioRunning(ctx, 80, sleep);
  assert.equal(ctx.resumeCalls, 0);
  assert.deepEqual(sleep.calls, []);
});

test("suspended context: resume awaited, then settle delay", async () => {
  const ctx = fakeCtx("suspended");
  const sleep = recordingSleep();
  await ensureAudioRunning(ctx, 80, sleep);
  assert.equal(ctx.resumeCalls, 1);
  assert.deepEqual(sleep.calls, [80], "must wait settleMs after resume");
  assert.equal(ctx.state, "running");
});

test("interrupted context (mobile post-mic-close): resume awaited, then settle delay", async () => {
  // This is the actual mobile regression — playChime currently only
  // checks "suspended" and skips "interrupted", so the chime is
  // scheduled into a context the OS hasn't routed yet → silence.
  const ctx = fakeCtx("interrupted");
  const sleep = recordingSleep();
  await ensureAudioRunning(ctx, 80, sleep);
  assert.equal(ctx.resumeCalls, 1, "must resume from interrupted state");
  assert.deepEqual(sleep.calls, [80], "must wait settleMs after resume");
  assert.equal(ctx.state, "running");
});

test("resume() rejection does not throw out of ensureAudioRunning", async () => {
  const ctx = {
    state: "suspended",
    async resume() { throw new Error("denied"); },
  };
  const sleep = recordingSleep();
  await assert.doesNotReject(() => ensureAudioRunning(ctx, 80, sleep));
});
