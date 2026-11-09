'use strict';

/*
 * Structured numerical evidence.
 *
 * A figure in generated text is only allowed if it is the *same claim* the applicant's own text makes: the same exact
 * representation (79.4% is not 79%, 79.4, 0.794 or "about 80%"), the same metric type (accuracy is not ROC-AUC) and,
 * when the sentence names a project, the same project.
 *
 * Source texts are turned into structured evidence once ({ reps, metrics, projects }); generated text is then checked
 * against that evidence. Plain code, no model involved. It is still pattern matching: see "limits" at the bottom.
 */

// ---- tokens -------------------------------------------------------------------------------------------------------

const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
// Unit that is part of the figure itself. A percent sign is not decoration: 79.4% and 79.4 are different claims.
const SUFFIX = String.raw`(?:\s?(?:%|percent\b|per cent\b)|\s?(?:ms|sec(?:onds?)?)\b|\s?(?:GB|MB|KB)\b|[kK](?![\p{L}\p{N}])|M(?![\p{L}\p{N}])|[x×](?![\p{L}\p{N}]))`;
// A number not glued to a letter, digit or decimal point (so "R1", "H1B" and "v3.11" yield no token).
const NUMBER = new RegExp(String.raw`(?<![\p{L}\p{N}.,])(${NUM})(${SUFFIX})?`, 'giu');
const TIME_UNIT = /^\s*(?:-|–|to\s+\d+(?:\.\d+)?\s*)?\s*(?:hours?|hrs?|weeks?|days?|months?|minutes?|mins?|years?|yrs?)\b/i;

const isYear = (digits) => /^\d{4}$/.test(digits) && Number(digits) >= 1900 && Number(digits) <= 2100;

function canonicalSuffix(suffix) {
    if (!suffix) return '';
    const text = suffix.trim();
    if (/^(?:%|percent|per cent)$/i.test(text)) return '%';
    if (/^sec/i.test(text)) return 'sec';
    if (text === '×' || /^x$/i.test(text)) return 'x';
    if (text === 'M') return 'M';
    return text.toLowerCase();
}

/** Canonical representation: digits without thousands commas, plus the unit. "79.4 percent" and "79.4%" are one thing. */
function representation(match) {
    return `${match[1].replace(/,/g, '')}${canonicalSuffix(match[2])}`;
}

// ---- metric types -------------------------------------------------------------------------------------------------

const LABEL = /(?<![\p{L}\p{N}])(accuracy|acc|precision|recall|f1(?:[- ]?score)?|f[- ]?score|(?:roc[- ]?)?auc|rmse|mae|mse|mape|r2|r²|r[- ]squared|log[- ]?loss|loss|error rate|c?gpa|sgpa)(?![\p{L}\p{N}])/giu;

function metricType(label) {
    const key = label.toLowerCase().replace(/[^a-z0-9²]/g, '');
    if (key === 'accuracy' || key === 'acc') return 'accuracy';
    if (key.endsWith('auc')) return 'auc';
    if (key.startsWith('f1') || key === 'fscore') return 'f1';
    if (key === 'r2' || key === 'r²' || key === 'rsquared') return 'r2';
    if (key === 'logloss' || key === 'loss') return 'loss';
    if (key === 'errorrate') return 'errorrate';
    if (key.endsWith('gpa')) return 'gpa';
    return key; // precision, recall, rmse, mae, mse, mape
}

// Words that end the stretch of text a label can be bound across.
const CLAUSE_BREAK = /[,;\n]|[.!?](?=\s|$)|\s(?:and|but|while|whereas|with|plus|versus|vs\.?)\s/gi;

function lastBreakEnd(text) {
    let end = 0;
    for (const match of text.matchAll(CLAUSE_BREAK)) end = match.index + match[0].length;
    return end;
}
function firstBreakStart(text) {
    const match = new RegExp(CLAUSE_BREAK.source, 'i').exec(text);
    return match ? match.index : text.length;
}

/** Every number in `text` with its representation and, if one sits next to it, its metric label. */
function scan(text) {
    const value = String(text ?? '');
    const tokens = [...value.matchAll(NUMBER)].map((match) => ({
        raw: match[0].trim(),
        rep: representation(match),
        digits: match[1].replace(/,/g, ''),
        hasUnit: Boolean(match[2]),
        start: match.index,
        end: match.index + match[0].length,
        type: null,
        label: null
    }));
    tokens.forEach((token, index) => {
        // A label is searched for only between this number and its neighbours, inside one clause.
        const floor = index > 0 ? tokens[index - 1].end : 0;
        const ceiling = index + 1 < tokens.length ? tokens[index + 1].start : value.length;
        let before = value.slice(Math.max(floor, token.start - 40), token.start);
        before = before.slice(lastBreakEnd(before));
        let after = value.slice(token.end, Math.min(ceiling, token.end + 30));
        after = after.slice(0, firstBreakStart(after));
        let best = null;
        for (const match of before.matchAll(LABEL)) {
            const distance = before.length - (match.index + match[0].length);
            if (!best || distance <= best.distance) best = { label: match[1], distance };
        }
        for (const match of after.matchAll(LABEL)) {
            if (!best || match.index < best.distance) best = { label: match[1], distance: match.index };
        }
        if (best) { token.label = best.label; token.type = metricType(best.label); }
    });
    return tokens;
}

