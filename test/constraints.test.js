const assert = require('node:assert/strict');
const test = require('node:test');
const guards = require('../lib/guards');

/*
 * Deterministic constraints: graduation windows and work authorization. Unknown information must stay unknown: when a date
 * is missing, ambiguous or unparseable nothing is asserted, and no date is ever invented. Work authorization is never
 * inferred from nationality, location or degree.
 */

const WINDOW = 'Graduation window: December 2027–June 2028';
const result = (profile, opportunity = WINDOW) => guards.deriveFacts(profile, opportunity, []).graduation?.result ?? null;

// ---- graduation: boundaries ---------------------------------------------------------------------------------------

test('graduation: May 2029 and May 2028 against December 2027 to June 2028', () => {
  assert.equal(result('Expected graduation: May 2029.'), 'outside');
  assert.equal(result('Expected graduation: May 2028.'), 'within');
});

test('graduation: the window boundaries are inclusive and the months either side are outside', () => {
  assert.equal(result('Graduating December 2027.'), 'within');
  assert.equal(result('Graduating June 2028.'), 'within');
  assert.equal(result('Graduating November 2027.'), 'outside');
  assert.equal(result('Graduating July 2028.'), 'outside');
});

test('graduation: the facts carry the exact dates and never an invented one', () => {
  assert.deepEqual(guards.deriveFacts('Graduating May 2029.', WINDOW, []).graduation, { candidate: 'May 2029', requiredWindow: 'December 2027 to June 2028', result: 'outside' });
  assert.equal(guards.deriveFacts('Class of 2028', WINDOW, []).graduation.candidate, '2028', 'a year-only date stays year-only');
});

// ---- graduation: formats ------------------------------------------------------------------------------------------

test('graduation: different candidate date formats give the same answer', () => {
  for (const [text, expected] of [
    ['Expected graduation: 15 May 2028', 'within'], ['Expected graduation: May 15, 2028', 'within'], ['Graduating May 2028', 'within'],
    ['Graduating Dec. 2027', 'within'], ['Graduating Sept 2028', 'outside'], ['Graduation: 05/2028', 'within'], ['Graduation: 2028-05', 'within'],
    ['Graduation: 05/15/2028', 'within'], ['Graduation: 15/05/2028', 'within'], ['Graduation: 05/2029', 'outside'], ['Expected graduation 31st May 2029', 'outside']
  ]) assert.equal(result(text), expected, text);
});

test('graduation: different posting window formats give the same answer', () => {
  for (const opportunity of [
    'Applicants must graduate between December 2027 and June 2028.', 'Graduation window: Dec 2027 to Jun 2028', 'Graduation date: 12/2027 - 06/2028',
    'Graduating from 2027-12 to 2028-06 only', 'Expected graduation: Dec. 2027 – Jun. 2028', 'Candidates graduating December 2027 through June 2028'
  ]) {
    assert.equal(result('Graduating May 2028.', opportunity), 'within', opportunity);
    assert.equal(result('Graduating May 2029.', opportunity), 'outside', opportunity);
  }
});

// ---- graduation: unknown stays unknown ----------------------------------------------------------------------------

test('graduation: missing, ambiguous or non-graduation dates assert nothing', () => {
  assert.equal(result('Passionate about finance.'), null, 'no date');
  assert.equal(result('B.Tech 2024-2028 at an Indian university.'), null, 'a degree span is not a stated graduation date');
  assert.equal(result('Graduating May 2029. Graduated high school in June 2023.'), null, 'two graduation dates: ambiguous');
  assert.equal(result('Expected graduation May 2028 or December 2028.'), null, 'alternatives: ambiguous');
  assert.equal(result('Graduating soon.'), null);
  assert.equal(result('Graduating May 2028.', 'Summer analyst role. Apply by June 2028.'), null, 'no window in the posting');
  assert.equal(result('Graduating May 2028.', 'Graduate by June 2028.'), null, 'a single bound is not a window');
  assert.equal(result('Graduating May 2028.', 'Cohort A graduating December 2027 to June 2028. Cohort B graduating December 2028 to June 2029.'), null, 'two windows: ambiguous');
  assert.equal(result('Graduation 06/07/2028'), 'unknown', 'day/month order unknown, so the month is not guessed (year-only against an edge year)');
});

