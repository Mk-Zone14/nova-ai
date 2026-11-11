'use strict';

/*
 * Plumbing shared by the API endpoints: Groq calls, request parsing/validation and error mapping.
 * Lives in lib/ because every file in api/ becomes a public endpoint.
 */

const MAX_PROFILE_LENGTH = 8000;
const MAX_OPPORTUNITY_LENGTH = 12000;
const MAX_UPSTREAM_RESPONSE_LENGTH = 1000000;
const JSON_CONTENT_TYPE = 'application/json';
const UNAVAILABLE_MESSAGE = 'Analysis is temporarily unavailable. Please try again later.';
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

// The model stopped because it ran out of output tokens, so the JSON may be cut off. Even if the cut happened to land on a
// valid object, sections after the cut would be missing, so a truncated reply is never used.
class TruncatedOutputError extends InvalidModelOutputError {
    constructor() {
        super();
        this.name = 'TruncatedOutputError';
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

// `maxCompletionTokens` is optional and, when given, is sent as `max_completion_tokens`. For a reasoning model the limit covers
// the hidden reasoning as well as the JSON that is returned, so it has to leave room for both.
async function callModel({ system, user, deadline, maxMs, maxCompletionTokens }) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_STAGE_MS) {
        const error = new Error('Pipeline time budget exhausted');
        error.name = 'AbortError';
        throw error;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(remaining, maxMs));
    const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
    const startedAt = Date.now();
    try {
        const response = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                response_format: { type: 'json_object' },
                temperature: 0.2,
                ...(Number.isInteger(maxCompletionTokens) && maxCompletionTokens > 0 ? { max_completion_tokens: maxCompletionTokens } : {})
            }),
            signal: controller.signal
        });
        // Decide on the HTTP status first: gateways answer 429/401/5xx with non-JSON bodies, and those
        // must map to the right user-facing message instead of surfacing as a JSON SyntaxError.
        let json = null;
        try { json = await response.json(); } catch { /* handled below by status / content checks */ }
        if (!response.ok) throw new UpstreamError(response.status);
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text) throw new InvalidModelOutputError();
        logUsage(model, Date.now() - startedAt, json);
        if (json?.choices?.[0]?.finish_reason === 'length') {
            console.warn('Groq reply discarded: finish=length (output token limit reached, reply may be incomplete).');
            throw new TruncatedOutputError();
        }
        return text;
    } finally {
        clearTimeout(timeoutId);
    }
}

// One line per successful call so the owner can measure real latency and token cost from the platform
// logs. Numbers and a fixed-format finish reason only: never prompts, completions, profile or key.
function logUsage(model, elapsedMs, json) {
    const count = (value) => (Number.isFinite(value) ? Math.round(value) : 'n/a');
    const finish = /^[a-z_]{1,20}$/.test(json?.choices?.[0]?.finish_reason || '') ? json.choices[0].finish_reason : 'n/a';
    // reasoning_tokens is part of completion_tokens for a reasoning model; logged so the split between thinking and output is visible.
    console.info(`Groq call ok: model=${model} ms=${elapsedMs} prompt_tokens=${count(json?.usage?.prompt_tokens)} completion_tokens=${count(json?.usage?.completion_tokens)} reasoning_tokens=${count(json?.usage?.completion_tokens_details?.reasoning_tokens)} finish=${finish}`);
}

/**
 * Method / key / content-type / JSON-body checks common to every endpoint.
 * Returns the parsed body, or null after having sent the error response.
 */
function preflight(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: 'Method not allowed.' });
        return null;
    }
    if (!process.env.GROQ_API_KEY) {
        // Operator detail goes to the log (the variable NAME only); visitors get a generic message.
        console.error('GROQ_API_KEY is not set; AI endpoints are returning 503.');
        sendJson(res, 503, { error: UNAVAILABLE_MESSAGE });
        return null;
    }
    const contentType = req.headers?.['content-type'] || '';
    if (typeof contentType !== 'string' || (contentType && !contentType.toLowerCase().includes(JSON_CONTENT_TYPE))) {
        sendJson(res, 415, { error: 'Content-Type must be application/json.' });
        return null;
    }
    let body;
    try {
        body = readRequestBody(req.body);
    } catch {
        sendJson(res, 400, { error: 'Request body must contain valid JSON.' });
        return null;
    }
    if (!body || Array.isArray(body) || typeof body !== 'object') {
        sendJson(res, 400, { error: 'Request body must be a JSON object.' });
        return null;
    }
    return body;
}

/** Validates the profile + opportunity text every model endpoint needs. */
function validateTexts(body) {
    const profile = body.profile || '';
    const opportunity = body.opportunity || '';
    const valid = typeof profile === 'string' && typeof opportunity === 'string'
        && profile.trim().length >= 50 && opportunity.trim().length >= 50
        && profile.length <= MAX_PROFILE_LENGTH && opportunity.length <= MAX_OPPORTUNITY_LENGTH;
    return valid ? { profile, opportunity } : null;
}

const TEXT_LIMIT_MESSAGE = `Please provide both a profile and an opportunity description (50-${MAX_PROFILE_LENGTH.toLocaleString()} and 50-${MAX_OPPORTUNITY_LENGTH.toLocaleString()} characters respectively).`;

/**
 * Public messages are generic and safe to show to any visitor. What an operator needs (error name and upstream
 * status, never the key, request or response body) goes to the log only.
 */
function respondWithError(res, error, label) {
    const status = error instanceof UpstreamError ? ` (upstream status ${error.status})` : '';
    console.error(`${label} failed:`, `${error?.name || 'UnknownError'}${status}`);
    if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
        console.error('The AI provider rejected the credentials. Check GROQ_API_KEY.');
        return sendJson(res, 503, { error: UNAVAILABLE_MESSAGE });
    }
    if (error instanceof UpstreamError && error.status === 429) {
        res.setHeader('Retry-After', '30');
        return sendJson(res, 503, { error: 'Nova\'s AI service is busy right now. Please try again in a minute.' });
    }
    if (error?.name === 'AbortError') {
        return sendJson(res, 504, { error: 'Analysis timed out. Please try again.' });
    }
    if (error instanceof InvalidModelOutputError) {
        return sendJson(res, 502, { error: 'Nova could not produce a reliable analysis this time. Please try again.' });
    }
    return sendJson(res, 502, { error: 'Nova could not complete the analysis. Please try again.' });
}

module.exports = {
    UNAVAILABLE_MESSAGE, MAX_PROFILE_LENGTH, MAX_OPPORTUNITY_LENGTH, MAX_UPSTREAM_RESPONSE_LENGTH, TEXT_LIMIT_MESSAGE,
    UpstreamError, InvalidModelOutputError, TruncatedOutputError,
    sendJson, readRequestBody, isValidModelResponse, parseModelJson, callModel,
    preflight, validateTexts, respondWithError
};
