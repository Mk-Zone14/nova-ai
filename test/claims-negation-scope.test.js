const assert = require('node:assert/strict');
const test = require('node:test');
const claims = require('../lib/claims');
const { complete } = require('./fixtures/insights');
const real = require('./fixtures/withheld-real-2026-11-11.json');

/*
 * F3 follow-up: negation scope.
 *
 * The fixture is a real /api/narrative insights run on Vercel Preview (build 7e56942, Groq gpt-oss-120b): the profile, the
 * posting, and the exact `_withheld` diagnostics it returned. The guard only reports the single token that tripped each
 * check, so each diagnostic below is paired with a representative sentence built from that token and from words in the
 * profile. Where the withhold was right it must stay withheld; where it was a false positive it must now be kept.
 */

const PROFILE = real.profile;
const OPPORTUNITY = real.opportunity;
const run = (overrides, profile = PROFILE, opportunity = OPPORTUNITY) => claims.guardClaims('insights', complete(overrides), profile, opportunity);
const tokensOf = (result) => result.diagnostics.map((item) => item.token);
const improvement = (current, suggested) => ({ section: 'x', current, suggested, impact: 'High' });

// One representative sentence per real diagnostic. `keep` is the verdict recorded in the fixture.
const CASES = [
  { token: 'proficiency', keep: false, over: { strengths: ['Proficiency in Python and SQL'] } },
  { token: 'basic', keep: true, over: { strengths: ['Skills: React, Node.js, Python, SQL (basic queries and joins), Git'] } },
  { token: 'organized', keep: true, over: { strengths: ['Organized two hackathons with the coding club'] } },
  { token: 'basics', keep: true, over: { resumeStrength: { score: 70, highlights: ['SQL basics alongside React and Node.js'], weaknesses: [] } }, extra: 'alongside' },
  { token: 'development', keep: true, over: { resumeStrength: { score: 70, highlights: ['Web development with React and Node.js'], weaknesses: [] } } },
  { token: 'experience', keep: false, over: { resumeStrength: { score: 70, highlights: ['Experience with cloud platforms and Docker'], weaknesses: [] } } },
  { token: 'organisation', keep: true, over: { resumeStrength: { score: 70, highlights: ['Hackathon organisation with the coding club'], weaknesses: [] } } },
  { token: 'adopted', keep: false, over: { resumeImprovements: [improvement('Projects: CampusConnect, a full-stack web app (React, Node.js, PostgreSQL) used by 40 classmates to share notes;', 'CampusConnect: full-stack web app adopted by 40 classmates')] } },
  { token: 'co-organised', keep: false, over: { resumeImprovements: [improvement('Member of the coding club; helped organise two hackathons.', 'Coding club member; co-organised two hackathons')] } }
];

test('fixture: every real diagnostic token has a case, and the recorded verdicts agree with it', () => {
  const covered = new Set(CASES.map((item) => item.token));
  for (const { token } of real.withheld) assert.ok(covered.has(token), `no regression case for real diagnostic "${token}"`);
  for (const item of CASES) {
    const verdict = real.verdicts[item.token];
    assert.ok(verdict, `fixture has no verdict for "${item.token}"`);
    assert.equal(item.keep, verdict.startsWith('false positive'), `verdict for "${item.token}" is "${verdict}"`);
  }
});

for (const item of CASES) {
  test(`real diagnostic "${item.token}": ${item.keep ? 'false positive, now kept' : 'true positive, still withheld'}`, () => {
    const result = run(item.over);
    const withheld = tokensOf(result);
    if (item.keep) {
      // `extra` lists words the sentence itself added that the guard is meant to check (the sentence is ours, not the model's).
      const unexpected = withheld.filter((token) => token !== item.extra);
      assert.deepEqual(unexpected, [], `withheld ${JSON.stringify(result.diagnostics)}`);
    } else {
      assert.ok(withheld.includes(item.token), `expected "${item.token}" to stay withheld, got ${JSON.stringify(result.diagnostics)}`);
    }
  });
}

