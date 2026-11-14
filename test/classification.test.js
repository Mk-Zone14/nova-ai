const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeRequirements, normalizeMatches, computeAssessment, WEIGHT, STATUS_CREDIT
} = require('../lib/eligibility');
const { classifyRequirement, hasExplicitDisqualifier, quoteContext } = require('../lib/classification');
const { createExtractPrompt } = require('../lib/prompts');
const handler = require('../api/analyze');

/*
 * F2: hard-requirement classification. `hardEligibility` is proposed by the extraction model; a requirement is hard only if it
 * is a pass/fail gate about who the applicant is or their status (age, citizenship/location, work authorization, enrolment,
 * degree level or year, graduation window, minimum grade, a human language, availability). Skills, proficiency, experience and
 * completed projects stay mandatory but are not gates, even when the posting says "must", "required" or lists them under an
 * "Eligibility" heading, unless the posting itself says that lacking them disqualifies the applicant. The code only ever
 * downgrades; it never promotes. In every case below the model is simulated as having marked the item hard AND mandatory, so
 * these tests exercise the code backstop, not the prompt.
 */

// One extracted item, as a model that over-marks hard would return it, inside a posting that contains the quote.
function classify(requirement, quote, posting, model = { mandatory: true, hardEligibility: true }) {
  const out = normalizeRequirements({ requirements: [{ requirement, sourceQuote: quote, ...model }] }, posting);
  assert.equal(out.requirements.length, 1, `"${requirement}" must survive quote verification`);
  return { item: out.requirements[0], reclassified: out.reclassified };
}
const ELIGIBILITY = (line) => `Software Engineering Intern\nEligibility:\n- Currently enrolled in a B.Tech programme.\n- ${line}\n- Open to candidates based in India.`;

// ---- skills, proficiency, experience and projects: not gates, still mandatory --------------------------------------------

const NOT_GATES = [
  ['the reported misclassification: skill under an Eligibility heading', 'Proficiency in Python', 'Proficiency in Python.', ELIGIBILITY('Proficiency in Python.')],
  ['the reported misclassification: completed project under an Eligibility heading', 'At least one completed software project', 'At least one completed software project.', ELIGIBILITY('At least one completed software project.')],
  ['"must be proficient" wording', 'Must be proficient in Python', 'Applicants must be proficient in Python.', 'Applicants must be proficient in Python. Apply by 30 September 2026.'],
  ['"must have completed" wording', 'Applicants must have completed at least one project', 'Applicants must have completed at least one project.', 'Applicants must have completed at least one project. Deadline: 30 September.'],
  ['a bare technology name after "Required:"', 'Python', 'Required: Python', 'Hackathon. Required: Python, machine learning fundamentals and student enrollment.'],
  ['important skill stated with "must have"', 'Strong SQL skills', 'You must have strong SQL skills', 'Data Intern. You must have strong SQL skills. Stipend provided.'],
  ['amount of experience', '3 years of professional experience', 'at least 3 years of professional experience', 'Analyst. Candidates need at least 3 years of professional experience.'],
  ['familiarity', 'Familiarity with Docker', 'Familiarity with Docker.', ELIGIBILITY('Familiarity with Docker.')],
  ['a public repository', 'A public GitHub repository', 'a public GitHub repository', 'Challenge. Required: Python, a public GitHub repository and student enrollment.'],
  ['soft skill listed as required', 'Strong communication skills', 'Strong communication skills.', ELIGIBILITY('Strong communication skills.')]
];
for (const [label, requirement, quote, posting] of NOT_GATES) {
  test(`not a gate: ${label}`, () => {
    const { item, reclassified } = classify(requirement, quote, posting);
    assert.equal(item.hardEligibility, false, 'no longer a hard eligibility gate');
    assert.equal(item.mandatory, true, 'still required: only the gate flag is removed');
    assert.deepEqual(reclassified.map(({ requirement: text, was, reason }) => ({ text, was, reason })), [{ text: requirement, was: 'hard', reason: 'skill-or-experience' }]);
  });
}

