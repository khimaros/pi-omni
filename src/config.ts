import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { VoiceConfig } from "./audio/loop.js";

export const CONFIG_PATH = join(homedir(), ".pi", "extensions", "omni.json");

// default web listen address, used when neither --listen nor PI_OMNI_LISTEN nor
// the config file sets one. a single host:port spec, matching the flag/env.
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4962;
export const LISTEN_ENV = "PI_OMNI_LISTEN";

const DEFAULT_VOICE_SYSTEM_PROMPT =
  "You are a concise local voice assistant. " +
  "Your reply will be spoken aloud by a text-to-speech engine, so never use " +
  "markdown, code blocks, bullet lists, or headings. " +
  "Reply in one or two short, conversational sentences."

const DEFAULTS: VoiceConfig = {
  baseURL: "http://localhost:8080/v1",
  apiKey: "sk-no-key",
  sttModel: "whisper-1",
  ttsModel: "tts-1",
  ttsVoice: "alloy",
  ttsSampleRate: 24000,
  ttsStreamBatchSize: 8,
  micDevice: undefined,
  speakerCmd: "aplay -q -f S16_LE -r 24000 -c 1 -t raw",
  voiceSystemPrompt: DEFAULT_VOICE_SYSTEM_PROMPT,
  vadEnabled: true,
  vadSampleRate: 16000,
  vadSilenceMs: 700,
  vadMinSpeechMs: 250,
  vadMaxRecordingMs: 30000,
  voiceShortcut: "alt+v",
  cancelShortcut: "esc",
  ttsChunkSentences: true,
  ttsStreamAudio: true,
  ttsInterSentenceGapMs: 200,
  aecEnabled: false,
  aecPlaybackDelayMs: 200,
  bargeInEnabled: false,
  bargeInMinSpeechMs: 300,
  bargeInGuardMs: 700,
  webHost: "127.0.0.1",
  webPort: 4962,
  autoStartWeb: false,
  autoStartLive: false,
  webAutoStart: false,
  orbGlyph: "",
};

export type LoadedConfig = {
  cfg: VoiceConfig;
  fromFile: boolean;
};

