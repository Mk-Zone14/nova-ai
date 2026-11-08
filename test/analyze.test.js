const assert = require('node:assert/strict');
const test = require('node:test');
const handler = require('../api/analyze');

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const PROFILE = 'Priya Sharma is a third-year B.Tech Computer Science student. Skills: JavaScript, Python, SQL. CGPA 8.6/10. Age 20. Indian citizen.';
const OPPORTUNITY = 'Product Engineering Intern. Eligibility: must be currently enrolled in an undergraduate degree. Required: strong JavaScript or Python. Preferred: React.';

function request(overrides = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { profile: PROFILE, opportunity: OPPORTUNITY },
    ...overrides
  };
}

const EXTRACT = {
  requirements: [
    { requirement: 'Currently enrolled in an undergraduate degree', sourceQuote: 'must be currently enrolled in an undergraduate degree', mandatory: true, hardEligibility: true },
    { requirement: 'Strong JavaScript or Python', sourceQuote: 'strong JavaScript or Python', mandatory: true, hardEligibility: false },
    { requirement: 'React', sourceQuote: 'Preferred: React', mandatory: false, hardEligibility: false }
  ]
};
const MATCH = {
  matches: [
    { requirementId: 'R1', status: 'Matched', evidenceQuote: 'third-year B.Tech Computer Science student', reasoning: 'Enrolled.' },
    { requirementId: 'R2', status: 'Matched', evidenceQuote: 'Skills: JavaScript, Python, SQL', reasoning: 'Lists both.' },
    { requirementId: 'R3', status: 'Missing', evidenceQuote: '', reasoning: 'No React mentioned.' }
  ]
};
const NARRATIVE = {
  coverLetter: 'Dear Atlas Labs,',
  // The model must not be able to set these:
  overallMatchScore: 5,
  eligibilityVerdict: 'Not eligible',
  acceptanceProbability: { percentage: 99 }
};

// Routes each Groq call by the STAGE marker in its system prompt.
function stagedFetch(stages, calls = []) {
  return async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    const stage = ['EXTRACT', 'MATCH', 'NARRATIVE'].find((name) => system.startsWith(`STAGE: ${name}`));
    calls.push(stage);
    const out = stages[stage];
    if (out instanceof Error) throw out;
    const content = typeof out === 'string' ? out : JSON.stringify(out);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
}
const report = (res) => JSON.parse(res.body.response);

async function run(overrides) {
  const res = response();
  await handler(request(overrides), res);
  return res;
}

const originalFetch = global.fetch;
const originalKey = process.env.GROQ_API_KEY;

test.beforeEach(() => handler.resetRateLimits());

test.after(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
});

test('rejects methods other than POST and declares the allowed method', async () => {
  const res = await run({ method: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
});

test('does not call the provider when its secret is missing', async () => {
  delete process.env.GROQ_API_KEY;
  global.fetch = async () => { throw new Error('must not call provider'); };
  const res = await run();
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /not configured/);
});

test('rejects non-JSON requests', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const res = await run({ headers: { 'content-type': 'text/plain' } });
  assert.equal(res.statusCode, 415);
});

test('rejects malformed JSON bodies safely', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const res = await run({ body: '{not json' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /valid JSON/);
});

test('rejects JSON bodies that are not objects', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const res = await run({ body: 'null' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /JSON object/);
});

test('rejects malformed Content-Type headers safely', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const res = await run({ headers: { 'content-type': ['application/json'] } });
  assert.equal(res.statusCode, 415);
});

test('validates minimum input length', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const res = await run({ body: { profile: 'short', opportunity: 'O'.repeat(50) } });
  assert.equal(res.statusCode, 400);
});

test('enforces the profile size limit before calling the provider', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const res = await run({ body: { profile: 'P'.repeat(handler.limits.MAX_PROFILE_LENGTH + 1), opportunity: 'O'.repeat(50) } });
  assert.equal(res.statusCode, 400);
});

test('enforces the opportunity size limit before calling the provider', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const res = await run({ body: { profile: 'P'.repeat(50), opportunity: 'O'.repeat(handler.limits.MAX_OPPORTUNITY_LENGTH + 1) } });
  assert.equal(res.statusCode, 400);
});

test('returns a generic authentication error without exposing the secret', async () => {
  process.env.GROQ_API_KEY = 'private-test-key';
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'key private-test-key' } }) });
  const res = await run();
  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(res.body), /private-test-key/);
});

test('maps non-authentication provider failures to a generic gateway error', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'provider failure' } }) });
  const res = await run();
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /could not complete/);
});

test('rejects malformed model output before it reaches the client', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '<script>alert(1)</script>' } }] }) });
  const res = await run();
  assert.equal(res.statusCode, 502);
});

