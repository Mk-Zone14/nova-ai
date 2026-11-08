const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isVerbatimQuote, normalizeRequirements, normalizeMatches, computeAssessment, buildDeterministicReport
} = require('../lib/eligibility');

const OPPORTUNITY = 'Fellowship. Eligibility: applicants must be aged 18-25. Must be an enrolled undergraduate. Required: Python. Preferred: Docker.';
const PROFILE = 'Rohan, age 27, is a final-year B.Tech student.   Skills: Python, JavaScript.\nBuilt a "dashboard" using Docker Compose.';

const req = (requirement, sourceQuote, mandatory, hardEligibility) => ({ requirement, sourceQuote, mandatory, hardEligibility });
const buildRequirements = (items) => normalizeRequirements({ requirements: items }, OPPORTUNITY).requirements;

test('quote verification ignores case, whitespace and typographic quotes/dashes', () => {
  assert.equal(isVerbatimQuote('SKILLS: python, javascript', PROFILE), true);
  assert.equal(isVerbatimQuote('final-year   B.Tech student', PROFILE), true);
  assert.equal(isVerbatimQuote('Built a “dashboard” using Docker', PROFILE), true);
  assert.equal(isVerbatimQuote('aged 18–25', OPPORTUNITY), true);
});

test('quote verification matches whole tokens, not substrings', () => {
  assert.equal(isVerbatimQuote('Java', PROFILE), false); // only appears inside "JavaScript"
  assert.equal(isVerbatimQuote('Script', PROFILE), false);
  assert.equal(isVerbatimQuote('JavaScript', PROFILE), true);
});

test('quote verification supports ellipsis joins and rejects empty, tiny, oversized or invented quotes', () => {
  assert.equal(isVerbatimQuote('age 27 ... B.Tech student', PROFILE), true);
  assert.equal(isVerbatimQuote('age 27 ... PhD student', PROFILE), false);
  assert.equal(isVerbatimQuote('', PROFILE), false);
  assert.equal(isVerbatimQuote('...', PROFILE), false);
  assert.equal(isVerbatimQuote('ag', PROFILE), false);
  assert.equal(isVerbatimQuote('x'.repeat(401), 'x'.repeat(500)), false);
  assert.equal(isVerbatimQuote(null, PROFILE), false);
});

test('extraction drops unverifiable and duplicate items and treats hard gates as mandatory', () => {
  const { requirements, dropped } = normalizeRequirements({
    requirements: [
      req('Aged 18-25', 'applicants must be aged 18-25', 'false', 'true'),
      req('aged 18-25', 'applicants must be aged 18-25', true, true), // duplicate
      req('Python', 'Required: Python', true, false),
      req('Kubernetes', 'Required: Kubernetes', true, false), // not in the text
      { requirement: '', sourceQuote: 'Required: Python' },
      null
    ]
  }, OPPORTUNITY);
  assert.deepEqual(requirements.map((item) => item.id), ['R1', 'R2']);
  assert.equal(requirements[0].hardEligibility, true);
  assert.equal(requirements[0].mandatory, true);
  assert.equal(requirements[1].mandatory, true);
  assert.equal(dropped.length, 1);
  assert.deepEqual(normalizeRequirements(undefined, OPPORTUNITY).requirements, []);
});

test('Matched and Partial need a verified profile quote, otherwise become Unknown', () => {
  const requirements = buildRequirements([req('Python', 'Required: Python', true, false), req('Docker', 'Preferred: Docker', false, false)]);
  const matches = normalizeMatches({
    matches: [
      { requirementId: 'R1', status: 'matched', evidenceQuote: 'Skills: Python', reasoning: 'ok' },
      { requirementId: 'R2', status: 'Partial Match', evidenceQuote: 'Kubernetes cluster operator', reasoning: 'made up' }
    ]
  }, requirements, PROFILE);
  assert.equal(matches[0].status, 'Matched');
  assert.equal(matches[0].evidenceVerified, true);
  assert.equal(matches[1].status, 'Unknown');
  assert.equal(matches[1].downgraded, true);
  assert.equal(matches[1].claimedStatus, 'Partial Match');
});

test('a hard requirement is only Missing with a verified contradicting quote', () => {
  const requirements = buildRequirements([req('Aged 18-25', 'applicants must be aged 18-25', true, true)]);
  const absence = normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Missing', reasoning: 'Not stated' }] }, requirements, PROFILE);
  assert.equal(absence[0].status, 'Unknown');
  const invented = normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Missing', contradictingQuote: 'age 31', reasoning: 'x' }] }, requirements, PROFILE);
  assert.equal(invented[0].status, 'Unknown');
  const contradicted = normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Missing', contradictingQuote: 'age 27', reasoning: 'Over the limit.' }] }, requirements, PROFILE);
  assert.equal(contradicted[0].status, 'Missing');
  assert.equal(contradicted[0].evidenceVerified, true);
});

