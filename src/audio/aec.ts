import { Apm } from "pi-omni-apm";

// WebRTC AEC3 (via aec3-rs compiled to WASM). Operates on 16kHz mono int16
// PCM. TTS reference must be resampled to 16kHz before being fed in.

const SAMPLE_RATE = 16000;
const CHANNELS = 1;

export type AecOptions = {
  initialDelayMs: number;
  // Process chain config. We disable AGC2/NS by default — we want clean
  // echo cancellation, not gain leveling. HPF (DC removal) is cheap and
  // helpful.
  enableHpf?: boolean;
  enableNs?: boolean;
  enableAgc?: boolean;
};

export class Aec {
  private apm: Apm;
  readonly frameSamples: number;
  private frameBytes: number;
  private captureRemainder: Buffer = Buffer.alloc(0);

  // Reference (TTS) bytes are buffered here and released to APM at the rate
  // matching real-time playback. Pushing every TTS chunk immediately would
  // put the reference seconds ahead of mic-heard echo (aplay-buffer latency),
  // which exceeds AEC3's filter tail and breaks cancellation. We anchor a
  // wall-clock time-zero on playback start and release frames as time elapses
  // past that anchor.
  private refQueue: Buffer[] = [];
  private refQueueBytes = 0;
  private refTotalReleasedBytes = 0;
  private playbackT0Ms: number | null = null;
  private readonly playbackDelayMs: number;

  constructor(opts: AecOptions) {
    this.apm = new Apm(
      SAMPLE_RATE,
      CHANNELS,
      opts.initialDelayMs,
      opts.enableHpf ?? true,
      opts.enableNs ?? false,
      opts.enableAgc ?? false,
    );
    this.frameSamples = this.apm.samples_per_frame;
    this.frameBytes = this.frameSamples * 2; // int16
    this.playbackDelayMs = opts.initialDelayMs;
  }

  // Tell the AEC that audio playback is starting NOW (i.e. PCM is being
  // written to the speaker, but won't emerge for ~playbackDelayMs). Anchors
  // the wall-clock release schedule for subsequent reference frames.
  startPlayback(): void {
    this.playbackT0Ms = Date.now() + this.playbackDelayMs;
    this.refTotalReleasedBytes = 0;
    this.refQueue = [];
    this.refQueueBytes = 0;
  }

  stopPlayback(): void {
    this.playbackT0Ms = null;
    this.refQueue = [];
    this.refQueueBytes = 0;
    this.refTotalReleasedBytes = 0;
  }

  // Append reference PCM (16kHz mono int16) to the pending-release queue.
  // Actual handoff to APM is deferred to processCapture(), where we know how
  // much real-time has elapsed.
  pushReference(pcm: Buffer): void {
    if (!pcm.length) return;
    this.refQueue.push(pcm);
    this.refQueueBytes += pcm.length;
  }

  // Push capture PCM from the mic. Returns cleaned PCM for whole frames
  // only; trailing partial frame is held until the next call. Caller can
  // feed downstream (VAD / STT) the returned buffer directly.
  processCapture(pcm: Buffer): Buffer {
    // First, release any reference frames whose wall-clock playback moment
    // has now arrived. Strictly interleaved with APM capture calls so the
    // canceller sees a consistent ref/capture timeline.
    this.releaseDueReference();

    const buf: Buffer = this.captureRemainder.length
      ? Buffer.concat([this.captureRemainder, pcm])
      : pcm;
    let off = 0;
    const f32In = new Float32Array(this.frameSamples);
    const out: Buffer[] = [];
    while (off + this.frameBytes <= buf.length) {
      int16ToFloat32(buf, off, f32In);
      let f32Out: Float32Array;
      try {
        f32Out = this.apm.process_capture_frame(f32In);
      } catch {
        f32Out = f32In;
      }
      out.push(float32ToInt16(f32Out));
      off += this.frameBytes;
    }
    this.captureRemainder = buf.subarray(off);
    return out.length ? Buffer.concat(out) : Buffer.alloc(0);
  }

