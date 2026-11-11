'use strict';

/*
 * On-demand narrative sections. The verdict is computed first (api/analyze.js); everything
 * here is optional writing generated afterwards, one section per request.
 */

const { STATUS, VERDICT, MAX_REQUIREMENTS } = require('./eligibility');
const { deriveFacts, guardSectionData } = require('./guards');
const {
    createInsightsPrompt, createCoverLetterPrompt, createInterviewPrompt, insightsSchema
} = require('./prompts');

const MAX_REQUIREMENT_TEXT = 300;
const MAX_COVER_LETTER_LENGTH = 6000;
const MAX_INTERVIEW_QUESTIONS = 10;
const INSIGHTS_MAX_COMPLETION_TOKENS = 8192;
const VERDICTS = new Set(Object.values(VERDICT));
const STATUSES = new Set(Object.values(STATUS));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const INSIGHT_LISTS = ['strengths', 'weaknesses', 'missingSkills', 'requiredDocuments', 'roadmap', 'riskAnalysis', 'learningResources', 'resumeImprovements'];
const INSIGHT_OBJECTS = ['atsReadiness', 'resumeStrength'];

const SECTIONS = Object.freeze({
    insights: {
        prompt: createInsightsPrompt,
        // The full insights object (about fifteen fields) plus the model's reasoning ran into a 3,072-token completion ceiling
        // twice in production-like use (finish=length). An explicit limit is sent so that ceiling is not left to the provider.
        maxCompletionTokens: INSIGHTS_MAX_COMPLETION_TOKENS,
        keys: Object.keys(insightsSchema.properties),
        // Every section the report renders must be present: a reply with some missing is incomplete, not a smaller answer.
        complete: (raw) => INSIGHT_LISTS.every((key) => Array.isArray(raw[key])) && INSIGHT_OBJECTS.every((key) => isPlainObject(raw[key])),
        valid: (data) => Object.keys(data).length > 0
    },
    coverLetter: {
        prompt: createCoverLetterPrompt,
        keys: ['coverLetter'],
        valid: (data) => typeof data.coverLetter === 'string' && data.coverLetter.trim().length >= 50
    },
    interview: {
        prompt: createInterviewPrompt,
        keys: ['interviewQuestions'],
        valid: (data) => Array.isArray(data.interviewQuestions) && data.interviewQuestions.length > 0
    }
});

/**
 * The client sends back the verdict and requirement statuses it received from /api/analyze.
 * They are untrusted input: re-validate the shape and bounds. (A user who edits them only
 * changes the writing generated for themselves; nothing here is stored or shared.)
 */
function validateAssessment(raw) {
    if (!isPlainObject(raw) || !VERDICTS.has(raw.verdict)) return null;
    if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > MAX_REQUIREMENTS) return null;
    const rows = [];
    for (const row of raw.rows) {
        if (!isPlainObject(row) || !STATUSES.has(row.status)) return null;
        const requirement = typeof row.requirement === 'string' ? row.requirement.replace(/\s+/g, ' ').trim() : '';
        if (!requirement || requirement.length > MAX_REQUIREMENT_TEXT) return null;
        rows.push({
            requirement,
            status: row.status,
            hardEligibility: row.hardEligibility === true,
            mandatory: row.mandatory === true || row.hardEligibility === true
        });
    }
    return { verdict: raw.verdict, rows };
}

/** Keep only the keys the section owns, with size and shape caps. Throws nothing; returns {} if empty. */
function sanitizeSection(section, raw) {
    const config = SECTIONS[section];
    const clean = {};
    for (const key of config.keys) {
        if (raw[key] !== undefined && raw[key] !== null) clean[key] = raw[key];
    }
    if (typeof clean.coverLetter === 'string') clean.coverLetter = clean.coverLetter.slice(0, MAX_COVER_LETTER_LENGTH);
    if (clean.interviewQuestions !== undefined) {
        clean.interviewQuestions = Array.isArray(clean.interviewQuestions)
            ? clean.interviewQuestions.filter(isPlainObject).slice(0, MAX_INTERVIEW_QUESTIONS)
            : [];
    }
    return clean;
}

/**
 * Withholds generated text that states facts the applicant's own texts do not support: figures that are not in the
 * profile/opportunity (rounded or reconstructed metrics), advice that a different cycle fixes a failed hard requirement,
 * and visa routes with no US context. Returns { data, removed }; `removed` lists reasons only, never content.
 */
function guardSection(data, profile, opportunity, assessment) {
    const facts = deriveFacts(profile, opportunity, assessment.rows);
    return guardSectionData(data, { sourceText: [profile, opportunity], facts });
}

module.exports = { SECTIONS, INSIGHT_LISTS, INSIGHT_OBJECTS, validateAssessment, sanitizeSection, guardSection };
