/*
 * Nova AI — decision-first frontend
 * Preserves the existing API contract and report schema while changing only
 * the presentation and navigation model.
 */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const safe = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])
  );
const arr = (v) => (Array.isArray(v) ? v : []);
const score = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const notAvailable = () => 'Not available from Nova.';
const storage = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* Storage can be disabled. */ }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch { /* Storage can be disabled. */ }
  }
};

const samples = {
  profile: `Priya Sharma is a 20-year-old third-year B.Tech Computer Science student at Delhi Technological University, graduating May 2027. CGPA: 8.6/10. Indian citizen. Skills: JavaScript, TypeScript, React, Python, SQL, Git, Figma. Completed a 3-month frontend engineering internship at a fintech startup and shipped React components used by 10,000+ users. Led a team of four at a university hackathon; placed second. Volunteers teaching digital literacy. Available 15 hours per week.`,
  resume: `PRIYA SHARMA | Delhi, India | priya@example.com | github.com/priyasharma\n\nEDUCATION\nB.Tech, Computer Science, Delhi Technological University | 2023–2027 | CGPA 8.6/10\n\nSKILLS\nPython, JavaScript, TypeScript, React, SQL, Git, Figma; English and Hindi\n\nEXPERIENCE\nFrontend Engineering Intern, Fintech Startup | May–Jul 2025\nBuilt reusable React components for a payments dashboard used by 10,000+ users.\n\nPROJECTS\nAccessLearn: React learning tool with accessible UI, 300 student users.\n\nACHIEVEMENTS\n2nd place, DTU Hackathon 2025. Google UX Design Certificate.`,
  internship: `Product Engineering Intern — Atlas Labs\nLocation: Bengaluru or remote, India | Deadline: 30 September 2026\nAtlas Labs is seeking undergraduate CS students for a 12-week paid internship. Applicants need strong JavaScript or Python, SQL fundamentals, experience shipping a web product, and 15 hours/week availability. Preferred: React, GitHub portfolio, cloud deployment, and collaborative communication. Submit a resume, transcript, portfolio/GitHub and short cover letter. Benefits include mentorship, stipend and conversion consideration.`,
  scholarship: `Global Digital Futures Fellowship 2026\nA fully funded, six-month remote fellowship for undergraduate students designing technology for social impact. Fellows receive mentorship, a $2,000 project grant, and an invitation to a final summit in Singapore.\nEligibility: enrolled undergraduate students aged 18–25 from South or Southeast Asia, Africa, or Latin America; one year of programming or digital product-building experience; written English; 12 hours weekly Jan–Jun 2026. Preferred: community impact, leadership, accessibility, education, climate or financial inclusion projects. Apply with CV, statement of purpose, portfolio/GitHub, transcript, academic reference, 90-second video and passport.`,
  competition: `AI for Good Student Challenge 2026\nRemote global competition for university students. Form a team of 2–5 and build an AI solution addressing climate resilience. Required: Python, machine learning fundamentals, a public GitHub repository and student enrollment. Preferred: deployed demo, data visualization and presentation experience. Deadline: 15 October 2026. Prizes include cloud credits, mentorship and $5,000.`
};

const profileInput = $('#profileInput');
const opportunityInput = $('#opportunityInput');
let abortController = null;
let phaseTimer = null;
let latestReport = null;
let latestReportSaved = false;

function icons() {
  window.lucide?.createIcons();
}

function toast(message) {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.remove('hidden');
  window.clearTimeout(element._toastTimer);
  element._toastTimer = window.setTimeout(() => element.classList.add('hidden'), 2800);
}

