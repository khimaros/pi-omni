import OpenAI from "openai";
import { Mic } from "./mic.js";
import { TtsPlayer, type TtsPhase, type TtsPhaseInfo } from "./tts.js";
import { transcribe } from "./stt.js";
import { sanitizeForSpeech } from "./sanitize.js";
import { SileroVad } from "./silero-vad.js";
import { wrapPcmAsWav } from "./wav.js";
import { SentenceChunker } from "./chunker.js";
import { Aec, LinearResampler } from "./aec.js";

const AEC_SAMPLE_RATE = 16000;

export type LoopLogger = (msg: string, level?: "info" | "warning" | "error") => void;

export type VoiceConfig = {
  baseURL: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  // Sample rate of the streamed PCM (S16_LE mono). Must match speakerCmd.
  ttsSampleRate: number;
  ttsStreamBatchSize: number;
  // Optional /audio/speech params, only sent when defined. Match the rhai
  // openai_tts node so config carries through identically.
  ttsSpeed?: number;
  ttsInstructions?: string;
  ttsLanguage?: string;
  micDevice?: string;
  speakerCmd: string;
  // Injected as a system message before every voice-mode turn so the LLM
  // knows its reply will be spoken aloud. Empty string disables.
  voiceSystemPrompt: string;
  // Voice-activity detection: auto-stop recording when the user goes quiet.
  vadEnabled: boolean;
  vadSampleRate: number; // mic capture rate; defaults to 16000
  vadSilenceMs: number; // trailing silence needed to end utterance
  vadMinSpeechMs: number; // ignore utterances shorter than this
  vadMaxRecordingMs: number; // hard cap on a single recording
  // Keyboard shortcut wired to the /omni toggle. Empty string disables.
  // Examples: "alt+v", "ctrl+space", "f9". Exact syntax is whatever pi accepts.
  voiceShortcut: string;
  // Keyboard shortcut wired to cancel: stops TTS, drops current recording,
  // and exits continuous chat mode. Empty string disables.
  cancelShortcut: string;
  // When true, sanitize+enqueue each completed sentence as the LLM streams
  // (lower time-to-first-audio, multiple TTS calls per turn). When false,
  // wait for turn_end and enqueue the whole assistant block as one TTS call.
  ttsChunkSentences: boolean;
  // When true, request server-sent-event PCM streaming from the TTS endpoint
  // (stream_format=sse, first audio plays before the TTS call completes).
  // When false, the endpoint returns the full PCM in one response -- higher
  // first-audio latency but works with TTS servers that don't speak SSE.
  // Orthogonal to ttsChunkSentences: you can chunk into sentences without
  // SSE (each sentence is a single non-streamed call), or stream audio for
  // the whole turn without chunking.
  ttsStreamAudio: boolean;
  // Milliseconds of silence inserted between consecutive sentences in
  // ttsChunkSentences mode. Without a gap, back-to-back synthesized sentences
  // run together (the second sentence has no prosodic lead-in from the first
  // since it was synthesized independently). 150-250ms feels natural. Set to
  // 0 to disable. Has no effect when ttsChunkSentences=false.
  ttsInterSentenceGapMs: number;
  // Acoustic echo cancellation via WebRTC AEC3 (WASM). Required for reliable
  // barge-in over speakers; without it the bot's own voice will trigger the
  // VAD. Adds ~10ms/frame of mic latency.
  aecEnabled: boolean;
  // Expected playback-to-mic round-trip delay. APM has a delay estimator but
  // converges faster with a good seed. 100-300ms is typical.
  aecPlaybackDelayMs: number;
  // When true, mic stays open during TTS playback and a speech-start triggers
  // cancellation + a new turn. Requires aecEnabled for reliable behavior on
  // speakers (use headphones otherwise).
  bargeInEnabled: boolean;
  // Ignore speech bursts shorter than this when detecting barge-in, to
  // suppress mic blips / AEC residual transients.
  bargeInMinSpeechMs: number;
  // Suppress VAD events for this long after TTS playback starts. Gives the
  // AEC adaptive filter time to converge before we listen for barge-in.
  // her/'s BARGE_IN_GUARD_MS pattern; 500-1000ms is typical.
  bargeInGuardMs: number;
  // /omni-web bind: host + port the embedded HTTP/WS server listens on.
  webHost: string;
  webPort: number;
  // Auto-start /omni-web server when the extension loads (equivalent to
  // passing --omni-web on the pi command line).
  autoStartWeb: boolean;
  // Auto-start /omni-live continuous voice mode on load (equivalent to
  // --omni-live).
  autoStartLive: boolean;
  // Web UI: when true, the browser skips the "tap to start" overlay and
  // tries to open the mic immediately on page load. Falls back to the
  // overlay if the browser blocks without a user gesture (iOS Safari).
  webAutoStart: boolean;
  // Glyph displayed inside the orb in the web UI. Empty string = no
  // glyph (plain disc + colored glow). Any single emoji works (e.g. 🌀).
  orbGlyph: string;
};

