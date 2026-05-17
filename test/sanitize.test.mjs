import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeForSpeech } from "../dist/audio/sanitize.js";

test("strips fenced code blocks", () => {
  const input = "Here is code:\n```js\nconst x = 1;\n```\nDone.";
  const out = sanitizeForSpeech(input);
  assert.equal(out.includes("const x"), false);
  assert.match(out, /Here is code/);
  assert.match(out, /Done\./);
});

test("unwraps inline code, bold, italic", () => {
  assert.equal(sanitizeForSpeech("use `foo` here").trim(), "use foo here");
  assert.equal(sanitizeForSpeech("**bold** and *italic*").trim(), "bold and italic");
});

test("links collapse to their text", () => {
  assert.equal(sanitizeForSpeech("see [the docs](https://x.y)").trim(), "see the docs");
});

test("images collapse to alt text", () => {
  assert.equal(sanitizeForSpeech("![cat](cat.png) sits").trim(), "cat sits");
});

test("idempotent on plain text", () => {
  const s = "Hello, world. How are you?";
  assert.equal(sanitizeForSpeech(s), s);
});
