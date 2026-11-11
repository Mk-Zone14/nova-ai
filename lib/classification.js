'use strict';

/*
 * Hard-requirement classification backstop (F2).
 *
 * `hardEligibility` is proposed by the extraction model (lib/prompts.js). A hard requirement is a pass/fail gate about
 * who the applicant IS or their status: age, citizenship or location, work authorization, enrolment, degree level or
 * year, graduation window, minimum grade, a natural language, availability. A "Missing" on one with a verified
 * contradicting quote makes the verdict "Not eligible", so a skill, proficiency level, amount of experience or number of
 * completed projects must not be hard just because it sounds important, is marked "required" or sits under an
 * "Eligibility" heading. Those make an applicant more competitive; they stay mandatory (still required, still visible,
 * still weighted) but are not eligibility gates.
 *
 * This module only ever DOWNGRADES a hard flag, and only when the requirement is clearly a skill / experience / project
 * criterion: it contains a capability cue or a technology name, no gate signal at all, and the posting does not itself
 * say that lacking it disqualifies the applicant. Anything mixed, unrecognised or ambiguous keeps the model's flag
 * unchanged. Nothing is ever promoted to hard here.
 *
 * The signals below are lexical and deliberately conservative. Gate signals only PROTECT a requirement from downgrade,
 * so an unrecognised gate costs nothing unless the same text also contains a capability cue.
 */

