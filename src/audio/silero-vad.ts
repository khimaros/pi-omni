// Silero VAD wrapper around avr-vad's RealTimeVAD. Mirrors her/'s
// SileroVADAnalyzer parameters (confidence=0.5, start_secs=0.5,
// stop_secs=0.2).
//
// Silero v5 uses 512-sample frames @ 16kHz = 32ms. Converting from her/'s
// seconds:
//   start_secs=0.5  -> minSpeechFrames ~= 16
//   stop_secs=0.2   -> redemptionFrames ~= 6
//
// avr-vad's processAudio is async; we fire-and-forget from the sync mic
// chunk callback. Internal frame buffer ensures ordering.

// avr-vad ships its own type defs; we keep an interface-free shape here
// to avoid coupling.
import { RealTimeVAD } from "avr-vad";

export type SileroVadOptions = {
  // Match her/. 0.5 / (0.5 - 0.15) is the typical pair.
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  // How many speech frames (@ 16kHz × frameSamples) sustain detection
  // before onSpeechStart fires. Default 5 frames ~= 480ms.
  minSpeechFrames?: number;
  // Trailing silence frames before onSpeechEnd. Default 8 frames ~= 768ms.
  redemptionFrames?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
};

export class SileroVad {
  private vad: RealTimeVAD;
  private onSpeechStart: () => void;
  private onSpeechEnd: () => void;

  private constructor(
    vad: RealTimeVAD,
    onStart: () => void,
    onEnd: () => void,
  ) {
    this.vad = vad;
    this.onSpeechStart = onStart;
    this.onSpeechEnd = onEnd;
  }

  static async create(opts: SileroVadOptions = {}): Promise<SileroVad> {
    let inst!: SileroVad;
    const positive = opts.positiveSpeechThreshold ?? 0.5;
    const negative = opts.negativeSpeechThreshold ?? 0.35;
    const minSpeechFrames = opts.minSpeechFrames ?? 16;
    const redemptionFrames = opts.redemptionFrames ?? 6;
    const vad = await RealTimeVAD.new({
      sampleRate: 16000,
      positiveSpeechThreshold: positive,
      negativeSpeechThreshold: negative,
      frameSamples: 512,
      preSpeechPadFrames: 0,
      minSpeechFrames,
      redemptionFrames,
      submitUserSpeechOnPause: false,
      onSpeechStart: () => inst.onSpeechStart(),
      onSpeechRealStart: () => {},
      onSpeechEnd: () => inst.onSpeechEnd(),
      onVADMisfire: () => {},
      onFrameProcessed: () => {},
    });
    vad.start();
    inst = new SileroVad(
      vad,
      opts.onSpeechStart ?? (() => {}),
      opts.onSpeechEnd ?? (() => {}),
    );
    return inst;
  }

  setCallbacks(opts: { onSpeechStart?: () => void; onSpeechEnd?: () => void }): void {
    if (opts.onSpeechStart) this.onSpeechStart = opts.onSpeechStart;
    if (opts.onSpeechEnd) this.onSpeechEnd = opts.onSpeechEnd;
  }

  // Feed int16 LE mono PCM at 16kHz. Internally converted to Float32 and
  // pushed into the VAD's async frame pipeline.
  feed(int16: Buffer): void {
    if (!int16.length) return;
    const n = int16.length / 2;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      f32[i] = int16.readInt16LE(i * 2) / 32768;
    }
    // Fire-and-forget; internal pipeline serializes.
    void this.vad.processAudio(f32);
  }

  reset(): void {
    this.vad.reset();
  }

  pause(): void {
    this.vad.pause();
  }

  resume(): void {
    this.vad.start();
  }

  destroy(): Promise<void> {
    return this.vad.destroy();
  }
}
