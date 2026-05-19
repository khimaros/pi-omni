// PTT capture state: a small buffer of Float32 frames captured from the
// raw mic ScriptProcessor while the user holds the orb, plus a
// `hadAudio` flag the close routine reports back to the reducer via
// CLOSE_DONE.hadAudio.
//
// The non-obvious bit is ordering. app.js's runAction dispatches actions
// in the order returned by the reducer; RELEASE returns
// [CLOSE_PTT, WS_FLUSH_PTT, audio_end]. CLOSE_PTT kicks off close() —
// which awaits — then control returns and WS_FLUSH_PTT calls flush()
// synchronously, setting hadAudio. close() therefore MUST read hadAudio
// AFTER its awaits resolve, not at function entry, otherwise it
// captures the pre-flush value (false) and CLOSE_DONE leaves the phase
// stuck at "paused" instead of advancing to "transcribing".
export function createPtt({
  sendUtterance,
  releaseMic,
  playChimeAndPause,
  dispatch,
}) {
  let buffer = [];
  let hadAudio = false;

  function push(chunk) {
    buffer.push(chunk);
  }

  function reset() {
    buffer = [];
    hadAudio = false;
  }

  function flush() {
    const total = buffer.reduce((n, a) => n + a.length, 0);
    if (total === 0) {
      hadAudio = false;
      return;
    }
    const flat = new Float32Array(total);
    let off = 0;
    for (const c of buffer) {
      flat.set(c, off);
      off += c.length;
    }
    buffer = [];
    sendUtterance(flat);
    hadAudio = true;
  }

  async function close() {
    await releaseMic();
    await playChimeAndPause();
    const snapshot = hadAudio;
    hadAudio = false;
    dispatch({ type: "CLOSE_DONE", hadAudio: snapshot });
  }

  return { push, reset, flush, close };
}
