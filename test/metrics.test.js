const assert = require('node:assert/strict');
const test = require('node:test');
const guards = require('../lib/guards');
const metrics = require('../lib/metrics');
const analyze = require('../api/analyze');
const rateLimit = require('../lib/rate-limit');
const model = require('../report-model');

/*
 * Metrics are structured evidence: exact representation, metric type, project. Generated text may not change any of the
 * three. These tests attack that with the alterations a model actually produces (rounding, truncation, extra decimals,
 * dropped % sign, unit change, swapped metric, swapped project, invented value) and check that faithful rephrasing still passes.
 */

const SOURCE = [
  'Projects',
  'Credit Card Default Prediction project: ROC-AUC 0.7738, Accuracy 79.4%. Ranked 79 in a contest.',
  'Churn project: Accuracy 91.2%, Recall 88.5%.',
  'Built 10 projects. CGPA 8.83/10. Latency 200 ms.'
].join('\n');
const NEUTRAL = { failedHardRequirements: [], workAuthorization: { usStudyOrStatusStated: false, statedRoutes: [] } };

const survives = (text, source = SOURCE) => guards.guardSectionData({ line: text }, { sourceText: source, facts: NEUTRAL }).data.line === text;

test('structured evidence: metrics keep exact representation, type and project', () => {
  const all = metrics.buildEvidence(SOURCE).metrics;
  const found = all.filter((metric) => metric.type);
  const pick = (type, project) => found.find((metric) => metric.type === type && metric.project === project);
  assert.equal(pick('accuracy', 'Credit Card Default Prediction').raw, '79.4%');
  assert.equal(pick('auc', 'Credit Card Default Prediction').raw, '0.7738');
  assert.equal(pick('accuracy', 'Churn').raw, '91.2%');
  assert.equal(pick('recall', 'Churn').raw, '88.5%');
  const gpa = found.find((metric) => metric.type === 'gpa');
  assert.equal(gpa.raw, '8.83/10', 'the scale stays with a grade');
  assert.equal(gpa.project, null, 'a grade belongs to the person, not to the project section above it');
  assert.equal(all.find((metric) => metric.rep === '200ms').type, null, 'an unlabelled number is not given a type it was not given');
});

test('verifiedMetrics: labelled metrics are copied from the profile as written, with their project', () => {
  assert.deepEqual(guards.verifiedMetrics(SOURCE), [
    { label: 'ROC-AUC', value: '0.7738', project: 'Credit Card Default Prediction' },
    { label: 'Accuracy', value: '79.4%', project: 'Credit Card Default Prediction' },
    { label: 'Accuracy', value: '91.2%', project: 'Churn' },
    { label: 'Recall', value: '88.5%', project: 'Churn' },
    { label: 'CGPA', value: '8.83/10', project: null }
  ]);
  assert.deepEqual(guards.verifiedMetrics('Built things in 2024. Ranked 79. 10 projects.'), [], 'no labelled metric, nothing to show');
});

test('altered decimals, rounding and truncation are rejected', () => {
  for (const text of ['Reached 79% accuracy', 'accuracy of about 80%', 'ROC-AUC 0.77', 'ROC-AUC 0.774', 'ROC-AUC of 0.7744', 'accuracy 79.40%', 'accuracy 79.41%', 'accuracy of 79.45%', 'CGPA 8.8', 'CGPA of 9']) {
    assert.equal(survives(text), false, text);
  }
});

test('a dropped or added percent sign, and changed units, are different claims', () => {
  for (const text of ['accuracy of 79.4', 'accuracy 79', 'Reached accuracy 79', 'accuracy 0.794', 'ROC-AUC 77.38%', 'latency of 200 s', 'latency 200 seconds', 'accuracy 7940 basis points']) {
    assert.equal(survives(text), false, text);
  }
});

test('a unit is part of the figure: an unrelated bare number cannot stand in for a figure with a unit', () => {
  const source = 'Ranked 79 in a contest. Training takes 30 seconds. Inference 12 ms. Dataset 5 GB.';
  for (const text of ['Training takes 79 sec', 'inference of 79 ms', 'training takes 30 ms', 'dataset 5 MB', 'dataset 79 GB']) assert.equal(survives(text, source), false, text);
  for (const text of ['Training takes 30 sec', 'Training takes 30 seconds', 'inference of 12 ms', 'Dataset 5 GB', 'Ranked 79 in a contest']) assert.equal(survives(text, source), true, text);
});

test('a metric moved to another metric type is rejected', () => {
  for (const text of ['ROC-AUC of 91.2%', 'precision 79.4%', 'recall of 79.4%', 'accuracy 0.7738', 'F1 of 88.5%', 'accuracy of 88.5%']) {
    assert.equal(survives(text), false, text);
  }
});

test('a metric moved to another project is rejected', () => {
  assert.equal(survives('The Credit Card Default Prediction project reached 91.2% accuracy'), false);
  assert.equal(survives('Churn project reached 79.4% accuracy'), false);
  assert.equal(survives('Churn: 0.7738 ROC-AUC'), false);
  assert.equal(survives('Credit Card Default Prediction reached 79.4% accuracy and Churn 79.4%'), false, 'each number is attributed to the nearest preceding project');
});

