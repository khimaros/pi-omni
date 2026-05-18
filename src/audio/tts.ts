import { spawn, type ChildProcess } from "node:child_process";

export type TtsDiag = {
  bytes: number;
  contentType?: string;
  events: number;
  ttfbMs?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError?: string;
  httpError?: string;
};

export type TtsLogger = (msg: string, level?: "info" | "warning" | "error") => void;

export type TtsPhase =
  | "synth_start"
  | "synth_end"
  | "play_start"
  | "play_end"
  | "drained";

export type TtsPhaseInfo = {
  text?: string;
  queued?: number;
  bytes?: number;
  contentType?: string;
  ttfbMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  ok?: boolean;
};

export type TtsPhaseSink = (phase: TtsPhase, info: TtsPhaseInfo) => void;

export type TtsOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  voice: string;
  sampleRate: number;
  streamBatchSize: number;
  speakerCmd: string; // must accept raw S16_LE mono PCM on stdin at sampleRate
  // Optional /audio/speech params, forwarded only when defined.
  speed?: number;
  instructions?: string;
  language?: string;
  logger?: TtsLogger;
  onPhase?: TtsPhaseSink;
  // Tap for the AEC reference signal: fires for every PCM chunk written to
  // the speaker, before the speaker buffers it. Caller is responsible for
  // resampling to whatever AEC needs (16kHz).
  onPcm?: (pcm: Buffer) => void;
};

type Player = {
  proc: ChildProcess;
  errChunks: Buffer[];
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>;
  spawnError?: string;
};

export class TtsPlayer {
  private queue: string[] = [];
  private busy = false;
  private player?: Player;
  private cancelled = false;
  private inflight?: AbortController;
  private opts: TtsOptions;
  private onPhase: TtsPhaseSink;

  constructor(opts: TtsOptions) {
    this.opts = opts;
    this.onPhase = opts.onPhase ?? (() => {});
  }

  get idle(): boolean {
    return !this.busy && this.queue.length === 0;
  }

  enqueue(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.queue.push(t);
    void this.drain();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    this.inflight?.abort();
    if (this.player) {
      try {
        this.player.proc.stdin?.end();
      } catch {}
      try {
        this.player.proc.kill("SIGTERM");
      } catch {}
    }
  }

  // One-shot synth+play used by /omni-test. Doesn't share the drain player —
  // spawns its own, writes a single sentence, closes stdin, waits.
  async speakOnce(text: string): Promise<TtsDiag> {
    const ac = new AbortController();
    const player = this.spawnPlayer();
    if (player.spawnError) {
      return blankDiag({ spawnError: player.spawnError });
    }
    this.onPhase("synth_start", { text });
    const synth = await this.synthIntoPlayer(text, 0, player, ac);
    try {
      player.proc.stdin?.end();
    } catch {}
    const close = await player.closed;
    const ok =
      !close.spawnError &&
      (close.code === 0 || close.signal === "SIGTERM") &&
      synth.firstPcm;
    this.onPhase("play_end", {
      text,
      exitCode: close.code,
      signal: close.signal,
      ok,
    });
    if (!ok && !this.cancelled && close.code !== 0) {
      const tail = Buffer.concat(player.errChunks)
        .toString("utf8")
        .split("\n")
        .slice(-2)
        .join(" ")
        .trim();
      this.opts.logger?.(
        `tts: player exit=${close.code} sig=${close.signal}${tail ? ` — ${tail}` : ""}`,
        "warning",
      );
    }
    return {
      bytes: synth.bytes,
      contentType: synth.contentType,
      events: synth.events,
      ttfbMs: synth.ttfbMs,
      exitCode: close.code,
      signal: close.signal,
      stderr: Buffer.concat(player.errChunks).toString("utf8"),
      spawnError: close.spawnError,
      httpError: synth.httpError,
    };
  }

