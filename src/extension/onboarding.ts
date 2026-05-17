import OpenAI from "openai";
import { spawn } from "node:child_process";
import { Mic } from "../audio/mic.js";
import { wrapPcmAsWav } from "../audio/wav.js";
import { transcribe } from "../audio/stt.js";
import { TtsPlayer } from "../audio/tts.js";
import { saveConfig, CONFIG_PATH } from "../config.js";
import type { VoiceConfig } from "../audio/loop.js";

// Loose duck-type — matches the ExtensionContext.ui surface documented in the
// pi extension docs. Cast at the boundary.
type Ui = {
  input: (prompt: string, placeholder?: string) => Promise<string | undefined>;
  select: (prompt: string, options: string[]) => Promise<string | undefined>;
  confirm: (
    title: string,
    message: string,
    options?: { timeout?: number },
  ) => Promise<boolean>;
  notify: (msg: string, level?: "info" | "warning" | "error") => void;
  setStatus?: (id: string, text: string) => void;
};

const CUSTOM = "(enter custom…)";
const DEFAULT_DEVICE = "(default)";

type Ctx = { ui: Ui };

// Show current value in the prompt; empty submit keeps the current value.
async function askInput(
  ui: Ui,
  label: string,
  current: string,
): Promise<string> {
  const shown = current === "" ? "(empty)" : current;
  const r = await ui.input(
    `${label} [current: ${shown}] (leave empty to keep)`,
    current,
  );
  if (r === undefined) return current;
  const trimmed = r.trim();
  return trimmed === "" ? current : trimmed;
}

export async function runOnboarding(
  ctx: Ctx,
  current: VoiceConfig,
): Promise<VoiceConfig | undefined> {
  const ui = ctx.ui;
  ui.notify("voice setup: configuring pi-omni…", "info");

  // 1. Endpoint
  const baseURL = await askInput(ui, "OpenAI-compatible base URL", current.baseURL);
  const apiKey = await askInput(ui, "API key (sk-no-key if unused)", current.apiKey);

  const client = new OpenAI({ baseURL, apiKey });

  // 2. Health check + model list
  let models: string[] = [];
  try {
    const list = await client.models.list();
    models = list.data.map((m) => m.id).sort();
    ui.notify(`endpoint OK — ${models.length} models available`, "info");
  } catch (e) {
    const cont = await ui.confirm(
      "endpoint unreachable",
      `Could not list /v1/models at ${baseURL} (${(e as Error).message}). Continue anyway?`,
    );
    if (!cont) return undefined;
  }

  // 3. Model picks
  const sttModel = await pickOrInput(
    ui,
    "STT model",
    models,
    current.sttModel,
  );
  const ttsModel = await pickOrInput(
    ui,
    "TTS model",
    models,
    current.ttsModel,
  );
  // Try to enumerate voices for the chosen model; fall back to free-text if
  // the endpoint doesn't support /audio/voices in any of the rhai's three forms.
  let voiceOptions: string[] = [];
  try {
    voiceOptions = await fetchVoices(baseURL, apiKey, ttsModel);
    if (voiceOptions.length) {
      ui.notify(`found ${voiceOptions.length} voices for ${ttsModel}`, "info");
    }
  } catch (e) {
    ui.notify(`voice list fetch failed: ${(e as Error).message}`, "warning");
  }
  const ttsVoice = await pickOrInput(
    ui,
    "TTS voice",
    voiceOptions,
    current.ttsVoice,
  );
  const sampleRateStr = await askInput(
    ui,
    "TTS sample rate (Hz, must match speaker -r)",
    String(current.ttsSampleRate),
  );
  const ttsSampleRate = Number(sampleRateStr) || current.ttsSampleRate;
  const batchStr = await askInput(
    ui,
    "TTS stream batch size (smaller = lower latency, more events)",
    String(current.ttsStreamBatchSize),
  );
  const ttsStreamBatchSize = Number(batchStr) || current.ttsStreamBatchSize;

  // Optional /audio/speech params (mirrored from the rhai openai_tts node).
  // Empty string clears the override; only sent on the wire when defined.
  const speedStr = await askInput(
    ui,
    "TTS speed (0.25-4.0; empty = engine default)",
    current.ttsSpeed != null ? String(current.ttsSpeed) : "",
  );
  const ttsSpeed = parseOptionalNumber(speedStr);
  const ttsInstructions = askOptionalText(
    await askInput(
      ui,
      "TTS instructions / style guidance (empty = none)",
      current.ttsInstructions ?? "",
    ),
  );
  const ttsLanguage = askOptionalText(
    await askInput(
      ui,
      "TTS language code, e.g. 'en' (empty = auto-detect)",
      current.ttsLanguage ?? "",
    ),
  );

  // 4. Audio devices
  const micDevice = await pickMicDevice(ui, current.micDevice);
  const speakerCmd = await askInput(
    ui,
    `Speaker command (reads raw S16_LE mono PCM at ${ttsSampleRate}Hz on stdin)`,
    current.speakerCmd,
  );

  const voiceSystemPrompt = await askInput(
    ui,
    "Voice-mode system prompt (instructs LLM that output will be spoken)",
    current.voiceSystemPrompt,
  );

  // Echo cancellation & barge-in (opt-in)
  const aecEnabled = await ui.confirm(
    "Enable acoustic echo cancellation?",
    "Runs WebRTC AEC3 (WASM) on the mic so the bot doesn't hear its own voice. Required for reliable barge-in on speakers.",
  );
  let aecPlaybackDelayMs = current.aecPlaybackDelayMs;
  if (aecEnabled) {
    const dStr = await askInput(
      ui,
      "Estimated speaker→mic round-trip delay in ms (100-300 typical)",
      String(current.aecPlaybackDelayMs),
    );
    aecPlaybackDelayMs = Number(dStr) || current.aecPlaybackDelayMs;
  }
  const bargeInEnabled = await ui.confirm(
    "Enable barge-in?",
    aecEnabled
      ? "Mic stays open during TTS playback so you can interrupt the bot by speaking."
      : "WARNING: without AEC enabled, the bot will interrupt itself unless you use headphones.",
  );

  const cfg: VoiceConfig = {
    baseURL,
    apiKey,
    sttModel,
    ttsModel,
    ttsVoice,
    ttsSampleRate,
    ttsStreamBatchSize,
    ttsSpeed,
    ttsInstructions,
    ttsLanguage,
    micDevice,
    speakerCmd,
    voiceSystemPrompt,
    vadEnabled: current.vadEnabled,
    vadSampleRate: current.vadSampleRate,
    vadSilenceMs: current.vadSilenceMs,
    vadMinSpeechMs: current.vadMinSpeechMs,
    vadMaxRecordingMs: current.vadMaxRecordingMs,
    voiceShortcut: current.voiceShortcut,
    cancelShortcut: current.cancelShortcut,
    ttsStreamSentences: current.ttsStreamSentences,
    aecEnabled,
    aecPlaybackDelayMs,
    bargeInEnabled,
    bargeInMinSpeechMs: current.bargeInMinSpeechMs,
    bargeInGuardMs: current.bargeInGuardMs,
    webHost: current.webHost,
    webPort: current.webPort,
    autoStartWeb: current.autoStartWeb,
    autoStartLive: current.autoStartLive,
    webAutoStart: current.webAutoStart,
    orbGlyph: current.orbGlyph,
  };

  // 5. Round-trip tests (skippable)
  const doTests = await ui.confirm(
    "test round-trip?",
    "Record a short clip, transcribe it, then synthesize a confirmation phrase.",
  );
  if (doTests) {
    const ok = await testRoundTrip(ui, cfg);
    if (!ok) {
      const save = await ui.confirm(
        "tests failed",
        "Save this config anyway? (You can re-run /omni-setup later.)",
      );
      if (!save) return undefined;
    }
  }

  // 6. Persist
  await saveConfig(cfg);
  ui.notify(`saved to ${CONFIG_PATH}`, "info");
  return cfg;
}