// ---- projects -----------------------------------------------------------------------------------------------------

const CAP = String.raw`[A-Z][\w&+/'-]*`;
const GENERIC_HEADINGS = /^(?:projects?|skills?|technical skills|education|experience|work experience|summary|profile|objective|certifications?|achievements?|awards?|interests|languages|publications|contact|extracurriculars?|activities|leadership|research|positions of responsibility)$/i;

// A project's block: its own line, then following blank, indented or bulleted lines. A new unbulleted line ends it, so a
// title in a format we do not recognise leaves its metrics unbound instead of inheriting the previous project.
const VERB_LED = /^(?:\w+ed|built|made|led|won|wrote|ran|taught|began|drove|grew)\b/i;
const CONTINUATION = /^\s*(?:$|[-*•▪◦]|\d+[.)]\s|\s)/;

/**
 * Where each project's section begins: "Churn Prediction project:", a heading line, or a "Title Case Name" line followed by
 * ":", "—", "–", " - ", "|" or "(" (covers "Name — metrics", "Name | stack", "Name (stack)", "Name | dates").
 * Each marker is { start, end, limit, name } and binds metrics from `end` to `limit`.
 */
function projectMarkers(text) {
    const value = String(text ?? '');
    const lines = [];
    let offset = 0;
    for (const line of value.split('\n')) { lines.push({ line, start: offset, end: offset + line.length }); offset += line.length + 1; }
    const blockLimit = (position, { open = false } = {}) => {
        let index = lines.findIndex((entry) => position <= entry.end);
        if (index === -1) return value.length;
        if (open) return Infinity; // markdown heading: runs to the next marker
        let limit = lines[index].end;
        while (index + 1 < lines.length && CONTINUATION.test(lines[index + 1].line)) { index += 1; limit = lines[index].end; }
        return limit;
    };
    const markers = [];
    for (const match of value.matchAll(new RegExp(String.raw`(${CAP}(?:[ \t]+${CAP}){0,4})[ \t]+project\b\s*[:–—-]`, 'g'))) {
        const end = match.index + match[0].length;
        markers.push({ start: match.index, end, limit: blockLimit(end), name: match[1] });
    }
    for (const { line, start } of lines) {
        const body = line.replace(/^\s*(?:[-*•▪◦]\s+|\d+[.)]\s+)?/, '').replace(/\*\*/g, '').trim();
        if (!body) continue;
        const bare = body.replace(/[:\s]+$/, '');
        const words = bare.split(/\s+/);
        let name = null;
        let length = line.length;
        let open = false;
        if (/^\s*#{1,6}\s/.test(line)) {
            name = line.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/[:\s]+$/, '');
            open = true;
        } else if (!/\d/.test(bare) && words.length <= 8 && !/[.!?,;]$/.test(bare) && words.every((word) => new RegExp(`^${CAP}$`).test(word))) {
            name = bare;
        } else {
            const titled = new RegExp(String.raw`^\s*(?:[-*•▪◦]\s+)?\**(${CAP}(?:[ \t]+${CAP}){1,5})\**\s*(?::|—|–|\s-\s|\||\()\s*\S`).exec(line);
            // A bullet fragment such as "Improved Model Accuracy: 79.4%" or "Built Churn Predictor" is a sentence, not a title.
            if (titled && !/\d/.test(titled[1]) && !VERB_LED.test(titled[1]) && !new RegExp(LABEL.source, 'iu').test(titled[1])) {
                name = titled[1];
                length = line.indexOf(titled[1]) + titled[1].length;
            }
        }
        if (name === null) continue;
        const end = start + length;
        markers.push({ start, end, limit: blockLimit(end, { open }), name: GENERIC_HEADINGS.test(name) ? null : name });
    }
    return markers.sort((a, b) => a.start - b.start);
}

