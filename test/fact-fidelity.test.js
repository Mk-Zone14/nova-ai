const assert = require('node:assert/strict');
const test = require('node:test');
const { complete } = require('./fixtures/insights');
const guards = require('../lib/guards');
const prompts = require('../lib/prompts');
const rateLimit = require('../lib/rate-limit');
const analyze = require('../api/analyze');
const narrative = require('../api/narrative');
const { normalizeRequirements, normalizeMatches } = require('../lib/eligibility');
const model = require('../report-model');

/*
 * Regression tests for the four findings of the production audit:
 *   1. numerical evidence was rewritten by the model (ROC-AUC 0.7738 -> 0.7744, accuracy 79.4% -> 79%)
 *   2. "target Summer 2028" was offered as if it resolved a graduation-window mismatch
 *   3. CPT/OPT was suggested to a candidate with no US study or status
 *   4. learning links presented as course links were provider homepages
 * The fixtures reproduce the audited candidate and opportunity.
 */

const PROFILE = 'B.Tech CSE (AI/ML) at an Indian university, expected graduation May 2029. CGPA 8.83/10. No US work authorization. No previous investment banking internship. Credit Card Default Prediction project: ROC-AUC 0.7738, Accuracy 79.4%.';
const OPPORTUNITY = 'Summer 2027 Investment Banking Summer Analyst.\nEligibility: Mandatory graduation window: December 2027–June 2028. Mandatory US work authorization.\nPreferred: finance, analytical, quantitative, Excel, modelling and communication skills.';
const ROWS = [
  { requirement: 'Graduation between December 2027 and June 2028', status: 'Missing', hardEligibility: true, mandatory: true },
  { requirement: 'US work authorization', status: 'Missing', hardEligibility: true, mandatory: true },
  { requirement: 'Excel', status: 'Unknown', hardEligibility: false, mandatory: false }
];
const ASSESSMENT = { verdict: 'Not eligible', rows: ROWS };

function response() {
  return { headers: {}, statusCode: null, body: null, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
const originalFetch = global.fetch;
const originalKey = process.env.GROQ_API_KEY;
const originalWarn = console.warn;
test.beforeEach(() => { rateLimit.resetRateLimits(); process.env.GROQ_API_KEY = 'test-key'; });
test.after(() => {
  global.fetch = originalFetch;
  console.warn = originalWarn;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalKey;
});
function fakeModel(reply, sent = []) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply(body)) } }] }) };
  };
}
async function runNarrative(section, reply, overrides = {}, sent = []) {
  global.fetch = fakeModel(reply, sent);
  const warnings = [];
  console.warn = (line) => warnings.push(line);
  const res = response();
  await narrative({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { profile: PROFILE, opportunity: OPPORTUNITY, section, assessment: ASSESSMENT, ...overrides } }, res);
  console.warn = originalWarn;
  return { res, warnings, sent };
}

// ---- 1. numerical evidence ------------------------------------------------------------------------------------------

test('figures: the audited rewrites are caught, and the exact source figures are not', () => {
  const source = guards.figureKeys(`${PROFILE}\n${OPPORTUNITY}`);
  assert.deepEqual(guards.unsupportedFigures('ROC-AUC of 0.7744', source), ['0.7744']);
  assert.deepEqual(guards.unsupportedFigures('about 79% accuracy', source), ['79%']);
  assert.deepEqual(guards.unsupportedFigures('ROC-AUC 0.7738 and accuracy 79.4%', source), []);
  assert.deepEqual(guards.unsupportedFigures('CGPA 8.83/10', source), []);
  assert.deepEqual(guards.unsupportedFigures('an AUC around 0.77', source), ['0.77'], 'rounding is a different figure');
  assert.deepEqual(guards.unsupportedFigures('accuracy of 0.794', source), ['0.794'], 'a unit conversion is a different figure');
});

