import { spawn, type ChildProcess } from "node:child_process";

export type MicOptions = {
  device?: string;
  sampleRate?: number; // default 16000
  onChunk?: (pcm: Buffer) => void;
};

// Streams raw S16_LE mono PCM from arecord. Caller accumulates / VAD-watches
// chunks via onChunk; stop() returns the full buffered PCM (no header).
export class Mic {
  private proc?: ChildProcess;
  private chunks: Buffer[] = [];
  private opts: MicOptions;

  constructor(opts: MicOptions | string = {}) {
    // Back-compat: old callers passed `device` as a positional string.
    this.opts = typeof opts === "string" ? { device: opts } : opts;
  }

  start(): void {
    this.chunks = [];
    const sr = this.opts.sampleRate ?? 16000;
    const args: string[] = [];
    if (this.opts.device) args.push("-D", this.opts.device);
    args.push(
      "-q",
      "-t", "raw",
      "-f", "S16_LE",
      "-r", String(sr),
      "-c", "1",
    );
    const proc = spawn("arecord", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout?.on("data", (b: Buffer) => {
      this.chunks.push(b);
      this.opts.onChunk?.(b);
    });
    proc.on("error", () => {});
    this.proc = proc;
  }

  async stop(): Promise<Buffer> {
    if (!this.proc) return Buffer.alloc(0);
    const proc = this.proc;
    const done = new Promise<void>((res) => proc.once("close", () => res()));
    proc.kill("SIGTERM");
    await done;
    this.proc = undefined;
    return Buffer.concat(this.chunks);
  }

  get recording(): boolean {
    return !!this.proc;
  }
}
