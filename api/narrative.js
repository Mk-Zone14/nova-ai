const rateLimit = require('../lib/rate-limit');
const {
    sendJson, preflight, validateTexts, TEXT_LIMIT_MESSAGE, callModel, parseModelJson, InvalidModelOutputError, respondWithError
} = require('../lib/model');
const { SECTIONS, validateAssessment, sanitizeSection, guardSection } = require('../lib/narrative');
const { applyProvenance } = require('../lib/provenance');

// One model call per request. Keep under maxDuration in vercel.json.
const BUDGET_MS = 50_000;
const CALL_MAX_MS = 45_000;
// Each analysis can trigger up to three narrative requests (insights + cover letter + interview).
const NARRATIVE_RATE_LIMIT = 20;

async function handler(req, res) {
    const body = preflight(req, res);
    if (!body) return;

    try {
        const texts = validateTexts(body);
        if (!texts) return sendJson(res, 400, { error: TEXT_LIMIT_MESSAGE });

        const section = typeof body.section === 'string' && Object.prototype.hasOwnProperty.call(SECTIONS, body.section) ? body.section : null;
        if (!section) return sendJson(res, 400, { error: 'Unknown section.' });

        const assessment = validateAssessment(body.assessment);
        if (!assessment) return sendJson(res, 400, { error: 'The assessment is missing or invalid. Run the analysis again.' });

        if (await rateLimit.isRateLimited(`narrative:${rateLimit.getClientKey(req)}`, Date.now(), NARRATIVE_RATE_LIMIT)) {
            res.setHeader('Retry-After', String(Math.ceil(rateLimit.limits.WINDOW_MS / 1000)));
            return sendJson(res, 429, { error: 'Too many requests. Please wait a minute and try again.' });
        }

        const config = SECTIONS[section];
        const raw = parseModelJson(await callModel({
            ...config.prompt(texts.profile, texts.opportunity, assessment),
            deadline: Date.now() + BUDGET_MS,
            maxMs: CALL_MAX_MS
        }));
        const clean = sanitizeSection(section, raw);
        if (config.complete && !config.complete(clean)) {
            console.warn(`Narrative reply incomplete in ${section}: ${(config.keys.filter((key) => clean[key] === undefined)).length} section(s) missing.`);
            throw new InvalidModelOutputError();
        }
        const guarded = guardSection(clean, texts.profile, texts.opportunity, assessment);
        const grounded = applyProvenance(section, guarded.data, texts.opportunity);
        guarded.data = grounded.data;
        guarded.removed = [...guarded.removed, ...grounded.removed];
        // Log that something was withheld and why, never what (it is the applicant's content).
        if (guarded.removed.length) console.warn(`Narrative guard withheld ${guarded.removed.length} item(s) in ${section}: ${[...new Set(guarded.removed.map((reason) => reason.split(':')[0]))].join('; ')}`);
        const data = guarded.data;
        if (!config.valid(data)) throw new InvalidModelOutputError();
        return sendJson(res, 200, { section, data });
    } catch (error) {
        return respondWithError(res, error, 'Narrative request');
    }
}

module.exports = handler;
