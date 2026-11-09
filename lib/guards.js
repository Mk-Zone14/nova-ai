'use strict';

/*
 * Deterministic guards for model-written text.
 *
 * The model drafts prose (insights, cover letter, interview answers, matcher reasoning), but it must not be the source of
 * facts. Everything here is plain code over the applicant's own texts:
 *
 *   1. Figures (lib/metrics.js). Metrics are structured evidence: exact representation, metric type and project. A
 *      generated figure must be the same claim the applicant's text makes; a rounded, truncated, re-united, re-typed or
 *      re-attributed metric (79.4% -> 79%, accuracy -> ROC-AUC, Churn -> Credit Card) is removed rather than shown.
 *   2. Facts. Graduation compatibility and work-authorization context are computed from the texts, so prompts and
 *      recommendations start from verified facts instead of the model's reading of them.
 *   3. Recommendations. When a hard requirement is failed, text that claims a different cycle fixes it, and visa-route
 *      advice the profile gives no basis for, are removed. constraintNotes() supplies the deterministic replacement.
 *
 * None of this changes the verdict or score (lib/eligibility.js). It is heuristic pattern matching, not understanding:
 * a pattern that does not match fails safe by *not* asserting a fact, never by inventing one.
 */

const { figureKeys, unsupportedFigures, verifiedMetrics } = require('./metrics');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---- 1. figures: see lib/metrics.js (structured, exact-representation evidence) ----------------------------------

// ---- 2. facts -----------------------------------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH = '\\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const YEAR = '((?:19|20)\\d\\d)';

function monthNumber(name) {
    const index = MONTHS.findIndex((month) => month.toLowerCase().startsWith(name.toLowerCase().slice(0, 3)));
    return index === -1 ? null : index + 1;
}
const formatDate = ({ month, year }) => (month ? `${MONTHS[month - 1]} ${year}` : String(year));
const dateKey = ({ month, year }) => `${year}-${month ?? ''}`;

