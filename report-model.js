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
      hiddenRequirements: arr(report.hiddenRequirements),
      riskAnalysis: arr(report.riskAnalysis),
      interviewQuestions: arr(report.interviewQuestions),
      learningResources: arr(report.learningResources).filter((item) => item && typeof item === 'object' && !Array.isArray(item)),
      resumeImprovements: arr(report.resumeImprovements)
    };
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
  function biggestConcern(report) {
    const gap = arr(report?.missingSkills)[0];
    if (gap?.skill) return `${gap.skill}${gap.whyItMatters ? ` — ${gap.whyItMatters}` : ''}`;
    const unknownRequirement = requirementItems(report).find((item) => normalizeStatus(item.status).key === 'unknown');
    if (unknownRequirement?.requirement) return `${unknownRequirement.requirement}${unknownRequirement.evidence ? ` — ${unknownRequirement.evidence}` : ''}`;
    const risk = arr(report?.riskAnalysis)[0];
    if (risk?.risk) return `${risk.risk}${risk.mitigation ? ` — ${risk.mitigation}` : ''}`;
    return firstText(report?.weaknesses, notAvailable());
  }
  function nextBestAction(report) {
    const improvement = arr(report?.resumeImprovements)[0];
    if (improvement?.suggested) return improvement.suggested;
    return firstText(report?.personalizedRecommendations, firstText(report?.roadmap?.map((item) => item.action), notAvailable()));
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
  function resourceMarkup(resource) {
    if (!resource || typeof resource !== 'object') return '';
    const skill = String(resource.skill || 'Learning resource');
    const title = String(resource.resource || resource.skill || 'Resource');
    const provider = String(resource.provider || '');
    const type = String(resource.type || '');
    const duration = String(resource.timeToComplete || '');
    const resolvedUrl = safeResourceUrl(resource.url, provider || resource.resource);
    const badge = type ? `<span class="status-unknown resource-type-badge">${safe(type)}</span>` : '';
    const durationEl = duration ? `<span class="resource-duration">${safe(duration)}</span>` : '';
    const providerEl = provider ? `<div class="resource-provider">${safe(provider)}</div>` : '';
    const linkEl = resolvedUrl
      ? `<a class="resource-open-link" href="${safe(resolvedUrl)}" target="_blank" rel="noopener noreferrer">Open resource <i data-lucide="arrow-up-right"></i></a>`
      : `<span class="resource-no-link">No direct link</span>`;
    return `<article class="resource-card" tabindex="0"><div class="resource-card-top">${badge}${durationEl}</div><div class="resource-card-skill">${safe(skill)}</div><strong class="resource-card-title">${safe(title)}</strong>${providerEl}<div class="resource-card-footer">${linkEl}</div></article>`;
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
    const documents = arr(report?.requiredDocuments);
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
    const resources = arr(report?.learningResources);
    const resourcesHtml = resources.length
      ? `<div class="resources-scroller" role="list" aria-label="Learning resources">${resources.map(resourceMarkup).join('')}</div>`
      : '<span class="empty">No learning resources were generated.</span>';
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
      return { title: 'Requirements', subtitle: `${counts.met} of ${counts.total || 0} mapped requirements matched`, html: `<div class="detail-summary">Each item connects the opportunity requirement to the evidence Nova found in the supplied profile.</div><div class="detail-list">${counts.items.length ? counts.items.map(detailRequirement).join('') : '<span class="empty">No requirements were identified.</span>'}</div>` };
    }
    if (module === 'strengths') {
      const strengths = arr(report?.strengths);
      const weaknesses = arr(report?.weaknesses);
      return { title: 'Strengths & weaknesses', subtitle: `${strengths.length} strengths · ${weaknesses.length} weaknesses`, html: `<div class="detail-summary">These are the strongest signals and limitations Nova found. Use strengths as evidence and weaknesses as edit targets.</div><div class="detail-list"><span class="detail-label">STRENGTHS</span>${strengths.length ? strengths.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item)}</strong><span class="status-met">Strong evidence</span></div><p>Supporting evidence is present in the supplied profile.</p></article>`).join('') : '<span class="empty">No strengths were returned by Nova.</span>'}<span class="detail-label">WEAKNESSES</span>${weaknesses.length ? weaknesses.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item)}</strong><span class="status-partial">Needs attention</span></div><p>This limitation was returned by Nova from the supplied evidence.</p></article>`).join('') : '<span class="empty">No weaknesses were returned by Nova.</span>'}</div>` };
    }
    if (module === 'gaps') {
      const gaps = arr(report?.missingSkills);
      return { title: 'Gaps', subtitle: `${gaps.length} important gaps`, html: `<div class="detail-summary">Start with the highest-impact gap. A missing signal is not a rejection; it is a decision about what to strengthen first.</div><div class="detail-list">${gaps.length ? gaps.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item.skill || 'Missing skill')}</strong><span class="status-${String(item.priority || 'medium').toLowerCase() === 'high' ? 'missing' : 'partial'}">${safe(item.priority || 'Priority')}</span></div><p><b>Why it matters:</b> ${safe(item.whyItMatters || 'This skill appears relevant to the opportunity.')}</p><small><b>Learning time:</b> ${safe(item.learningTime || 'Not specified')} · <b>Difficulty:</b> ${safe(item.difficulty || 'Not specified')}</small></article>`).join('') : '<span class="empty">No high-priority gaps were identified.</span>'}</div>` };
    }
    if (module === 'documents') {
      const documents = arr(report?.requiredDocuments);
      return { title: 'Documents', subtitle: `${documents.length} required document${documents.length === 1 ? '' : 's'}`, html: `<div class="detail-summary">Use this as the final submission checklist. Status labels come directly from the analysis.</div><div class="detail-list">${documents.length ? documents.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item.document || 'Required document')}</strong><span class="status-${/completed|ready|not[\s_-]*required/i.test(item.status || '') ? 'met' : 'unknown'}">${safe(presentationText(item.status, 'Not enough evidence'))}</span></div></article>`).join('') : '<span class="empty">No documents were identified.</span>'}</div>` };
    }
    if (module === 'risks') {
      const risks = arr(report?.riskAnalysis);
      return { title: 'Blockers', subtitle: `${risks.length} risk signal${risks.length === 1 ? '' : 's'}`, html: `<div class="detail-summary">Risk signals help you decide whether to apply now, verify something, or strengthen evidence first.</div><div class="detail-list">${risks.length ? risks.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item.risk || 'Risk signal')}</strong><span class="status-${String(item.severity || 'medium').toLowerCase() === 'high' ? 'missing' : 'partial'}">${safe(presentationText(item.severity || 'Medium'))}</span></div><p>${safe(item.mitigation || 'Review this risk before submitting.')}</p></article>`).join('') : '<span class="empty">No significant risks were identified.</span>'}</div>` };
    }
    if (module === 'strategy') {
      return { title: 'Application strategy', subtitle: 'A concise path forward', html: strategyMarkup(report, state) };
    }
    if (module === 'resources') {
      const resources = arr(report?.learningResources);
      return { title: 'Learning resources', subtitle: `${resources.length} recommendation${resources.length === 1 ? '' : 's'}`, html: `<div class="detail-summary">Click a card to open the resource in a new tab. Resources are matched to the skill gaps in your profile.</div>${resources.length ? `<div class="resources-scroller" role="list" aria-label="Learning resources">${resources.map(resourceMarkup).join('')}</div>` : '<span class="empty">No resources were generated.</span>'}` };
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
      `Requirements: ${countsData.met}/${countsData.total || 0} matched`,
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

  const api = {
    safe, arr, notAvailable, parse, hasNumber, numberOrNull, adaptNovaReport, friendlyError,
    list, STATUS_LABELS, presentationText, normalizeStatus, humanizeVerdict, requirementItems,
    statusCounts, firstText, biggestConcern, nextBestAction, contextCandidate,
    detailRequirement, resourceMarkup, strategyMarkup, moduleContent, buildReportText,
    buildAssessmentPayload, mergeNarrative, hasInsights,
    responseErrorMessage
  };
  root.NovaReport = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