function countTo(element, target, suffix = '', duration = 650) {
  if (!element) return;
  if (target === null || target === undefined) {
    element.textContent = '—';
    element.setAttribute('aria-label', 'Fit score not available');
    return;
  }
  const finalText = `${target}${suffix}`;
  element.setAttribute('aria-label', finalText);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    element.textContent = finalText;
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = `${Math.round(target * eased)}${suffix}`;
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function counts() {
  const pc = $('#profileCount');
  const oc = $('#opportunityCount');
  if (pc) pc.textContent = `${profileInput.value.length.toLocaleString()} / 8,000`;
  if (oc) oc.textContent = `${opportunityInput.value.length.toLocaleString()} / 12,000`;
  const profileState = $('#profileState');
  const opportunityState = $('#opportunityState');
  if (profileState) {
    profileState.textContent = profileInput.value.trim() ? 'Profile ready' : 'Waiting for profile';
    profileState.classList.toggle('ready', Boolean(profileInput.value.trim()));
  }
  if (opportunityState) {
    opportunityState.textContent = opportunityInput.value.trim() ? 'Brief ready' : 'Waiting for opportunity';
    opportunityState.classList.toggle('ready', Boolean(opportunityInput.value.trim()));
  }
}

function loadSample(kind, { announce = true } = {}) {
  if (kind === 'profile' || kind === 'resume') profileInput.value = samples[kind];
  else opportunityInput.value = samples[kind];
  counts();
  if (announce) toast(`Sample ${kind} loaded.`);
}

function showWorkspace({ scroll = true } = {}) {
  document.body.classList.remove('report-mode', 'analysis-mode');
  $('#report')?.classList.add('hidden');
  $('#errorCard')?.classList.add('hidden');
  $('#workspace')?.classList.remove('hidden');
  if (scroll) $('#workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function loadSampleDecision() {
  showWorkspace({ scroll: false });
  loadSample('profile', { announce: false });
  loadSample('internship', { announce: false });
  $('#workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Sample decision loaded.');
}

$$('[data-sample]').forEach((button) => {
  button.addEventListener('click', () => {
    loadSample(button.dataset.sample);
    button.closest('details')?.removeAttribute('open');
  });
});
$('#sampleProfile')?.addEventListener('click', () => loadSample('profile'));
$('#sampleOpportunity')?.addEventListener('click', () => loadSample('internship'));
$('#sampleDecisionBtn')?.addEventListener('click', loadSampleDecision);
$('#sampleDecisionHero')?.addEventListener('click', loadSampleDecision);
profileInput?.addEventListener('input', counts);
opportunityInput?.addEventListener('input', counts);

function setupPointerGlow() {
  const zone = $('[data-pointer-zone]');
  const card = $('[data-pointer-card]');
  if (!zone || !card || matchMedia('(pointer: coarse)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  zone.addEventListener('pointermove', (event) => {
    const rect = zone.getBoundingClientRect();
    const x = `${event.clientX - rect.left}px`;
    const y = `${event.clientY - rect.top}px`;
    zone.style.setProperty('--pointer-x', x);
    zone.style.setProperty('--pointer-y', y);
    const cardRect = card.getBoundingClientRect();
    card.style.setProperty('--card-shift-x', `${Math.max(-4, Math.min(4, (event.clientX - (cardRect.left + cardRect.width / 2)) / 90))}px`);
    card.style.setProperty('--card-shift-y', `${Math.max(-4, Math.min(4, (event.clientY - (cardRect.top + cardRect.height / 2)) / 120))}px`);
    card.style.setProperty('--card-pointer-x', `${event.clientX - cardRect.left}px`);
    card.style.setProperty('--card-pointer-y', `${event.clientY - cardRect.top}px`);
  });
  zone.addEventListener('pointerleave', () => {
    zone.style.removeProperty('--pointer-x');
    zone.style.removeProperty('--pointer-y');
    card.style.removeProperty('--card-shift-x');
    card.style.removeProperty('--card-shift-y');
    card.style.removeProperty('--card-pointer-x');
    card.style.removeProperty('--card-pointer-y');
  });
}

function setupConstellation() {
  const canvas = $('#constellationField');
  const zone = $('[data-pointer-zone]');
  if (!canvas || !zone) return;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: -9999, y: -9999, active: false };
  let nodes = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let last = 0;
  const paletteForTheme = () => document.documentElement.dataset.theme === 'light'
    ? { node: 'rgba(50, 60, 80, 0.95)', line: 'rgba(50, 60, 80, 0.45)', hot: '60, 90, 150', field: 'rgba(60, 90, 150, 0.2)', fieldClear: 'rgba(60, 90, 150, 0)' }
    : { node: 'rgba(200, 215, 240, 0.95)', line: 'rgba(160, 180, 220, 0.55)', hot: '180, 200, 255', field: 'rgba(180, 200, 255, 0.3)', fieldClear: 'rgba(180, 200, 255, 0)' };
  const nodeCount = () => Math.min(window.innerWidth < 680 ? 28 : 52, Math.max(18, Math.floor(width / 25)));
  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const rect = zone.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    nodes = Array.from({ length: nodeCount() }, (_, index) => {
      const previous = nodes[index];
      return previous || { x: Math.random() * width, y: Math.random() * height, vx: (Math.random() - 0.5) * 0.035, vy: (Math.random() - 0.5) * 0.035, phase: Math.random() * Math.PI * 2 };
    });
    draw(0);
  }
  function draw(time) {
    const delta = Math.min(32, time - last || 16);
    last = time;
    const palette = paletteForTheme();
    context.clearRect(0, 0, width, height);
    if (pointer.active) {
      const gradient = context.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, Math.min(240, width * 0.35));
      gradient.addColorStop(0, palette.field);
      gradient.addColorStop(1, palette.fieldClear);
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    }
    const movement = reduce.matches ? 0 : delta;
    nodes.forEach((node) => {
      node.x += node.vx * movement;
      node.y += node.vy * movement;
      if (node.x < -20) node.x = width + 20;
      if (node.x > width + 20) node.x = -20;
      if (node.y < -20) node.y = height + 20;
      if (node.y > height + 20) node.y = -20;
      if (!reduce.matches) {
        node.x += Math.cos(time * 0.00018 + node.phase) * 0.03;
        node.y += Math.sin(time * 0.00016 + node.phase) * 0.03;
      }
      if (pointer.active && !reduce.matches) {
        const dx = node.x - pointer.x;
        const dy = node.y - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 200 && distance > 0) {
          const push = (200 - distance) / 200 * 0.45;
          node.x += dx / distance * push;
          node.y += dy / distance * push;
        }
      }
    });
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > 142) continue;
        const proximity = pointer.active ? Math.max(0, 1 - Math.hypot((a.x + b.x) / 2 - pointer.x, (a.y + b.y) / 2 - pointer.y) / 180) : 0;
        context.strokeStyle = proximity > 0.05 ? `rgba(${palette.hot}, ${0.1 + proximity * 0.24})` : palette.line;
        context.lineWidth = proximity > 0.05 ? 2.0 : 1.2;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
    }
    nodes.forEach((node) => {
      const distance = pointer.active ? Math.hypot(node.x - pointer.x, node.y - pointer.y) : 9999;
      const active = distance < 140;
      context.fillStyle = active ? (document.documentElement.dataset.theme === 'light' ? 'rgba(62, 86, 141, 0.65)' : 'rgba(209, 220, 242, 0.84)') : palette.node;
      context.beginPath();
      context.arc(node.x, node.y, active ? 4.5 : 2.5, 0, Math.PI * 2);
      context.fill();
    });
    if (!reduce.matches && !document.hidden) frame = requestAnimationFrame(draw);
  }
  function start() { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); }
  function stop() { cancelAnimationFrame(frame); frame = 0; }
  function onPointerMove(event) {
    const rect = zone.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.active = true;
    if (!reduce.matches && !document.hidden && !frame) start();
  }
  function onPointerLeave() { pointer.active = false; }
  resize();
  zone.addEventListener('pointermove', onPointerMove, { passive: true });
  zone.addEventListener('pointerleave', onPointerLeave, { passive: true });
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (!reduce.matches) start(); });
  reduce.addEventListener?.('change', () => { resize(); if (reduce.matches) stop(); else start(); });
  const themeObserver = new MutationObserver(() => draw(performance.now()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (!reduce.matches) start();
}

if ($('#themeToggle')) {
  $('#themeToggle').setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
  $('#themeToggle').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    $('#themeToggle').setAttribute('aria-pressed', String(theme === 'dark'));
    storage.set('opportunity-theme', theme);
  });
}

