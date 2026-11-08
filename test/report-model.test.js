const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../report-model');
const fixture = require('./fixtures/nova-report.json');
const { STATUS, VERDICT, normalizeRequirements, normalizeMatches, computeAssessment, buildDeterministicReport } = require('../lib/eligibility');

const {
  safe, arr, parse, hasNumber, numberOrNull, adaptNovaReport, friendlyError, list, presentationText, normalizeStatus,
  humanizeVerdict, requirementItems, statusCounts, biggestConcern, nextBestAction, contextCandidate,
  detailRequirement, resourceMarkup, strategyMarkup, moduleContent, buildReportText,
  buildAssessmentPayload, mergeNarrative, hasInsights
} = model;

const MODULES = ['requirements', 'strengths', 'gaps', 'documents', 'risks', 'strategy', 'resources'];
const adapted = () => adaptNovaReport({ response: JSON.stringify(fixture) });

// ---- helpers ---------------------------------------------------------------------------------

// Every tag Nova's own markup is allowed to emit. Anything else in output means model text became markup.
const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'b', 'small', 'strong', 'article', 'details', 'summary', 'button', 'a', 'i', 'ul', 'li']);
function assertSafeMarkup(html, label) {
  // Model text is escaped, so any "<...>" left in the output is markup Nova generated itself.
  const tagSource = html.match(/<[^>]*>/g) || [];
  const tags = tagSource.map((tag) => (tag.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/) || [])[1]?.toLowerCase());
  const unexpected = tags.filter((tag) => !ALLOWED_TAGS.has(tag));
  assert.deepEqual(unexpected, [], `${label}: unexpected tags ${unexpected}`);
  for (const tag of tagSource) {
    assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `${label}: inline event handler in ${tag}`);
    assert.doesNotMatch(tag, /javascript:/i, `${label}: javascript: URL in ${tag}`);
  }
}

// ---- safe / arr / parse / numbers ------------------------------------------------------------

