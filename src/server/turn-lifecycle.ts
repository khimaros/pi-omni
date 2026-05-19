// Tracks whether the server is currently within a "live" turn — i.e.
// the runtime is producing events the client should see. WebSession
// uses isActive to gate llm_delta / tts / agent_end forwarding.
//
// The non-obvious bit is `pendingStaleEnds`. When a new utterance
// arrives mid-turn we call begin(): we have to mark the prior turn's
// agent_end as cancelled so that, when the runtime eventually drains
// and fires it, we don't forward a stale agent_end to the client.
//
// The race that pendingStaleEnds solves: in pi-coding-agent,
// `await session.abort()` can return BEFORE the runtime's drained
// agent_end fires through subscribe. We must rearm() (active=true)
// so the new turn's deltas forward, but we MUST NOT also clear the
// pending stale cancellation — the late agent_end is still on the
// way and would otherwise classify as "natural" and (a) be forwarded,
// (b) clear active, silently dropping the new turn's events.
//
// Possible outcomes of end():
//   "natural":   the active turn ended cleanly with no pending stale
//                cancellations. WS layer should forward agent_end.
//   "cancelled": end fired while at least one stale cancellation was
//                pending. Counter decrements, active stays as-is.
//                WS layer must NOT forward — the client either already
//                moved on or is mid-turn for a later utterance.
//   "idle":      end fired with no active turn and no pending stale
//                ends. Ignore.
export type EndKind = "natural" | "cancelled" | "idle";

export class TurnLifecycle {
  private active = false;
  private pendingStaleEnds = 0;
  // Whether the most recent begin() incremented pendingStaleEnds (vs
  // just activating from idle). Used by revert() to undo the right
  // operation when STT comes back empty.
  private lastBeginAddedStale = false;

  get isActive(): boolean {
    return this.active;
  }

  begin(): void {
    if (this.active) {
      // Replacement: new utterance arrived while prior turn was
      // streaming. Mark the prior turn's eventual agent_end as stale
      // and stop forwarding its residual events.
      this.pendingStaleEnds += 1;
      this.active = false;
      this.lastBeginAddedStale = true;
    } else {
      this.active = true;
      this.lastBeginAddedStale = false;
    }
  }

  // Client sent WS cancel (PTT press during TTS / streaming). Same
  // semantics as begin-while-active: mark stale, deactivate. No-op if
  // nothing was active.
  cancel(): void {
    if (!this.active) return;
    this.pendingStaleEnds += 1;
    this.active = false;
  }

  rearm(): void {
    // Re-assert active so the NEW turn's events forward. Do NOT clear
    // pendingStaleEnds — the prior turn's drained agent_end may still
    // be on the way (pi-coding-agent's abort() can return before the
    // drain emits) and must still classify as "cancelled" when it
    // fires.
    this.active = true;
  }

  revert(): void {
    // Undo the most recent begin() — empty-STT path. If that begin
    // added a stale cancellation (because a turn was active), undo it
    // and restore active. Otherwise it just optimistically activated
    // from idle, so walk back to inactive.
    if (this.lastBeginAddedStale) {
      this.pendingStaleEnds = Math.max(0, this.pendingStaleEnds - 1);
      this.active = true;
      this.lastBeginAddedStale = false;
    } else {
      this.active = false;
    }
  }

  end(): EndKind {
    if (this.pendingStaleEnds > 0) {
      this.pendingStaleEnds -= 1;
      // Important: do NOT clear active here. A drained stale end after
      // rearm must leave the new turn's "active=true" intact so its
      // events keep forwarding.
      return "cancelled";
    }
    if (!this.active) return "idle";
    this.active = false;
    return "natural";
  }
}
