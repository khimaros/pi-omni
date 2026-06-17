# pi-omni

push-to-talk voice extension for [pi.dev](https://pi.dev): wires a local
OpenAI-compatible STT/LLM/TTS stack (e.g. [llama-swap](https://github.com/mostlygeek/llama-swap)
serving whisper.cpp + llama.cpp + a TTS model) into a pi agent session, plus
an optional browser UI.

## getting started

prerequisites:

- node.js 20+
- a working pi installation
- `arecord` (alsa-utils) and a wav-on-stdin speaker (`aplay`, `paplay`,
  `ffplay -nodisp -autoexit -`, …)
- an OpenAI-compatible endpoint exposing STT, LLM, and TTS

install as a pi extension:

```bash
pi install npm:@khimaros/pi-omni
```

control voice mode from the pi tui:

```bash
> /omni              # push-to-talk: tap to record, VAD or re-tap to stop
> /omni-live         # continuous conversation: record → STT → LLM → TTS loop
> /omni-cancel       # cancel any active recording / TTS / chat loop
> /omni-setup        # configure endpoint, models, mic, speaker (re-run anytime)
> /omni-test [text]  # TTS round-trip diagnostic
```

control the web UI from the pi tui:

```bash
> /omni-web start    # start the web server
> /omni-web status   # view server status
> /omni-web open     # open the web UI in browser
> /omni-web stop     # stop the web server
```

or auto-start when pi launches (terminated when pi exits):

```bash
pi --omni-live       # continuous voice on launch
pi --omni-web        # web server on launch
```

run the web server standalone (no pi tui). pi-coding-agent is an optional peer
(the pi tui already provides it), so install it alongside pi-omni for the
standalone path:

```bash
npm install -g @earendil-works/pi-coding-agent @khimaros/pi-omni
PI_VOICE_LLM_MODEL=qwen3-32b pi-omni-web
```

then open <http://127.0.0.1:4962>.

Once loaded, the Web UI automatically tracks active sessions. You can use the premium glassmorphic **sessions** menu in the top-right corner to view a list of recent sessions, switch between them, or start a new session instantly. Reconnecting after a WebSocket disconnect or reloading the page automatically resumes the active session based on the URL hash.

### pwa installation

the web UI is a Progressive Web App (PWA). you can "install" it to your home screen or desktop for a native-like experience:
1. open the URL in a supported browser (Chrome, Safari, Edge).
2. look for the "Install" icon in the address bar or select "Add to Home Screen" from the browser menu.
3. the app will appear on your device with a premium waveform icon.


### from a source checkout

```bash
make            # install deps + build
make test       # run tests
make wasm       # rebuild wasm/apm (after touching wasm/apm/src/)
```

## configuration

first run of `/omni` triggers `/omni-setup` automatically — it walks
through endpoint, models, mic, speaker, and an end-to-end round-trip test.
saved to `~/.pi/extensions/omni.json`. re-run `/omni-setup` anytime to
reconfigure.

env vars override the saved file:

| variable | default | purpose |
| --- | --- | --- |
| `PI_VOICE_BASE_URL` | `http://localhost:8080/v1` | OpenAI-compatible endpoint |
| `PI_VOICE_API_KEY` | `sk-no-key` | llama-swap usually ignores it |
| `PI_VOICE_STT_MODEL` | `whisper-1` | as exposed by your server |
| `PI_VOICE_TTS_MODEL` | `tts-1` | |
| `PI_VOICE_TTS_VOICE` | `alloy` | |
| `PI_VOICE_LLM_MODEL` | _(none)_ | required for standalone `pi-omni-web` |
| `PI_VOICE_MIC_DEVICE` | _(default ALSA)_ | passed to `arecord -D` |
| `PI_VOICE_SPEAKER_CMD` | `aplay -q ...` | reads WAV from stdin |
| `PI_VOICE_AEC_ENABLED` | `false` | acoustic echo cancellation (WebRTC AEC3 WASM) |
| `PI_VOICE_AEC_DELAY_MS` | `200` | expected speaker→mic round-trip |
| `PI_VOICE_BARGE_IN` | `false` | keep mic open during TTS, cut in on speech |
| `PI_VOICE_BARGE_IN_MIN_MS` | `300` | minimum speech duration to count as barge-in |
| `PI_VOICE_WEB_HOST` | `127.0.0.1` | http bind address for the web server |
| `PI_VOICE_WEB_PORT` | `4962` | http port for the web server |

cli flags for the pi extension:

| flag | env var | config key | effect |
| --- | --- | --- | --- |
| `--omni-live` | `PI_OMNI_AUTO_LIVE=true` | `autoStartLive` | start continuous voice on launch |
| `--omni-web` | `PI_OMNI_AUTO_WEB=true` | `autoStartWeb` | start web server on launch |

cli flags for standalone `pi-omni-web`:

| flag | purpose |
| --- | --- |
| `--listen <host:port>` | http bind address; takes precedence over env vars |
| `-h`, `--help` | usage |

## echo cancellation & barge-in

set `aecEnabled: true` and `bargeInEnabled: true` (via `/omni-setup` or env)
to keep the mic open during TTS so you can interrupt by speaking. without
AEC, only enable barge-in on headphones — speaker output will feed back into
the mic and the bot will interrupt itself.

the AEC is a Rust port of WebRTC AEC3 compiled to WASM, depended on as a
`file:` package at `wasm/apm/pkg/`. rebuild after touching `wasm/apm/src/`:

```bash
make wasm
# or directly:
cd wasm/apm && wasm-pack build --target nodejs --release
```

build deps: `rustup` (e.g. via `mise use -g rust@latest`) with the
`wasm32-unknown-unknown` target, plus `wasm-pack`.

## roadmap

see [ROADMAP.md](ROADMAP.md) for implemented and planned features.

## architecture

```
src/
  extension/   pi extension entry (commands, shortcuts, event handlers)
  server/      HTTP + WS server hosting the browser client
  bin/         standalone executables (pi-omni-web)
  audio/       mic, STT, TTS, VAD, AEC, sentence chunker, sanitizer
  config.ts    shared config + env-var overrides
public/        browser client (no build step)
wasm/apm/      WebRTC AEC3 → WASM (rust)
test/          node --test files
```

## development

```bash
make            # install deps + build (tsc)
make test       # build then run node --test
make lint       # type-check (tsc --noEmit)
make precommit  # lint + test
make install    # install globally from this checkout
make update     # npm update
make wasm       # rebuild wasm/apm
make pack       # npm pack into build/
make publish    # npm publish --access public
make clean      # rm -rf dist build
```

## known limits

- sentence chunking is naive (split on `.!?\n`); abbreviations like "e.g."
  will split early.
- manual barge-in via `/omni` re-tap works without AEC; automatic barge-in
  needs AEC enabled or headphones.
- if the pi extension bus doesn't forward `message_update`, TTS waits for
  `turn_end` — still works, just less interactive.
- barge-in cuts off TTS instantly but the LLM keeps generating in the
  background until it finishes; its output is discarded.
- standalone `pi-omni-web` requires `PI_VOICE_LLM_MODEL`; the pi extension
  path doesn't (pi owns the LLM).
