const assert = require('node:assert/strict');
const test = require('node:test');
const {
  preferredSectionLines, normalizeRequirements, normalizeMatches, computeAssessment, buildDeterministicReport, WEIGHT, STATUS_CREDIT
} = require('../lib/eligibility');
const report = require('../report-model');

/*
 * F1: the extractor is one model call and sometimes leaves the "Preferred" list out (observed in production: the same
 * posting gave 5 requirements and fit 100 in one run, 9 requirements and fit 79 in the next). Lines under an explicit
 * preferred heading are recovered in code, only ever as preferred, and the requirements match is reported per tier.
 * The fit-score formula is unchanged.
 */

const OPPORTUNITY = `Software Engineering Intern — Northwind Labs
Location: Bengaluru / Remote, India

Eligibility:
- Currently enrolled in a B.Tech/B.E. programme in Computer Science or a related field.
- Graduation window: December 2027 to June 2028.
- Proficiency in Python.
- At least one completed software project.
Open to candidates based in India.

Preferred qualifications:
- Experience with AWS or another cloud platform.
- Familiarity with Docker.
- Prior internship experience.
- Contributions to open-source projects.

What we offer:
- Stipend of ₹25,000 per month.
- Mentorship from senior engineers.
No visa or work-authorization requirements.`;

const HARD = [
  ['Currently enrolled in a B.Tech/B.E. programme in Computer Science or related field', 'Currently enrolled in a B.Tech/B.E. programme in Computer Science or a related field.'],
  ['Graduation window December 2027 to June 2028', 'Graduation window: December 2027 to June 2028.'],
  ['Proficiency in Python', 'Proficiency in Python.'],
  ['At least one completed software project', 'At least one completed software project.'],
  ['Based in India', 'Open to candidates based in India.']
].map(([requirement, sourceQuote]) => ({ requirement, sourceQuote, mandatory: true, hardEligibility: true }));
const PREFERRED = [
  ['Experience with AWS or another cloud platform', 'Experience with AWS or another cloud platform.'],
  ['Familiarity with Docker', 'Familiarity with Docker.'],
  ['Prior internship experience', 'Prior internship experience.'],
  ['Contributions to open-source projects', 'Contributions to open-source projects.']
].map(([requirement, sourceQuote]) => ({ requirement, sourceQuote, mandatory: false, hardEligibility: false }));

const PROFILE = 'Aarav Mehta. B.Tech Computer Science, Techno Valley Institute, Pune, India. Expected graduation: May 2028. Skills: Python, SQL (basic queries and joins), React, Git. Churn Predictor project: Python, scikit-learn. No prior internship. No experience with cloud platforms or Docker.';

test('preferred section: only the lines under a preferred heading, without offer or prose lines', () => {
  assert.deepEqual(preferredSectionLines(OPPORTUNITY), PREFERRED.map((item) => item.sourceQuote));
  assert.deepEqual(preferredSectionLines('Requirements:\n- Python\n- SQL'), [], 'no preferred heading: nothing');
  assert.deepEqual(preferredSectionLines('Nice to have:\n- Docker\nBenefits:\n- Free lunch\n- Docker experience'), ['Docker'], 'a later heading ends the section');
  assert.deepEqual(preferredSectionLines('Bonus points:\n• Kubernetes\n1. Terraform\nStipend ₹20,000 per month\nWe offer mentorship'), ['Kubernetes', 'Terraform'], 'bullets and numbering are stripped; offer lines are skipped');
  assert.deepEqual(preferredSectionLines('Nice to have: Docker, AWS\nRequirements:\n- Python'), ['Docker, AWS'], 'an inline heading keeps its one item');
  assert.deepEqual(preferredSectionLines('Preferred:\nWe are a fast-growing team. You will love it here. Come join us.'), [], 'multi-sentence prose is not a qualification');
  assert.deepEqual(preferredSectionLines(''), []);
});

