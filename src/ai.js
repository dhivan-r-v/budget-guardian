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

// One turn of a tool-using conversation. `contents` is the conversation so far (Gemini
// format); returns the model's turn to append, the tool calls it asked for, and any text.
export async function chatTurn({ system, contents, functionDeclarations, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
  const response = await client.models.generateContent({
    model: AI_MODEL,
    contents,
    config: {
      systemInstruction: system,
      tools: [{ functionDeclarations }],
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(timeoutMs),
    },
  });
  const content = response.candidates?.[0]?.content ?? { role: 'model', parts: [] };
  return {
    content: { role: 'model', parts: content.parts ?? [] },
    calls: (response.functionCalls ?? []).map((c) => ({ name: c.name, args: c.args ?? {} })),
    text: (content.parts ?? []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join(''),
  };
}
