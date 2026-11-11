'use strict';

/*
 * Claim grounding for generated text about the candidate (F3).
 *
 * The figure guard (lib/guards.js) keeps numbers honest; this module keeps the words honest. Resume suggestions,
 * strengths, resume highlights and the profile summary are written by the model, and in production they upgraded what
 * the profile said: "helped organise" became "co-organised ... fostering collaboration", "used by 40 classmates" became
 * "adopted by 40 classmates ... for continuous availability", and a profile that says "No experience with cloud platforms
 * or Docker" produced "actively learning AWS cloud services and Docker containerisation".
 *
 * Three checks, all against the applicant's own profile text:
 *   1. claim words  - ownership, outcome, adoption, proficiency and experience words must themselves appear in the
 *                     profile, and in a clause that is not negated ("No experience with ..." does not support
 *                     "experience with ..."). A skill in a skills list is a listed skill, not proficiency.
 *   2. contradictions - a thing the profile says the candidate lacks ("No prior internship", "no experience with cloud
 *                     platforms or Docker") may not be claimed affirmatively anywhere in the guarded fields.
 *   3. traceability - a strength, highlight or profile-summary item must be made of words that are in the profile (for
 *                     strengths and highlights, the opportunity text too, since they compare the two); a resume
 *                     suggestion may reword, but any proper noun, technology or hyphenated term it adds must be in the
 *                     profile or in the bullet being rewritten, and the bullet being rewritten must be a verbatim quote.
 *
 * Anything that fails is withheld, never repaired. Empty lists are acceptable; invented qualifications are not. The
 * checks are lexical: they cannot judge meaning, so they sometimes withhold text that was fine.
 *
 * Scope of a negation. "No experience with Docker" blocks Docker; it must not block the rest of the profile. A negated
 * clause therefore ends at a contrast ("... but proficient in SQL") or at a new predicate ("... and have built three
 * apps"), a word the profile also uses affirmatively ("SQL (basic queries and joins)" next to "Have not used Excel
 * beyond basics") is not treated as lacking, and level words ("basic", "beyond", "advanced") describe how much of a skill
 * the candidate has rather than naming a skill, so they are never blocked on their own.
 */

const { isVerbatimQuote } = require('./eligibility');

const CLAIM_WORDS = new Set([
    // ownership / role
    'led', 'lead', 'leads', 'leading', 'spearheaded', 'owned', 'owns', 'owning', 'drove', 'drive', 'driving', 'directed',
    'managed', 'manages', 'managing', 'founded', 'co-founded', 'cofounded', 'co-founder', 'co-organised', 'co-organized',
    'coorganised', 'coorganized', 'co-led', 'co-authored', 'headed', 'architected', 'orchestrated', 'oversaw', 'overseeing',
    'supervised', 'mentored', 'championed', 'pioneered', 'initiated', 'established', 'coordinated', 'coordinating',
    // outcomes
    'improved', 'improving', 'increased', 'increasing', 'reduced', 'reducing', 'boosted', 'optimised', 'optimized',
    'accelerated', 'achieved', 'achieving', 'delivered', 'delivering', 'scaled', 'scaling', 'grew', 'growing', 'enhanced',
    'streamlined', 'resulting', 'fostering', 'fostered', 'enabling', 'enabled', 'ensuring', 'ensured', 'demonstrating',
    'demonstrated', 'demonstrates', 'maximised', 'maximized', 'minimised', 'minimized', 'generated', 'saved', 'exceeded',
    'transformed', 'impact', 'impactful', 'measurable', 'successfully', 'effectively',
    // adoption / usage
    'adopted', 'adoption', 'launched', 'rolled', 'users', 'customers', 'clients', 'serving', 'served', 'production',
    'production-ready', 'availability', 'uptime', 'traffic', 'downloads', 'stakeholders', 'deployed', 'deploying',
    // proficiency / experience
    'proficient', 'proficiency', 'expert', 'expertise', 'advanced', 'skilled', 'mastery', 'mastered', 'fluent',
    'well-versed', 'hands-on', 'extensive', 'experienced', 'experience', 'seasoned', 'deep', 'solid', 'actively',
    'learning', 'eager', 'familiar', 'familiarity', 'competent', 'specialised', 'specialized', 'versed', 'adept',
    'teamwork', 'leadership', 'collaboration', 'collaborative', 'ownership'
]);

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'over', 'your', 'their', 'our',
    'are', 'was', 'were', 'has', 'have', 'had', 'but', 'not', 'any', 'all', 'one', 'two', 'three', 'four', 'five', 'who', 'which',
    'while', 'where', 'when', 'than', 'then', 'also', 'via', 'per', 'using', 'use', 'used', 'based', 'such', 'these', 'those',
    'through', 'across', 'within', 'without', 'under', 'upon', 'about', 'after', 'before', 'during', 'both', 'each', 'other',
    'including', 'included', 'includes', 'currently', 'current', 'listed', 'lists', 'stated', 'states', 'mentioned', 'mentions',
    'shows', 'meets', 'matches', 'match', 'matching', 'required', 'requirement', 'requirements', 'window', 'expected',
    'relevant', 'clear', 'clearly', 'good', 'well', 'strong', 'record', 'academic', 'background', 'skills', 'skill',
    'project', 'projects', 'programme', 'program', 'degree', 'student', 'candidate', 'profile', 'resume', 'section',
    'summary', 'objective', 'role', 'position', 'opportunity', 'performance', 'metrics', 'metric', 'application', 'applying', 'seeking',
    'wants', 'want', 'interest', 'interested', 'enrolled', 'graduation', 'graduating', 'completed', 'complete',
    'built', 'build', 'building', 'developed', 'develop', 'developing', 'created', 'create', 'wrote', 'written', 'worked',
    'work', 'working', 'member', 'helped', 'help', 'web', 'app', 'application', 'software', 'engineering', 'engineer',
    'computer', 'science', 'university', 'college', 'institute', 'india', 'indian',
    // Neutral vocabulary: names an activity or a way of presenting a figure, asserts nothing about the applicant that could be
    // invented. (Figures themselves are checked by lib/guards.js; ownership and outcome words by CLAIM_WORDS.)
    'development', 'quantified', 'quantifying', 'quantify']);

