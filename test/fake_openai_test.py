#!/usr/bin/env python3
"""black-box end-to-end test: drive the pi-omni web voice server against the
fake-openai mock (an openai-compatible endpoint) instead of real STT/LLM/TTS.

written in python -- deliberately a different language than the extension, so it
cannot reach into internals and must drive the real socket like any client. it
spawns the built standalone pi-omni bin (dist/server/index.js) exactly as the pi
extension does, points STT/TTS and the LLM at the mock, connects over the
websocket, sends a voice utterance (audio frames), and asserts the STT transcript,
the LLM request, and the spoken reply round-trip.

skips when the fake-openai binary or node are unavailable."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT.parent / "fake-openai" / "clients" / "python"))
import fakeopenai

# the built standalone pi-omni entrypoint, run as its own process exactly as the
# pi extension spawns it (requires `make build` / `npm run build` first).
PI_OMNI_BIN = PROJECT_ROOT / "dist" / "server" / "index.js"
PROVIDER = "fake"
MODEL_ID = "fake-model"
BOOT_TIMEOUT_S = 30
# the fixed transcript fake-openai returns for every stt request.
STT_TRANSCRIPT = "this is a test transcription"

PASS = FAIL = 0


def check(desc, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS: {desc}")
    else:
        FAIL += 1
        print(f"FAIL: {desc}")
        if detail:
            print(f"  {detail}")


def seed_agent(agent_dir, base_url):
    """seed an isolated agent dir with the mock provider and a default model (used
    by pi-coding-agent for the LLM); STT/TTS use the same mock via PI_VOICE_*."""
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "models.json").write_text(json.dumps({
        "providers": {PROVIDER: {
            "baseUrl": base_url, "api": "openai-completions", "apiKey": "test",
            "models": [{"id": MODEL_ID, "name": "Fake Model",
                        "contextWindow": 200000, "maxTokens": 4096}],
        }}
    }))
    (agent_dir / "settings.json").write_text(json.dumps({
        "defaultProvider": PROVIDER, "defaultModel": MODEL_ID,
    }))


def start_omni(base_url, agent_dir, proj_dir, session_dir):
    seed_agent(agent_dir, base_url)
    env = {**os.environ,
           "PI_AGENT_DIR": str(agent_dir),
           "PI_CODING_AGENT_DIR": str(agent_dir),
           "PI_PROJECT_CWD": str(proj_dir),
           "PI_SESSION_DIR": str(session_dir),
           # STT and TTS go through the openai-compatible endpoint = the mock.
           "PI_VOICE_BASE_URL": base_url,
           "PI_VOICE_API_KEY": "test",
           "PI_OFFLINE": "1", "CI": "1"}
    log = open(proj_dir / "pi-omni.stderr.log", "w")
    proc = subprocess.Popen([str(PI_OMNI_BIN), "--listen", "127.0.0.1:0"],
                            cwd=str(proj_dir), env=env,
                            stdout=subprocess.PIPE, stderr=log, text=True)
    deadline = time.time() + BOOT_TIMEOUT_S
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        if line.startswith("base_url="):
            return proc, line.strip()[len("base_url="):]
    stop_omni(proc)
    raise RuntimeError(f"pi-omni did not announce base_url within {BOOT_TIMEOUT_S}s")


def stop_omni(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def host_port(base_url):
    host, _, port = base_url.split("://", 1)[1].partition(":")
    return host, int(port)


def drain_until(ws, found, timeout_s=30):
    """collect websocket text frames until one satisfies found(frame), or timeout."""
    frames = []
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            frames.append(ws.recv_json(timeout=max(0.1, deadline - time.time())))
        except (ConnectionError, OSError):
            break
        if found(frames[-1]):
            break
    return frames


def scenario_voice_turn(base_url, fake):
    reply = "the programmed pi-omni reply"
    fake.program([{"content": reply}])
    host, port = host_port(base_url)
    with fakeopenai.WSClient(host, port, "/ws") as ws:
        # one voice utterance: start, a frame of (silent) pcm, end. the mock
        # transcribes it to a fixed string regardless of the audio content.
        ws.send_json({"type": "audio_start"})
        ws.send_bytes(b"\x00" * 3200)  # 100ms of 16kHz mono 16-bit silence
        ws.send_json({"type": "audio_end", "sampleRate": 16000})
        # collect until the assistant reply text shows up in a frame.
        frames = drain_until(ws, lambda f: reply in json.dumps(f), 30)

    blob = json.dumps(frames)
    check("voice: stt transcript reached the client", STT_TRANSCRIPT in blob,
          detail=f"{len(frames)} frames; transcript not seen")
    check("voice: programmed reply spoken back to the client", reply in blob,
          detail="reply text not seen in any frame")

    caps = fake.chat_captures()
    check("voice: mock captured a chat request", len(caps) >= 1)
    if caps:
        sent = json.dumps(caps[0]["body"].get("messages", []))
        check("voice: llm request carried the transcribed utterance", STT_TRANSCRIPT in sent)


def main():
    if not fakeopenai.available():
        print(f"SKIP: fake-openai binary not found at {fakeopenai.BIN}; build ../fake-openai or set FAKE_OPENAI_BIN")
        return 0
    if not shutil.which("node"):
        print("SKIP: node not on PATH")
        return 0

    tmp = Path(tempfile.mkdtemp(prefix="pi-omni-test-"))
    proj_dir = tmp / "project"
    proj_dir.mkdir(parents=True)
    with fakeopenai.FakeOpenAI() as fake:
        proc, base = start_omni(fake.base_url, tmp / "agent", proj_dir, tmp / "sessions")
        print(f"pi-omni on {base} (mock {fake.base_url})")
        try:
            scenario_voice_turn(base, fake)
        finally:
            stop_omni(proc)
            shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