async function extractTextFromPDF(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
    if (!pdfjsLib) {
      toast('PDF reader is loading. Please try again in a moment.');
      return null;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    if (pdf.numPages > 100) {
      toast('This PDF has too many pages. Please choose a shorter resume.');
      return null;
    }
    let text = '';
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += `${content.items.map((item) => item.str).join(' ')}\n`;
    }
    return text.trim();
  } catch (error) {
    console.error('PDF extraction error:', error);
    toast('Could not read this PDF. Try a text-based PDF or paste your resume directly.');
    return null;
  }
}

async function addResumeFile(file) {
  if (!file) return;
  const f = file;
  const fileName = file.name.toLowerCase();
  const isPdf = file.type === 'application/pdf' || fileName.endsWith('.pdf');
  const isText = file.type.startsWith('text/') || /\.(txt|md)$/i.test(fileName);
  if (!isPdf && !isText) {
    toast('Please upload a TXT, Markdown, or PDF resume.');
    return;
  }
  if (f.size > 2000000) {
    toast('File is too large. Please choose a file smaller than 2 MB.');
    return;
  }
  if (isPdf) {
    toast('Reading PDF…');
    const text = await extractTextFromPDF(file);
    if (text && text.length > 10) {
      profileInput.value = text.slice(0, 8000);
      counts();
      toast(`Resume extracted from PDF (${text.length.toLocaleString()} characters).`);
    } else if (text !== null) {
      toast('PDF appears empty or image-based. Paste your resume text instead.');
    }
    return;
  }
  if (file.size > 500000) {
    toast('Choose a text file smaller than 500 KB.');
    return;
  }
  try {
    profileInput.value = (await file.text()).slice(0, 8000);
    counts();
    toast('Resume added and ready for analysis.');
  } catch {
    toast('Could not read this file. Please try a different format.');
  }
}