test('runs extract, match and narrative stages and returns a code-computed report', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const calls = [];
  const prompts = [];
  const inner = stagedFetch({ EXTRACT, MATCH, NARRATIVE }, calls);
  global.fetch = async (url, options) => {
    prompts.push(JSON.parse(options.body));
    return inner(url, options);
  };
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(calls, ['EXTRACT', 'MATCH', 'NARRATIVE']);
  for (const body of prompts) {
    assert.equal(body.temperature, 0.2);
    assert.match(body.messages[0].content, /Return ONLY valid JSON/);
    assert.match(body.messages[0].content, /untrusted reference data/);
  }

  const out = report(res);
  assert.equal(out.eligibilityVerdict, 'Eligible');
  assert.equal(out.overallMatchScore, 83); // (3 + 2) / (3 + 2 + 1)
  assert.equal(out.evidenceCoverage, 67); // 2 of 3 requirements have a verified quote
  assert.equal(out.confidenceScore, out.evidenceCoverage);
  assert.equal(out.coverLetter, 'Dear Atlas Labs,');
  assert.equal(out.narrativeAvailable, true);
  assert.equal(out.acceptanceProbability, undefined, 'model-supplied probability must be dropped');
  assert.equal(out.requirementMapping.length, 3);
});

test('fabricated profile evidence is downgraded and blocks an Eligible verdict', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const fabricated = { matches: [{ ...MATCH.matches[0], evidenceQuote: 'Final-year undergraduate at MIT' }, ...MATCH.matches.slice(1)] };
  global.fetch = stagedFetch({ EXTRACT, MATCH: fabricated, NARRATIVE });
  const out = report(await run());
  assert.equal(out.eligibilityVerdict, 'Needs verification');
  const row = out.requirementMapping.find((item) => item.hardEligibility);
  assert.equal(row.status, 'Unknown');
  assert.equal(row.evidenceVerified, false);
  assert.equal(out._evidenceTrace.downgrades.length, 1);
});

test('requirements whose source quote is not in the opportunity text are dropped', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const invented = { requirements: [...EXTRACT.requirements, { requirement: 'Must hold a PhD', sourceQuote: 'applicants must hold a PhD', mandatory: true, hardEligibility: true }] };
  global.fetch = stagedFetch({ EXTRACT: invented, MATCH, NARRATIVE });
  const out = report(await run());
  assert.equal(out.requirementMapping.length, 3);
  assert.equal(out.eligibilityVerdict, 'Eligible');
  assert.equal(out._evidenceTrace.droppedRequirements.length, 1);
});

test('a narrative-stage failure keeps the verified verdict', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = stagedFetch({ EXTRACT, MATCH, NARRATIVE: 'not json' });
  const res = await run();
  assert.equal(res.statusCode, 200);
  const out = report(res);
  assert.equal(out.narrativeAvailable, false);
  assert.equal(out.eligibilityVerdict, 'Eligible');
  assert.equal(out.coverLetter, undefined);
});

test('returns 422 when no verifiable requirements can be extracted', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = stagedFetch({ EXTRACT: { requirements: [] } });
  assert.equal((await run()).statusCode, 422);
});

test('maps an invalid match-stage response to a gateway error', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = stagedFetch({ EXTRACT, MATCH: '[]' });
  assert.equal((await run()).statusCode, 502);
});

test('rejects provider responses that are valid JSON but not report objects', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[]' } }] }) });
  const res = await run();
  assert.equal(res.statusCode, 502);
});

test('rejects oversized provider responses before returning them to the browser', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  const oversizedResponse = `{\"text\":\"${'x'.repeat(handler.limits.MAX_UPSTREAM_RESPONSE_LENGTH)}\"}`;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: oversizedResponse } }] }) });
  const res = await run();
  assert.equal(res.statusCode, 502);
});

test('maps provider timeouts to a gateway timeout', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
  const res = await run();
  assert.equal(res.statusCode, 504);
});

test('maps malformed provider JSON and fetch errors to a safe gateway error', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad upstream'); } });
  assert.equal((await run()).statusCode, 502);
  global.fetch = async () => { throw new Error('network unavailable'); };
  assert.equal((await run()).statusCode, 502);
});

test('rate limits repeated valid requests per client and returns retry guidance', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = stagedFetch({ EXTRACT, MATCH, NARRATIVE });
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' };
  for (let index = 0; index < handler.limits.RATE_LIMIT_MAX_REQUESTS; index++) {
    assert.equal((await run({ headers })).statusCode, 200);
  }
  const limited = await run({ headers });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['Retry-After'], '60');
});

test('rate-limit and model-validation utilities cover expiry and invalid values', () => {
  assert.equal(handler.isRateLimited('test-client', 0), false);
  assert.equal(handler.isRateLimited('test-client', 60_001), false);
  assert.equal(handler.isValidModelResponse('{}'), true);
  assert.equal(handler.isValidModelResponse('null'), false);
  assert.equal(handler.isValidModelResponse('not json'), false);
  assert.equal(handler.isValidModelResponse('x'.repeat(handler.limits.MAX_UPSTREAM_RESPONSE_LENGTH + 1)), false);
});

test('rate-limit tracking bounds client-memory growth and removes expired entries', () => {
  for (let index = 0; index < 1000; index++) handler.isRateLimited(`expired-${index}`, 0);
  assert.equal(handler.isRateLimited('fresh-after-expiry', 60_001), false);
  handler.resetRateLimits();
  for (let index = 0; index < 1000; index++) handler.isRateLimited(`active-${index}`, 0);
  assert.equal(handler.isRateLimited('fresh-under-pressure', 0), false);
});

test('request-body parser supports Vercel objects and JSON strings', () => {
  assert.deepEqual(handler.readRequestBody({ profile: 'a' }), { profile: 'a' });
  assert.deepEqual(handler.readRequestBody('{"opportunity":"b"}'), { opportunity: 'b' });
});
