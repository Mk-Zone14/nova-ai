const assert = require('node:assert/strict');
const test = require('node:test');
const { callModel, parseModelJson, respondWithError, UpstreamError, InvalidModelOutputError, TruncatedOutputError, UNAVAILABLE_MESSAGE } = require('../lib/model');

const realFetch = global.fetch;
const env = { key: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL };
test.afterEach(() => {
  global.fetch = realFetch;
  if (env.key === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = env.key;
  if (env.model === undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL = env.model;
});

const SECRET = 'gsk_test_secret_value';
const reply = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const okBody = (content = '{"a":1}', extra = {}) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 45 }, ...extra });
const call = () => callModel({ system: 'SYSTEM PROMPT with profile text', user: 'USER', deadline: Date.now() + 10_000, maxMs: 5_000 });
function capture(method) {
  const lines = [];
  const original = console[method];
  console[method] = (...args) => lines.push(args.map(String).join(' '));
  return { lines, restore: () => { console[method] = original; } };
}
function res() {
  return { headers: {}, statusCode: null, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('request construction: endpoint, bearer auth, JSON mode, default model, low temperature, abort signal', async () => {
  process.env.GROQ_API_KEY = SECRET;
  delete process.env.GROQ_MODEL;
  let seen;
  global.fetch = async (url, options) => { seen = { url, options }; return reply(okBody())(); };
  const quiet = capture('info');
  try { assert.equal(await call(), '{"a":1}'); } finally { quiet.restore(); }
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(seen.options.headers['Content-Type'], 'application/json');
  assert.ok(seen.options.signal instanceof AbortSignal, 'every call must be abortable');
  const body = JSON.parse(seen.options.body);
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
});

test('GROQ_MODEL overrides the default model', async () => {
  process.env.GROQ_API_KEY = SECRET;
  process.env.GROQ_MODEL = 'some/other-model';
  let model;
  global.fetch = async (url, options) => { model = JSON.parse(options.body).model; return reply(okBody())(); };
  const quiet = capture('info');
  try { await call(); } finally { quiet.restore(); }
  assert.equal(model, 'some/other-model');
});

test('usage logging records latency, token counts and finish reason, and nothing sensitive', async () => {
  process.env.GROQ_API_KEY = SECRET;
  global.fetch = async () => reply(okBody('{"secretAnswer":"the model said this"}', { usage: { prompt_tokens: 120.4, completion_tokens: 45 } }))();
  const logs = capture('info');
  try { await call(); } finally { logs.restore(); }
  const line = logs.lines.join('\n');
  assert.match(line, /Groq call ok: model=openai\/gpt-oss-120b ms=\d+ prompt_tokens=120 completion_tokens=45 finish=stop/);
  assert.doesNotMatch(line, new RegExp(`${SECRET}|SYSTEM PROMPT|profile text|secretAnswer|the model said`), 'prompts, completions and the key never reach the log');
});

test('usage logging tolerates missing or hostile usage fields', async () => {
  process.env.GROQ_API_KEY = SECRET;
  global.fetch = async () => reply({ choices: [{ message: { content: '{}' }, finish_reason: 'x\ny; DROP' }], usage: { prompt_tokens: 'many', completion_tokens: null } })();
  const logs = capture('info');
  try { await call(); } finally { logs.restore(); }
  assert.match(logs.lines.join(''), /prompt_tokens=n\/a completion_tokens=n\/a finish=n\/a/);
  assert.equal(logs.lines.length, 1);
});

test('provider failures keep their status even when the body is not JSON', async () => {
  process.env.GROQ_API_KEY = SECRET;
  for (const status of [401, 403, 429, 500, 502, 503]) {
    global.fetch = async () => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });
    await assert.rejects(call(), (error) => error instanceof UpstreamError && error.status === status, `status ${status}`);
  }
});

