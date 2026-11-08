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
    if (/Groq|GROQ_API_KEY|server is not configured|not configured for AI analysis|STAGE|provider|invalid analysis/i.test(raw)) return 'Analysis is unavailable in this preview right now. Your inputs are still here—please try again later.';
    if (/timed out/i.test(raw)) return 'The analysis took too long to finish. Your inputs are still here—please try again.';
    if (/too many/i.test(raw)) return raw;
    return raw || 'Something went wrong. Your inputs are still here—please try again.';
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

  function strategyMarkup(report) {
    const requirements = statusCounts(report);
    const documents = arr(report?.requiredDocuments);
    const pendingDocument = documents.find((item) => !/completed|ready|not[\s_-]*required/i.test(item?.status || ''));
    const actions = [
      ['Should I apply?', humanizeVerdict(report?.finalVerdict || report?.eligibilityVerdict || 'Review the eligibility status before submitting.')],
      ['What to emphasize', firstText(report?.strengths, notAvailable())],
      ['What to fix first', biggestConcern(report)],
      ['What could hurt', arr(report?.riskAnalysis)[0]?.risk || firstText(report?.weaknesses, notAvailable())],
      ['Before submitting', pendingDocument?.document || nextBestAction(report)]
    ];
    const coverText = String(report?.coverLetter || '');
    const coverHtml = coverText ? coverText.split(/\n+/).filter(Boolean).map((para) => `<p>${safe(para)}</p>`).join('') : '<span class="empty">No cover letter was generated.</span>';
    const resources = arr(report?.learningResources);
    const resourcesHtml = resources.length
      ? `<div class="resources-scroller" role="list" aria-label="Learning resources">${resources.map(resourceMarkup).join('')}</div>`
      : '<span class="empty">No learning resources were generated.</span>';
    return `<div class="strategy-grid"><div class="detail-summary">${requirements.total ? `${requirements.met} of ${requirements.total} mapped requirements are currently matched. Use the actions below to decide how to spend your effort.` : 'Use the evidence and gaps below to decide how to spend your effort.'}</div>${actions.map(([label, value]) => `<article class="strategy-card"><span>${safe(label)}</span><p>${safe(value)}</p></article>`).join('')}<article class="detail-item"><div class="detail-item-header"><strong>Generated cover letter</strong><button class="secondary-button" id="coverLetterCopy" type="button">Copy</button></div><div class="cover-letter-content">${coverHtml}</div></article><article class="detail-item"><div class="detail-item-header"><strong>Learning resources</strong><span class="status-unknown">${resources.length} available</span></div>${resourcesHtml}</article></div>`;
  }
  function moduleContent(module, report) {
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
      return { title: 'Application strategy', subtitle: 'A concise path forward', html: strategyMarkup(report) };
    }
    if (module === 'resources') {
      const resources = arr(report?.learningResources);
      return { title: 'Learning resources', subtitle: `${resources.length} recommendation${resources.length === 1 ? '' : 's'}`, html: `<div class="detail-summary">Click a card to open the resource in a new tab. Resources are matched to the skill gaps in your profile.</div>${resources.length ? `<div class="resources-scroller" role="list" aria-label="Learning resources">${resources.map(resourceMarkup).join('')}</div>` : '<span class="empty">No resources were generated.</span>'}` };
    }
    return { title: 'Evidence', subtitle: 'Focused details from your fit brief', html: '<span class="empty">No details are available for this module.</span>' };
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
    detailRequirement, resourceMarkup, strategyMarkup, moduleContent, buildReportText
  };
  root.NovaReport = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
