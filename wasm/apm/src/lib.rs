use aec3::nodes::audio::AudioFormat;
use aec3::pipelines::linear::{self, LinearPipeline};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Apm {
    pipeline: LinearPipeline,
    samples_per_frame: usize,
    scratch_out: Vec<f32>,
}

#[wasm_bindgen]
impl Apm {
    /// Build a standard render+capture pipeline (HPF -> AEC3 -> NS -> AGC2).
    /// `sample_rate` is in Hz (16000/32000/48000), `channels` typically 1.
    /// `initial_delay_ms` is the expected playback->mic round-trip; APM has a
    /// delay estimator, this just seeds it.
    #[wasm_bindgen(constructor)]
    pub fn new(
        sample_rate: u32,
        channels: u32,
        initial_delay_ms: i32,
        enable_hpf: bool,
        enable_ns: bool,
        enable_agc: bool,
    ) -> Result<Apm, JsError> {
        let fmt = AudioFormat::ten_ms(sample_rate, channels as u16);
        let samples_per_frame = fmt.sample_count();
        let pipeline = linear::builder(fmt, fmt)
            .initial_delay_ms(initial_delay_ms)
            .enable_high_pass_filter(enable_hpf)
            .enable_noise_suppression(enable_ns)
            .enable_gain_controller2(enable_agc)
            .build()
            .map_err(|e| JsError::new(&format!("aec3 build: {e}")))?;
        Ok(Apm {
            pipeline,
            samples_per_frame,
            scratch_out: vec![0.0; samples_per_frame],
        })
    }

    /// Samples per 10ms frame for the configured format.
    #[wasm_bindgen(getter)]
    pub fn samples_per_frame(&self) -> u32 {
        self.samples_per_frame as u32
    }

    /// Push one 10ms interleaved-f32 reference frame (the audio about to be
    /// played out the speaker).
    pub fn handle_render_frame(&mut self, frame: &[f32]) -> Result<(), JsError> {
        if frame.len() != self.samples_per_frame {
            return Err(JsError::new("render frame size mismatch"));
        }
        self.pipeline
            .handle_render_frame(frame)
            .map_err(|e| JsError::new(&format!("handle_render_frame: {e}")))
    }

    /// Process one 10ms interleaved-f32 capture frame from the mic. Returns a
    /// new Float32Array containing the cleaned frame.
    pub fn process_capture_frame(&mut self, frame: &[f32]) -> Result<Vec<f32>, JsError> {
        if frame.len() != self.samples_per_frame {
            return Err(JsError::new("capture frame size mismatch"));
        }
        let produced = self
            .pipeline
            .process_capture_frame(frame, &mut self.scratch_out)
            .map_err(|e| JsError::new(&format!("process_capture_frame: {e}")))?;
        if !produced {
            return Ok(frame.to_vec());
        }
        Ok(self.scratch_out.clone())
    }
}