// Most specific first; a later pattern cannot claim text an earlier one already used.
const DATE_FORMATS = [
    { // 15/06/2028 or 06/15/2028: the month is only known when one side cannot be a month
        re: new RegExp(`(?<![\\d/.-])(\\d{1,2})[/.-](\\d{1,2})[/.-]${YEAR}(?!\\d)`, 'g'),
        read: (m) => {
            const first = Number(m[1]);
            const second = Number(m[2]);
            const month = first > 12 && second <= 12 ? second : second > 12 && first <= 12 ? first : null;
            return { month, year: Number(m[3]) };
        }
    },
    { re: new RegExp(`(?<![\\d/.-])${YEAR}[/-](0?[1-9]|1[0-2])(?:[/-]\\d{1,2})?(?![\\d/])`, 'g'), read: (m) => ({ month: Number(m[2]), year: Number(m[1]) }) },
    { re: new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\.?,?\\s+${YEAR}(?!\\d)`, 'gi'), read: (m) => ({ month: monthNumber(m[2]), year: Number(m[3]) }) },
    { re: new RegExp(`${MONTH}\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?${YEAR}(?!\\d)`, 'gi'), read: (m) => ({ month: monthNumber(m[1]), year: Number(m[2]) }) },
    { re: new RegExp(`(?<![\\d/.-])(0?[1-9]|1[0-2])\\s*[/.-]\\s*${YEAR}(?!\\d)`, 'g'), read: (m) => ({ month: Number(m[1]), year: Number(m[2]) }) },
    { re: new RegExp(`(?<![\\d/.])${YEAR}(?![\\d])`, 'g'), read: (m) => ({ month: null, year: Number(m[1]) }) }
];

/** Dates in `text`, in order, each { month|null, year, start, end }. A date with no month is a year only: never guessed. */
function datesIn(text) {
    const claimed = [];
    const found = [];
    for (const { re, read } of DATE_FORMATS) {
        for (const match of text.matchAll(re)) {
            const start = match.index;
            const end = start + match[0].length;
            if (claimed.some((range) => start < range.end && end > range.start)) continue;
            claimed.push({ start, end });
            found.push({ ...read(match), start, end });
        }
    }
    return found.sort((a, b) => a.start - b.start);
}

// Sentences are split after ". " but not inside "U.S.", and not on "Dec. 2027".
const normalizeAbbreviations = (text) => String(text ?? '').replace(/\bU\.S\.A?\.?(?=\s|$|[,;)])/g, 'US');
const sentencesOf = (text) => normalizeAbbreviations(text).split(/(?<![A-Za-z]{3})(?<=[.!?])\s+(?=[A-Z])|\n+/);

const GRADUATION_CUE = /graduat\w*|class of|expected (?:completion|finish)\w*|pass(?:ing)? out/gi;

/**
 * The one graduation date the profile states, or null if it states none or several different ones. Only a date next to a
 * graduation cue counts ("B.Tech 2024-2028" alone is not a graduation date); ambiguity is not guessed away.
 */
function extractGraduation(profileText) {
    const found = new Map();
    for (const sentence of sentencesOf(profileText)) {
        const dates = datesIn(sentence);
        if (!dates.length) continue;
        for (const cue of sentence.matchAll(GRADUATION_CUE)) {
            const cueEnd = cue.index + cue[0].length;
            const after = dates.find((date) => date.start >= cueEnd && date.start - cueEnd <= 60);
            const before = [...dates].reverse().find((date) => date.end <= cue.index && cue.index - date.end <= 40);
            const date = after ?? before;
            if (!date) continue;
            found.set(dateKey(date), date);
            // "May 2028 or December 2028", "2028 / 2029": alternatives joined to the first date are all candidates, so ambiguous.
            let last = date;
            for (const next of dates.filter((item) => item.start > date.start)) {
                if (!/^\s*(?:or|and|\/|,|to|until|through|–|—|-)\s*$/i.test(sentence.slice(last.end, next.start))) break;
                found.set(dateKey(next), next);
                last = next;
            }
        }
    }
    return found.size === 1 ? [...found.values()][0] : null;
}

const RANGE_JOINER = /^\s*(?:–|—|-|to|and|through|thru|until|till)\s*$/i;

/**
 * The graduation window an opportunity requires ("graduation window: December 2027 - June 2028", "graduating between
 * 12/2027 and 06/2028"), or null when none is stated or the posting states several different ones.
 */
function extractGraduationWindow(opportunityText) {
    const found = new Map();
    for (const line of normalizeAbbreviations(opportunityText).split('\n')) {
        for (const cue of line.matchAll(GRADUATION_CUE)) {
            const rest = line.slice(cue.index + cue[0].length, cue.index + cue[0].length + 140);
            const dates = datesIn(rest);
            if (dates.length < 2) continue;
            const [start, end] = dates;
            if (start.start > 60 || !RANGE_JOINER.test(rest.slice(start.end, end.start))) continue;
            found.set(`${dateKey(start)}|${dateKey(end)}`, { start: { month: start.month, year: start.year }, end: { month: end.month, year: end.year } });
        }
    }
    return found.size === 1 ? [...found.values()][0] : null;
}

/** 'within' | 'outside' | 'unknown'. A year with no month that touches a window edge is 'unknown', not a guess. */
function graduationResult(candidate, window) {
    if (!candidate || !window) return 'unknown';
    const { start, end } = window;
    if (candidate.month) {
        const at = candidate.year * 12 + candidate.month;
        const from = start.year * 12 + (start.month ?? 1);
        const to = end.year * 12 + (end.month ?? 12);
        return at >= from && at <= to ? 'within' : 'outside';
    }
    if (candidate.year < start.year || candidate.year > end.year) return 'outside';
    return candidate.year > start.year && candidate.year < end.year ? 'within' : 'unknown';
}

const WORK_AUTH = /\b(?:work(?:ing)? authori[sz]ation|authori[sz]ed to work|right to work|(?:eligible|able|legally (?:able|authori[sz]ed)) to work|work permit|work visa|visa|sponsorship|citizenship|citizen|permanent resident)\b/i;

const US = '(?:US|USA|United States)';
// Stated, present-tense US study or student status. Deliberately narrow: when unsure, no visa route is suggested.
const US_STUDY_OR_STATUS = new RegExp(String.raw`\b(?:F-?1|J-?1)\b|\b(?:OPT|CPT|STEM[- ]OPT)\b|\b(?:study|studying|studied|enrol+ed|student|pursuing)\b[^.\n]{0,60}\b(?:in the ${US}|at an? (?:${US}|American) (?:university|college))|\b(?:${US}|American) (?:university|college)\b`, 'i');
// Stated US work authorization (not merely a wish for one).
const US_WORK_AUTHORIZATION = new RegExp(String.raw`\b(?:authori[sz]ed|eligible|permitted|legally (?:able|allowed|authori[sz]ed)|able) to work in the ${US}\b|\b${US} work authori[sz]ation\b|\b${US} citizen\b|\bAmerican citizen\b|\bcitizen of the ${US}\b|\bgreen card\b|\bpermanent resident of the ${US}\b|\bH-?1B (?:holder|status)\b|\bEAD\b`, 'i');
// A sentence like these states a wish, plan, need or absence, not a status.
const NOT_A_STATEMENT = /\b(?:not|no|never|without|lack(?:s|ing)?|need(?:s|ed)?|require[sd]?|seek(?:ing)?|hop(?:e|ing)|plan(?:s|ning)?|want(?:s)?|wish(?:es)?|aspir\w+|would like|open to|relocat\w+|intend\w*|if|whether|unsure|unclear)\b|n't\b|\bapply(?:ing)?\s+(?:for|to)\b/i;

const ROUTE_TOKEN = '(?:CPT|OPT|STEM[- ]OPT|F-?1|J-?1|H-?1B|cap[- ]gap|(?:curricular|optional) practical training)';
const VISA_ROUTE = new RegExp(`\\b${ROUTE_TOKEN}\\b`, 'i');
const routeKey = (route) => route.toUpperCase().replace(/[- ]/g, '');
// Telling the applicant they are eligible for a route is a visa-eligibility claim Nova cannot make from a profile. Advice to
// go and check ("confirm whether you are eligible for OPT") is not that claim.
const ROUTE_ELIGIBILITY = new RegExp(String.raw`\b(?:you|you're|your)\b[^.\n]{0,50}\b(?:eligible|qualify|qualifies|qualified|entitled|authori[sz]ed|permitted|allowed)\b[^.\n]{0,60}\b${ROUTE_TOKEN}\b|\b(?:is|are|be|become|becomes)\s+eligible\b[^.\n]{0,40}\b${ROUTE_TOKEN}\b|\b(?:you|your)\b[^.\n]{0,30}\b(?:can use|can get|can apply for|will get)\b[^.\n]{0,20}\b${ROUTE_TOKEN}\b|\b${ROUTE_TOKEN}\b[^.\n]{0,40}\b(?:will|would) (?:let|allow|cover)\b`, 'i');
const ROUTE_HEDGE = /\b(?:whether|if|check|confirm|verify|ask|find out|see if|determine)\b/i;
function assertsRouteEligibility(text) {
    const match = ROUTE_ELIGIBILITY.exec(text);
    return Boolean(match) && !ROUTE_HEDGE.test(text.slice(Math.max(0, match.index - 60), match.index + 12));
}

// Advice that a different cycle/year/intake is the way round a failed requirement.
const CYCLE_WORDS = '(?:cycle|intake|cohort|round|session|season|batch|edition|programme|program|year|term|call|posting|opening|opportunity)';
const CYCLE_SHIFT = new RegExp([
    String.raw`\b(?:next|following|upcoming|future|later|another|different|subsequent|coming)\s+(?:year'?s?\s+)?(?:application\s+)?${CYCLE_WORDS}\b`,
    String.raw`\bre-?appl(?:y|ying|ication)\b`,
    String.raw`\bapply\s+(?:again|next|later)\b`,
    String.raw`\b(?:wait|waiting|hold(?:ing)? off|defer(?:ring)?|postpon\w+|delay(?:ing)?|revisit(?:ing)?|come back)\b[^.\n]{0,50}\b(?:appl\w+|until|next|later|following|graduat\w+|open\w*)\b`,
    String.raw`\b(?:next|following|later)\s+(?:time|time round|time around)\b`,
    String.raw`\b(?:in|for|during|at)\s+(?:the\s+)?(?:(?:summer|winter|spring|fall|autumn)\s+)?20\d\d\s+${CYCLE_WORDS}\b`,
    String.raw`\b(?:target(?:ing)?|aim(?:ing)?\s+for|apply(?:ing)?\s+(?:for|in|to)|consider(?:ing)?|pursu(?:e|ing)|look(?:ing)?\s+(?:at|for)|wait(?:ing)?\s+for|try(?:ing)?)\b[^.\n]{0,60}\b(?:(?:summer|winter|spring|fall|autumn)\s+)?20\d\d\b`,
    String.raw`\b(?:when|once|after)\b[^.\n]{0,40}\b(?:graduat\w+|window)\b[^.\n]{0,40}\b(?:appl\w+|reopen\w*|open\w*|match\w*)\b`
].join('|'), 'i');

const GRADUATION_ROW = /graduat|expected completion|class of/i;

const statedRoutes = (sentences) => {
    const routes = new Set();
    for (const sentence of sentences) for (const match of sentence.matchAll(new RegExp(VISA_ROUTE.source, 'gi'))) routes.add(routeKey(match[0]));
    return [...routes].sort();
};

/**
 * Facts computed in code from the applicant's texts and the verified requirement rows
 * ({requirement, status, hardEligibility, mandatory}).
 *
 * Work authorization is never inferred from nationality, location or degree. Only an explicit, non-hypothetical statement
 * in the profile counts ("I study in the US on an F-1", "authorized to work in the US"); a sentence with a wish, plan,
 * negation or condition does not.
 */
function deriveFacts(profileText, opportunityText, rows = []) {
    const candidate = extractGraduation(profileText);
    const window = extractGraduationWindow(opportunityText);
    const result = graduationResult(candidate, window);
    const hard = rows.filter((row) => row.hardEligibility);
    const statements = sentencesOf(profileText).filter((sentence) => !NOT_A_STATEMENT.test(sentence));
    return {
        graduation: candidate && window
            ? { candidate: formatDate(candidate), requiredWindow: `${formatDate(window.start)} to ${formatDate(window.end)}`, result }
            : null,
        workAuthorization: {
            requiredByOpportunity: WORK_AUTH.test(String(opportunityText ?? '')) || rows.some((row) => WORK_AUTH.test(row.requirement)),
            usStudyOrStatusStated: statements.some((sentence) => US_STUDY_OR_STATUS.test(sentence)),
            usWorkAuthorizationStated: statements.some((sentence) => US_WORK_AUTHORIZATION.test(sentence)),
            statedRoutes: statedRoutes(statements)
        },
        failedHardRequirements: hard.filter((row) => row.status === 'Missing').map((row) => row.requirement),
        unverifiedHardRequirements: hard.filter((row) => row.status === 'Unknown' || row.status === 'Partial Match').map((row) => row.requirement)
    };
}

/**
 * Deterministic, plain-language consequences of the verified constraints, most important first. Each note is
 * { concern, action }; they are built only from facts and requirement text, never from model prose.
 */
function constraintNotes(facts, rows = []) {
    const notes = [];
    const graduation = facts.graduation;
    const graduationMismatch = graduation?.result === 'outside';
    if (graduationMismatch) {
        notes.push({
            concern: `Graduation window mismatch: your profile states graduation in ${graduation.candidate}, but this opportunity requires graduation in the window ${graduation.requiredWindow}.`,
            action: 'Do not plan around a different application cycle: it is not guaranteed to resolve this, because later postings may use different graduation windows. Check each posting\'s stated window before applying.'
        });
    }
    for (const row of rows.filter((item) => item.hardEligibility && item.status === 'Missing')) {
        if (graduationMismatch && GRADUATION_ROW.test(row.requirement)) continue; // already covered, with the actual dates
        if (WORK_AUTH.test(row.requirement)) {
            notes.push({
                concern: `Work authorization required but not shown in your profile: ${row.requirement}`,
                action: facts.workAuthorization.usStudyOrStatusStated || facts.workAuthorization.usWorkAuthorizationStated
                    ? 'Confirm the organiser\'s work-authorization rules and whether your stated status meets them before applying. Nova cannot decide that for you.'
                    : 'Confirm the organiser\'s work-authorization rules directly. Nova has not assumed any visa route, because your profile does not state that you study in the US or hold US work authorization.'
            });
        } else {
            notes.push({
                concern: `Hard eligibility requirement not met: ${row.requirement}`,
                action: 'This is a pass/fail requirement for this opportunity, so strengthening other areas will not change the outcome. Confirm it with the organiser before spending effort on an application.'
            });
        }
    }
    for (const requirement of facts.unverifiedHardRequirements) {
        notes.push({
            concern: `Hard eligibility requirement not verified: ${requirement}`,
            action: 'Add evidence for it to your profile, or confirm it with the organiser, before applying.'
        });
    }
    return notes.slice(0, 5);
}

// ---- 3. guarding generated text -----------------------------------------------------------------------------------

const REMOVED = Symbol('removed');

/**
 * Returns a function: text -> list of reasons it must not be shown (empty when fine).
 * `sourceText` is everything the model was allowed to quote.
 */
function createTextCheck(sourceText, facts) {
    const evidence = figureKeys(sourceText);
    const blockCycleAdvice = Boolean(facts?.failedHardRequirements?.length);
    const allowVisaRoutes = Boolean(facts?.workAuthorization?.usStudyOrStatusStated);
    const stated = new Set(facts?.workAuthorization?.statedRoutes ?? []);
    return (text) => {
        const reasons = [];
        const figures = unsupportedFigures(text, evidence);
        if (figures.length) reasons.push(`figure not in source: ${figures.join(', ')}`);
        if (!allowVisaRoutes && VISA_ROUTE.test(text)) reasons.push('visa route without US context');
        if (assertsRouteEligibility(text)) {
            const mentioned = [...text.matchAll(new RegExp(VISA_ROUTE.source, 'gi'))].map((match) => routeKey(match[0]));
            if (mentioned.some((route) => !stated.has(route))) reasons.push('visa-route eligibility asserted without a stated basis');
        }
        if (blockCycleAdvice && CYCLE_SHIFT.test(text)) reasons.push('different-cycle advice despite a failed hard requirement');
        return reasons;
    };
}

function guardNode(node, check, removed) {
    if (typeof node === 'string') {
        const reasons = check(node);
        if (reasons.length) { removed.push(...reasons); return REMOVED; }
        return node;
    }
    if (Array.isArray(node)) {
        const out = [];
        for (const item of node) {
            const before = removed.length;
            const cleaned = guardNode(item, check, removed);
            if (cleaned === REMOVED) continue;
            if (isPlainObject(item) && removed.length > before) continue; // a record with one bad field is dropped whole
            out.push(cleaned);
        }
        return out;
    }
    if (isPlainObject(node)) {
        const out = {};
        for (const [key, value] of Object.entries(node)) {
            const cleaned = guardNode(value, check, removed);
            if (cleaned !== REMOVED) out[key] = cleaned;
        }
        return out;
    }
    return node;
}

/**
 * Cover letters are checked sentence by sentence, so one bad sentence does not discard the letter. Text the checks do not
 * object to is returned byte for byte; only the rejected sentences (and the space after them) are cut.
 */
function guardLetter(letter, check, removed) {
    const parts = letter.split(/(?<=[.!?])(\s+)/); // [sentence, whitespace, sentence, ...]
    let out = '';
    let cut = false;
    for (let index = 0; index < parts.length; index += 2) {
        const sentence = parts[index];
        const gap = parts[index + 1] ?? '';
        const reasons = check(sentence);
        if (reasons.length) {
            removed.push(...reasons);
            cut = true;
            if (gap.includes('\n')) out += gap; // keep a paragraph break, drop an ordinary space
            continue;
        }
        out += sentence + gap;
    }
    return cut ? out.replace(/\n{3,}/g, '\n\n').replace(/^\s+|[ \t]+$/g, '').trim() : letter;
}

/**
 * Removes whatever the checks reject from a section's data. Returns { data, removed } where `removed` lists the reasons
 * (never the text), so callers can log that something was withheld without logging user content.
 */
function guardSectionData(data, { sourceText, facts }) {
    const check = createTextCheck(sourceText, facts);
    const removed = [];
    const out = {};
    for (const [key, value] of Object.entries(data)) {
        if (key === 'coverLetter' && typeof value === 'string') { out[key] = guardLetter(value, check, removed); continue; }
        const cleaned = guardNode(value, check, removed);
        if (cleaned !== REMOVED) out[key] = cleaned;
    }
    return { data: out, removed };
}

module.exports = {
    figureKeys, unsupportedFigures, verifiedMetrics,
    extractGraduation, extractGraduationWindow, graduationResult,
    deriveFacts, constraintNotes, createTextCheck, guardSectionData,
    patterns: { WORK_AUTH, US_STUDY_OR_STATUS, US_WORK_AUTHORIZATION, VISA_ROUTE, ROUTE_ELIGIBILITY, CYCLE_SHIFT }
};