$('#resumeUpload')?.addEventListener('change', (event) => addResumeFile(event.target.files?.[0]));
$$('.input-card').forEach((card) => {
  card.addEventListener('dragover', (event) => { event.preventDefault(); card.classList.add('drag-over'); });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('drag-over');
    addResumeFile(event.dataTransfer.files?.[0]);
  });
});

function parse(text) {
  if (!text) return {};
  return JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
}

function hasNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
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
    opportunitySummary: report.opportunitySummary && typeof report.opportunitySummary === 'object' ? report.opportunitySummary : null,
    profileSummary: report.profileSummary && typeof report.profileSummary === 'object' ? report.profileSummary : null,
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
    learningResources: arr(report.learningResources),
    resumeImprovements: arr(report.resumeImprovements)
  };
}

function loading(show) {
  $('#loadingPanel')?.classList.toggle('hidden', !show);
  $('#loadingPanel')?.setAttribute('aria-busy', String(show));
  $('#workspace')?.classList.toggle('hidden', show);
  const button = $('#analyzeBtn');
  if (button) button.disabled = show;
}

const phases = [
  'Reading opportunity.',
  'Mapping your evidence.',
  'Checking blockers.',
  'Preparing your next moves.'
];

function startLoading() {
  document.body.classList.add('analysis-mode');
  loading(true);
  let index = 0;
  const text = $('#loadingText');
  if (text) text.textContent = phases[0];
  $$('.loading-steps span').forEach((step, stepIndex) => step.classList.toggle('active', stepIndex === 0));
  phaseTimer = window.setInterval(() => {
    index = (index + 1) % phases.length;
    if (text) text.textContent = phases[index];
    $$('.loading-steps span').forEach((step, stepIndex) => step.classList.toggle('active', stepIndex === index));
  }, 1600);
}
function stopLoading() {
  window.clearInterval(phaseTimer);
  phaseTimer = null;
  loading(false);
}
function friendlyError(message) {
  const raw = String(message || '');
  if (/Groq|GROQ_API_KEY|server is not configured|not configured for AI analysis|STAGE|provider|invalid analysis/i.test(raw)) return 'Analysis is unavailable in this preview right now. Your inputs are still here—please try again later.';
  if (/timed out/i.test(raw)) return 'The analysis took too long to finish. Your inputs are still here—please try again.';
  if (/too many/i.test(raw)) return raw;
  return raw || 'Something went wrong. Your inputs are still here—please try again.';
}