// Words that say how much of a skill someone has, not which skill. "Have not used Excel beyond basics" lacks Excel at depth;
// it says nothing about SQL, and must not make "SQL (basic queries and joins)" a contradiction.
const LEVEL_WORDS = new Set(['basic', 'basics', 'beyond', 'fundamental', 'fundamentals', 'introductory', 'intro', 'beginner',
    'elementary', 'rudimentary', 'intermediate', 'advanced', 'entry', 'level', 'levels', 'depth', 'extent']);

// Where a negated clause stops: a contrast ("No Docker but proficient in SQL") or a new predicate ("No Docker and have built three apps").
const CLAUSE_BREAK = String.raw`\s+(?:(?:but|however|although|though|whereas|while|except|instead|despite)\b|and\s+(?:i|we|have|has|had|am|is|are|was|were|did|do|does|can|could|will|would|currently|now|also|completed|built|developed|worked|learned|learnt|studied)\b)`;
// A clause that says the candidate lacks something. The captured phrase lists what is lacking.
const NEGATED = new RegExp(String.raw`\b(?:no|not|never|without|lack(?:s|ing)?|haven't|hasn't|don't|doesn't|didn't|zero|yet\s+to|limited)\b\s+(?:(?:any|prior|formal|professional|hands-on|real|real-world|much|previous|direct|industry|production)\s+)*(?:(?:experience|exposure|background|familiarity|knowledge|history|training|work|projects?|used|worked|learned|learnt|studied|tried|done|had|completed|familiar)\s*)?(?:(?:with|in|of|using|on|to)\b)?\s*((?:(?!${CLAUSE_BREAK})(?:[^.;:!?,\n]|,(?!\s*(?:but|however|yet|though|although|while)\b)))*)`, 'gi');

const squash = (text) => String(text ?? '').normalize('NFKC').replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();

/** Lower-case word tokens; internal . - / % kept so "node.js", "scikit-learn" and "8.4/10" stay whole. */
function tokens(text) {
    return squash(text).toLowerCase().split(/\s+/)
        .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, ''))
        .filter((token) => token && /[\p{L}\p{N}]/u.test(token));
}
// Light stemming so "internships" ~ "internship" and "learning" ~ "learn" without prefix collisions.
function stem(token) {
    for (const suffix of ['ing', 'ed', 'es', 's']) {
        if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
    }
    return token;
}
const stems = (text) => new Set(tokens(text).map(stem));

