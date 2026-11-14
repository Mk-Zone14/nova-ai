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
const { hardDowngradeReason } = require('./classification');

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

// ---- preferred-section recovery ------------------------------------------------------------------------------------
// The extractor is one model call and sometimes leaves out the "Preferred" list entirely (observed in production: the same
// posting gave 5 requirements in one run and 9 in the next). Lines under an explicit preferred/nice-to-have heading are
// therefore recovered in code, as preferred requirements only, with the line itself as the verbatim quote.

const PREFERRED_HEADING = /^(?:preferred|nice[\s-]*to[\s-]*haves?|bonus(?:\s+points?)?|good[\s-]*to[\s-]*have|desirable|desired|a\s+plus|pluses|advantageous|optional)(?:\s+(?:qualifications?|skills?|requirements?|experience|criteria|background|but\s+not\s+required|to\s+have))?\s*:?\s*$/i;
const OTHER_HEADING = /^(?:requirements?|minimum\s+(?:qualifications?|requirements?)|basic\s+qualifications?|eligibility(?:\s+criteria)?|responsibilities|duties|what\s+you(?:'ll|\s+will)\s+do|benefits?|perks?|what\s+we\s+offer|compensation|stipend|salary|about(?:\s+(?:us|the\s+role|the\s+team))?|how\s+to\s+apply|application\s+process|deadline|location|duration|timeline|role|overview|description|skills?|required(?:\s+(?:skills?|qualifications?))?|qualifications?|must[\s-]*haves?)\s*:?\s*$/i;
const BULLET = /^\s*(?:[-*•·▪◦‣–—]|\d{1,2}[.)]|[a-z][.)])\s+/i;
// Lines that describe the offer or the organisation rather than the applicant.
const NOT_A_QUALIFICATION = /\b(?:stipend|salary|₹|\$|€|£|per\s+(?:month|hour|week|annum)|lpa|certificate\s+of|benefits?|perks?|lunch|swag|we\s+offer|we\s+provide|you\s+will\s+(?:get|receive|be\s+paid)|flexible\s+(?:hours|timings)|mentorship\s+from|letter\s+of\s+recommendation|allowance|free\s+|discount)\b/i;
// Lines that tell the applicant how to apply rather than what they need. A posting often ends its Preferred list with
// "Submit a resume and a cover letter."; without a heading of its own that line was recovered as a preferred requirement and
// scored Missing or Unknown (four of four real postings).
const APPLICATION_INSTRUCTION = /^(?:(?:please\s+)?(?:submit|send|email|e-mail|upload|attach|share|forward|include)\b[^.]*\b(?:resume|r[eé]sum[eé]|cv|cover\s+letter|transcripts?|portfolio|application|references?|documents?|form|statement\s+of\s+purpose|sop)\b|(?:please\s+)?apply\b|how\s+to\s+apply\b|to\s+apply\b|applications?\s+(?:are|will|must|should|close|open|via|through)\b|shortlisted\b|interviews?\s+(?:will|are)\b)/i;
const MAX_RECOVERED_LINE = 200;

function stripBullet(line) {
    return line.replace(BULLET, '').trim();
}
function isHeadingLike(line) {
    const text = stripBullet(line);
    return text.length <= 60 && (PREFERRED_HEADING.test(text) || OTHER_HEADING.test(text) || (/:$/.test(text) && !/[.!?]/.test(text.slice(0, -1))));
}

/** Verbatim lines listed under an explicit preferred heading in the posting, in order. */
function preferredSectionLines(opportunityText) {
    const lines = String(opportunityText ?? '').split(/\r?\n/);
    const found = [];
    let inPreferred = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const text = stripBullet(line);
        // "Nice to have: Docker, AWS" on one line: the heading and its only item.
        const inline = /^([^:]{3,60}):\s*(.+)$/.exec(text);
        if (inline && PREFERRED_HEADING.test(`${inline[1]}:`)) {
            inPreferred = true;
            if (!NOT_A_QUALIFICATION.test(inline[2]) && !APPLICATION_INSTRUCTION.test(inline[2])) found.push(inline[2].trim());
            continue;
        }
        if (isHeadingLike(line)) {
            inPreferred = PREFERRED_HEADING.test(text);
            continue;
        }
        if (!inPreferred) continue;
        if (text.length > MAX_RECOVERED_LINE || text.length < 3) continue;
        if (NOT_A_QUALIFICATION.test(text) || APPLICATION_INSTRUCTION.test(text)) continue;
        if ((text.match(/[.!?](?:\s+[A-Z]|$)/g) || []).length > 1) continue; // multi-sentence prose, not a list item
        found.push(text);
    }
    return found;
}

