// These tests use a MOCKED provider. They prove the verification script's own checks work (it passes good
// output and flags bad output). They say nothing about how the real Groq model behaves: for that,
// the owner runs `GROQ_API_KEY=... node scripts/verify-groq.js` (see README).
const assert = require('node:assert/strict');
const test = require('node:test');
const { verify, sample } = require('../scripts/verify-groq');
const rateLimit = require('../lib/rate-limit');

const realFetch = global.fetch;
const realKey = process.env.GROQ_API_KEY;
test.beforeEach(() => { process.env.GROQ_API_KEY = 'mock-key'; rateLimit.resetRateLimits(); });
test.afterEach(() => { global.fetch = realFetch; if (realKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = realKey; });

const EXTRACT = { requirements: [
  { requirement: 'Strong JavaScript or Python', sourceQuote: 'strong JavaScript or Python', mandatory: true, hardEligibility: false },
  { requirement: 'SQL fundamentals', sourceQuote: 'SQL fundamentals', mandatory: true, hardEligibility: false },
  { requirement: '15 hours per week', sourceQuote: '15 hours/week availability', mandatory: true, hardEligibility: true },
  { requirement: 'React', sourceQuote: 'Preferred: React', mandatory: false, hardEligibility: false }
] };
const goodMatch = { matches: [
  { requirementId: 'R1', status: 'Matched', evidenceQuote: 'Skills: JavaScript, TypeScript, React, Python, SQL', reasoning: 'Lists both.' },
  { requirementId: 'R2', status: 'Matched', evidenceQuote: 'Python, SQL', reasoning: 'Lists SQL.' },
  { requirementId: 'R3', status: 'Matched', evidenceQuote: 'Available 15 hours per week', reasoning: 'Stated.' },
  { requirementId: 'R4', status: 'Matched', evidenceQuote: 'shipped React components used by 10,000+ users', reasoning: 'Shipped React.' }
] };
const LETTER = 'Dear Atlas Labs team, '.concat('I am a third-year Computer Science student with hands-on frontend experience from a fintech internship, where I shipped React components used by thousands of users. '.repeat(3), 'Thank you for your consideration.');
const SECTIONS = {
  insights: { strengths: ['a'], weaknesses: ['b'], missingSkills: [], roadmap: [], personalizedRecommendations: ['c'], atsReadiness: { score: 70 }, learningResources: [{ skill: 'SQL', resource: 'x', provider: 'y', url: 'https://example.com/sql', type: 'course', timeToComplete: '1h' }] },
  coverLetter: { coverLetter: LETTER },
  interview: { interviewQuestions: [1, 2, 3].map((n) => ({ question: `Q${n}`, whyAsked: 'w', suggestedAnswer: 'a' })) }
};

function mockProvider({ match = goodMatch, letter } = {}) {
  global.fetch = async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    const stage = ['EXTRACT', 'MATCH', 'INSIGHTS', 'COVER_LETTER', 'INTERVIEW'].find((name) => system.startsWith(`STAGE: ${name}`));
    let out = { EXTRACT, MATCH: match, INSIGHTS: SECTIONS.insights, COVER_LETTER: letter || SECTIONS.coverLetter, INTERVIEW: SECTIONS.interview }[stage];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) };
  };
}
const run = async () => { const lines = []; const info = console.info; console.info = () => {}; try { return { results: await verify({ log: (l) => lines.push(l) }), lines }; } finally { console.info = info; } };

test('sample data is read from client.js (single source of truth)', () => {
  assert.match(sample('profile'), /Priya Sharma/);
  assert.match(sample('internship'), /Atlas Labs/);
  assert.throws(() => sample('doesNotExist'), /not found/);
});

test('the script passes well-formed output and makes exactly five provider calls (2 verdict + 3 sections)', async () => {
  let calls = 0; mockProvider(); const inner = global.fetch; global.fetch = async (...a) => { calls += 1; return inner(...a); };
  const { results } = await run();
  assert.equal(results.filter((r) => r.level === 'FAIL').length, 0, JSON.stringify(results.filter((r) => r.level === 'FAIL')));
  assert.equal(calls, 5);
  assert.ok(results.some((r) => r.name.includes('cover letter has substance') && r.level === 'PASS'));
});

test('the script FAILS when the provider returns an evidence quote that is not in the profile', async () => {
  // The code-side verifier downgrades fabricated quotes, so the failure surfaces as a downgrade count, not a PASS on evidence.
  mockProvider({ match: { matches: goodMatch.matches.map((m, i) => (i === 0 ? { ...m, evidenceQuote: 'Expert in Kubernetes and Rust' } : m)) } });
  const { results } = await run();
  const downgrade = results.find((r) => r.name.startsWith('claims downgraded'));
  assert.match(downgrade.detail, /^[1-9]/, 'a fabricated quote must be visible as a downgrade');
});

test('the script warns about placeholders and flags a too-short cover letter', async () => {
  mockProvider({ letter: { coverLetter: 'Dear [Hiring Manager], I would like to apply for the Atlas Labs internship. Thank you for reading.' } }); // 50+ chars so the server accepts it; < 300 so the script flags it
  const { results } = await run();
  assert.ok(results.some((r) => r.level === 'FAIL' && r.name.includes('too short')));
  assert.ok(results.some((r) => r.level === 'WARN' && r.name.includes('placeholders')));
});

test('the script reports provider failure instead of crashing', async () => {
  global.fetch = async () => ({ ok: false, status: 429, json: async () => { throw new SyntaxError('html'); } });
  const quiet = console.error; console.error = () => {};
  try { const { results } = await run(); assert.equal(results[0].level, 'FAIL'); assert.match(results[0].detail, /503/); } finally { console.error = quiet; }
});