type State = "idle" | "recording" | "thinking";
type StatusSink = (text: string) => void;

type Pi = {
  sendUserMessage: (content: string, options?: unknown) => unknown;
};
type CmdCtx = {
  ui: {
    notify: (msg: string, level?: string) => void;
    setStatus: (id: string, text: string) => void;
  };
};

const STATUS_ID = "voice";

export class VoiceLoop {
  private state: State = "idle";
  private mic: Mic;
  private tts: TtsPlayer;
  private client: OpenAI;
  private status: StatusSink = () => {};
  private agentEnded = false;
  private voiceTurnActive = false;
  // Single persistent Silero VAD instance, lazily initialized. Mode-based
  // dispatch: "recording" routes onSpeechEnd to handleAutoStop; "barge"
  // routes onSpeechStart to onBargeIn. "off" drops both.
  private silero?: SileroVad;
  private sileroInit?: Promise<SileroVad>;
  private vadMode: "off" | "recording" | "barge" = "off";
  // Wall-clock cutoff before which VAD events are ignored. Set on
  // play_start to suppress events while AEC converges.
  private vadGuardUntilMs = 0;
  private maxRecordingTimer?: NodeJS.Timeout;
  private autoStopCtx?: CmdCtx;
  private chatMode = false;
  private chatCtx?: CmdCtx;
  // Latest ctx we have so esc-cancel can be triggered from a terminal input
  // listener that was registered against an older ctx (rebind every bindCtx).
  private latestCtx?: CmdCtx;
  private escUnsub?: () => void;
  private chunker = new SentenceChunker();
  // Whether we received any streamed deltas this turn -- if so, turn_end just
  // flushes the chunker rather than enqueueing the full assistant text again.
  private sawDeltasThisTurn = false;
  // AEC stack: pre-built once if cfg.aecEnabled, then mic chunks are routed
  // through processCapture and TTS PCM through a resampler + pushReference.
  private aec?: Aec;
  private refResampler?: LinearResampler;
  // Cleaned-PCM buffer for the current recording (only used when AEC is on).
  // Replaces mic.stop()'s raw accumulation when sending to STT.
  private recordedPcm: Buffer[] = [];
  private captureRate: number;
  // Monotonic counter incremented on barge-in. LLM deltas / turn_end events
  // tagged with a stale generation are ignored (they're from the turn we
  // just cut off).
  private generation = 0;
  // Tracks whether TTS is currently in a contiguous playback span. We anchor
  // the AEC reference clock only on the FIRST play_start of a span (each
  // sentence fires its own play_start), and clear on drained.
  private ttsSpanActive = false;
  private loopLogger?: LoopLogger;