async function pickOrInput(
  ui: Ui,
  label: string,
  models: string[],
  current: string,
): Promise<string> {
  if (models.length === 0) {
    return askInput(ui, label, current);
  }
  const keep = `(keep current: ${current || "(empty)"})`;
  const opts = [
    keep,
    ...models.filter((m) => m !== current),
    CUSTOM,
  ];
  const picked = await ui.select(`${label} [current: ${current || "(empty)"}]`, opts);
  if (picked === undefined || picked === keep) return current;
  if (picked === CUSTOM) return askInput(ui, label, current);
  return picked;
}

async function pickMicDevice(
  ui: Ui,
  current: string | undefined,
): Promise<string | undefined> {
  const cur = current ?? "";
  const devices = await listAlsaCaptureDevices();
  if (devices.length === 0) {
    const v = await askInput(
      ui,
      "Mic device (ALSA, empty = system default)",
      cur,
    );
    return v ? v : undefined;
  }
  const keep = `(keep current: ${cur || "(default)"})`;
  const opts = [keep, DEFAULT_DEVICE, ...devices, CUSTOM];
  const picked = await ui.select(
    `Mic device [current: ${cur || "(default)"}]`,
    opts,
  );
  if (picked === undefined || picked === keep) return current;
  if (picked === DEFAULT_DEVICE) return undefined;
  if (picked === CUSTOM) {
    const v = await askInput(ui, "Mic device", cur);
    return v ? v : undefined;
  }
  return picked;
}

function listAlsaCaptureDevices(): Promise<string[]> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const p = spawn("arecord", ["-l"], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.on("close", () => {
      const text = Buffer.concat(out).toString("utf8");
      const devs: string[] = [];
      for (const line of text.split("\n")) {
        // "card 1: USB [USB Audio], device 0: USB Audio [USB Audio]"
        const m = line.match(/^card (\d+):[^,]+,\s*device (\d+):/);
        if (m) devs.push(`hw:${m[1]},${m[2]}`);
      }
      resolve(devs);
    });
    p.on("error", () => resolve([]));
  });
}

