// Audio-session helpers. Kept pure (no DOM, no global state) so they
// can be unit-tested with a fake AudioContext under node.

// Bring an AudioContext back to the "running" state before scheduling
// playback. Mobile browsers can park the context in "suspended" or
// "interrupted" when a capture context (e.g. PTT mic) closes — in
// either state, scheduled oscillators silently no-op. After resume()
// resolves we wait `settleMs` so the OS audio session has a chance to
// re-establish the route before the first note is scheduled.
//
// No-op when the context is already running.
export async function ensureAudioRunning(ctx, settleMs, sleep = defaultSleep) {
  if (ctx.state === "running") return;
  try { await ctx.resume(); } catch {}
  await sleep(settleMs);
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