test('missing assessments and unrecognised statuses fall back to Unknown, one match per requirement', () => {
  const requirements = buildRequirements([req('Python', 'Required: Python', true, false), req('Docker', 'Preferred: Docker', false, false)]);
  const matches = normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Excellent!' }, { requirementId: 'R1', status: 'Matched' }] }, requirements, PROFILE);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].status, 'Unknown');
  assert.equal(matches[1].status, 'Unknown');
  assert.match(matches[1].reasoning, /no assessment/);
});

test('REGRESSION: a high-scoring profile that fails a hard requirement is never Eligible', () => {
  const requirements = buildRequirements([
    req('Aged 18-25', 'applicants must be aged 18-25', true, true),
    req('Python', 'Required: Python', true, false),
    req('Docker', 'Preferred: Docker', false, false)
  ]);
  const matches = normalizeMatches({
    matches: [
      { requirementId: 'R1', status: 'Missing', contradictingQuote: 'age 27', reasoning: 'Too old.' },
      { requirementId: 'R2', status: 'Matched', evidenceQuote: 'Skills: Python', reasoning: 'ok' },
      { requirementId: 'R3', status: 'Matched', evidenceQuote: 'Docker Compose', reasoning: 'ok' }
    ]
  }, requirements, PROFILE);
  const assessment = computeAssessment(requirements, matches);
  assert.equal(assessment.verdict, 'Not eligible');
  assert.equal(assessment.fitScore, 50); // 3 of 6 weight earned: strong skills do not hide the gate
  assert.match(assessment.verdictReason, /Aged 18-25/);
});

test('verdict: unresolved or partial hard requirements need verification; all-met hard requirements are Eligible', () => {
  const requirements = buildRequirements([req('Enrolled undergraduate', 'Must be an enrolled undergraduate', true, true), req('Python', 'Required: Python', true, false)]);
  const python = { requirementId: 'R2', status: 'Matched', evidenceQuote: 'Skills: Python' };
  const unknown = computeAssessment(requirements, normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Unknown' }, python] }, requirements, PROFILE));
  assert.equal(unknown.verdict, 'Needs verification');
  const partial = computeAssessment(requirements, normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Partial', evidenceQuote: 'B.Tech student' }, python] }, requirements, PROFILE));
  assert.equal(partial.verdict, 'Needs verification');
  const met = computeAssessment(requirements, normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Matched', evidenceQuote: 'B.Tech student' }, python] }, requirements, PROFILE));
  assert.equal(met.verdict, 'Eligible');
  assert.equal(met.fitScore, 100);
  assert.equal(met.evidenceCoverage, 100);
});

test('scoring weights, partial credit and conservative treatment of Unknown', () => {
  const requirements = buildRequirements([req('Python', 'Required: Python', true, false), req('Docker', 'Preferred: Docker', false, false)]);
  const matches = normalizeMatches({
    matches: [
      { requirementId: 'R1', status: 'Partial Match', evidenceQuote: 'Skills: Python' },
      { requirementId: 'R2', status: 'Unknown' }
    ]
  }, requirements, PROFILE);
  const assessment = computeAssessment(requirements, matches);
  assert.equal(assessment.fitScore, 33); // (2 * 0.5 + 1 * 0) / 3
  assert.equal(assessment.evidenceCoverage, 50);
  assert.match(assessment.verdictReason, /No hard eligibility requirements were identified/);
});

test('no requirements yields Needs verification with null score and coverage', () => {
  const assessment = computeAssessment([], []);
  assert.equal(assessment.verdict, 'Needs verification');
  assert.equal(assessment.fitScore, null);
  assert.equal(assessment.evidenceCoverage, null);
});

test('deterministic report exposes UI-compatible fields and an audit trail', () => {
  const requirements = buildRequirements([req('Python', 'Required: Python', true, false), req('Docker', 'Preferred: Docker', false, false)]);
  const matches = normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Matched', evidenceQuote: 'Skills: Python', reasoning: 'ok' }, { requirementId: 'R2', status: 'Missing' }] }, requirements, PROFILE);
  const out = buildDeterministicReport(requirements, matches, [], computeAssessment(requirements, matches));
  assert.equal(out.mandatoryRequirements.length, 1);
  assert.equal(out.preferredRequirements.length, 1);
  assert.deepEqual(out.missingRequirements, []); // the only gap is a non-mandatory item
  assert.equal(out.requirementMapping[0].confidence, 'Verified');
  assert.equal(out.requirementMapping[1].confidence, 'Not verified');
  assert.equal(out.readinessCategory, 'Ready to apply');
  assert.equal(out._evidenceTrace.requirements[0].sourceQuote, 'Required: Python');
});
