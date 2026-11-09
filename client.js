/*
 * Nova AI — decision-first frontend
 * Preserves the existing API contract and report schema while changing only
 * the presentation and navigation model.
 */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
// Pure report logic lives in report-model.js (loaded before this file) so it can be unit-tested.
const {
  safe, arr, notAvailable, numberOrNull, adaptNovaReport, friendlyError, list, presentationText,
  humanizeVerdict, statusCounts, biggestConcern, nextBestAction, contextCandidate, moduleContent,
  buildAssessmentPayload, mergeNarrative, hasInsights,
  hasModernColor, modernColorToRgba, exportBlockReason, pdfTitle, pdfFilename, responseErrorMessage
} = window.NovaReport;
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

// Longer than the server's own limits (60 s per function), so a healthy request is never cut off by the browser,
// but a stalled connection can never leave the interface waiting forever.
const ANALYZE_TIMEOUT_MS = 75_000;
const SECTION_TIMEOUT_MS = 65_000;

// Errors whose message is written for the user. Anything else (a bug, a library error) is logged by name and shown generically.
class UserFacingError extends Error {}
const GENERIC_FAILURE = 'Something went wrong. Your inputs are still here—please try again.';
function userMessage(error) {
  return error instanceof UserFacingError ? friendlyError(error.message) : GENERIC_FAILURE;
}

