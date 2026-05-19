// PTT close/flush sequencing. The interesting case is the action
// ordering driven by state.js's RELEASE reducer: it returns
// [CLOSE_PTT, WS_FLUSH_PTT, audio_end]. runAction in app.js dispatches
// them in order — CLOSE_PTT starts the async close(), control returns,
// and WS_FLUSH_PTT calls flush() SYNCHRONOUSLY before close()'s awaits
// resolve. close() must observe flush()'s hadAudio side-effect when it
// eventually dispatches CLOSE_DONE — otherwise the phase stays stuck
// at "paused" instead of advancing to "transcribing".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPtt } from "../public/ptt.js";

function makeDeps() {
  const calls = { send: [], dispatched: [] };
  return {
    calls,
    sendUtterance: (f32) => calls.send.push(f32),
    releaseMic: async () => {},
    playChimeAndPause: async () => {},
    dispatch: (event) => calls.dispatched.push(event),
  };
}

test("close() after flush() with captured frames reports hadAudio=true", async () => {
  const deps = makeDeps();
  const ptt = createPtt(deps);
  ptt.push(new Float32Array(2048).fill(0.1));

  // Simulate runAction sequence: CLOSE_PTT then WS_FLUSH_PTT, both
  // synchronous from the dispatcher's perspective. close() awaits;
  // flush() runs in the gap before close()'s first microtask resolves.
  const closing = ptt.close();
  ptt.flush();
  await closing;

  const closeDone = deps.calls.dispatched.find((e) => e.type === "CLOSE_DONE");
  assert.ok(closeDone, "close() must dispatch CLOSE_DONE");
  assert.equal(
    closeDone.hadAudio,
    true,
    "close() must observe flush()'s hadAudio side-effect — " +
      "otherwise the reducer leaves the phase at 'paused'",
  );
  assert.equal(deps.calls.send.length, 1, "flush() should have sent one utterance");
});

test("close() with no captured frames reports hadAudio=false", async () => {
  const deps = makeDeps();
  const ptt = createPtt(deps);

  const closing = ptt.close();
  ptt.flush(); // empty buffer — hadAudio stays false
  await closing;

  const closeDone = deps.calls.dispatched.find((e) => e.type === "CLOSE_DONE");
  assert.ok(closeDone);
  assert.equal(closeDone.hadAudio, false);
  assert.equal(deps.calls.send.length, 0);
});

test("flush() with empty buffer does not send", () => {
  const deps = makeDeps();
  const ptt = createPtt(deps);
  ptt.flush();
  assert.equal(deps.calls.send.length, 0);
});

test("reset() clears buffer and hadAudio", async () => {
  const deps = makeDeps();
  const ptt = createPtt(deps);
  ptt.push(new Float32Array(2048).fill(0.1));
  ptt.flush();
  ptt.reset();

  const closing = ptt.close();
  await closing;
  const closeDone = deps.calls.dispatched.find((e) => e.type === "CLOSE_DONE");
  assert.equal(closeDone.hadAudio, false);
});
