import type OpenAI from "openai";
import { toFile } from "openai/uploads";

export async function transcribe(
  client: OpenAI,
  wav: Buffer,
  model: string,
): Promise<string> {
  const file = await toFile(wav, "audio.wav", { type: "audio/wav" });
  const r = await client.audio.transcriptions.create({ file, model });
  return (r as { text?: string }).text ?? "";
}