  constructor(
    private pi: Pi,
    private cfg: VoiceConfig,
    logger?: LoopLogger,
  ) {
    this.loopLogger = logger;
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
    if (cfg.aecEnabled) {
      try {
        this.aec = new Aec({ initialDelayMs: cfg.aecPlaybackDelayMs });
        if (cfg.ttsSampleRate !== AEC_SAMPLE_RATE) {
          this.refResampler = new LinearResampler(
            cfg.ttsSampleRate,
            AEC_SAMPLE_RATE,
          );
        }
      } catch (e) {
        logger?.(`aec: init failed, continuing without -- ${(e as Error).message}`, "warning");
      }
    }
    // Mic capture rate is forced to AEC rate when AEC is on (APM needs 16k).
    this.captureRate = this.aec ? AEC_SAMPLE_RATE : cfg.vadSampleRate;
    this.mic = new Mic({
      device: cfg.micDevice,
      sampleRate: this.captureRate,
      onChunk: (pcm) => this.onMicChunk(pcm),
    });
    this.tts = new TtsPlayer({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      model: cfg.ttsModel,
      voice: cfg.ttsVoice,
      sampleRate: cfg.ttsSampleRate,
      streamBatchSize: cfg.ttsStreamBatchSize,
      speakerCmd: cfg.speakerCmd,
      speed: cfg.ttsSpeed,
      instructions: cfg.ttsInstructions,
      language: cfg.ttsLanguage,
      streamAudio: cfg.ttsStreamAudio,
      interSentenceGapMs: cfg.ttsChunkSentences ? cfg.ttsInterSentenceGapMs : 0,
      logger,
      onPhase: (phase, info) => this.onTtsPhase(phase, info),
      onPcm: this.aec ? (pcm) => this.onTtsPcm(pcm) : undefined,
    });
  }

  // Mic capture path. When AEC is on, route through the canceller and feed
  // VAD + accumulator with cleaned PCM. When off, fall back to raw passthrough
  // (mic already buffers raw bytes itself; here we only feed VAD).
  private onMicChunk(pcm: Buffer): void {
    const feed = this.aec ? this.aec.processCapture(pcm) : pcm;
    if (!feed.length) return;
    if (this.state === "recording") this.recordedPcm.push(feed);
    if (this.vadMode !== "off") this.silero?.feed(feed);
  }

  // Lazy Silero init. Loads the ONNX model on first request; subsequent
  // calls return the cached instance.
  private async ensureSilero(): Promise<SileroVad | undefined> {
    if (!this.cfg.vadEnabled) return undefined;
    if (this.silero) return this.silero;
    if (!this.sileroInit) {
      this.sileroInit = SileroVad.create({
        onSpeechStart: () => this.onVadSpeechStart(),
        onSpeechEnd: () => this.onVadSpeechEnd(),
      }).catch((e) => {
        this.loopLogger?.(
          `silero: init failed, VAD disabled -- ${(e as Error).message}`,
          "warning",
        );
        throw e;
      });
    }
    try {
      this.silero = await this.sileroInit;
      return this.silero;
    } catch {
      return undefined;
    }
  }

  private onVadSpeechStart(): void {
    if (Date.now() < this.vadGuardUntilMs) return;
    if (this.vadMode === "recording") {
      this.status("speech detected -- listening…");
    } else if (this.vadMode === "barge") {
      this.onBargeIn();
    }
  }

  private onVadSpeechEnd(): void {
    if (Date.now() < this.vadGuardUntilMs) return;
    if (this.vadMode !== "recording") return;
    this.status("end of speech -- stopping mic");
    void this.handleAutoStop();
  }

  // Reference path: TTS PCM about to hit the speaker. Resample if needed,
  // push to the canceller. Best-effort -- errors are swallowed.
  private onTtsPcm(pcm: Buffer): void {
    if (!this.aec) return;
    const at16 = this.refResampler ? this.refResampler.process(pcm) : pcm;
    if (at16.length) this.aec.pushReference(at16);
  }

  get voiceTurnInFlight(): boolean {
    return this.voiceTurnActive;
  }

  // true while continuous conversation mode is active (between/around turns).
  get inChatMode(): boolean {
    return this.chatMode;
  }

  get systemPrompt(): string {
    return this.cfg.voiceSystemPrompt;
  }

  // Route status updates through whatever ctx is most recently in scope.
  // index.ts calls this from every command/event handler.
  bindCtx(ctx: CmdCtx | undefined): void {
    if (!ctx) {
      this.status = () => {};
      this.latestCtx = undefined;
      return;
    }
    this.status = (text: string) => ctx.ui.setStatus(STATUS_ID, text);
    this.latestCtx = ctx;
    this.rebindEsc(ctx);
  }

