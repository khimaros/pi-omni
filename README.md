# pi-omni

standalone **web voice server** for [pi.dev](https://pi.dev): a browser-based
voice chat UI backed by a real pi-coding-agent session, wired to a local
OpenAI-compatible STT/LLM/TTS stack (e.g. [llama-swap](https://github.com/mostlygeek/llama-swap)
serving whisper.cpp + llama.cpp + a TTS model).

speak in the browser; pi-omni transcribes (STT), runs the turn through pi's
agent loop and tools (LLM), and speaks the reply back (TTS). each browser tab
gets its own pi session.

> in-TUI voice (push-to-talk and continuous voice rendered inside the pi
> terminal, no browser) lives in the separate **pi-live** package.

## getting started

prerequisites:

- node.js 20+ (the server compiles to dist/ via tsc; the extension stays .ts)
- a working pi installation
- an OpenAI-compatible endpoint exposing STT, LLM, and TTS

install as a pi extension:

```bash
pi install npm:@khimaros/pi-omni
```

control the web voice server from the pi tui:

```bash
> /omni              # interactive picker (start / status / stop / open)
> /omni start        # start the server (optionally: /omni start <host:port>)
> /omni status       # show the listen address
> /omni stop         # stop the server
> /omni open         # open the web voice app in a browser
```

or auto-start when pi launches (owned by pi, terminated when pi exits):

```bash
pi --omni                       # start on launch
pi --omni-listen 0.0.0.0:4962   # custom bind address (implies --omni)
```

run the server standalone (no pi tui, outlives pi). pi-coding-agent is an
optional peer (the pi tui already provides it), so install it alongside for the
standalone path, or `make install` to put the `pi-omni` command on PATH:

```bash
npm install -g @earendil-works/pi-coding-agent @khimaros/pi-omni
PI_VOICE_LLM_MODEL=qwen3-32b pi-omni --listen 127.0.0.1:4962
```

the server prints `base_url=http://host:port` once listening; open that URL.

### pwa installation

the web UI is a Progressive Web App (PWA). open the URL in a supported browser
and choose "Install" / "Add to Home Screen" for a native-like experience.

### from a source checkout

```bash
make            # install deps + compile the server to dist/ (tsc)
make start      # run the server
make test       # build + run tests
make test-integration  # black-box python e2e against fake-openai
make wasm       # rebuild wasm/apm (after touching wasm/apm/src/)
```

## configuration

the OpenAI-compatible endpoint and STT/TTS models come from env vars (overriding
the saved `~/.pi/extensions/omni.json`):

| variable | default | purpose |
| --- | --- | --- |
| `PI_VOICE_BASE_URL` | `http://localhost:8080/v1` | OpenAI-compatible endpoint (STT + TTS) |
| `PI_VOICE_API_KEY` | `sk-no-key` | llama-swap usually ignores it |
| `PI_VOICE_STT_MODEL` | `whisper-1` | as exposed by your server |
| `PI_VOICE_TTS_MODEL` | `tts-1` | |
| `PI_VOICE_TTS_VOICE` | `alloy` | |
| `PI_VOICE_LLM_MODEL` | _(none)_ | default model for the standalone server |
| `PI_OMNI_LISTEN` | `127.0.0.1:4962` | http bind address (`host:port`, `:port`, or `port`) |

the LLM runs through pi-coding-agent (and any installed pi extensions), so it
uses pi's configured providers/models; the OpenAI-compatible endpoint above is
used only for STT and TTS.

cli flags:

| flag | purpose |
| --- | --- |
| `--listen <host:port>` | bind address; takes precedence over `PI_OMNI_LISTEN` |
| `-h`, `--help` | usage |

## echo cancellation & barge-in

the browser client can keep the mic open during TTS and cut in on speech
(barge-in), using an acoustic echo canceller -- a Rust port of WebRTC AEC3
compiled to WASM, depended on as a `file:` package at `wasm/apm/pkg/`. rebuild
after touching `wasm/apm/src/`:

```bash
make wasm
# or directly:
cd wasm/apm && wasm-pack build --target nodejs --release
```

build deps: `rustup` (e.g. via `mise use -g rust@latest`) with the
`wasm32-unknown-unknown` target, plus `wasm-pack`.

## architecture

```
src/
  extension/   pi extension entry -- spawns the bin, handshakes on base_url=; .ts
  server/      HTTP + WS voice server hosting the pi sdk runtime, compiled to dist/
                 index.ts (standalone entrypoint), http.ts, session.ts,
                 turn-lifecycle.ts
  audio/       STT, TTS, VAD, AEC, sentence chunker, sanitizer (shared with
                 pi-live, which keeps its own copy)
  config.ts    shared config + env-var overrides
public/        browser client (vanilla js, no build step)
wasm/apm/      WebRTC AEC3 -> WASM (rust)
test/          node --test files (.mjs) + python e2e (fake_openai_test.py)
```

the server compiles to `dist/` (the bin runs under plain node, which will not
type-strip `.ts` under `node_modules/`); the extension stays `.ts` and is loaded by
pi's jiti loader.

## development

```bash
make            # install deps + compile the server to dist/ (tsc)
make start      # run the server
make test       # build + run tests
make test-integration  # black-box python e2e against fake-openai
make lint       # type-check (tsc --noEmit)
make precommit  # lint + test + test-integration
make install    # install the pi-omni command globally (onto PATH)
make wasm       # rebuild wasm/apm
make pack       # npm pack into build/
make publish    # npm publish --access public
make clean      # rm -rf build
```