test('graduation: ambiguity produces no constraint note and no failed-requirement claim', () => {
  const rows = [{ requirement: 'Excel', status: 'Unknown', hardEligibility: false, mandatory: false }];
  const facts = guards.deriveFacts('Graduating May 2029. Graduated school June 2023.', WINDOW, rows);
  assert.equal(facts.graduation, null);
  assert.deepEqual(guards.constraintNotes(facts, rows), []);
});

// ---- cycle advice, alternative wording ----------------------------------------------------------------------------

const FAILED = { failedHardRequirements: ['Graduation between December 2027 and June 2028'], workAuthorization: { usStudyOrStatusStated: false, statedRoutes: [] } };
const adviceSurvives = (text, facts = FAILED) => guards.guardSectionData({ line: text }, { sourceText: ['profile', 'posting'], facts }).data.line === text;

test('cycle advice: alternative wordings of "apply in another cycle" are removed when a hard requirement failed', () => {
  for (const text of [
    'Target the Summer 2028 programme instead', 'Apply next year', 'Consider the following intake', 'Wait for the next cohort, then apply',
    'Re-apply once you meet the window', 'Come back to this when the next round opens', 'Postpone your application until you graduate',
    'Hold off on applying until the next batch', 'Apply to the 2029 programme', 'Look for a later session', 'Try again next time round',
    'Apply when your graduation window matches and applications reopen', 'Defer applying to the upcoming edition', 'Aim for the 2029 intake'
  ]) assert.equal(adviceSurvives(text), false, text);
});

test('cycle advice: ordinary advice and the same words with no failed hard requirement are left alone', () => {
  for (const text of ['Confirm the requirement with the organiser', 'Build a small Excel model this week', 'Check each posting\'s stated window before applying', 'Practise case interviews']) {
    assert.equal(adviceSurvives(text), true, text);
  }
  assert.equal(adviceSurvives('Apply next year', { failedHardRequirements: [], workAuthorization: { statedRoutes: [] } }), true, 'no failed hard requirement: not touched');
});

// ---- work authorization -------------------------------------------------------------------------------------------

const AUTH_ROW = { requirement: 'US work authorization', status: 'Missing', hardEligibility: true, mandatory: true };
const POSTING = 'Mandatory US work authorization.';
const auth = (profile) => guards.deriveFacts(profile, POSTING, [AUTH_ROW]);
const adviceFor = (profile, text) => {
  const facts = auth(profile);
  return guards.guardSectionData({ line: text }, { sourceText: [profile, POSTING], facts }).data.line === text;
};

test('work authorization 1: studying in India with no US authorization gets no visa route', () => {
  const profile = 'B.Tech student at an Indian university in Pune, India. No US work authorization.';
  const facts = auth(profile);
  assert.equal(facts.workAuthorization.usStudyOrStatusStated, false);
  assert.equal(facts.workAuthorization.usWorkAuthorizationStated, false);
  assert.deepEqual(facts.workAuthorization.statedRoutes, []);
  for (const text of ['Investigate CPT or OPT with your university', 'Look into F-1 and H-1B routes', 'You may qualify for OPT']) assert.equal(adviceFor(profile, text), false, text);
  assert.equal(adviceFor(profile, 'Confirm the organiser\'s work-authorization rules directly'), true);
  const note = guards.constraintNotes(facts, [AUTH_ROW]).find((item) => /Work authorization/.test(item.concern));
  assert.match(note.action, /has not assumed any visa route/);
});