// ---- real gates stay hard ------------------------------------------------------------------------------------------------

const GATES = [
  ['minimum age', 'Aged 18-25', 'applicants must be aged 18-25', 'Fellowship. Eligibility: applicants must be aged 18-25. Preferred: Docker.'],
  ['minimum age, "years of age"', 'At least 18 years of age', 'Must be at least 18 years of age', 'Prize. Must be at least 18 years of age to enter.'],
  ['minimum age, "or older"', '18 or older', 'Must be 18 or older', 'Prize. Must be 18 or older to enter.'],
  ['enrolment', 'Currently enrolled in an undergraduate degree', 'must be currently enrolled in an undergraduate degree', 'Intern. Eligibility: must be currently enrolled in an undergraduate degree.'],
  ['degree level', "Bachelor's degree in Computer Science", "Must hold a bachelor's degree in Computer Science", "Analyst. Must hold a bachelor's degree in Computer Science."],
  ['year of study', 'Final-year student', 'Must be a final-year student.', 'Scheme. Must be a final-year student.'],
  ['work authorization', 'Authorized to work in India', 'Must be authorized to work in India', 'Role. Must be authorized to work in India.'],
  ['work authorization, informal wording', 'Able to work in the US', 'Must be able to work in the US', 'Role. Must be able to work in the US without sponsorship.'],
  ['citizenship', 'Citizen of India', 'Must be a citizen of India', 'Grant. Must be a citizen of India.'],
  ['location', 'Based in India', 'Open to candidates based in India.', ELIGIBILITY('Proficiency in Python.')],
  ['graduation window', 'Graduation window December 2027 to June 2028', 'Graduation window: December 2027 to June 2028.', ELIGIBILITY('Graduation window: December 2027 to June 2028.')],
  ['minimum grade', 'Minimum CGPA 8.0', 'Minimum CGPA 8.0', 'Scholarship. Minimum CGPA 8.0 in the last semester.'],
  ['human language', 'Fluent in written and spoken English', 'Fluent in written and spoken English', 'Role. Fluent in written and spoken English.'],
  ['availability', '15 hours per week', '15 hours/week availability', 'Intern. Applicants need 15 hours/week availability.'],
  ['formal credential', 'AWS certification', 'Must hold an AWS certification', 'Cloud role. Must hold an AWS certification before the start date.']
];
for (const [label, requirement, quote, posting] of GATES) {
  test(`stays a gate: ${label}`, () => {
    const { item, reclassified } = classify(requirement, quote, posting);
    assert.equal(item.hardEligibility, true);
    assert.equal(item.mandatory, true);
    assert.deepEqual(reclassified, []);
  });
}

// ---- the posting itself makes a skill disqualifying ------------------------------------------------------------------------

test('explicit consequence wording keeps a skill hard: the posting says lacking it disqualifies', () => {
  for (const posting of [
    'Proficiency in Python is a strict requirement: applicants without it are ineligible.',
    'Proficiency in Python. Applicants who lack it will not be considered.',
    'Proficiency in Python is non-negotiable.',
    'Proficiency in Python (hard requirement).'
  ]) {
    const { item, reclassified } = classify('Proficiency in Python', 'Proficiency in Python', posting);
    assert.equal(item.hardEligibility, true, posting);
    assert.deepEqual(reclassified, [], posting);
  }
});

test('"required", "must" and an Eligibility heading are not consequence wording', () => {
  for (const text of ['Eligibility: Proficiency in Python is required.', 'You must have proficiency in Python.', 'Mandatory: proficiency in Python.', 'Required eligibility criteria: proficiency in Python.']) {
    assert.equal(hasExplicitDisqualifier(text), false, text);
    assert.equal(classify('Proficiency in Python', 'proficiency in Python', text).item.hardEligibility, false, text);
  }
});

