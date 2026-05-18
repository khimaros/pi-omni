#!/usr/bin/env node
// Standalone pi-omni web server. Boots the same HTTP/WS server the /omni-web
// command launches inside pi, but instead of talking to an extension API it
// spawns a pi-coding-agent session directly — same approach as pi-webui — so
// the LLM, tools, and any installed pi extensions (pi-evolve, etc.) are all
// in the loop. The OpenAI-compatible endpoint from cfg is still used for STT
// and TTS only.

import { resolve } from "node:path";
import OpenAI from "openai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { startWebServer } from "../server/index.js";
import { WebSession } from "../server/session.js";

type Args = { host?: string; port?: number; help?: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--listen") {
      const v = argv[++i] ?? "";
      const m = v.match(/^(?:\[([^\]]+)\]|([^:]+))?:?(\d+)?$/);
      if (m) {
        out.host = m[1] || m[2] || undefined;
        if (m[3]) out.port = Number(m[3]);
      }
    }
  }
  return out;
}

const HELP = `pi-omni-web — standalone web server for pi-omni

Usage: pi-omni-web [--listen <host:port>]

Reads config from ~/.pi/extensions/omni.json and env vars (PI_VOICE_*).
LLM/tools are handled by pi-coding-agent (and any installed extensions);
the OpenAI-compatible endpoint is used only for STT and TTS.
`;

