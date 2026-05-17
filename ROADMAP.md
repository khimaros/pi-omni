# ROADMAP

## backlog

```
[ ] move AEC3 into the browser (wasm-pack --target web) for the web UI path
[ ] native Node binding to libwebrtc-audio-processing to drop the WASM layer
[ ] replace energy VAD with Silero-WASM for more robust speech detection
[ ] whisper in the browser (whisper.cpp WASM / transformers.js) — keep only LLM on server
[ ] TTS in the browser (Kokoro / Piper WASM) — eliminate audio round-trip
[ ] smarter sentence chunking (abbreviation-aware: "e.g.", "i.e.", "Dr.", ...)
[ ] discard LLM tokens after barge-in instead of generating-then-dropping
```

## in progress

```
[ ] server-side AEC3 + barge-in — WASM build of aec3-rs at wasm/apm/; wiring through src/aec.ts → src/mic.ts (capture cleanup) and src/tts.ts (reference tap); gated by aecEnabled and bargeInEnabled flags
[ ] minimal mobile web UI — single page that auto-enters voice-live mode on first tap; browser owns mic + speaker; server shovels PCM over WebSocket; native getUserMedia({ echoCancellation: true }) bypasses server-side AEC on this path
```

## done

```
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