test('negated consequence wording does not count', () => {
  assert.equal(hasExplicitDisqualifier('Applicants without Python will not be disqualified.'), false);
  assert.equal(hasExplicitDisqualifier('Applicants without Python will be disqualified.'), true);
  assert.equal(classify('Proficiency in Python', 'Proficiency in Python', 'Proficiency in Python. Applicants without it will not be disqualified.').item.hardEligibility, false);
});

test('only the quote\'s own sentence and the next one count: a disqualifier elsewhere in the posting does not make a skill hard', () => {
  const posting = 'Proficiency in Python. Strong teamwork. Benefits include mentorship. Applicants under 18 are ineligible.';
  assert.match(quoteContext('Proficiency in Python', posting), /Strong teamwork/);
  assert.doesNotMatch(quoteContext('Proficiency in Python', posting), /ineligible/);
  assert.equal(classify('Proficiency in Python', 'Proficiency in Python', posting).item.hardEligibility, false, 'documented limit: a block-level disqualifier statement is not attributed to this line');
});

// ---- ambiguity, mixed wording, no promotion --------------------------------------------------------------------------------

test('mixed wording (a gate and a skill in one item) keeps the model flag: the guard only downgrades what it is sure about', () => {
  const posting = 'Enrolled B.Tech student with proficiency in Python.';
  assert.equal(classifyRequirement({ requirement: 'Enrolled B.Tech student with proficiency in Python', sourceQuote: posting }, posting).kind, 'mixed');
  assert.equal(classify('Enrolled B.Tech student with proficiency in Python', posting, posting).item.hardEligibility, true);
});

test('wording the guard cannot judge keeps the model flag in both directions', () => {
  const posting = 'Must own a laptop. Must be a team player.';
  assert.equal(classifyRequirement({ requirement: 'Own a laptop', sourceQuote: 'Must own a laptop.' }, posting).kind, 'unclear');
  assert.equal(classify('Own a laptop', 'Must own a laptop.', posting, { mandatory: true, hardEligibility: true }).item.hardEligibility, true, 'model said hard: unchanged');
  assert.equal(classify('Own a laptop', 'Must own a laptop.', posting, { mandatory: true, hardEligibility: false }).item.hardEligibility, false, 'model said not hard: never promoted');
});

test('never promotes: a gate the model left non-hard stays non-hard, and a skill the model left mandatory stays mandatory', () => {
  const gate = classify('Aged 18-25', 'applicants must be aged 18-25', 'Applicants must be aged 18-25.', { mandatory: true, hardEligibility: false });
  assert.deepEqual([gate.item.hardEligibility, gate.item.mandatory, gate.reclassified], [false, true, []]);
  const skill = classify('Proficiency in Python', 'Proficiency in Python.', ELIGIBILITY('Proficiency in Python.'), { mandatory: true, hardEligibility: false });
  assert.deepEqual([skill.item.hardEligibility, skill.item.mandatory, skill.reclassified], [false, true, []], 'nothing to downgrade, nothing recorded');
});

test('preferred qualifications: F1 handles the preferred section, F2 does not double-record it', () => {
  const posting = 'Eligibility:\n- Proficiency in Python.\nPreferred qualifications:\n- Familiarity with Docker.\n- Experience with AWS.';
  const { requirements, reclassified } = normalizeRequirements({ requirements: [
    { requirement: 'Proficiency in Python', sourceQuote: 'Proficiency in Python.', mandatory: true, hardEligibility: true },
    { requirement: 'Familiarity with Docker', sourceQuote: 'Familiarity with Docker.', mandatory: true, hardEligibility: true }
  ] }, posting);
  const docker = requirements.find((item) => item.requirement === 'Familiarity with Docker');
  assert.deepEqual([docker.hardEligibility, docker.mandatory], [false, false]);
  assert.deepEqual(reclassified.map((item) => [item.requirement, item.was, item.reason ?? 'preferred-section']), [
    ['Familiarity with Docker', 'hard', 'preferred-section'],
    ['Proficiency in Python', 'hard', 'skill-or-experience']
  ]);
  assert.deepEqual(requirements.filter((item) => item.recovered).map((item) => [item.requirement, item.hardEligibility, item.mandatory]), [['Experience with AWS', false, false]]);
});