test('the real profile now blocks what it lacks and nothing else', () => {
  const blocked = [...claims.blockedTerms(PROFILE)];
  assert.deepEqual(blocked, ['excel', 'cloud', 'docker']);
  for (const word of ['basic', 'beyond', 'sql', 'python']) assert.equal(blocked.includes(word), false, word);
});

test('negation about Excel does not suppress SQL, but Excel, cloud and Docker claims are still withheld', () => {
  const kept = run({ strengths: ['Skills: React, Node.js, Python, SQL (basic queries and joins), Git'] });
  assert.equal(kept.removed.length, 0);
  assert.equal(kept.data.strengths.length, 1);
  for (const text of ['Completed a data analysis course using Excel', 'Docker containers for CampusConnect', 'Cloud deployment of CampusConnect']) {
    const result = run({ resumeImprovements: [improvement('Completed a data analysis course.', text)] });
    assert.equal(result.data.resumeImprovements.length, 0, text);
    assert.ok(result.removed.includes('claim: contradicts profile'), text);
  }
});

test('level words are never blocked, and claiming the level that was denied is still withheld', () => {
  const profile = 'Skills: Python, SQL. Have not used Excel beyond basics.';
  assert.deepEqual([...claims.blockedTerms(profile)], ['excel']);
  const advanced = claims.guardClaims('insights', complete({ resumeImprovements: [improvement('Skills: Python, SQL.', 'Skills: Python, advanced SQL.')] }), profile, '');
  assert.equal(advanced.data.resumeImprovements.length, 0, '"advanced" is a claim word the profile does not support');
  assert.ok(advanced.removed.includes('claim: unsupported claim word'));
  const noExcel = claims.guardClaims('insights', complete({ resumeImprovements: [improvement('Skills: Python, SQL.', 'Skills: Python, SQL, Excel.')] }), profile, '');
  assert.equal(noExcel.data.resumeImprovements.length, 0, 'Excel is still not claimable');
});

test('a word used affirmatively elsewhere in the profile is not made a contradiction by one negated clause', () => {
  const profile = 'Skills: Python, SQL. No experience with SQL window functions.';
  assert.equal(claims.blockedTerms(profile).has('sql'), false);
  const ok = claims.guardClaims('insights', complete({ strengths: ['Python and SQL'] }), profile, 'SQL role');
  assert.deepEqual(ok.diagnostics, []);
  const overclaim = claims.guardClaims('insights', complete({ strengths: ['Experience with SQL window functions'] }), profile, 'SQL window functions');
  assert.equal(overclaim.data.strengths.length, 0, 'still withheld: "experience" and "functions" exist only inside the negated clause');
});

test('scope: a negated clause ends at a contrast or a new predicate, with or without a comma', () => {
  const lacks = (text) => [...claims.blockedTerms(text)];
  assert.deepEqual(lacks('No experience with Docker but proficient in SQL.'), ['docker']);
  assert.deepEqual(lacks('No experience with Docker, but proficient in SQL.'), ['docker']);
  assert.deepEqual(lacks('No experience with Docker however proficient in SQL.'), ['docker']);
  assert.deepEqual(lacks('No experience with Docker and have built three web apps in Flask.'), ['docker']);
  assert.deepEqual(lacks('No experience with Docker and currently learning Flask.'), ['docker']);
  assert.deepEqual(lacks('No experience with cloud platforms or Docker and Kubernetes.'), ['cloud', 'docker', 'kubernet'], 'a list of lacks continues through "or" and "and"');
  const profile = 'Skills: Python, SQL. No experience with Docker but proficient in SQL.';
  const kept = claims.guardClaims('insights', complete({ strengths: ['Proficient in SQL'] }), profile, 'SQL');
  assert.deepEqual(kept.diagnostics, [], 'the profile says proficient in SQL');
  const blocked = claims.guardClaims('insights', complete({ strengths: ['Docker for SQL'] }), profile, 'Docker SQL');
  assert.ok(tokensOf(blocked).includes('docker'), 'Docker stays blocked');
});