// Mirrors pi-webui's selection: honor the user's /scoped-models setting when
// resolving which models the session may use.
function resolveScopedModelsFromSettings(services: any): Array<{ model: any }> {
  const patterns = services.settingsManager.getEnabledModels?.();
  if (!patterns || patterns.length === 0) return [];
  const available = services.modelRegistry.getAvailable();
  const matched: Array<{ model: any }> = [];
  for (const pattern of patterns) {
    const found = available.find(
      (m: any) => `${m.provider}/${m.id}` === pattern || m.id === pattern,
    );
    if (found && !matched.find((sm) => sm.model === found)) {
      matched.push({ model: found });
    }
  }
  return matched;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const { cfg } = await loadConfig();
  const host = args.host || process.env.PI_VOICE_WEB_HOST || cfg.webHost || "127.0.0.1";
  const port =
    args.port || Number(process.env.PI_VOICE_WEB_PORT) || cfg.webPort || 4962;

  const log = (m: string, l?: "info" | "warning" | "error"): void => {
    process.stderr.write(`[pi-omni-web] ${l ?? "info"}: ${m}\n`);
  };

  const cwd = process.env.PI_PROJECT_CWD
    ? resolve(process.env.PI_PROJECT_CWD)
    : process.cwd();
  const agentDir = process.env.PI_AGENT_DIR || getAgentDir();
  const sessionDir = process.env.PI_SESSION_DIR;

  // STT/TTS endpoint client — LLM is handled by pi-coding-agent below.
  const sttTtsClient = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });

  const runtime = await createAgentSessionRuntime(
    async ({ cwd, sessionManager, sessionStartEvent }: any) => {
      const services = await createAgentSessionServices({ cwd, agentDir });
      const scopedModels = resolveScopedModelsFromSettings(services);
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          scopedModels,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    },
    {
      cwd,
      agentDir,
      sessionManager: SessionManager.create(cwd, sessionDir),
    },
  );
  const session = runtime.session;
  await session.bindExtensions({});
  log(
    `pi session ready: ${session.model ? `${session.model.provider}/${session.model.id}` : "(no model)"}`,
  );

  // Append the voice system prompt to the session's base system prompt so
  // every turn carries it implicitly — instead of prepending it as a fake
  // user message before each utterance. agent-session resets state.systemPrompt
  // to _baseSystemPrompt at the start of every prompt() (see agent-session.js
  // ~line 797), so we mutate the base directly. The session has no public
  // setter for this; pi-coding-agent's documented path is a before_agent_start
  // extension, which standalone pi-omni-web doesn't have machinery for.
  const voicePrompt = cfg.voiceSystemPrompt?.trim();
  if (voicePrompt) {
    const s = session as unknown as {
      _baseSystemPrompt: string;
      agent: { state: { systemPrompt: string } };
    };
    s._baseSystemPrompt = `${s._baseSystemPrompt}\n\n${voicePrompt}`;
    s.agent.state.systemPrompt = s._baseSystemPrompt;
    log(`appended voice system prompt (${voicePrompt.length} chars)`);
  }

  // Surface what tools the session actually has and any extension/resource
  // load errors — silent extension failures are the #1 reason tool calls
  // mysteriously do nothing.
  try {
    const active = (session as any).getActiveToolNames?.() ?? [];
    const all = (session as any).getAllTools?.() ?? [];
    log(`tools active=${active.length} total=${all.length}: ${active.join(", ") || "(none)"}`);
  } catch (e) {
    log(`could not list tools: ${(e as Error).message}`, "warning");
  }
  const diag = (runtime as any).diagnostics ?? [];
  if (Array.isArray(diag) && diag.length > 0) {
    for (const d of diag) {
      const type = d?.type ?? "info";
      const lvl: "info" | "warning" | "error" =
        type === "error" ? "error" : type === "warning" ? "warning" : "info";
      log(`diag(${type}): ${d?.message ?? JSON.stringify(d)} ${d?.path ?? ""}`, lvl);
    }
  }

  let activeSession: WebSession | undefined;

  // Transcript logging — every prompt, tool call, and assistant reply is
  // logged to stderr so journalctl shows the full conversation. Disable with
  // PI_OMNI_WEB_LOG_TRANSCRIPT=0 if you want quieter logs.
  const logTranscript = process.env.PI_OMNI_WEB_LOG_TRANSCRIPT !== "0";

  // Extract a readable text payload from a content array | string. Falls back
  // to JSON for non-text parts (images, etc.) so we never silently drop info.
  const stringifyContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    const parts: string[] = [];
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      const t = (p as { type?: string }).type;
      if (t === "text" && typeof (p as { text?: unknown }).text === "string") {
        parts.push((p as { text: string }).text);
      } else {
        parts.push(`[${t ?? "part"}]`);
      }
    }
    return parts.join("");
  };

  const logEvent = (kind: string, payload: unknown): void => {
    if (!logTranscript) return;
    let body: string;
    try {
      body = typeof payload === "string" ? payload : JSON.stringify(payload);
    } catch {
      body = String(payload);
    }
    process.stderr.write(`[pi-omni-web] transcript ${kind}: ${body}\n`);
  };

  // Fan pi session events out to the active WebSession and the transcript log.
  // The WebSession path only needs deltas + turn end + agent end (mirrors the
  // in-pi extension); the log path captures everything else (messages, tools).
  session.subscribe((event: any) => {
    const ws = activeSession;
    switch (event?.type) {
      case "message_start": {
        const msg = event.message;
        const role = msg?.role;
        if (role === "user") {
          logEvent("user", stringifyContent(msg.content));
        }
        return;
      }
      case "message_update": {
        const ame = event?.assistantMessageEvent;
        if (!ame) return;
        switch (ame.type) {
          case "text_delta":
            if (typeof ame.delta === "string") ws?.onLlmDelta(ame.delta);
            return;
          case "thinking_end":
            if (typeof ame.content === "string") logEvent("thinking", ame.content);
            return;
          case "toolcall_end":
            logEvent("toolcall", ame.toolCall);
            return;
          case "error":
            logEvent("ame_error", { reason: ame.reason, error: ame.error });
            return;
        }
        return;
      }
      case "message_end": {
        const msg = event.message;
        if (msg?.role === "assistant") {
          logEvent("assistant", stringifyContent(msg.content));
        } else if (msg?.role === "tool" || msg?.role === "toolResult") {
          logEvent("tool_result", {
            toolCallId: msg.toolCallId,
            content: stringifyContent(msg.content),
          });
        }
        return;
      }
      case "tool_execution_start":
        logEvent("tool_call", {
          tool: event.toolName,
          args: event.args,
        });
        return;
      case "tool_execution_end":
        logEvent("tool_end", {
          tool: event.toolName,
          isError: event.isError,
          result: event.result,
        });
        return;
      case "turn_end":
        ws?.onTurnEnd(event);
        return;
      case "agent_end":
        ws?.onAgentEnd();
        return;
    }
  });

  const sendUserMessage = async (text: string): Promise<void> => {
    logEvent("submit", text);
    try {
      // Voice is push-to-talk: if the user speaks again while the agent is
      // still streaming the previous turn, hard-cancel the in-flight model
      // call (abort waits for idle) and then send the new prompt fresh.
      // steer() would only queue a soft interjection without aborting.
      if (session.isStreaming) {
        log("aborting in-flight turn for new voice prompt");
        await session.abort();
      }
      await session.prompt(text);
    } catch (e) {
      log(`session.prompt error: ${(e as Error).message}`, "error");
      activeSession?.onAgentEnd();
    }
  };

  const server = await startWebServer({
    host,
    port,
    logger: log,
    makeSession: (ws, logger) => {
      if (activeSession) {
        try {
          activeSession.dispose();
        } catch {}
      }
      return new WebSession(ws, {
        cfg,
        client: sttTtsClient,
        sendUserMessage: (text) => {
          void sendUserMessage(text);
        },
        onActivate: (s) => {
          activeSession = s;
        },
        onDeactivate: (s) => {
          if (activeSession === s) activeSession = undefined;
        },
        logger,
      });
    },
  });

  log(`serving at ${server.url}`);

  const shutdown = (): void => {
    void (async () => {
      try {
        await server.close();
      } catch {}
      try {
        await runtime.dispose();
      } catch {}
      process.exit(0);
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main().catch((e) => {
  process.stderr.write(`[pi-omni-web] fatal: ${(e as Error).stack || e}\n`);
  process.exit(1);
});
