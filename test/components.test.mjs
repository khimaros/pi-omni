// Tests for the LLM-component label formatter AND the transient
// assistant-display reducer that decides whether the assistant slot
// shows the most recent indicator chip or the streaming answer text.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatComponent,
  reduceAssistant,
  initialAssistant,
} from "../public/components.js";

// ─── label formatter ────────────────────────────────────────────────

test("thinking → 'thinking'", () => {
  assert.equal(formatComponent({ kind: "thinking" }), "thinking");
});

test("tool call with name → 'tool: <name>'", () => {
  assert.equal(
    formatComponent({ kind: "tool_call", name: "persona_datetime" }),
    "tool: persona_datetime",
  );
});

test("tool call without name → 'tool'", () => {
  assert.equal(formatComponent({ kind: "tool_call" }), "tool");
});

test("tool result ok → 'tool: <name> ok'", () => {
  assert.equal(
    formatComponent({ kind: "tool_result", name: "persona_datetime", ok: true }),
    "tool: persona_datetime ok",
  );
});

test("tool result error → 'tool: <name> error'", () => {
  assert.equal(
    formatComponent({ kind: "tool_result", name: "bash", ok: false }),
    "tool: bash error",
  );
});

test("unknown kind → fallback to the kind string", () => {
  assert.equal(formatComponent({ kind: "weird_event" }), "weird_event");
});

test("missing kind → 'event'", () => {
  assert.equal(formatComponent({}), "event");
  assert.equal(formatComponent(null), "event");
});

test("never contains emoji", () => {
  const all = [
    { kind: "thinking" },
    { kind: "tool_call", name: "x" },
    { kind: "tool_result", name: "x", ok: true },
    { kind: "tool_result", name: "x", ok: false },
    { kind: "unknown" },
  ];
  const emojiRe = /[\p{Extended_Pictographic}]/u;
  for (const c of all) {
    assert.ok(!emojiRe.test(formatComponent(c)), `emoji leaked into ${JSON.stringify(c)}`);
  }
});

// ─── transient display reducer ──────────────────────────────────────
// The assistant slot shows AT MOST ONE chip at a time (the most recent
// indicator) OR the streaming answer text. Once text starts arriving,
// the chip is dropped -- the answer supersedes the in-progress meta.

test("initial state is empty", () => {
  assert.deepEqual(initialAssistant, { chip: null, text: "" });
});

test("first component sets the chip", () => {
  const s = reduceAssistant(initialAssistant, { type: "component", value: "thinking" });
  assert.deepEqual(s, { chip: "thinking", text: "" });
});

test("second component REPLACES the first (not appended)", () => {
  let s = reduceAssistant(initialAssistant, { type: "component", value: "thinking" });
  s = reduceAssistant(s, { type: "component", value: "tool: persona_datetime" });
  assert.deepEqual(s, { chip: "tool: persona_datetime", text: "" });
});

test("delta text clears the chip and appends to text", () => {
  let s = reduceAssistant(initialAssistant, { type: "component", value: "thinking" });
  s = reduceAssistant(s, { type: "delta", text: "Hello" });
  assert.deepEqual(s, { chip: null, text: "Hello" });
  s = reduceAssistant(s, { type: "delta", text: " world" });
  assert.deepEqual(s, { chip: null, text: "Hello world" });
});

test("full text clears the chip and replaces text", () => {
  let s = reduceAssistant(initialAssistant, { type: "component", value: "thinking" });
  s = reduceAssistant(s, { type: "delta", text: "draft" });
  s = reduceAssistant(s, { type: "text", text: "Final answer." });
  assert.deepEqual(s, { chip: null, text: "Final answer." });
});

test("component AFTER text is ignored -- chip must not reappear next to the answer", () => {
  // Once the answer text has begun streaming, late indicator events
  // (a delayed thinking_end fired after text_delta, or a follow-on
  // toolcall_end) must NOT reattach a chip. The answer is the durable
  // display; chips are pre-answer activity only. Reattaching them
  // leaves the UI showing "[thinking] hello" forever.
  let s = reduceAssistant(initialAssistant, { type: "delta", text: "Hello" });
  s = reduceAssistant(s, { type: "component", value: "tool: bash" });
  assert.deepEqual(s, { chip: null, text: "Hello" });
});

test("reset clears both chip and text", () => {
  let s = reduceAssistant(initialAssistant, { type: "component", value: "thinking" });
  s = reduceAssistant(s, { type: "delta", text: "Hello" });
  s = reduceAssistant(s, { type: "reset" });
  assert.deepEqual(s, { chip: null, text: "" });
});

test("placeholder fills the chip slot when text is empty", () => {
  const s = reduceAssistant(initialAssistant, { type: "placeholder" });
  assert.deepEqual(s, { chip: "(no response)", text: "" });
});

test("placeholder is a no-op if text already streamed", () => {
  let s = reduceAssistant(initialAssistant, { type: "delta", text: "Hello" });
  s = reduceAssistant(s, { type: "placeholder" });
  assert.deepEqual(s, { chip: null, text: "Hello" });
});