  // Process all queued sentences against a single persistent player so audio
  // plays continuously across sentence boundaries. Synthesis of sentence N+1
  // is pipelined behind sentence N's playback (PCM is buffered in the
  // player's stdin pipe + audio device buffer).
  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.cancelled = false;
    let player: Player | undefined;
    try {
      while (this.queue.length && !this.cancelled) {
        const text = this.queue.shift()!;
        const queuedBehind = this.queue.length;
        if (!player) {
          player = this.spawnPlayer();
          this.player = player;
          if (player.spawnError) {
            this.opts.logger?.(`tts: spawn failed: ${player.spawnError}`, "error");
            return;
          }
        }
        this.inflight = new AbortController();
        this.onPhase("synth_start", { text, queued: queuedBehind });
        const r = await this.synthIntoPlayer(
          text,
          queuedBehind,
          player,
          this.inflight,
        );
        // synth_end + play_end fire when SSE is done for this sentence —
        // audio may still be playing from the player's buffer, but at the
        // producer level we're handing off to the next sentence now.
        this.onPhase("synth_end", {
          text,
          queued: queuedBehind,
          bytes: r.bytes,
          contentType: r.contentType,
          ok: !r.httpError,
        });
        this.onPhase("play_end", {
          text,
          queued: queuedBehind,
          ok: !r.httpError && r.firstPcm,
        });
        if (r.httpError) {
          this.opts.logger?.(`tts: ${r.httpError}`, "error");
        }
        if (this.cancelled) break;
      }
    } finally {
      this.inflight = undefined;
      if (player) {
        try {
          player.proc.stdin?.end();
        } catch {}
        const close = await player.closed;
        if (
          !this.cancelled &&
          close.code !== 0 &&
          close.signal !== "SIGTERM" &&
          !close.spawnError
        ) {
          const tail = Buffer.concat(player.errChunks)
            .toString("utf8")
            .split("\n")
            .slice(-2)
            .join(" ")
            .trim();
          this.opts.logger?.(
            `tts: player exit=${close.code} sig=${close.signal}${tail ? ` — ${tail}` : ""}`,
            "warning",
          );
        }
        this.player = undefined;
      }
      this.busy = false;
      // If a new sentence landed while we were awaiting player.closed above,
      // enqueue()'s drain() call saw busy=true and bailed — pick it up now.
      // Skip the "drained" signal in that case so we don't flap tts_end →
      // tts_start on the client between sentences.
      if (this.queue.length && !this.cancelled) {
        void this.drain();
        return;
      }
      this.onPhase("drained", {});
    }
  }

  private spawnPlayer(): Player {
    const parts = this.opts.speakerCmd.split(/\s+/).filter(Boolean);
    const [cmd, ...args] = parts;
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (e) {
      return {
        proc: null as unknown as ChildProcess,
        errChunks: [],
        closed: Promise.resolve({
          code: null,
          signal: null,
          spawnError: (e as Error).message,
        }),
        spawnError: (e as Error).message,
      };
    }
    const errChunks: Buffer[] = [];
    proc.stderr?.on("data", (b: Buffer) => errChunks.push(b));
    proc.stdin?.on("error", () => {});
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: string;
    }>((resolve) => {
      proc.once("error", (e) =>
        resolve({ code: null, signal: null, spawnError: e.message }),
      );
      proc.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { proc, errChunks, closed };
  }

  // Open the SSE stream for one sentence and pipe decoded PCM into the
  // supplied player. Returns once the stream completes (NOT once the audio
  // finishes playing — that's the player's exit).
  private async synthIntoPlayer(
    text: string,
    queued: number,
    player: Player,
    ac: AbortController,
  ): Promise<{
    bytes: number;
    contentType?: string;
    events: number;
    ttfbMs?: number;
    firstPcm: boolean;
    httpError?: string;
  }> {
    const url = `${this.opts.baseURL.replace(/\/+$/, "")}/audio/speech`;
    const bodyObj: Record<string, unknown> = {
      input: text,
      model: this.opts.model,
      voice: this.opts.voice,
      response_format: "pcm",
      stream_format: "sse",
      stream_batch_size: this.opts.streamBatchSize,
    };
    if (this.opts.speed != null) bodyObj.speed = this.opts.speed;
    if (this.opts.instructions) bodyObj.instructions = this.opts.instructions;
    if (this.opts.language) bodyObj.language = this.opts.language;
    const body = JSON.stringify(bodyObj);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        body,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal: ac.signal,
      });
    } catch (e) {
      return {
        bytes: 0,
        events: 0,
        firstPcm: false,
        httpError: `fetch failed: ${(e as Error).message}`,
      };
    }

    const contentType = resp.headers.get("content-type") ?? undefined;
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "");
      return {
        bytes: 0,
        contentType,
        events: 0,
        firstPcm: false,
        httpError: `tts ${resp.status} ${errText.slice(0, 200)}`,
      };
    }

    let firstPcm = false;
    let totalBytes = 0;
    let events = 0;
    let ttfbMs: number | undefined;
    const startedAt = Date.now();

    // Older OpenAI TTS models (tts-1, tts-1-hd) ignore stream_format and just
    // stream raw PCM with content-type "audio/pcm". The SSE parser below
    // would silently drop every byte. Detect that and pipe the body straight
    // through to the player instead.
    const isSse = (contentType ?? "").includes("text/event-stream");
    if (!isSse) {
      const reader = resp.body.getReader();
      // S16_LE = 2 bytes/sample. Fetch chunks aren't aligned to sample
      // boundaries, so carry any trailing odd byte forward; otherwise the
      // next chunk would be byte-shifted and the audio comes out scrambled.
      let carry: Buffer | null = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.cancelled) break;
          if (!value || value.length === 0) continue;
          let pcm = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          if (carry) {
            pcm = Buffer.concat([carry, pcm]);
            carry = null;
          }
          if (pcm.length % 2 === 1) {
            carry = pcm.subarray(pcm.length - 1);
            pcm = pcm.subarray(0, pcm.length - 1);
          }
          if (pcm.length === 0) continue;
          totalBytes += pcm.length;
          events += 1;
          if (!firstPcm) {
            firstPcm = true;
            ttfbMs = Date.now() - startedAt;
            this.onPhase("play_start", { text, queued, ttfbMs });
          }
          try {
            player.proc.stdin?.write(pcm);
          } catch {}
          try {
            this.opts.onPcm?.(pcm);
          } catch {}
        }
      } catch (e) {
        if (!this.cancelled) {
          this.opts.logger?.(
            `tts: raw stream read error: ${(e as Error).message}`,
            "warning",
          );
        }
      }
      return { bytes: totalBytes, contentType, events, ttfbMs, firstPcm };
    }

    const dispatch = (eventName: string | null, dataLines: string[]): void => {
      if (!dataLines.length && eventName === null) return;
      const name = eventName || "message";
      const payload = dataLines.join("");
      if (!payload || payload === "[DONE]") return;
      if (name !== "speech.audio.delta") return;
      let obj: unknown;
      try {
        obj = JSON.parse(payload);
      } catch {
        return;
      }
      const audioB64 = (obj as { audio?: unknown })?.audio;
      if (typeof audioB64 !== "string") return;
      const pcm = Buffer.from(audioB64, "base64");
      if (!pcm.length) return;
      events += 1;
      totalBytes += pcm.length;
      if (!firstPcm) {
        firstPcm = true;
        ttfbMs = Date.now() - startedAt;
        this.onPhase("play_start", { text, queued, ttfbMs });
      }
      try {
        player.proc.stdin?.write(pcm);
      } catch {}
      try {
        this.opts.onPcm?.(pcm);
      } catch {}
    };

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent: string | null = null;
    let dataBuf: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.cancelled) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") {
            dispatch(currentEvent, dataBuf);
            currentEvent = null;
            dataBuf = [];
          } else if (line.startsWith(":")) {
            // comment
          } else if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataBuf.push(line.slice(5).trimStart());
          }
        }
      }
      dispatch(currentEvent, dataBuf);
    } catch (e) {
      if (!this.cancelled) {
        this.opts.logger?.(
          `tts: stream read error: ${(e as Error).message}`,
          "warning",
        );
      }
    }

    return { bytes: totalBytes, contentType, events, ttfbMs, firstPcm };
  }
}

function blankDiag(overrides: Partial<TtsDiag>): TtsDiag {
  return {
    bytes: 0,
    contentType: undefined,
    events: 0,
    ttfbMs: undefined,
    exitCode: null,
    signal: null,
    stderr: "",
    ...overrides,
  };
}