  // Re-attach the esc handler against the latest ctx. We use
  // onTerminalInput (returns `{consume:true}` to swallow, undefined to pass
  // through) instead of a global pi.registerShortcut so esc only acts during
  // an active voice turn / chat mode -- when nothing's in flight the key
  // falls through to pi's built-in esc handlers (cancel picker, etc.).
  private rebindEsc(ctx: CmdCtx): void {
    if (typeof (ctx.ui as { onTerminalInput?: unknown }).onTerminalInput !== "function") {
      return;
    }
    this.escUnsub?.();
    this.escUnsub = (ctx.ui as unknown as {
      onTerminalInput: (h: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void;
    }).onTerminalInput((data) => {
      if (data !== "\x1b") return undefined;
      if (!this.voiceTurnInFlight && !this.chatMode) return undefined;
      const target = this.latestCtx;
      if (!target) return undefined;
      // Cancel asynchronously so the return value still consumes the key.
      queueMicrotask(() => this.cancelOutput(target));
      return { consume: true };
    });
  }

  get ttsPlayer(): TtsPlayer {
    return this.tts;
  }

  dispose(): void {
    this.tts.cancel();
    this.escUnsub?.();
    this.escUnsub = undefined;
  }

  async toggle(ctx: CmdCtx): Promise<void> {
    this.bindCtx(ctx);
    if (this.state === "recording") {
      await this.stopAndSend(ctx);
      return;
    }
    if (this.state === "thinking") {
      ctx.ui.notify("voice: still processing previous turn", "warning");
      return;
    }
    // idle -- also barge-in: kill any TTS that's still playing
    this.tts.cancel();
    await this.startRecording(ctx);
  }

  // Continuous loop: record → STT → LLM → TTS → record again. Call again to
  // turn off; Esc / cancelOutput() also exits.
  async toggleChat(ctx: CmdCtx): Promise<void> {
    this.bindCtx(ctx);
    if (this.chatMode) {
      this.exitChatMode();
      this.status("voice-live: stopped");
      return;
    }
    if (this.state === "thinking") {
      ctx.ui.notify("voice-live: wait for current turn to finish", "warning");
      return;
    }
    this.chatMode = true;
    this.chatCtx = ctx;
    this.status("voice-live: started -- esc to stop");
    if (this.state === "idle" && this.tts.idle) {
      this.tts.cancel();
      await this.startRecording(ctx);
    }
  }

  private exitChatMode(): void {
    this.chatMode = false;
    this.chatCtx = undefined;
  }

  // Esc-style cancel: stop TTS, drop any in-flight recording, exit chat mode.
  cancelOutput(ctx: CmdCtx): void {
    this.bindCtx(ctx);
    this.exitChatMode();
    this.tts.cancel();
    if (this.aec && this.ttsSpanActive) {
      this.ttsSpanActive = false;
      this.aec.stopPlayback();
    }
    if (this.state === "recording") {
      if (this.maxRecordingTimer) {
        clearTimeout(this.maxRecordingTimer);
        this.maxRecordingTimer = undefined;
      }
      this.vadMode = "off";
      this.autoStopCtx = undefined;
      void this.mic.stop();
      this.recordedPcm = [];
      this.state = "idle";
    }
    this.stopBargeInListen();
    this.status("cancelled");
  }

  private maybeChatRestart(): void {
    if (!this.chatMode || !this.chatCtx) return;
    if (this.state !== "idle") return;
    if (!this.tts.idle) return;
    void this.startRecording(this.chatCtx);
  }

  private async startRecording(ctx: CmdCtx): Promise<void> {
    this.autoStopCtx = ctx;
    this.recordedPcm = [];
    if (this.cfg.vadEnabled) {
      await this.ensureSilero();
      this.silero?.reset();
      this.vadMode = "recording";
    } else {
      this.vadMode = "off";
    }
    this.vadGuardUntilMs = 0;
    if (!this.mic.recording) this.mic.start();
    this.state = "recording";
    this.maxRecordingTimer = setTimeout(() => {
      if (this.state === "recording") {
        this.status("max recording duration hit -- stopping");
        void this.handleAutoStop();
      }
    }, this.cfg.vadMaxRecordingMs);
    this.status(
      this.cfg.vadEnabled
        ? "recording -- VAD will auto-stop on silence; /omni cancels"
        : "recording -- /omni again to stop",
    );
  }

  private async handleAutoStop(): Promise<void> {
    if (this.state !== "recording") return;
    const ctx = this.autoStopCtx;
    if (!ctx) return;
    await this.stopAndSend(ctx);
  }

  private async stopAndSend(ctx: CmdCtx): Promise<void> {
    if (this.maxRecordingTimer) {
      clearTimeout(this.maxRecordingTimer);
      this.maxRecordingTimer = undefined;
    }
    this.autoStopCtx = undefined;
    this.vadMode = "off";
    this.status("stopping mic…");
    // Mic lifetime:
    //  - bargeInEnabled: mic stays open across the turn so we can detect a
    //    user-initiated interrupt. We use the accumulated recordedPcm.
    //  - otherwise: stop the mic and use whichever buffer was populated.
    let pcm: Buffer;
    if (this.cfg.bargeInEnabled) {
      pcm = Buffer.concat(this.recordedPcm);
    } else {
      const rawPcm = await this.mic.stop();
      pcm = this.recordedPcm.length ? Buffer.concat(this.recordedPcm) : rawPcm;
    }
    this.recordedPcm = [];
    const wav = wrapPcmAsWav(pcm, this.captureRate);
    this.status("sent audio to STT");
    let text = "";
    try {
      text = await transcribe(this.client, wav, this.cfg.sttModel);
    } catch (e) {
      ctx.ui.notify(`STT failed: ${(e as Error).message ?? e}`, "error");
      this.state = "idle";
      this.status("");
      this.exitChatMode(); // avoid runaway retry loop on repeated STT failure
      return;
    }
    text = text.trim();
    if (!text) {
      ctx.ui.notify("voice: empty transcription", "warning");
      this.state = "idle";
      this.status("");
      this.maybeChatRestart();
      return;
    }
    this.status("STT complete -- sending to LLM");
    this.state = "thinking";
    this.agentEnded = false;
    this.voiceTurnActive = true;
    this.chunker = new SentenceChunker();
    this.sawDeltasThisTurn = false;
    this.startBargeInListen();
    await this.pi.sendUserMessage(text, { deliverAs: "steer" });
    this.status("LLM thinking…");
  }

  // Keep the mic open after the user stopped recording so we can detect the
  // user starting to speak again while TTS plays. No-op unless bargeInEnabled.
  private startBargeInListen(): void {
    if (!this.cfg.bargeInEnabled) return;
    // Use the same persistent Silero VAD; just switch its mode. Reset so we
    // don't carry over speech state from the previous recording.
    this.silero?.reset();
    this.vadMode = "barge";
    // mic was stopped by stopAndSend(); restart it for listening.
    if (!this.mic.recording) this.mic.start();
  }

  private stopBargeInListen(): void {
    if (this.vadMode === "barge") this.vadMode = "off";
    if (this.state !== "recording" && this.mic.recording) {
      void this.mic.stop();
    }
  }

  private onBargeIn(): void {
    // Drop the current turn: kill TTS, mark this generation as obsolete so
    // any late deltas / turn_end events are ignored.
    this.tts.cancel();
    if (this.aec && this.ttsSpanActive) {
      this.ttsSpanActive = false;
      this.aec.stopPlayback();
    }
    this.generation += 1;
    this.voiceTurnActive = false;
    // Swap into recording mode with a fresh VAD reset; mic is already streaming.
    this.status("barge-in -- listening");
    this.recordedPcm = [];
    this.silero?.reset();
    this.vadMode = "recording";
    this.vadGuardUntilMs = 0;
    this.state = "recording";
    if (this.maxRecordingTimer) {
      clearTimeout(this.maxRecordingTimer);
    }
    this.maxRecordingTimer = setTimeout(() => {
      if (this.state === "recording") {
        this.status("max recording duration hit -- stopping");
        void this.handleAutoStop();
      }
    }, this.cfg.vadMaxRecordingMs);
    // autoStopCtx remains whatever was last bound; status sink already points
    // at the current ctx.
    this.autoStopCtx = this.chatCtx;
  }

  // Called on each LLM text delta. In sentence-streaming mode, deltas feed a
  // chunker and each completed sentence is enqueued to TTS as soon as it's
  // ready (her/-style). In block mode this only updates status.
  onLlmDelta(delta: string): void {
    if (this.state !== "thinking") return;
    if (!this.sawDeltasThisTurn) {
      this.sawDeltasThisTurn = true;
      this.status("LLM streaming…");
    }
    if (!this.cfg.ttsChunkSentences) return;
    for (const sentence of this.chunker.push(delta)) {
      const sanitized = sanitizeForSpeech(sentence);
      if (sanitized) this.tts.enqueue(sanitized);
    }
  }

  // End-of-turn flush. Two paths:
  //  - sentence-streaming: emit any buffered partial (handles replies that
  //    end without terminal punctuation) and stop.
  //  - block mode (or no deltas were seen -- extension bus didn't forward
  //    message_update): sanitize the whole assistant text and enqueue once.
  onTurnEnd(event: unknown): void {
    if (this.state !== "thinking") return;
    if (this.cfg.ttsChunkSentences && this.sawDeltasThisTurn) {
      for (const sentence of this.chunker.flush()) {
        const sanitized = sanitizeForSpeech(sentence);
        if (sanitized) this.tts.enqueue(sanitized);
      }
      return;
    }
    const raw = extractAssistantText(event).trim();
    if (!raw) return;
    const text = sanitizeForSpeech(raw);
    if (!text) return;
    this.status("assistant block complete -- sending to TTS");
    this.tts.enqueue(text);
  }

  onAgentEnd(): void {
    // Stale agent_end from a turn we cut off via barge-in: ignore so we don't
    // clobber the new recording state.
    if (this.state !== "thinking") return;
    this.state = "idle";
    this.agentEnded = true;
    this.voiceTurnActive = false;
    if (this.tts.idle) {
      this.status("");
      this.stopBargeInListen();
      this.maybeChatRestart();
    }
  }

  private onTtsPhase(phase: TtsPhase, info: TtsPhaseInfo): void {
    switch (phase) {
      case "synth_start":
        this.status("TTS synth start");
        break;
      case "synth_end":
        this.status(info.ok === false ? "TTS synth FAILED" : "TTS synth complete");
        break;
      case "play_start":
        this.status("TTS playback start");
        if (this.aec && !this.ttsSpanActive) {
          this.ttsSpanActive = true;
          this.aec.startPlayback();
        }
        // Suppress barge-in detection while AEC is converging.
        if (this.cfg.bargeInEnabled) {
          this.vadGuardUntilMs = Date.now() + this.cfg.bargeInGuardMs;
          this.silero?.reset();
        }
        break;
      case "play_end":
        this.status(info.ok === false ? "TTS playback FAILED" : "TTS playback complete");
        break;
      case "drained":
        if (this.aec && this.ttsSpanActive) {
          this.ttsSpanActive = false;
          this.aec.stopPlayback();
        }
        if (this.agentEnded) {
          this.status("");
          this.stopBargeInListen();
          this.maybeChatRestart();
        } else {
          this.status("TTS idle");
        }
        break;
    }
  }
}

function extractAssistantText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as Record<string, unknown>;
  const candidates: unknown[] = [e.message, e.assistantMessage, e.response];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "string") return c;
    if (typeof c === "object") {
      const content = (c as { content?: unknown }).content;
      if (Array.isArray(content)) {
        return content
          .filter(
            (p): p is { type: string; text: string } =>
              !!p && typeof p === "object" && (p as { type?: string }).type === "text" &&
              typeof (p as { text?: unknown }).text === "string",
          )
          .map((p) => p.text)
          .join("");
      }
    }
  }
  return "";
}
