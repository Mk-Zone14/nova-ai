const assert = require('node:assert/strict');
const test = require('node:test');
const { complete } = require('./fixtures/insights');
const handler = require('../api/narrative');
const analyze = require('../api/analyze');
const rateLimit = require('../lib/rate-limit');
const { validateAssessment, sanitizeSection } = require('../lib/narrative');

const PROFILE = 'Priya Sharma is a third-year B.Tech Computer Science student. Skills: JavaScript, Python, SQL. CGPA 8.6/10. Age 20. Indian citizen.';
const OPPORTUNITY = 'Product Engineering Intern. Eligibility: must be currently enrolled in an undergraduate degree. Required: strong JavaScript or Python. Preferred: React.';
const ASSESSMENT = {
  verdict: 'Needs verification',
  rows: [
    { requirement: 'Currently enrolled in an undergraduate degree', status: 'Unknown', hardEligibility: true, mandatory: true },
    { requirement: 'Strong JavaScript or Python', status: 'Matched', hardEligibility: false, mandatory: true },
    { requirement: 'React', status: 'Missing', hardEligibility: false, mandatory: false }
  ]
};
const LETTER = 'Dear Atlas Labs hiring team, I am a third-year Computer Science student with working JavaScript and Python skills. I am keen to learn React quickly. Thank you for your time.';

function response() {
  return {
    headers: {}, statusCode: null, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}
const base = (overrides = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: { profile: PROFILE, opportunity: OPPORTUNITY, section: 'insights', assessment: ASSESSMENT },
  ...overrides
});
const withBody = (patch) => base({ body: { ...base().body, ...patch } });
async function run(req = base()) {
  const res = response();
  await handler(req, res);
  return res;
}

// Records every model call and answers with the given content.
function model(content, calls = []) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) };
  };
}
const noModel = () => { throw new Error('the model must not be called'); };

const originalFetch = global.fetch;
const originalKey = process.env.GROQ_API_KEY;
test.beforeEach(() => { rateLimit.resetRateLimits(); process.env.GROQ_API_KEY = 'test-key'; global.fetch = noModel; });
test.after(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
});

// ---- output limit (Item 2) -------------------------------------------------------------------

test('insights sends an explicit completion limit; the other sections and the request shape are unchanged', async () => {
  const calls = [];
  global.fetch = model(complete({ strengths: ['Python'] }), calls);
  assert.equal((await run()).statusCode, 200);
  assert.equal(calls[0].max_completion_tokens, 8192);
  assert.equal(calls[0].temperature, 0.2);
  assert.deepEqual(calls[0].response_format, { type: 'json_object' });
  global.fetch = model({ coverLetter: LETTER }, calls);
  assert.equal((await run(withBody({ section: 'coverLetter' }))).statusCode, 200);
  global.fetch = model({ interviewQuestions: [{ question: 'Why this role?', whyAsked: 'fit', suggestedAnswer: 'Because Python.' }] }, calls);
  assert.equal((await run(withBody({ section: 'interview' }))).statusCode, 200);
  assert.equal('max_completion_tokens' in calls[1], false, 'cover letter keeps the provider default');
  assert.equal('max_completion_tokens' in calls[2], false, 'interview keeps the provider default');
});

test('insights: a reply cut off by the output limit is still rejected, never shown', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(complete({ strengths: ['Python'] })) }, finish_reason: 'length' }], usage: { prompt_tokens: 2709, completion_tokens: 8192 } }) });
  const warn = console.warn; const info = console.info; console.warn = () => {}; console.info = () => {};
  let res;
  try { res = await run(); } finally { console.warn = warn; console.info = info; }
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.data, undefined);
});

// ---- sections --------------------------------------------------------------------------------

test('insights: one model call, only analysis keys survive, and the model cannot set verdict or scores', async () => {
  const calls = [];
  global.fetch = model({
    ...complete({ strengths: ['Python'], missingSkills: [{ skill: 'React' }], learningResources: [] }),
    overallMatchScore: 99, eligibilityVerdict: 'Eligible', confidenceScore: 99, acceptanceProbability: { percentage: 99 },
    coverLetter: 'should not be here', interviewQuestions: [{ question: 'q' }], requirementMapping: [{ requirement: 'x', status: 'Matched' }]
  }, calls);
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(res.body.data).sort(), Object.keys(complete()).sort(), 'only analysis keys: no verdict, scores, cover letter or interview questions');
  assert.deepEqual(res.body.data.strengths, ['Python']);
  assert.equal(res.body.section, 'insights');
});

