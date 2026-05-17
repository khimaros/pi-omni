import { exec } from "node:child_process";
import OpenAI from "openai";
import { VoiceLoop } from "../audio/loop.js";
import { loadConfig } from "../config.js";
import { runOnboarding } from "./onboarding.js";
import { startWebServer, type RunningServer } from "../server/index.js";
import { WebSession } from "../server/session.js";

type AnyExtensionAPI = {
  on: (event: string, handler: (...args: unknown[]) => unknown) => void;
  registerCommand: (
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void> | void;
    },
  ) => void;
  registerShortcut?: (
    shortcut: string,
    options: {
      description?: string;
      handler: (...args: unknown[]) => Promise<void> | void;
    },
  ) => void;
  registerFlag?: (
    name: string,
    options: {
      description: string;
      type: "boolean" | "string" | "number";
      default?: unknown;
    },
  ) => void;
  getFlag?: (name: string) => unknown;
  sendUserMessage: (content: string, options?: unknown) => unknown;
};

type CmdCtx = {
  ui: {
    notify: (m: string, l?: string) => void;
    setStatus: (id: string, t: string) => void;
    input: (p: string, ph?: string) => Promise<string | undefined>;
    select: (p: string, o: string[]) => Promise<string | undefined>;
    confirm: (
      t: string,
      m: string,
      o?: { timeout?: number },
    ) => Promise<boolean>;
  };
};

// CmdCtx used when an action is triggered from a CLI flag rather than a
// user-invoked command. UI prompts no-op; notify writes to stderr.
function makeStubCtx(): CmdCtx {
  return {
    ui: {
      notify: (m, l) => process.stderr.write(`[pi-omni] ${l ?? "info"}: ${m}\n`),
      setStatus: () => {},
      input: async () => undefined,
      select: async () => undefined,
      confirm: async () => false,
    },
  };
}

