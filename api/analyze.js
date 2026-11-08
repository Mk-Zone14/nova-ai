const rateLimit = require('../lib/rate-limit');
const {
    normalizeRequirements, normalizeMatches, computeAssessment, buildDeterministicReport
} = require('../lib/eligibility');
const { createExtractPrompt, createMatchPrompt } = require('../lib/prompts');
const {
    MAX_PROFILE_LENGTH, MAX_OPPORTUNITY_LENGTH, MAX_UPSTREAM_RESPONSE_LENGTH, TEXT_LIMIT_MESSAGE,
    sendJson, readRequestBody, isValidModelResponse, parseModelJson, callModel, preflight, validateTexts, respondWithError
} = require('../lib/model');

// The verdict needs only two model calls. The writing (insights, cover letter, interview prep)
// is generated afterwards, on demand, by api/narrative.js so it never delays the decision.
const TOTAL_BUDGET_MS = 50_000; // keep under maxDuration in vercel.json
const EXTRACT_MAX_MS = 20_000;
const MATCH_MAX_MS = 25_000;

async function runPipeline(profile, opportunity) {
    const deadline = Date.now() + TOTAL_BUDGET_MS;

    // Stage 1: extract requirements. Each must carry a quote verifiable in the opportunity text.
    const extractRaw = parseModelJson(await callModel({
        system: createExtractPrompt(opportunity),
        user: 'Extract the requirements and output JSON.',
        deadline, maxMs: EXTRACT_MAX_MS
    }));
    const { requirements, dropped } = normalizeRequirements(extractRaw, opportunity);
    if (!requirements.length) return { noRequirements: true };

    // Stage 2: match against the profile. Evidence is verified in code, not trusted.
    const matchRaw = parseModelJson(await callModel({
        system: createMatchPrompt(requirements, profile),
        user: 'Assess each requirement against the profile and output JSON.',
        deadline, maxMs: MATCH_MAX_MS
    }));
    const matches = normalizeMatches(matchRaw, requirements, profile);

    // Stage 3 (code): verdict, score and evidence coverage.
    const assessment = computeAssessment(requirements, matches);
    return { report: buildDeterministicReport(requirements, matches, dropped, assessment) };
}

async function handler(req, res) {
    const body = preflight(req, res);
    if (!body) return;

    try {
        const texts = validateTexts(body);
        if (!texts) return sendJson(res, 400, { error: TEXT_LIMIT_MESSAGE });

        if (await rateLimit.isRateLimited(rateLimit.getClientKey(req))) {
            res.setHeader('Retry-After', String(Math.ceil(rateLimit.limits.WINDOW_MS / 1000)));
            return sendJson(res, 429, { error: 'Too many analysis requests. Please wait a minute and try again.' });
        }

        const result = await runPipeline(texts.profile, texts.opportunity);
        if (result.noRequirements) {
            return sendJson(res, 422, { error: 'Nova could not find clear requirements in the opportunity text. Paste the full eligibility criteria and try again.' });
        }
        return sendJson(res, 200, { response: JSON.stringify(result.report) });
    } catch (error) {
        return respondWithError(res, error, 'Analysis request');
    }
}

module.exports = handler;
module.exports.readRequestBody = readRequestBody;
module.exports.isRateLimited = rateLimit.isRateLimitedLocal;
module.exports.isValidModelResponse = isValidModelResponse;
module.exports.resetRateLimits = rateLimit.resetRateLimits;
module.exports.limits = { MAX_PROFILE_LENGTH, MAX_OPPORTUNITY_LENGTH, MAX_UPSTREAM_RESPONSE_LENGTH, RATE_LIMIT_MAX_REQUESTS: rateLimit.limits.MAX_REQUESTS };
