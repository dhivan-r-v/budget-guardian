// The only file that talks to an LLM provider. Swapping providers means changing this file.
import { GoogleGenAI } from '@google/genai';

export const AI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
// The free tier sometimes stalls; give up and let callers fall back rather than hang a request.
const DEFAULT_TIMEOUT_MS = 15_000;

export function aiAvailable() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

let client;

// Asks the model for JSON matching `schema` and returns it parsed. Throws on any failure,
// including when no answer arrives within `timeoutMs`.
export async function generateJson({ system, prompt, schema, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
  const response = await client.models.generateContent({
    model: AI_MODEL,
    contents: prompt,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      temperature: 0.4,
      abortSignal: AbortSignal.timeout(timeoutMs),
    },
  });
  return JSON.parse(response.text);
}