export default async function (pi: AnyExtensionAPI): Promise<void> {
  // Flags — register early so pi sees them on the command line.
  pi.registerFlag?.("omni-live", {
    description: "Start /omni-live (continuous voice mode) on launch.",
    type: "boolean",
    default: false,
  });
  pi.registerFlag?.("omni-web", {
    description: "Start /omni-web server on launch (background HTTP/WS server).",
    type: "boolean",
    default: false,
  });

  let { cfg, fromFile } = await loadConfig();
  const makeLoop = () =>
    new VoiceLoop(pi, cfg, (msg, level) => {
      try {
        process.stderr.write(`[pi-omni] ${level ?? "info"}: ${msg}\n`);
      } catch {}
    });
  let loop = makeLoop();

  let webServer: RunningServer | undefined;
  let webSession: WebSession | undefined;

  const runOmni = async (ctx: CmdCtx) => {
    if (!fromFile) {
      ctx.ui.notify("omni: no saved config — running first-time setup", "info");
      const next = await runOnboarding(ctx, cfg);
      if (!next) {
        ctx.ui.notify("omni: setup cancelled", "warning");
        return;
      }
      cfg = next;
      fromFile = true;
      loop.dispose();
      loop = makeLoop();
    }
    await loop.toggle(ctx);
  };

  const runOmniLive = async (ctx: CmdCtx) => {
    if (!fromFile) {
      ctx.ui.notify("omni-live: no saved config — running setup first", "info");
      const next = await runOnboarding(ctx, cfg);
      if (!next) {
        ctx.ui.notify("omni-live: setup cancelled", "warning");
        return;
      }
      cfg = next;
      fromFile = true;
      loop.dispose();
      loop = makeLoop();
    }
    await loop.toggleChat(ctx);
  };

  const startWeb = async (notify: (m: string, l?: string) => void) => {
    if (webServer) {
      notify(`omni-web: already running at ${webServer.url}`, "info");
      return;
    }
    const host =
      process.env.PI_VOICE_WEB_HOST ||
      (cfg.webHost && cfg.webHost.length ? cfg.webHost : "127.0.0.1");
    const port = Number(process.env.PI_VOICE_WEB_PORT) || cfg.webPort || 8788;
    try {
      webServer = await startWebServer({
        host,
        port,
        logger: (m, l) =>
          process.stderr.write(`[pi-omni] web ${l ?? "info"}: ${m}\n`),
        makeSession: (ws, logger) => {
          if (webSession) {
            try {
              webSession.dispose();
            } catch {}
          }
          return new WebSession(ws, {
            cfg,
            client: new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey }),
            sendUserMessage: async (text) => {
              await pi.sendUserMessage(text, { deliverAs: "steer" });
            },
            onActivate: (s) => {
              webSession = s;
            },
            onDeactivate: (s) => {
              if (webSession === s) webSession = undefined;
            },
            logger,
          });
        },
      });
      notify(`omni-web: serving at ${webServer.url}`, "info");
    } catch (e) {
      notify(`omni-web: start failed — ${(e as Error).message}`, "error");
    }
  };

  const stopWeb = async (notify: (m: string, l?: string) => void) => {
    if (!webServer) {
      notify("omni-web: not running", "info");
      return;
    }
    try {
      await webServer.close();
    } catch {}
    webServer = undefined;
    webSession = undefined;
    notify("omni-web: stopped", "info");
  };

  pi.registerCommand("omni", {
    description:
      "Push-to-talk with VAD auto-stop: tap to start, VAD ends on silence (or re-tap to cancel).",
    handler: async (_args, rawCtx) => {
      await runOmni(rawCtx as CmdCtx);
    },
  });

  pi.registerCommand("omni-live", {
    description:
      "Continuous conversation mode: auto-loops record → STT → LLM → TTS → record. Run again or press the cancel key to stop.",
    handler: async (_args, rawCtx) => {
      await runOmniLive(rawCtx as CmdCtx);
    },
  });

  pi.registerCommand("omni-cancel", {
    description: "Cancel any active voice output / recording / chat mode.",
    handler: async (_args, rawCtx) => {
      loop.cancelOutput(rawCtx as CmdCtx);
    },
  });

  pi.registerCommand("omni-setup", {
    description: "Configure pi-omni: endpoint, models, mic + speaker.",
    handler: async (_args, rawCtx) => {
      const ctx = rawCtx as CmdCtx;
      const next = await runOnboarding(ctx, cfg);
      if (!next) {
        ctx.ui.notify("omni-setup: cancelled", "warning");
        return;
      }
      cfg = next;
      fromFile = true;
      loop.dispose();
      loop = makeLoop();
      ctx.ui.notify("omni-setup: applied", "info");
    },
  });

  const omniWebSubs: Array<{ name: string; label: string }> = [
    { name: "start", label: "start  - launch the server" },
    { name: "status", label: "status - check server status" },
    { name: "stop", label: "stop   - stop the server" },
    { name: "open", label: "open   - open in browser" },
  ];

  const openOmniWeb = (notify: (m: string, l?: string) => void): void => {
    if (!webServer) {
      notify("omni-web: not running. run /omni-web start first.", "error");
      return;
    }
    const url = webServer.url;
    const cmd =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;
    try {
      exec(cmd);
      notify(`omni-web: opening ${url}`, "info");
    } catch (e) {
      notify(`omni-web: open failed — ${(e as Error).message}`, "error");
    }
  };

  const statusOmniWeb = (notify: (m: string, l?: string) => void): void => {
    if (webServer) {
      notify(
        `omni-web: running at ${webServer.url}${webSession ? " (client connected)" : ""}`,
        "info",
      );
    } else {
      notify("omni-web: not running", "info");
    }
  };

  const dispatchOmniWeb = async (
    sub: string,
    notify: (m: string, l?: string) => void,
  ): Promise<boolean> => {
    switch (sub) {
      case "start":
        await startWeb(notify);
        return true;
      case "stop":
        await stopWeb(notify);
        return true;
      case "status":
        statusOmniWeb(notify);
        return true;
      case "open":
        openOmniWeb(notify);
        return true;
      default:
        return false;
    }
  };

  pi.registerCommand("omni-web", {
    description: "control the pi-omni web server",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as CmdCtx;
      const notify = (m: string, l?: string) => ctx.ui.notify(m, l);
      const sub = (args || "").trim().toLowerCase();
      if (!sub || sub === "help") {
        const labels = omniWebSubs.map((s) => s.label);
        const selected = await ctx.ui.select("pi-omni web", labels);
        if (!selected) return;
        const match = omniWebSubs.find((s) => s.label === selected);
        if (match) await dispatchOmniWeb(match.name, notify);
        return;
      }
      if (!(await dispatchOmniWeb(sub, notify))) {
        notify(`omni-web: unknown subcommand: ${sub}`, "error");
      }
    },
  });

  pi.registerCommand("omni-test", {
    description:
      "Synthesize a test phrase via TTS and report bytes/content-type/player exit. Optional arg = phrase to say.",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as CmdCtx;
      const phrase =
        (args && args.trim()) || "The quick brown fox jumps over the lazy dog.";
      try {
        const diag = await loop.ttsPlayer.speakOnce(phrase);
        const ct = diag.contentType ?? "?";
        const ttfb = diag.ttfbMs != null ? `, ttfb=${diag.ttfbMs}ms` : "";
        const httpErr = diag.httpError ? `, http: ${diag.httpError}` : "";
        const player = diag.spawnError
          ? `spawn err: ${diag.spawnError}`
          : `player exit=${diag.exitCode} sig=${diag.signal ?? "-"}`;
        const tail = diag.stderr
          ? ` — ${diag.stderr.split("\n").slice(-2).join(" ").trim()}`
          : "";
        ctx.ui.notify(
          `tts: ${diag.bytes}B pcm, ${diag.events} sse events, ${ct}${ttfb}, ${player}${tail}${httpErr}`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`tts: synth failed: ${(e as Error).message}`, "error");
      }
    },
  });

  // Keyboard shortcuts.
  const findCtx = (args: unknown[]): CmdCtx | undefined => {
    for (const a of args) {
      if (a && typeof a === "object" && "ui" in (a as object)) {
        return a as CmdCtx;
      }
    }
    return undefined;
  };
  const tryBind = (
    key: string,
    description: string,
    fn: (ctx: CmdCtx) => Promise<void> | void,
  ): void => {
    if (!key || !pi.registerShortcut) return;
    try {
      pi.registerShortcut(key, {
        description,
        handler: async (...args: unknown[]) => {
          const ctx = findCtx(args);
          if (!ctx) {
            process.stderr.write(
              `[pi-omni] shortcut "${key}" fired but no ctx received — skipping\n`,
            );
            return;
          }
          await fn(ctx);
        },
      });
    } catch (e) {
      process.stderr.write(
        `[pi-omni] failed to register shortcut "${key}": ${(e as Error).message}\n`,
      );
    }
  };
  tryBind(cfg.voiceShortcut, "Toggle pi-omni voice recording", runOmni);
  // cancelShortcut (default "esc") is intentionally NOT bound via
  // registerShortcut — that would swallow esc globally even when nothing's
  // in flight, blocking pi's built-in esc behaviors. Instead the VoiceLoop
  // installs a conditional onTerminalInput listener that only consumes esc
  // while a voice turn or chat mode is active.

  const bind = (rawCtx: unknown) => {
    if (rawCtx && typeof rawCtx === "object" && "ui" in (rawCtx as object)) {
      loop.bindCtx(rawCtx as CmdCtx);
    }
  };

  pi.on("before_agent_start", (event: unknown, ctx: unknown) => {
    bind(ctx);
    const inFlight = loop.voiceTurnInFlight || webSession?.voiceTurnInFlight;
    if (!inFlight) return undefined;
    const prompt =
      (webSession?.voiceTurnInFlight ? webSession.systemPrompt : undefined) ??
      loop.systemPrompt;
    if (!prompt) return undefined;
    const e = event as { systemPrompt?: string };
    const base = typeof e.systemPrompt === "string" ? e.systemPrompt : "";
    return {
      systemPrompt: base ? `${base}\n\n${prompt}` : prompt,
    };
  });

  pi.on("message_update", (event: unknown, ctx: unknown) => {
    bind(ctx);
    const e = event as {
      assistantMessageEvent?: { type?: string; delta?: string };
    };
    const ame = e?.assistantMessageEvent;
    if (ame?.type === "text_delta" && typeof ame.delta === "string") {
      loop.onLlmDelta(ame.delta);
      webSession?.onLlmDelta(ame.delta);
    }
  });

  pi.on("turn_end", (event: unknown, ctx: unknown) => {
    bind(ctx);
    loop.onTurnEnd(event);
    webSession?.onTurnEnd(event);
  });

  pi.on("agent_end", (_event: unknown, ctx: unknown) => {
    bind(ctx);
    loop.onAgentEnd();
    webSession?.onAgentEnd();
  });

  pi.on("session_shutdown", () => {
    loop.dispose();
    if (webServer) void webServer.close();
    webSession?.dispose();
  });

  // Flag- and config-driven auto-start. Defer one tick so pi has finished
  // parsing argv — getFlag() can return the default value if checked too early.
  // the ctx may be stale by then (e.g. inside a pi-webui-spawned session that
  // immediately switches sessions); flags are only meaningful for a top-level
  // pi invocation, so swallow the stale-ctx error.
  setImmediate(() => {
    const stubCtx = makeStubCtx();
    let wantWeb: boolean;
    let wantLive: boolean;
    try {
      wantWeb = !!pi.getFlag?.("omni-web") || cfg.autoStartWeb;
      wantLive = !!pi.getFlag?.("omni-live") || cfg.autoStartLive;
    } catch {
      return;
    }
    if (wantWeb) {
      process.stderr.write("[pi-omni] --omni-web: starting server\n");
      void startWeb(stubCtx.ui.notify);
    }
    if (wantLive) {
      if (!fromFile) {
        process.stderr.write(
          "[pi-omni] --omni-live: no saved config; run /omni-setup first\n",
        );
      } else {
        process.stderr.write("[pi-omni] --omni-live: starting continuous voice\n");
        void runOmniLive(stubCtx);
      }
    }
  });
}