  private releaseDueReference(): void {
    if (this.playbackT0Ms === null) return;
    const elapsedMs = Date.now() - this.playbackT0Ms;
    if (elapsedMs <= 0) return;
    const targetBytes = Math.floor((elapsedMs * SAMPLE_RATE * 2) / 1000);
    const f32 = new Float32Array(this.frameSamples);
    while (
      this.refTotalReleasedBytes + this.frameBytes <= targetBytes &&
      this.refQueueBytes >= this.frameBytes
    ) {
      const frame = this.popRefFrame();
      if (!frame) break;
      int16ToFloat32(frame, 0, f32);
      try {
        this.apm.handle_render_frame(f32);
      } catch {}
      this.refTotalReleasedBytes += this.frameBytes;
    }
  }

  private popRefFrame(): Buffer | undefined {
    if (this.refQueueBytes < this.frameBytes) return undefined;
    const head = this.refQueue[0];
    if (head.length >= this.frameBytes) {
      const frame = head.subarray(0, this.frameBytes);
      const rest = head.subarray(this.frameBytes);
      if (rest.length) this.refQueue[0] = rest;
      else this.refQueue.shift();
      this.refQueueBytes -= this.frameBytes;
      return Buffer.from(frame);
    }
    // Frame straddles multiple queued buffers — concat the head until we have
    // a whole frame.
    const parts: Buffer[] = [];
    let collected = 0;
    while (collected < this.frameBytes && this.refQueue.length) {
      const need = this.frameBytes - collected;
      const front = this.refQueue[0];
      if (front.length <= need) {
        parts.push(front);
        collected += front.length;
        this.refQueue.shift();
      } else {
        parts.push(front.subarray(0, need));
        this.refQueue[0] = front.subarray(need);
        collected += need;
      }
    }
    this.refQueueBytes -= this.frameBytes;
    return Buffer.concat(parts);
  }

  dispose(): void {
    try {
      this.apm.free();
    } catch {}
  }
}

// Linear resampler. Caller-supplied state ring covers fractional positions.
// Sample rate ratios > 1 (downsampling): inputRate / outputRate.
export class LinearResampler {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  // Cumulative fractional position into the buffer.
  private pos = 0;
  private readonly ratio: number;

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate;
  }

  process(int16In: Buffer): Buffer {
    const combined: Buffer = this.buf.length
      ? Buffer.concat([this.buf, int16In])
      : int16In;
    const inSamples = combined.length / 2;
    if (inSamples < 2) {
      this.buf = combined;
      return Buffer.alloc(0);
    }
    // Output samples we can produce without running past inSamples - 1
    // (need pos < inSamples - 1 for linear interp).
    const maxPos = inSamples - 1;
    const outSamples = Math.floor((maxPos - this.pos) / this.ratio);
    if (outSamples <= 0) {
      this.buf = combined;
      return Buffer.alloc(0);
    }
    const out = Buffer.allocUnsafe(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      const p = this.pos + i * this.ratio;
      const i0 = Math.floor(p);
      const frac = p - i0;
      const a = combined.readInt16LE(i0 * 2);
      const b = combined.readInt16LE((i0 + 1) * 2);
      const s = Math.round(a + (b - a) * frac);
      out.writeInt16LE(clampInt16(s), i * 2);
    }
    const lastP = this.pos + outSamples * this.ratio;
    const dropI = Math.floor(lastP);
    this.pos = lastP - dropI;
    this.buf = combined.subarray(dropI * 2);
    return out;
  }
}

function int16ToFloat32(src: Buffer, off: number, dst: Float32Array): void {
  for (let i = 0; i < dst.length; i++) {
    dst[i] = src.readInt16LE(off + i * 2) / 32768;
  }
}

function float32ToInt16(src: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(src.length * 2);
  for (let i = 0; i < src.length; i++) {
    let s = Math.round(src[i] * 32768);
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

function clampInt16(s: number): number {
  if (s > 32767) return 32767;
  if (s < -32768) return -32768;
  return s;
}
