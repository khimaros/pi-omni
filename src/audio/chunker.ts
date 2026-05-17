// Splits a stream of text deltas into complete sentences. Trailing partial
// text is kept in the buffer and only emitted by flush().
//
// Period rule: only split on `.` when followed by whitespace (so "1.2.3" and
// "e.g.foo" stay intact). `!`, `?`, and `\n` split unconditionally.
export class SentenceChunker {
  private buf = "";

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    const re = /[^.!?\n]*(?:[!?\n]+|\.+(?=[ \t\n]))[ \t]*/g;
    let m: RegExpExecArray | null;
    let lastIdx = 0;
    while ((m = re.exec(this.buf)) !== null) {
      // exec with /g skips forward when the regex can't match at lastIdx
      // (e.g. "Node.js" — the dot before "js" isn't a sentence terminator,
      // so the engine jumps ahead to the next valid match). Slice from
      // lastIdx to capture that skipped text as part of THIS sentence,
      // otherwise it gets silently dropped from the TTS stream.
      const end = m.index + m[0].length;
      const s = this.buf.slice(lastIdx, end).trim();
      if (s) out.push(s);
      lastIdx = end;
    }
    if (lastIdx > 0) this.buf = this.buf.slice(lastIdx);
    return out;
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}
