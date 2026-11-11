const assert = require('node:assert/strict');
const test = require('node:test');
const claims = require('../lib/claims');
const { complete } = require('./fixtures/insights');

/*
 * F3: generated text about the candidate may not say more than the profile does. Every example here is a real production
 * output for the Northwind / Aarav Mehta sample, or the honest version of it. The guard withholds; it never rewrites.
 */

const PROFILE = `Aarav Mehta
B.Tech Computer Science, Techno Valley Institute, Pune, India. Expected graduation: May 2028. CGPA 8.4/10.
Skills: Python, SQL (basic queries and joins), React, Git.
Churn Predictor project: Python, scikit-learn. Accuracy 88.5%, Recall 81.2%. Trained on 7,043 customer records.
Expense Tracker project: React and Node.js web app used by 40 classmates. Deployed on Vercel.
Member of the college coding club; helped organise two hackathons.
No prior internship. No experience with cloud platforms or Docker.`;
const OPPORTUNITY = 'Eligibility: Currently enrolled in a B.Tech/B.E. programme in Computer Science. Graduation window: December 2027 to June 2028. Proficiency in Python. At least one completed software project. Open to candidates based in India. Preferred: Experience with AWS or another cloud platform. Familiarity with Docker. Prior internship experience.';

const run = (overrides) => claims.guardClaims('insights', complete(overrides), PROFILE, OPPORTUNITY);
const suggestion = (current, suggested) => ({ section: 'x', current, suggested, impact: 'High' });

test('contradictions: what the profile says the candidate lacks is read from its negated clauses', () => {
  assert.deepEqual([...claims.blockedTerms(PROFILE)], ['internship', 'cloud', 'docker']);
  assert.deepEqual([...claims.blockedTerms('Never used Kubernetes. Not familiar with Rust. I have no certifications yet.')], ['kubernet', 'rust', 'certification']);
  assert.deepEqual([...claims.blockedTerms('Skills: Python, Docker. Deployed on Vercel.')], [], 'nothing negated: nothing blocked');
  const support = claims.supportStems(PROFILE);
  assert.equal(support.has('experience'), false, '"experience" appears only inside "No experience with", so it supports nothing');
  assert.equal(claims.supportStems(`${PROFILE} Experience with React.`).has('experience'), true, 'the same word in a positive clause does');
});

test('resume suggestions: the production rewrites are withheld, honest rewording is kept with its metrics and context', () => {
  const { data, removed } = run({ resumeImprovements: [
    suggestion('No prior internship. No experience with cloud platforms or Docker.', 'Completed two software projects (Churn Predictor and Expense Tracker) demonstrating full‑stack development; actively learning AWS cloud services and Docker containerisation.'),
    suggestion('Expense Tracker project: React and Node.js web app used by 40 classmates. Deployed on Vercel.', 'Expense Tracker – Built a full‑stack React and Node.js web application adopted by 40 classmates; deployed on Vercel for continuous availability.'),
    suggestion('Member of the college coding club; helped organise two hackathons.', 'Active member of college coding club; co‑organised two hackathons, fostering collaboration among peers.'),
    suggestion('Churn Predictor project: Python, scikit-learn. Accuracy 88.5%, Recall 81.2%.', 'Churn Predictor (Python, scikit-learn): accuracy 88.5%, recall 81.2% on 7,043 customer records.'),
    suggestion('Expense Tracker project: React and Node.js web app used by 40 classmates. Deployed on Vercel.', 'Expense Tracker: React and Node.js web app used by 40 classmates, deployed on Vercel.'),
    suggestion('Member of the college coding club; helped organise two hackathons.', 'Coding club member; helped organise two hackathons.')
  ] });
  assert.deepEqual(data.resumeImprovements.map((item) => item.suggested), [
    'Churn Predictor (Python, scikit-learn): accuracy 88.5%, recall 81.2% on 7,043 customer records.',
    'Expense Tracker: React and Node.js web app used by 40 classmates, deployed on Vercel.',
    'Coding club member; helped organise two hackathons.'
  ]);
  assert.ok(removed.includes('claim: contradicts profile'), 'AWS/Docker learning against "No experience with cloud platforms or Docker"');
  assert.ok(removed.includes('claim: unsupported claim word'), 'adopted, co-organised, fostering, demonstrating, actively learning');
  assert.ok(removed.includes('claim: term not in profile'), 'full-stack and AWS are new terms');
  assert.doesNotMatch(removed.join(' '), /AWS|Docker|hackathon|classmates/, 'reasons never carry content');
});

