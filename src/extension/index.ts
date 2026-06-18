// pi-omni extension entry point.
//
// registers an `--omni` flag (start the web voice server at launch) and an
// `/omni` command for control from an interactive session. both spawn the
// standalone entrypoint (src/server/index.ts) as a child and learn its address
// from the `base_url=` handshake it prints -- the same standalone-bin-plus-
// handshake model the sibling pi-* servers use.
//
// lifecycle is owned: the child is tied to this pi process and torn down when pi
// quits. a pid file backs /omni status|stop and lets a fresh pi detect an orphan
// left by a crashed one. for a server that outlives pi, run the installed
// `pi-omni` command directly. the in-TUI voice mode lives in the pi-live package.

import { exec, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const OMNI_FLAG = "omni";
const LISTEN_FLAG = "omni-listen";
// matches the env the server reads (src/config.ts); kept in sync by name.
const LISTEN_ENV = "PI_OMNI_LISTEN";

// the standalone server bin is always the compiled dist/server/index.js, run with
// plain node. pi loads this extension from .ts source (src/extension, via its jiti
// loader); the tests load the compiled copy (dist/extension). resolve the bin for
// either location.
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_PATH =
	[join(HERE, "..", "server", "index.js"), join(HERE, "..", "..", "dist", "server", "index.js")].find(existsSync) ??
	join(HERE, "..", "..", "dist", "server", "index.js");

// the one machine-parseable readiness line the child prints once it is listening.
const HANDSHAKE_PREFIX = "base_url=";
const HANDSHAKE_TIMEOUT_MS = 10_000;

// persisted so status/stop and orphan detection survive a pi restart.
const PID_FILE = join(homedir(), ".pi", "extensions", "omni.pid");

const SUBCOMMANDS = [
	{ name: "start", label: "start  - launch the server" },
	{ name: "status", label: "status - check server status" },
	{ name: "stop", label: "stop   - stop the server" },
	{ name: "open", label: "open   - open the web voice app in a browser" },
];

// the server this pi process owns. base_url is the real bound address from the
// handshake, not an assumed one, so a port-0 / dynamic bind is reported correctly.
let owned: { child: ChildProcess; baseUrl: string } | null = null;

function readPid(): number | null {
	try {
		if (existsSync(PID_FILE)) return Number(readFileSync(PID_FILE, "utf8").trim()) || null;
	} catch {
		/* ignore */
	}
	return null;
}

function writePid(pid: number): void {
	try {
		mkdirSync(dirname(PID_FILE), { recursive: true });
		writeFileSync(PID_FILE, String(pid));
	} catch {
		/* ignore */
	}
}

function clearPid(): void {
	try {
		if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
	} catch {
		/* ignore */
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isOwnedLive(): boolean {
	return owned !== null && !owned.child.killed;
}

// resolve once the child announces its base_url; reject if it dies or stalls first.
function awaitHandshake(child: ChildProcess): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const finish = (fn: () => void) => {
			clearTimeout(timer);
			child.stdout?.off("data", onData);
			child.off("exit", onExit);
			fn();
		};
		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line.startsWith(HANDSHAKE_PREFIX)) return finish(() => resolve(line.slice(HANDSHAKE_PREFIX.length)));
			}
		};
		const onExit = (code: number | null) => finish(() => reject(new Error(`server exited before handshake (code ${code})`)));
		const timer = setTimeout(() => finish(() => reject(new Error("timed out waiting for server handshake"))), HANDSHAKE_TIMEOUT_MS);
		child.stdout?.on("data", onData);
		child.once("exit", onExit);
	});
}

// flag wins over env; either may be a "host:port" / ":port" / "port" spec.
function resolveListen(pi: ExtensionAPI, override?: string): string | undefined {
	if (override) return override;
	const flag = pi.getFlag(LISTEN_FLAG);
	if (typeof flag === "string" && flag) return flag;
	return process.env[LISTEN_ENV] || undefined;
}

