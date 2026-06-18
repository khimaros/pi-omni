// Tests for the audio-session recovery helper. The fake AudioContext
// records resume() calls and dispatches statechange events the same
// way real browsers do, so we can verify ensureAudioRunning actually
// waits for "running" before letting playback proceed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureAudioRunning } from "../public/audio.js";

function fakeCtx(initialState) {
  const listeners = new Set();
  const ctx = {
    state: initialState,
    resumeCalls: 0,
    addEventListener(type, fn) {
      if (type === "statechange") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "statechange") listeners.delete(fn);
    },
    _setState(s) {
      this.state = s;
      for (const fn of [...listeners]) fn({ type: "statechange" });
    },
    resume() {
      this.resumeCalls += 1;
      // Real browsers transition asynchronously. Schedule a microtask so
      // the caller's `if (ctx.state !== "running")` check sees the
      // pre-transition state and falls into waitForState.
      Promise.resolve().then(() => this._setState("running"));
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
  await ensureAudioRunning(ctx, 80, { sleep });
  assert.equal(ctx.resumeCalls, 0);
  assert.deepEqual(sleep.calls, []);
});

test("suspended context: waits for 'running' statechange before settle", async () => {
  const ctx = fakeCtx("suspended");
  const sleep = recordingSleep();
  await ensureAudioRunning(ctx, 80, { sleep });
  assert.equal(ctx.resumeCalls, 1);
  assert.deepEqual(sleep.calls, [80], "settle delay only fires after 'running'");
  assert.equal(ctx.state, "running");
});

test("interrupted context: waits for 'running' statechange before settle", async () => {
  // The actual mobile regression -- playChime once only checked
  // "suspended". On Firefox Android the context can be "interrupted",
  // and resume() may transition slowly (or back to interrupted).
  // We must observe the statechange before scheduling.
  const ctx = fakeCtx("interrupted");
  const sleep = recordingSleep();
  await ensureAudioRunning(ctx, 80, { sleep });
  assert.equal(ctx.resumeCalls, 1, "must resume from interrupted state");
  assert.deepEqual(sleep.calls, [80], "settle delay only fires after 'running'");
  assert.equal(ctx.state, "running");
});

test("resume() rejection: still falls through to timeout, doesn't hang", async () => {
  const ctx = {
    state: "suspended",
    addEventListener() {},
    removeEventListener() {},
    resume() { throw new Error("denied"); },
  };
  const sleep = recordingSleep();
  await assert.doesNotReject(() =>
    ensureAudioRunning(ctx, 80, { sleep, runningTimeoutMs: 5 }),
  );
});

test("never reaches 'running': times out instead of hanging forever", async () => {
  const ctx = {
    state: "suspended",
    addEventListener() {},
    removeEventListener() {},
    resume() { /* never transitions */ },
  };
  const sleep = recordingSleep();
  const start = Date.now();
  await ensureAudioRunning(ctx, 80, { sleep, runningTimeoutMs: 10 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 10, "must wait at least the timeout before continuing");
  assert.ok(elapsed < 200, "must not hang past the timeout");
});