test('figures: ordinary writing is not flagged (years, durations, small counts, ids, versions, source numbers)', () => {
  const source = guards.figureKeys('Built a dashboard used by 10,000+ users. Python 3 and SQL.');
  for (const text of ['Spend 1.5 hours a day for 6 weeks', 'Week 2: practise SQL', 'Prepare 5 questions', 'Graduating in 2029', 'Requirement R1 and R12', 'Use H1B or F1 notation', 'Upgrade to v3.11', 'Used by 10,000 users', 'Plan a 2-3 hour block', 'Two 90 minute sessions']) {
    assert.deepEqual(guards.unsupportedFigures(text, source), [], text);
  }
  assert.deepEqual(guards.unsupportedFigures('Used by 25,000 users', source), ['25,000'], 'a new large number is a new claim');
});

test('narrative handler: a rewritten metric is withheld from every section, exact metrics survive (production regression)', async () => {
  const reply = () => complete({
    resumeImprovements: [
      { section: 'Projects', current: 'Credit Card Default Prediction', suggested: 'Built a default risk classifier (ROC-AUC 0.7744, 79% accuracy)', impact: 'High' },
      { section: 'Projects', current: 'Credit Card Default Prediction', suggested: 'Built a default risk classifier (ROC-AUC 0.7738, accuracy 79.4%)', impact: 'High' }
    ],
    personalizedRecommendations: ['Lead with the ROC-AUC of 0.7744 in applications', 'Learn Excel modelling for 10 hours'],
    strengths: ['Project accuracy 79.4%', 'Project accuracy of roughly 79%'],
    profileSummary: { cgpa: '8.83/10', projects: ['Credit Card Default Prediction (ROC-AUC 0.7738)', 'Another (ROC-AUC 0.7744)'] }
  });
  const { res, warnings } = await runNarrative('insights', reply);
  assert.equal(res.statusCode, 200);
  const data = res.body.data;
  assert.deepEqual(data.resumeImprovements.map((item) => item.suggested), ['Built a default risk classifier (ROC-AUC 0.7738, accuracy 79.4%)']);
  assert.deepEqual(data.personalizedRecommendations, ['Learn Excel modelling for 10 hours']);
  assert.deepEqual(data.strengths, ['Project accuracy 79.4%']);
  assert.deepEqual(data.profileSummary, { cgpa: '8.83/10', projects: ['Credit Card Default Prediction (ROC-AUC 0.7738)'] });
  assert.ok(!JSON.stringify(data).includes('0.7744') && !JSON.stringify(data).includes('79%'));
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /0\.77|ROC|79/, 'the log records that something was withheld, never the content');
});

test('narrative handler: cover letter and interview answers keep exact figures and lose only the offending sentence or question', async () => {
  const letter = 'Dear hiring team,\n\nI built a credit default model with ROC-AUC 0.7738 and accuracy 79.4%. I reached 79% accuracy in testing. I am keen to learn Excel modelling.\n\nThank you for your time.';
  const letterRun = await runNarrative('coverLetter', () => ({ coverLetter: letter }));
  assert.equal(letterRun.res.body.data.coverLetter, 'Dear hiring team,\n\nI built a credit default model with ROC-AUC 0.7738 and accuracy 79.4%. I am keen to learn Excel modelling.\n\nThank you for your time.');

  const interview = await runNarrative('interview', () => ({
    interviewQuestions: [
      { question: 'Tell us about your project', whyAsked: 'Depth', suggestedAnswer: 'ROC-AUC 0.7738 with accuracy 79.4%.' },
      { question: 'Tell us about your model quality', whyAsked: 'Rigour', suggestedAnswer: 'ROC-AUC 0.7744 and 79% accuracy.' }
    ]
  }));
  assert.deepEqual(interview.res.body.data.interviewQuestions.map((item) => item.question), ['Tell us about your project']);
});

test('narrative handler: text the guard has no objection to is returned byte for byte', async () => {
  const letter = 'Dear team,  I built a model with 79.4% accuracy.\n\n\nThank you.\n';
  const { res } = await runNarrative('coverLetter', () => ({ coverLetter: letter.repeat(2) }));
  assert.equal(res.body.data.coverLetter, letter.repeat(2));
});