test('work authorization 2: studying in the US with no stated authorization may be pointed to the school, never told they are eligible', () => {
  const profile = 'I study computer science at a US university.';
  const facts = auth(profile);
  assert.equal(facts.workAuthorization.usStudyOrStatusStated, true);
  assert.equal(facts.workAuthorization.usWorkAuthorizationStated, false);
  assert.deepEqual(facts.workAuthorization.statedRoutes, []);
  assert.equal(adviceFor(profile, 'Ask your international student office whether CPT is possible'), true);
  for (const text of ['You are eligible for CPT', 'You qualify for OPT after graduation', 'Your degree makes you eligible for STEM OPT', 'You can use CPT to work this summer']) assert.equal(adviceFor(profile, text), false, text);
  const note = guards.constraintNotes(facts, [AUTH_ROW]).find((item) => /Work authorization/.test(item.concern));
  assert.match(note.action, /Nova cannot decide that for you/);
  assert.doesNotMatch(note.action, /has not assumed/);
});

test('work authorization 3: explicit US student status allows only the routes the profile states', () => {
  const profile = 'I am an F-1 student at a US university, currently on CPT.';
  const facts = auth(profile);
  assert.equal(facts.workAuthorization.usStudyOrStatusStated, true);
  assert.deepEqual(facts.workAuthorization.statedRoutes, ['CPT', 'F1']);
  assert.equal(adviceFor(profile, 'Your CPT authorization may need updating: confirm with your DSO'), true);
  assert.equal(adviceFor(profile, 'You are eligible for CPT'), true, 'a route the profile itself states');
  assert.equal(adviceFor(profile, 'You are eligible for STEM OPT'), false, 'a route the profile does not state is still an eligibility claim');
  assert.equal(adviceFor(profile, 'Confirm whether you are eligible for OPT with your DSO'), true, 'advice to check is not an assertion');
});

test('work authorization 4: explicit US work authorization is recognised and does not invite visa-route advice', () => {
  for (const profile of ['I am a US citizen studying in Texas.', 'U.S. citizen.', 'I am authorized to work in the United States.', 'Permanent resident of the US', 'H-1B holder', 'I hold a green card.']) {
    const facts = auth(profile);
    assert.equal(facts.workAuthorization.usWorkAuthorizationStated, true, profile);
    assert.equal(adviceFor(profile, 'Look into OPT or CPT'), false, `${profile}: a route is irrelevant to someone already authorized`);
  }
  const note = guards.constraintNotes(auth('I am a US citizen.'), [AUTH_ROW]).find((item) => /Work authorization/.test(item.concern));
  assert.doesNotMatch(note.action, /has not assumed/);
});

test('work authorization 5: missing or ambiguous information is never read as a status', () => {
  for (const profile of [
    'Final year student interested in finance.',
    'Open to relocating to the US.',
    'I plan to study in the US next year.',
    'Hoping to get a US work visa one day.',
    'Not sure whether I am authorized to work in the US.',
    'I do not hold F-1 status.',
    'I need sponsorship to work in the US.',
    'If I get into a US university I will apply for CPT.',
    ''
  ]) {
    const facts = auth(profile).workAuthorization;
    assert.equal(facts.usStudyOrStatusStated, false, profile);
    assert.equal(facts.usWorkAuthorizationStated, false, profile);
    assert.deepEqual(facts.statedRoutes, [], profile);
  }
});

test('work authorization: nothing is inferred from nationality, location or degree alone', () => {
  for (const profile of [
    'Indian citizen with a B.Tech in India.', 'Lives in New York.', 'Born in California.', 'MBA graduate from a top school.', 'Bachelor of Science, Computer Science.',
    'Working in the United States as a freelancer.', 'Citizen of India, based in London.', 'Visited the US for a conference.'
  ]) {
    const facts = auth(profile).workAuthorization;
    assert.equal(facts.usStudyOrStatusStated, false, profile);
    assert.equal(facts.usWorkAuthorizationStated, false, profile);
    assert.equal(adviceFor(profile, 'Look into CPT'), false, profile);
  }
});
