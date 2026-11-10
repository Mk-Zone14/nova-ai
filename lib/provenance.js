'use strict';

/*
 * Where a claim about the opportunity came from. The model reports a claim and, for anything it calls "stated" or
 * "inferred", the text it relied on; this module checks that text against the opportunity itself, in code:
 *
 *   stated    - the opportunity says so; the quoted text was found in it
 *   inferred  - the opportunity implies it; the quoted basis was found in it
 *   suggested - Nova recommends it; the organiser has not asked for it
 *   unknown   - the opportunity does not say (deadline)
 *
 * Nothing is ever promoted: a claim whose quote cannot be found is shown as "suggested" (or dropped for a deadline). A
 * deadline is never invented and a suggestion is never presented as an employer requirement.
 */

const PROVENANCE = Object.freeze(['stated', 'inferred', 'suggested', 'unknown']);

const squash = (text) => String(text ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const STOPWORDS = new Set(['document', 'documents', 'copy', 'copies', 'with', 'from', 'your', 'the', 'and', 'for', 'form', 'proof', 'official']);

/** The quote is real (found in the opportunity, ignoring case and spacing) and is about the thing it supports. */
function quoteSupports(quote, subject, opportunity) {
    const q = squash(quote).replace(/^["'.…]+|["'.…]+$/g, '');
    if (q.length < 4 || !squash(opportunity).includes(q)) return false;
    const stems = (String(subject ?? '').toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => !STOPWORDS.has(word)).map((word) => word.slice(0, 5));
    return stems.length === 0 || stems.some((stem) => q.includes(stem));
}

/** Documents: 'stated' | 'inferred' only with a verified quote; everything else is Nova's suggestion. */
function documentProvenance(item, opportunity) {
    const claimed = String(item?.source ?? '').toLowerCase();
    if ((claimed === 'stated' || claimed === 'inferred') && quoteSupports(item?.quote, item?.document, opportunity)) return claimed;
    return 'suggested';
}

const DATE_TOKEN = new RegExp(String.raw`\b${MONTH_WORD}\b|\d+`, 'gi');
const NO_DEADLINE = /^(?:n\/?a|none|unknown|not (?:specified|stated|provided|available|mentioned)|unspecified|tbd|tba|-+)\.?$/i;

/** True only for a calendar date (month and day, or a numeric date): a bare year is not a deadline. */
function hasStatedDate(opportunity) {
    const text = String(opportunity ?? '');
    return new RegExp(String.raw`\b${MONTH_WORD}\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_WORD}\b|\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b`, 'i').test(text);
}

/** A deadline is kept only if every month and number in it appears in the opportunity; otherwise it is "unknown". */
function verifiedDeadline(deadline, opportunity) {
    const value = String(deadline ?? '').trim();
    if (!value || NO_DEADLINE.test(value) || !hasStatedDate(opportunity)) return '';
    const tokens = value.match(DATE_TOKEN) ?? [];
    if (!tokens.length) return squash(opportunity).includes(squash(value)) ? value : '';
    const text = String(opportunity);
    const present = tokens.every((token) => (/^\d+$/.test(token)
        ? new RegExp(String.raw`(?<![\d.])${token.replace(/^0+(?=\d)/, '0*')}(?!\d)`).test(text)
        : new RegExp(String.raw`\b${token.slice(0, 3)}[a-z]*\b`, 'i').test(text)));
    return present ? value : '';
}

const DEADLINE_RISK = /\b(?:deadline|due date|closes?|closing date|applications? (?:close|due)|days? (?:left|remaining)|weeks? (?:left|remaining)|approaching|imminent|time[- ]sensitive|tight timeline)\b/i;

/**
 * Applies provenance to the insights section. Returns { data, removed } where `removed` lists reasons only.
 * Other sections are returned unchanged.
 */
function applyProvenance(section, data, opportunity) {
    if (section !== 'insights') return { data, removed: [] };
    const removed = [];
    const out = { ...data };
    if (Array.isArray(out.requiredDocuments)) {
        out.requiredDocuments = out.requiredDocuments
            .filter((item) => item && typeof item === 'object' && typeof item.document === 'string' && item.document.trim())
            .map((item) => {
                const provenance = documentProvenance(item, opportunity);
                if (provenance === 'suggested' && /^(?:stated|inferred)$/i.test(String(item.source ?? ''))) removed.push('provenance: document claimed as stated/inferred without a quote found in the opportunity (shown as suggested)');
                const entry = { document: item.document.trim(), status: typeof item.status === 'string' ? item.status : '', provenance };
                if (provenance !== 'suggested') entry.evidenceQuote = String(item.quote).trim();
                return entry;
            });
    }
    if (out.opportunitySummary && typeof out.opportunitySummary === 'object' && !Array.isArray(out.opportunitySummary)) {
        const deadline = verifiedDeadline(out.opportunitySummary.deadline, opportunity);
        if (String(out.opportunitySummary.deadline ?? '').trim() && !deadline && !NO_DEADLINE.test(String(out.opportunitySummary.deadline).trim())) removed.push('provenance: deadline not found in the opportunity');
        out.opportunitySummary = { ...out.opportunitySummary, deadline, deadlineProvenance: deadline ? 'stated' : 'unknown' };
    }
    if (Array.isArray(out.riskAnalysis) && !hasStatedDate(opportunity)) {
        const kept = out.riskAnalysis.filter((item) => !(item && typeof item === 'object' && DEADLINE_RISK.test(`${item.risk ?? ''} ${item.mitigation ?? ''}`)));
        if (kept.length !== out.riskAnalysis.length) removed.push('provenance: timing risk with no deadline stated in the opportunity');
        out.riskAnalysis = kept;
    }
    return { data: out, removed };
}

module.exports = { PROVENANCE, quoteSupports, documentProvenance, hasStatedDate, verifiedDeadline, applyProvenance };
