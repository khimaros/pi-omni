import type { WebSocket } from "ws";
import type OpenAI from "openai";
import { transcribe } from "../audio/stt.js";
import { TtsPlayer, type TtsPhase, type TtsPhaseInfo } from "../audio/tts.js";
import { sanitizeForSpeech } from "../audio/sanitize.js";
import { SentenceChunker } from "../audio/chunker.js";
import { wrapPcmAsWav } from "../audio/wav.js";
import type { VoiceConfig } from "../audio/loop.js";

// One WebSession per WebSocket client. Owns its STT/TTS plumbing but
// piggybacks on the shared pi.sendUserMessage call into the pi agent
// (a single pi session is shared across all web clients and the CLI).
//
// Client → server frames:
//   text  {type:"hello"}                  initial
//   text  {type:"audio_start"}            user started speaking
//   bin   <int16 LE PCM @ captureRate>    mic data (between start/end)
//   text  {type:"audio_end", sampleRate}  utterance complete → run STT+pi
//   text  {type:"cancel"}                 stop TTS, drop in-flight turn
//
// Server → client frames:
//   text  {type:"hello", captureRate:16000, ttsSampleRate:24000}
//   text  {type:"status", message:"..."}
//   text  {type:"transcript", text:"..."}
//   text  {type:"tts_start"}
//   bin   <int16 LE PCM @ ttsSampleRate>
//   text  {type:"tts_end"}
//   text  {type:"agent_end"}
//   text  {type:"error", message:"..."}

export type SessionDeps = {
  cfg: VoiceConfig;
  client: OpenAI;
  // Pi-side message send (called per finished utterance).
  sendUserMessage: (text: string) => Promise<void> | void;
  // Called when this session becomes active / inactive so the host can
  // route pi event handlers (or suppress local TTS).
  onActivate: (s: WebSession) => void;
  onDeactivate: (s: WebSession) => void;
  // Optional logger; if omitted, swallow.
  logger?: (m: string, l?: "info" | "warning" | "error") => void;
};

export class WebSession {
  private ws: WebSocket;
  private deps: SessionDeps;
  private tts: TtsPlayer;
  private pcmChunks: Buffer[] = [];
  private utteranceRate = 16000;
  private chunker = new SentenceChunker();
  private sawDeltasThisTurn = false;
  private turnActive = false;
  private disposed = false;