test('matcher reasoning: a figure that is not in the profile or the requirement withholds the explanation, not the status', () => {
  const requirements = [{ id: 'R1', requirement: 'Minimum CGPA 8.0', sourceQuote: 'Minimum CGPA 8.0', hardEligibility: false, mandatory: true }];
  const run = (reasoning) => normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Matched', evidenceQuote: 'CGPA 8.83/10', reasoning }] }, requirements, PROFILE)[0];
  const exact = run('CGPA 8.83 exceeds the 8.0 minimum.');
  assert.equal(exact.reasoning, 'CGPA 8.83 exceeds the 8.0 minimum.');
  const altered = run('CGPA 8.8 exceeds the 8.0 minimum.');
  assert.equal(altered.status, 'Matched', 'the verified status is untouched');
  assert.match(altered.reasoning, /withheld/);
  assert.doesNotMatch(altered.reasoning, /8\.8\b/);
});

test('requirement wording: a paraphrase that alters a figure is replaced by the posting\'s own quote', () => {
  const opportunity = 'Eligibility: minimum CGPA of 7.55 required.';
  const out = normalizeRequirements({ requirements: [{ requirement: 'CGPA of at least 7.5', sourceQuote: 'minimum CGPA of 7.55 required', mandatory: true, hardEligibility: true }] }, opportunity);
  assert.equal(out.requirements[0].requirement, 'minimum CGPA of 7.55 required');
  const faithful = normalizeRequirements({ requirements: [{ requirement: 'CGPA of at least 7.55', sourceQuote: 'minimum CGPA of 7.55 required', mandatory: true, hardEligibility: true }] }, opportunity);
  assert.equal(faithful.requirements[0].requirement, 'CGPA of at least 7.55');
});

// ---- 2. graduation window and next-cycle advice -----------------------------------------------------------------------

test('graduation facts: the audited mismatch is computed in code', () => {
  const facts = guards.deriveFacts(PROFILE, OPPORTUNITY, ROWS);
  assert.deepEqual(facts.graduation, { candidate: 'May 2029', requiredWindow: 'December 2027 to June 2028', result: 'outside' });
  assert.deepEqual(facts.failedHardRequirements, ['Graduation between December 2027 and June 2028', 'US work authorization']);
});

test('graduation facts: window and date formats, edges, and uncertainty', () => {
  const result = (profile, opportunity) => guards.deriveFacts(profile, opportunity, []).graduation?.result ?? null;
  assert.equal(result('Graduating June 2028.', 'Graduation window: December 2027 - June 2028'), 'within');
  assert.equal(result('Graduating December 2027.', 'Applicants must graduate between December 2027 and June 2028.'), 'within', 'window edges are inclusive');
  assert.equal(result('Graduating July 2028.', 'Applicants must graduate between December 2027 and June 2028.'), 'outside');
  assert.equal(result('Graduating November 2027.', 'Expected graduation: Dec 2027 to Jun 2028'), 'outside');
  assert.equal(result('Class of 2029', 'Graduation window: December 2027–June 2028'), 'outside');
  assert.equal(result('Class of 2028', 'Graduation window: December 2027–June 2028'), 'unknown', 'a year alone cannot be placed against a window edge');
  assert.equal(result('Class of 2027', 'Graduation window: 2027-2028'), 'unknown');
  assert.equal(result('Expected graduation: 2026', 'Graduation window: 2027–2028'), 'outside');
  assert.equal(result('No dates here.', 'Graduation window: December 2027–June 2028'), null, 'no stated date: nothing is asserted');
  assert.equal(result('Graduating May 2029. Earlier I graduated high school in June 2023.', 'Graduation window: December 2027–June 2028'), null, 'two graduation dates are ambiguous, so none is asserted');
  assert.equal(result('Graduating May 2029.', 'Summer analyst, apply by 2027.'), null, 'no window in the posting');
});

