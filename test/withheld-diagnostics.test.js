const assert = require('node:assert/strict');
const test = require('node:test');
const guards = require('../lib/guards');
const provenance = require('../lib/provenance');
const claims = require('../lib/claims');
const handler = require('../api/narrative');
const rateLimit = require('../lib/rate-limit');
const report = require('../report-model');
const { complete } = require('./fixtures/insights');

/*
 * Withheld diagnostics: for Preview review only, each withheld item is reported as { field, reason, token? } where token is
 * the single generated word or figure that tripped the check. Never the withheld sentence, never profile text, never in
 * logs, never in production replies. Guard decisions are unchanged: every assertion on `data` here matches the guards'
 * existing behaviour.
 */

const PROFILE = 'Skills: Python, React. Churn Predictor project: accuracy 88.5%. Member of the coding club; helped organise two hackathons. No experience with Docker.';
const OPPORTUNITY = 'Eligibility: Proficiency in Python. Preferred: Familiarity with Docker. Apply by 30 September 2026.';

test('figure guard: field, category and the offending figure; nested fields keep their path', () => {
  const { data, removed, diagnostics } = guards.guardSectionData(
    { strengths: ['Accuracy 88.5% on Churn Predictor', 'Accuracy 91% on Churn Predictor'], resumeStrength: { highlights: ['Reached 79% recall'] }, roadmap: [{ week: 'Week 1', action: 'Target 95% accuracy' }] },
    { sourceText: [PROFILE, OPPORTUNITY], facts: guards.deriveFacts(PROFILE, OPPORTUNITY, []) }
  );
  assert.deepEqual(data.strengths, ['Accuracy 88.5% on Churn Predictor']);
  assert.deepEqual(removed, ['figure not in source: 91%', 'figure not in source: 79%', 'figure not in source: 95%'], 'the log-side reason strings are unchanged');
  assert.deepEqual(diagnostics, [
    { field: 'strengths', reason: 'figure not in source', token: '91%' },
    { field: 'resumeStrength.highlights', reason: 'figure not in source', token: '79%' },
    { field: 'roadmap.action', reason: 'figure not in source', token: '95%' }
  ]);
});

test('figure guard: categories without a token carry none; cover-letter sentences are attributed to coverLetter', () => {
  const facts = guards.deriveFacts('B.Tech student in India.', 'Hard requirement: must be a US citizen.', [{ requirement: 'US citizen', status: 'Missing', hardEligibility: true, mandatory: true }]);
  const { diagnostics } = guards.guardSectionData(
    { coverLetter: 'I am a B.Tech student. Re-apply in the next application cycle. Thank you.' },
    { sourceText: ['B.Tech student in India.'], facts }
  );
  assert.deepEqual(diagnostics, [{ field: 'coverLetter', reason: 'different-cycle advice despite a failed hard requirement' }]);
  assert.equal('token' in diagnostics[0], false);
});

test('provenance: field and category, never the document name, deadline or risk text', () => {
  const { diagnostics, removed } = provenance.applyProvenance('insights', complete({
    requiredDocuments: [{ document: 'Academic Transcript', status: 'Missing', source: 'stated', quote: 'bring everything' }],
    opportunitySummary: { deadline: '1 November 2026' },
    riskAnalysis: [{ risk: 'Deadline approaching fast', severity: 'High', mitigation: 'Hurry' }]
  }), 'No dates here. Submit a statement.');
  assert.deepEqual(diagnostics, [
    { field: 'requiredDocuments', reason: 'provenance' },
    { field: 'opportunitySummary.deadline', reason: 'provenance' },
    { field: 'riskAnalysis', reason: 'provenance' }
  ]);
  assert.equal(removed.length, 3);
  assert.doesNotMatch(JSON.stringify(diagnostics), /Transcript|November|approaching/);
  assert.deepEqual(provenance.applyProvenance('coverLetter', { coverLetter: 'x' }, '').diagnostics, []);
});