test('the guard works from the posting\'s own wording, not from a fixed list of phrases: other skills behave the same way', () => {
  for (const [requirement, quote] of [['Knowledge of Kubernetes', 'Knowledge of Kubernetes.'], ['Hands-on experience with Figma', 'Hands-on experience with Figma.'], ['At least one published paper', 'At least one published paper.'], ['Completed an internship', 'Completed an internship.'], ['Working knowledge of statistics', 'Working knowledge of statistics.']]) {
    const { item } = classify(requirement, quote, ELIGIBILITY(quote));
    assert.equal(item.hardEligibility, false, requirement);
    assert.equal(item.mandatory, true, requirement);
  }
});

// ---- consequences ----------------------------------------------------------------------------------------------------------

test('the scoring formula and weights are unchanged: the pre-F2 numbers for the same flags still come out of computeAssessment', () => {
  // Five hard + four preferred, flags set directly (no classification involved): 15 of 19 weighted points, fit 79.
  const requirements = [
    ...[1, 2, 3, 4, 5].map((n) => ({ id: `R${n}`, requirement: `hard ${n}`, hardEligibility: true, mandatory: true })),
    ...[6, 7, 8, 9].map((n) => ({ id: `R${n}`, requirement: `preferred ${n}`, hardEligibility: false, mandatory: false }))
  ];
  const matches = requirements.map((requirement, index) => ({ requirementId: requirement.id, status: index < 5 ? 'Matched' : 'Missing', evidenceVerified: index < 5 }));
  const assessment = computeAssessment(requirements, matches);
  assert.equal(assessment.fitScore, 79);
  assert.deepEqual(assessment.requirementsMatch.required, { total: 5, matched: 5, partial: 0, missing: 0, unknown: 0, percent: 100, weightedEarned: 15, weightedPossible: 15 });
  assert.deepEqual(WEIGHT, { hard: 3, mandatory: 2, preferred: 1 });
  assert.deepEqual(STATUS_CREDIT, { Matched: 1, 'Partial Match': 0.5, Missing: 0, Unknown: 0 });
});

test('a downgraded item changes the weight it carries and what can decide the verdict, nothing else', () => {
  const posting = ELIGIBILITY('Proficiency in Python.');
  const { requirements } = normalizeRequirements({ requirements: [
    { requirement: 'Currently enrolled in a B.Tech programme', sourceQuote: 'Currently enrolled in a B.Tech programme.', mandatory: true, hardEligibility: true },
    { requirement: 'Proficiency in Python', sourceQuote: 'Proficiency in Python.', mandatory: true, hardEligibility: true }
  ] }, posting);
  const profile = 'Third-year B.Tech student. No experience with Python.';
  const matches = normalizeMatches({ matches: [
    { requirementId: 'R1', status: 'Matched', evidenceQuote: 'Third-year B.Tech student' },
    { requirementId: 'R2', status: 'Missing', contradictingQuote: 'No experience with Python' }
  ] }, requirements, profile);
  const assessment = computeAssessment(requirements, matches);
  assert.equal(assessment.verdict, 'Eligible', 'a skill gap no longer disqualifies');
  assert.deepEqual(assessment.hardMissing, []);
  assert.deepEqual(assessment.mandatoryGaps, ['Proficiency in Python'], 'but it is still reported as a missing mandatory requirement');
  assert.match(assessment.verdictReason, /1 other mandatory requirement missing or unproven: Proficiency in Python/);
  assert.equal(assessment.fitScore, 60, '3 of 5 weighted points: the skill carries weight 2, not 3');
});

// ---- end to end through the handler, with a simulated model -----------------------------------------------------------------

