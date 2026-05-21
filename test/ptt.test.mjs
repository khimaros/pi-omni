// PTT capture buffer. The interesting case is the action ordering
// driven by state.js's RELEASE reducer: it returns
// [CLOSE_PTT, WS_FLUSH_PTT, audio_end]. runAction in app.js dispatches
// them in order — closePtt() starts the async close lifecycle, control
// returns, and WS_FLUSH_PTT calls flush() SYNCHRONOUSLY before the
// lifecycle's awaits resolve. The lifecycle must observe flush()'s
// hadAudio side-effect when it eventually dispatches CLOSE_DONE —
// otherwise the phase stays stuck at "paused" instead of advancing to
// "transcribing". consumeHadAudio() is the read-and-clear primitive
// the lifecycle uses to make that observation late.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPtt } from "../public/ptt.js";

function makeDeps() {
  const calls = { send: [] };
  return {
    calls,
    sendUtterance: (f32) => calls.send.push(f32),
  };
}

test("flush() after push() reports hadAudio=true via consumeHadAudio", () => {
  const deps = makeDeps();
  const ptt = createPtt(deps);
  ptt.push(new Float32Array(2048).fill(0.1));
  ptt.flush();
  assert.equal(ptt.consumeHadAudio(), true);
  assert.equal(deps.calls.send.length, 1);
});

test("flush() with empty buffer leaves hadAudio=false and sends nothing", () => {
  const deps = makeDeps();
  const ptt = createPtt(deps);
  ptt.flush();
  assert.equal(ptt.consumeHadAudio(), false);
  assert.equal(deps.calls.send.length, 0);
});

test("consumeHadAudio() clears the flag (read-once)", () => {
  const deps = makeDeps();
  const ptt = createPtt(deps);
  ptt.push(new Float32Array(2048).fill(0.1));
  ptt.flush();
  assert.equal(ptt.consumeHadAudio(), true);
  assert.equal(ptt.consumeHadAudio(), false);
});

test("reset() clears buffer and hadAudio", () => {
  const deps = makeDeps();
  const ptt = createPtt(deps);
  ptt.push(new Float32Array(2048).fill(0.1));
  ptt.flush();
  ptt.reset();
  assert.equal(ptt.consumeHadAudio(), false);
});