test('safe() escapes every HTML-significant character and tolerates null and non-strings', () => {
  assert.equal(safe(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#039;&amp;&#039;&lt;/a&gt;');
  assert.equal(safe(null), '');
  assert.equal(safe(undefined), '');
  assert.equal(safe(0), '0');
  assert.equal(safe({}), '[object Object]');
  assert.equal(safe('&lt;'), '&amp;lt;', 'must not double-trust already escaped text');
});

test('arr() only passes real arrays through', () => {
  assert.deepEqual(arr([1]), [1]);
  for (const value of [null, undefined, 'a', 1, {}, { length: 1 }]) assert.deepEqual(arr(value), []);
});

test('parse() strips markdown code fences, returns {} for empty, and throws on invalid JSON', () => {
  assert.deepEqual(parse('{"a":1}'), { a: 1 });
  assert.deepEqual(parse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parse('```\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parse(''), {});
  assert.deepEqual(parse(null), {});
  assert.throws(() => parse('not json'), SyntaxError);
});

test('numberOrNull() clamps to 0-100 and treats anything non-numeric as "not available", never as 0', () => {
  assert.equal(numberOrNull(62), 62);
  assert.equal(numberOrNull('62'), 62);
  assert.equal(numberOrNull(150), 100);
  assert.equal(numberOrNull(-5), 0);
  assert.equal(numberOrNull(0), 0, 'a genuine zero is a real score');
  for (const value of [null, undefined, '', '   ', 'abc', NaN, Infinity, [], {}, true, false]) {
    assert.equal(numberOrNull(value), null, `numberOrNull(${JSON.stringify(value)})`);
  }
  assert.equal(hasNumber([]), false);
});

// ---- adaptNovaReport -------------------------------------------------------------------------

test('adaptNovaReport accepts a JSON-string envelope, an object envelope and a bare report', () => {
  const asString = adaptNovaReport({ response: JSON.stringify({ overallMatchScore: 70 }) });
  const asObject = adaptNovaReport({ response: { overallMatchScore: 70 } });
  const bare = adaptNovaReport({ overallMatchScore: 70 });
  assert.equal(asString.overallMatchScore, 70);
  assert.equal(asObject.overallMatchScore, 70);
  assert.equal(bare.overallMatchScore, 70);
  assert.equal(adaptNovaReport({ response: '```json\n{"overallMatchScore":55}\n```' }).overallMatchScore, 55);
});

test('adaptNovaReport turns garbage into an empty-but-renderable report instead of crashing', () => {
  for (const input of [null, undefined, 'x', 5, [], { response: [] }, { response: 7 }]) {
    const report = adaptNovaReport(input);
    assert.equal(report.overallMatchScore, null);
    assert.deepEqual(report.requirementMapping, []);
    assert.deepEqual(report.learningResources, []);
    assert.equal(report.opportunitySummary, null);
  }
  assert.throws(() => adaptNovaReport({ response: 'not json' }), SyntaxError);
});

test('adaptNovaReport coerces wrong-typed fields from the model', () => {
  const report = adaptNovaReport({
    overallMatchScore: '88', confidenceScore: 400, applicationReadiness: 'n/a',
    strengths: 'not an array', missingSkills: { skill: 'x' }, opportunitySummary: 'text', profileSummary: [1]
  });
  assert.equal(report.overallMatchScore, 88);
  assert.equal(report.confidenceScore, 100);
  assert.equal(report.applicationReadiness, null);
  assert.deepEqual(report.strengths, []);
  assert.deepEqual(report.missingSkills, []);
  assert.equal(report.opportunitySummary, null);
  assert.equal(report.profileSummary, null, 'an array is not a valid summary object');
});

test('adaptNovaReport merges evidence-trace detail into requirement rows without overriding explicit fields', () => {
  const report = adaptNovaReport({
    requirementMapping: [{ requirement: 'Aged 18-25', status: 'Unknown', reasoning: 'explicit' }, { requirement: 'Other', status: 'Matched' }],
    _evidenceTrace: {
      requirements: [{ id: 'R1', requirement: 'Aged 18-25', mandatory: true, hardEligibility: true }],
      matches: [{ requirement_id: 'R1', reasoning: 'from trace', confidence: 'High', evidence_id: 'E1' }]
    }
  });
  const [first, second] = report.uiRequirementMapping;
  assert.equal(first.reasoning, 'explicit');
  assert.equal(first.confidence, 'High');
  assert.equal(first.evidenceId, 'E1');
  assert.equal(first.mandatory, true);
  assert.equal(first.hardEligibility, true);
  assert.equal(second.reasoning, null);
  assert.equal(second.mandatory, null);
});

// ---- status / verdict presentation (contract with the backend) -------------------------------

test('normalizeStatus maps every status the backend can emit to the right UI bucket', () => {
  assert.equal(normalizeStatus(STATUS.MATCHED).key, 'met');
  assert.equal(normalizeStatus(STATUS.PARTIAL).key, 'partial');
  assert.equal(normalizeStatus(STATUS.MISSING).key, 'missing');
  assert.equal(normalizeStatus(STATUS.UNKNOWN).key, 'unknown');
  for (const [input, key] of [['met', 'met'], ['SATISFIED', 'met'], ['partial_match', 'partial'], ['partially-met', 'partial'], ['not met', 'missing'], ['unmet', 'missing'], ['???', 'unknown'], [null, 'unknown'], ['', 'unknown']]) {
    assert.equal(normalizeStatus(input).key, key, String(input));
  }
});

test('every verdict and readiness label the backend emits is shown to the user verbatim', () => {
  for (const verdict of Object.values(VERDICT)) assert.equal(humanizeVerdict(verdict), verdict);
  assert.equal(humanizeVerdict('Ready to apply'), 'Ready to apply');
  assert.equal(presentationText('READY_AFTER_ONE_FIX'), 'Ready after one fix');
});

test('presentationText humanises unknown values and falls back for empty ones', () => {
  assert.equal(presentationText(null), 'Not available from Nova.');
  assert.equal(presentationText('', 'n/a'), 'n/a');
  assert.equal(presentationText('some_odd_value'), 'Some Odd Value');
  assert.equal(presentationText('PARTIALLY_MET'), 'Partially matched');
});

test('friendlyError hides provider internals but keeps actionable messages', () => {
  assert.match(friendlyError('Your Groq API key is expired'), /unavailable in this preview/);
  assert.match(friendlyError('The server is not configured for AI analysis.'), /unavailable/);
  assert.match(friendlyError('Groq returned an invalid analysis. Please try again.'), /unavailable/);
  assert.match(friendlyError('Analysis timed out. Please try again.'), /took too long/);
  assert.equal(friendlyError('Too many analysis requests. Please wait a minute and try again.'), 'Too many analysis requests. Please wait a minute and try again.');
  assert.match(friendlyError(''), /Something went wrong/);
  assert.match(friendlyError(undefined), /Something went wrong/);
  assert.match(friendlyError('Nova could not find clear requirements in the opportunity text.'), /could not find clear requirements/);
});

// ---- requirement aggregation -----------------------------------------------------------------

test('requirementItems de-duplicates across mapping / mandatory / preferred and prefers the item with evidence', () => {
  const items = requirementItems({
    requirementMapping: [{ requirement: 'Python', status: 'Matched' }],
    mandatoryRequirements: [{ requirement: 'python', status: 'Matched', note: 'has note' }, { requirement: 'SQL', status: 'Missing' }],
    preferredRequirements: [{ requirement: 'Docker' }, { status: 'Matched' }, null]
  });
  assert.deepEqual(items.map((item) => item.requirement), ['python', 'SQL', 'Docker']);
  assert.equal(items[0].note, 'has note', 'the duplicate that carries evidence replaces the bare one');
});

test('requirementItems uses uiRequirementMapping instead of requirementMapping when present', () => {
  const items = requirementItems({ uiRequirementMapping: [{ requirement: 'A', status: 'Matched' }], requirementMapping: [{ requirement: 'B' }] });
  assert.deepEqual(items.map((item) => item.requirement), ['A']);
  assert.deepEqual(statusCounts({}), { total: 0, met: 0, items: [] });
  assert.equal(statusCounts(adapted()).total, 6, '5 mapped + 1 preferred, the mandatory duplicate is merged');
  assert.equal(statusCounts(adapted()).met, 1);
});

test('REGRESSION: real backend output flows through adaptNovaReport with correct counts and labels', () => {
  const opportunity = 'Eligibility: applicants must be aged 18-25. Required: Python. Preferred: Docker.';
  const profile = 'Rohan, age 27. Skills: Python.';
  const { requirements } = normalizeRequirements({ requirements: [
    { requirement: 'Aged 18-25', sourceQuote: 'applicants must be aged 18-25', mandatory: true, hardEligibility: true },
    { requirement: 'Python', sourceQuote: 'Required: Python', mandatory: true, hardEligibility: false },
    { requirement: 'Docker', sourceQuote: 'Preferred: Docker', mandatory: false, hardEligibility: false }
  ] }, opportunity);
  const matches = normalizeMatches({ matches: [
    { requirementId: 'R1', status: 'Missing', contradictingQuote: 'age 27' },
    { requirementId: 'R2', status: 'Matched', evidenceQuote: 'Skills: Python' },
    { requirementId: 'R3', status: 'Missing' }
  ] }, requirements, profile);
  const server = buildDeterministicReport(requirements, matches, [], computeAssessment(requirements, matches));

  const report = adaptNovaReport({ response: JSON.stringify(server) });
  assert.equal(humanizeVerdict(report.eligibilityVerdict), 'Not eligible');
  const counts = statusCounts(report);
  assert.deepEqual([counts.met, counts.total], [1, 3]);
  const age = report.uiRequirementMapping.find((item) => item.requirement === 'Aged 18-25');
  assert.equal(age.hardEligibility, true);
  assert.equal(normalizeStatus(age.status).key, 'missing');
  assert.match(detailRequirement(age), /Required/);
});

// ---- narrative helpers -----------------------------------------------------------------------

test('biggestConcern falls back skill gap -> unknown requirement -> risk -> weakness -> N/A', () => {
  assert.match(biggestConcern({ missingSkills: [{ skill: 'K8s', whyItMatters: 'deploys' }] }), /^K8s — deploys$/);
  assert.match(biggestConcern({ requirementMapping: [{ requirement: 'Age', status: 'Unknown', evidence: 'x' }] }), /^Age — x$/);
  assert.match(biggestConcern({ riskAnalysis: [{ risk: 'Late', mitigation: 'Apply' }] }), /^Late — Apply$/);
  assert.equal(biggestConcern({ weaknesses: ['', 'Thin'] }), 'Thin');
  assert.equal(biggestConcern({}), 'Not available from Nova.');
  assert.equal(biggestConcern(null), 'Not available from Nova.');
});

test('nextBestAction prefers a resume fix, then recommendations, then the roadmap', () => {
  assert.equal(nextBestAction({ resumeImprovements: [{ suggested: 'Shipped X' }], personalizedRecommendations: ['R'] }), 'Shipped X');
  assert.equal(nextBestAction({ personalizedRecommendations: ['R'] }), 'R');
  assert.equal(nextBestAction({ roadmap: [{ action: 'Read docs' }] }), 'Read docs');
  assert.equal(nextBestAction({}), 'Not available from Nova.');
});

test('contextCandidate builds a display name and meta line with fallbacks', () => {
  assert.deepEqual(contextCandidate({ profileSummary: { name: 'Priya', degree: 'B.Tech', university: 'DTU' } }), { name: 'Priya', meta: 'B.Tech · DTU' });
  assert.deepEqual(contextCandidate({}), { name: 'Candidate profile', meta: 'Not available from Nova.' });
});

test('list() drops empty items and escapes content and the empty-state text', () => {
  assert.equal(list(['a', '', null, '<b>']), '<li>a</li><li>&lt;b&gt;</li>');
  assert.equal(list([], '<none>'), '<li class="empty">&lt;none&gt;</li>');
  assert.equal(list('x'), '<li class="empty">No details identified.</li>');
});

// ---- markup safety (XSS) ---------------------------------------------------------------------

test('XSS: every detail module renders hostile model text as inert text', () => {
  const report = adapted();
  for (const name of MODULES) {
    const { html, title, subtitle } = moduleContent(name, report);
    assertSafeMarkup(html, name);
    assert.ok(title && subtitle);
  }
  const all = MODULES.map((name) => moduleContent(name, report).html).join('');
  assert.match(all, /&lt;img src=x onerror=alert\(1\)&gt;|&lt;b&gt;pool&lt;\/b&gt;/, 'hostile text should appear escaped, not vanish');
  assert.ok(all.includes('&quot;&gt;&lt;svg onload=alert(2)&gt;'));
});

test('XSS: individual builders escape requirement, resource and cover-letter content', () => {
  assertSafeMarkup(detailRequirement({ requirement: '<img src=x onerror=1>', status: 'Matched', evidence: '<script>1</script>', reasoning: '"><svg onload=1>', confidence: '<i>' }), 'detailRequirement');
  assertSafeMarkup(resourceMarkup({ skill: '<s>', resource: '<img>', provider: '<p onclick=1>', type: '<u>', timeToComplete: '<e>', url: 'https://www.coursera.org/x' }), 'resourceMarkup');
  assertSafeMarkup(strategyMarkup({ coverLetter: 'a\n\n<img src=x onerror=1>', strengths: ['<s>'], learningResources: [] }), 'strategyMarkup');
  assert.equal(resourceMarkup(null), '');
  assert.equal(resourceMarkup('x'), '');
});

test('learning links: only canonical https URLs ever reach an href, hostile ones become "No direct link"', () => {
  const report = adapted();
  const html = moduleContent('resources', report).html;
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(hrefs, ['https://www.coursera.org'], 'only the legitimate Coursera card links out');
  assert.equal((html.match(/No direct link/g) || []).length, 2, 'javascript: and github.com/attacker cards have no link');
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
});

// ---- module content --------------------------------------------------------------------------

test('moduleContent summarises each module with accurate counts', () => {
  const report = adapted();
  assert.equal(moduleContent('requirements', report).subtitle, '1 of 6 mapped requirements matched');
  assert.equal(moduleContent('strengths', report).subtitle, '3 strengths · 1 weaknesses');
  assert.equal(moduleContent('gaps', report).subtitle, '2 important gaps');
  assert.equal(moduleContent('documents', report).subtitle, '3 required documents');
  assert.equal(moduleContent('risks', report).subtitle, '2 risk signals');
  assert.equal(moduleContent('resources', report).subtitle, '3 recommendations', 'junk entries are removed before counting');
  assert.equal(moduleContent('strategy', report).title, 'Application strategy');
});

test('moduleContent shows honest empty states for an empty report and a default panel for unknown modules', () => {
  const empty = adaptNovaReport({});
  assert.match(moduleContent('requirements', empty).html, /No requirements were identified/);
  assert.match(moduleContent('gaps', empty).html, /No high-priority gaps/);
  assert.match(moduleContent('documents', empty).html, /No documents were identified/);
  assert.match(moduleContent('risks', empty).html, /No significant risks/);
  assert.match(moduleContent('resources', empty).html, /No resources were generated/);
  assert.match(moduleContent('strategy', empty).html, /data-action="generate-cover-letter"/, 'offers to draft rather than claiming none exists');
  assert.equal(moduleContent('nope', empty).title, 'Evidence');
});

test('document and risk status colouring follows the status text', () => {
  const html = moduleContent('documents', adapted()).html;
  assert.equal((html.match(/status-met/g) || []).length, 2, 'Completed and not_required both count as done');
  assert.equal(adapted().learningResources.length, 3);
  assert.match(moduleContent('risks', adapted()).html, /status-missing[^>]*>High/);
});

test('strategy panel splits the cover letter into paragraphs', () => {
  const html = strategyMarkup(adapted());
  assert.equal((html.match(/<p>Dear Atlas,<\/p>/g) || []).length, 1);
  assert.match(html, /<p>I am &lt;b&gt;excited&lt;\/b&gt;\.<\/p>/);
  assert.match(html, /1 of 6 mapped requirements are currently matched/);
});

// ---- exported text brief ---------------------------------------------------------------------

test('buildReportText produces the plain-text brief and survives an empty report', () => {
  const text = buildReportText(adapted());
  assert.match(text, /^NOVA AI — FIT BRIEF/);
  assert.match(text, /Fit score: 62\/100/);
  assert.match(text, /Verdict: Needs verification/);
  assert.match(text, /Requirements: 1\/6 matched/);
  assert.match(text, /• Kubernetes \(High\)/);
  assert.match(text, /AI-generated/);

  const empty = buildReportText();
  assert.match(empty, /Fit score: Not available from Nova\./);
  assert.match(empty, /Requirements: 0\/0 matched/);
});

// ---- on-demand sections ----------------------------------------------------------------------

test('strategy offers Generate buttons, then loading, error and ready states per draft', () => {
  const base = adaptNovaReport({});
  const idle = strategyMarkup(base);
  assert.match(idle, /data-action="generate-cover-letter"/);
  assert.match(idle, /data-action="generate-interview"/);
  assert.doesNotMatch(idle, /id="coverLetterCopy"/);

  const loading = strategyMarkup(base, { coverLetter: 'loading', interview: 'loading' });
  assert.match(loading, /Drafting your cover letter/);
  assert.match(loading, /Preparing interview questions/);
  assert.doesNotMatch(loading, /data-action="generate-/);

  const failed = strategyMarkup(base, { coverLetter: 'error' });
  assert.match(failed, /Couldn(?:'|&#039;)t draft the cover letter/);
  assert.match(failed, /data-action="generate-cover-letter"/, 'error state offers retry');

  const saved = strategyMarkup(base, { canGenerate: false });
  assert.match(saved, /Run a new analysis/);
  assert.doesNotMatch(saved, /data-action="generate-/);

  const ready = adaptNovaReport({ coverLetter: 'Dear team,\nHello.', interviewQuestions: [{ question: 'Why us?', whyAsked: 'Fit', suggestedAnswer: 'Because <b>x</b>' }] });
  const html = strategyMarkup(ready, { coverLetter: 'loading' });
  assert.match(html, /id="coverLetterCopy"/, 'existing content wins over a stale loading flag');
  assert.match(html, /Why us\?/);
  assert.doesNotMatch(html, /<b>x<\/b>/, 'model text is escaped');
  assertSafeMarkup(html, 'strategy ready');
});

test('insight-dependent modules show pending and retry panels until insights arrive', () => {
  for (const module of ['strengths', 'gaps', 'documents', 'risks', 'resources']) {
    assert.match(moduleContent(module, adapted(), { insights: 'loading' }).html, /still preparing/i, module);
    assert.match(moduleContent(module, adapted(), { insights: 'error' }).html, /data-action="retry-insights"/, module);
  }
  assert.equal(moduleContent('requirements', adapted(), { insights: 'loading' }).title, 'Requirements', 'verdict-backed modules never wait');
  assert.doesNotMatch(moduleContent('requirements', adapted(), { insights: 'loading' }).html, /still preparing/i);
  const strategy = moduleContent('strategy', adaptNovaReport({}), { insights: 'loading' }).html;
  assert.match(strategy, /still preparing/i);
  assert.match(strategy, /data-action="generate-cover-letter"/, 'drafts do not depend on insights');
});

test('buildAssessmentPayload sends only verified verdict data in the canonical shape the server expects', () => {
  const report = adapted();
  const payload = buildAssessmentPayload(report);
  assert.equal(payload.verdict, report.eligibilityVerdict);
  assert.ok(payload.rows.length >= 1 && payload.rows.length <= 25);
  for (const row of payload.rows) {
    assert.ok(['Matched', 'Partial Match', 'Missing', 'Unknown'].includes(row.status), row.status);
    assert.equal(typeof row.hardEligibility, 'boolean');
    assert.equal(typeof row.mandatory, 'boolean');
    assert.ok(row.requirement.length > 0 && row.requirement.length <= 300);
    assert.deepEqual(Object.keys(row).sort(), ['hardEligibility', 'mandatory', 'requirement', 'status']);
  }
  const { validateAssessment } = require('../lib/narrative');
  assert.ok(validateAssessment(payload), 'payload passes the server validator unchanged');
});

test('mergeNarrative folds generated sections in without losing the verdict', () => {
  const report = adapted();
  const merged = mergeNarrative(report, { coverLetter: 'Dear team', interviewQuestions: [{ question: 'Q' }] });
  assert.equal(merged.coverLetter, 'Dear team');
  assert.equal(merged.interviewQuestions.length, 1);
  assert.equal(merged.eligibilityVerdict, report.eligibilityVerdict);
  assert.equal(merged.overallMatchScore, report.overallMatchScore);
  assert.equal(mergeNarrative(report, null).eligibilityVerdict, report.eligibilityVerdict);
  assert.equal(mergeNarrative(report, ['x']).coverLetter, report.coverLetter, 'arrays are ignored');
});

test('unavailable insights explain why instead of showing misleading empty states', () => {
  const html = moduleContent('risks', adapted(), { insights: 'unavailable' });
  assert.match(html.html, /weren.t saved/);
  assert.doesNotMatch(html.html, /data-action/, 'nothing to retry without the original inputs');
  assert.equal(html.subtitle, 'Not saved with this analysis');
});

test('hasInsights recognises generated sections, legacy reports, and a verdict-only report', () => {
  assert.equal(hasInsights(adaptNovaReport({})), false);
  assert.equal(hasInsights(adapted()), true, 'reports from before the split already carry insights');
  const verdictOnly = adaptNovaReport({ eligibilityVerdict: 'Eligible' });
  assert.equal(hasInsights(mergeNarrative(verdictOnly, {}, 'insights')), true, 'an insights section that legitimately found nothing is still generated');
  assert.equal(hasInsights(mergeNarrative(verdictOnly, { coverLetter: 'x' }, 'coverLetter')), false);
});