test('constraint notes: built from facts, explicit about the mismatch, and never name another cycle or opportunity', () => {
  const facts = guards.deriveFacts(PROFILE, OPPORTUNITY, ROWS);
  const notes = guards.constraintNotes(facts, ROWS);
  assert.equal(notes.length, 2, 'graduation (with the dates) and work authorization; the graduation row is not repeated');
  assert.match(notes[0].concern, /May 2029/);
  assert.match(notes[0].concern, /December 2027 to June 2028/);
  assert.match(notes[0].action, /not guaranteed to resolve/);
  for (const note of notes) {
    assert.doesNotMatch(`${note.concern} ${note.action}`, /(summer|winter|spring|fall|autumn) 20\d\d|next (year|cycle|intake)|re-?apply|apply (again|next|later)/i, 'no alternative cycle is named or recommended');
  }
  assert.match(notes[0].action, /^Do not plan around a different application cycle/, 'the only mention of another cycle is a warning against relying on it');
});

test('constraint notes: a failed hard requirement is stated as pass/fail; an unverified one asks for verification; an eligible candidate gets none', () => {
  const rows = [
    { requirement: 'Age 18-25', status: 'Missing', hardEligibility: true, mandatory: true },
    { requirement: 'Enrolled undergraduate', status: 'Unknown', hardEligibility: true, mandatory: true },
    { requirement: 'React', status: 'Missing', hardEligibility: false, mandatory: false }
  ];
  const notes = guards.constraintNotes(guards.deriveFacts('Age 27.', 'Age 18-25 only.', rows), rows);
  assert.equal(notes.length, 2);
  assert.match(notes[0].concern, /Age 18-25/);
  assert.match(notes[0].action, /pass\/fail/);
  assert.match(notes[1].concern, /not verified/);
  const eligible = [{ requirement: 'Python', status: 'Matched', hardEligibility: true, mandatory: true }];
  assert.deepEqual(guards.constraintNotes(guards.deriveFacts('Python.', 'Python required.', eligible), eligible), []);
});

test('cycle advice: removed when a hard requirement failed (including the audited sentence), kept when none did', async () => {
  const reply = () => complete({
    personalizedRecommendations: [
      'Target Summer 2028 applications once your profile is stronger',
      'Re-apply in the next application cycle',
      'Consider applying for the following intake',
      'Build a small Excel financial model to show quantitative skill'
    ],
    roadmap: [{ week: 'Week 1', focus: 'Excel', action: 'Wait for next year\'s cycle, then apply' }, { week: 'Week 2', focus: 'Modelling', action: 'Build a three-statement model' }]
  });
  const failed = await runNarrative('insights', reply);
  assert.deepEqual(failed.res.body.data.personalizedRecommendations, ['Build a small Excel financial model to show quantitative skill']);
  assert.deepEqual(failed.res.body.data.roadmap.map((item) => item.week), ['Week 2']);

  const noFailure = { verdict: 'Needs verification', rows: [{ requirement: 'Excel', status: 'Unknown', hardEligibility: false, mandatory: false }] };
  const fine = await runNarrative('insights', reply, { assessment: noFailure });
  assert.equal(fine.res.body.data.personalizedRecommendations.length, 4, 'with no failed hard requirement, other advice is not touched');
});

test('narrative prompt: verified constraints reach the model as data and the rules forbid the audited advice', async () => {
  const { sent } = await runNarrative('insights', () => complete({ strengths: ['Python'] }));
  const data = JSON.parse(sent[0].messages.find((m) => m.role === 'user').content);
  assert.deepEqual(data.verified_assessment.constraints.graduation, { candidate: 'May 2029', requiredWindow: 'December 2027 to June 2028', result: 'outside' });
  assert.equal(data.verified_assessment.constraints.workAuthorization.usStudyOrStatusStated, false);
  const system = sent[0].messages.find((m) => m.role === 'system').content;
  assert.match(system, /Never round, convert, recompute/);
  assert.match(system, /Do not suggest that applying in a different year, cycle, intake or programme resolves it/);
  assert.match(system, /never describe the candidate as meeting a graduation window when result is "outside"/);
  assert.ok(!system.includes('0.7738'), 'the system message still holds no user text');
});

