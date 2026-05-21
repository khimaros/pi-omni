// Audio-session helpers. Kept pure (no DOM, no global state) so they
// can be unit-tested with a fake AudioContext under node.

// Bring an AudioContext back to the "running" state before scheduling
// playback. Mobile browsers can park the context in "suspended" or
// "interrupted" — in either state, scheduled oscillators silently
// no-op. Per MDN, calling resume() from "interrupted" may transition
// back to "interrupted" instead of "running", so just awaiting the
// resume() Promise is not enough — we have to actually observe a
// statechange to "running". Time out after `runningTimeoutMs` to avoid
// hanging if the OS refuses to wake the engine.
//
// After we confirm "running", wait `settleMs` so the OS audio session
// has a chance to re-establish the route before the first note.
//
// No-op when the context is already running.
export async function ensureAudioRunning(
  ctx,
  settleMs,
  { runningTimeoutMs = 500, sleep = defaultSleep } = {},
) {
  if (ctx.state === "running") return;
  try { ctx.resume(); } catch {}
  if (ctx.state !== "running") {
    await waitForState(ctx, "running", runningTimeoutMs);
  }
  await sleep(settleMs);
}

function waitForState(ctx, target, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ctx.removeEventListener("statechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => { if (ctx.state === target) finish(); };
    ctx.addEventListener("statechange", onChange);
    const timer = setTimeout(finish, timeoutMs);
    if (ctx.state === target) finish();
  });
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
