const {
    normalizeRequirements, normalizeMatches, computeAssessment, buildDeterministicReport
} = require('../lib/eligibility');
const rateLimit = require('../lib/rate-limit');
const { createExtractPrompt, createMatchPrompt, createNarrativePrompt, NARRATIVE_KEYS } = require('../lib/prompts');

const MAX_PROFILE_LENGTH = 8000;
const MAX_OPPORTUNITY_LENGTH = 12000;
const MAX_UPSTREAM_RESPONSE_LENGTH = 1000000;
const JSON_CONTENT_TYPE = 'application/json';

// One shared budget for the whole pipeline; keep it under maxDuration in vercel.json.
const TOTAL_BUDGET_MS = 50_000;
const EXTRACT_MAX_MS = 20_000;
const MATCH_MAX_MS = 25_000;
const NARRATIVE_MAX_MS = 30_000;
const MIN_STAGE_MS = 1_000;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

class UpstreamError extends Error {
    constructor(status) {
        super(`Upstream status ${status}`);
        this.name = 'UpstreamError';
        this.status = status;
    }
}
class InvalidModelOutputError extends Error {
    constructor() {
        super('Invalid model output');
        this.name = 'InvalidModelOutputError';
    }
}

function sendJson(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(status).json(body);
}

function readRequestBody(body) {
    if (!body) return {};
    if (typeof body === 'string') return JSON.parse(body);
    return body;
}

function isValidModelResponse(text) {
    if (typeof text !== 'string' || text.length > MAX_UPSTREAM_RESPONSE_LENGTH) return false;
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object';
    } catch {
        return false;
    }
}

function parseModelJson(text) {
    if (!isValidModelResponse(text)) throw new InvalidModelOutputError();
    return JSON.parse(text);
}

async function callModel({ system, user, deadline, maxMs }) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_STAGE_MS) {
        const error = new Error('Pipeline time budget exhausted');
        error.name = 'AbortError';
        throw error;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(remaining, maxMs));
    try {
        const response = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.GROQ_MODEL || DEFAULT_MODEL,
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                response_format: { type: 'json_object' },
                temperature: 0.2
            }),
            signal: controller.signal
        });
        const json = await response.json();
        const text = json?.choices?.[0]?.message?.content;
        if (!response.ok || !text) throw new UpstreamError(response.status);
        return text;
    } finally {
        clearTimeout(timeoutId);
    }
}

// Keep only schema-listed narrative fields so the model can never set a verdict or score.
function sanitizeNarrative(raw) {
    const clean = {};
    for (const key of NARRATIVE_KEYS) {
        if (raw[key] !== undefined && raw[key] !== null) clean[key] = raw[key];
    }
    return clean;
}

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
    const report = buildDeterministicReport(requirements, matches, dropped, assessment);

    // Stage 4: narrative. Failure here must not discard a verified verdict.
    let narrative = {};
    let narrativeAvailable = true;
    try {
        const rows = requirements.map((requirement, index) => ({ ...requirement, status: matches[index].status }));
        narrative = sanitizeNarrative(parseModelJson(await callModel({
            system: createNarrativePrompt(profile, opportunity, { verdict: assessment.verdict, rows }),
            user: 'Write the narrative sections and output JSON.',
            deadline, maxMs: NARRATIVE_MAX_MS
        })));
    } catch (error) {
        narrativeAvailable = false;
        console.error('Narrative stage failed:', error?.name || 'UnknownError');
    }

    return { report: { ...narrative, ...report, narrativeAvailable } };
}

async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    if (!process.env.GROQ_API_KEY) {
        return sendJson(res, 503, { error: 'The server is not configured for AI analysis. Add GROQ_API_KEY to Vercel and redeploy.' });
    }

    try {
        const contentType = req.headers?.['content-type'] || '';
        if (typeof contentType !== 'string' || (contentType && !contentType.toLowerCase().includes(JSON_CONTENT_TYPE))) {
            return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
        }

        // Vercel parses JSON bodies. The string branch keeps the handler testable and robust.
        let body;
        try {
            body = readRequestBody(req.body);
        } catch {
            return sendJson(res, 400, { error: 'Request body must contain valid JSON.' });
        }
        if (!body || Array.isArray(body) || typeof body !== 'object') {
            return sendJson(res, 400, { error: 'Request body must be a JSON object.' });
        }
        const profile = body.profile || '';
        const opportunity = body.opportunity || '';

        if (typeof profile !== 'string' || typeof opportunity !== 'string' || profile.trim().length < 50 || opportunity.trim().length < 50 || profile.length > MAX_PROFILE_LENGTH || opportunity.length > MAX_OPPORTUNITY_LENGTH) {
            return sendJson(res, 400, { error: `Please provide both a profile and an opportunity description (50-${MAX_PROFILE_LENGTH.toLocaleString()} and 50-${MAX_OPPORTUNITY_LENGTH.toLocaleString()} characters respectively).` });
        }

        if (await rateLimit.isRateLimited(rateLimit.getClientKey(req))) {
            res.setHeader('Retry-After', String(Math.ceil(rateLimit.limits.WINDOW_MS / 1000)));
            return sendJson(res, 429, { error: 'Too many analysis requests. Please wait a minute and try again.' });
        }

        const result = await runPipeline(profile, opportunity);
        if (result.noRequirements) {
            return sendJson(res, 422, { error: 'Nova could not find clear requirements in the opportunity text. Paste the full eligibility criteria and try again.' });
        }
        return sendJson(res, 200, { response: JSON.stringify(result.report) });
    } catch (error) {
        console.error('Analysis request failed:', error?.name || 'UnknownError');
        if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
            return sendJson(res, 401, { error: 'Your Groq API key is expired or invalid. Please check your Vercel Environment Variables.' });
        }
        if (error?.name === 'AbortError') {
            return sendJson(res, 504, { error: 'Analysis timed out. Please try again.' });
        }
        if (error instanceof InvalidModelOutputError) {
            return sendJson(res, 502, { error: 'Groq returned an invalid analysis. Please try again.' });
        }
        return sendJson(res, 502, { error: 'Groq could not complete the analysis. Please try again.' });
    }
}

module.exports = handler;
module.exports.readRequestBody = readRequestBody;
module.exports.isRateLimited = rateLimit.isRateLimitedLocal;
module.exports.isValidModelResponse = isValidModelResponse;
module.exports.resetRateLimits = rateLimit.resetRateLimits;
module.exports.limits = { MAX_PROFILE_LENGTH, MAX_OPPORTUNITY_LENGTH, MAX_UPSTREAM_RESPONSE_LENGTH, RATE_LIMIT_MAX_REQUESTS: rateLimit.limits.MAX_REQUESTS };
