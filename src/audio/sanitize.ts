// Strip markdown / structural formatting from assistant text before TTS.
// We're optimizing for "sounds natural when read aloud", not lossless conversion.
export function sanitizeForSpeech(input: string): string {
  let s = input;

  // Drop fenced code blocks entirely (```lang\n...\n```). Reading code aloud
  // is universally bad. Same for ~~~ fences.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");

  // Indented code blocks (4-space prefix on consecutive lines). Drop.
  s = s.replace(/(^|\n)( {4}|\t)[^\n]*(?=\n|$)/g, "$1");

  // Inline code: `foo` → foo
  s = s.replace(/`([^`]+)`/g, "$1");

  // Images: ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Links: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Reference-style links: [text][ref] → text
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

  // Bold/italic/strikethrough wrappers (greedy unwrap).
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "$1");
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1");

  // Headings: leading # ## ### etc. Drop the hashes + any trailing #s.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  s = s.replace(/[ \t]+#+[ \t]*$/gm, "");

  // Blockquote markers.
  s = s.replace(/^[ \t]*>+[ \t]?/gm, "");

  // Bullet / numbered list markers at line start.
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  s = s.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");

  // Horizontal rules.
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "");

  // Tables: drop separator rows, keep cells joined with commas.
  s = s.replace(/^\s*\|?[ \t:|-]{3,}\|?\s*$/gm, "");
  s = s.replace(/\|/g, ", ");

  // HTML tags.
  s = s.replace(/<[^>]+>/g, "");

  // Collapse newlines + whitespace -- TTS reads as a continuous stream.
  s = s.replace(/\s+/g, " ");

  return s.trim();
}
