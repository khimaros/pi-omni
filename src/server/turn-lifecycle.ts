// Tracks whether the server is currently within a "live" turn -- i.e.
// the runtime is producing events the client should see. WebSession
// uses isActive to gate llm_delta / tts / agent_end forwarding.
//
// The race this guards against: when a new utterance arrives mid-turn
// (begin() while active), we need to drop the prior turn's residual
// events (text_delta, turn_end, agent_end) so they don't bleed into
// the new turn's display or play stale TTS.
//
// pi-coding-agent's `await session.abort()` returns before the
// runtime's drained agent_end actually fires through subscribe (the
// drain happens on a later macrotask). So we CANNOT count on the
// stale end to be consumed before rearm. Two design constraints fall
// out of that:
//
//   1. rearm() decays one pending stale end -- by the time the next
//      prompt() runs, we assume any stale drain has either fired
//      (consumed it) or has been effectively lost. A late drained
//      agent_end firing AFTER rearm gets forwarded as "natural"; the
//      frontend's sawTurnActivity guard suppresses the (no response)
//      placeholder in that case, and any subsequent LLM_TEXT restores
//      the thinking phase.
//
//   2. end() does NOT deactivate. Active is only cleared by begin()
//      replacing an active turn. This prevents the catastrophic
//      "stuck in thinking" bug where a stray end() set active=false
//      and the new turn's deltas were then silently dropped.
//
// Possible outcomes of end():
//   "natural":   no pending stale; treat as forwardable.
//   "cancelled": there was a pending stale; consume and suppress.
//   "idle":      called while nothing is active and no stales pending
//                -- ignore.
export type EndKind = "natural" | "cancelled" | "idle";

export class TurnLifecycle {
  private active = false;
  private pendingStaleEnds = 0;
  private lastBeginAddedStale = false;

  get isActive(): boolean {
    return this.active;
  }

  begin(): void {
    if (this.active) {
      this.pendingStaleEnds += 1;
      this.active = false;
      this.lastBeginAddedStale = true;
    } else {
      this.active = true;
      this.lastBeginAddedStale = false;
    }
  }

  cancel(): void {
    if (!this.active) return;
    this.pendingStaleEnds += 1;
    this.active = false;
  }

  rearm(): void {
    // Re-assert active so the new turn's events forward, AND decay one
    // pending stale -- we've waited as long as we're going to wait for
    // the drained end to arrive. If it fired during abort, end() has
    // already consumed it (pending was already 0). If it didn't, we
    // forfeit suppression: a late drained agent_end will classify as
    // natural and be forwarded, but the frontend workaround handles
    // that path gracefully. The alternative -- keeping pending -- was
    // worse: the new turn's REAL natural end would then misclassify
    // as cancelled and the UI would stick in "thinking" forever.
    this.active = true;
    if (this.pendingStaleEnds > 0) this.pendingStaleEnds -= 1;
  }

  revert(): void {
    // Empty-STT path: undo the most recent begin().
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
      return "cancelled";
    }
    if (this.active) {
      // Do NOT clear active here. Subsequent events for this same
      // turn (or even a late drained event from a prior turn) must
      // continue flowing -- the only path to active=false is begin()
      // replacing an active turn at the next utterance.
      return "natural";
    }
    return "idle";
  }
}