test('prompts carry the verified statuses and the texts as JSON data, and the system message holds none of it', async () => {
  const calls = [];
  global.fetch = model(complete({ strengths: ['x'] }), calls);
  await run();
  const [system, user] = calls[0].messages.map((message) => message.content);
  assert.match(system, /^STAGE: INSIGHTS/);
  assert.match(system, /Never claim the candidate meets a requirement whose status is Missing, Unknown or Partial Match/);
  assert.match(system, /untrusted reference data/);
  assert.doesNotMatch(system, new RegExp(PROFILE.slice(0, 30)), 'user text must never be interpolated into the system message');
  assert.doesNotMatch(system, /Needs verification|"status":"Missing"/, 'neither may the assessment');
  const data = JSON.parse(user);
  assert.deepEqual(Object.keys(data).sort(), ['opportunity', 'student_profile', 'verified_assessment']);
  assert.equal(data.verified_assessment.verdict, 'Needs verification');
  assert.equal(data.verified_assessment.requirements.find((row) => row.requirement === 'React').status, 'Missing');
  assert.equal(data.student_profile, PROFILE);
});

test('coverLetter: returns only the letter, capped in length, from its own prompt', async () => {
  const calls = [];
  global.fetch = model({ coverLetter: LETTER + ' '.repeat(10) + 'x'.repeat(7000), strengths: ['leak'] }, calls);
  const res = await run(withBody({ section: 'coverLetter' }));
  assert.equal(res.statusCode, 200);
  assert.match(calls[0].messages[0].content, /^STAGE: COVER_LETTER/);
  assert.deepEqual(Object.keys(res.body.data), ['coverLetter']);
  assert.equal(res.body.data.coverLetter.length, 6000);
});

test('interview: keeps well-formed questions only and caps the count', async () => {
  const questions = [...Array.from({ length: 14 }, (_, index) => ({ question: `Q${index}`, whyAsked: 'w', suggestedAnswer: 'a' })), 'junk', null];
  global.fetch = model({ interviewQuestions: ['junk', null, ...questions] });
  const res = await run(withBody({ section: 'interview' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.interviewQuestions.length, 10);
  assert.ok(res.body.data.interviewQuestions.every((item) => typeof item === 'object' && item.question));
});

test('sanitizeSection ignores keys that belong to other sections', () => {
  assert.deepEqual(sanitizeSection('coverLetter', { coverLetter: 'x', strengths: ['y'] }), { coverLetter: 'x' });
  assert.deepEqual(sanitizeSection('interview', { interviewQuestions: 'not an array' }), { interviewQuestions: [] });
});

// ---- validation ------------------------------------------------------------------------------

test('rejects unknown sections without calling the model, including prototype keys', async () => {
  for (const section of [undefined, null, 5, 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const res = await run(withBody({ section }));
    assert.equal(res.statusCode, 400, String(section));
    assert.match(res.body.error, /Unknown section/);
  }
});

test('rejects a missing or malformed assessment without calling the model', async () => {
  const row = ASSESSMENT.rows[0];
  const bad = [
    undefined, null, 'x', [], {},
    { verdict: 'Eligible!!', rows: ASSESSMENT.rows },
    { verdict: 'Eligible', rows: [] },
    { verdict: 'Eligible', rows: 'rows' },
    { verdict: 'Eligible', rows: Array.from({ length: 26 }, () => row) },
    { verdict: 'Eligible', rows: [{ ...row, status: 'Great' }] },
    { verdict: 'Eligible', rows: [{ ...row, requirement: '' }] },
    { verdict: 'Eligible', rows: [{ ...row, requirement: 'x'.repeat(301) }] },
    { verdict: 'Eligible', rows: [null] }
  ];
  for (const assessment of bad) {
    const res = await run(withBody({ assessment }));
    assert.equal(res.statusCode, 400, JSON.stringify(assessment)?.slice(0, 60));
    assert.match(res.body.error, /assessment/i);
  }
});

test('validateAssessment normalises rows and treats hard requirements as mandatory', () => {
  const out = validateAssessment({ verdict: 'Eligible', rows: [{ requirement: '  Aged   18-25 ', status: 'Matched', hardEligibility: true, mandatory: false, extra: 'x' }, { requirement: 'R', status: 'Missing', hardEligibility: 'true' }] });
  assert.deepEqual(out.rows[0], { requirement: 'Aged 18-25', status: 'Matched', hardEligibility: true, mandatory: true });
  assert.equal(out.rows[1].hardEligibility, false, 'only a real boolean true counts');
});

test('enforces the same text limits as /api/analyze', async () => {
  for (const patch of [{ profile: 'short' }, { opportunity: 'short' }, { profile: 'P'.repeat(analyze.limits.MAX_PROFILE_LENGTH + 1) }, { opportunity: 5 }]) {
    assert.equal((await run(withBody(patch))).statusCode, 400);
  }
});

test('shares the standard request guards: method, key, content type, JSON', async () => {
  const get = await run(base({ method: 'GET' }));
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.Allow, 'POST');
  assert.equal((await run(base({ headers: { 'content-type': 'text/plain' } }))).statusCode, 415);
  assert.equal((await run(base({ body: '{nope' }))).statusCode, 400);
  assert.equal((await run(base({ body: 'null' }))).statusCode, 400);
  delete process.env.GROQ_API_KEY;
  assert.equal((await run()).statusCode, 503);
});

// ---- upstream failures -----------------------------------------------------------------------

test('treats model output that is empty or unusable for the section as a gateway error', async () => {
  const cases = [
    ['insights', {}], ['insights', '[]'], ['insights', 'not json'],
    ['coverLetter', { coverLetter: 'too short' }], ['coverLetter', { strengths: ['x'] }],
    ['interview', { interviewQuestions: [] }], ['interview', { interviewQuestions: ['only junk'] }]
  ];
  for (const [section, content] of cases) {
    global.fetch = model(content);
    const res = await run(withBody({ section }));
    assert.equal(res.statusCode, 502, `${section}: ${JSON.stringify(content)}`);
  }
});

test('maps upstream auth failures, timeouts and network errors without leaking details', async () => {
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'key test-key' } }) });
  const original = console.error;
  console.error = () => {};
  let auth;
  try { auth = await run(); } finally { console.error = original; }
  assert.equal(auth.statusCode, 503, 'a rejected provider key is our problem, not an authorisation failure for the visitor');
  assert.doesNotMatch(JSON.stringify(auth.body), /test-key|GROQ|Vercel|environment/i);
  global.fetch = async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
  assert.equal((await run()).statusCode, 504);
  global.fetch = async () => { throw new Error('network unavailable'); };
  assert.equal((await run()).statusCode, 502);
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal((await run()).statusCode, 502);
});

