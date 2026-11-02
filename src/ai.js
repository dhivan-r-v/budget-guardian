// The only file that talks to LLM providers.
//
// Two kinds of provider:
//   - "openai": any OpenAI-compatible API serving open models (Groq by default; also
//     OpenRouter, NVIDIA NIM, Moonshot, Together...). AI_API_KEY, AI_BASE_URL, AI_MODEL,
//     and AI_AGENT_MODEL for the tool-using rescue agent.
//   - "gemini": Google's API (GEMINI_API_KEY, GEMINI_MODEL).
// With both configured, the open model answers first and Gemini takes over when it fails
// (rate limit, outage, timeout, unusable answer), so one free tier running dry doesn't stop
// the app. Callers still validate everything and fall back to code-written text.
//
// The conversation format for chatTurn() is Gemini's (role user/model, parts with text,
// functionCall, functionResponse); the OpenAI provider converts it both ways.
import { GoogleGenAI } from '@google/genai';

const DEFAULT_TIMEOUT_MS = 15_000;
const GROQ = 'https://api.groq.com/openai/v1';

const env = (k) => process.env[k]?.trim() || '';
const openaiKey = () => env('AI_API_KEY');
const geminiKey = () => env('GEMINI_API_KEY');
const useOpenAI = () => Boolean(openaiKey()) && env('AI_PROVIDER') !== 'gemini';

const GEMINI_MODEL = env('GEMINI_MODEL') || 'gemini-flash-lite-latest';
// Model names, used in cache keys (a different model means fresh answers) and shown in the UI.
export const AI_MODEL = useOpenAI() ? env('AI_MODEL') || 'qwen/qwen3.8-27b' : GEMINI_MODEL;
export const AGENT_MODEL = useOpenAI() ? env('AI_AGENT_MODEL') || env('AI_MODEL') || 'openai/gpt-oss-120b' : GEMINI_MODEL;

export function aiAvailable() {
  return Boolean(openaiKey() || geminiKey());
}

export class AIError extends Error {
  constructor(provider, status, message) {
    super(`${provider}: ${message}`);
    this.provider = provider;
    this.status = status;
  }
}

// Tries the open model, then Gemini (when both are set up).
async function withFallback(openaiCall, geminiCall) {
  if (useOpenAI()) {
    try {
      return await openaiCall();
    } catch (err) {
      if (!geminiKey()) throw err;
      console.warn(`Open model failed (${err.message}); falling back to Gemini.`);
    }
  }
  if (!geminiKey()) throw new AIError('ai', 503, 'no AI provider configured');
  return geminiCall();
}

// --- OpenAI-compatible provider

// Free tiers limit tokens per minute and answer 429 with "try again in 1.2s"; a short wait
// like that is worth one retry.
const MAX_RETRY_WAIT_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openaiRequest(body, timeoutMs, fetchImpl = fetch, retried = false) {
  const base = (env('AI_BASE_URL') || GROQ).replace(/\/$/, '');
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429 && !retried) {
    const m = String(data.error?.message ?? '').match(/try again in ([\d.]+)(ms|s)/i);
    const waitMs = m ? Number(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1) + 250 : null;
    if (waitMs !== null && waitMs <= MAX_RETRY_WAIT_MS) {
      await sleep(waitMs);
      return openaiRequest(body, timeoutMs, fetchImpl, true);
    }
  }
  if (!res.ok) throw new AIError('openai', res.status, data.error?.message ?? `request failed (${res.status})`);
  const message = data.choices?.[0]?.message;
  if (!message) throw new AIError('openai', 502, 'empty response');
  return message;
}

// Reasoning models may wrap their answer in <think>...</think> or a ```json fence.
export function parseJsonText(text) {
  const cleaned = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1);
  return JSON.parse(body);
}

