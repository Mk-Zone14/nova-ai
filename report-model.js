/*
 * Pure report model + markup builders (no DOM access).
 *
 * Everything here maps a model/API response to display values or HTML strings, so it can be
 * unit-tested in Node. client.js keeps the DOM wiring. All dynamic text must pass through
 * safe() before it is placed in a markup string.
 *
 * Works as a browser global (NovaReport) and as a CommonJS module for tests.
 */
(function (root) {
  'use strict';

  // Resolved lazily so load order in the browser only matters at call time.
  const linkResolver = () => (typeof require === 'function' ? require('./resource-links') : root.NovaResources);
  const safeResourceUrl = (url, provider) => linkResolver().safeResourceUrl(url, provider);

  const safe = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])
    );
  const arr = (v) => (Array.isArray(v) ? v : []);
  const notAvailable = () => 'Not available from Nova.';
  function parse(text) {
    if (!text) return {};
    return JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
  }

  function hasNumber(value) {
    // Only real numbers and non-blank numeric strings count. Number([]), Number(' ') and
    // Number(true) are 0/1, which would turn "no data" into a fabricated score.
    const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
    return numeric && Number.isFinite(Number(value));
  }
  function numberOrNull(value) {
    return hasNumber(value) ? Math.max(0, Math.min(100, Number(value))) : null;
  }

  function adaptNovaReport(data) {
    const envelope = data && typeof data === 'object' ? data : {};
    const source = typeof envelope.response === 'string'
      ? parse(envelope.response)
      : envelope.response && typeof envelope.response === 'object'
        ? envelope.response
        : envelope;
    const report = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const trace = report._evidenceTrace && typeof report._evidenceTrace === 'object' ? report._evidenceTrace : {};
    const traceRequirements = arr(trace.requirements);
    const traceMatches = arr(trace.matches);
    const uiRequirementMapping = arr(report.requirementMapping).map((item) => {
      const traceRequirement = traceRequirements.find((candidate) => candidate.requirement === item.requirement);
      const traceMatch = traceMatches.find((candidate) => candidate.requirement_id === traceRequirement?.id);
      return {
        ...item,
        reasoning: item.reasoning ?? traceMatch?.reasoning ?? null,
        confidence: item.confidence ?? traceMatch?.confidence ?? null,
        evidenceId: item.evidenceId ?? traceMatch?.evidence_id ?? null,
        mandatory: item.mandatory ?? traceRequirement?.mandatory ?? null,
        hardEligibility: item.hardEligibility ?? traceRequirement?.hardEligibility ?? null
      };
    });
    return {
      ...report,
      uiRequirementMapping,
      overallMatchScore: numberOrNull(report.overallMatchScore),
      confidenceScore: numberOrNull(report.confidenceScore),
      applicationReadiness: numberOrNull(report.applicationReadiness),
      opportunitySummary: report.opportunitySummary && typeof report.opportunitySummary === 'object' && !Array.isArray(report.opportunitySummary) ? report.opportunitySummary : null,
      profileSummary: report.profileSummary && typeof report.profileSummary === 'object' && !Array.isArray(report.profileSummary) ? report.profileSummary : null,
      requirementMapping: arr(report.requirementMapping),
      mandatoryRequirements: arr(report.mandatoryRequirements),
      preferredRequirements: arr(report.preferredRequirements),
      missingRequirements: arr(report.missingRequirements),
      missingSkills: arr(report.missingSkills),
      strengths: arr(report.strengths),
      weaknesses: arr(report.weaknesses),
      requiredDocuments: arr(report.requiredDocuments),
      roadmap: arr(report.roadmap),
      personalizedRecommendations: arr(report.personalizedRecommendations),
      riskAnalysis: arr(report.riskAnalysis),
      interviewQuestions: arr(report.interviewQuestions),
      learningResources: arr(report.learningResources).filter((item) => item && typeof item === 'object' && !Array.isArray(item)),
      resumeImprovements: arr(report.resumeImprovements),
      constraintNotes: constraintNotes(report),
      verifiedMetrics: verifiedMetrics(report)
    };
  }
  function verifiedMetricsMarkup(report) {
    const metrics = verifiedMetrics(report);
    if (!metrics.length) return '';
    return `<span class="detail-label">VERIFIED METRICS</span><p class="resource-note">Copied exactly from your profile. Nova does not rewrite these.</p>${metrics.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item.label)}: ${safe(item.value)}</strong><span class="status-met">From your profile</span></div>${item.project ? `<p>${safe(item.project)}</p>` : ''}</article>`).join('')}`;
  }
  function friendlyError(message) {
    const raw = String(message || '');
    if (/Groq|GROQ_API_KEY|API key|Environment Variables|server is not configured|not configured for AI analysis|STAGE|provider|invalid analysis/i.test(raw)) return 'Analysis is unavailable in this preview right now. Your inputs are still here—please try again later.';
    if (/failed to fetch|networkerror|network request failed|load failed/i.test(raw)) return 'Could not reach Nova. Check your connection and try again. Your inputs are still here.';
    if (/timed out/i.test(raw)) return 'The analysis took too long to finish. Your inputs are still here—please try again.';
    if (/too many/i.test(raw)) return raw;
    return raw || 'Something went wrong. Your inputs are still here—please try again.';
  }
  // Message for a failed HTTP response. Our API always sends { error: "<safe message>" }; anything else (a platform
  // timeout page, a proxy error) is described from the status code instead of surfacing "unreadable response".
  function responseErrorMessage(status, bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim().slice(0, 300);
    } catch { /* not JSON: describe by status below */ }
    if (status === 429) return 'Too many requests. Please wait a minute and try again.';
    if (status === 408 || status === 504) return 'The request took too long to finish. Please try again.';
    if (status === 413) return 'That request was too large. Shorten your text and try again.';
    if (status >= 500) return 'Nova hit a problem on its side. Please try again in a moment.';
    return 'The request could not be completed. Please try again.';
  }
  function list(items, emptyText = 'No details identified.') {
    const values = arr(items).filter(Boolean);
    return values.length ? values.map((item) => `<li>${safe(item)}</li>`).join('') : `<li class="empty">${safe(emptyText)}</li>`;
  }
  const STATUS_LABELS = {
    MET: 'Matched',
    MATCHED: 'Matched',
    COMPLETED: 'Completed',
    SATISFIED: 'Satisfied',
    PARTIAL: 'Partially matched',
    PARTIALLY_MET: 'Partially matched',
    PARTIAL_MATCH: 'Partially matched',
    MISSING: 'Not met',
    NOT_MET: 'Not met',
    UNMET: 'Not met',
    UNKNOWN: 'Not enough evidence',
    NEEDS_VERIFICATION: 'Needs verification',
    ELIGIBLE: 'Eligible',
    INELIGIBLE: 'Not eligible',
    NOT_ELIGIBLE: 'Not eligible',
    READY: 'Ready to apply',
    READY_TO_APPLY: 'Ready to apply',
    READY_AFTER_ONE_FIX: 'Ready after one fix'
  };
  function presentationText(value, fallback = 'Not available from Nova.') {
    if (value === null || value === undefined || value === '') return fallback;
    const raw = String(value);
    const key = raw.toUpperCase().replace(/[\s-]+/g, '_');
    if (STATUS_LABELS[key]) return STATUS_LABELS[key];
    const words = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().split(' ');
    return words.map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : ['to', 'and', 'of', 'with'].includes(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }
  function normalizeStatus(value) {
    const key = String(value || 'UNKNOWN').toUpperCase().replace(/[\s-]+/g, '_');
    if (key === 'MET' || key === 'MATCHED' || key === 'COMPLETED' || key === 'SATISFIED') return { key: 'met', label: 'Matched' };
    if (key === 'PARTIAL' || key === 'PARTIALLY_MET' || key === 'PARTIAL_MATCH') return { key: 'partial', label: 'Partially matched' };
    if (key === 'MISSING' || key === 'NOT_MET' || key === 'UNMET') return { key: 'missing', label: 'Not met' };
    return { key: 'unknown', label: 'Not enough evidence' };
  }
  function humanizeVerdict(value) { return presentationText(value, 'Not available from Nova.'); }
  function requirementItems(report) {
    const primary = arr(report?.uiRequirementMapping).length ? arr(report.uiRequirementMapping) : arr(report?.requirementMapping);
    const values = [...primary, ...arr(report?.mandatoryRequirements), ...arr(report?.preferredRequirements)];
    const byRequirement = new Map();
    values.forEach((item) => {
      const name = item?.requirement;
      if (!name) return;
      const key = String(name).toLowerCase();
      const current = byRequirement.get(key);
      if (!current || (!current.evidence && (item.evidence || item.note))) byRequirement.set(key, item);
    });
    return [...byRequirement.values()];
  }
  function statusCounts(report) {
    const items = requirementItems(report);
    return { total: items.length, met: items.filter((item) => normalizeStatus(item.status).key === 'met').length, items };
  }
  function firstText(values, fallback) {
    return arr(values).find((value) => String(value || '').trim()) || fallback;
  }
  // Deterministic notes computed by /api/analyze from verified constraints (failed hard requirements, graduation window,
  // work authorization). They are plain { concern, action } strings built from facts, never model prose.
  // Metrics copied from the applicant's own profile by the server. Shape-checked here; anything malformed is dropped.
  function verifiedMetrics(report) {
    return arr(report?.verifiedMetrics)
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.label === 'string' && typeof item.value === 'string'
        && item.label.length <= 40 && item.value.length <= 24 && (item.project == null || (typeof item.project === 'string' && item.project.length <= 80)))
      .slice(0, 12)
      .map((item) => ({ label: item.label, value: item.value, project: item.project ?? null }));
  }
  // Requirements match per tier (required = hard + mandatory; preferred), computed by /api/analyze. Shape-checked.
  function requirementsMatch(report) {
    const raw = report?.requirementsMatch;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const tier = (value) => (value && typeof value === 'object' && Number.isInteger(value.total) && Number.isInteger(value.matched) ? value : null);
    const required = tier(raw.required);
    const preferred = tier(raw.preferred);
    if (!required || !preferred) return null;
    return {
      required, preferred,
      fitExplanation: typeof raw.fitExplanation === 'string' ? raw.fitExplanation : '',
      evidenceExplanation: typeof raw.evidenceExplanation === 'string' ? raw.evidenceExplanation : ''
    };
  }
  function requirementsMatchText(report) {
    const match = requirementsMatch(report);
    if (!match) return null;
    const tierText = (label, tier) => (tier.total ? `${label} ${tier.matched}${tier.partial ? `+${tier.partial} partial` : ''} / ${tier.total}` : `${label} none listed`);
    return `${tierText('Required', match.required)} · ${tierText('Preferred', match.preferred)}`;
  }
  function constraintNotes(report) {
    return arr(report?.constraintNotes).filter((note) => note && typeof note.concern === 'string' && typeof note.action === 'string' && note.concern.trim() && note.action.trim());
  }
  function biggestConcern(report) {
    // A failed or unverified hard requirement outranks any skill gap: strengthening skills cannot fix it.
    const constraint = constraintNotes(report)[0];
    if (constraint) return constraint.concern;
    const gap = arr(report?.missingSkills)[0];
    if (gap?.skill) return `${gap.skill}${gap.whyItMatters ? ` — ${gap.whyItMatters}` : ''}`;
    const unknownRequirement = requirementItems(report).find((item) => normalizeStatus(item.status).key === 'unknown');
    if (unknownRequirement?.requirement) return `${unknownRequirement.requirement}${unknownRequirement.evidence ? ` — ${unknownRequirement.evidence}` : ''}`;
    const risk = arr(report?.riskAnalysis)[0];
    if (risk?.risk) return `${risk.risk}${risk.mitigation ? ` — ${risk.mitigation}` : ''}`;
    return firstText(report?.weaknesses, notAvailable());
  }
  // Where each document came from. Only "stated" and "inferred" (with a quote the server found in the opportunity) count as
  // coming from the opportunity; anything else, including saved reports from before provenance existed, is Nova's suggestion.
  function documentGroups(report) {
    const groups = { fromOpportunity: [], suggested: [] };
    for (const item of arr(report?.requiredDocuments)) {
      if (!item || typeof item !== 'object') continue;
      (item.provenance === 'stated' || item.provenance === 'inferred' ? groups.fromOpportunity : groups.suggested).push(item);
    }
    return groups;
  }
  function documentMarkup(item) {
    const label = { stated: 'Stated in the opportunity', inferred: 'Inferred from the opportunity' }[item.provenance] || 'Suggested by Nova';
    const quote = item.provenance === 'stated' || item.provenance === 'inferred' ? `<p><b>Opportunity text:</b> &ldquo;${safe(item.evidenceQuote || '')}&rdquo;</p>` : '';
    const done = /completed|ready|not[\s_-]*required/i.test(item.status || '');
    return `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item.document || 'Document')}</strong><span class="status-${done ? 'met' : 'unknown'}">${safe(presentationText(item.status, 'Not enough evidence'))}</span></div><small>${label}</small>${quote}</article>`;
  }
  // The action is an instruction to the applicant. A rewritten resume bullet is not one: real runs showed "Completed data
  // analysis course" as the next best action, which is the bullet's new text, not what to do. Resume rewrites come last and
  // are phrased as the edit to make.
  function nextBestAction(report) {
    const constraint = constraintNotes(report)[0];
    if (constraint) return constraint.action;
    const recommendation = firstText(report?.personalizedRecommendations, '');
    if (recommendation) return recommendation;
    const roadmap = firstText(arr(report?.roadmap).map((item) => item?.action), '');
    if (roadmap) return roadmap;
    const improvement = arr(report?.resumeImprovements).find((item) => item && typeof item.current === 'string' && item.current.trim() && typeof item.suggested === 'string' && item.suggested.trim());
    if (improvement) return `Update your resume: replace “${improvement.current.trim()}” with “${improvement.suggested.trim()}”.`;
    return notAvailable();
  }
  function contextCandidate(report) {
    const profile = report?.profileSummary || {};
    return { name: profile.name || 'Candidate profile', meta: [profile.degree, profile.university].filter(Boolean).join(' · ') || notAvailable() };
  }
  function detailRequirement(x) {
    const status = normalizeStatus(x.status);
    const requirementText = safe(x.requirement);
    const evidence = safe(x.evidence || x.note || notAvailable());
    const reasoning = safe(x.reasoning || notAvailable());
    const confidence = safe(presentationText(x.confidence));
    const mandatory = x.mandatory === true ? '<span class="detail-required">Required</span>' : '';
    return `<details class="detail-item"><summary class="detail-item-header"><strong>${requirementText || 'Requirement'}</strong><span class="detail-status-group">${mandatory}<span class="status-${status.key}">${safe(status.label)}</span></span></summary><p><b>Evidence:</b> ${evidence}</p><p><b>Reasoning:</b> ${reasoning}</p><small><b>Confidence:</b> ${confidence}</small></details>`;
  }
  // A learning-resource card. Accepts a resolved entry from resource-links (kind: verified | search | none) or, for older
  // callers, a model-style item, of which only the skill name is used: titles and URLs always come from the catalogue.
  function resourceMarkup(resource) {
    if (!resource || typeof resource !== 'object') return '';
    const entry = typeof resource.kind === 'string' ? resource : linkResolver().resolveResource(resource.skill);
    if (!entry) return '';
    const badge = { verified: ['status-met', 'Verified page'], search: ['status-unknown', 'Search results'], none: ['status-unknown', 'No link'] }[entry.kind] || ['status-unknown', 'No link'];
    const note = {
      verified: `A page Nova has checked, chosen for this gap. It is the page for the topic, not a homepage.`,
      search: `Nova has no checked page for this gap, so this opens ${entry.provider} search results for it. Nothing here is a verified course.`,
      none: 'No learning resource: this is gained through work or projects rather than a course.'
    }[entry.kind] || '';
    const typeEl = entry.type ? `<span class="status-unknown resource-type-badge">${safe(entry.type)}</span>` : '';
    const providerEl = entry.provider ? `<div class="resource-provider">${safe(entry.provider)}</div>` : '';
    const linkEl = entry.url
      ? `<a class="resource-open-link" href="${safe(entry.url)}" target="_blank" rel="noopener noreferrer">${entry.kind === 'verified' ? 'Open page' : 'Open search'} <i data-lucide="arrow-up-right"></i></a>`
      : '<span class="resource-no-link">No direct link</span>';
    return `<article class="resource-card" tabindex="0"><div class="resource-card-top"><span class="${badge[0]} resource-type-badge">${badge[1]}</span>${typeEl}</div><div class="resource-card-skill">${safe(entry.skill)}</div><strong class="resource-card-title">${safe(entry.title)}</strong>${providerEl}<p class="resource-note">${safe(note)}</p><div class="resource-card-footer">${linkEl}</div></article>`;
  }

  // ---- on-demand sections -------------------------------------------------------------------
  // `state` describes the background requests for a report (it is UI state, never stored):
  //   insights / coverLetter / interview : 'loading' | 'error' | undefined
  //   canGenerate                         : false when the original inputs are no longer in memory

  const INSIGHT_MODULES = new Set(['strengths', 'gaps', 'documents', 'risks', 'resources']);

  function insightsStatusMarkup(status) {
    if (status === 'error') {
      return '<article class="detail-item narrative-status-item" role="alert"><p>Nova couldn\'t prepare this analysis.</p><button class="secondary-button" type="button" data-action="retry-insights">Try again</button></article>';
    }
    if (status === 'unavailable') {
      return '<article class="detail-item narrative-status-item"><p class="empty">These details weren\'t saved with this analysis, and your original inputs aren\'t kept. Run a new analysis to generate them.</p></article>';
    }
    return '<article class="detail-item narrative-status-item" role="status"><p class="narrative-pending">Nova is still preparing this analysis. It fills in automatically in a few seconds.</p></article>';
  }

  // True when the report carries the on-demand "insights" section (or content from before the split).
  function hasInsights(report) {
    if (report?.narrativeSections?.insights === true) return true;
    return ['strengths', 'weaknesses', 'missingSkills', 'riskAnalysis', 'requiredDocuments', 'learningResources', 'roadmap']
      .some((key) => arr(report?.[key]).length > 0);
  }

  function draftSection({ title, readyHeaderExtra = '', readyHtml, hasContent, status, action, actionLabel, loadingText, errorText, hint, canGenerate }) {
    const header = (extra) => `<div class="detail-item-header"><strong>${safe(title)}</strong>${extra}</div>`;
    if (hasContent) return `<article class="detail-item">${header(readyHeaderExtra)}${readyHtml}</article>`;
    if (status === 'loading') return `<article class="detail-item" role="status">${header('')}<p class="narrative-pending">${safe(loadingText)}</p></article>`;
    if (status === 'error') return `<article class="detail-item" role="alert">${header('')}<p>${safe(errorText)}</p><button class="secondary-button" type="button" data-action="${action}">Try again</button></article>`;
    if (canGenerate === false) return `<article class="detail-item">${header('')}<p class="empty">This needs your original inputs, which aren\'t kept for saved analyses. Run a new analysis to generate it.</p></article>`;
    return `<article class="detail-item">${header('')}<p>${safe(hint)}</p><button class="secondary-button" type="button" data-action="${action}">${safe(actionLabel)}</button></article>`;
  }

  function interviewMarkup(questions) {
    return `<div class="detail-list">${questions.map((item) => `<details class="detail-item"><summary class="detail-item-header"><strong>${safe(item.question || 'Question')}</strong></summary><p><b>Why it\'s asked:</b> ${safe(item.whyAsked || notAvailable())}</p><p><b>Suggested answer:</b> ${safe(item.suggestedAnswer || notAvailable())}</p></details>`).join('')}</div>`;
  }

  function strategyMarkup(report, state = {}) {
    const requirements = statusCounts(report);
    const documents = documentGroups(report).fromOpportunity;
    const pendingDocument = documents.find((item) => !/completed|ready|not[\s_-]*required/i.test(item?.status || ''));
    const insightsPending = ['loading', 'error', 'unavailable'].includes(state.insights);
    const actions = [
      ['Should I apply?', humanizeVerdict(report?.finalVerdict || report?.eligibilityVerdict || 'Review the eligibility status before submitting.')],
      ['What to emphasize', firstText(report?.strengths, notAvailable())],
      ['What to fix first', biggestConcern(report)],
      ['What could hurt', arr(report?.riskAnalysis)[0]?.risk || firstText(report?.weaknesses, notAvailable())],
      ['Before submitting', pendingDocument?.document || nextBestAction(report)]
    ];
    const coverText = String(report?.coverLetter || '');
    const coverHtml = coverText.split(/\n+/).filter(Boolean).map((para) => `<p>${safe(para)}</p>`).join('');
    const resources = linkResolver().resolveResources(report);
    const resourcesHtml = resources.length
      ? `<div class="resources-scroller" role="list" aria-label="Learning resources">${resources.map(resourceMarkup).join('')}</div>`
      : '<span class="empty">No skill gaps to find resources for.</span>';
    const questions = arr(report?.interviewQuestions).filter((item) => item && typeof item === 'object');

    const cover = draftSection({
      title: coverText ? 'Generated cover letter' : 'Cover letter',
      readyHeaderExtra: '<button class="secondary-button" id="coverLetterCopy" type="button">Copy</button>',
      readyHtml: `<div class="cover-letter-content">${coverHtml}</div>`,
      hasContent: Boolean(coverHtml), status: state.coverLetter, action: 'generate-cover-letter', actionLabel: 'Draft cover letter',
      loadingText: 'Drafting your cover letter… this takes a few seconds.', errorText: 'Couldn\'t draft the cover letter.',
      hint: 'Written on request from your profile and this opportunity, using only facts you provided. Review and edit before sending.',
      canGenerate: state.canGenerate
    });
    const interview = draftSection({
      title: 'Interview preparation', readyHtml: interviewMarkup(questions), hasContent: questions.length > 0,
      status: state.interview, action: 'generate-interview', actionLabel: 'Prepare interview questions',
      loadingText: 'Preparing interview questions… this takes a few seconds.', errorText: 'Couldn\'t prepare the interview questions.',
      hint: 'Five likely questions with suggested answers, including ones that probe your gaps. Generated on request.',
      canGenerate: state.canGenerate
    });
    const summary = requirements.total
      ? `${requirements.met} of ${requirements.total} mapped requirements are currently matched. Use the actions below to decide how to spend your effort.`
      : 'Use the evidence and gaps below to decide how to spend your effort.';
    const insightCards = insightsPending
      ? insightsStatusMarkup(state.insights)
      : actions.map(([label, value]) => `<article class="strategy-card"><span>${safe(label)}</span><p>${safe(value)}</p></article>`).join('');
    const resourcesArticle = insightsPending ? '' : `<article class="detail-item"><div class="detail-item-header"><strong>Learning resources</strong><span class="status-unknown">${resources.length} available</span></div>${resourcesHtml}</article>`;
    return `<div class="strategy-grid"><div class="detail-summary">${safe(summary)}</div>${insightCards}${cover}${interview}${resourcesArticle}</div>`;
  }

  function baseModuleContent(module, report, state) {
    const counts = statusCounts(report);
    if (module === 'requirements') {
      const match = requirementsMatch(report);
      const matchHtml = match ? `<div class="detail-summary"><b>Requirements match:</b> ${safe(requirementsMatchText(report))}. Eligibility depends only on the hard requirements; this count covers every listed requirement.${match.fitExplanation ? `<br><b>Fit score:</b> ${safe(match.fitExplanation)}` : ''}${match.evidenceExplanation ? `<br><b>Evidence coverage:</b> ${safe(match.evidenceExplanation)}` : ''}</div>` : '';
      return { title: 'Requirements', subtitle: `${counts.met} of ${counts.total || 0} mapped requirements matched`, html: `<div class="detail-summary">Each item connects the opportunity requirement to the evidence Nova found in the supplied profile.</div>${matchHtml}<div class="detail-list">${counts.items.length ? counts.items.map(detailRequirement).join('') : '<span class="empty">No requirements were identified.</span>'}</div>` };
    }
    if (module === 'strengths') {
      const strengths = arr(report?.strengths);
      const weaknesses = arr(report?.weaknesses);
      return { title: 'Strengths & weaknesses', subtitle: `${strengths.length} strengths · ${weaknesses.length} weaknesses`, html: `<div class="detail-summary">These are the strongest signals and limitations Nova found. Use strengths as evidence and weaknesses as edit targets.</div><div class="detail-list">${verifiedMetricsMarkup(report)}<span class="detail-label">STRENGTHS</span>${strengths.length ? strengths.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item)}</strong><span class="status-partial">Nova observation</span></div><p>Written by Nova from your profile text. Check it against the requirement evidence; it is not a verified match.</p></article>`).join('') : '<span class="empty">No strengths were returned by Nova.</span>'}<span class="detail-label">WEAKNESSES</span>${weaknesses.length ? weaknesses.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item)}</strong><span class="status-partial">Needs attention</span></div><p>This limitation was returned by Nova from the supplied evidence.</p></article>`).join('') : '<span class="empty">No weaknesses were returned by Nova.</span>'}</div>` };
    }
    if (module === 'gaps') {
      const gaps = arr(report?.missingSkills);
      return { title: 'Gaps', subtitle: `${gaps.length} important gaps`, html: `<div class="detail-summary">Start with the highest-impact gap. A missing signal is not a rejection; it is a decision about what to strengthen first.</div><div class="detail-list">${gaps.length ? gaps.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item.skill || 'Missing skill')}</strong><span class="status-${String(item.priority || 'medium').toLowerCase() === 'high' ? 'missing' : 'partial'}">${safe(item.priority || 'Priority')}</span></div><p><b>Why it matters:</b> ${safe(item.whyItMatters || 'This skill appears relevant to the opportunity.')}</p><small><b>Learning time:</b> ${safe(item.learningTime || 'Not specified')} · <b>Difficulty:</b> ${safe(item.difficulty || 'Not specified')}</small></article>`).join('') : '<span class="empty">No high-priority gaps were identified.</span>'}</div>` };
    }
    if (module === 'documents') {
      const { fromOpportunity, suggested } = documentGroups(report);
      const group = (title, note, items, empty) => `<span class="detail-label">${title}</span><p class="detail-note">${note}</p>${items.length ? items.map(documentMarkup).join('') : `<span class="empty">${empty}</span>`}`;
      return {
        title: 'Documents',
        subtitle: `${fromOpportunity.length} from the opportunity · ${suggested.length} suggested`,
        html: `<div class="detail-summary">Only the first group is something the organiser asked for or implied, and each item shows the opportunity text it rests on. The second group is Nova's own suggestion: useful to prepare, but not a requirement.</div><div class="detail-list">${group('FROM THE OPPORTUNITY', 'Stated or implied by the opportunity text.', fromOpportunity, 'No documents were identified in the opportunity text.')}${group('SUGGESTED BY NOVA', 'Recommendations only. The organiser has not asked for these.', suggested, 'No extra documents suggested.')}</div>`
      };
    }
    if (module === 'risks') {
      const risks = arr(report?.riskAnalysis);
      return { title: 'Blockers', subtitle: `${risks.length} risk signal${risks.length === 1 ? '' : 's'}`, html: `<div class="detail-summary">Risk signals help you decide whether to apply now, verify something, or strengthen evidence first.</div><div class="detail-list">${risks.length ? risks.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item.risk || 'Risk signal')}</strong><span class="status-${String(item.severity || 'medium').toLowerCase() === 'high' ? 'missing' : 'partial'}">${safe(presentationText(item.severity || 'Medium'))}</span></div><p>${safe(item.mitigation || 'Review this risk before submitting.')}</p></article>`).join('') : '<span class="empty">No significant risks were identified.</span>'}</div>` };
    }
    if (module === 'strategy') {
      return { title: 'Application strategy', subtitle: 'A concise path forward', html: strategyMarkup(report, state) };
    }
    if (module === 'resources') {
      const resources = linkResolver().resolveResources(report);
      const verified = resources.filter((item) => item.kind === 'verified').length;
      return { title: 'Learning resources', subtitle: `${verified} checked page${verified === 1 ? '' : 's'} · ${resources.length - verified} other`, html: `<div class="detail-summary">One resource per skill gap. "Verified page" links go to a page Nova has checked for that topic; "Search results" links open a provider search when Nova has no checked page; nothing is generated by the model.</div>${resources.length ? `<div class="resources-scroller" role="list" aria-label="Learning resources">${resources.map(resourceMarkup).join('')}</div>` : '<span class="empty">No skill gaps to find resources for.</span>'}` };
    }
    return { title: 'Evidence', subtitle: 'Focused details from your fit brief', html: '<span class="empty">No details are available for this module.</span>' };
  }
  function moduleContent(module, report, state = {}) {
    const content = baseModuleContent(module, report, state);
    const status = state.insights;
    if (INSIGHT_MODULES.has(module) && ['loading', 'error', 'unavailable'].includes(status)) {
      const subtitle = { error: 'Could not be prepared', unavailable: 'Not saved with this analysis' }[status] || 'Still preparing…';
      return { ...content, subtitle, html: insightsStatusMarkup(status) };
    }
    return content;
  }

  // The verified verdict and requirement statuses, sent back to /api/narrative so generated
  // writing stays consistent with them. Untrusted on the server, which re-validates it.
  const CANONICAL_STATUS = { met: 'Matched', partial: 'Partial Match', missing: 'Missing', unknown: 'Unknown' };
  function buildAssessmentPayload(report) {
    const rows = requirementItems(report).slice(0, 25).map((item) => ({
      requirement: String(item.requirement).replace(/\s+/g, ' ').trim().slice(0, 300),
      status: CANONICAL_STATUS[normalizeStatus(item.status).key],
      hardEligibility: item.hardEligibility === true,
      mandatory: item.mandatory === true || item.hardEligibility === true
    }));
    return { verdict: report?.eligibilityVerdict, rows };
  }

  // Fold a generated section into the report, re-applying the same coercions as the first load.
  function mergeNarrative(report, data, section) {
    const generated = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const narrativeSections = { ...(report?.narrativeSections || {}), ...(section ? { [section]: true } : {}) };
    return adaptNovaReport({ ...report, ...generated, narrativeSections });
  }

  function buildReportText(report = {}) {
    const countsData = statusCounts(report);
    return [
      'NOVA AI — FIT BRIEF',
      '\u2015'.repeat(50),
      '',
      `Opportunity: ${report.opportunitySummary?.role || report.opportunityName || ''}`,
      `Organization: ${report.opportunitySummary?.organization || ''}`,
      `Fit score: ${numberOrNull(report.overallMatchScore) === null ? notAvailable() : `${numberOrNull(report.overallMatchScore)}/100`}`,
      `Verdict: ${humanizeVerdict(report.eligibilityVerdict || '')}`,
      `Requirements: ${countsData.met}/${countsData.total || 0} matched${requirementsMatchText(report) ? ` (${requirementsMatchText(report)})` : ''}`,
      `Evidence coverage: ${numberOrNull(report.evidenceCoverage ?? report.confidenceScore) === null ? notAvailable() : `${numberOrNull(report.evidenceCoverage ?? report.confidenceScore)}% of requirement statuses rest on a verified profile quote (not confidence in the verdict)`}`,
      `Readiness: ${report.readinessCategory || (numberOrNull(report.applicationReadiness) === null ? notAvailable() : `${numberOrNull(report.applicationReadiness)}%`)}`,
      '',
      'WHY THIS VERDICT',
      report.whyVerdict || report.finalVerdict || report.verdictReason || '',
      '',
      'TOP STRENGTHS',
      ...arr(report.strengths).map((item) => `• ${item}`),
      '',
      'KEY GAPS',
      ...arr(report.missingSkills).map((item) => `• ${item.skill} (${item.priority || 'priority'})`),
      '',
      'NEXT BEST ACTION',
      nextBestAction(report),
      '',
      'This analysis is AI-generated and should be used as a guide, not a guarantee.'
    ].join('\n');
  }

  // ---- saved history (localStorage) -----------------------------------------------------------
  // A saved report holds personal details (profile quotes, generated drafts), so entries expire. Policy: kept for
  // HISTORY_TTL_DAYS from the first save (editing an entry never extends it), at most HISTORY_MAX entries, and every
  // read of the store goes through normalizeHistory(), so expired, malformed and legacy entries are dealt with in one place.
  const HISTORY_KEY = 'ocopilot-history';
  const HISTORY_TTL_DAYS = 30;
  const HISTORY_TTL_MS = HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000;
  const HISTORY_MAX = 10;
  const HISTORY_EARLIEST = Date.UTC(2020, 0, 1); // legacy ids are Date.now() values; smaller numbers are not timestamps
  const HISTORY_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const plausibleTime = (value, now) => typeof value === 'number' && Number.isFinite(value) && value >= HISTORY_EARLIEST && value <= now + HISTORY_CLOCK_SKEW_MS;

  // Returns a clean entry, or null if it is malformed or expired. Migration policy for legacy entries (saved before
  // expiry existed, so without savedAt/expiresAt): their id WAS Date.now() at save time, so the real save time is
  // recovered from it and they expire HISTORY_TTL_DAYS after that (older ones are therefore removed on first load).
  // If the id is not a plausible timestamp the entry is kept and given a full term from now. An expiresAt that would
  // outlive the policy is clamped to it, so edited storage cannot extend retention.
  function normalizeHistoryEntry(entry, now) {
    if (!isPlainObject(entry) || !isPlainObject(entry.report)) return null;
    const id = typeof entry.id === 'number' && Number.isFinite(entry.id) ? entry.id : (typeof entry.id === 'string' && entry.id ? entry.id : null);
    if (id === null) return null;
    const savedAt = plausibleTime(entry.savedAt, now) ? entry.savedAt : (plausibleTime(id, now) ? id : now);
    const limit = savedAt + HISTORY_TTL_MS;
    const expiresAt = typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) ? Math.min(entry.expiresAt, limit) : limit;
    if (expiresAt <= now) return null;
    return {
      id,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.slice(0, 200) : 'Analysis',
      score: typeof entry.score === 'number' && Number.isFinite(entry.score) ? entry.score : null,
      verdict: typeof entry.verdict === 'string' ? entry.verdict.slice(0, 100) : '',
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp.slice(0, 100) : '',
      savedAt,
      expiresAt,
      report: entry.report
    };
  }

  // raw: the stored string (or null). Returns the entries to keep plus whether storage must be rewritten (something
  // expired, was malformed or was migrated). Unreadable storage yields no entries and changed: true.
  function normalizeHistory(raw, now = Date.now()) {
    if (raw === null || raw === undefined) return { entries: [], changed: false };
    let parsed = null;
    if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { parsed = null; } }
    const seen = new Set();
    const entries = [];
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const entry = normalizeHistoryEntry(item, now);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
      if (entries.length === HISTORY_MAX) break;
    }
    return { entries, changed: JSON.stringify(entries) !== raw };
  }
  // entries come from normalizeHistory. The new entry is stamped here so every saved entry carries its own expiry.
  function addHistoryEntry(entries, entry, now = Date.now()) {
    const stamped = { ...entry, savedAt: now, expiresAt: now + HISTORY_TTL_MS };
    return [stamped, ...entries.filter((item) => item.id !== entry.id)].slice(0, HISTORY_MAX);
  }
  function removeHistoryEntry(entries, id) {
    return entries.filter((item) => String(item.id) !== String(id));
  }

  // ---- export ---------------------------------------------------------------------------------
  // html2canvas (inside html2pdf) cannot parse CSS Color 4 functions. Chrome reports computed color-mix()
  // values as color(srgb ...), so the export converts them in its private clone of the report.
  const MODERN_COLOR = /(?:^|[^\w-])(?:color|color-mix|lab|lch|oklab|oklch|hwb|light-dark)\(/i;
  function hasModernColor(value) {
    return typeof value === 'string' && MODERN_COLOR.test(value);
  }
  // Exact conversion for the one form Chrome emits for srgb color-mix results; null for anything else
  // (the caller then falls back to letting a canvas resolve the colour).
  function modernColorToRgba(value) {
    const match = /^color\(\s*srgb\s+(-?[\d.]+%?)\s+(-?[\d.]+%?)\s+(-?[\d.]+%?)(?:\s*\/\s*(-?[\d.]+%?))?\s*\)$/i.exec(String(value || '').trim());
    if (!match) return null;
    const unit = (token) => (token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token));
    const channel = (token) => Math.round(Math.min(1, Math.max(0, unit(token))) * 255);
    const alpha = match[4] === undefined ? 1 : Math.min(1, Math.max(0, unit(match[4])));
    const parts = [channel(match[1]), channel(match[2]), channel(match[3])];
    if (parts.some(Number.isNaN) || Number.isNaN(alpha)) return null;
    return `rgba(${parts.join(', ')}, ${Math.round(alpha * 1000) / 1000})`;
  }
  // Exporting while the background analysis is incomplete would produce placeholder text, so reject it.
  // 'unavailable' (restored from history, details not saved) is allowed: the report says so itself.
  function exportBlockReason(state = {}) {
    if (state.insights === 'loading') return 'Nova is still preparing the analysis details. You can export once they finish loading.';
    if (state.insights === 'error') return 'The analysis details could not be prepared. Retry them (open Strengths or Gaps) before exporting.';
    return null;
  }
  function pdfTitle(report) {
    const role = report?.opportunitySummary?.role || report?.opportunityName || 'Eligibility assessment';
    return `Nova fit brief — ${String(role).replace(/\s+/g, ' ').trim().slice(0, 120)}`;
  }
  function pdfFilename(report, now = new Date()) {
    const role = report?.opportunitySummary?.role || report?.opportunityName || '';
    const slug = String(role).normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString().slice(0, 10) : 'report';
    return `nova-fit-brief-${slug ? `${slug}-` : ''}${date}.pdf`;
  }

  const api = {
    safe, arr, notAvailable, parse, hasNumber, numberOrNull, adaptNovaReport, friendlyError,
    list, STATUS_LABELS, presentationText, normalizeStatus, humanizeVerdict, requirementItems,
    statusCounts, firstText, biggestConcern, nextBestAction, documentGroups, constraintNotes, verifiedMetrics, requirementsMatch, requirementsMatchText, contextCandidate,
    detailRequirement, resourceMarkup, strategyMarkup, moduleContent, buildReportText,
    buildAssessmentPayload, mergeNarrative, hasInsights,
    hasModernColor, modernColorToRgba, exportBlockReason, pdfTitle, pdfFilename, responseErrorMessage,
    HISTORY_KEY, HISTORY_TTL_DAYS, HISTORY_TTL_MS, HISTORY_MAX, normalizeHistory, addHistoryEntry, removeHistoryEntry
  };
  root.NovaReport = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