// ---- rate limiting ---------------------------------------------------------------------------

test('has its own, higher rate-limit bucket that does not consume the analyze allowance', async () => {
  global.fetch = model(complete({ strengths: ['x'] }));
  const headers = { 'content-type': 'application/json' };
  const socket = { remoteAddress: '198.51.100.7' };
  for (let index = 0; index < 20; index++) assert.equal((await run({ ...base({ headers }), socket })).statusCode, 200, `request ${index + 1}`);
  const limited = await run({ ...base({ headers }), socket });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  // the same client can still run analyses
  assert.equal(await rateLimit.isRateLimited(rateLimit.getClientKey({ headers, socket })), false);
});

test('insights: a reply with report sections missing is rejected as incomplete, never returned as a smaller answer', async () => {
  const { INSIGHT_LISTS, INSIGHT_OBJECTS } = require('../lib/narrative');
  const full = complete({ strengths: ['Python'] });
  for (const key of [...INSIGHT_LISTS, ...INSIGHT_OBJECTS]) {
    const partial = { ...full };
    delete partial[key];
    global.fetch = model(partial);
    const res = await run();
    assert.equal(res.statusCode, 502, `missing ${key}`);
    assert.equal(res.body.data, undefined);
  }
  global.fetch = model({ ...full, strengths: 'not a list' });
  assert.equal((await run()).statusCode, 502, 'a section of the wrong type is not accepted');
  global.fetch = model(full);
  assert.equal((await run()).statusCode, 200);
});

test('insights: the claim guard runs in the handler after the figure and provenance guards', async () => {
  const profile = 'Skills: Python. Member of the coding club; helped organise two hackathons. No experience with Docker.';
  global.fetch = model(complete({
    strengths: ['Helped organise two hackathons', 'Led two hackathons', 'Familiar with Docker'],
    resumeImprovements: [{ section: 'x', current: 'helped organise two hackathons', suggested: 'co-organised two hackathons', impact: 'Low' }]
  }));
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  let res;
  try { res = await run(withBody({ profile })); } finally { console.warn = warn; }
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.strengths, ['Helped organise two hackathons']);
  assert.deepEqual(res.body.data.resumeImprovements, []);
  assert.match(warnings.join("\n"), /withheld \d+ item\(s\) in insights: claim/);
  assert.doesNotMatch(warnings.join('\n'), /hackathon|Docker/);
});
