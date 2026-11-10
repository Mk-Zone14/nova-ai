const assert = require('node:assert/strict');
const test = require('node:test');
const provenance = require('../lib/provenance');
const { complete } = require('./fixtures/insights');
const report = require('../report-model');

/*
 * Provenance of claims about the opportunity: a document or deadline is presented as coming from the opportunity only if the
 * opportunity text contains it. Nova's own suggestions are labelled as suggestions, never as requirements.
 */

const OPPORTUNITY = 'Atlas Fellowship. Apply by 30 September 2026. Submit your official transcripts and a one-page statement of purpose.';

test('documents: a stated document needs a quote that is in the opportunity and about that document', () => {
  const doc = (document, source, quote) => provenance.documentProvenance({ document, source, quote }, OPPORTUNITY);
  assert.equal(doc('Academic Transcript', 'stated', 'official transcripts'), 'stated');
  assert.equal(doc('Statement of purpose', 'inferred', 'a one-page STATEMENT   of purpose'), 'inferred', 'case and spacing are ignored');
  assert.equal(doc('Project Portfolio', 'stated', 'official transcripts'), 'suggested', 'a real quote about something else proves nothing');
  assert.equal(doc('Academic Transcript', 'stated', 'transcripts signed by the dean'), 'suggested', 'quote not in the opportunity');
  assert.equal(doc('Academic Transcript', 'stated', ''), 'suggested');
  assert.equal(doc('Academic Transcript', 'stated', undefined), 'suggested');
  assert.equal(doc('Academic Transcript', 'suggested', 'official transcripts'), 'suggested', 'the model can always downgrade itself');
  assert.equal(doc('Academic Transcript', 'required', 'official transcripts'), 'suggested', 'unknown labels are not trusted');
});

test('deadline: kept only when its month and numbers are in the opportunity, otherwise unknown', () => {
  assert.equal(provenance.verifiedDeadline('30 September 2026', OPPORTUNITY), '30 September 2026');
  assert.equal(provenance.verifiedDeadline('30 Sep 2026', OPPORTUNITY), '30 Sep 2026');
  assert.equal(provenance.verifiedDeadline('15 October 2026', OPPORTUNITY), '', 'a date the text does not contain is invented');
  assert.equal(provenance.verifiedDeadline('30 September 2027', OPPORTUNITY), '', 'one wrong number is enough');
  assert.equal(provenance.verifiedDeadline('Rolling basis', OPPORTUNITY), '');
  assert.equal(provenance.verifiedDeadline('Not specified', OPPORTUNITY), '');
  assert.equal(provenance.verifiedDeadline('30 September 2026', 'No dates in this posting. Summer 2026 internship.'), '', 'a deadline cannot appear from nowhere');
  assert.equal(provenance.verifiedDeadline('', OPPORTUNITY), '');
  assert.equal(provenance.hasStatedDate('Summer 2026 internship'), false, 'a bare year is not a deadline');
  assert.equal(provenance.hasStatedDate('Closes 12/10/2026'), true);
});