const overlaps = (a, b) => {
    const x = normalizeForMatch(a).replace(/[.!?]+$/, '');
    const y = normalizeForMatch(b).replace(/[.!?]+$/, '');
    return x.length >= MIN_FRAGMENT_LENGTH && y.length >= MIN_FRAGMENT_LENGTH && (x.includes(y) || y.includes(x));
};

/**
 * Validate the extraction stage. A requirement survives only if its source
 * quote is verifiable in the opportunity text, so invented requirements can't
 * affect the verdict. Dropped items are returned for the audit trail.
 *
 * Preferred-section lines (see above) are then reconciled with the model's items: an extracted item whose quote comes
 * from that section is never hard or mandatory (downgrade only; nothing is ever promoted), and a listed line the model
 * left out is added as a preferred requirement. Both are recorded in the trace.
 */
function normalizeRequirements(raw, opportunityText) {
    const items = Array.isArray(raw?.requirements) ? raw.requirements : [];
    const requirements = [];
    const dropped = [];
    const seen = new Set();
    const seenQuotes = new Set();

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
        const sourceQuote = cleanText(item.sourceQuote, MAX_QUOTE_LENGTH);
        const quoteKey = normalizeForMatch(sourceQuote);
        if (seenQuotes.has(quoteKey)) continue; // the same posting line twice under different wording
        seen.add(key);
        seenQuotes.add(quoteKey);
        const hardEligibility = toBoolean(item.hardEligibility);
        requirements.push({
            id: `R${requirements.length + 1}`,
            requirement: text,
            sourceQuote,
            hardEligibility,
            mandatory: hardEligibility || toBoolean(item.mandatory) // a hard gate is always mandatory
        });
    }

    const preferredLines = preferredSectionLines(opportunityText);
    const reclassified = [];
    const recovered = [];
    for (const requirement of requirements) {
        if (!preferredLines.some((line) => overlaps(line, requirement.sourceQuote))) continue;
        if (requirement.hardEligibility || requirement.mandatory) {
            reclassified.push({ id: requirement.id, requirement: requirement.requirement, was: requirement.hardEligibility ? 'hard' : 'mandatory' });
            requirement.hardEligibility = false;
            requirement.mandatory = false;
        }
    }
    // F2: a skill, proficiency, amount of experience or completed project is not an eligibility gate, whatever the heading or
    // the word "required" suggests. Downgrade only (hard -> mandatory: still required, still weighted, no longer able to
    // decide the verdict), and only when the wording is clearly a skill/experience criterion with no gate signal and the
    // posting does not itself say that lacking it disqualifies. See lib/classification.js.
    for (const requirement of requirements) {
        if (!requirement.hardEligibility) continue;
        const reason = hardDowngradeReason(requirement, opportunityText);
        if (!reason) continue;
        requirement.hardEligibility = false;
        reclassified.push({ id: requirement.id, requirement: requirement.requirement, was: 'hard', reason });
    }
    for (const line of preferredLines) {
        if (requirements.length >= MAX_REQUIREMENTS) break;
        const text = cleanText(line.replace(/[.;]+$/, ''), MAX_REQUIREMENT_LENGTH);
        const key = normalizeForMatch(text);
        if (!text || seen.has(key)) continue;
        if (requirements.some((requirement) => overlaps(line, requirement.sourceQuote) || overlaps(text, requirement.requirement))) continue;
        seen.add(key);
        requirements.push({ id: `R${requirements.length + 1}`, requirement: text, sourceQuote: cleanText(line, MAX_QUOTE_LENGTH), hardEligibility: false, mandatory: false, recovered: true });
        recovered.push({ id: requirements[requirements.length - 1].id, requirement: text });
    }
    return { requirements, dropped, recovered, reclassified };
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
    const tier = () => ({ total: 0, matched: 0, partial: 0, missing: 0, unknown: 0, earned: 0, possible: 0 });
    const tiers = { required: tier(), preferred: tier() };
    const TIER_KEY = { [STATUS.MATCHED]: 'matched', [STATUS.PARTIAL]: 'partial', [STATUS.MISSING]: 'missing', [STATUS.UNKNOWN]: 'unknown' };

    for (const requirement of requirements) {
        const match = matchById.get(requirement.id);
        const status = match?.status ?? STATUS.UNKNOWN;
        counts[status] += 1;
        if (match?.evidenceVerified) verified += 1;

        const weight = requirement.hardEligibility ? WEIGHT.hard : requirement.mandatory ? WEIGHT.mandatory : WEIGHT.preferred;
        possible += weight;
        earned += weight * STATUS_CREDIT[status];
        const bucket = requirement.hardEligibility || requirement.mandatory ? tiers.required : tiers.preferred;
        bucket.total += 1;
        bucket[TIER_KEY[status]] += 1;
        bucket.possible += weight;
        bucket.earned += weight * STATUS_CREDIT[status];

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
    const requirementsMatch = buildRequirementsMatch(tiers, { fitScore, earned, possible, evidenceCoverage, verified, total: requirements.length });

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
        verdict, verdictReason, fitScore, evidenceCoverage, requirementsMatch, counts,
        hardTotal, hardMissing, hardUnresolved, mandatoryGaps
    };
}

