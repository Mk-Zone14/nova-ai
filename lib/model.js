'use strict';

/*
 * Plumbing shared by the API endpoints: Groq calls, request parsing/validation and error mapping.
 * Lives in lib/ because every file in api/ becomes a public endpoint.
 */

const MAX_PROFILE_LENGTH = 8000;
const MAX_OPPORTUNITY_LENGTH = 12000;
const MAX_UPSTREAM_RESPONSE_LENGTH = 1000000;
const JSON_CONTENT_TYPE = 'application/json';
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
        sendJson(res, 503, { error: 'The server is not configured for AI analysis. Add GROQ_API_KEY to Vercel and redeploy.' });
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

function respondWithError(res, error, label) {
    console.error(`${label} failed:`, error?.name || 'UnknownError');
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

module.exports = {
    MAX_PROFILE_LENGTH, MAX_OPPORTUNITY_LENGTH, MAX_UPSTREAM_RESPONSE_LENGTH, TEXT_LIMIT_MESSAGE,
    UpstreamError, InvalidModelOutputError,
    sendJson, readRequestBody, isValidModelResponse, parseModelJson, callModel,
    preflight, validateTexts, respondWithError
};
