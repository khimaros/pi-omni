// Format a single LLM-component descriptor into the short human-
// readable label shown as a chip in the assistant block. Pure: no DOM,
// no globals. The driver wraps the returned string in a styled span.
//
// Component shapes (mirrors the server WS messages):
//   { kind: "thinking" }
//   { kind: "tool_call", name: "<tool>" }
//   { kind: "tool_result", name: "<tool>", ok: true|false }
//
// Anything else falls back to the kind itself (or the generic "event"
// when even that's missing) — keeps the UI from blanking out on a
// future server-side extension we haven't taught the client about yet.
export function formatComponent(c) {
  if (!c || typeof c !== "object") return "event";
  const kind = typeof c.kind === "string" ? c.kind : null;
  if (!kind) return "event";
  if (kind === "thinking") return "thinking";
  if (kind === "tool_call") {
    return c.name ? `tool: ${c.name}` : "tool";
  }
  if (kind === "tool_result") {
    const status = c.ok ? "ok" : "error";
    return c.name ? `tool: ${c.name} ${status}` : `tool ${status}`;
  }
  return kind;
}

// Pure reducer for the contents of the assistant slot. The slot shows
// AT MOST ONE indicator chip (the most recent component for the turn)
// alongside the streaming answer text. Once any text streams, the chip
// is dropped — the durable answer supersedes in-progress meta. The
// driver renders {chip, text} after each event.
export const initialAssistant = Object.freeze({ chip: null, text: "" });

export function reduceAssistant(state, event) {
  switch (event?.type) {
    case "component":
      // Late components (after answer text has begun) are ignored — the
      // answer is the durable display, chips are pre-answer activity
      // only.
      if (state.text) return state;
      return { chip: event.value ?? null, text: state.text };
    case "delta":
      return { chip: null, text: state.text + (event.text ?? "") };
    case "text":
      return { chip: null, text: event.text ?? "" };
    case "placeholder":
      // Only show "(no response)" if no real answer streamed.
      if (state.text) return state;
      return { chip: "(no response)", text: "" };
    case "reset":
      return { chip: null, text: "" };
    default:
      return state;
  }
}
