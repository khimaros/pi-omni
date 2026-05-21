import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSession } from "../dist/server/session.js";

// Mock WebSocket class for Node.js ws compatibility
class MockWebSocket {
  constructor() {
    this.sent = [];
    this.listeners = {};
    this.closed = false;
    this.readyState = 1; // WebSocket.OPEN
  }
  send(data) {
    this.sent.push(data);
  }
  on(event, listener) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(listener);
    return this;
  }
  off(event, listener) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((l) => l !== listener);
    }
    return this;
  }
  removeAllListeners() {
    this.listeners = {};
    return this;
  }
  close() {
    this.closed = true;
    this.readyState = 3; // WebSocket.CLOSED
  }
  emit(event, ...args) {
    if (this.listeners[event]) {
      for (const listener of this.listeners[event]) {
        listener(...args);
      }
    }
  }
}

// Helper to create session dependencies
function makeSessionDeps(options = {}) {
  const calls = { activated: [], deactivated: [] };
  const deps = {
    cfg: {
      baseURL: "https://api.openai.com/v1",
      apiKey: "test-key",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsSampleRate: 24000,
      ttsStreamBatchSize: 1024,
      ttsSpeed: 1.0,
      ttsInstructions: "speak clearly",
      ttsLanguage: "en",
      ttsStreamAudio: false,
      ttsChunkSentences: false,
      ttsInterSentenceGapMs: 0,
      webAutoStart: true,
      orbGlyph: "🎙️",
    },
    client: {}, // Stub OpenAI client
    sendUserMessage: () => {},
    onActivate: (s) => calls.activated.push(s),
    onDeactivate: (s) => calls.deactivated.push(s),
    history: options.history,
  };
  return { deps, calls };
}

test("WebSession constructor initializes properly and sends hello", () => {
  const ws = new MockWebSocket();
  const { deps, calls } = makeSessionDeps();
  const session = new WebSession(ws, deps);

  assert.ok(session.sessionId, "Must generate a random sessionId");
  assert.equal(session.socket, ws, "getter socket must return the bound socket");
  assert.equal(calls.activated.length, 1, "Must activate on init");
  assert.equal(calls.activated[0], session);

  assert.equal(ws.sent.length, 1, "Must send a hello frame");
  const msg = JSON.parse(ws.sent[0]);
  assert.equal(msg.type, "hello");
  assert.equal(msg.sessionId, session.sessionId);
  assert.equal(msg.ttsSampleRate, 24000);
  assert.equal(msg.orbGlyph, "🎙️");
  assert.equal(msg.lastUserText, undefined);
  assert.equal(msg.lastAssistantText, undefined);
});

test("WebSession constructor accepts predefined sessionId and sends history", () => {
  const ws = new MockWebSocket();
  const history = {
    lastUserText: "hello from test user",
    lastAssistantText: "hello from test assistant",
  };
  const { deps } = makeSessionDeps({ history });
  const predefinedId = "fixed-session-id-12345";
  const session = new WebSession(ws, deps, predefinedId);

  assert.equal(session.sessionId, predefinedId, "Must use predefined sessionId");
  assert.equal(ws.sent.length, 1);
  const msg = JSON.parse(ws.sent[0]);
  assert.equal(msg.type, "hello");
  assert.equal(msg.sessionId, predefinedId);
  assert.equal(msg.lastUserText, "hello from test user");
  assert.equal(msg.lastAssistantText, "hello from test assistant");
});

test("WebSession.attach closes old socket and activates new socket", () => {
  const ws1 = new MockWebSocket();
  const { deps, calls } = makeSessionDeps();
  const session = new WebSession(ws1, deps);

  assert.equal(ws1.closed, false);
  assert.equal(calls.activated.length, 1);

  const ws2 = new MockWebSocket();
  session.attach(ws2);

  assert.equal(ws1.closed, true, "Must close the old socket");
  assert.equal(session.socket, ws2, "Must bind the new socket");
  assert.equal(calls.activated.length, 2, "Must activate the new session");
  assert.equal(calls.activated[1], session);

  assert.equal(ws2.sent.length, 1, "Must send hello message on the new socket");
  const msg = JSON.parse(ws2.sent[0]);
  assert.equal(msg.type, "hello");
  assert.equal(msg.sessionId, session.sessionId);
});

test("WebSession handles disconnect/close by triggering onDeactivate via dispose", () => {
  const ws = new MockWebSocket();
  const { deps, calls } = makeSessionDeps();
  const session = new WebSession(ws, deps);

  assert.equal(calls.deactivated.length, 0);

  // Dispose session to deactivate
  session.dispose();

  assert.equal(calls.deactivated.length, 1, "Must trigger onDeactivate on dispose");
  assert.equal(calls.deactivated[0], session);
});

// ─── barge-in during transcribing: concurrent finishUtterance race ──

// Controllable mock OpenAI client: each call to transcribe() returns a
// deferred promise that the test resolves manually, controlling the
// order in which concurrent STT calls complete.
function makeDeferredSttClient() {
  const calls = [];
  const client = {
    audio: {
      transcriptions: {
        create: () => {
          let resolve, reject;
          const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          });
          calls.push({ resolve, reject, promise });
          return promise;
        },
      },
    },
  };
  return { client, calls };
}