test('fabricated values are rejected', () => {
  for (const text of ['accuracy 95.2%', 'ROC-AUC of 0.85', 'improved recall by 12%', 'served 25,000 users', 'accuracy 85']) {
    assert.equal(survives(text), false, text);
  }
});

test('faithful restatements still pass', () => {
  for (const text of [
    'accuracy 79.4%', '79.4% accuracy', 'Accuracy: 79.4%', 'accuracy of 79.4 percent', 'accuracy (79.4%)',
    'ROC-AUC 0.7738 and accuracy 79.4%', 'a ROC-AUC of 0.7738, with accuracy of 79.4%',
    'The Credit Card Default Prediction project reached 79.4% accuracy', 'Churn project reached 91.2% accuracy and 88.5% recall',
    'Credit Card Default Prediction reached 79.4% accuracy and Churn 91.2% accuracy', 'CGPA 8.83/10', 'Ranked 79 in a contest',
    'Built 10 projects', 'latency of 200 ms', 'Week 2: spend 2 hours on Excel'
  ]) {
    assert.equal(survives(text), true, text);
  }
});

test('profiles written as prose still get exact-representation and type protection', () => {
  const prose = 'I built a churn model with 91.2% accuracy and a fraud model with ROC-AUC 0.7738.';
  assert.equal(survives('churn model with 91.2% accuracy', prose), true);
  assert.equal(survives('churn model with 91% accuracy', prose), false);
  assert.equal(survives('fraud model with 0.7738 accuracy', prose), false);
});

test('resume improvements cannot alter a metric: the whole altered record is dropped, unaltered ones stay', () => {
  const data = {
    resumeImprovements: [
      { current: 'Built churn model', suggested: 'Built a churn model reaching 91% accuracy', impact: 'High' },
      { current: 'Built credit model', suggested: 'Built a credit model with 79.4% accuracy', impact: 'High' }
    ]
  };
  const { data: out, removed } = guards.guardSectionData(data, { sourceText: [SOURCE, 'Analyst role'], facts: NEUTRAL });
  assert.deepEqual(out.resumeImprovements.map((item) => item.suggested), ['Built a credit model with 79.4% accuracy']);
  assert.ok(removed.some((reason) => /91%/.test(reason)));
  assert.ok(!JSON.stringify(removed).includes('Built a churn model'), 'reasons never carry the generated text');
});

test('a metric in the opportunity text is not accepted for a project it does not belong to', () => {
  const profile = 'Churn project: Accuracy 91.2%.';
  const opportunity = 'Past winners reached accuracy 95%.';
  assert.equal(guards.guardSectionData({ line: 'Churn project reached 95% accuracy' }, { sourceText: [profile, opportunity], facts: NEUTRAL }).data.line, undefined);
  assert.equal(guards.guardSectionData({ line: 'Past winners reached accuracy 95%' }, { sourceText: [profile, opportunity], facts: NEUTRAL }).data.line, 'Past winners reached accuracy 95%');
});

test('matcher reasoning is withheld when it alters a metric', () => {
  const { normalizeRequirements, normalizeMatches } = require('../lib/eligibility');
  const opportunity = 'Requires: machine learning project experience';
  const { requirements } = normalizeRequirements({ requirements: [{ requirement: 'Machine learning project experience', sourceQuote: 'machine learning project experience', mandatory: true, hardEligibility: false }] }, opportunity);
  const matchWith = (reasoning) => normalizeMatches({ matches: [{ requirementId: 'R1', status: 'Matched', evidenceQuote: 'Accuracy 79.4%', reasoning }] }, requirements, SOURCE)[0].reasoning;
  assert.match(matchWith('Delivered a project with 79% accuracy.'), /withheld/);
  assert.equal(matchWith('Delivered a project with 79.4% accuracy.'), 'Delivered a project with 79.4% accuracy.');
});

// ---- project binding across common multi-project resume formats ------------------------------------------------------