async function testRoundTrip(ui: Ui, cfg: VoiceConfig): Promise<boolean> {
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });

  // mic + STT
  const mic = new Mic({ device: cfg.micDevice, sampleRate: cfg.vadSampleRate });
  await ui.confirm(
    "mic test",
    "Press OK, then say a short phrase. Recording will run for ~3 seconds.",
  );
  mic.start();
  await sleep(3000);
  const pcm = await mic.stop();
  const wav = wrapPcmAsWav(pcm, cfg.vadSampleRate);
  let text = "";
  try {
    text = (await transcribe(client, wav, cfg.sttModel)).trim();
  } catch (e) {
    ui.notify(`STT failed: ${(e as Error).message}`, "error");
    return false;
  }
  if (!text) {
    ui.notify("STT returned empty — check mic + model", "warning");
    return false;
  }
  const heard = await ui.confirm(
    "STT result",
    `Transcribed: "${text}"\n\nIs that roughly what you said?`,
  );
  if (!heard) return false;

  // TTS — streaming PCM over SSE; diag covers bytes, sse events, ttfb, player.
  const tts = new TtsPlayer({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.ttsModel,
    voice: cfg.ttsVoice,
    sampleRate: cfg.ttsSampleRate,
    streamBatchSize: cfg.ttsStreamBatchSize,
    speakerCmd: cfg.speakerCmd,
  });
  let diag;
  try {
    diag = await tts.speakOnce("Voice mode is ready.");
  } catch (e) {
    ui.notify(`TTS synth failed: ${(e as Error).message}`, "error");
    return false;
  }
  const summary = formatDiag(diag);
  ui.notify(`TTS: ${summary}`, "info");
  const playedOk = await ui.confirm(
    "TTS test",
    `Did you hear "Voice mode is ready."?\n\n${summary}`,
  );
  return playedOk;
}

function formatDiag(d: {
  bytes: number;
  contentType?: string;
  events: number;
  ttfbMs?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError?: string;
  httpError?: string;
}): string {
  const ct = d.contentType ?? "?";
  const ttfb = d.ttfbMs != null ? `, ttfb=${d.ttfbMs}ms` : "";
  const http = d.httpError ? `, http: ${d.httpError}` : "";
  const player =
    d.spawnError != null
      ? `spawn err: ${d.spawnError}`
      : `player exit=${d.exitCode} sig=${d.signal ?? "-"}`;
  const tail = d.stderr ? ` — ${d.stderr.split("\n").slice(-2).join(" ").trim()}` : "";
  return `${d.bytes}B pcm, ${d.events} sse events, ${ct}${ttfb}, ${player}${tail}${http}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseOptionalNumber(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function askOptionalText(s: string): string | undefined {
  const t = s.trim();
  return t === "" ? undefined : t;
}

// Mirror flow/user_nodes/openai_tts.rhai's voice-discovery chain:
//   1. {api_base}/audio/voices?model={model}    (llama-swap requires the param)
//   2. {api_base}/audio/voices                  (servers that don't expect it)
//   3. {server_base}/upstream/{model}/v1/audio/voices  (bypasses llama-swap)
// Parses the same three response shapes (object with .voices/.items, map of
// model → string[], or bare string[]).
async function fetchVoices(
  baseURL: string,
  apiKey: string,
  model: string,
): Promise<string[]> {
  const apiBase = baseURL.replace(/\/+$/, "");
  const serverBase = apiBase.endsWith("/v1") ? apiBase.slice(0, -3) : apiBase;
  const headers: Record<string, string> = {};
  if (apiKey && apiKey !== "sk-no-key") headers.Authorization = `Bearer ${apiKey}`;

  const urls = [
    `${apiBase}/audio/voices?model=${encodeURIComponent(model)}`,
    `${apiBase}/audio/voices`,
    `${serverBase}/upstream/${encodeURIComponent(model)}/v1/audio/voices`,
  ];
  let body: unknown = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      body = await r.json();
      break;
    } catch {
      // try next
    }
  }
  if (body == null) return [];
  return parseVoiceList(body).sort();
}

function parseVoiceList(body: unknown): string[] {
  if (Array.isArray(body)) {
    return body.filter((v): v is string => typeof v === "string");
  }
  if (typeof body !== "object" || body == null) return [];
  const obj = body as Record<string, unknown>;
  // Shape 1: { voices: [...] } or { items: [...] } (paginated, e.g. Mistral).
  const arr = (Array.isArray(obj.voices) && obj.voices) ||
    (Array.isArray(obj.items) && obj.items);
  if (arr) {
    const out: string[] = [];
    for (const v of arr) {
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const id = (o.id ?? o.voice_id ?? o.name) as string | undefined;
        if (typeof id === "string") out.push(id);
      }
    }
    return out;
  }
  // Shape 2: { ModelName: ["voice1", ...], ... }
  const out: string[] = [];
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const x of v) if (typeof x === "string") out.push(x);
    }
  }
  return out;
}