// ---- 3. work authorization --------------------------------------------------------------------------------------------

test('work authorization: US-study context is detected only from explicit statements', () => {
  const stated = ['I am an F-1 student', 'Currently on OPT until 2027', 'I study at a US university', 'Studying in the United States on a student visa', 'Enrolled at an American university'];
  for (const profile of stated) assert.equal(guards.deriveFacts(profile, 'x', []).workAuthorization.usStudyOrStatusStated, true, profile);
  const notStated = [PROFILE, 'Studies at IIT Bombay. No US work authorization.', 'Indian citizen studying in Kolkata', 'Exchange semester planned in the future', 'Interested in US markets', 'Applying for CPT this summer', 'I plan to study in the US next year', 'I do not hold F-1 status'];
  for (const profile of notStated) assert.equal(guards.deriveFacts(profile, 'x', []).workAuthorization.usStudyOrStatusStated, false, profile);
});

test('visa routes: removed without US context (the audited CPT/OPT advice), allowed with it, other visa facts untouched', async () => {
  const reply = () => complete({
    personalizedRecommendations: [
      'Investigate CPT/OPT eligibility with your university',
      'Look into F-1 and H-1B routes',
      'Confirm the organiser\'s work-authorization rules directly',
      'The posting does not offer visa sponsorship'
    ]
  });
  const noContext = await runNarrative('insights', reply);
  assert.deepEqual(noContext.res.body.data.personalizedRecommendations, ['Confirm the organiser\'s work-authorization rules directly', 'The posting does not offer visa sponsorship']);

  const withContext = await runNarrative('insights', reply, { profile: `${PROFILE} I am an F-1 student at a US university.` });
  assert.equal(withContext.res.body.data.personalizedRecommendations.length, 4, 'a candidate who states US study keeps route advice');
});

test('visa routes: the deterministic note for missing work authorization assumes no route', () => {
  const notes = guards.constraintNotes(guards.deriveFacts(PROFILE, OPPORTUNITY, ROWS), ROWS);
  const note = notes.find((item) => /Work authorization/.test(item.concern));
  assert.ok(note);
  assert.match(note.action, /Confirm the organiser/);
  assert.match(note.action, /has not assumed any visa route/);
  assert.doesNotMatch(`${note.concern} ${note.action}`, /CPT|OPT|F-1|H-1B/);
  const us = guards.deriveFacts(`${PROFILE} I am an F-1 student at a US university.`, OPPORTUNITY, ROWS);
  assert.doesNotMatch(guards.constraintNotes(us, ROWS).find((item) => /Work authorization/.test(item.concern)).action, /has not assumed/);
});

// ---- the analysis response, end to end -------------------------------------------------------------------------------