const CC = 'Credit Card Default Prediction';
const bindings = (source) => Object.fromEntries(metrics.buildEvidence(source).metrics.filter((metric) => metric.type === 'accuracy').map((metric) => [metric.raw, metric.project]));
const FORMATS = {
  'dash separator': `PROJECTS\n- ${CC} — Accuracy 79.4%\n- Churn Predictor — Accuracy 91.2%\n\nSKILLS\nPython, SQL`,
  'title then bullets': `Projects\n${CC}\n• Accuracy 79.4%\nChurn Predictor\n• Accuracy 91.2%`,
  'markdown headings': `## ${CC}\n- Accuracy 79.4%\n## Churn Predictor\n- Accuracy 91.2%`,
  'bold title | stack': `**${CC}** | Python, scikit-learn\n- Accuracy 79.4%\n**Churn Predictor** | Python\n- Accuracy 91.2%`,
  'title (stack)': `${CC} (Python, XGBoost)\n- Achieved accuracy of 79.4%\nChurn Predictor (Python)\n- Achieved accuracy of 91.2%`,
  'title | dates': `${CC} | Jan 2025 - Mar 2025\n- Accuracy 79.4%\nChurn Predictor | Apr 2025 - May 2025\n- Accuracy 91.2%`,
  'unlisted section heading': `Technical Projects\n**${CC}** | Python\n- Accuracy 79.4%\n**Churn Predictor** | Python\n- Accuracy 91.2%`,
  'mixed formats': `Projects\n- ${CC} — Accuracy 79.4%\n**Churn Predictor** | Python\n- Accuracy 91.2%`
};
for (const [name, source] of Object.entries(FORMATS)) {
  test(`project binding: ${name}`, () => {
    assert.deepEqual(bindings(source), { '79.4%': CC, '91.2%': 'Churn Predictor' });
    assert.equal(survives('Churn Predictor reached 91.2% accuracy', source), true);
    assert.equal(survives(`${CC} reached 79.4% accuracy`, source), true);
    assert.equal(survives(`${CC} reached 91.2% accuracy`, source), false, 'swapped project');
    assert.equal(survives('Churn Predictor reached 79.4% accuracy', source), false, 'swapped project');
  });
}

test('project binding: bullet sentence fragments are not project names, so correct claims are not blocked', () => {
  const source = `${CC}\n- Improved Model Accuracy: 79.4%\n- Reduced Error Rate: 3.1%\n- Final Test Recall: 88.5%\n- Built Churn Predictor — Accuracy 91.2%`;
  assert.deepEqual(metrics.buildEvidence(source).projects, [CC]);
  assert.equal(survives(`${CC} reached 79.4% accuracy`, source), true);
});

test('project binding: a title in an unrecognised format leaves its metrics unbound; it never inherits the previous project', () => {
  const source = `- ${CC} — Accuracy 79.4%\nchurn predictor (lowercase title)\n- Accuracy 91.2%`;
  assert.deepEqual(bindings(source), { '79.4%': CC, '91.2%': null });
  assert.equal(survives('Churn Predictor reached 91.2% accuracy', source), true, 'fail-open: no project is known for it');
});

test('project binding: unstructured prose gets type and representation protection only (documented gap)', () => {
  const prose = 'I built a credit model with 79.4% accuracy and a churn model with 91.2% accuracy.';
  assert.deepEqual(metrics.buildEvidence(prose).projects, []);
  assert.equal(survives('churn model with 91% accuracy', prose), false);
  assert.equal(survives('churn model with 79.4% accuracy', prose), true, 'a swap between unnamed projects cannot be detected');
});

// ---- end to end: verified metrics come from the source and reach the page --------------------------------------------

const originalFetch = global.fetch;
const originalKey = process.env.GROQ_API_KEY;
test.beforeEach(() => { rateLimit.resetRateLimits(); process.env.GROQ_API_KEY = 'test-key'; });
test.after(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalKey;
});

test('analyze returns verifiedMetrics copied from the profile; the page renders them and drops malformed entries', async () => {
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const reply = body.messages[0].content.startsWith('STAGE: EXTRACT')
      ? { requirements: [{ requirement: 'Machine learning project', sourceQuote: 'machine learning project', mandatory: true, hardEligibility: false }] }
      : { matches: [{ requirementId: 'R1', status: 'Matched', evidenceQuote: 'Accuracy 79.4%', reasoning: 'Strong.' }] };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await analyze({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { profile: SOURCE, opportunity: 'Looking for a machine learning project background.' }, socket: { remoteAddress: '203.0.113.20' } }, res);
  assert.equal(res.statusCode, 200);
  const report = JSON.parse(res.body.response);
  assert.deepEqual(report.verifiedMetrics.find((item) => item.project === 'Churn' && item.label === 'Accuracy'), { label: 'Accuracy', value: '91.2%', project: 'Churn' });

  const adapted = model.adaptNovaReport(res.body);
  const html = model.moduleContent('strengths', adapted, {}).html;
  assert.match(html, /Accuracy: 79\.4%/);
  assert.match(html, /Copied exactly from your profile/);
  assert.doesNotMatch(model.moduleContent('strengths', model.adaptNovaReport({ response: JSON.stringify({}) }), {}).html, /VERIFIED METRICS/, 'no metrics, no block');

  const hostile = model.adaptNovaReport({ response: JSON.stringify({ verifiedMetrics: [{ label: '<img src=x onerror=alert(1)>', value: '1%', project: null }, { label: 'ok', value: 5 }, null, 'x', { label: ['<b>'], value: ['1%'] }, { label: 'Accuracy', value: '79.4%', project: ['P'] }, { label: 'Accuracy', value: '79.4%', project: 'P' }] }) });
  assert.deepEqual(hostile.verifiedMetrics.map((item) => item.value), ['1%', '79.4%'], 'wrong-typed entries (numbers, arrays) are dropped');
});