/** Clauses in the profile that state an absence, and the terms inside them. */
function negatedPhrases(text) {
    const phrases = [];
    for (const match of squash(text).matchAll(NEGATED)) phrases.push(match[0]);
    return phrases;
}
function blockedTerms(profile) {
    const blocked = new Set();
    const positive = positiveStems(profile);
    for (const match of squash(profile).matchAll(NEGATED)) {
        for (const part of match[1].split(/,|\/|\bor\b|\band\b|\bnor\b/i)) {
            for (const token of tokens(part)) {
                if (token.length < 3 || STOPWORDS.has(token) || GENERIC_LACK.has(token) || LEVEL_WORDS.has(token)) continue;
                // The profile uses this word affirmatively somewhere else, so one negated clause does not make it a lack.
                if (positive.has(stem(token))) continue;
                blocked.add(stem(token));
            }
        }
    }
    return blocked;
}
const GENERIC_LACK = new Set(['platform', 'platforms', 'tools', 'tool', 'technologies', 'technology', 'frameworks', 'framework', 'services', 'service', 'systems', 'system', 'environments', 'environment', 'languages', 'language', 'yet', 'far', 'still']);

/**
 * Words of the profile that may support a claim: every token, minus the ones that only appear inside a negated clause.
 * "No experience with cloud platforms or Docker" therefore does not make "experience" available.
 */
function supportStems(profile) {
    const all = stems(profile);
    const negatedOnly = new Set();
    for (const phrase of negatedPhrases(profile)) for (const token of tokens(phrase)) negatedOnly.add(stem(token));
    const positive = positiveStems(profile);
    for (const item of negatedOnly) if (!positive.has(item)) all.delete(item);
    return all;
}

/** Stems of the profile with every negated clause removed: what it says the candidate does have. */
function positiveStems(profile) {
    let positive = squash(profile);
    for (const phrase of negatedPhrases(profile)) positive = positive.replace(phrase, ' ');
    return stems(positive);
}

/**
 * Spelling and inflection variants of one word compare equal for the traceability check only: "organise", "organised",
 * "organized" and "organisation" are the profile's "helped organise". Claim words are matched on their own and are not folded,
 * so "co-organised" still needs its own support.
 */
function fold(token) {
    return token
        .replace(/is(e|es|ed|ing|ation|ations|er|ers)$/, 'iz$1')
        .replace(/(?<=.)iz(?:e|es|ed|ing|ation|ations|er|ers)$/, 'iz');
}
function traceStems(text) {
    const out = new Set();
    for (const token of tokens(text)) { out.add(stem(token)); out.add(fold(token)); }
    return out;
}

// Returns [{ reason, token }] where token is the single generated word that tripped the check; the first word per reason.
function analyseDetailed(text, { support, blocked, traceable }) {
    const found = new Map();
    const hit = (reason, token) => { if (!found.has(reason)) found.set(reason, token); };
    const words = tokens(text);
    const negatedHere = new Set();
    for (const phrase of negatedPhrases(text)) for (const token of tokens(phrase)) negatedHere.add(stem(token));
    for (const word of words) {
        const base = stem(word);
        if ((CLAIM_WORDS.has(word) || CLAIM_WORDS.has(base)) && !negatedHere.has(base)) {
            if (!support.has(base) && !support.has(word)) hit('claim: unsupported claim word', word);
        }
        if (blocked.has(base) && !negatedHere.has(base)) hit('claim: contradicts profile', word);
    }
    if (traceable) {
        // "React/Node.js" and "2027-June" are traceable when each part is; "scikit-learn" is traceable as a whole.
        const known = (word) => traceable.has(word) || traceable.has(stem(word)) || traceable.has(fold(word));
        for (const word of words) {
            if (word.length < 3 || STOPWORDS.has(word)) continue;
            const parts = word.split(/[-/]/).filter((part) => part.length >= 3 && !STOPWORDS.has(part));
            if (!known(word) && !(parts.length && parts.every(known))) { hit('claim: untraceable text', word); break; }
        }
    }
    return [...found].map(([reason, token]) => ({ reason, token }));
}
function analyse(text, options) {
    return analyseDetailed(text, options).map((item) => item.reason);
}