async function startServer(pi: ExtensionAPI, cwd: string, override?: string): Promise<string> {
	if (isOwnedLive()) return `already serving at ${owned!.baseUrl}`;
	const orphan = readPid();
	if (orphan && alive(orphan)) return `already serving (pid ${orphan}); use /omni stop first`;
	const listen = resolveListen(pi, override);
	const args = [BIN_PATH, ...(listen ? ["--listen", listen] : [])];
	const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
	const baseUrl = await awaitHandshake(child);
	child.stdout?.resume(); // drain any further output so the child never blocks on a full pipe
	owned = { child, baseUrl };
	writePid(child.pid!);
	child.once("exit", () => {
		if (owned?.child === child) owned = null;
		clearPid();
	});
	return `serving at ${baseUrl} -- open it with /omni open`;
}

async function stopServer(): Promise<string> {
	const target = isOwnedLive() ? owned!.child.pid : readPid();
	if (!target || !alive(target)) return "server is not running";
	const where = isOwnedLive() ? owned!.baseUrl : `pid ${target}`;
	owned = null;
	try {
		process.kill(target, "SIGTERM");
	} catch {
		/* already gone */
	}
	clearPid();
	return `stopped server at ${where}`;
}

function statusText(): string {
	if (isOwnedLive()) return `serving at ${owned!.baseUrl}`;
	const pid = readPid();
	return pid && alive(pid) ? `serving (pid ${pid})` : "server is not running";
}

// open the running web voice app in the default browser. only this pi process
// knows the owned server's url; an orphan from another session opens from there.
function openServer(): string {
	if (isOwnedLive()) {
		const url = owned!.baseUrl;
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
		exec(`${cmd} "${url}"`);
		return `opening ${url} in browser`;
	}
	const pid = readPid();
	if (pid && alive(pid)) return "server is running but was started by another session; open it from there";
	return "server is not running; run /omni start first";
}

async function dispatch(name: string, pi: ExtensionAPI, ctx: ExtensionCommandContext, listen?: string): Promise<void> {
	try {
		if (name === "start") {
			const msg = await startServer(pi, ctx.cwd, listen);
			ctx.ui.notify(msg, msg.startsWith("serving") || msg.startsWith("already") ? "info" : "error");
		} else if (name === "stop") {
			ctx.ui.notify(await stopServer(), "info");
		} else if (name === "status") {
			ctx.ui.notify(statusText(), "info");
		} else if (name === "open") {
			ctx.ui.notify(openServer(), "info");
		} else {
			ctx.ui.notify(`unknown subcommand '${name}'. use start, stop, status, or open.`, "error");
		}
	} catch (err) {
		ctx.ui.notify(`omni failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

async function pickAndRun(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const selected = await ctx.ui.select("pi-omni", SUBCOMMANDS.map((s) => s.label));
	const sub = SUBCOMMANDS.find((s) => s.label === selected);
	if (sub) await dispatch(sub.name, pi, ctx);
}

export default function (pi: ExtensionAPI): void {
	pi.registerFlag(OMNI_FLAG, { description: "start the pi-omni web voice server at launch", type: "boolean", default: false });
	pi.registerFlag(LISTEN_FLAG, { description: "omni bind address (host:port, :port, or port). implies --omni", type: "string" });

	pi.registerCommand("omni", {
		description: "control the pi-omni web voice server (start|stop|status|open)",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.map((s) => s.name)
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [sub, listenArg] = args.trim().split(/\s+/).filter(Boolean);
			if (!sub) await pickAndRun(pi, ctx);
			else await dispatch(sub, pi, ctx, listenArg);
		},
	});

	// auto-start when launched with --omni / --omni-listen; guarded so session
	// swaps (new/resume/fork) do not relaunch a server we already own.
	pi.on("session_start", async () => {
		const listenFlag = pi.getFlag(LISTEN_FLAG);
		const want = Boolean(pi.getFlag(OMNI_FLAG)) || (typeof listenFlag === "string" && listenFlag.length > 0);
		if (!want || isOwnedLive()) return;
		try {
			const msg = await startServer(pi, process.cwd());
			process.stderr.write(`pi-omni: ${msg}\n`);
		} catch (err) {
			process.stderr.write(`pi-omni: failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	});

	// tear down only when pi is actually quitting, not on session replacement.
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await stopServer();
	});
}