test('claim guard: each category names the single generated token that tripped it', () => {
  const { data, diagnostics } = claims.guardClaims('insights', complete({
    strengths: ['Proficient in Python', 'Familiar with Docker', 'Award-winning React developer', 'Python and React listed'],
    resumeStrength: { highlights: ['Demonstrated teamwork'] },
    profileSummary: { skills: ['Python', 'Kubernetes'], university: 'Stanford University' },
    resumeImprovements: [
      { section: 'x', current: 'helped organise two hackathons', suggested: 'co-organised two hackathons', impact: 'Low' },
      { section: 'x', current: 'helped organise two hackathons', suggested: 'Helped organise two hackathons at TechFest', impact: 'Low' },
      { section: 'x', current: 'not in the profile at all', suggested: 'anything', impact: 'Low' },
      'junk'
    ]
  }), PROFILE, OPPORTUNITY);
  assert.deepEqual(data.strengths, ['Python and React listed']);
  const expected = [
    { field: 'strengths', reason: 'unsupported claim word', token: 'proficient' },
    { field: 'strengths', reason: 'unsupported claim word', token: 'familiar' },
    { field: 'strengths', reason: 'contradicts profile', token: 'docker' },
    { field: 'strengths', reason: 'untraceable text', token: 'award-winning' },
    { field: 'resumeStrength.highlights', reason: 'unsupported claim word', token: 'demonstrated' },
    { field: 'profileSummary.skills', reason: 'untraceable text', token: 'kubernetes' },
    { field: 'profileSummary.university', reason: 'untraceable text', token: 'stanford' },
    { field: 'resumeImprovements', reason: 'unsupported claim word', token: 'co-organised' },
    { field: 'resumeImprovements', reason: 'term not in profile', token: 'TechFest' },
    { field: 'resumeImprovements', reason: 'current text not in profile' },
    { field: 'resumeImprovements', reason: 'malformed suggestion' }
  ];
  const key = (item) => JSON.stringify(item);
  const have = new Set(diagnostics.map(key));
  for (const item of expected) assert.ok(have.has(key(item)), `missing ${key(item)}`);
  assert.equal(diagnostics.filter((item) => !('token' in item)).length, 2, 'only the two categories without a generated word lack a token');
  for (const item of diagnostics) {
    if ('token' in item) assert.equal(item.token.split(/\s+/).length, 1, 'a token is one word');
    assert.doesNotMatch(JSON.stringify(item), /hackathons at|not in the profile at all|Python and React/, 'never a sentence or source excerpt');
  }
});

test('handler: _withheld is attached on Preview only, with field, reason and token, and the log line stays category-only', async () => {
  rateLimit.resetRateLimits();
  process.env.GROQ_API_KEY = 'test-key';
  const reply = complete({ strengths: ['Helped organise two hackathons', 'Led two hackathons', 'Accuracy 91% on Churn Predictor'], resumeImprovements: [] });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] }) });
  const request = () => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { profile: PROFILE, opportunity: OPPORTUNITY, section: 'insights', assessment: { verdict: 'Eligible', rows: [{ requirement: 'Python', status: 'Matched', hardEligibility: true, mandatory: true }] } } });
  const response = () => ({ headers: {}, statusCode: null, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const originalEnv = process.env.VERCEL_ENV;
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    for (const env of ['production', 'development', undefined]) {
      if (env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env;
      rateLimit.resetRateLimits();
      const res = response();
      await handler(request(), res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.data.strengths, ['Helped organise two hackathons']);
      assert.equal('_withheld' in res.body.data, false, `no diagnostics when VERCEL_ENV=${env}`);
    }
    process.env.VERCEL_ENV = 'preview';
    rateLimit.resetRateLimits();
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.strengths, ['Helped organise two hackathons'], 'the decision is the same with diagnostics on');
    assert.deepEqual(res.body.data._withheld, [
      { field: 'strengths', reason: 'figure not in source', token: '91%' },
      { field: 'strengths', reason: 'unsupported claim word', token: 'led' },
      { field: 'strengths', reason: 'untraceable text', token: 'led' }
    ]);
    const clean = complete({ strengths: ['Helped organise two hackathons'] });
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(clean) }, finish_reason: 'stop' }] }) });
    rateLimit.resetRateLimits();
    const none = response();
    await handler(request(), none);
    assert.equal('_withheld' in none.body.data, false, 'nothing withheld: no key, even on Preview');
  } finally {
    console.warn = warn;
    if (originalEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = originalEnv;
  }
  const logged = warnings.filter((line) => /withheld/.test(line));
  assert.ok(logged.length >= 1);
  assert.doesNotMatch(logged.join('\n'), /91%|led|hackathon|_withheld|token/, 'logs carry categories only');
  assert.equal(handler.withheldDiagnosticsEnabled({ VERCEL_ENV: 'preview' }), true);
  assert.equal(handler.withheldDiagnosticsEnabled({ VERCEL_ENV: 'production' }), false);
  assert.equal(handler.withheldDiagnosticsEnabled({}), false);
});

test('frontend: _withheld is never rendered in any module, the brief text or the strategy view', () => {
  const marker = 'ZZDIAGZZ';
  const r = report.mergeNarrative(report.adaptNovaReport({ strengths: ['ok'] }), { strengths: ['ok'], _withheld: [{ field: marker, reason: marker, token: marker }] }, 'insights');
  assert.ok(Array.isArray(r._withheld), 'kept in the data so the JSON export carries it for review');
  for (const module of ['requirements', 'strengths', 'gaps', 'documents', 'risks', 'strategy', 'resources', 'other']) {
    const content = report.moduleContent(module, r, {});
    assert.doesNotMatch(`${content.title}${content.subtitle}${content.html}`, new RegExp(marker), module);
  }
  assert.doesNotMatch(report.buildReportText(r), new RegExp(marker));
  assert.doesNotMatch(report.strategyMarkup(r, {}), new RegExp(marker));
});
