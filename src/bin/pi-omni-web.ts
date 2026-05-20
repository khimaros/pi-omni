#!/usr/bin/env node
// Standalone pi-omni web server. Boots the same HTTP/WS server the /omni-web
// command launches inside pi, but instead of talking to an extension API it
// spawns a pi-coding-agent session directly — same approach as pi-webui — so
// the LLM, tools, and any installed pi extensions (pi-evolve, etc.) are all
// in the loop. The OpenAI-compatible endpoint from cfg is still used for STT
// and TTS only.

import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";
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

  // Each browser session gets its own pi runtime/session: hitting refresh
  // (or opening a second tab) yields a clean conversation, not a shared one.
  // Trade-off: extensions re-init per connection — slower first-utterance
  // latency, but the only correct behavior when multiple users / tabs hit
  // the same server.
  function findSessionFile(sessionId: string, dir: string): string | undefined {
    try {
      const files = readdirSync(dir);
      const suffix = `_${sessionId}.jsonl`;
      const found = files.find((f) => f.endsWith(suffix));
      if (found) {
        return join(dir, found);
      }
    } catch {}
    return undefined;
  }

  const createPiSessionForConnection = async (
    connLog: (m: string, l?: "info" | "warning" | "error") => void,
    requestedSessionId?: string,
  ) => {
    const defaultMgr = SessionManager.create(cwd, sessionDir);
    const resolvedSessionDir = defaultMgr.getSessionDir();

    let activeMgr = defaultMgr;
    if (requestedSessionId) {
      const file = findSessionFile(requestedSessionId, resolvedSessionDir);
      if (file) {
        connLog(`resuming existing pi session: ${requestedSessionId}`);
        activeMgr = SessionManager.open(file, sessionDir);
      } else {
        connLog(`requested session ${requestedSessionId} not found, starting new`);
      }
    }

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
        sessionManager: activeMgr,
      },
    );
    const session = runtime.session;
    await session.bindExtensions({});
    connLog(
      `pi session ready: ${session.model ? `${session.model.provider}/${session.model.id}` : "(no model)"}`,
    );

    // Append the voice system prompt LAST, after every other extension has
    // had a chance to mutate it. Mutating _baseSystemPrompt directly doesn't
    // work because earlier-loaded extensions (pi-evolve, etc.) implement
    // before_agent_start by REPLACING event.systemPrompt with their own
    // merged value — dropping anything we'd appended to the base. We wrap
    // _extensionRunner.emitBeforeAgentStart so our append runs after the
    // full handler chain. See pi-evolve/src/extension/index.ts for the
    // standard before_agent_start "append to event.systemPrompt" pattern.
    const voicePrompt = cfg.voiceSystemPrompt?.trim();
    if (voicePrompt) {
      const runner = (session as unknown as {
        _extensionRunner: {
          emitBeforeAgentStart: (
            prompt: string,
            images: unknown,
            systemPrompt: string,
            opts: unknown,
          ) => Promise<
            { messages?: unknown[]; systemPrompt?: string } | undefined
          >;
        };
      })._extensionRunner;
      const orig = runner.emitBeforeAgentStart.bind(runner);
      runner.emitBeforeAgentStart = async (prompt, images, systemPrompt, opts) => {
        const result = await orig(prompt, images, systemPrompt, opts);
        const base = result?.systemPrompt ?? systemPrompt;
        return {
          messages: result?.messages,
          systemPrompt: `${base}\n\n${voicePrompt}`,
        };
      };
      connLog(`will append voice system prompt (${voicePrompt.length} chars) after extensions`);
    }

    try {
      const active = (session as any).getActiveToolNames?.() ?? [];
      const all = (session as any).getAllTools?.() ?? [];
      connLog(`tools active=${active.length} total=${all.length}: ${active.join(", ") || "(none)"}`);
    } catch (e) {
      connLog(`could not list tools: ${(e as Error).message}`, "warning");
    }
    const diag = (runtime as any).diagnostics ?? [];
    if (Array.isArray(diag) && diag.length > 0) {
      for (const d of diag) {
        const type = d?.type ?? "info";
        const lvl: "info" | "warning" | "error" =
          type === "error" ? "error" : type === "warning" ? "warning" : "info";
        connLog(`diag(${type}): ${d?.message ?? JSON.stringify(d)} ${d?.path ?? ""}`, lvl);
      }
    }
    return { runtime, session, sessionManager: activeMgr };
  };

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

  // Split an assistant message into its text answer and the bracket-tagged
  // structural parts (thinking, toolCall, ...). The two are logged on
  // separate lines so it's obvious whether the model produced a
  // user-visible answer at all, vs. only reasoning / tool calls.
  const splitAssistantContent = (
    content: unknown,
  ): { answer: string; structure: string } => {
    if (typeof content === "string") return { answer: content, structure: "" };
    if (!Array.isArray(content)) {
      return { answer: "", structure: JSON.stringify(content) };
    }
    const answerParts: string[] = [];
    const structureParts: string[] = [];
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      const t = (p as { type?: string }).type;
      if (t === "text" && typeof (p as { text?: unknown }).text === "string") {
        answerParts.push((p as { text: string }).text);
      } else {
        structureParts.push(`[${t ?? "part"}]`);
      }
    }
    return { answer: answerParts.join(""), structure: structureParts.join("") };
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

  // Track per-connection runtimes so shutdown can dispose them all.
  const liveRuntimes = new Set<{ dispose: () => Promise<void> }>();

  const server = await startWebServer({
    host,
    port,
    logger: log,
    makeSession: async (ws, logger, requestedSessionId) => {
      const { runtime, session, sessionManager } = await createPiSessionForConnection(logger, requestedSessionId);
      liveRuntimes.add(runtime);

      let webSession: WebSession | undefined;

      // Per-connection event fan-out: events from THIS pi session route to
      // THIS connection's WebSession only. The transcript log captures
      // everything else (messages, tools).
      const unsubscribe = session.subscribe((event: any) => {
        const ws = webSession;
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
                ws?.onComponent({ kind: "thinking" });
                return;
              case "toolcall_end":
                logEvent("toolcall", ame.toolCall);
                ws?.onComponent({
                  kind: "tool_call",
                  name: (ame.toolCall as { name?: string } | undefined)?.name,
                });
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
              const { answer, structure } = splitAssistantContent(msg.content);
              if (structure) logEvent("assistant_structure", structure);
              if (answer) logEvent("assistant_answer", answer);
              else logEvent("assistant_answer", "<empty — no text block produced>");
            } else if (msg?.role === "tool" || msg?.role === "toolResult") {
              logEvent("tool_result", {
                toolCallId: msg.toolCallId,
                content: stringifyContent(msg.content),
              });
            }
            return;
          }
          case "tool_execution_start":
            logEvent("tool_call", { tool: event.toolName, args: event.args });
            return;
          case "tool_execution_end":
            logEvent("tool_end", {
              tool: event.toolName,
              isError: event.isError,
              result: event.result,
            });
            webSession?.onComponent({
              kind: "tool_result",
              name: typeof event.toolName === "string" ? event.toolName : undefined,
              ok: !event.isError,
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
          if (session.isStreaming) {
            logger("aborting in-flight turn for new voice prompt");
            await session.abort();
          }
          webSession?.rearmTurn();
          await session.prompt(text);
        } catch (e) {
          logger(`session.prompt error: ${(e as Error).message}`, "error");
          webSession?.onAgentEnd();
        }
      };

      let lastUserText: string | undefined;
      let lastAssistantText: string | undefined;
      try {
        const context = sessionManager.buildSessionContext();
        const messages = context.messages ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role === "user" && !lastUserText) {
            lastUserText = stringifyContent(m.content);
          } else if (m.role === "assistant" && !lastAssistantText) {
            lastAssistantText = splitAssistantContent(m.content).answer;
          }
          if (lastUserText && lastAssistantText) break;
        }
      } catch (e) {
        logger(`failed to extract session history: ${(e as Error).message}`, "warning");
      }

      webSession = new WebSession(
        ws,
        {
          cfg,
          client: sttTtsClient,
          sendUserMessage: (text) => {
            void sendUserMessage(text);
          },
          // onActivate/onDeactivate are no-ops now that each connection owns
          // its own pi session — there's no shared active-session to track.
          onActivate: () => {},
          onDeactivate: () => {},
          logger,
          history: { lastUserText, lastAssistantText },
        },
        sessionManager.getSessionId(),
      );

      // Wrap dispose so closing the WS also tears down this connection's
      // pi runtime. Without this, every refresh would leak a session.
      const origDispose = webSession.dispose.bind(webSession);
      webSession.dispose = () => {
        try {
          unsubscribe();
        } catch {}
        origDispose();
        liveRuntimes.delete(runtime);
        void runtime.dispose().catch((e) => {
          logger(`runtime.dispose error: ${(e as Error).message}`, "warning");
        });
      };

      return webSession;
    },
  });

  log(`serving at ${server.url}`);

  const shutdown = (): void => {
    void (async () => {
      try {
        await server.close();
      } catch {}
      for (const r of liveRuntimes) {
        try {
          await r.dispose();
        } catch {}
      }
      liveRuntimes.clear();
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