test('missing: preferred lines the model left out are added as preferred, with the posting line as the quote', () => {
  const { requirements, recovered, reclassified, dropped } = normalizeRequirements({ requirements: HARD }, OPPORTUNITY);
  assert.equal(requirements.length, 9);
  assert.deepEqual(recovered.map((item) => item.requirement), PREFERRED.map((item) => item.requirement));
  for (const item of requirements.slice(5)) {
    assert.equal(item.hardEligibility, false);
    assert.equal(item.mandatory, false);
    assert.equal(item.recovered, true);
    assert.ok(OPPORTUNITY.includes(item.sourceQuote), 'the quote is verbatim from the posting');
  }
  // F2: the posting's skill and project lines were marked hard by the model and are downgraded to mandatory (test/classification.test.js).
  assert.deepEqual(reclassified.map((item) => [item.requirement, item.was, item.reason]), [
    ['Proficiency in Python', 'hard', 'skill-or-experience'],
    ['At least one completed software project', 'hard', 'skill-or-experience']
  ]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(requirements.map((item) => item.id), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']);
});

test('duplicated: a line the model already extracted is not added twice, however it was reworded', () => {
  const reworded = { requirement: 'Docker familiarity', sourceQuote: 'Familiarity with Docker.', mandatory: false, hardEligibility: false };
  const { requirements, recovered } = normalizeRequirements({ requirements: [...HARD, reworded, { ...reworded, requirement: 'Knows Docker' }] }, OPPORTUNITY);
  assert.equal(requirements.filter((item) => /docker/i.test(item.requirement)).length, 1);
  assert.deepEqual(recovered.map((item) => item.requirement), ['Experience with AWS or another cloud platform', 'Prior internship experience', 'Contributions to open-source projects']);
  const complete = normalizeRequirements({ requirements: [...HARD, ...PREFERRED] }, OPPORTUNITY);
  assert.equal(complete.requirements.length, 9);
  assert.deepEqual(complete.recovered, [], 'nothing to recover when the model was complete');
});

test('inconsistently classified: a preferred-section item marked hard or mandatory is downgraded, never the reverse', () => {
  const wrong = [
    { requirement: 'Familiarity with Docker', sourceQuote: 'Familiarity with Docker.', mandatory: true, hardEligibility: true },
    { requirement: 'Prior internship experience', sourceQuote: 'Prior internship experience.', mandatory: true, hardEligibility: false }
  ];
  const { requirements, reclassified } = normalizeRequirements({ requirements: [...HARD, ...wrong] }, OPPORTUNITY);
  const docker = requirements.find((item) => item.requirement === 'Familiarity with Docker');
  const internship = requirements.find((item) => item.requirement === 'Prior internship experience');
  assert.deepEqual([docker.hardEligibility, docker.mandatory, internship.hardEligibility, internship.mandatory], [false, false, false, false]);
  assert.deepEqual(reclassified.filter((item) => !item.reason), [{ id: docker.id, requirement: 'Familiarity with Docker', was: 'hard' }, { id: internship.id, requirement: 'Prior internship experience', was: 'mandatory' }], 'F1 preferred-section downgrades are unchanged');
  assert.equal(requirements.find((item) => item.requirement === 'Based in India').hardEligibility, true, 'a gate outside the section keeps the model classification');
  const python = requirements.find((item) => item.requirement === 'Proficiency in Python');
  assert.deepEqual([python.hardEligibility, python.mandatory], [false, true], 'F2: a skill outside the section is no longer a gate, but stays mandatory');
  const unlisted = normalizeRequirements({ requirements: [{ requirement: 'Open to candidates based in India', sourceQuote: 'Open to candidates based in India.', mandatory: false, hardEligibility: false }] }, OPPORTUNITY);
  assert.equal(unlisted.requirements[0].mandatory, false, 'a non-mandatory item outside the section is not promoted');
});

test('recovered requirements flow through matching, scoring and the verdict like any other', () => {
  const { requirements } = normalizeRequirements({ requirements: HARD }, OPPORTUNITY);
  const matches = normalizeMatches({ matches: [
    { requirementId: 'R1', status: 'Matched', evidenceQuote: 'B.Tech Computer Science, Techno Valley Institute, Pune, India.' },
    { requirementId: 'R2', status: 'Matched', evidenceQuote: 'Expected graduation: May 2028.' },
    { requirementId: 'R3', status: 'Matched', evidenceQuote: 'Skills: Python, SQL (basic queries and joins), React, Git.' },
    { requirementId: 'R4', status: 'Matched', evidenceQuote: 'Churn Predictor project: Python, scikit-learn.' },
    { requirementId: 'R5', status: 'Matched', evidenceQuote: 'Pune, India.' },
    { requirementId: 'R6', status: 'Missing' }, { requirementId: 'R7', status: 'Missing' }, { requirementId: 'R8', status: 'Missing' }, { requirementId: 'R9', status: 'Missing' }
  ] }, requirements, PROFILE);
  const assessment = computeAssessment(requirements, matches);
  // Before F2 this posting scored 15 of 19 weighted points (fit 79) because Python and the project were hard (weight 3).
  // Now they are mandatory (weight 2): 3 hard x 3 + 2 mandatory x 2 = 13 of 13 required, 13 of 17 overall. Formula unchanged
  // (the old 15/19 arithmetic is still pinned in test/classification.test.js with the flags set directly).
  assert.equal(assessment.fitScore, 76);
  assert.equal(assessment.evidenceCoverage, 56);
  assert.equal(assessment.verdict, 'Eligible', 'preferred gaps never affect eligibility');
  assert.deepEqual(assessment.requirementsMatch.required, { total: 5, matched: 5, partial: 0, missing: 0, unknown: 0, percent: 100, weightedEarned: 13, weightedPossible: 13 });
  assert.deepEqual(assessment.requirementsMatch.preferred, { total: 4, matched: 0, partial: 0, missing: 4, unknown: 0, percent: 0, weightedEarned: 0, weightedPossible: 4 });
  assert.match(assessment.requirementsMatch.fitExplanation, /^Fit score 76 = weighted credit 13 ÷ weighted total 17 \(required tier 13\/13, preferred tier 0\/4\)/);
  assert.match(assessment.requirementsMatch.evidenceExplanation, /^Evidence coverage 56% = 5 of 9 requirement statuses rest on a quote verified in your profile\. It is not confidence in the verdict\./);
  assert.deepEqual(WEIGHT, { hard: 3, mandatory: 2, preferred: 1 }, 'formula constants unchanged');
  assert.deepEqual(STATUS_CREDIT, { Matched: 1, 'Partial Match': 0.5, Missing: 0, Unknown: 0 });

  const out = buildDeterministicReport(requirements, matches, [], assessment, { recovered: [{ id: 'R6', requirement: 'x' }], reclassified: [] });
  assert.equal(out.preferredRequirements.length, 4);
  assert.equal(out.requirementsMatch.preferred.missing, 4);
  assert.deepEqual(out._evidenceTrace.recoveredRequirements, [{ id: 'R6', requirement: 'x' }]);
  assert.deepEqual(out._evidenceTrace.reclassifiedRequirements, []);
});

test('partial credit and empty tiers are reported honestly', () => {
  const requirements = normalizeRequirements({ requirements: HARD }, 'Eligibility:\n- Proficiency in Python.\nPreferred:\n- Familiarity with Docker.\n- Experience with AWS or another cloud platform.').requirements;
  const matches = normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Partial', evidenceQuote: 'Python' }, { requirementId: 'R2', status: 'Unknown' }, { requirementId: 'R3', status: 'Matched', evidenceQuote: 'Python' }] }, requirements, PROFILE);
  const { requirementsMatch } = computeAssessment(requirements, matches);
  assert.deepEqual([requirementsMatch.required.partial, requirementsMatch.required.percent], [1, 50]);
  assert.deepEqual([requirementsMatch.preferred.matched, requirementsMatch.preferred.unknown, requirementsMatch.preferred.percent], [1, 1, 50]);
  assert.match(requirementsMatch.fitExplanation, /weighted credit 2 ÷ weighted total 4/);
  const none = computeAssessment([], []);
  assert.equal(none.requirementsMatch.required.percent, null);
  assert.equal(none.requirementsMatch.fitExplanation, 'No fit score: no requirements were verified.');
});

test('UI: the requirements line shows both tiers and the explanations never call coverage confidence', () => {
  const r = report.adaptNovaReport({ requirementsMatch: { required: { total: 5, matched: 5, partial: 0, missing: 0, unknown: 0, percent: 100 }, preferred: { total: 4, matched: 0, partial: 1, missing: 3, unknown: 0, percent: 13 }, fitExplanation: 'Fit score 79 = x', evidenceExplanation: 'Evidence coverage 56% = y. It is not confidence in the verdict.' }, evidenceCoverage: 56, confidenceScore: 56 });
  assert.equal(report.requirementsMatchText(r), 'Required 5 / 5 · Preferred 0+1 partial / 4');
  const html = report.moduleContent('requirements', r).html;
  assert.match(html, /Requirements match:<\/b> Required 5 \/ 5 · Preferred 0\+1 partial \/ 4/);
  assert.match(html, /Fit score 79 = x/);
  assert.match(html, /not confidence in the verdict/);
  assert.match(report.buildReportText(r), /Evidence coverage: 56% of requirement statuses rest on a verified profile quote \(not confidence in the verdict\)/);
  assert.equal(report.requirementsMatchText(report.adaptNovaReport({})), null, 'reports saved before this field exists fall back');
  assert.equal(report.requirementsMatch(report.adaptNovaReport({ requirementsMatch: { required: 'x' } })), null, 'malformed shapes are ignored');
});

test('change 3, real postings: an application instruction after the Preferred list is not a preferred requirement', () => {
  const real = require('./fixtures/validation-real-2026-11-13.json');
  for (const [who, data] of Object.entries(real.cases)) {
    const lines = preferredSectionLines(data.opportunity);
    assert.equal(lines.length, 1, `${who}: only the preferred list itself is recovered, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], /^(?:Docker|AWS)/, who);
    const instruction = real.recoveredInstructionLines[who];
    if (instruction) assert.equal(lines.includes(instruction), false, `${who}: "${instruction}" is how to apply, not a requirement`);
  }
  // Instruction wording in other shapes, and a genuine preferred line that happens to start with a similar word.
  const posting = 'Preferred:\n- Docker\n- Sharing knowledge in team demos\nPlease submit your CV and transcript.\nApplications are reviewed weekly.\nHow to apply: email careers@example.com';
  assert.deepEqual(preferredSectionLines(posting), ['Docker', 'Sharing knowledge in team demos']);
  assert.deepEqual(preferredSectionLines('Nice to have: Submit pull requests to open-source projects'), ['Submit pull requests to open-source projects'], 'an instruction verb alone does not make a line an application instruction');
  assert.deepEqual(preferredSectionLines('Nice to have: Submit a portfolio with your application'), [], 'the inline form is filtered the same way');
});