/*
 * Requirements match: how many of the posting's requirements the profile meets, per tier. It is a different question
 * from eligibility (are the hard gates passed?) and from evidence coverage (how many statuses rest on a verified quote?),
 * so it is reported as its own object with its own explanation. The fit score itself is unchanged; its arithmetic is
 * spelled out here so the number can be checked by hand.
 */
function buildRequirementsMatch(tiers, { fitScore, earned, possible, evidenceCoverage, verified, total }) {
    const finish = ({ total: count, matched, partial, missing, unknown, earned: tierEarned, possible: tierPossible }) => ({
        total: count, matched, partial, missing, unknown,
        percent: count > 0 ? Math.round(((matched + STATUS_CREDIT[STATUS.PARTIAL] * partial) / count) * 100) : null,
        weightedEarned: tierEarned, weightedPossible: tierPossible
    });
    const required = finish(tiers.required);
    const preferred = finish(tiers.preferred);
    const fmt = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
    const fitExplanation = fitScore === null
        ? 'No fit score: no requirements were verified.'
        : `Fit score ${fitScore} = weighted credit ${fmt(earned)} ÷ weighted total ${fmt(possible)} (required tier ${fmt(required.weightedEarned)}/${fmt(required.weightedPossible)}, preferred tier ${fmt(preferred.weightedEarned)}/${fmt(preferred.weightedPossible)}). Weights: hard ${WEIGHT.hard}, mandatory ${WEIGHT.mandatory}, preferred ${WEIGHT.preferred}; credit: Matched 1, Partial Match ${STATUS_CREDIT[STATUS.PARTIAL]}, Missing and Unknown 0.`;
    const evidenceExplanation = evidenceCoverage === null
        ? 'No evidence coverage: no requirements were verified.'
        : `Evidence coverage ${evidenceCoverage}% = ${verified} of ${total} requirement statuses rest on a quote verified in your profile. It is not confidence in the verdict. A requirement your profile does not meet usually has no supporting quote, so missing qualifications lower this number as well.`;
    return { required, preferred, fitExplanation, evidenceExplanation };
}

function joinRows(requirements, matches) {
    const matchById = new Map(matches.map((match) => [match.requirementId, match]));
    return requirements.map((requirement) => ({ requirement, match: matchById.get(requirement.id) }));
}

/** Report fields the UI already understands, plus an audit trail. */
function buildDeterministicReport(requirements, matches, dropped, assessment, { recovered = [], reclassified = [] } = {}) {
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
        confidenceScore: assessment.evidenceCoverage, // legacy key; the UI labels it "Evidence coverage", never confidence
        evidenceCoverage: assessment.evidenceCoverage,
        requirementsMatch: assessment.requirementsMatch,
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
            recoveredRequirements: recovered,
            reclassifiedRequirements: reclassified,
            downgrades: matches.filter((match) => match.downgraded).map((match) => ({ requirementId: match.requirementId, claimed: match.claimedStatus, final: match.status }))
        }
    };
}

module.exports = {
    STATUS, VERDICT, WEIGHT, STATUS_CREDIT, MAX_REQUIREMENTS,
    normalizeForMatch, isVerbatimQuote, normalizeRequirements, normalizeMatches, preferredSectionLines,
    computeAssessment, buildDeterministicReport
};
