const assert = require('node:assert/strict');
const test = require('node:test');
const claims = require('../lib/claims');
const { complete } = require('./fixtures/insights');
const real = require('./fixtures/validation-real-2026-11-13.json');

/*
 * Final stabilisation batch, changes 1 and 2. Every case below is text the model actually returned on Vercel Preview
 * (build ca1d329) for the recorded profile and posting; the verdicts are the ones agreed in the validation review.
 */

const improvement = (item) => ({ section: 'x', current: item.current, suggested: item.suggested, impact: 'i' });
const tokensOf = (result) => result.diagnostics.map((item) => item.token);

for (const [who, data] of Object.entries(real.cases)) {
  test(`change 1, real output (${who}): inflating resume rewrites are withheld, honest ones kept`, () => {
    const result = claims.guardClaims('insights', complete({ resumeImprovements: data.resumeImprovements.map(improvement) }), data.profile, data.opportunity);
    const kept = new Set(result.data.resumeImprovements.map((item) => item.suggested));
    for (const item of data.resumeImprovements) {
      assert.equal(kept.has(item.suggested), item.keep, `${item.why}: "${item.current}" -> "${item.suggested}" ${JSON.stringify(result.diagnostics)}`);
    }
  });

  test(`change 2, real output (${who}): ATS suggestions naming unheld skills are withheld, formatting advice kept`, () => {
    const result = claims.guardClaims('insights', complete({ atsReadiness: { score: 70, issues: ['Missing keywords'], suggestions: data.atsSuggestions.map((item) => item.text) } }), data.profile, data.opportunity);
    const kept = new Set(result.data.atsReadiness.suggestions);
    for (const item of data.atsSuggestions) assert.equal(kept.has(item.text), item.keep, `${item.why}: "${item.text}" ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.data.atsReadiness.score, 70, 'the score is never touched');
    assert.deepEqual(result.data.atsReadiness.issues, ['Missing keywords'], 'issues are statements, never withheld');
    for (const diagnostic of result.diagnostics) assert.equal(diagnostic.field, 'atsReadiness.suggestions');
  });
}

test('change 1: the dropped qualifier is named in the diagnostic, and every hedge in the source must survive', () => {
  const profile = real.cases.aarav.profile;
  const dropped = claims.guardClaims('insights', complete({ resumeImprovements: [improvement({ current: 'Member of the coding club; helped organise two hackathons', suggested: 'Member of coding club; organized two hackathons' })] }), profile, '');
  assert.deepEqual(dropped.diagnostics, [{ field: 'resumeImprovements', reason: 'dropped qualifier', token: 'helped' }]);
  assert.ok(dropped.removed.includes('claim: dropped qualifier'));
  const keptHedge = claims.guardClaims('insights', complete({ resumeImprovements: [improvement({ current: 'Member of the coding club; helped organise two hackathons', suggested: 'Coding club member; helped organise two hackathons' })] }), profile, '');
  assert.deepEqual(keptHedge.diagnostics, [], 'the same rewrite with the hedge kept passes');
  const inflected = claims.guardClaims('insights', complete({ resumeImprovements: [improvement({ current: 'Skills: C, Python (introductory course), HTML.', suggested: 'Skills: C, Python (introductory courses), HTML.' })] }), real.cases.kabir.profile, '');
  assert.deepEqual(inflected.diagnostics, [], 'course/courses is the same hedge');
});

test('change 1: intensifiers need profile support like any other claim word', () => {
  const profile = 'LogSense, a Python log parser with unit tests.';
  for (const word of ['comprehensive', 'robust', 'rigorous', 'thorough', 'proven', 'scalable', 'end-to-end']) {
    const result = claims.guardClaims('insights', complete({ resumeImprovements: [improvement({ current: 'LogSense, a Python log parser with unit tests', suggested: `LogSense: Python log parser with ${word} unit tests` })] }), profile, '');
    assert.equal(result.data.resumeImprovements.length, 0, word);
    assert.ok(tokensOf(result).includes(word), word);
  }
  const supported = claims.guardClaims('insights', complete({ strengths: ['Comprehensive unit tests for LogSense'] }), 'LogSense has comprehensive unit tests.', '');
  assert.deepEqual(supported.diagnostics, [], 'a word the profile itself uses stays claimable');
});

test('change 2: honest ATS suggestions that name the profile\'s own skills, or only formatting, are kept', () => {
  const data = real.cases.ananya;
  const result = claims.guardClaims('insights', complete({ atsReadiness: { score: 68, issues: [], suggestions: [
    'Highlight Python and Flask in the skills section',
    'List NoteNest under Projects with the 25-classmate figure',
    'Add a Skills heading above the skills list',
    'Put your availability of 15 hours per week near the top'
  ] } }), data.profile, data.opportunity);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.data.atsReadiness.suggestions.length, 4);
});

test('change 2: the guard reads only add-type sentences, and only on atsReadiness.suggestions', () => {
  const data = real.cases.kabir;
  const statement = claims.guardClaims('insights', complete({ atsReadiness: { score: 68, issues: ['Resume does not list Java, Spring Boot or Git'], suggestions: ['Resume does not list Java, Spring Boot or Git'] } }), data.profile, data.opportunity);
  assert.deepEqual(statement.diagnostics, [], 'a statement without an add verb is not a suggestion to add');
  const weaknesses = claims.guardClaims('insights', complete({ resumeStrength: { score: 65, highlights: [], weaknesses: ['Add Java, Spring Boot and Git'] } }), data.profile, data.opportunity);
  assert.deepEqual(weaknesses.data.resumeStrength.weaknesses, ['Add Java, Spring Boot and Git'], 'other fields are untouched by this check');
  const missing = claims.guardClaims('insights', complete({ atsReadiness: { score: 68, issues: [], suggestions: ['Sprinkle the required keywords through the summary'] } }), data.profile, data.opportunity);
  assert.deepEqual(tokensOf(missing), ['missing keywords']);
});

test('change 2: malformed atsReadiness is left alone', () => {
  for (const ats of [null, 'text', [], { score: 50 }, { score: 50, suggestions: 'not a list' }]) {
    const result = claims.guardClaims('insights', complete({ atsReadiness: ats }), real.cases.kabir.profile, real.cases.kabir.opportunity);
    assert.deepEqual(result.data.atsReadiness, ats);
    assert.deepEqual(result.diagnostics, []);
  }
});