// Proper nouns, technologies and hyphenated terms a suggestion introduces must come from the profile or the bullet itself.
function novelTerms(suggested, allowed) {
    const raw = squash(suggested).split(/\s+/);
    const found = [];
    for (let index = 0; index < raw.length; index += 1) {
        const token = raw[index].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, '');
        if (!token || token.length < 3) continue;
        const sentenceStart = index === 0 || /[.!?:;]$/.test(raw[index - 1]) || /^[-–—•(]$/.test(raw[index - 1]);
        const capitalised = /^\p{Lu}/u.test(token) && !sentenceStart;
        const technical = /-/.test(token) || /\p{Ll}\p{Lu}/u.test(token) || /\.[a-z]+$/i.test(token);
        if (!capitalised && !technical) continue;
        const lower = token.toLowerCase();
        if (STOPWORDS.has(lower)) continue;
        if (!allowed.has(lower) && !allowed.has(stem(lower))) found.push(token);
    }
    return found;
}

const isString = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Applies the checks to the insights section. Returns { data, removed }; `removed` lists reasons only, never content.
 */
function guardClaims(section, data, profile, opportunity = '') {
    if (section !== 'insights' || !data || typeof data !== 'object') return { data, removed: [], diagnostics: [] };
    const support = supportStems(profile);
    const blocked = blockedTerms(profile);
    const profileStems = stems(profile);
    const comparison = traceStems(`${profile} ${opportunity}`);
    const profileTrace = traceStems(profile);
    const removed = [];
    const diagnostics = [];
    const out = { ...data };
    // Records a reason (category only, for logs) and a diagnostic (field + category + the generated token, for the applicant).
    const note = (field, reason, token) => {
        removed.push(reason);
        diagnostics.push(token ? { field, reason: reason.replace(/^claim:\s*/, ''), token } : { field, reason: reason.replace(/^claim:\s*/, '') });
    };
    const noteAll = (field, items) => { for (const item of items) note(field, item.reason, item.token); return items.length; };

    const keepStrings = (field, list, traceable) => list.filter((item) => {
        if (!isString(item)) { note(field, 'claim: not text'); return false; }
        return noteAll(field, analyseDetailed(item, { support, blocked, traceable })) === 0;
    });

    if (Array.isArray(out.strengths)) out.strengths = keepStrings('strengths', out.strengths, comparison);
    if (out.resumeStrength && typeof out.resumeStrength === 'object' && !Array.isArray(out.resumeStrength) && Array.isArray(out.resumeStrength.highlights)) {
        out.resumeStrength = { ...out.resumeStrength, highlights: keepStrings('resumeStrength.highlights', out.resumeStrength.highlights, comparison) };
    }
    if (out.profileSummary && typeof out.profileSummary === 'object' && !Array.isArray(out.profileSummary)) {
        const summary = {};
        for (const [key, value] of Object.entries(out.profileSummary)) {
            if (Array.isArray(value)) summary[key] = keepStrings(`profileSummary.${key}`, value, profileTrace);
            else if (isString(value)) {
                summary[key] = noteAll(`profileSummary.${key}`, analyseDetailed(value, { support, blocked, traceable: profileTrace })) ? '' : value;
            } else summary[key] = value;
        }
        out.profileSummary = summary;
    }
    if (Array.isArray(out.resumeImprovements)) {
        out.resumeImprovements = out.resumeImprovements.filter((item) => {
            if (!item || typeof item !== 'object' || !isString(item.current) || !isString(item.suggested)) { note('resumeImprovements', 'claim: malformed suggestion'); return false; }
            if (!isVerbatimQuote(item.current, profile)) { note('resumeImprovements', 'claim: current text not in profile'); return false; }
            const findings = analyseDetailed(item.suggested, { support, blocked, traceable: null });
            const novel = novelTerms(item.suggested, new Set([...profileStems, ...stems(item.current)]));
            if (novel.length) findings.push({ reason: 'claim: term not in profile', token: novel[0] });
            return noteAll('resumeImprovements', findings) === 0;
        });
    }
    return { data: out, removed, diagnostics };
}

module.exports = { guardClaims, blockedTerms, supportStems, novelTerms, analyse, CLAIM_WORDS };
