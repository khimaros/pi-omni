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
