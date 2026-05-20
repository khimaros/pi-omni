import { test } from "node:test";
import assert from "node:assert/strict";

// Helper to set up a clean mock DOM
function setupMockDOM(options = {}) {
  const elements = {};
  
  class MockElement {
    constructor(tagName = "div", id = "") {
      this.tagName = tagName;
      this.id = id;
      this.classList = {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          } else if (force) {
            this.classes.add(c);
          } else {
            this.classes.delete(c);
          }
        },
        contains(c) { return this.classes.has(c); }
      };
      this.children = [];
      this.childNodes = [];
      this.textContent = "";
      this.listeners = {};
      this.style = {};
    }
    
    get firstChild() {
      return this.childNodes[0];
    }
    
    querySelector(sel) {
      if (sel === ".dot") return new MockElement("div");
      if (sel === "#orb .glyph" || sel === ".glyph") return new MockElement("span");
      return new MockElement();
    }
    
    addEventListener(event, listener) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(listener);
    }
    
    trigger(event, data) {
      if (this.listeners[event]) {
        for (const listener of this.listeners[event]) {
          listener(data);
        }
      }
    }
    
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
    }
    
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      this.childNodes = this.childNodes.filter((c) => c !== child);
    }

    setAttribute(name, value) {
      this[name] = value;
    }
  }

  const getOrCreate = (id) => {
    if (!elements[id]) {
      elements[id] = new MockElement("div", id);
    }
    return elements[id];
  };

  global.document = {
    body: new MockElement("body"),
    getElementById(id) {
      return getOrCreate(id);
    },
    createElement(tag) {
      return new MockElement(tag);
    },
    querySelector(sel) {
      if (sel === "#orb .glyph") return getOrCreate("orb-glyph");
      return new MockElement();
    },
    addEventListener(event, listener) {},
  };

  class MockAudioNode {
    constructor() {
      this.gain = {
        value: 1.0,
        cancelScheduledValues() {},
        setValueAtTime() {},
        linearRampToValueAtTime() {},
      };
      this.delayTime = {
        value: 0.0,
      };
    }
    connect() {}
  }

  global.window = {
    isSecureContext: true,
    addEventListener(event, listener) {},
    AudioContext: class {
      constructor() {
        this.state = "suspended";
        this.currentTime = 0;
        this.audioWorklet = {
          async addModule() {}
        };
        this.destination = {};
      }
      async resume() {
        this.state = "running";
      }
      createGain() { return new MockAudioNode(); }
      createDelay() { return new MockAudioNode(); }
    },
    webkitAudioContext: class {},
    location: {
      protocol: "http:",
      host: "localhost",
      pathname: "/",
      search: "",
      hash: options.hash || "",
      replace(url) {
        this.hash = url.includes("#") ? url.substring(url.indexOf("#")) : "";
      }
    },
  };
  global.location = global.window.location;
  
  Object.defineProperty(global, "navigator", {
    value: {
      userAgent: "mock",
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks() { return []; }
        })
      }
    },
    configurable: true,
    writable: true,
  });

  global.AudioWorkletNode = class {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage(msg) {}
      };
    }
    connect() {}
  };

  global.localStorage = {
    getItem(key) { return this[key] || null; },
    setItem(key, value) { this[key] = String(value); },
    removeItem(key) { delete this[key]; },
  };

  global.fetch = async (url) => {
    return {
      ok: true,
      headers: {
        get(name) { return "1024"; },
      },
      body: {
        getReader() {
          let readCount = 0;
          return {
            async read() {
              if (readCount > 0) return { done: true };
              readCount++;
              return { done: false, value: new Uint8Array(1024) };
            }
          };
        }
      }
    };
  };

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.readyState = 0; // CONNECTING
      this.binaryType = "blob";
      MockWebSocket.lastInstance = this;
      setTimeout(() => {
        this.readyState = 1; // OPEN
        this.trigger("open");
      }, 0);
    }
    addEventListener(event, listener) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(listener);
    }
    trigger(event, data) {
      if (this.listeners[event]) {
        for (const listener of this.listeners[event]) {
          listener(data);
        }
      }
    }
    close() {
      this.readyState = 3; // CLOSED
      this.trigger("close");
    }
  }
  MockWebSocket.CLOSED = 3;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.lastInstance = null;
  global.WebSocket = MockWebSocket;

  return { elements, MockWebSocket };
}

// Clean up globals after all tests run
test.after(() => {
  delete global.document;
  delete global.window;
  delete global.navigator;
  delete global.AudioWorkletNode;
  delete global.localStorage;
  delete global.fetch;
  delete global.WebSocket;
});

test("onboarding instructions are shown when starting a new session with empty history", async () => {
  const { elements, MockWebSocket } = setupMockDOM({ hash: "" });
  
  // Dynamically load app.js to trigger startup side effects with our mock globals
  await import("../public/app.js?t=" + Date.now());
  
  // Wait for the websocket connection to settle and hello message to be processed
  await new Promise((resolve) => setTimeout(resolve, 50));
  
  const wsInstance = MockWebSocket.lastInstance;
  assert.ok(wsInstance, "WebSocket instance should be created");
  
  // Send "hello" message with no history and autostart enabled (simulating server default)
  wsInstance.trigger("message", {
    data: JSON.stringify({
      type: "hello",
      sessionId: "test-session-id",
      autoStart: true,
      lastUserText: "",
      lastAssistantText: ""
    })
  });
  
  // Wait for hello message processing and any autostart promises to settle
  await new Promise((resolve) => setTimeout(resolve, 50));
  
  const startHint = elements["start-hint"];
  
  // Since this is a new session with empty history, the onboarding instructions MUST remain visible
  assert.equal(
    startHint.classList.contains("hidden"),
    false,
    "start-hint should NOT be hidden for a new session with empty history"
  );
});