test('analyze: the audited candidate gets a Not eligible verdict plus deterministic constraint notes, and the UI uses them', async () => {
  const sent = [];
  global.fetch = fakeModel((body) => (body.messages[0].content.startsWith('STAGE: EXTRACT')
    ? { requirements: [
      { requirement: 'Graduation between December 2027 and June 2028', sourceQuote: 'Mandatory graduation window: December 2027–June 2028', mandatory: true, hardEligibility: true },
      { requirement: 'US work authorization', sourceQuote: 'Mandatory US work authorization', mandatory: true, hardEligibility: true },
      { requirement: 'Excel', sourceQuote: 'Excel', mandatory: false, hardEligibility: false }
    ] }
    : { matches: [
      { requirementId: 'R1', status: 'Missing', contradictingQuote: 'expected graduation May 2029', reasoning: 'Graduation is May 2029, outside the window.' },
      { requirementId: 'R2', status: 'Missing', contradictingQuote: 'No US work authorization', reasoning: 'The profile states no US work authorization.' },
      { requirementId: 'R3', status: 'Unknown', reasoning: 'No Excel evidence; the ROC-AUC of 0.7744 is not relevant.' }
    ] }), sent);
  const res = response();
  await analyze({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { profile: PROFILE, opportunity: OPPORTUNITY }, socket: { remoteAddress: '203.0.113.9' } }, res);
  assert.equal(res.statusCode, 200);
  const report = JSON.parse(res.body.response);
  assert.equal(report.eligibilityVerdict, 'Not eligible');
  assert.equal(report.constraintNotes.length, 2);
  assert.match(report.constraintNotes[0].concern, /May 2029.*December 2027 to June 2028/);
  assert.match(report.requirementMapping[2].reasoning, /withheld/, 'a figure the profile does not contain is not shown');

  const adapted = model.adaptNovaReport(res.body);
  assert.equal(model.biggestConcern(adapted), report.constraintNotes[0].concern);
  assert.equal(model.nextBestAction(adapted), report.constraintNotes[0].action);
  assert.doesNotMatch(model.buildReportText(adapted), /Summer 2028|CPT|OPT|0\.7744/);
});

test('report model: model-written advice never outranks a verified constraint; reports without notes behave as before', () => {
  const withModelAdvice = { resumeImprovements: [{ suggested: 'Model rewrite 0.7744' }], personalizedRecommendations: ['Target Summer 2028'], missingSkills: [{ skill: 'Excel', whyItMatters: 'x' }] };
  assert.equal(model.nextBestAction(withModelAdvice), 'Model rewrite 0.7744', 'unchanged when there are no constraint notes');
  assert.equal(model.biggestConcern(withModelAdvice), 'Excel — x');
  const withNote = { ...withModelAdvice, constraintNotes: [{ concern: 'Hard failure', action: 'Confirm with the organiser.' }] };
  assert.equal(model.nextBestAction(withNote), 'Confirm with the organiser.');
  assert.equal(model.biggestConcern(withNote), 'Hard failure');
  const malformed = { ...withModelAdvice, constraintNotes: [null, 'text', { concern: 5, action: 'x' }, { concern: '', action: 'x' }] };
  assert.equal(model.nextBestAction(malformed), 'Model rewrite 0.7744', 'malformed notes are ignored, never shown');
  assert.deepEqual(model.adaptNovaReport({ response: { constraintNotes: [null, { concern: 'a', action: 'b' }, { concern: 1 }] } }).constraintNotes, [{ concern: 'a', action: 'b' }]);
});

// ---- 4. learning resources --------------------------------------------------------------------------------------------

test('resources: a provider-site link is labelled as one and is not presented as a course link', () => {
  const html = model.resourceMarkup({ skill: 'Excel', resource: 'Financial Modelling Course', provider: 'Coursera', url: 'https://www.coursera.org/learn/some-invented-course', type: 'Course', timeToComplete: '10 hours' });
  assert.match(html, /href="https:\/\/www\.coursera\.org"/, 'the invented course path is still discarded');
  assert.match(html, /Open provider site/);
  assert.match(html, /Suggested search\. The link opens the provider's site, not a verified course page\./);
  assert.doesNotMatch(html, /Open resource/);
  assert.match(html, /Financial Modelling Course/, 'the suggested title stays visible as the thing to search for');
});

test('resources: with no resolvable link, no link and no claim about one is shown', () => {
  const html = model.resourceMarkup({ skill: 'Excel', resource: 'Course', provider: 'Udemy', url: 'https://udemy.com/course/x', type: 'Course' });
  assert.match(html, /No direct link/);
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /Suggested search/);
});

test('resources: the insights prompt asks for suggested searches on provider base URLs and forbids invented course paths', () => {
  const { system } = prompts.createInsightsPrompt(PROFILE, OPPORTUNITY, ASSESSMENT);
  assert.match(system, /suggested search, not as a verified course/);
  assert.match(system, /Never invent course-specific paths or claim a specific course exists/);
  assert.doesNotMatch(system, /specific free resources/);
});