// Wording that points at a formal gate. Any match protects the requirement from downgrade.
const GATE_SIGNALS = [
    ['age', /\b(?:aged?|years?\s+old|years?\s+of\s+age|age\s+(?:limit|requirement|range|bracket|cap)|minors?|adults?|older|younger|(?:under|over|above|below)\s*-?\s*(?:1[6-9]|[2-6]\d)|(?:1[6-9]|[2-6]\d)\s*(?:\+|-|–|—|to|or\s+(?:older|above|over|younger|under|below)))\b|\b(?:1[6-9]|[2-6]\d)\s*\+/i],
    ['status-or-degree', /\b(?:enrol\w*|enroll\w*|(?:currently\s+)?(?:studying|pursuing)|students?|undergrad\w*|postgrad\w*|graduat\w*|alumn\w*|degrees?|bachelor\w*|master'?s|b\.?\s?tech|m\.?\s?tech|b\.e|m\.e|b\.?\s?sc|m\.?\s?sc|bca|mca|mba|ph\.?\s?d|doctora\w*|diploma|programmes?|programs?|universit\w*|college|school|institutions?|(?:first|second|third|fourth|fifth|final|pre-?final|\d(?:st|nd|rd|th))[\s-]years?|year\s+of\s+study|semester|batch|cohort|class\s+of|full[\s-]?time|part[\s-]?time)\b/i],
    ['citizenship-location-authorization', /\b(?:citizen\w*|nationals?|nationality|residents?|residen\w*|domicile\w*|reside\w*|based\s+in|located\s+in|living\s+in|country|countries|region|permanent\s+address|visas?|work\s+(?:authori[sz]ation|permit|eligibility)|right\s+to\s+work|(?:authori[sz]ed|permitted|eligible)\s+to\s+work|legally\s+(?:able|entitled)\s+to\s+work|(?:able|ability)\s+to\s+(?:legally\s+)?work\s+(?:in|for)|sponsorship|passports?|relocat\w*|on-?\s?site|in-?\s?person|time\s?zone)\b/i],
    ['availability-or-dates', /\b(?:availab\w*|\d+\s*(?:hours?|hrs?)\b|hours?\s*(?:\/|per|a)\s*(?:week|day)|commit(?:ment|ted)?|start\s+date|notice\s+period|duration|(?:19|20)\d{2})\b/i],
    ['minimum-grade', /\b(?:c?gpa|percentage|percent|marks|grades?|cut-?\s?off|class\s+(?:rank|standing)|academic\s+(?:standing|record|performance)|good\s+standing|merit|rank)\b|%/i],
    ['natural-language', /\b(?:english|hindi|bengali|tamil|telugu|marathi|gujarati|urdu|spanish|french|german|mandarin|chinese|japanese|korean|arabic|portuguese|russian|italian|spoken)\b/i],
    ['status-or-identity', /\b(?:gender|wom[ae]n|female|male|non-?binary|first[\s-]?gen\w*|veterans?|disabilit\w*|disabled|under-?represented|minorit\w*|income|financial\s+need|members?(?:hip)?\s+(?:of|in)|affiliat\w*|employees?|employed|previous(?:ly)?\s+(?:received|awarded|participated|attended|applied)|never\s+(?:received|been|participated)|prior\s+(?:recipient|award|participation)|nominat\w*|referr?al|endorse\w*|guardian|parental|consent|identity|id\s+(?:proof|card)|background\s+check|security\s+clearance|criminal|drug\s+test|vaccinat\w*|pregnan\w*|religio\w*|caste|categor(?:y|ies)|reserved)\b/i],
    ['formal-credential', /\b(?:certified|certificat\w*|licen[cs]\w*|accredit\w*|registered|chartered|pre-?requisites?)\b/i]
];

// Wording that marks a requirement as a skill, proficiency, experience or project criterion.
const CAPABILITY_CUES = /\b(?:proficien\w*|familiar\w*|fluen\w*|knowledge(?:able)?|understanding\s+of|experience[ds]?|expert\w*|skill(?:s|ed)?|competen\w*|comfortable\s+with|hands-?\s?on|background\s+in|command\s+of|working\s+knowledge|exposure|aptitude|fundamentals?|portfolio|github|repositor\w*|projects?|internships?|hackathons?|publications?|published|papers?|patents?|open[\s-]?source|contributions?|coursework|communication\s+skills?|team\s?work|leadership|problem[\s-]?solving)\b/i;

// Common technologies, so a bare "Required: Python" is recognised as a skill. Not exhaustive: an unlisted tool name
// without a capability cue is left to the model's flag.
const TECH_TERMS = /(?<![\w+#.])(?:python|java|javascript|typescript|c\+\+|c#|golang|rust|kotlin|swift|ruby|php|scala|matlab|sql|nosql|mysql|postgres(?:ql)?|mongodb|react(?:\.?js)?|angular|vue(?:\.?js)?|node(?:\.?js)?|django|flask|fastapi|spring\s+boot|git|github|gitlab|docker|kubernetes|aws|azure|gcp|linux|excel|tableau|power\s?bi|figma|tensorflow|pytorch|scikit-?learn|pandas|numpy|machine\s+learning|deep\s+learning|data\s+structures|algorithms?|html5?|css3?|rest(?:ful)?\s+apis?|apis?|cloud|devops|ci\/cd|nlp|computer\s+vision|data\s+analysis|data\s+science|statistics|programming|coding|software\s+(?:development|engineering)|web\s+development)(?![\w+#])/i;

// The posting itself says that lacking the item excludes the applicant. "Eligibility", "required" and "must" alone are
// NOT this: the point is explicit consequence wording. A negated form ("will not be disqualified") does not count.
const EXPLICIT_DISQUALIFIER = /\b(?:ineligible|not\s+eligible|disqualif\w*|will\s+not\s+be\s+(?:considered|accepted|admitted|eligible)|(?:cannot|can't|can\s+not)\s+be\s+(?:considered|accepted|admitted)|(?:are|is)\s+not\s+(?:considered|accepted)|will\s+be\s+(?:rejected|excluded)|automatically\s+(?:rejected|excluded)|non[-\s]?negotiable|strict(?:ly)?\s+(?:required|enforced)|hard\s+(?:requirement|cut-?\s?off|filter)|without\s+exception|no\s+exceptions?)\b/i;
const NEGATED_DISQUALIFIER = /\b(?:not|never|won't|wouldn't)\s+(?:be\s+)?(?:ineligible|disqualified|rejected|excluded)\b/gi;

const normalize = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!?;:,]+$/, '');

// The posting split into sentence-or-line units, so the sentence a requirement was quoted from can be found.
function postingUnits(text) {
    const units = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        for (const part of line.split(/(?<=[.!?;])\s+(?=[A-Z0-9"'([])/)) {
            const unit = part.trim();
            if (unit) units.push(unit);
        }
    }
    return units;
}

/** The sentence(s) the quote came from, plus the one right after. Further-away statements do not count. */
function quoteContext(sourceQuote, opportunityText) {
    const fragments = String(sourceQuote ?? '').split(/\.{3}|…/).map(normalize).filter((fragment) => fragment.length >= 3);
    if (!fragments.length) return '';
    const units = postingUnits(opportunityText);
    const hits = [];
    units.forEach((unit, index) => {
        const value = normalize(unit);
        if (value.length >= 3 && fragments.some((fragment) => value.includes(fragment) || fragment.includes(value))) hits.push(index);
    });
    if (!hits.length) return '';
    const last = hits[hits.length - 1];
    return units.slice(hits[0], Math.min(units.length, last + 2)).join(' ');
}

function hasExplicitDisqualifier(text) {
    return EXPLICIT_DISQUALIFIER.test(String(text ?? '').replace(NEGATED_DISQUALIFIER, ' '));
}

/**
 * kind: 'gate' (gate signals, no capability cue), 'capability' (capability cue, no gate signal), 'mixed' (both) or
 * 'unclear' (neither). Uses the model's short wording and its verbatim quote together, so a signal in either protects.
 */
function classifyRequirement({ requirement, sourceQuote }, opportunityText) {
    const own = `${requirement ?? ''} ${sourceQuote ?? ''}`;
    const gateSignals = GATE_SIGNALS.filter(([, pattern]) => pattern.test(own)).map(([name]) => name);
    const capability = CAPABILITY_CUES.test(own) || TECH_TERMS.test(own);
    const kind = gateSignals.length ? (capability ? 'mixed' : 'gate') : (capability ? 'capability' : 'unclear');
    return { kind, gateSignals, explicitDisqualifier: hasExplicitDisqualifier(quoteContext(sourceQuote, opportunityText)) };
}

/**
 * Why a requirement the model marked hard should not be, or null to leave it alone.
 * Only a clear skill / experience / project criterion that the posting does not itself make disqualifying is downgraded.
 */
function hardDowngradeReason(requirement, opportunityText) {
    const { kind, explicitDisqualifier } = classifyRequirement(requirement, opportunityText);
    return kind === 'capability' && !explicitDisqualifier ? 'skill-or-experience' : null;
}

module.exports = { classifyRequirement, hardDowngradeReason, hasExplicitDisqualifier, quoteContext };
