import { test } from 'node:test';
import assert from 'node:assert/strict';

// Configure an OpenAI-compatible provider (no Gemini) before ai.js reads the environment.
process.env.AI_API_KEY = 'test-key';
process.env.AI_BASE_URL = 'https://llm.example.com/v1/';
delete process.env.AI_PROVIDER;
delete process.env.AI_MODEL;
delete process.env.AI_AGENT_MODEL;
delete process.env.GEMINI_API_KEY;
const ai = await import('../src/ai.js');

// A fake chat completions endpoint: records requests, answers with `message` (or an error).
function fakeFetch(answer, status = 200) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const body = status === 200 ? { choices: [{ message: answer }] } : { error: { message: answer } };
    return { ok: status === 200, status, json: async () => body };
  };
  return { requests, fetchImpl };
}

test('open models are the default: Qwen for JSON, gpt-oss-120b for the agent', () => {
  assert.equal(ai.aiAvailable(), true);
  assert.equal(ai.AI_MODEL, 'qwen/qwen3.8-27b');
  assert.equal(ai.AGENT_MODEL, 'openai/gpt-oss-120b');
});

test('JSON answers are parsed even with reasoning or a code fence around them', async () => {
  assert.deepEqual(ai.parseJsonText('{"a":1}'), { a: 1 });
  assert.deepEqual(ai.parseJsonText('<think>let me see {"no":1}</think>\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(ai.parseJsonText('Sure! {"a":3} Hope that helps.'), { a: 3 });

  const { requests, fetchImpl } = fakeFetch({ content: '<think>…</think>{"headline":"Fuel is up"}' });
  const out = await ai.generateJson({ system: 'S', prompt: 'P', schema: { type: 'object' } }, { fetchImpl });
  assert.deepEqual(out, { headline: 'Fuel is up' });
  const [req] = requests;
  assert.equal(req.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(req.headers.Authorization, 'Bearer test-key');
  assert.equal(req.body.model, 'qwen/qwen3.8-27b');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.match(req.body.messages[0].content, /^S\n\nAnswer with one JSON object only, matching this JSON schema:\n\{"type":"object"\}$/);
});

test('an unusable answer or an API error throws (callers then use code-written text)', async () => {
  await assert.rejects(ai.generateJson({ system: 'S', prompt: 'P', schema: {} }, fakeFetch({ content: 'no json here' })), /not valid JSON/);
  await assert.rejects(ai.generateJson({ system: 'S', prompt: 'P', schema: {} }, fakeFetch('Rate limit reached', 429)), (err) => err.status === 429 && /Rate limit/.test(err.message));
});

test('the agent conversation converts to OpenAI messages, tool calls matched to their results', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'Goal: get back under budget.' }] },
    { role: 'model', parts: [{ functionCall: { name: 'getBudgetStatus', args: {} } }, { functionCall: { name: 'getPlanOptions', args: { category: 'fuel' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'getBudgetStatus', response: { result: { over: '$25.00' } } } }, { functionResponse: { name: 'getPlanOptions', response: { result: [] } } }] },
    { role: 'model', parts: [{ text: 'Thinking.' }] },
    { role: 'user', parts: [{ text: 'Finish by calling proposePlan.' }] },
  ];
  assert.deepEqual(ai.toOpenAIMessages('SYS', contents), [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'Goal: get back under budget.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1_0', type: 'function', function: { name: 'getBudgetStatus', arguments: '{}' } },
        { id: 'call_1_1', type: 'function', function: { name: 'getPlanOptions', arguments: '{"category":"fuel"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1_0', content: '{"result":{"over":"$25.00"}}' },
    { role: 'tool', tool_call_id: 'call_1_1', content: '{"result":[]}' },
    { role: 'assistant', content: 'Thinking.' },
    { role: 'user', content: 'Finish by calling proposePlan.' },
  ]);
});

test("the agent's tool calls come back in the app's format", async () => {
  const { requests, fetchImpl } = fakeFetch({
    content: null,
    tool_calls: [
      { id: 'x1', type: 'function', function: { name: 'getSpikes', arguments: '{}' } },
      { id: 'x2', type: 'function', function: { name: 'simulate', arguments: '{"optionIds":["fuel:public_transport:2"]}' } },
      { id: 'x3', type: 'function', function: { name: 'getPlanHistory', arguments: 'not json' } },
    ],
  });
  const tools = [{ name: 'getSpikes', description: 'd', parametersJsonSchema: { type: 'object', properties: {} } }];
  const turn = await ai.chatTurn({ system: 'S', contents: [{ role: 'user', parts: [{ text: 'go' }] }], functionDeclarations: tools }, { fetchImpl });
  assert.deepEqual(turn.calls, [
    { name: 'getSpikes', args: {} },
    { name: 'simulate', args: { optionIds: ['fuel:public_transport:2'] } },
    { name: 'getPlanHistory', args: {} },
  ]);
  assert.deepEqual(turn.content.parts.map((p) => p.functionCall.name), ['getSpikes', 'simulate', 'getPlanHistory']);
  assert.equal(requests[0].body.model, 'openai/gpt-oss-120b');
  assert.deepEqual(requests[0].body.tools[0], { type: 'function', function: { name: 'getSpikes', description: 'd', parameters: { type: 'object', properties: {} } } });
});