test('applyProvenance: documents get a provenance, invented deadlines and deadline risks are removed', () => {
  const data = complete({
    opportunitySummary: { role: 'Fellow', deadline: '1 November 2026' },
    requiredDocuments: [
      { document: 'Academic Transcript', status: 'Missing', source: 'stated', quote: 'official transcripts' },
      { document: 'Project Portfolio', status: 'Missing', source: 'stated', quote: 'bring a portfolio' },
      { document: 'Reference letter', status: 'Missing', source: 'suggested', quote: '' },
      'junk', { document: '   ' }
    ],
    riskAnalysis: [{ risk: 'Deadline is approaching', severity: 'High', mitigation: 'Apply this week' }, { risk: 'Competitive pool', severity: 'Medium', mitigation: 'Tailor it' }]
  });
  const noDate = 'Atlas Fellowship. Submit your official transcripts.';
  const out = provenance.applyProvenance('insights', data, noDate);
  assert.deepEqual(out.data.requiredDocuments.map((d) => [d.document, d.provenance]), [['Academic Transcript', 'stated'], ['Project Portfolio', 'suggested'], ['Reference letter', 'suggested']]);
  assert.equal(out.data.requiredDocuments[0].evidenceQuote, 'official transcripts');
  assert.equal('evidenceQuote' in out.data.requiredDocuments[1], false, 'a suggestion carries no quote');
  assert.equal(out.data.opportunitySummary.deadline, '');
  assert.equal(out.data.opportunitySummary.deadlineProvenance, 'unknown');
  assert.deepEqual(out.data.riskAnalysis.map((r) => r.risk), ['Competitive pool'], 'no stated date: no timing risk');
  assert.ok(out.removed.length >= 3 && out.removed.every((reason) => reason.startsWith('provenance:')));
  assert.doesNotMatch(out.removed.join(' '), /1 November|Portfolio|transcript/i, 'reasons never repeat content');

  const dated = provenance.applyProvenance('insights', { ...data, opportunitySummary: { deadline: '30 Sep 2026' } }, OPPORTUNITY);
  assert.equal(dated.data.opportunitySummary.deadline, '30 Sep 2026');
  assert.equal(dated.data.opportunitySummary.deadlineProvenance, 'stated');
  assert.equal(dated.data.riskAnalysis.length, 2, 'timing risk is allowed when the opportunity states a date');
});

test('applyProvenance leaves other sections alone', () => {
  const data = { coverLetter: 'x'.repeat(60) };
  assert.equal(provenance.applyProvenance('coverLetter', data, 'x').data, data);
});

test('documents module: only opportunity-sourced documents are shown as coming from the opportunity', () => {
  const item = (document, provenance, evidenceQuote) => ({ document, status: 'Missing', provenance, evidenceQuote });
  const r = report.adaptNovaReport({ requiredDocuments: [item('Transcript', 'stated', 'official transcripts'), item('Portfolio', 'suggested'), { document: 'Legacy doc', status: 'Missing' }] });
  assert.equal(report.moduleContent('documents', r).subtitle, '1 from the opportunity · 2 suggested');
  const html = report.moduleContent('documents', r).html;
  assert.match(html, /FROM THE OPPORTUNITY[\s\S]*Transcript[\s\S]*Stated in the opportunity[\s\S]*official transcripts/);
  assert.match(html, /SUGGESTED BY NOVA[\s\S]*Portfolio[\s\S]*Suggested by Nova[\s\S]*Legacy doc/);
  assert.doesNotMatch(html.split('SUGGESTED BY NOVA')[0], /Portfolio|Legacy doc/, 'suggestions never appear under the opportunity heading');
  assert.equal(report.documentGroups({ requiredDocuments: [item('A', 'inferred', 'x')] }).fromOpportunity.length, 1);
  assert.equal(report.moduleContent('documents', report.adaptNovaReport({})).subtitle, '0 from the opportunity · 0 suggested');
});

test('strategy "Before submitting" never names a suggested document', () => {
  const r = report.adaptNovaReport({ requiredDocuments: [{ document: 'Portfolio', status: 'Missing', provenance: 'suggested' }], personalizedRecommendations: ['Do X'] });
  assert.doesNotMatch(report.strategyMarkup(r, {}), /Portfolio/);
});

test('strengths are labelled as Nova observations, not as strong evidence', () => {
  const html = report.moduleContent('strengths', report.adaptNovaReport({ strengths: ['Python'] })).html;
  assert.doesNotMatch(html, /Strong evidence|Supporting evidence is present/);
  assert.match(html, /Nova observation/);
});

test('deadline: scattered numbers and a month name do not add up to a date the opportunity never states', () => {
  const scattered = 'September intake. We expect 30 applicants in the 2026 cohort.';
  assert.equal(provenance.hasStatedDate(scattered), false);
  assert.equal(provenance.verifiedDeadline('30 Sep 2026', scattered), '', 'every token is present, but nothing in the text is a deadline');
});