test('resume suggestions: current must be a verbatim profile quote, and malformed items are dropped', () => {
  const { data, removed } = run({ resumeImprovements: [
    suggestion('Did some stuff with Python', 'Python developer'),
    suggestion('Skills: Python, SQL (basic queries and joins), React, Git.', 'Skills: Python, SQL (basic queries and joins), React, Git'),
    { section: 'x', current: '', suggested: 'anything' }, 'junk', { current: 'Skills: Python', suggested: 42 }
  ] });
  assert.deepEqual(data.resumeImprovements.map((item) => item.suggested), ['Skills: Python, SQL (basic queries and joins), React, Git']);
  assert.equal(removed.filter((reason) => reason === 'claim: current text not in profile').length, 1);
  assert.equal(removed.filter((reason) => reason === 'claim: malformed suggestion').length, 3);
});

test('resume suggestions: participation, usage and activity are not upgraded; a listed skill is not proficiency', () => {
  const kept = (current, suggested) => run({ resumeImprovements: [suggestion(current, suggested)] }).data.resumeImprovements.length === 1;
  const club = 'Member of the college coding club; helped organise two hackathons.';
  assert.equal(kept(club, 'Led two hackathons for the college coding club.'), false, 'helped organise -> led');
  assert.equal(kept(club, 'Coding club member; coordinated two hackathons.'), false, 'helped organise -> coordinated');
  assert.equal(kept(club, 'Helped organise two hackathons as a member of the college coding club.'), true, 'reordered, same claim');
  const tracker = 'Expense Tracker project: React and Node.js web app used by 40 classmates. Deployed on Vercel.';
  assert.equal(kept(tracker, 'Expense Tracker: React and Node.js web app with 40 users, deployed on Vercel.'), false, 'classmates -> users');
  assert.equal(kept(tracker, 'Expense Tracker: React and Node.js web app used by 40 classmates, improving expense tracking for peers.'), false, 'an outcome the profile never states');
  const skills = 'Skills: Python, SQL (basic queries and joins), React, Git.';
  assert.equal(kept(skills, 'Proficient in Python, SQL, React and Git.'), false, 'listed skill -> proficiency');
  assert.equal(kept(skills, 'Experienced with Python, SQL, React and Git.'), false, 'listed skill -> experience');
  assert.equal(kept(skills, 'Python, SQL (basic queries and joins), React, Git.'), true);
  const churn = 'Churn Predictor project: Python, scikit-learn. Accuracy 88.5%, Recall 81.2%. Trained on 7,043 customer records.';
  assert.equal(kept(churn, 'Churn Predictor: scikit-learn model, accuracy 88.5% and recall 81.2% on 7,043 customer records.'), true, 'metrics and their context preserved');
  assert.equal(kept(churn, 'Churn Predictor: scikit-learn model with 88.5% recall.'), true, 'the figure guard, not this one, catches a swapped metric; see metrics tests');
});

