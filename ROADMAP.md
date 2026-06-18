# ROADMAP

## backlog

```

[x] keep mic track alive permanently after first acquire; gate utterance
    frames so capture begins exactly when start chime ends and stops
    immediately before end chime begins. eliminates os-level audio-session
    renegotiation and the fragile mic-on settle delay.
[x] fix choppy audio on mobile (regression from b69b20b): VAD no longer
    shares playerCtx, so a mic input stops forcing the playback context
    into voice-communication mode. also use latencyHint "playback".
[x] fix "reconnecting" status showing in the phase color (amber while
    thinking): on socket reopen the reconnecting class clears but the stale
    "reconnecting" text lingered, painted by the leftover phase class.
    re-derive status text from phase when leaving the reconnecting state.
[x] fix pre-live speech leaking into the first transcript: drop a VAD
    onSpeechEnd whose onSpeechStart was gated out (vadSpeaking still false),
    since the library's audio spans the pre-captureOpen portion.
[x] keep ws alive during long "thinking" turns with a server-side ping/pong
    heartbeat so idle mobile/proxy timeouts stop forcing a reconnect.
[x] fix orb bouncing on refresh: it was the sole flex spacer, so history
    text loading into transcript/assistant after first paint shrank its
    region and shoved it up. pin the visible disc to viewport center so
    its position no longer depends on sibling content height.
[x] fix PTT audio crackling: PTT captured via a ScriptProcessorNode wired
    to pttCtx.destination, opening a second 16khz output stream alongside
    the 48khz playerCtx that never tore down -- destabilizing TTS playback
    on mobile after the first PTT press. capture via an AudioWorkletNode
    not connected to destination (mirrors the live VAD worklet path).
[x] fix standalone pi-omni crash on global install: ERR_MODULE_NOT_FOUND
    for 'chalk'. the persona vm installs pi-coding-agent globally, then
    `npm -g install`s pi-omni, which nests its own pi-coding-agent copy; since
    pi-omni ships bundleDependencies (file: wasm), npm's reify drops part of
    that nested copy's transitive deps (chalk). mark the pi-coding-agent peer
    optional so npm never nests it and the bin resolves the top-level copy.
[ ] PTT during live mode should barge in and return to paused after
[ ] rename paused to something better, like idle?
[ ] animate waveform when recording or something?
[ ] native Node binding to libwebrtc-audio-processing to drop the WASM layer
[ ] whisper in the browser (whisper.cpp WASM / transformers.js) -- keep only LLM on server
[ ] TTS in the browser (Kokoro / Piper WASM) -- eliminate audio round-trip
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
