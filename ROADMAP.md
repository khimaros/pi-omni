# ROADMAP

## backlog

```
[ ] PTT during live mode should barge in and return to paused after
[ ] rename paused to something better, like idle?
[ ] animate waveform when recording or something?
[ ] native Node binding to libwebrtc-audio-processing to drop the WASM layer
[ ] whisper in the browser (whisper.cpp WASM / transformers.js) — keep only LLM on server
[ ] TTS in the browser (Kokoro / Piper WASM) — eliminate audio round-trip
[ ] smarter sentence chunking (abbreviation-aware: "e.g.", "i.e.", "Dr.", ...)
[ ] discard LLM tokens after barge-in instead of generating-then-dropping
```

## done

```
[x] replace energy VAD with Silero-WASM for more robust speech detection
[x] move AEC3 into the browser (wasm-pack --target web) for the web UI path
[x] push-to-talk /omni (tap to start, tap to stop)
[x] continuous /omni-live (VAD-driven record → STT → LLM → TTS → record loop)
[x] /omni-cancel
[x] /omni-setup onboarding (endpoint, models, mic, speaker, round-trip test)
[x] /omni-web HTTP/WS server with browser client
[x] /omni-test (TTS round-trip diagnostics)
[x] auto-start flags: --omni-live, --omni-web
[x] env-var + saved-config overrides (~/.pi/extensions/omni.json)
[x] sentence-chunked TTS streaming (token-level when message_update is available)
[x] manual barge-in via /omni re-tap (cancels TTS, starts new recording)
[x] WASM AEC3 (aec3-rs port) gated by aecEnabled
[x] automatic barge-in gated by bargeInEnabled (requires AEC or headphones)
```
