# ROADMAP

## backlog

```

[x] keep mic track alive permanently after first acquire; gate utterance
    frames so capture begins exactly when start chime ends and stops
    immediately before end chime begins. eliminates os-level audio-session
    renegotiation and the fragile mic-on settle delay.
[x] fix crackling audio on firefox android (playerCtx output underruns):
    use latencyHint "playback" for a larger output buffer
[ ] PTT during live mode should barge in and return to paused after
[ ] rename paused to something better, like idle?
[ ] animate waveform when recording or something?
[ ] native Node binding to libwebrtc-audio-processing to drop the WASM layer
[ ] whisper in the browser (whisper.cpp WASM / transformers.js) — keep only LLM on server
[ ] TTS in the browser (Kokoro / Piper WASM) — eliminate audio round-trip
[ ] smarter sentence chunking (abbreviation-aware: "e.g.", "i.e.", "Dr.", ...)
## done

```
[x] fix barge-in during transcribing: concurrent finishUtterance can drop new request
[x] simplify autostart logic and fix onboarding hint visibility on new session
[x] expand test coverage for session preservation, deletion, and connection state changes
[x] support WebSocket disconnect/reconnect session preservation and new session action
[x] make status text slightly larger and match glow color for each phase
[x] move "loading VAD" message to start-hint element
[x] fix PWA install button in Firefox Android (missing 192/512 icons)
[x] convert to PWA with a premium icon
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