test('scope: a claim cannot hide inside a negated clause of the generated text', () => {
  const profile = 'Skills: Python. Member of the coding club.';
  const result = claims.guardClaims('insights', complete({ strengths: ['No Docker but led the coding club'] }), profile, 'Docker');
  assert.ok(result.removed.includes('claim: unsupported claim word'), '"led" follows the contrast, so it is not covered by the negation');
  assert.ok(tokensOf(result).includes('led'));
});

test('traceability: spelling and inflection variants of a profile word are the same word, claim words are not', () => {
  const profile = 'Member of the coding club; helped organise two hackathons.';
  for (const text of ['Organised two hackathons', 'Organized two hackathons', 'Hackathon organisation', 'Hackathon organization']) {
    const result = claims.guardClaims('insights', complete({ strengths: [text] }), profile, '');
    assert.deepEqual(result.diagnostics, [], text);
  }
  const upgraded = claims.guardClaims('insights', complete({ strengths: ['Co-organised two hackathons'] }), profile, '');
  assert.deepEqual(tokensOf(upgraded), ['co-organised'], 'the upgrade from "helped organise" is a claim word with no support');
  const invented = claims.guardClaims('insights', complete({ strengths: ['Organised a conference'] }), profile, '');
  assert.deepEqual(tokensOf(invented), ['conference'], 'a word that is not in the profile is still untraceable');
});

test('traceability: "queries" in the profile makes "query" traceable (found in a second real run)', () => {
  const profile = 'Skills: Python, SQL (basic queries and joins), Git.';
  const ok = claims.guardClaims('insights', complete({ strengths: ['SQL query skills listed with Python'] }), profile, '');
  assert.deepEqual(tokensOf(ok).filter((token) => token !== 'skills'), [], JSON.stringify(ok.diagnostics));
  const bad = claims.guardClaims('insights', complete({ strengths: ['SQL query optimisation'] }), profile, '');
  assert.ok(tokensOf(bad).includes('optimisation'), 'a word that is not in the profile is still untraceable');
});

test('traceability: neutral vocabulary is exempt, claim and technology words are not', () => {
  const profile = 'Skills: Python, React. Churn Predictor reached 88.5% accuracy.';
  const ok = claims.guardClaims('insights', complete({ strengths: ['Web development in React', 'Quantified churn accuracy at 88.5%'] }), profile, '');
  assert.deepEqual(ok.diagnostics, []);
  const bad = claims.guardClaims('insights', complete({ strengths: ['Development of microservices in React', 'Led development in React'] }), profile, '');
  assert.deepEqual([...new Set(tokensOf(bad))], ['microservices', 'led']);
});

test('documented limit: JavaScript is withheld from a resume suggestion when the profile lists only React and Node.js', () => {
  // React and Node.js are JavaScript technologies, but the guard compares what the profile says, not what it implies.
  // Adding an implication table would let the model assert skills the applicant never listed; withholding is the safe side.
  const result = run({ resumeImprovements: [improvement('Skills: React, Node.js, Python, SQL (basic queries and joins), Git', 'Skills: JavaScript (React, Node.js), Python, SQL (basic queries and joins), Git')] });
  assert.equal(result.data.resumeImprovements.length, 0);
  assert.deepEqual(result.diagnostics, [{ field: 'resumeImprovements', reason: 'term not in profile', token: 'JavaScript' }]);
});

test('full-stack and the figures the profile gives are kept; "used by" is not upgraded', () => {
  const kept = run({ strengths: ['Projects: CampusConnect, a full-stack web app (React, Node.js, PostgreSQL) used by 40 classmates to share notes'] });
  assert.deepEqual(kept.diagnostics, []);
  const upgraded = run({ strengths: ['CampusConnect adopted by 40 classmates'] });
  assert.ok(tokensOf(upgraded).includes('adopted'));
});