// Generate a minimal WAV header for 16kHz 16-bit mono PCM so
// finishUtterance doesn't bail out on empty pcm. Content doesn't
// matter since STT is mocked.
function dummyPcm(bytes = 320) {
  return Buffer.alloc(bytes, 0x42);
}

// finishUtterance() awaits toFile() before calling client.audio.
// transcriptions.create, so the mock isn't invoked synchronously.
// One macrotask is enough to flush the chain past toFile.
function flushMicrotasks() {
  return new Promise((r) => setTimeout(r, 10));
}

test("barge-in during transcribing: stale STT completing last clobbers new request", async () => {
  // This test reproduces the race condition where the user barges in
  // during transcribing and the second (current) STT returns before
  // the first (stale) STT. The stale sendUserMessage then aborts the
  // current prompt.
  const { client, calls: sttCalls } = makeDeferredSttClient();
  const sentMessages = [];
  const ws = new MockWebSocket();
  const { deps } = makeSessionDeps();
  deps.client = client;
  // Mirror the production connection wrapper: rearmTurn before each
  // prompt so the lifecycle stays active for the new turn's deltas.
  let session;
  deps.sendUserMessage = (text) => {
    session.rearmTurn();
    sentMessages.push(text);
  };
  session = new WebSession(ws, deps);
  ws.sent = []; // clear hello

  // Simulate first utterance: audio_start → pcm → audio_end.
  ws.emit("message", JSON.stringify({ type: "audio_start" }), false);
  ws.emit("message", dummyPcm(), true);
  ws.emit("message", JSON.stringify({ type: "audio_end", sampleRate: 16000 }), false);
  await flushMicrotasks();

  // finishUtterance #1 is now awaiting STT.
  assert.equal(sttCalls.length, 1, "first audio_end should trigger STT");

  // Barge-in: audio_start clears pcmChunks, new pcm, audio_end.
  ws.emit("message", JSON.stringify({ type: "audio_start" }), false);
  ws.emit("message", dummyPcm(), true);
  ws.emit("message", JSON.stringify({ type: "audio_end", sampleRate: 16000 }), false);
  await flushMicrotasks();

  // finishUtterance #2 is now also awaiting STT.
  assert.equal(sttCalls.length, 2, "second audio_end should trigger another STT");

  // Second STT returns first (shorter audio, faster to transcribe).
  sttCalls[1].resolve({ text: "new request" });
  await flushMicrotasks();

  // First (stale) STT returns after.
  sttCalls[0].resolve({ text: "old request" });
  await flushMicrotasks();

  // BUG: without a guard, both texts are sent to sendUserMessage.
  // The stale "old request" arrives LAST and clobbers the "new request"
  // that was already processing. The fix must ensure only the most
  // recent utterance's text is forwarded.
  assert.equal(sentMessages.length, 1,
    "only the most recent utterance should be sent to sendUserMessage");
  assert.equal(sentMessages[0], "new request",
    "the new request must be the one sent, not the stale old request");
});

test("barge-in during transcribing: stale STT returning empty does not break new request", async () => {
  // Variant: first STT returns empty (false-positive VAD) while second
  // STT returns valid text. The revert() for the empty result must not
  // corrupt the turn lifecycle for the second request.
  const { client, calls: sttCalls } = makeDeferredSttClient();
  const sentMessages = [];
  const ws = new MockWebSocket();
  const { deps } = makeSessionDeps();
  deps.client = client;
  // Mirror the production connection wrapper: rearmTurn before each
  // prompt so the lifecycle stays active for the new turn's deltas.
  let session;
  deps.sendUserMessage = (text) => {
    session.rearmTurn();
    sentMessages.push(text);
  };
  session = new WebSession(ws, deps);
  ws.sent = []; // clear hello

  // First utterance.
  ws.emit("message", JSON.stringify({ type: "audio_start" }), false);
  ws.emit("message", dummyPcm(), true);
  ws.emit("message", JSON.stringify({ type: "audio_end", sampleRate: 16000 }), false);
  await flushMicrotasks();
  assert.equal(sttCalls.length, 1);

  // Barge-in: second utterance.
  ws.emit("message", JSON.stringify({ type: "audio_start" }), false);
  ws.emit("message", dummyPcm(), true);
  ws.emit("message", JSON.stringify({ type: "audio_end", sampleRate: 16000 }), false);
  await flushMicrotasks();
  assert.equal(sttCalls.length, 2);

  // First STT returns empty (VAD false positive).
  sttCalls[0].resolve({ text: "" });
  await flushMicrotasks();

  // Second STT returns with real text.
  sttCalls[1].resolve({ text: "hello world" });
  await flushMicrotasks();

  // The second (current) request must still be processed.
  assert.equal(sentMessages.length, 1, "valid second utterance must be processed");
  assert.equal(sentMessages[0], "hello world");

  // Verify the turn lifecycle is in a healthy state: LLM events should
  // be forwarded (turn is active).
  assert.equal(session.voiceTurnInFlight, true,
    "turn must be active after processing the second utterance");
});

