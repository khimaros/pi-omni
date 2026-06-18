import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { WebSession } from "./session.js";

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// At runtime we're under dist/server/, so browser assets are at <pkg>/public/.
const CLIENT_DIR = resolve(__dirname, "..", "..", "public");
const PKG_VERSION: string = require(resolve(__dirname, "..", "..", "package.json")).version;

// Ping each ws this often to keep idle connections alive through a long
// "thinking" turn -- mobile radios and intermediaries reap silent sockets
// well under a minute. Browsers auto-reply with a pong at the protocol
// level; a client that misses two consecutive pings is treated as dead.
const WS_HEARTBEAT_MS = 25_000;

// Resolve a dep's on-disk root by resolving its main entry and walking up to
// the nearest package.json. Avoids `<pkg>/package.json` import which is gated
// by some packages' `exports` field (e.g. onnxruntime-web). Works whether the
// dep is colocated (dev) or hoisted (global install).
function resolvePackageDir(spec: string): string {
  const mainPath = require.resolve(spec);
  let dir = dirname(mainPath);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json not found for ${spec}`);
    dir = parent;
  }
}

// Map URL path prefix → resolved on-disk subdirectory of the dep package.
const VENDOR_MAP: Array<{ prefix: string; baseDir: string }> = [
  {
    prefix: "/vendor/vad-web/",
    baseDir: resolve(resolvePackageDir("@ricky0123/vad-web"), "dist"),
  },
  {
    prefix: "/vendor/ort/",
    baseDir: resolve(resolvePackageDir("onnxruntime-web"), "dist"),
  },
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export type WebServerOptions = {
  host: string;
  port: number;
  // Factory invoked once per WS connection. The session takes ownership of
  // the socket; on close it should release any pi-side resources. May be
  // async -- bootstrap (e.g. spinning up a per-connection pi runtime) runs
  // before the WebSession is returned.
  makeSession: (
    ws: WebSocket,
    logger: (m: string, l?: string) => void,
    requestedSessionId?: string,
  ) => WebSession | Promise<WebSession>;
  logger: (m: string, l?: "info" | "warning" | "error") => void;
};

export type RunningServer = {
  http: Server;
  wss: WebSocketServer;
  url: string;
  close: () => Promise<void>;
};

export async function startWebServer(opts: WebServerOptions): Promise<RunningServer> {
  const sessions = new Map<string, WebSession>();

  // Surface where each vendor dep is being served from, and warn loudly if
  // the dir is missing -- the silent-fail mode is a disabled start button.
  for (const v of VENDOR_MAP) {
    const exists = await stat(v.baseDir).then((s) => s.isDirectory()).catch(() => false);
    if (exists) {
      opts.logger(`vendor ${v.prefix} → ${v.baseDir}`, "info");
    } else {
      opts.logger(
        `vendor ${v.prefix} → ${v.baseDir} (MISSING -- start button will stay disabled)`,
        "error",
      );
    }
  }

  const http = createServer((req, res) => {
    void handleHttp(req, res, (m, l) =>
      opts.logger(m, (l as "info" | "warning" | "error" | undefined) ?? "info"),
    );
  });
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    if (!req.url) return socket.destroy();
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      void (async () => {
        const sessionId = url.searchParams.get("sessionId") || undefined;
        let session: WebSession;

        if (sessionId && sessions.has(sessionId)) {
          session = sessions.get(sessionId)!;
          try {
            session.attach(ws);
            opts.logger(`ws: re-attached to existing session ${sessionId}`, "info");
          } catch (e) {
            opts.logger(`ws: failed to re-attach to session ${sessionId}: ${(e as Error).message}`, "error");
            try {
              ws.close();
            } catch {}
            return;
          }
        } else {
          try {
            session = await opts.makeSession(
              ws,
              (m, l) => opts.logger(m, (l as "info" | "warning" | "error" | undefined) ?? "info"),
              sessionId,
            );
          } catch (e) {
            opts.logger(`makeSession failed: ${(e as Error).message}`, "error");
            try {
              ws.close();
            } catch {}
            return;
          }

          // The socket may have closed during async bootstrap; dispose now if so.
          if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
            try {
              session.dispose();
            } catch {}
            return;
          }

          sessions.set(session.sessionId, session);
          opts.logger(`ws: created new session ${session.sessionId}`, "info");
        }

        // Heartbeat: keep the socket warm during long turns and detect a
        // peer that has silently gone away. `alive` is reset by each pong.
        let alive = true;
        ws.on("pong", () => { alive = true; });
        const heartbeat = setInterval(() => {
          if (!alive) { try { ws.terminate(); } catch {} return; }
          alive = false;
          try { ws.ping(); } catch {}
        }, WS_HEARTBEAT_MS);

        ws.on("close", () => {
          clearInterval(heartbeat);
          if (session.socket !== ws) {
            // Old socket that closed after re-attach. Ignore it.
            return;
          }
          opts.logger(`ws: connection closed for session ${session.sessionId}, disposing immediately`, "info");
          try {
            session.dispose();
          } catch {}
          sessions.delete(session.sessionId);
        });
      })();
    });
  });

  await new Promise<void>((res, rej) => {
    http.once("error", rej);
    http.listen(opts.port, opts.host, () => res());
  });
  // report the actual bound address so a ':0' dynamic port resolves correctly.
  const addr = http.address();
  const boundHost = addr && typeof addr === "object" ? addr.address : opts.host;
  const boundPort = addr && typeof addr === "object" ? addr.port : opts.port;
  const url = `http://${boundHost}:${boundPort}`;

  return {
    http,
    wss,
    url,
    close: () =>
      new Promise<void>((res) => {
        for (const [sid, session] of sessions) {
          try {
            session.dispose();
          } catch {}
        }
        sessions.clear();
        for (const c of wss.clients) c.close();
        wss.close(() => http.close(() => res()));
      }),
  };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  log: (m: string, l?: string) => void,
): Promise<void> {
  try {
    if (!req.url) return notFound(res);
    const url = new URL(req.url, "http://localhost");
    const rawPath = url.pathname;

    // Vendor routes -- serve specific node_modules paths. These rarely
    // change, so we cache them aggressively.
    for (const v of VENDOR_MAP) {
      if (rawPath.startsWith(v.prefix)) {
        const sub = rawPath.slice(v.prefix.length).replace(/\.\.+/g, "");
        const filePath = join(v.baseDir, sub);
        if (!filePath.startsWith(v.baseDir)) return notFound(res);
        return await serveFile(res, filePath, "public, max-age=3600", log);
      }
    }

    // Static client files -- change every build, so disable caching.
    let path = rawPath === "/" ? "/index.html" : rawPath;
    path = path.replace(/^\/+/, "").replace(/\.\.+/g, "");
    const filePath = join(CLIENT_DIR, path);
    if (!filePath.startsWith(CLIENT_DIR)) return notFound(res, rawPath, log);
    // sw.js carries the cache version -- substitute __VERSION__ from package.json
    // so a release bump invalidates the precache without a manual edit.
    if (path === "sw.js") {
      const src = await readFile(filePath, "utf8").catch(() => null);
      if (src === null) return notFound(res, filePath, log);
      const body = src.replace(/__VERSION__/g, PKG_VERSION);
      res.writeHead(200, {
        "Content-Type": MIME[".js"],
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    return await serveFile(res, filePath, "no-store", log);
  } catch (e) {
    log(`web: request error for ${req.url}: ${(e as Error).message}`, "warning");
    notFound(res, req.url || "(unknown)", log);
  }
}

async function serveFile(
  res: ServerResponse,
  filePath: string,
  cacheControl: string,
  log: (m: string, l?: string) => void,
): Promise<void> {
  const s = await stat(filePath).catch(() => null);
  if (!s || !s.isFile()) {
    // Treat any miss in a /vendor/ path as load-bearing: it's almost always a
    // mis-resolved dep dir, which silently disables the start button.
    const level = filePath.includes("/vendor/") || /\b(vad-web|onnxruntime-web)\b/.test(filePath)
      ? "error" : "warning";
    log(`asset miss: ${filePath}`, level);
    return notFound(res, filePath, log);
  }
  const data = await readFile(filePath);
  const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": cacheControl,
  });
  res.end(data);
}

function notFound(res: ServerResponse, what?: string, log?: (m: string, l?: string) => void): void {
  if (log && what) log(`404 ${what}`, "warning");
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}