export async function loadConfig(): Promise<LoadedConfig> {
  let fileCfg: Partial<VoiceConfig> = {};
  let fromFile = false;
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    fileCfg = JSON.parse(raw);
    fromFile = true;
  } catch {
    // missing file is fine
  }

  const env = {
    baseURL: process.env.PI_VOICE_BASE_URL,
    apiKey: process.env.PI_VOICE_API_KEY,
    sttModel: process.env.PI_VOICE_STT_MODEL,
    ttsModel: process.env.PI_VOICE_TTS_MODEL,
    ttsVoice: process.env.PI_VOICE_TTS_VOICE,
    ttsSampleRate: numOrUndef(process.env.PI_VOICE_TTS_SAMPLE_RATE),
    ttsStreamBatchSize: numOrUndef(process.env.PI_VOICE_TTS_BATCH_SIZE),
    ttsSpeed: numOrUndef(process.env.PI_VOICE_TTS_SPEED),
    ttsInstructions: process.env.PI_VOICE_TTS_INSTRUCTIONS,
    ttsLanguage: process.env.PI_VOICE_TTS_LANGUAGE,
    micDevice: process.env.PI_VOICE_MIC_DEVICE || undefined,
    speakerCmd: process.env.PI_VOICE_SPEAKER_CMD,
    voiceSystemPrompt: process.env.PI_VOICE_SYSTEM_PROMPT,
    vadEnabled: boolOrUndef(process.env.PI_VOICE_VAD_ENABLED),
    vadSampleRate: numOrUndef(process.env.PI_VOICE_VAD_SAMPLE_RATE),
    vadSilenceMs: numOrUndef(process.env.PI_VOICE_VAD_SILENCE_MS),
    vadMinSpeechMs: numOrUndef(process.env.PI_VOICE_VAD_MIN_SPEECH_MS),
    vadMaxRecordingMs: numOrUndef(process.env.PI_VOICE_VAD_MAX_MS),
    voiceShortcut: process.env.PI_VOICE_SHORTCUT,
    cancelShortcut: process.env.PI_VOICE_CANCEL_SHORTCUT,
    // Accept legacy PI_VOICE_TTS_STREAM_SENTENCES for ttsChunkSentences so
    // existing systemd units / .env files keep working after the rename.
    ttsChunkSentences:
      boolOrUndef(process.env.PI_VOICE_TTS_CHUNK_SENTENCES) ??
      boolOrUndef(process.env.PI_VOICE_TTS_STREAM_SENTENCES),
    ttsStreamAudio: boolOrUndef(process.env.PI_VOICE_TTS_STREAM_AUDIO),
    ttsInterSentenceGapMs: numOrUndef(process.env.PI_VOICE_TTS_INTER_SENTENCE_GAP_MS),
    aecEnabled: boolOrUndef(process.env.PI_VOICE_AEC_ENABLED),
    aecPlaybackDelayMs: numOrUndef(process.env.PI_VOICE_AEC_DELAY_MS),
    bargeInEnabled: boolOrUndef(process.env.PI_VOICE_BARGE_IN),
    bargeInMinSpeechMs: numOrUndef(process.env.PI_VOICE_BARGE_IN_MIN_MS),
    bargeInGuardMs: numOrUndef(process.env.PI_VOICE_BARGE_IN_GUARD_MS),
    webHost: process.env.PI_VOICE_WEB_HOST,
    webPort: numOrUndef(process.env.PI_VOICE_WEB_PORT),
    autoStartWeb: boolOrUndef(process.env.PI_OMNI_AUTO_WEB),
    autoStartLive: boolOrUndef(process.env.PI_OMNI_AUTO_LIVE),
    webAutoStart: boolOrUndef(process.env.PI_OMNI_WEB_AUTO_START),
    orbGlyph: process.env.PI_OMNI_ORB_GLYPH,
  };

  const cfg: VoiceConfig = {
    baseURL: env.baseURL ?? fileCfg.baseURL ?? DEFAULTS.baseURL,
    apiKey: env.apiKey ?? fileCfg.apiKey ?? DEFAULTS.apiKey,
    sttModel: env.sttModel ?? fileCfg.sttModel ?? DEFAULTS.sttModel,
    ttsModel: env.ttsModel ?? fileCfg.ttsModel ?? DEFAULTS.ttsModel,
    ttsVoice: env.ttsVoice ?? fileCfg.ttsVoice ?? DEFAULTS.ttsVoice,
    ttsSampleRate:
      env.ttsSampleRate ?? fileCfg.ttsSampleRate ?? DEFAULTS.ttsSampleRate,
    ttsStreamBatchSize:
      env.ttsStreamBatchSize ??
      fileCfg.ttsStreamBatchSize ??
      DEFAULTS.ttsStreamBatchSize,
    ttsSpeed: env.ttsSpeed ?? fileCfg.ttsSpeed ?? DEFAULTS.ttsSpeed,
    ttsInstructions:
      env.ttsInstructions ?? fileCfg.ttsInstructions ?? DEFAULTS.ttsInstructions,
    ttsLanguage:
      env.ttsLanguage ?? fileCfg.ttsLanguage ?? DEFAULTS.ttsLanguage,
    micDevice: env.micDevice ?? fileCfg.micDevice ?? DEFAULTS.micDevice,
    speakerCmd: env.speakerCmd ?? fileCfg.speakerCmd ?? DEFAULTS.speakerCmd,
    voiceSystemPrompt:
      env.voiceSystemPrompt ??
      fileCfg.voiceSystemPrompt ??
      DEFAULTS.voiceSystemPrompt,
    vadEnabled:
      env.vadEnabled ?? fileCfg.vadEnabled ?? DEFAULTS.vadEnabled,
    vadSampleRate:
      env.vadSampleRate ?? fileCfg.vadSampleRate ?? DEFAULTS.vadSampleRate,
    vadSilenceMs:
      env.vadSilenceMs ?? fileCfg.vadSilenceMs ?? DEFAULTS.vadSilenceMs,
    vadMinSpeechMs:
      env.vadMinSpeechMs ?? fileCfg.vadMinSpeechMs ?? DEFAULTS.vadMinSpeechMs,
    vadMaxRecordingMs:
      env.vadMaxRecordingMs ?? fileCfg.vadMaxRecordingMs ?? DEFAULTS.vadMaxRecordingMs,
    voiceShortcut:
      env.voiceShortcut ?? fileCfg.voiceShortcut ?? DEFAULTS.voiceShortcut,
    cancelShortcut:
      env.cancelShortcut ?? fileCfg.cancelShortcut ?? DEFAULTS.cancelShortcut,
    // Honor legacy ttsStreamSentences key in saved omni.json so an existing
    // user config still resolves correctly post-rename.
    ttsChunkSentences:
      env.ttsChunkSentences ??
      fileCfg.ttsChunkSentences ??
      (fileCfg as { ttsStreamSentences?: boolean }).ttsStreamSentences ??
      DEFAULTS.ttsChunkSentences,
    ttsStreamAudio:
      env.ttsStreamAudio ?? fileCfg.ttsStreamAudio ?? DEFAULTS.ttsStreamAudio,
    ttsInterSentenceGapMs:
      env.ttsInterSentenceGapMs ??
      fileCfg.ttsInterSentenceGapMs ??
      DEFAULTS.ttsInterSentenceGapMs,
    aecEnabled:
      env.aecEnabled ?? fileCfg.aecEnabled ?? DEFAULTS.aecEnabled,
    aecPlaybackDelayMs:
      env.aecPlaybackDelayMs ??
      fileCfg.aecPlaybackDelayMs ??
      DEFAULTS.aecPlaybackDelayMs,
    bargeInEnabled:
      env.bargeInEnabled ?? fileCfg.bargeInEnabled ?? DEFAULTS.bargeInEnabled,
    bargeInMinSpeechMs:
      env.bargeInMinSpeechMs ??
      fileCfg.bargeInMinSpeechMs ??
      DEFAULTS.bargeInMinSpeechMs,
    bargeInGuardMs:
      env.bargeInGuardMs ?? fileCfg.bargeInGuardMs ?? DEFAULTS.bargeInGuardMs,
    webHost: env.webHost ?? fileCfg.webHost ?? DEFAULTS.webHost,
    webPort: env.webPort ?? fileCfg.webPort ?? DEFAULTS.webPort,
    autoStartWeb:
      env.autoStartWeb ?? fileCfg.autoStartWeb ?? DEFAULTS.autoStartWeb,
    autoStartLive:
      env.autoStartLive ?? fileCfg.autoStartLive ?? DEFAULTS.autoStartLive,
    webAutoStart:
      env.webAutoStart ?? fileCfg.webAutoStart ?? DEFAULTS.webAutoStart,
    orbGlyph: env.orbGlyph ?? fileCfg.orbGlyph ?? DEFAULTS.orbGlyph,
  };

  return { cfg, fromFile };
}

function numOrUndef(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function boolOrUndef(v: string | undefined): boolean | undefined {
  if (v == null || v === "") return undefined;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export async function saveConfig(cfg: VoiceConfig): Promise<void> {
  await fs.mkdir(dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