test('HTTP 200 with no content or a non-JSON body is invalid model output, not an upstream error', async () => {
  process.env.GROQ_API_KEY = SECRET;
  for (const body of [{ choices: [] }, { choices: [{ message: { content: '' } }] }, { choices: [{ message: { content: null } }] }, {}, null]) {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
    await assert.rejects(call(), InvalidModelOutputError);
  }
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
  await assert.rejects(call(), InvalidModelOutputError);
});

test('parseModelJson rejects truncated, array, scalar and oversized output', () => {
  for (const bad of ['{"a":', '[1,2]', '"text"', '42', 'null', '', undefined, `{"a":"${'x'.repeat(1_000_001)}"}`]) {
    assert.throws(() => parseModelJson(bad), InvalidModelOutputError);
  }
  assert.deepEqual(parseModelJson('{"a":[1]}'), { a: [1] });
});

test('timeouts abort the provider call and an exhausted budget never reaches the network', async () => {
  process.env.GROQ_API_KEY = SECRET;
  let calls = 0;
  global.fetch = (url, options) => { calls += 1; return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); };
  await assert.rejects(callModel({ system: 's', user: 'u', deadline: Date.now() + 10_000, maxMs: 30 }), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(callModel({ system: 's', user: 'u', deadline: Date.now() + 200, maxMs: 5_000 }), { name: 'AbortError' });
  assert.equal(calls, 1, 'under one second of budget left: do not start another call');
});

test('every provider failure maps to a safe public response', () => {
  const quiet = capture('error');
  try {
    const cases = [
      [new UpstreamError(401), 503, UNAVAILABLE_MESSAGE], [new UpstreamError(403), 503, UNAVAILABLE_MESSAGE],
      [new UpstreamError(429), 503, /busy/], [new UpstreamError(500), 502, /could not complete/],
      [Object.assign(new Error('x'), { name: 'AbortError' }), 504, /timed out/], [new InvalidModelOutputError(), 502, /reliable/],
      [new TypeError(`fetch failed ${SECRET}`), 502, /could not complete/]
    ];
    for (const [error, status, message] of cases) {
      const out = res();
      respondWithError(out, error, 'Test');
      assert.equal(out.statusCode, status, error.name);
      assert.match(out.body.error, message instanceof RegExp ? message : new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(JSON.stringify(out.body), new RegExp(`${SECRET}|GROQ|Groq|Vercel`));
    }
    assert.doesNotMatch(quiet.lines.join('\n'), new RegExp(SECRET), 'even an error carrying the key in its message is not logged');
  } finally { quiet.restore(); }
});

test('a reply that stopped on the output-token limit is rejected even when its JSON happens to parse', async () => {
  process.env.GROQ_API_KEY = SECRET;
  // A complete-looking object with sections missing: valid JSON, but finish=length means it was cut off.
  global.fetch = async () => reply({ choices: [{ message: { content: '{"strengths":["a"]}' }, finish_reason: 'length' }], usage: { prompt_tokens: 2300, completion_tokens: 3060 } })();
  const info = capture('info');
  const warn = capture('warn');
  try {
    await assert.rejects(call(), (error) => error instanceof TruncatedOutputError && error instanceof InvalidModelOutputError);
  } finally { info.restore(); warn.restore(); }
  assert.match(info.lines.join(''), /completion_tokens=3060 finish=length/, 'the usage line is still logged, so the cause is visible');
  assert.match(warn.lines.join(''), /finish=length/);
  const out = res();
  respondWithError(out, new TruncatedOutputError());
  assert.equal(out.statusCode, 502, 'surfaces as a retryable error, never as partial content');
});

test('only finish=length is treated as truncation', async () => {
  process.env.GROQ_API_KEY = SECRET;
  for (const finish of ['stop', undefined, 'tool_calls']) {
    global.fetch = async () => reply({ choices: [{ message: { content: '{"a":1}' }, finish_reason: finish }], usage: {} })();
    const quiet = capture('info');
    try { assert.equal(await call(), '{"a":1}'); } finally { quiet.restore(); }
  }
});