const PROFILE = 'Third-year B.Tech Computer Science student. No experience with Python.';
const OPPORTUNITY = 'Software Intern. Eligibility: must be currently enrolled in an undergraduate degree. Proficiency in Python. At least one completed software project.';
const EXTRACT = { requirements: [
  { requirement: 'Currently enrolled in an undergraduate degree', sourceQuote: 'must be currently enrolled in an undergraduate degree', mandatory: true, hardEligibility: true },
  { requirement: 'Proficiency in Python', sourceQuote: 'Proficiency in Python', mandatory: true, hardEligibility: true },
  { requirement: 'At least one completed software project', sourceQuote: 'At least one completed software project', mandatory: true, hardEligibility: true }
] };
const MATCH = { matches: [
  { requirementId: 'R1', status: 'Matched', evidenceQuote: 'Third-year B.Tech Computer Science student', reasoning: 'Enrolled.' },
  { requirementId: 'R2', status: 'Missing', contradictingQuote: 'No experience with Python', reasoning: 'States no Python experience.' },
  { requirementId: 'R3', status: 'Unknown', reasoning: 'Profile does not mention projects.' }
] };

function stagedFetch(stages) {
  return async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    const stage = ['EXTRACT', 'MATCH'].find((name) => system.startsWith(`STAGE: ${name}`));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(stages[stage]) } }] }) };
  };
}
const originalFetch = global.fetch;
const originalKey = process.env.GROQ_API_KEY;
test.after(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
});

test('handler: a model that marks skill and project hard cannot turn a skill gap into "Not eligible"', async () => {
  handler.resetRateLimits();
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = stagedFetch({ EXTRACT, MATCH });
  const res = { headers: {}, statusCode: null, body: null, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { profile: PROFILE, opportunity: OPPORTUNITY } }, res);
  assert.equal(res.statusCode, 200);
  const report = JSON.parse(res.body.response);
  const byName = Object.fromEntries(report.requirementMapping.map((row) => [row.requirement, row]));
  assert.deepEqual([byName['Currently enrolled in an undergraduate degree'].hardEligibility, byName['Currently enrolled in an undergraduate degree'].mandatory], [true, true], 'the enrolment gate is untouched');
  for (const name of ['Proficiency in Python', 'At least one completed software project']) {
    assert.deepEqual([byName[name].hardEligibility, byName[name].mandatory], [false, true], name);
  }
  assert.notEqual(report.eligibilityVerdict, 'Not eligible');
  assert.equal(report.eligibilityVerdict, 'Eligible');
  assert.match(report.verdictReason, /2 other mandatory requirements missing or unproven/);
  assert.equal(report.constraintNotes.failedHardRequirements, undefined, 'no hard requirement is reported as failed');
  assert.deepEqual(report._evidenceTrace.reclassifiedRequirements.map((item) => [item.requirement, item.was, item.reason]), [
    ['Proficiency in Python', 'hard', 'skill-or-experience'],
    ['At least one completed software project', 'hard', 'skill-or-experience']
  ], 'the downgrade is visible in the audit trail');
});

// ---- prompt ------------------------------------------------------------------------------------------------------------------

test('extraction prompt: gates are about who the applicant is, skills and projects are never hard, a heading is not a gate', () => {
  const { system } = createExtractPrompt('anything');
  assert.match(system, /NEVER hardEligibility/);
  assert.match(system, /Skills, proficiency in a tool or programming language, years or amount of experience, completed projects/);
  assert.match(system, /even when the line sits under an "Eligibility" heading/);
  assert.match(system, /A heading, or the words must and required, do not by themselves make something a gate\. When unsure, use hardEligibility: false/);
  assert.doesNotMatch(system, /anything listed under an "Eligibility" heading as a condition/, 'the wording that licensed the misclassification is gone');
  assert.match(system, /work authorization/);
  assert.match(system, /spoken or written human language such as English/);
});