function projectAt(markers, position) {
    let current = null;
    for (const marker of markers) {
        if (marker.end > position) break;
        current = position <= marker.limit ? marker.name : null;
    }
    return current;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- evidence -----------------------------------------------------------------------------------------------------

/**
 * Structured evidence from one text, or several (e.g. [profile, opportunity]); each is read on its own so a heading in
 * one cannot assign projects in another.
 * Returns { reps: Set, metrics: [{ rep, raw, type, label, project }], projects: [name] }.
 */
function buildEvidence(sources) {
    const texts = (Array.isArray(sources) ? sources : [sources]).map((text) => String(text ?? ''));
    const evidence = { reps: new Set(), metrics: [], projects: [] };
    for (const text of texts) {
        const markers = projectMarkers(text);
        for (const marker of markers) {
            if (marker.name && !evidence.projects.some((name) => name.toLowerCase() === marker.name.toLowerCase())) evidence.projects.push(marker.name);
        }
        for (const token of scan(text)) {
            evidence.reps.add(token.rep);
            const scale = token.type === 'gpa' ? /^\s?\/\s?(10|4(?:\.0+)?|5|100)\b/.exec(text.slice(token.end)) : null;
            evidence.metrics.push({
                rep: token.rep,
                raw: scale ? `${token.raw}${scale[0].replace(/\s/g, '')}` : token.raw,
                type: token.type,
                label: token.label,
                project: token.type === 'gpa' ? null : projectAt(markers, token.start) // a grade is the person's, not a project's
            });
        }
    }
    return evidence;
}

/** Back-compatible name: the evidence object doubles as the "source keys" argument of unsupportedFigures(). */
const figureKeys = buildEvidence;

// ---- checking generated text --------------------------------------------------------------------------------------

function sentenceAround(text, start, end) {
    const before = text.slice(0, start);
    const from = Math.max(before.lastIndexOf('\n'), ...[...before.matchAll(/[.!?]\s/g)].map((match) => match.index + 1)) + 1;
    const rest = text.slice(end);
    const stop = rest.search(/[.!?](?:\s|$)|\n/);
    return { from, to: stop === -1 ? text.length : end + stop + 1 };
}

/** The project this number is attributed to: the nearest named project before it in its sentence, else the nearest after. */
function claimedProject(text, token, projects) {
    if (!projects.length) return undefined;
    const { from, to } = sentenceAround(text, token.start, token.end);
    let before = null;
    let after = null;
    for (const name of projects) {
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu');
        for (const match of text.slice(from, to).matchAll(pattern)) {
            const at = from + match.index;
            if (at + match[0].length <= token.start) { if (!before || at > before.at) before = { name, at }; }
            else if (!after || at < after.at) after = { name, at };
        }
    }
    return (before ?? after)?.name;
}

/**
 * Figures in `text` that the evidence does not support. Checked: every percentage, decimal, number with a unit, number of
 * 100 or more (years and durations such as "2 hours" excepted), and any number sitting next to a metric label. A figure
 * is unsupported when
 *   - its exact representation is absent from the source (rounding, truncation, extra decimals, a dropped % sign,
 *     a changed unit, an invented value), or
 *   - it is attached to a metric type the source does not give that value for (ROC-AUC 0.77 -> accuracy 0.77), or
 *   - it is attached to a project the source does not give that value for.
 * Small unlabelled whole numbers ("week 2", "5 questions") are ordinary writing and are not checked.
 */
function unsupportedFigures(text, evidence) {
    const source = evidence?.reps instanceof Set ? evidence : buildEvidence('');
    const value = String(text ?? '');
    const found = [];
    for (const token of scan(value)) {
        const strict = token.hasUnit || token.digits.includes('.') || (Number(token.digits) >= 100 && !isYear(token.digits));
        if (!token.type && !strict) continue;
        if (!token.hasUnit && TIME_UNIT.test(value.slice(token.end))) continue;
        if (!source.reps.has(token.rep)) { found.push(token.raw); continue; }
        const project = claimedProject(value, token, source.projects);
        const supported = source.metrics.some((metric) => metric.rep === token.rep
            && (!token.type || metric.type === token.type)
            && (project === undefined || (metric.project && metric.project.toLowerCase() === project.toLowerCase())));
        if (!supported) found.push(token.raw);
    }
    return found;
}

// ---- rendering from source ----------------------------------------------------------------------------------------

const MAX_VERIFIED_METRICS = 12;

/**
 * The labelled metrics in the applicant's profile, exactly as written ("79.4%", "0.7738", "8.83/10"), with the project each
 * belongs to when the profile structure shows it. These are shown to the user straight from the source, not from the model.
 */
function verifiedMetrics(profileText) {
    const seen = new Set();
    const out = [];
    for (const metric of buildEvidence(profileText).metrics) {
        if (!metric.type || /^(?:19|20)\d\d$/.test(metric.rep)) continue;
        const key = `${metric.project}|${metric.type}|${metric.rep}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label: metric.label, value: metric.raw, project: metric.project });
        if (out.length >= MAX_VERIFIED_METRICS) break;
    }
    return out;
}

/*
 * Limits (heuristic, not understanding):
 *  - Metric labels are a finite list (accuracy, precision, recall, F1, AUC, RMSE, MAE, MSE, MAPE, R2, loss, error rate,
 *    GPA). A number beside any other label is checked by representation (and project) but not by type.
 *  - A project is recognised from "<Title Case Name> project:", a heading line, or a "Title Case Name: ..." line. Profiles
 *    written as plain prose get type and representation protection but no project binding.
 *  - A project's metrics are those on its own line and the bulleted/indented lines under it. A title in a format we do not
 *    recognise ends up unbound (fail-open) rather than inheriting the previous project; titles written in lower case, or a
 *    single word with a stack/date suffix, are such cases. Under a markdown # heading, plain prose lines also count.
 *  - A sentence that names several projects attributes each number to the nearest preceding project name.
 *  - A source number with no label is never accepted under a label the source did not give it.
 */

module.exports = { buildEvidence, figureKeys, unsupportedFigures, verifiedMetrics, scan, projectMarkers, metricType };
