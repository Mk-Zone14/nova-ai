'use strict';

/*
 * Deterministic eligibility core.
 *
 * The LLM is only allowed to *propose* requirements and statuses. Everything
 * that reaches the user as a verdict or score is derived here, in code, from
 * statuses whose evidence has been verified against the user's own text.
 *
 * NOTE: lives in lib/, not api/ — every file in api/ becomes a public Vercel endpoint.
 */

const STATUS = Object.freeze({
    MATCHED: 'Matched',
    PARTIAL: 'Partial Match',
    MISSING: 'Missing',
    UNKNOWN: 'Unknown'
});

const VERDICT = Object.freeze({
    ELIGIBLE: 'Eligible',
    NEEDS_VERIFICATION: 'Needs verification',
    NOT_ELIGIBLE: 'Not eligible'
});

// Tunable scoring constants. Partial credit is a judgement call, not a measured value.
const STATUS_CREDIT = Object.freeze({
    [STATUS.MATCHED]: 1,
    [STATUS.PARTIAL]: 0.5,
    [STATUS.MISSING]: 0,
    [STATUS.UNKNOWN]: 0 // unproven counts as not earned: the score is deliberately conservative
});
const WEIGHT = Object.freeze({ hard: 3, mandatory: 2, preferred: 1 });

const MAX_REQUIREMENTS = 25;
const MAX_REQUIREMENT_LENGTH = 300;
const MAX_QUOTE_LENGTH = 400;
const MIN_FRAGMENT_LENGTH = 3;
const MAX_REASONING_LENGTH = 500;
const WITHHELD_REASONING = 'The explanation was withheld because it contained figures that are not in your profile.';

const { figureKeys, unsupportedFigures } = require('./guards');