async function runAnalysis() {
  const profile = profileInput.value.trim();
  const opportunity = opportunityInput.value.trim();
  if (!profile || !opportunity) { toast('Add both your profile and an opportunity first.'); return; }
  if (profile.length < 50) { toast('Your profile seems too short. Add more detail for a useful analysis.'); return; }
  if (opportunity.length < 50) { toast('The opportunity description seems too short. Paste the full description.'); return; }
  $('#errorCard')?.classList.add('hidden');
  $('#report')?.classList.add('hidden');
  startLoading();
  abortController = new AbortController();
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, opportunity }),
      signal: abortController.signal
    });
    let data = {};
    try { data = await response.json(); } catch { throw new Error('The analysis response was not readable.'); }
    if (!response.ok) throw new Error(data.error || 'The analysis could not be completed.');
    if (!data.response) throw new Error('The analysis returned no result.');
    renderReport(adaptNovaReport(data), { save: true });
  } catch (error) {
    if (error.name === 'AbortError') return;
    const message = friendlyError(error.message);
    const errorMessage = $('#errorMessage');
    if (errorMessage) errorMessage.textContent = message;
    document.body.classList.remove('analysis-mode');
    $('#errorCard')?.classList.remove('hidden');
    window.requestAnimationFrame(() => $('#errorTitle')?.focus({ preventScroll: true }));
  } finally {
    abortController = null;
    stopLoading();
  }
}
$('#analyzeBtn')?.addEventListener('click', runAnalysis);
$('#retryBtn')?.addEventListener('click', runAnalysis);
$('#cancelLoading')?.addEventListener('click', () => {
  abortController?.abort();
  abortController = null;
  window.clearInterval(phaseTimer);
  document.body.classList.remove('analysis-mode');
  loading(false);
  toast('Analysis cancelled.');
});

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value ?? '';
}
function setHTML(selector, html) {
  const element = $(selector);
  if (element) element.innerHTML = html;
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
function statusClass(status) { return normalizeStatus(status).key; }
function detailRequirement(x) {
  const status = normalizeStatus(x.status);
  const requirementText = safe(x.requirement);
  const evidence = safe(x.evidence || x.note || notAvailable());
  const reasoning = safe(x.reasoning || notAvailable());
  const confidence = safe(presentationText(x.confidence));
  const mandatory = x.mandatory === true ? '<span class="detail-required">Required</span>' : '';
  return `<details class="detail-item"><summary class="detail-item-header"><strong>${requirementText || 'Requirement'}</strong><span class="detail-status-group">${mandatory}<span class="status-${status.key}">${safe(status.label)}</span></span></summary><p><b>Evidence:</b> ${evidence}</p><p><b>Reasoning:</b> ${reasoning}</p><small><b>Confidence:</b> ${confidence}</small></details>`;
}
// Trusted platform base hostnames — LLM-provided URLs are only used if their hostname matches.
const TRUSTED_RESOURCE_ORIGINS = new Set([
  'freecodecamp.org', 'developer.mozilla.org', 'coursera.org', 'edx.org',
  'kaggle.com', 'youtube.com', 'youtu.be', 'ocw.mit.edu', 'developers.google.com',
  'learn.microsoft.com', 'docs.aws.amazon.com', 'cloud.google.com', 'khanacademy.org',
  'docs.python.org', 'docs.docker.com', 'git-scm.com', 'reactjs.org', 'react.dev',
  'typescriptlang.org', 'nodejs.org', 'flask.palletsprojects.com', 'fastapi.tiangolo.com',
  'postgresql.org', 'sqlite.org', 'redis.io', 'aws.amazon.com', 'azure.microsoft.com',
  'cloud.google.com', 'figma.com', 'linkedin.com', 'github.com'
]);

// Provider name -> guaranteed-safe homepage/learn-index URL.
const PROVIDER_FALLBACK_URLS = {
  'freecodecamp': 'https://www.freecodecamp.org',
  'mdn web docs': 'https://developer.mozilla.org',
  'mdn': 'https://developer.mozilla.org',
  'mozilla': 'https://developer.mozilla.org',
  'coursera': 'https://www.coursera.org',
  'edx': 'https://www.edx.org',
  'kaggle': 'https://www.kaggle.com/learn',
  'youtube': 'https://www.youtube.com',
  'mit opencourseware': 'https://ocw.mit.edu',
  'mit': 'https://ocw.mit.edu',
  'google developers': 'https://developers.google.com',
  'google': 'https://developers.google.com/learn',
  'microsoft learn': 'https://learn.microsoft.com',
  'microsoft': 'https://learn.microsoft.com',
  'aws': 'https://docs.aws.amazon.com',
  'amazon web services': 'https://docs.aws.amazon.com',
  'google cloud': 'https://cloud.google.com/learn',
  'khan academy': 'https://www.khanacademy.org',
  'khanacademy': 'https://www.khanacademy.org',
  'typescript': 'https://www.typescriptlang.org/docs/',
  'react': 'https://react.dev',
  'node.js': 'https://nodejs.org/en/learn',
  'nodejs': 'https://nodejs.org/en/learn',
  'python': 'https://docs.python.org/3/tutorial/',
  'docker': 'https://docs.docker.com',
  'git': 'https://git-scm.com/doc',
  'github': 'https://docs.github.com',
  'postgresql': 'https://www.postgresql.org/docs/',
  'redis': 'https://redis.io/docs/',
  'flask': 'https://flask.palletsprojects.com',
  'fastapi': 'https://fastapi.tiangolo.com',
  'figma': 'https://www.figma.com/resources/learn-design/'
};

function safeResourceUrl(url, provider) {
  if (url && typeof url === 'string' && url.startsWith('http')) {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      // Exact match or subdomain of trusted origin (e.g. docs.github.com -> github.com)
      if (TRUSTED_RESOURCE_ORIGINS.has(hostname)) return url;
      for (const trusted of TRUSTED_RESOURCE_ORIGINS) {
        if (hostname.endsWith('.' + trusted) || hostname === trusted) return url;
      }
    } catch { /* invalid URL — fall through */ }
  }
  if (provider && typeof provider === 'string') {
    const key = provider.toLowerCase().trim();
    if (PROVIDER_FALLBACK_URLS[key]) return PROVIDER_FALLBACK_URLS[key];
    for (const [k, v] of Object.entries(PROVIDER_FALLBACK_URLS)) {
      if (key.includes(k) || k.includes(key.split(' ')[0])) return v;
    }
  }
  return null;
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
  const pendingDocument = documents.find((item) => !/completed|ready|not required/i.test(item?.status || ''));
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
    return { title: 'Documents', subtitle: `${documents.length} required document${documents.length === 1 ? '' : 's'}`, html: `<div class="detail-summary">Use this as the final submission checklist. Status labels come directly from the analysis.</div><div class="detail-list">${documents.length ? documents.map((item) => `<article class="detail-item"><div class="detail-item-header"><strong>${safe(item.document || 'Required document')}</strong><span class="status-${/completed|ready|not required/i.test(item.status || '') ? 'met' : 'unknown'}">${safe(presentationText(item.status, 'Not enough evidence'))}</span></div></article>`).join('') : '<span class="empty">No documents were identified.</span>'}</div>` };
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

const dialog = $('#analysisDialog');
function closeDialog() { if (dialog?.open) dialog.close(); }
function openModule(module) {
  if (!latestReport) return;
  const content = moduleContent(module, latestReport);
  setText('#dialogTitle', content.title);
  setText('#dialogSubtitle', content.subtitle);
  setHTML('#dialogContent', content.html);
  icons();
  if (typeof dialog?.showModal === 'function') dialog.showModal();
  else dialog?.setAttribute('open', '');
  $('#coverLetterCopy')?.addEventListener('click', () => {
    const text = latestReport?.coverLetter || '';
    navigator.clipboard?.writeText(text).then(() => toast('Cover letter copied.'), () => toast('Could not copy the cover letter.'));
  });
  $('#dialogClose')?.focus();
}
$$('[data-module]').forEach((button) => button.addEventListener('click', () => openModule(button.dataset.module)));
$('#viewAnalysisBtn')?.addEventListener('click', () => {
  $('#moduleGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#moduleGrid [data-module="requirements"]')?.focus();
});
$('#editInputsBtn')?.addEventListener('click', () => {
  showWorkspace();
  profileInput?.focus({ preventScroll: true });
});
$('#dialogClose')?.addEventListener('click', closeDialog);
dialog?.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
dialog?.addEventListener('cancel', closeDialog);

function renderHistory() {
  const element = $('#historyList');
  if (!element) return;
  const entries = historyEntries();
  element.innerHTML = entries.length ? entries.map((entry) => `<button data-history="${safe(entry.id)}" aria-label="Restore analysis: ${safe(entry.title)}, score ${safe(entry.score ?? 'Not available')}"><strong>${safe(entry.title)}</strong><span>${safe(entry.score == null ? 'Not available' : `${entry.score}/100`)} · ${safe(humanizeVerdict(entry.verdict || 'Analysis'))} · ${safe(entry.timestamp || 'Saved')}</span></button>`).join('') : '<span class="empty">Your past analyses appear here.</span>';
  $$('[data-history]').forEach((button) => button.addEventListener('click', () => {
    const entry = historyEntries().find((item) => String(item.id) === String(button.dataset.history));
    if (entry?.report) renderReport(entry.report, { save: false });
  }));
}
function historyEntries() {
  try {
    const parsed = JSON.parse(storage.get('ocopilot-history') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function saveHistory(report) {
  const existing = historyEntries();
  const title = report?.opportunitySummary?.role || report?.opportunityName || 'Analysis';
  const entry = { id: Date.now(), title, score: numberOrNull(report?.overallMatchScore), verdict: humanizeVerdict(report?.eligibilityVerdict || 'Analysis'), timestamp: new Date().toLocaleString(), report };
  storage.set('ocopilot-history', JSON.stringify([entry, ...existing].slice(0, 10)));
}
$('#clearHistory')?.addEventListener('click', () => { storage.remove('ocopilot-history'); renderHistory(); toast('History cleared from this device.'); });

function renderReport(report, { save = false } = {}) {
  latestReport = report || {};
  window.latestReport = latestReport;
  const countsData = statusCounts(latestReport);
  const fit = numberOrNull(latestReport.overallMatchScore);
  const readiness = numberOrNull(latestReport.applicationReadiness);
  const confidence = numberOrNull(latestReport.confidenceScore);
  const candidate = contextCandidate(latestReport);
  const role = latestReport.opportunitySummary?.role || latestReport.opportunityName || 'Eligibility assessment';
  const organization = latestReport.opportunitySummary?.organization || 'Opportunity';
  const verdict = humanizeVerdict(latestReport.eligibilityVerdict || 'Assessment pending');
  const strengths = arr(latestReport.strengths);
  const gaps = arr(latestReport.missingSkills);
  const risks = arr(latestReport.riskAnalysis);
  const documents = arr(latestReport.requiredDocuments);

  setText('#reportTitle', role);
  setText('#reportSubtitle', `${organization} · evidence-based candidate analysis`);
  setText('#execVerdict', verdict);
  setText('#execRecommendation', latestReport.executiveRecommendation || latestReport.verdictReason || latestReport.finalVerdict || 'Your decision-ready overview will appear here.');
  countTo($('#execScore'), fit);
  setText('#decisionEligibility', verdict);
  setText('#decisionRequirements', countsData.total ? `${countsData.met} / ${countsData.total}` : 'Not mapped');
  setText('#decisionConfidence', confidence === null ? notAvailable() : `${confidence}%`);
  setText('#biggestConcern', biggestConcern(latestReport));
  setText('#nextBestAction', nextBestAction(latestReport));
  setText('#contextOpportunity', role);
  setText('#contextOpportunityMeta', [organization, latestReport.opportunitySummary?.deadline].filter(Boolean).join(' · ') || 'Opportunity brief analyzed');
  setText('#contextCandidate', candidate.name);
  setText('#contextCandidateMeta', candidate.meta);
  setText('#contextReadiness', latestReport.readinessCategory ? presentationText(latestReport.readinessCategory) : (readiness === null ? notAvailable() : `${readiness}% ready`));
  setText('#moduleRequirementsMeta', countsData.total ? `${countsData.met} / ${countsData.total} matched · View evidence` : 'No requirements mapped');
  const weaknessCount = arr(latestReport.weaknesses).length;
  setText('#moduleStrengthsMeta', `${strengths.length} strength${strengths.length === 1 ? '' : 's'} · ${weaknessCount} weakness${weaknessCount === 1 ? '' : 'es'} · View evidence`);
  setText('#moduleGapsMeta', `${gaps.length} important gap${gaps.length === 1 ? '' : 's'} · View analysis`);
  setText('#moduleDocumentsMeta', `${documents.length} required · View checklist`);
  setText('#moduleRisksMeta', `${risks.length} identified · View risks`);
  const strategyCount = arr(latestReport.roadmap).length + arr(latestReport.personalizedRecommendations).length;
  const resourceCount = arr(latestReport.learningResources).length;
  setText('#moduleStrategyMeta', strategyCount ? `${strategyCount} strategy item${strategyCount === 1 ? '' : 's'} · View strategy` : 'No strategy data returned');
  setText('#moduleResourcesMeta', resourceCount ? `${resourceCount} resource${resourceCount === 1 ? '' : 's'} · View links` : 'No resources returned');

  const resumeStrength = numberOrNull(latestReport.resumeStrength?.score);
  const ats = numberOrNull(latestReport.atsReadiness?.score);
  setText('#resumeStrScore', resumeStrength === null ? '—' : resumeStrength);
  setText('#atsScore', ats === null ? '—' : ats);
  const resumeMeter = $('#resumeStrMeter');
  const atsMeter = $('#atsMeter');
  if (resumeMeter) resumeMeter.style.width = resumeStrength === null ? '0%' : `${resumeStrength}%`;
  if (atsMeter) atsMeter.style.width = ats === null ? '0%' : `${ats}%`;
  setText('#resumeStrLabel', resumeStrength === null ? notAvailable() : resumeStrength >= 75 ? 'Strong resume — well-structured and detailed.' : resumeStrength >= 50 ? 'Adequate resume — some improvements needed.' : 'Resume quality needs attention.');
  setText('#atsLabel', ats === null ? notAvailable() : ats >= 75 ? 'Good ATS compatibility — your resume should parse well.' : ats >= 50 ? 'Moderate ATS readiness — optimize keywords and formatting.' : 'ATS readiness needs attention.');
  setHTML('#resumeStrHighlights', list(latestReport.resumeStrength?.highlights, 'No highlights identified.'));
  setHTML('#resumeStrWeaknesses', list(latestReport.resumeStrength?.weaknesses, 'No improvement areas identified.'));
  setHTML('#atsIssues', list(latestReport.atsReadiness?.issues, 'No ATS issues identified.'));
  setHTML('#atsSuggestions', list(latestReport.atsReadiness?.suggestions, 'No ATS suggestions identified.'));

  document.body.classList.remove('analysis-mode');
  document.body.classList.add('report-mode');
  $('#workspace')?.classList.add('hidden');
  $('#report')?.classList.remove('hidden');
  $('#errorCard')?.classList.add('hidden');
  if (save && !latestReportSaved) { saveHistory(latestReport); latestReportSaved = true; renderHistory(); }
  icons();
  window.requestAnimationFrame(() => $('#report')?.focus({ preventScroll: true }));
}

function reportText() {
  const report = latestReport || {};
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
function download(content, type, name) {
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(new Blob([content], { type }));
  link.href = objectUrl;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
$('#copyBtn')?.addEventListener('click', () => navigator.clipboard?.writeText(reportText()).then(() => toast('Fit brief copied.'), () => toast('Could not copy the brief.')));
$('#jsonBtn')?.addEventListener('click', () => { if (!latestReport) return toast('No report to export.'); download(JSON.stringify(latestReport, null, 2), 'application/json', 'nova-fit-brief.json'); toast('JSON downloaded.'); });
$('#pdfBtn')?.addEventListener('click', async () => {
  const report = $('#report');
  if (!report || report.classList.contains('hidden')) return toast('No report to export.');
  if (!window.html2pdf) return window.print();
  toast('Generating PDF…');
  try { await window.html2pdf().set({ margin: 8, filename: `nova-fit-brief-${Date.now()}.pdf`, image: { type: 'jpeg', quality: 0.95 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } }).from(report).save(); toast('PDF downloaded.'); } catch { toast('PDF generation failed. Using print instead.'); window.print(); }
});
$('#printBtn')?.addEventListener('click', () => window.print());

function reset() {
  profileInput.value = '';
  opportunityInput.value = '';
  latestReport = null;
  latestReportSaved = false;
  counts();
  closeDialog();
  showWorkspace();
}
$$('[data-reset]').forEach((button) => button.addEventListener('click', reset));

icons();
counts();
setupPointerGlow();
setupConstellation();
renderHistory();




