#!/usr/bin/env node
'use strict';

/*
 * Manual verification of the REAL Groq integration. Run it yourself, with your own key:
 *
 *   GROQ_API_KEY=<your key> node scripts/verify-groq.js
 *
 * It sends the bundled sample student profile and the Atlas Labs internship through the same
 * handlers production uses (api/analyze.js, then api/narrative.js for each section) and checks
 * the properties that matter: valid structure, quotes that really exist in the profile, a verdict
 * computed in code, bounded latency, and sensible narrative output. Token usage and latency per
 * call are printed by lib/model.js ("Groq call ok: ..."). It prints the sample data's results, never
 * your key. It performs no mocking: without a key it refuses to run.
 */

const fs = require('node:fs');
const path = require('node:path');
const analyze = require('../api/analyze');
const narrative = require('../api/narrative');
const { VERDICT } = require('../lib/eligibility');
const model = require('../report-model');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

/** Reads a sample from the `samples` object in client.js so there is one source of truth. */
function sample(name) {
    const match = SRC.match(new RegExp(`\\n  ${name}: \`([^\`]*)\``));
    if (!match) throw new Error(`Sample "${name}" not found in client.js`);
    return match[1].replace(/\\n/g, '\n');
}

function fakeResponse() {
    return {
        headers: {}, statusCode: null, body: null,
        setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

async function post(handler, body) {
    const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body, socket: { remoteAddress: '127.0.0.1' } };
    const res = fakeResponse();
    const started = Date.now();
    await handler(req, res);
    return { status: res.statusCode, body: res.body, ms: Date.now() - started };
}

const norm = (text) => String(text).replace(/\s+/g, ' ').trim().toLowerCase();

async function verify({ log = console.log } = {}) {
    const results = [];
    const record = (level, name, detail = '') => { results.push({ level, name, detail }); log(`${level.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}`); };
    const profile = sample('profile');
    const opportunity = sample('internship');

    log(`Model: ${process.env.GROQ_MODEL || 'default (see lib/model.js)'}\n`);

    // 1. Verdict
    const analysis = await post(analyze, { profile, opportunity });
    if (analysis.status !== 200) {
        record('FAIL', 'analyze returned 200', `got ${analysis.status}: ${analysis.body?.error}`);
        return results;
    }
    record('PASS', 'analyze returned 200', `${analysis.ms} ms (budget 50 000 ms)`);
    analysis.ms > 40_000 ? record('WARN', 'analyze latency is close to the 50 s budget', `${analysis.ms} ms`) : record('PASS', 'analyze latency comfortably inside budget');
    let report;
    try { report = JSON.parse(analysis.body.response); } catch { record('FAIL', 'analyze response is valid JSON'); return results; }
    const verdicts = new Set(Object.values(VERDICT));
    verdicts.has(report.eligibilityVerdict) ? record('PASS', 'verdict is one of the known values', report.eligibilityVerdict) : record('FAIL', 'verdict is one of the known values', String(report.eligibilityVerdict));
    const rows = report.requirementMapping || [];
    rows.length >= 3 ? record('PASS', 'at least 3 requirements extracted', `${rows.length}`) : record('FAIL', 'at least 3 requirements extracted', `${rows.length}`);
    const trace = report._evidenceTrace || {};
    const sourceOk = (trace.requirements || []).every((r) => norm(opportunity).includes(norm(r.sourceQuote)));
    sourceOk ? record('PASS', 'every requirement quote exists in the opportunity text') : record('FAIL', 'a requirement quote does not exist in the opportunity text');
    const profileText = norm(profile);
    const badEvidence = (trace.matches || []).filter((m) => ['Matched', 'Partial Match'].includes(m.status) && !String(m.evidenceQuote || '').split('...').every((part) => !norm(part) || profileText.includes(norm(part))));
    badEvidence.length === 0 ? record('PASS', 'every Matched/Partial evidence quote exists in the profile') : record('FAIL', 'evidence quote not found in the profile', badEvidence.map((m) => m.requirementId).join(', '));
    const downgrades = (trace.downgrades || []).length;
    record('INFO', 'claims downgraded by code verification', `${downgrades} of ${(trace.matches || []).length} (a high rate means the model is overclaiming)`);
    record('INFO', 'requirements dropped for unverifiable quotes', `${(trace.droppedRequirements || []).length}`);
    record('INFO', 'score / evidence coverage', `${report.overallMatchScore} / ${report.evidenceCoverage}%`);
    log('\nRequirement table (review by eye: do the statuses match what the profile says?):');
    for (const row of rows) log(`  [${String(row.status).padEnd(13)}] ${row.requirement}`);
    log('');

    // 2. Narrative sections, each its own request, built exactly as the browser builds them
    const assessment = model.buildAssessmentPayload(model.adaptNovaReport(report));
    const sections = {};
    for (const section of ['insights', 'coverLetter', 'interview']) {
        const out = await post(narrative, { profile, opportunity, section, assessment });
        if (out.status !== 200) { record('FAIL', `narrative:${section} returned 200`, `got ${out.status}: ${out.body?.error}`); continue; }
        sections[section] = out.body.data;
        record('PASS', `narrative:${section} returned 200`, `${out.ms} ms (budget 50 000 ms)`);
    }
    if (sections.insights) {
        const keys = Object.keys(sections.insights);
        keys.length >= 5 ? record('PASS', 'insights has several sections', `${keys.length} keys`) : record('WARN', 'insights is thin', `${keys.length} keys`);
        const urls = (sections.insights.learningResources || []).map((r) => r.url).filter(Boolean);
        record('INFO', 'learning-resource URLs the model produced (the client only links vetted hosts; check none look invented)', urls.join(' | ') || 'none');
    }
    if (sections.coverLetter) {
        const letter = sections.coverLetter.coverLetter || '';
        letter.length > 300 ? record('PASS', 'cover letter has substance', `${letter.length} chars`) : record('FAIL', 'cover letter is too short', `${letter.length} chars`);
        /\[[^\]]{2,40}\]/.test(letter) ? record('WARN', 'cover letter contains [placeholders]') : record('PASS', 'cover letter has no [placeholders]');
        /\b(React|Kubernetes|AWS)\b/.test(letter) && !/React/i.test(profile) ? record('WARN', 'cover letter mentions a skill not in the profile (possible fabrication) — read it') : record('PASS', 'no obvious skill fabrication detected (heuristic, still read the letter)');
    }
    if (sections.interview) {
        const questions = sections.interview.interviewQuestions || [];
        questions.length >= 3 && questions.every((q) => q.question && q.suggestedAnswer) ? record('PASS', 'interview prep has 3+ complete questions', `${questions.length}`) : record('FAIL', 'interview prep incomplete', `${questions.length} questions`);
    }
    log('\nNow READ the cover letter and answers yourself. The checks above cannot judge honesty or tone.');
    return results;
}

module.exports = { verify, sample };

if (require.main === module) {
    if (!process.env.GROQ_API_KEY) {
        console.error('GROQ_API_KEY is not set. Run: GROQ_API_KEY=<your key> node scripts/verify-groq.js');
        process.exit(2);
    }
    verify().then((results) => {
        const counts = results.reduce((acc, r) => ({ ...acc, [r.level]: (acc[r.level] || 0) + 1 }), {});
        console.log(`\nSummary: ${JSON.stringify(counts)}`);
        process.exit(counts.FAIL ? 1 : 0);
    }).catch((error) => { console.error('Verification crashed:', error?.name, error?.message); process.exit(1); });
}
