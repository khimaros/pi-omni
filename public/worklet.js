// Gapless Int16 PCM player. Main thread posts Int16Array chunks; we ring-
// buffer them and pour them out at the AudioContext sample rate, with linear
// resampling from the source rate (TTS ttsSampleRate, usually 24000) to the
// graph rate (browser default, usually 48000).
//
// Messages from main:
//   {type:'init', sourceRate}
//   {type:'pcm', samples: Int16Array}   appended to playout buffer
//   {type:'reset'}                      drop buffered audio (barge-in)
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceRate = 24000;
    this.queue = []; // array of Float32Array, oldest first
    this.queueOffset = 0; // sample offset into queue[0]
    this.queueSamples = 0;
    // Resampler state: fractional read position into the source stream.
    this.pos = 0;
    // Tracks whether we've produced any audio since the last drained
    // notification. Used to post a single "drained" message back to the
    // main thread the moment we run out of buffered PCM, so the UI can
    // hold the "speaking" phase until playout actually finishes (the
    // server's tts_end fires when bytes are sent, not when they're heard).
    this.hadAudio = false;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m && m.type === "init") {
      this.sourceRate = m.sourceRate ?? 24000;
    } else if (m && m.type === "pcm") {
      const i16 = m.samples;
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      this.queue.push(f32);
      this.queueSamples += f32.length;
      this.hadAudio = true;
    } else if (m && m.type === "reset") {
      this.queue = [];
      this.queueOffset = 0;
      this.queueSamples = 0;
      this.pos = 0;
      this.hadAudio = false;
    }
  }

  // Returns the source sample at integer index `i`, or 0 if past end.
  // `i` is absolute over the conceptual concatenated stream from current
  // queueOffset onward.
  readSample(i) {
    let cursor = i + this.queueOffset;
    for (const buf of this.queue) {
      if (cursor < buf.length) return buf[cursor];
      cursor -= buf.length;
    }
    return 0;
  }

  // Advance the queue/queueOffset to drop `n` source samples we no longer
  // need (everything strictly before integer floor(pos)).
  consume(n) {
    let remaining = n;
    while (remaining > 0 && this.queue.length) {
      const head = this.queue[0];
      const avail = head.length - this.queueOffset;
      if (avail > remaining) {
        this.queueOffset += remaining;
        this.queueSamples -= remaining;
        remaining = 0;
      } else {
        this.queueSamples -= avail;
        remaining -= avail;
        this.queue.shift();
        this.queueOffset = 0;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const ratio = this.sourceRate / sampleRate; // src per dst sample
    for (let i = 0; i < out.length; i++) {
      // Need src samples at integer indices floor(pos) and floor(pos)+1.
      const i0 = Math.floor(this.pos);
      // If we don't have ANY source data buffered, output silence. We use
      // strict `>=` (not `>`) -- the last sample is allowed to interpolate
      // against an implicit zero, which both fades cleanly and ensures
      // `queueSamples` actually reaches 0 so we can post `drained`.
      if (i0 >= this.queueSamples) {
        out[i] = 0;
        continue;
      }
      const frac = this.pos - i0;
      const a = this.readSample(i0);
      const b = this.readSample(i0 + 1); // 0 when past end (last sample edge)
      out[i] = a + (b - a) * frac;
      this.pos += ratio;
    }
    // Consume samples we'll no longer need.
    const drop = Math.floor(this.pos);
    if (drop > 0) {
      this.consume(drop);
      this.pos -= drop;
    }
    // We've drained: post one notification so the UI can leave the
    // speaking phase only after audible playout actually finishes.
    if (this.hadAudio && this.queueSamples === 0) {
      this.hadAudio = false;
      this.port.postMessage({ type: "drained" });
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);

// Raw mono PCM capture for push-to-talk. Accumulates input quanta into
// CAPTURE_CHUNK_SAMPLES-sized chunks and posts them to the main thread.
// Unlike a ScriptProcessorNode, a capture worklet is pulled purely off its
// input connection and needs no wiring to destination -- so it opens no
// second output stream, which on mobile destabilizes the playback context
// and crackles TTS.
const CAPTURE_CHUNK_SAMPLES = 2048;
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CAPTURE_CHUNK_SAMPLES);
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.fill++] = ch[i];
      if (this.fill === CAPTURE_CHUNK_SAMPLES) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(CAPTURE_CHUNK_SAMPLES);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