function normalizeForMatch(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .replace(/[‘’‛′]/g, "'")
        .replace(/[“”‟″]/g, '"')
        .replace(/[‐-―−]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-token containment, so the quote "Java" does not verify against "JavaScript".
function containsFragment(haystack, fragment) {
    const startsAlnum = /^[\p{L}\p{N}]/u.test(fragment);
    const endsAlnum = /[\p{L}\p{N}]$/u.test(fragment);
    const pattern = `${startsAlnum ? '(?<![\\p{L}\\p{N}])' : ''}${escapeRegExp(fragment)}${endsAlnum ? '(?![\\p{L}\\p{N}])' : ''}`;
    return new RegExp(pattern, 'u').test(haystack);
}

/**
 * True only if every "..."-separated fragment of `quote` appears verbatim
 * (modulo case, whitespace, quote/dash style) in `sourceText`.
 */
function isVerbatimQuote(quote, sourceText) {
    if (typeof quote !== 'string' || !quote.trim() || quote.length > MAX_QUOTE_LENGTH) return false;
    const fragments = quote.split(/\.{3}|…/).map(normalizeForMatch).filter(Boolean);
    if (!fragments.length) return false;
    const haystack = normalizeForMatch(sourceText);
    return fragments.every((fragment) => fragment.length >= MIN_FRAGMENT_LENGTH && containsFragment(haystack, fragment));
}

function toBoolean(value) {
    return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function cleanText(value, max) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Validate the extraction stage. A requirement survives only if its source
 * quote is verifiable in the opportunity text, so invented requirements can't
 * affect the verdict. Dropped items are returned for the audit trail.
 */
function normalizeRequirements(raw, opportunityText) {
    const items = Array.isArray(raw?.requirements) ? raw.requirements : [];
    const requirements = [];
    const dropped = [];
    const seen = new Set();

    for (const item of items) {
        if (requirements.length >= MAX_REQUIREMENTS) break;
        let text = cleanText(item?.requirement, MAX_REQUIREMENT_LENGTH);
        if (!text) continue;
        // The short wording is the model's paraphrase. If it carries a figure the posting does not (a rounded or altered
        // threshold), show the posting's own quote instead.
        if (unsupportedFigures(text, figureKeys(opportunityText)).length) text = cleanText(item?.sourceQuote, MAX_REQUIREMENT_LENGTH) || text;
        const key = normalizeForMatch(text);
        if (seen.has(key)) continue;
        if (!isVerbatimQuote(item?.sourceQuote, opportunityText)) {
            dropped.push({ requirement: text, reason: 'Source quote not found in the opportunity text.' });
            continue;
        }
        seen.add(key);
        const hardEligibility = toBoolean(item.hardEligibility);
        requirements.push({
            id: `R${requirements.length + 1}`,
            requirement: text,
            sourceQuote: cleanText(item.sourceQuote, MAX_QUOTE_LENGTH),
            hardEligibility,
            mandatory: hardEligibility || toBoolean(item.mandatory) // a hard gate is always mandatory
        });
    }
    return { requirements, dropped };
}

function coerceStatus(value) {
    const key = String(value ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
    if (['matched', 'met', 'satisfied', 'completed'].includes(key)) return STATUS.MATCHED;
    if (['partial match', 'partial', 'partially met', 'partially matched'].includes(key)) return STATUS.PARTIAL;
    if (['missing', 'not met', 'unmet'].includes(key)) return STATUS.MISSING;
    return STATUS.UNKNOWN;
}

/**
 * Validate the matching stage against the user's profile text.
 *  - Matched / Partial need a verbatim profile quote, else they become Unknown.
 *  - Missing on a *hard* requirement needs a verbatim quote that contradicts it,
 *    else it becomes Unknown: absence from a resume is not proof of ineligibility.
 * Returns exactly one match per requirement, in requirement order.
 */
function normalizeMatches(raw, requirements, profileText) {
    const items = Array.isArray(raw?.matches) ? raw.matches : [];
    const byId = new Map();
    for (const item of items) {
        const id = cleanText(item?.requirementId, 20);
        if (id && !byId.has(id)) byId.set(id, item);
    }

    return requirements.map((requirement) => {
        const item = byId.get(requirement.id);
        if (!item) {
            return {
                requirementId: requirement.id, status: STATUS.UNKNOWN, claimedStatus: null, evidenceQuote: '',
                evidenceVerified: false, downgraded: false,
                reasoning: 'The model returned no assessment for this requirement.'
            };
        }

        const claimedStatus = coerceStatus(item.status);
        let status = claimedStatus;
        let evidenceQuote = '';
        let evidenceVerified = false;
        let reasoning = cleanText(item.reasoning, MAX_REASONING_LENGTH);
        // Figures in the explanation must come from the profile or the requirement itself, never be recomputed or rounded.
        if (reasoning && unsupportedFigures(reasoning, figureKeys([profileText, requirement.requirement, requirement.sourceQuote])).length) reasoning = WITHHELD_REASONING;
        let downgradeReason = null;

        if (claimedStatus === STATUS.MATCHED || claimedStatus === STATUS.PARTIAL) {
            if (isVerbatimQuote(item.evidenceQuote, profileText)) {
                evidenceQuote = cleanText(item.evidenceQuote, MAX_QUOTE_LENGTH);
                evidenceVerified = true;
            } else {
                status = STATUS.UNKNOWN;
                downgradeReason = 'The cited evidence could not be found in your profile, so this was not counted.';
            }
        } else if (claimedStatus === STATUS.MISSING && requirement.hardEligibility) {
            if (isVerbatimQuote(item.contradictingQuote, profileText)) {
                evidenceQuote = cleanText(item.contradictingQuote, MAX_QUOTE_LENGTH);
                evidenceVerified = true;
            } else {
                status = STATUS.UNKNOWN;
                downgradeReason = 'Your profile does not mention this, which is not the same as failing it. Please verify it.';
            }
        }

        if (downgradeReason) reasoning = reasoning ? `${downgradeReason} (Model said: ${reasoning})` : downgradeReason;
        return {
            requirementId: requirement.id, status, claimedStatus, evidenceQuote, evidenceVerified,
            downgraded: status !== claimedStatus, reasoning
        };
    });
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const joinList = (items) => items.slice(0, 3).join('; ') + (items.length > 3 ? `; and ${items.length - 3} more` : '');

/**
 * Pure function: requirements + validated matches -> verdict, score, coverage.
 *   Not eligible       : any hard requirement is Missing (with a verified contradiction)
 *   Needs verification : otherwise, any hard requirement is Unknown or only Partial
 *   Eligible           : otherwise
 * fitScore = weighted share of earned credit (hard 3, mandatory 2, preferred 1).
 * evidenceCoverage = % of requirements backed by a verified quote.
 */
function computeAssessment(requirements, matches) {
    const matchById = new Map(matches.map((match) => [match.requirementId, match]));
    const counts = { [STATUS.MATCHED]: 0, [STATUS.PARTIAL]: 0, [STATUS.MISSING]: 0, [STATUS.UNKNOWN]: 0 };
    const hardMissing = [];
    const hardUnresolved = [];
    const mandatoryGaps = [];
    let earned = 0;
    let possible = 0;
    let verified = 0;
    let hardTotal = 0;

    for (const requirement of requirements) {
        const match = matchById.get(requirement.id);
        const status = match?.status ?? STATUS.UNKNOWN;
        counts[status] += 1;
        if (match?.evidenceVerified) verified += 1;

        const weight = requirement.hardEligibility ? WEIGHT.hard : requirement.mandatory ? WEIGHT.mandatory : WEIGHT.preferred;
        possible += weight;
        earned += weight * STATUS_CREDIT[status];

        if (requirement.hardEligibility) {
            hardTotal += 1;
            if (status === STATUS.MISSING) hardMissing.push(requirement.requirement);
            else if (status !== STATUS.MATCHED) hardUnresolved.push(requirement.requirement);
        } else if (requirement.mandatory && (status === STATUS.MISSING || status === STATUS.UNKNOWN)) {
            mandatoryGaps.push(requirement.requirement);
        }
    }

    const hasRequirements = requirements.length > 0;
    const fitScore = hasRequirements && possible > 0 ? Math.round((earned / possible) * 100) : null;
    const evidenceCoverage = hasRequirements ? Math.round((verified / requirements.length) * 100) : null;

    let verdict;
    let verdictReason;
    if (hardMissing.length) {
        verdict = VERDICT.NOT_ELIGIBLE;
        verdictReason = `${plural(hardMissing.length, 'hard eligibility requirement')} not met: ${joinList(hardMissing)}.`;
    } else if (hardUnresolved.length || !hasRequirements) {
        verdict = VERDICT.NEEDS_VERIFICATION;
        verdictReason = hasRequirements
            ? `Eligibility can't be confirmed: ${plural(hardUnresolved.length, 'hard requirement')} lack${hardUnresolved.length === 1 ? 's' : ''} verified evidence in your profile: ${joinList(hardUnresolved)}.`
            : 'No requirements could be verified from the opportunity text.';
    } else {
        verdict = VERDICT.ELIGIBLE;
        verdictReason = hardTotal
            ? `All ${plural(hardTotal, 'hard eligibility requirement')} verified as met.`
            : 'No hard eligibility requirements were identified in the opportunity text, so nothing disqualifying was checked. Confirm against the official criteria.';
    }
    if (verdict !== VERDICT.NOT_ELIGIBLE && mandatoryGaps.length) {
        verdictReason += ` ${plural(mandatoryGaps.length, 'other mandatory requirement')} missing or unproven: ${joinList(mandatoryGaps)}.`;
    }

    return {
        verdict, verdictReason, fitScore, evidenceCoverage, counts,
        hardTotal, hardMissing, hardUnresolved, mandatoryGaps
    };
}

function joinRows(requirements, matches) {
    const matchById = new Map(matches.map((match) => [match.requirementId, match]));
    return requirements.map((requirement) => ({ requirement, match: matchById.get(requirement.id) }));
}

/** Report fields the UI already understands, plus an audit trail. */
function buildDeterministicReport(requirements, matches, dropped, assessment) {
    const rows = joinRows(requirements, matches);
    const mapping = rows.map(({ requirement, match }) => ({
        requirement: requirement.requirement,
        status: match.status,
        evidence: match.evidenceQuote || '',
        note: match.reasoning,
        reasoning: match.reasoning,
        confidence: match.evidenceVerified ? 'Verified' : 'Not verified',
        mandatory: requirement.mandatory,
        hardEligibility: requirement.hardEligibility,
        evidenceVerified: match.evidenceVerified
    }));
    const unresolved = rows
        .filter(({ requirement, match }) => (requirement.mandatory || requirement.hardEligibility) && (match.status === STATUS.MISSING || match.status === STATUS.UNKNOWN))
        .map(({ requirement }) => requirement.requirement);

    return {
        overallMatchScore: assessment.fitScore,
        eligibilityVerdict: assessment.verdict,
        verdictReason: assessment.verdictReason,
        whyVerdict: assessment.verdictReason,
        finalVerdict: assessment.verdictReason,
        executiveRecommendation: assessment.verdictReason,
        readinessCategory: assessment.verdict === VERDICT.ELIGIBLE ? 'Ready to apply' : assessment.verdict,
        confidenceScore: assessment.evidenceCoverage, // surfaced in the UI as "Evidence coverage"
        evidenceCoverage: assessment.evidenceCoverage,
        applicationReadiness: null,
        requirementMapping: mapping,
        mandatoryRequirements: mapping.filter((item) => item.mandatory),
        preferredRequirements: mapping.filter((item) => !item.mandatory),
        missingRequirements: unresolved,
        _evidenceTrace: {
            scoring: { weights: WEIGHT, statusCredit: STATUS_CREDIT, counts: assessment.counts },
            requirements: requirements.map(({ id, requirement, sourceQuote, mandatory, hardEligibility }) => ({ id, requirement, sourceQuote, mandatory, hardEligibility })),
            matches,
            droppedRequirements: dropped,
            downgrades: matches.filter((match) => match.downgraded).map((match) => ({ requirementId: match.requirementId, claimed: match.claimedStatus, final: match.status }))
        }
    };
}

module.exports = {
    STATUS, VERDICT, WEIGHT, STATUS_CREDIT, MAX_REQUIREMENTS,
    normalizeForMatch, isVerbatimQuote, normalizeRequirements, normalizeMatches,
    computeAssessment, buildDeterministicReport
};
