'use strict';

/*
 * On-demand narrative sections. The verdict is computed first (api/analyze.js); everything
 * here is optional writing generated afterwards, one section per request.
 */

const { STATUS, VERDICT, MAX_REQUIREMENTS } = require('./eligibility');
const {
    createInsightsPrompt, createCoverLetterPrompt, createInterviewPrompt, insightsSchema
} = require('./prompts');

const MAX_REQUIREMENT_TEXT = 300;
const MAX_COVER_LETTER_LENGTH = 6000;
const MAX_INTERVIEW_QUESTIONS = 10;
const VERDICTS = new Set(Object.values(VERDICT));
const STATUSES = new Set(Object.values(STATUS));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const SECTIONS = Object.freeze({
    insights: {
        prompt: createInsightsPrompt,
        user: 'Write the analysis sections and output JSON.',
        keys: Object.keys(insightsSchema.properties),
        valid: (data) => Object.keys(data).length > 0
    },
    coverLetter: {
        prompt: createCoverLetterPrompt,
        user: 'Write the cover letter and output JSON.',
        keys: ['coverLetter'],
        valid: (data) => typeof data.coverLetter === 'string' && data.coverLetter.trim().length >= 50
    },
    interview: {
        prompt: createInterviewPrompt,
        user: 'Write the interview preparation and output JSON.',
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

module.exports = { SECTIONS, validateAssessment, sanitizeSection };