test('strengths and highlights: production inferences are withheld, restated facts survive', () => {
  const { data, removed } = run({
    strengths: [
      'Currently enrolled in a B.Tech Computer Science programme',
      'Graduation window matches December 2027‑June 2028 (expected May 2028)',
      'Proficient in Python with a project achieving 88.5% accuracy and 81.2% recall',
      'Completed two software projects (Churn Predictor and Expense Tracker)',
      'Based in India',
      'Demonstrated teamwork through coding club hackathons',
      'Experience with React',
      'Familiar with Docker',
      'Churn Predictor project with 88.5% accuracy',
      'Award-winning hackathon organiser'
    ],
    resumeStrength: { score: 72, highlights: ['Python project with clear performance metrics (88.5% accuracy, 81.2% recall)', 'React/Node.js web app used by 40 classmates', 'Strong academic record (CGPA 8.4/10)', 'Demonstrated teamwork through coding club hackathons', 'Leadership in the coding club'], weaknesses: ['No cloud experience'] }
  });
  assert.deepEqual(data.strengths, [
    'Currently enrolled in a B.Tech Computer Science programme',
    'Graduation window matches December 2027‑June 2028 (expected May 2028)',
    'Completed two software projects (Churn Predictor and Expense Tracker)',
    'Based in India',
    'Churn Predictor project with 88.5% accuracy'
  ]);
  assert.deepEqual(data.resumeStrength.highlights, ['Python project with clear performance metrics (88.5% accuracy, 81.2% recall)', 'React/Node.js web app used by 40 classmates', 'Strong academic record (CGPA 8.4/10)']);
  assert.equal(data.resumeStrength.score, 72, 'other fields untouched');
  assert.deepEqual(data.resumeStrength.weaknesses, ['No cloud experience'], 'weaknesses are not guarded: a stated absence is not a claim');
  assert.ok(removed.includes('claim: untraceable text'), 'award-winning');
});

test('profile summary: every item must trace to the profile; invented skills, experience and contradicted items are dropped', () => {
  const { data } = run({ profileSummary: {
    name: 'Aarav Mehta', degree: 'B.Tech Computer Science', year: 'May 2028', university: 'Techno Valley Institute', cgpa: '8.4/10',
    skills: ['Python', 'SQL (basic queries and joins)', 'React', 'Git', 'Docker', 'AWS'],
    programmingLanguages: ['Python', 'SQL', 'JavaScript'],
    certifications: ['AWS Cloud Practitioner'],
    projects: ['Churn Predictor project: Python, scikit-learn. Accuracy 88.5%, Recall 81.2%. Trained on 7,043 customer records.', 'Chatbot built with LangChain'],
    experience: ['Member of the college coding club; helped organise two hackathons.', 'Summer internship at Acme Corp'],
    achievements: [], extra: 7
  } });
  assert.deepEqual(data.profileSummary, {
    name: 'Aarav Mehta', degree: 'B.Tech Computer Science', year: 'May 2028', university: 'Techno Valley Institute', cgpa: '8.4/10',
    skills: ['Python', 'SQL (basic queries and joins)', 'React', 'Git'],
    programmingLanguages: ['Python', 'SQL'],
    certifications: [],
    projects: ['Churn Predictor project: Python, scikit-learn. Accuracy 88.5%, Recall 81.2%. Trained on 7,043 customer records.'],
    experience: ['Member of the college coding club; helped organise two hackathons.'],
    achievements: [], extra: 7
  });
  assert.equal(run({ profileSummary: { university: 'Stanford University' } }).data.profileSummary.university, '', 'an untraceable scalar is blanked, not guessed');
});

test('a negated mention in generated text is not an affirmative claim, and empty output is acceptable', () => {
  const { data } = run({ strengths: ['No Docker experience, but strong Python project work'], resumeImprovements: [] });
  assert.deepEqual(data.strengths, ['No Docker experience, but strong Python project work']);
  const everything = run({ strengths: ['Expert AWS architect'], resumeImprovements: [suggestion('x', 'y')], profileSummary: { skills: ['Kubernetes'] } }).data;
  assert.deepEqual([everything.strengths, everything.resumeImprovements, everything.profileSummary.skills], [[], [], []]);
});

test('other sections and malformed data pass through unchanged', () => {
  const letter = { coverLetter: 'Dear team, I am proficient in everything.' };
  assert.equal(claims.guardClaims('coverLetter', letter, PROFILE).data, letter);
  assert.deepEqual(claims.guardClaims('insights', null, PROFILE), { data: null, removed: [], diagnostics: [] });
  const odd = complete({ strengths: 'not a list', resumeStrength: 'text', profileSummary: ['list'], resumeImprovements: 'text' });
  const out = claims.guardClaims('insights', odd, PROFILE).data;
  assert.deepEqual([out.strengths, out.resumeStrength, out.profileSummary, out.resumeImprovements], ['not a list', 'text', ['list'], 'text']);
});