// POSTs JSON and returns the parsed body. A user cancel rejects with the original AbortError (callers ignore it);
// a timeout, network failure or error response rejects with a UserFacingError.
async function postJson(url, payload, { signal, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new UserFacingError('The request took too long to finish. Please try again.');
      if (error?.name === 'AbortError') throw error;
      throw new UserFacingError('Could not reach Nova. Check your connection and try again. Your inputs are still here.');
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (timedOut) throw new UserFacingError('The request took too long to finish. Please try again.');
      if (error?.name === 'AbortError') throw error;
      throw new UserFacingError('The connection dropped before Nova finished. Please try again.');
    }
    if (!response.ok) throw new UserFacingError(responseErrorMessage(response.status, text));
    try { return JSON.parse(text); } catch { throw new UserFacingError('Nova received an unreadable response. Please try again.'); }
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

// Clipboard writes can be unavailable (insecure context, denied permission); say so instead of doing nothing.
function copyText(text, success, failure) {
  if (!navigator.clipboard?.writeText) { toast(failure); return; }
  navigator.clipboard.writeText(text).then(() => toast(success), () => toast(failure));
}

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
let latestHistoryId = null;
// Background (on-demand) sections. `inputs` stays in memory only — never written to storage —
// so a report restored from history cannot request more (canGenerate is false for it).
const narrative = { runId: 0, inputs: null, status: {}, controllers: new Set() };

function icons() {
  window.lucide?.createIcons();
  // Icons only decorate text that is already in the button or label; hide them from assistive technology.
  document.querySelectorAll('svg.lucide, svg[data-lucide]').forEach((svg) => {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  });
}

// Visible toast (top-layer popover so it also shows above the modal dialog) plus a persistent
// live region: screen readers announce text changes in an always-rendered region far more
// reliably than a node that toggles display:none.
function announce(message) {
  const region = $('#liveStatus');
  if (!region) return;
  region.textContent = '';
  window.setTimeout(() => { region.textContent = message; }, 40);
}
function toast(message, duration = 2800) {
  const element = $('#toast');
  announce(message);
  if (!element) return;
  element.textContent = message;
  element.classList.remove('hidden');
  try { if (typeof element.showPopover === 'function' && !element.matches(':popover-open')) element.showPopover(); } catch { /* top layer unsupported: fixed positioning still applies */ }
  window.clearTimeout(element._toastTimer);
  element._toastTimer = window.setTimeout(() => {
    try { if (typeof element.hidePopover === 'function' && element.matches(':popover-open')) element.hidePopover(); } catch { /* already hidden */ }
    element.classList.add('hidden');
    element.textContent = '';
  }, duration);
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
      toast('The PDF reader is not available in this browser session. Paste your resume text instead.');
      return null;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
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
    // Name only: the error object can carry document details, and a resume is personal data.
    console.error('PDF extraction failed:', error?.name || 'UnknownError');
    toast(error?.name === 'PasswordException'
      ? 'This PDF is password-protected. Remove the password or paste your resume text instead.'
      : 'Could not read this PDF. Try a text-based PDF or paste your resume directly.');
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

[profileInput, opportunityInput].forEach((field) => field?.addEventListener('input', () => field.removeAttribute('aria-invalid')));
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


function loading(show) {
  $('#loadingPanel')?.classList.toggle('hidden', !show);
  $('#loadingPanel')?.setAttribute('aria-busy', String(show));
  $('#workspace')?.classList.toggle('hidden', show);
  // The control that started the analysis is about to be hidden; keep keyboard and screen-reader focus on the status heading.
  if (show) window.requestAnimationFrame(() => $('#loadingTitle')?.focus({ preventScroll: true }));
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

async function runAnalysis() {
  if (abortController) return; // an analysis is already running: never start a duplicate request
  const profile = profileInput.value.trim();
  const opportunity = opportunityInput.value.trim();
  const rejectInput = (fields, message) => {
    fields.forEach((field) => field.setAttribute('aria-invalid', 'true'));
    fields[0].focus(); // take keyboard and screen-reader users to the problem, not just a toast
    toast(message);
  };
  const missing = [profileInput, opportunityInput].filter((field) => !field.value.trim());
  if (missing.length) { rejectInput(missing, missing.length === 2 ? 'Add both your profile and an opportunity first.' : `Add ${missing[0] === profileInput ? 'your profile' : 'the opportunity'} first.`); return; }
  if (profile.length < 50) { rejectInput([profileInput], 'Your profile seems too short. Add more detail for a useful analysis.'); return; }
  if (opportunity.length < 50) { rejectInput([opportunityInput], 'The opportunity description seems too short. Paste the full description.'); return; }
  $('#errorCard')?.classList.add('hidden');
  $('#report')?.classList.add('hidden');
  resetNarrative(null);
  latestReportSaved = false;
  latestHistoryId = null;
  startLoading();
  abortController = new AbortController();
  try {
    const data = await postJson('/api/analyze', { profile, opportunity }, { signal: abortController.signal, timeoutMs: ANALYZE_TIMEOUT_MS });
    if (!data?.response) throw new UserFacingError('The analysis returned no result. Please try again.');
    renderReport(adaptNovaReport(data), { save: true, inputs: { profile, opportunity } });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    // Log the kind of failure only (never request content), then show a message the user can act on.
    if (!(error instanceof UserFacingError)) console.error('Analysis failed unexpectedly:', error?.name || 'UnknownError');
    const errorMessage = $('#errorMessage');
    if (errorMessage) errorMessage.textContent = userMessage(error);
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

const dialog = $('#analysisDialog');
let activeModule = null;
function closeDialog() { activeModule = null; if (dialog?.open) dialog.close(); }
function paintModule(module) {
  const content = moduleContent(module, latestReport, uiState());
  setText('#dialogTitle', content.title);
  setText('#dialogSubtitle', content.subtitle);
  setHTML('#dialogContent', content.html);
  icons();
}
function openModule(module) {
  if (!latestReport) return;
  activeModule = module;
  paintModule(module);
  if (typeof dialog?.showModal === 'function') dialog.showModal();
  else dialog?.setAttribute('open', '');
  $('#dialogClose')?.focus();
}
// One delegated handler: the dialog body is re-rendered whenever a background section arrives.
$('#dialogContent')?.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('#coverLetterCopy, [data-action]') : null;
  if (!target) return;
  if (target.id === 'coverLetterCopy') {
    const text = latestReport?.coverLetter || '';
    copyText(text, 'Cover letter copied.', 'Could not copy the cover letter.');
    return;
  }
  const section = { 'generate-cover-letter': 'coverLetter', 'generate-interview': 'interview', 'retry-insights': 'insights' }[target.dataset.action];
  if (section) loadSection(section);
});
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
  return entry.id;
}
function updateHistory(id, report) {
  if (id == null) return;
  const entries = historyEntries();
  const index = entries.findIndex((item) => item.id === id);
  if (index === -1) return;
  entries[index] = { ...entries[index], score: numberOrNull(report?.overallMatchScore), report };
  storage.set('ocopilot-history', JSON.stringify(entries));
}
$('#clearHistory')?.addEventListener('click', () => { storage.remove('ocopilot-history'); renderHistory(); toast('History cleared from this device.'); });

// ---- on-demand sections ----------------------------------------------------------------------
function resetNarrative(inputs) {
  narrative.runId += 1;
  narrative.controllers.forEach((controller) => controller.abort());
  narrative.controllers.clear();
  narrative.inputs = inputs;
  narrative.status = {};
}
function uiState() {
  const state = { ...narrative.status, canGenerate: Boolean(narrative.inputs) };
  if (!state.insights && latestReport && !hasInsights(latestReport)) state.insights = narrative.inputs ? 'loading' : 'unavailable';
  return state;
}
function renderInsightPanels() {
  const report = latestReport || {};
  const candidate = contextCandidate(report);
  const role = report.opportunitySummary?.role || report.opportunityName || 'Eligibility assessment';
  const organization = report.opportunitySummary?.organization || 'Opportunity';
  setText('#reportTitle', role);
  setText('#reportSubtitle', `${organization} · evidence-based candidate analysis`);
  setText('#contextOpportunity', role);
  setText('#contextOpportunityMeta', [organization, report.opportunitySummary?.deadline].filter(Boolean).join(' · ') || 'Opportunity brief analyzed');
  setText('#contextCandidate', candidate.name);
  setText('#contextCandidateMeta', candidate.meta);
  const pending = ['loading', 'error', 'unavailable'].includes(uiState().insights);
  const status = uiState().insights;
  const countsData = statusCounts(report);
  const strengths = arr(report.strengths);
  const gaps = arr(report.missingSkills);
  const risks = arr(report.riskAnalysis);
  const documents = arr(report.requiredDocuments);
  const waiting = { loading: 'Preparing…', error: 'Could not be prepared · Open to retry', unavailable: 'Not saved with this analysis' }[status];

  setText('#moduleRequirementsMeta', countsData.total ? `${countsData.met} / ${countsData.total} matched · View evidence` : 'No requirements mapped');
  if (pending) {
    ['Strengths', 'Gaps', 'Documents', 'Risks', 'Resources'].forEach((name) => setText(`#module${name}Meta`, waiting));
    setText('#moduleStrategyMeta', 'Cover letter · Interview prep · On request');
  } else {
    const weaknessCount = arr(report.weaknesses).length;
    setText('#moduleStrengthsMeta', `${strengths.length} strength${strengths.length === 1 ? '' : 's'} · ${weaknessCount} weakness${weaknessCount === 1 ? '' : 'es'} · View evidence`);
    setText('#moduleGapsMeta', `${gaps.length} important gap${gaps.length === 1 ? '' : 's'} · View analysis`);
    setText('#moduleDocumentsMeta', `${documents.length} required · View checklist`);
    setText('#moduleRisksMeta', `${risks.length} identified · View risks`);
    const resourceCount = arr(report.learningResources).length;
    setText('#moduleResourcesMeta', resourceCount ? `${resourceCount} resource${resourceCount === 1 ? '' : 's'} · View links` : 'No resources returned');
    setText('#moduleStrategyMeta', 'Strategy · Cover letter · Interview prep');
  }

  const concern = biggestConcern(report);
  setText('#biggestConcern', pending && concern === notAvailable() ? waiting : concern);
  const action = nextBestAction(report);
  setText('#nextBestAction', pending && action === notAvailable() ? waiting : action);

  const resumeStrength = pending ? null : numberOrNull(report.resumeStrength?.score);
  const ats = pending ? null : numberOrNull(report.atsReadiness?.score);
  setText('#resumeStrScore', resumeStrength === null ? '—' : resumeStrength);
  setText('#atsScore', ats === null ? '—' : ats);
  const resumeMeter = $('#resumeStrMeter');
  const atsMeter = $('#atsMeter');
  if (resumeMeter) resumeMeter.style.width = resumeStrength === null ? '0%' : `${resumeStrength}%`;
  if (atsMeter) atsMeter.style.width = ats === null ? '0%' : `${ats}%`;
  setText('#resumeStrLabel', pending ? waiting : resumeStrength === null ? notAvailable() : resumeStrength >= 75 ? 'Strong resume — well-structured and detailed.' : resumeStrength >= 50 ? 'Adequate resume — some improvements needed.' : 'Resume quality needs attention.');
  setText('#atsLabel', pending ? waiting : ats === null ? notAvailable() : ats >= 75 ? 'Good ATS compatibility — your resume should parse well.' : ats >= 50 ? 'Moderate ATS readiness — optimize keywords and formatting.' : 'ATS readiness needs attention.');
  setHTML('#resumeStrHighlights', pending ? '' : list(report.resumeStrength?.highlights, 'No highlights identified.'));
  setHTML('#resumeStrWeaknesses', pending ? '' : list(report.resumeStrength?.weaknesses, 'No improvement areas identified.'));
  setHTML('#atsIssues', pending ? '' : list(report.atsReadiness?.issues, 'No ATS issues identified.'));
  setHTML('#atsSuggestions', pending ? '' : list(report.atsReadiness?.suggestions, 'No ATS suggestions identified.'));
  updateExportButtons();
}
const EXPORT_BUTTONS = ['copyBtn', 'jsonBtn', 'pdfBtn', 'printBtn'];
// Exports stay focusable (aria-disabled, not disabled) so keyboard users hear why they are unavailable.
function updateExportButtons() {
  const reason = exportBlockReason(uiState());
  EXPORT_BUTTONS.forEach((id) => {
    const button = $(`#${id}`);
    if (!button) return;
    if (reason) { button.setAttribute('aria-disabled', 'true'); button.title = reason; }
    else { button.removeAttribute('aria-disabled'); button.removeAttribute('title'); }
  });
}
// True (after telling the user why) when an export must not run yet.
function exportBlocked() {
  const reason = exportBlockReason(uiState());
  if (reason) toast(reason, 5000);
  return Boolean(reason);
}
function refreshNarrativeUI() {
  renderInsightPanels();
  if (!activeModule || !dialog?.open) return;
  const content = $('#dialogContent');
  const hadFocus = content?.contains(document.activeElement);
  paintModule(activeModule);
  if (hadFocus && !content.contains(document.activeElement)) $('#dialogClose')?.focus();
}
async function loadSection(section) {
  if (!latestReport || !narrative.inputs || narrative.status[section] === 'loading') return;
  const run = narrative.runId;
  const controller = new AbortController();
  narrative.controllers.add(controller);
  narrative.status[section] = 'loading';
  refreshNarrativeUI();
  try {
    const body = await postJson('/api/narrative', { ...narrative.inputs, section, assessment: buildAssessmentPayload(latestReport) }, { signal: controller.signal, timeoutMs: SECTION_TIMEOUT_MS });
    if (run !== narrative.runId) return;
    if (body?.section !== section || !body.data || typeof body.data !== 'object') throw new UserFacingError('This section returned no result. Please try again.');
    latestReport = mergeNarrative(latestReport, body.data, section);
    window.latestReport = latestReport;
    delete narrative.status[section];
    updateHistory(latestHistoryId, latestReport);
    announce({ insights: 'Analysis details are ready.', coverLetter: 'Cover letter is ready.', interview: 'Interview preparation is ready.' }[section] || 'Section is ready.');
  } catch (error) {
    if (error?.name === 'AbortError' || run !== narrative.runId) return;
    narrative.status[section] = 'error';
    if (!(error instanceof UserFacingError)) console.error('Section failed unexpectedly:', error?.name || 'UnknownError');
    if (section !== 'insights') toast(userMessage(error), 5000);
    else announce('Analysis details could not be prepared. Open Strengths or Gaps to try again.');
  } finally {
    narrative.controllers.delete(controller);
    if (run === narrative.runId) refreshNarrativeUI();
  }
}

function renderReport(report, { save = false, inputs = null } = {}) {
  latestReport = report || {};
  window.latestReport = latestReport;
  const countsData = statusCounts(latestReport);
  const fit = numberOrNull(latestReport.overallMatchScore);
  const readiness = numberOrNull(latestReport.applicationReadiness);
  const confidence = numberOrNull(latestReport.confidenceScore);
  const verdict = humanizeVerdict(latestReport.eligibilityVerdict || 'Assessment pending');

  resetNarrative(inputs);
  setText('#execVerdict', verdict);
  setText('#execRecommendation', latestReport.executiveRecommendation || latestReport.verdictReason || latestReport.finalVerdict || 'Your decision-ready overview will appear here.');
  countTo($('#execScore'), fit);
  setText('#decisionEligibility', verdict);
  setText('#decisionRequirements', countsData.total ? `${countsData.met} / ${countsData.total}` : 'Not mapped');
  setText('#decisionConfidence', confidence === null ? notAvailable() : `${confidence}%`);
  setText('#contextReadiness', latestReport.readinessCategory ? presentationText(latestReport.readinessCategory) : (readiness === null ? notAvailable() : `${readiness}% ready`));
  renderInsightPanels();

  document.body.classList.remove('analysis-mode');
  document.body.classList.add('report-mode');
  $('#workspace')?.classList.add('hidden');
  $('#report')?.classList.remove('hidden');
  $('#errorCard')?.classList.add('hidden');
  if (save && !latestReportSaved) { latestHistoryId = saveHistory(latestReport); latestReportSaved = true; renderHistory(); }
  icons();
  if (inputs) loadSection('insights');
  window.requestAnimationFrame(() => $('#report')?.focus({ preventScroll: true }));
}

function reportText() { return NovaReport.buildReportText(latestReport || {}); }
function download(content, type, name) {
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(new Blob([content], { type }));
  link.href = objectUrl;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
$('#copyBtn')?.addEventListener('click', () => exportBlocked() || copyText(reportText(), 'Fit brief copied.', 'Could not copy the brief.'));
$('#jsonBtn')?.addEventListener('click', () => { if (!latestReport) return toast('No report to export.'); if (exportBlocked()) return; download(JSON.stringify(latestReport, null, 2), 'application/json', 'nova-fit-brief.json'); toast('JSON downloaded.'); });
// html2canvas throws on colour functions it cannot parse (color(), lab(), ...). Resolve them to rgba()
// in the private clone it renders; gradients and shadows that use them are dropped there.
function resolveModernColor(value) {
  const exact = modernColorToRgba(value);
  if (exact) return exact;
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  context.canvas.width = context.canvas.height = 1;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
}
const PDF_COLOR_PROPERTIES = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color'];
const PDF_DROP_PROPERTIES = ['background-image', 'box-shadow', 'border-image-source'];
// Stylesheet injected into html2canvas's private clone document only (never the live page). With transitions running,
// the inline colour overrides below start a transition, and for a frame computed colours are interpolated in oklab(),
// which html2canvas cannot parse. Animations are also stopped so the snapshot is deterministic.
const PDF_STABLE_STYLES = '.pdf-export, .pdf-export *, .pdf-export *::before, .pdf-export *::after { transition: none !important; animation: none !important; }';
function prepareCloneForPdf(clonedDocument) {
  const view = clonedDocument.defaultView;
  const stable = clonedDocument.createElement('style');
  stable.textContent = PDF_STABLE_STYLES;
  clonedDocument.head.appendChild(stable);
  // 'important' so the replacement also beats any !important rule in the stylesheet.
  clonedDocument.querySelectorAll('*').forEach((element) => {
    const style = view.getComputedStyle(element);
    PDF_COLOR_PROPERTIES.forEach((property) => {
      const value = style.getPropertyValue(property);
      if (hasModernColor(value)) element.style.setProperty(property, resolveModernColor(value), 'important');
    });
    PDF_DROP_PROPERTIES.forEach((property) => {
      if (hasModernColor(style.getPropertyValue(property))) element.style.setProperty(property, 'none', 'important');
    });
  });
}
const PDF_AVOID_BREAKS = ['.decision-hero', '.report-context', '.analysis-module', '.supplemental-card', '.module-heading'];
let pdfExporting = false;
const PDF_EXPORT_MARK = 'data-nova-pdf-export';
// html2pdf 0.10.1 and html2canvas 1.4.1 only remove their overlay and iframe when rendering succeeds, so a failed
// export leaves a fixed, pointer-capturing overlay over the page. Remove exactly what this export created:
// the overlay holding our uniquely marked clone, and html2canvas iframes that did not exist before we started.
function removeExportArtifacts(mark, iframesBefore) {
  document.querySelectorAll(`.html2pdf__overlay [${PDF_EXPORT_MARK}="${mark}"]`).forEach((node) => node.closest('.html2pdf__overlay')?.remove());
  document.querySelectorAll('iframe.html2canvas-container').forEach((frame) => { if (!iframesBefore.has(frame)) frame.remove(); });
}
async function exportPdf() {
  const report = $('#report');
  if (!report || report.classList.contains('hidden') || !latestReport) return toast('No report to export.');
  if (exportBlocked() || pdfExporting) return;
  if (!window.html2pdf) {
    // Intentional fallback (not a failure): the PDF library did not load, so use the browser's own PDF printing.
    toast('The PDF library is unavailable, so the print dialog is opening. Choose “Save as PDF”.', 5000);
    return window.print();
  }
  pdfExporting = true;
  const button = $('#pdfBtn');
  button?.setAttribute('aria-busy', 'true');
  toast('Generating PDF…', 15000);
  const mark = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const iframesBefore = new Set(document.querySelectorAll('iframe.html2canvas-container'));
  try {
    // Render a private clone so the on-screen report is untouched; `.pdf-export` (styles.css) hides controls and sets print-safe colours.
    const clone = report.cloneNode(true);
    clone.removeAttribute('id');
    clone.setAttribute(PDF_EXPORT_MARK, mark);
    clone.classList.add('pdf-export');
    clone.querySelectorAll('details').forEach((details) => { details.open = true; });
    await window.html2pdf().set({
      margin: [10, 8, 12, 8],
      filename: pdfFilename(latestReport),
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, onclone: prepareCloneForPdf },
      pagebreak: { mode: ['css', 'legacy'], avoid: PDF_AVOID_BREAKS },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    }).from(clone).toPdf().get('pdf').then((pdf) => {
      pdf.setProperties({ title: pdfTitle(latestReport), subject: 'Opportunity fit brief', creator: 'Nova AI' });
    }).save();
    toast('PDF downloaded.');
  } catch (error) {
    // A real failure: report it (message only — never report content) and let the user choose; do not auto-open print.
    console.error('PDF export failed:', error?.name || 'UnknownError', String(error?.message || '').slice(0, 200));
    toast('PDF export failed. Please try again, or use Print and choose “Save as PDF”.', 6000);
  } finally {
    removeExportArtifacts(mark, iframesBefore);
    pdfExporting = false;
    button?.removeAttribute('aria-busy');
  }
}
$('#pdfBtn')?.addEventListener('click', exportPdf);
$('#printBtn')?.addEventListener('click', () => { if (!exportBlocked()) window.print(); });

function reset() {
  profileInput.value = '';
  opportunityInput.value = '';
  latestReport = null;
  latestReportSaved = false;
  latestHistoryId = null;
  resetNarrative(null);
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




