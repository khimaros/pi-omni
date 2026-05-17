// Smoke test: AEC3-only (no HPF, no NS, no AGC2) so we can directly observe
// echo suppression. Reference = 400Hz sine; mic = same sine attenuated &
// delayed by 200 frames (= 200ms at 16kHz, matching the seed delay).
// Expect: after convergence, output << input.
import { Apm } from "./pkg/pi_omni_apm.js";

const SR = 16000;
const DELAY_MS = 200;
const apm = new Apm(SR, 1, DELAY_MS, false, false, false); // AEC3 only

const N = apm.samples_per_frame;
console.log(`samples_per_frame = ${N}`);

// Pre-roll the delay line: 200ms = 20 frames of zeros for the mic path
const DELAY_FRAMES = (DELAY_MS * SR) / 1000 / N; // 20 frames
const TOTAL_FRAMES = 400; // 4 seconds — give AEC3 time to converge
const ref = new Float32Array(N);
const mic = new Float32Array(N);

const refRing = []; // queue of past reference frames for echo simulation
const energies = []; // [(in, out)] per frame

// White noise — broadband, decorrelated, what AEC3 is tuned for.
const rand = () => (Math.random() * 2 - 1) * 0.3;

for (let f = 0; f < TOTAL_FRAMES; f++) {
  for (let i = 0; i < N; i++) ref[i] = rand();
  // Build mic frame from delayed ref (echo) at 0.5 gain
  const past = refRing.length >= DELAY_FRAMES ? refRing.shift() : null;
  if (past) {
    for (let i = 0; i < N; i++) mic[i] = past[i] * 0.5;
  } else {
    mic.fill(0);
  }
  refRing.push(new Float32Array(ref));

  apm.handle_render_frame(ref);
  const out = apm.process_capture_frame(mic);

  let inE = 0, outE = 0;
  for (let i = 0; i < N; i++) {
    inE += mic[i] * mic[i];
    outE += out[i] * out[i];
  }
  energies.push([Math.sqrt(inE / N), Math.sqrt(outE / N)]);
}

const report = (label, start, end) => {
  let inSum = 0, outSum = 0;
  for (let i = start; i < end; i++) {
    inSum += energies[i][0];
    outSum += energies[i][1];
  }
  const inMean = inSum / (end - start);
  const outMean = outSum / (end - start);
  const db = 20 * Math.log10(inMean / Math.max(outMean, 1e-9));
  console.log(`${label}: in RMS=${inMean.toFixed(4)} out RMS=${outMean.toFixed(4)} reduction=${db.toFixed(1)} dB`);
};

report("first 50 frames", 0, 50);
report("frames 100-200", 100, 200);
report("frames 300-400 (converged)", 300, 400);