  constructor(ws: WebSocket, deps: SessionDeps) {
    this.ws = ws;
    this.deps = deps;
    // TtsPlayer with a no-op speaker; we drain the SSE stream for its PCM
    // (via onPcm) and forward to the WS instead of playing locally.
    this.tts = new TtsPlayer({
      baseURL: deps.cfg.baseURL,
      apiKey: deps.cfg.apiKey,
      model: deps.cfg.ttsModel,
      voice: deps.cfg.ttsVoice,
      sampleRate: deps.cfg.ttsSampleRate,
      streamBatchSize: deps.cfg.ttsStreamBatchSize,
      speed: deps.cfg.ttsSpeed,
      instructions: deps.cfg.ttsInstructions,
      language: deps.cfg.ttsLanguage,
      // /dev/null sink — we don't want server-side playback.
      speakerCmd: "cat",
      logger: deps.logger,
      onPhase: (phase, info) => this.onTtsPhase(phase, info),
      onPcm: (pcm) => this.sendBinary(pcm),
    });

    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) this.onAudio(data as Buffer);
        else this.onControl(data.toString("utf8"));
      } catch (e) {
        this.log(`session: msg error: ${(e as Error).message}`, "warning");
      }
    });
    ws.on("error", (e) => this.log(`session: ws error: ${e.message}`, "warning"));

    this.sendJson({
      type: "hello",
      captureRate: 16000,
      ttsSampleRate: deps.cfg.ttsSampleRate,
      autoStart: deps.cfg.webAutoStart,
      orbGlyph: deps.cfg.orbGlyph,
    });
    deps.onActivate(this);
  }

  // Forwarded from index.ts event handlers when this session is active.
  onLlmDelta(delta: string): void {
    if (!this.turnActive) return;
    if (!this.sawDeltasThisTurn) {
      this.sawDeltasThisTurn = true;
      this.sendJson({ type: "status", message: "LLM streaming…" });
    }
    // Forward raw delta for live display (browser appends).
    this.sendJson({ type: "llm_delta", text: delta });
    if (!this.deps.cfg.ttsStreamSentences) return;
    for (const sentence of this.chunker.push(delta)) {
      const s = sanitizeForSpeech(sentence);
      if (s) {
        this.log(`tts enqueue (stream): ${JSON.stringify(s.slice(0, 80))}`);
        this.tts.enqueue(s);
      }
    }
  }

  onTurnEnd(event: unknown): void {
    if (!this.turnActive) return;
    if (this.deps.cfg.ttsStreamSentences && this.sawDeltasThisTurn) {
      for (const sentence of this.chunker.flush()) {
        const s = sanitizeForSpeech(sentence);
        if (s) this.tts.enqueue(s);
      }
      return;
    }
    const raw = extractAssistantText(event).trim();
    if (!raw) return;
    // Block-mode display: send the full text once.
    this.sendJson({ type: "llm_text", text: raw });
    const text = sanitizeForSpeech(raw);
    if (!text) return;
    this.tts.enqueue(text);
  }

  onAgentEnd(): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.sendJson({ type: "agent_end" });
  }

  get voiceTurnInFlight(): boolean {
    return this.turnActive;
  }

  get systemPrompt(): string {
    return this.deps.cfg.voiceSystemPrompt;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.tts.cancel();
    } catch {}
    try {
      this.deps.onDeactivate(this);
    } catch {}
  }

  private onControl(text: string): void {
    let msg: { type?: string; sampleRate?: number };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.type) {
      case "audio_start":
        this.pcmChunks = [];
        this.sendJson({ type: "status", message: "recording" });
        break;
      case "audio_end":
        this.utteranceRate = msg.sampleRate ?? 16000;
        void this.finishUtterance();
        break;
      case "cancel":
        this.tts.cancel();
        this.turnActive = false;
        this.sendJson({ type: "status", message: "cancelled" });
        break;
    }
  }

  private onAudio(pcm: Buffer): void {
    this.pcmChunks.push(pcm);
  }

  private async finishUtterance(): Promise<void> {
    const pcm = Buffer.concat(this.pcmChunks);
    this.pcmChunks = [];
    if (!pcm.length) {
      this.sendJson({ type: "status", message: "empty utterance" });
      return;
    }
    const wav = wrapPcmAsWav(pcm, this.utteranceRate);
    this.sendJson({ type: "status", message: "STT…" });
    let text = "";
    try {
      text = (await transcribe(this.deps.client, wav, this.deps.cfg.sttModel)).trim();
    } catch (e) {
      this.sendJson({ type: "error", message: `STT: ${(e as Error).message}` });
      return;
    }
    if (!text) {
      // Empty STT — likely a false-positive from VAD. Do NOT cancel any
      // in-flight TTS / LLM turn; just drop the audio silently.
      this.sendJson({ type: "status", message: "empty transcription" });
      return;
    }
    this.sendJson({ type: "transcript", text });
    // Commit to a new turn: drop in-flight TTS (local sink + client playout)
    // and reset per-turn state.
    this.tts.cancel();
    this.sendJson({ type: "tts_cancel" });
    this.chunker = new SentenceChunker();
    this.sawDeltasThisTurn = false;
    this.turnActive = true;
    try {
      await this.deps.sendUserMessage(text);
    } catch (e) {
      this.sendJson({
        type: "error",
        message: `pi.sendUserMessage: ${(e as Error).message}`,
      });
      this.turnActive = false;
    }
  }

  private onTtsPhase(phase: TtsPhase, info: TtsPhaseInfo): void {
    // Log every phase change so silent TTS failures are visible in journalctl.
    // Includes bytes/ttfb/exit on the phases where they're populated.
    const parts: string[] = [`tts phase=${phase}`];
    if (info.text != null) parts.push(`text=${JSON.stringify(info.text.slice(0, 80))}`);
    if (info.queued != null) parts.push(`queued=${info.queued}`);
    if (info.bytes != null) parts.push(`bytes=${info.bytes}`);
    if (info.contentType != null) parts.push(`ct=${info.contentType}`);
    if (info.ttfbMs != null) parts.push(`ttfb=${info.ttfbMs}ms`);
    if (info.exitCode != null) parts.push(`exit=${info.exitCode}`);
    if (info.signal != null) parts.push(`sig=${info.signal}`);
    if (info.ok != null) parts.push(`ok=${info.ok}`);
    this.log(parts.join(" "));
    switch (phase) {
      case "synth_start":
        this.sendJson({ type: "tts_start" });
        break;
      case "drained":
        this.sendJson({ type: "tts_end" });
        break;
    }
  }

  private sendJson(obj: unknown): void {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {}
  }

  private sendBinary(pcm: Buffer): void {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(pcm, { binary: true });
    } catch {}
  }

  private log(m: string, l?: "info" | "warning" | "error"): void {
    this.deps.logger?.(m, l);
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
              !!p &&
              typeof p === "object" &&
              (p as { type?: string }).type === "text" &&
              typeof (p as { text?: unknown }).text === "string",
          )
          .map((p) => p.text)
          .join("");
      }
    }
  }
  return "";
}
