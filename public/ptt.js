// PTT capture buffer: holds Float32 frames captured from the raw mic
// ScriptProcessor while the user holds the orb, plus a `hadAudio` flag
// that flush() sets based on whether anything was actually captured.
//
// Lifecycle (open mic, chime, close mic, etc.) lives in app.js's
// openMicLifecycle / closeMicLifecycle so PTT and live share the same
// orchestration. consumeHadAudio() reads and clears the flag — call it
// AFTER flush() runs (driven by the WS_FLUSH_PTT action that follows
// CLOSE_PTT in the RELEASE reducer output) so the snapshot reflects the
// post-flush value, not the pre-flush default of false.
export function createPtt({ sendUtterance }) {
  let buffer = [];
  let hadAudio = false;
  return {
    push(chunk) { buffer.push(chunk); },
    reset() { buffer = []; hadAudio = false; },
    flush() {
      const total = buffer.reduce((n, a) => n + a.length, 0);
      if (total === 0) { hadAudio = false; return; }
      const flat = new Float32Array(total);
      let off = 0;
      for (const c of buffer) { flat.set(c, off); off += c.length; }
      buffer = [];
      sendUtterance(flat);
      hadAudio = true;
    },
    consumeHadAudio() {
      const snapshot = hadAudio;
      hadAudio = false;
      return snapshot;
    },
  };
}