async function openaiJson({ system, prompt, schema, timeoutMs }, fetchImpl) {
  const message = await openaiRequest({
    model: AI_MODEL,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${system}\n\nAnswer with one JSON object only, matching this JSON schema:\n${JSON.stringify(schema)}` },
      { role: 'user', content: prompt },
    ],
  }, timeoutMs, fetchImpl);
  try {
    return parseJsonText(message.content);
  } catch {
    throw new AIError('openai', 502, 'answer was not valid JSON');
  }
}

// Gemini-format conversation -> OpenAI messages. A model turn's function calls get ids by
// position, and the next user turn's function responses answer them in the same order.
export function toOpenAIMessages(system, contents) {
  const messages = [{ role: 'system', content: system }];
  contents.forEach((c, turn) => {
    const parts = c.parts ?? [];
    if (c.role === 'model') {
      const calls = parts.filter((p) => p.functionCall);
      const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length && {
          tool_calls: calls.map((p, i) => ({ id: `call_${turn}_${i}`, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } })),
        }),
      });
      return;
    }
    const responses = parts.filter((p) => p.functionResponse);
    if (responses.length) {
      responses.forEach((p, i) => messages.push({ role: 'tool', tool_call_id: `call_${turn - 1}_${i}`, content: JSON.stringify(p.functionResponse.response) }));
    } else {
      messages.push({ role: 'user', content: parts.map((p) => p.text ?? '').join('') });
    }
  });
  return messages;
}

async function openaiChatTurn({ system, contents, functionDeclarations, timeoutMs }, fetchImpl) {
  const message = await openaiRequest({
    model: AGENT_MODEL,
    temperature: 0.3,
    messages: toOpenAIMessages(system, contents),
    tools: functionDeclarations.map((f) => ({ type: 'function', function: { name: f.name, description: f.description, parameters: f.parametersJsonSchema } })),
    tool_choice: 'auto',
  }, timeoutMs, fetchImpl);
  const calls = (message.tool_calls ?? []).map((t) => {
    let args = {};
    try {
      args = JSON.parse(t.function.arguments || '{}');
    } catch {
      args = {};
    }
    return { name: t.function.name, args };
  });
  const text = String(message.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return {
    content: { role: 'model', parts: [...(text ? [{ text }] : []), ...calls.map((c) => ({ functionCall: c }))] },
    calls,
    text,
  };
}

// --- Gemini provider

let gemini;
const geminiClient = () => (gemini ??= new GoogleGenAI({ apiKey: geminiKey() }));

async function geminiJson({ system, prompt, schema, timeoutMs }) {
  const response = await geminiClient().models.generateContent({
    model: GEMINI_MODEL,
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

async function geminiChatTurn({ system, contents, functionDeclarations, timeoutMs }) {
  const response = await geminiClient().models.generateContent({
    model: GEMINI_MODEL,
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

// --- The two calls the app uses

// Asks for JSON matching `schema` and returns it parsed. Throws on any failure, including
// no answer within `timeoutMs`.
export function generateJson({ system, prompt, schema, timeoutMs = DEFAULT_TIMEOUT_MS }, { fetchImpl } = {}) {
  const args = { system, prompt, schema, timeoutMs };
  return withFallback(() => openaiJson(args, fetchImpl), () => geminiJson(args));
}

// The agent's providers, in order: the open model, then Gemini. A conversation can't move
// from one to the other halfway (Gemini requires its own signatures on earlier tool calls),
// so the caller restarts with the next provider instead.
export function agentProviders({ fetchImpl } = {}) {
  const out = [];
  if (useOpenAI()) out.push(Object.assign((args) => openaiChatTurn({ timeoutMs: DEFAULT_TIMEOUT_MS, ...args }, fetchImpl), { model: AGENT_MODEL }));
  if (geminiKey()) out.push(Object.assign((args) => geminiChatTurn({ timeoutMs: DEFAULT_TIMEOUT_MS, ...args }), { model: GEMINI_MODEL }));
  return out;
}

// One turn of a tool-using conversation, with the first available provider. Returns the
// model's turn to append (Gemini format), the tool calls it asked for, and any text.
export function chatTurn({ system, contents, functionDeclarations, timeoutMs = DEFAULT_TIMEOUT_MS }, { fetchImpl } = {}) {
  const args = { system, contents, functionDeclarations, timeoutMs };
  return withFallback(() => openaiChatTurn(args, fetchImpl), () => geminiChatTurn(args));
}
