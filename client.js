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
  humanizeVerdict, statusCounts, requirementsGlance, biggestConcern, nextBestAction, reportHeader, narrativeBanner, historyTitle, moduleContent,
  buildAssessmentPayload, mergeNarrative, hasInsights,
  hasModernColor, modernColorToRgba, exportBlockReason, pdfTitle, pdfFilename, responseErrorMessage,
  HISTORY_KEY, normalizeHistory, addHistoryEntry, removeHistoryEntry
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
  // role="img" lets the label stand in for the number while it counts up, so a screen reader hears the final score once.
  element.setAttribute('aria-label', `Fit score ${finalText} out of 100`);
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

// An inline message under a field: unlike a toast it stays until the problem is fixed, and screen readers hear it.
function fieldMessage(field, text, kind = 'info') {
  const element = $(field === profileInput ? '#profileMessage' : '#opportunityMessage');
  if (!element) return;
  element.textContent = text || '';
  element.hidden = !text;
  element.dataset.kind = text ? kind : '';
}
let profileSource = null; // file name of an uploaded resume, shown with the profile status
function counts() {
  const pc = $('#profileCount');
  const oc = $('#opportunityCount');
  if (pc) pc.textContent = `${profileInput.value.length.toLocaleString()} / 8,000`;
  if (oc) oc.textContent = `${opportunityInput.value.length.toLocaleString()} / 12,000`;
  for (const [element, field] of [[pc, profileInput], [oc, opportunityInput]]) {
    const max = Number(field.maxLength);
    element?.classList.toggle('near-limit', field.value.length >= max * 0.9);
  }
  const MIN_CHARS = 50; // the same minimum runAnalysis enforces
  const stateText = (value, ready, empty) => {
    const length = value.trim().length;
    if (!length) return { text: empty, ready: false };
    if (length < MIN_CHARS) return { text: `${MIN_CHARS - length} more characters needed`, ready: false };
    return { text: ready, ready: true };
  };
  for (const [selector, field, ready, empty] of [['#profileState', profileInput, 'Profile ready', 'Waiting for profile'], ['#opportunityState', opportunityInput, 'Brief ready', 'Waiting for opportunity']]) {
    const element = $(selector);
    if (!element) continue;
    const state = stateText(field.value, ready, empty);
    element.textContent = state.ready && field === profileInput && profileSource ? `${state.text} · ${profileSource}` : state.text;
    element.classList.toggle('ready', state.ready);
  }
}

function loadSample(kind, { announce = true } = {}) {
  if (kind === 'profile' || kind === 'resume') profileInput.value = samples[kind];
  else opportunityInput.value = samples[kind];
  counts();
  if (announce) toast(`Sample ${kind} loaded.`);
}

// Explicit scroll options override CSS scroll-behavior, so reduced motion has to be honoured here as well.
function scrollMode() { return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; }

function showWorkspace({ scroll = true } = {}) {
  document.body.classList.remove('report-mode', 'analysis-mode');
  $('#report')?.classList.add('hidden');
  $('#errorCard')?.classList.add('hidden');
  $('#workspace')?.classList.remove('hidden');
  if (scroll) $('#workspace')?.scrollIntoView({ behavior: scrollMode(), block: 'start' });
}

function loadSampleDecision() {
  showWorkspace({ scroll: false });
  loadSample('profile', { announce: false });
  loadSample('internship', { announce: false });
  $('#workspace')?.scrollIntoView({ behavior: scrollMode(), block: 'start' });
  toast('Sample profile and opportunity loaded. Review them, then build the brief.');
}

$$('[data-sample]').forEach((button) => {
  button.addEventListener('click', () => {
    loadSample(button.dataset.sample);
    button.closest('details')?.removeAttribute('open');
  });
});
$('#sampleDecisionBtn')?.addEventListener('click', loadSampleDecision);
$('#sampleDecisionHero')?.addEventListener('click', loadSampleDecision);
profileInput?.addEventListener('input', counts);
opportunityInput?.addEventListener('input', counts);

// A fixed, full-page canvas behind everything: a slow constellation that leans toward the pointer, scrolls with the page
// (parallax), leaves a short trail behind the pointer, and lets the visitor add stars and ripples by clicking open space.
function setupConstellation() {
  const canvas = $('#constellationField');
  if (!canvas) return;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');
  const hint = $('#constellationHint');
  const pointer = { x: -9999, y: -9999, active: false, since: 0 };
  let trail = []; // marks the pointer leaves behind; each drifts up and fades
  let travel = { x: -9999, y: -9999, since: 0 };
  let scrollY = window.scrollY;
  let nodes = [];
  let stars = []; // nodes the visitor adds by clicking; they fade out on their own
  let ripples = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let last = 0;
  const MAX_STARS = 10;
  const STAR_LIFE = 14000;
  const RIPPLE_MS = 1000;
  const RIPPLE_REACH = 300;
  const GLOW_DECAY = 0.02;
  const TRAIL_LIFE = 1400;
  const TRAIL_GAP = 34; // pointer travel between two marks, in px
  const MAX_TRAIL = 60;
  const PARALLAX = 0.12; // how far the field moves per px of page scroll, so it feels attached to the page
  const paletteForTheme = () => document.documentElement.dataset.theme === 'light'
    ? { node: 'rgba(50, 60, 80, 1)', line: 'rgba(50, 60, 80, 0.58)', hot: '60, 90, 150', active: 'rgba(62, 86, 141, 0.7)' }
    : { node: 'rgba(205, 218, 242, 1)', line: 'rgba(165, 185, 225, 0.7)', hot: '180, 200, 255', active: 'rgba(209, 220, 242, 0.9)' };
  const nodeCount = () => Math.min(coarse.matches ? 36 : 84, Math.max(22, Math.floor((width * height) / 18000)));
  // Text and cards: static lines and nodes inside these are drawn faintly so the field never competes with copy.
  const QUIET_SELECTOR = '.hero-copy, .sample-decision, .trust-strip, .input-card, .decision-hero, .report-context, .requirements-glance, .module-grid, .supplemental-grid, .preparation-details, .history-card, .loading-panel, .error-card';
  let quiet = [];
  let quietDirty = true;
  const measureQuiet = () => {
    quiet = [...$$(QUIET_SELECTOR)].filter((el) => el.offsetParent !== null).map((el) => el.getBoundingClientRect())
      .filter((r) => r.bottom > -12 && r.top < height + 12)
      .map((r) => ({ left: r.left - 12, right: r.right + 12, top: r.top - 12, bottom: r.bottom + 12 }));
    buildGrid();
    quietDirty = false;
  };
  // Coarse grid so the many per-frame lookups cost one array read each, not a scan of every rectangle.
  const CELL = 20;
  let grid = new Uint8Array(0);
  let gridCols = 0;
  const buildGrid = () => {
    gridCols = Math.ceil(width / CELL) + 1;
    const rows = Math.ceil(height / CELL) + 1;
    grid = new Uint8Array(gridCols * rows);
    for (const r of quiet) {
      const x0 = Math.max(0, Math.floor(r.left / CELL)); const x1 = Math.min(gridCols - 1, Math.floor(r.right / CELL));
      const y0 = Math.max(0, Math.floor(r.top / CELL)); const y1 = Math.min(rows - 1, Math.floor(r.bottom / CELL));
      for (let y = y0; y <= y1; y += 1) grid.fill(1, y * gridCols + x0, y * gridCols + x1 + 1);
    }
  };
  const inQuiet = (p) => {
    const x = Math.floor(p.x / CELL); const y = Math.floor(p.y / CELL);
    return x >= 0 && y >= 0 && x < gridCols && grid[y * gridCols + x] === 1;
  };
  const QUIET_ALPHA = 0.2;
  const LIVE_QUIET_ALPHA = 0.55; // interaction stays visible over text, at reduced strength
  const makeNode = (x, y, extra = {}) => ({ x, y, vx: (Math.random() - 0.5) * 0.035, vy: (Math.random() - 0.5) * 0.035, phase: Math.random() * Math.PI * 2, ox: 0, oy: 0, ovx: 0, ovy: 0, glow: 0, ...extra });
  const at = (node) => ({ x: node.x + node.ox, y: node.y + node.oy });

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    nodes = Array.from({ length: nodeCount() }, (_, index) => nodes[index] || makeNode(Math.random() * width, Math.random() * height));
    quietDirty = true;
    render(performance.now());
  }

  function step(node, time, movement, interactive) {
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
    if (!interactive) return;
    // Interaction moves a node by an offset that springs back to rest, so nothing snaps or drifts away for good.
    let targetX = 0;
    let targetY = 0;
    if (pointer.active) {
      const dx = pointer.x - (node.x + node.ox);
      const dy = pointer.y - (node.y + node.oy);
      const distance = Math.hypot(dx, dy);
      if (distance > 0 && distance < 230) {
        const lean = distance < 70 ? -(70 - distance) / 70 * 26 : Math.sin((distance - 70) / 160 * Math.PI) * 30;
        targetX = dx / distance * lean;
        targetY = dy / distance * lean;
      }
    }
    node.ovx = (node.ovx + (targetX - node.ox) * 0.035) * 0.86;
    node.ovy = (node.ovy + (targetY - node.oy) * 0.035) * 0.86;
    node.glow = Math.max(0, node.glow - GLOW_DECAY);
    for (const ripple of ripples) {
      const age = (time - ripple.born) / RIPPLE_MS;
      const p = at(node);
      const away = Math.hypot(p.x - ripple.x, p.y - ripple.y) || 1;
      const gap = away - age * RIPPLE_REACH;
      if (Math.abs(gap) < 30 && age < 1) {
        const push = (1 - Math.abs(gap) / 30) * (1 - age) * 1.6;
        node.ovx += (p.x - ripple.x) / away * push;
        node.ovy += (p.y - ripple.y) / away * push;
        node.glow = 1;
      }
    }
    node.ox += node.ovx;
    node.oy += node.ovy;
  }
  function starFade(node, time) {
    if (!node.born) return 1;
    const age = time - node.born;
    return Math.min(1, age / 500, (STAR_LIFE - age) / 3000);
  }

  function drawTrail(time, palette) {
    trail = trail.filter((mark) => time - mark.born < TRAIL_LIFE);
    canvas.dataset.trail = String(trail.length);
    for (const mark of trail) {
      const life = (time - mark.born) / TRAIL_LIFE;
      const ease = 1 - life * life;
      const y = mark.y - life * 26;
      const calm = inQuiet(mark) ? 0.55 : 1;
      context.fillStyle = `rgba(${palette.hot}, ${0.75 * ease * calm})`;
      context.beginPath();
      context.arc(mark.x + Math.sin(mark.phase + life * 4) * 3, y, mark.size * (1 - life * 0.5), 0, Math.PI * 2);
      context.fill();
      if (mark.size > 2) {
        context.strokeStyle = `rgba(${palette.hot}, ${0.35 * ease * calm})`;
        context.lineWidth = 1;
        context.beginPath();
        context.arc(mark.x, y, mark.size + life * 14, 0, Math.PI * 2);
        context.stroke();
      }
    }
  }

  function render(time) {
    const delta = Math.min(32, time - last || 16);
    last = time;
    const palette = paletteForTheme();
    if (quietDirty) measureQuiet();
    context.clearRect(0, 0, width, height);
    const movement = reduce.matches ? 0 : delta;
    const interactive = !reduce.matches;
    stars = stars.filter((star) => time - star.born < STAR_LIFE);
    ripples = ripples.filter((ripple) => time - ripple.born < RIPPLE_MS);
    const all = [...nodes, ...stars];
    all.forEach((node) => step(node, time, movement, interactive));

    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = at(all[i]);
        const b = at(all[j]);
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > 160) continue;
        const proximity = pointer.active ? Math.max(0, 1 - Math.hypot((a.x + b.x) / 2 - pointer.x, (a.y + b.y) / 2 - pointer.y) / 180) : 0;
        const fade = Math.max(starFade(all[i], time), 0) * Math.max(starFade(all[j], time), 0);
        context.strokeStyle = proximity > 0.05 ? `rgba(${palette.hot}, ${0.1 + proximity * 0.24})` : palette.line;
        context.lineWidth = proximity > 0.05 ? 1.6 : 1;
        const calm = inQuiet(a) || inQuiet(b);
        const live = proximity > 0.05 || all[i].born || all[j].born;
        context.globalAlpha = (calm ? (live ? LIVE_QUIET_ALPHA : QUIET_ALPHA) : 1) * fade * (1 - distance / 240);
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
    }

    // The pointer is a node too: it tethers to the nearest few stars.
    if (pointer.active && interactive) {
      const near = all.map((node) => ({ p: at(node) }))
        .map((entry) => ({ ...entry, d: Math.hypot(entry.p.x - pointer.x, entry.p.y - pointer.y) }))
        .filter((entry) => entry.d < 190).sort((x, y) => x.d - y.d).slice(0, 5);
      near.forEach(({ p, d }) => {
        context.strokeStyle = `rgba(${palette.hot}, ${0.55 * (1 - d / 190)})`;
        context.lineWidth = 1.2;
        context.globalAlpha = inQuiet(p) ? LIVE_QUIET_ALPHA : 1;
        context.beginPath();
        context.moveTo(pointer.x, pointer.y);
        context.lineTo(p.x, p.y);
        context.stroke();
      });
    }
    context.globalAlpha = 1;

    ripples.forEach((ripple) => {
      const age = (time - ripple.born) / RIPPLE_MS;
      context.strokeStyle = `rgba(${palette.hot}, ${0.42 * (1 - age)})`;
      context.lineWidth = 1.4;
      context.beginPath();
      context.arc(ripple.x, ripple.y, age * RIPPLE_REACH, 0, Math.PI * 2);
      context.stroke();
    });

    all.forEach((node) => {
      const p = at(node);
      const distance = pointer.active ? Math.hypot(p.x - pointer.x, p.y - pointer.y) : 9999;
      const active = distance < 140 || node.glow > 0.05;
      context.fillStyle = active ? palette.active : palette.node;
      context.globalAlpha = (inQuiet(p) ? (active || node.born ? LIVE_QUIET_ALPHA : QUIET_ALPHA) : 1) * Math.max(starFade(node, time), 0);
      context.beginPath();
      context.arc(p.x, p.y, (active ? 4 : 2.2) + node.glow * 2.5 + (node.born ? 1.6 : 0), 0, Math.PI * 2);
      context.fill();
    });
    context.globalAlpha = 1;

    if (interactive) drawTrail(time, palette);
  }
  // The only place a frame is scheduled. Everything else calls render() directly, so a resize or theme change can never start a second loop.
  function tick(time) {
    frame = 0;
    render(time);
    if (!reduce.matches && !document.hidden) frame = requestAnimationFrame(tick);
  }

  function start() { if (!frame) frame = requestAnimationFrame(tick); }
  function stop() { cancelAnimationFrame(frame); frame = 0; }
  function onPointerMove(event) {
    pointer.x = event.clientX; pointer.y = event.clientY; pointer.active = true;
    if (reduce.matches) return;
    // Leave a mark every TRAIL_GAP px of travel (denser while the button is held), never a mark per event.
    const moved = Math.hypot(pointer.x - travel.x, pointer.y - travel.y);
    const gap = event.buttons ? TRAIL_GAP / 2 : TRAIL_GAP;
    if (moved > gap) {
      travel = { x: pointer.x, y: pointer.y, since: performance.now() };
      trail.push({ x: pointer.x, y: pointer.y, born: travel.since, size: event.buttons ? 2.6 + Math.random() * 1.6 : 1.4 + Math.random() * 1.4, phase: Math.random() * Math.PI * 2 });
      if (trail.length > MAX_TRAIL) trail.shift();
      canvas.dataset.trail = String(trail.length);
    }
    if (!document.hidden && !frame) start();
  }
  function onScroll() {
    const next = window.scrollY;
    const shift = (next - scrollY) * PARALLAX;
    scrollY = next;
    quietDirty = true;
    if (reduce.matches || !shift) return;
    for (const node of nodes) {
      node.y -= shift;
      if (node.y < -20) node.y += height + 40;
      if (node.y > height + 20) node.y -= height + 40;
    }
    for (const star of stars) star.y -= shift;
    for (const mark of trail) mark.y -= shift;
    if (!document.hidden && !frame) start();
  }
  function onPointerLeave() { pointer.active = false; }
  // Click or tap on open space: a ripple pushes the nearby stars, and a new star joins the web for a while.
  const SOLID = 'a, button, summary, input, textarea, select, label, details, dialog, header, p, h1, h2, h3, li, table, [data-pointer-card], .input-card, .report, .history-card';
  function onPointerDown(event) {
    if (reduce.matches || event.button > 0 || !(event.target instanceof Element) || event.target.closest(SOLID)) return;
    const x = event.clientX; const y = event.clientY;
    const now = performance.now();
    ripples.push({ x, y, born: now });
    stars.push(makeNode(x, y, { born: now }));
    if (stars.length > MAX_STARS) stars.shift();
    canvas.dataset.stars = String(stars.length);
    hint?.classList.add('is-used');
    pointer.x = x; pointer.y = y; pointer.active = true;
    if (!frame) start();
  }
  function onPointerUp(event) { if (event.pointerType === 'touch') pointer.active = false; }

  resize();
  if (hint) {
    hint.textContent = coarse.matches ? 'Tap the background to add a star' : 'Click empty space to add a star';
    hint.hidden = reduce.matches;
  }
  canvas.dataset.stars = '0';
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onPointerLeave, { passive: true });
  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  new MutationObserver(() => { quietDirty = true; }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (!reduce.matches) start(); });
  reduce.addEventListener?.('change', () => { if (hint) hint.hidden = reduce.matches; ripples = []; stars = []; trail = []; resize(); if (reduce.matches) stop(); else start(); });
  const themeObserver = new MutationObserver(() => render(performance.now()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (!reduce.matches) start();
}

// The sample menu is a <details>: close it on Escape (returning focus to its button) and when the user clicks elsewhere.
const sampleMenu = $('.sample-menu');
sampleMenu?.addEventListener('keydown', (event) => { if (event.key === 'Escape' && sampleMenu.open) { sampleMenu.open = false; sampleMenu.querySelector('summary')?.focus(); } });
document.addEventListener('click', (event) => { if (sampleMenu?.open && !sampleMenu.contains(event.target)) sampleMenu.open = false; });

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
  const fail = (message) => { fieldMessage(profileInput, message, 'error'); toast(message); };
  const LIMIT = 8000; // keep in step with the textarea maxlength (asserted by test/quality.test.js)
  // Loads extracted text into the profile and says plainly if the field limit cut any of it off.
  const accept = (text, label) => {
    profileInput.value = text.slice(0, 8000);
    profileSource = file.name;
    counts();
    profileInput.removeAttribute('aria-invalid');
    if (text.length > LIMIT) {
      fieldMessage(profileInput, `${file.name} has ${text.length.toLocaleString()} characters. Only the first ${LIMIT.toLocaleString()} were kept; check that what matters is included.`, 'warning');
      toast(`${label} Only the first ${LIMIT.toLocaleString()} characters were kept.`, 5000);
    } else {
      fieldMessage(profileInput, '');
      toast(label);
    }
  };
  if (!isPdf && !isText) { fail('Please upload a TXT, Markdown, or PDF resume.'); return; }
  if (f.size > 2000000) { fail('File is too large. Please choose a file smaller than 2 MB.'); return; }
  if (isPdf) {
    toast('Reading PDF…');
    const text = await extractTextFromPDF(file);
    if (text && text.length > 10) accept(text, `Resume extracted from PDF (${text.length.toLocaleString()} characters).`);
    else if (text !== null) fail('This PDF looks empty or image-based. Paste your resume text instead.');
    return;
  }
  if (file.size > 500000) { fail('Choose a text file smaller than 500 KB.'); return; }
  try {
    accept(await file.text(), 'Resume added and ready for analysis.');
  } catch {
    fail('Could not read this file. Please try a different format.');
  }
}

[profileInput, opportunityInput].forEach((field) => field?.addEventListener('input', () => {
  field.removeAttribute('aria-invalid');
  if (field === profileInput && !field.value.trim()) { profileSource = null; counts(); }
  const atLimit = field.value.length >= Number(field.maxLength);
  fieldMessage(field, atLimit ? `Limit of ${Number(field.maxLength).toLocaleString()} characters reached. Anything beyond it is not kept.` : '', 'warning');
}));
$('#resumeUpload')?.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  event.target.value = ''; // choosing the same file again must still fire a change
  addResumeFile(file);
});
$$('.input-card').forEach((card) => {
  const accepts = card.id === 'profileCard';
  let depth = 0; // dragenter/dragleave fire for every child element, so count them to avoid flicker
  card.addEventListener('dragenter', () => { depth += 1; if (accepts) card.classList.add('drag-over'); });
  card.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = accepts ? 'copy' : 'none'; });
  card.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) card.classList.remove('drag-over'); });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    card.classList.remove('drag-over');
    // A resume only ever belongs in the profile box; dropping it on the opportunity box must not silently replace the profile.
    if (!accepts) { if (event.dataTransfer.files?.length) toast('Drop your resume on the profile box. Paste the opportunity text here.'); return; }
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
    fieldMessage(fields[0], message, 'error');
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
  const controller = new AbortController();
  abortController = controller;
  try {
    const data = await postJson('/api/analyze', { profile, opportunity }, { signal: controller.signal, timeoutMs: ANALYZE_TIMEOUT_MS });
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
    // A cancelled run has already been cleaned up; it must not tear down a newer analysis that started after the cancel.
    if (abortController === controller) {
      abortController = null;
      stopLoading();
    }
  }
}
$('#analyzeBtn')?.addEventListener('click', runAnalysis);
$('#retryBtn')?.addEventListener('click', runAnalysis);
$('#narrativeRetry')?.addEventListener('click', () => loadSection('insights'));
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
const MODULE_ORDER = [['requirements', 'Evidence'], ['risks', 'Blockers'], ['strategy', 'Next moves'], ['strengths', 'Strengths & weaknesses'], ['gaps', 'Gaps'], ['documents', 'Documents'], ['resources', 'Resources']];
function paintModuleNav(module) {
  const index = MODULE_ORDER.findIndex(([name]) => name === module);
  for (const [id, offset, arrow] of [['#dialogPrev', -1, '←'], ['#dialogNext', 1, '→']]) {
    const target = MODULE_ORDER[(index + offset + MODULE_ORDER.length) % MODULE_ORDER.length];
    const button = $(id);
    if (!button) continue;
    button.dataset.target = target[0];
    button.textContent = offset < 0 ? `${arrow} ${target[1]}` : `${target[1]} ${arrow}`;
  }
}
function paintModule(module) {
  paintModuleNav(module);
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
  $('#moduleGrid')?.scrollIntoView({ behavior: scrollMode(), block: 'start' });
  $('#moduleGrid [data-module="requirements"]')?.focus();
});
$('#editInputsBtn')?.addEventListener('click', () => {
  showWorkspace();
  profileInput?.focus({ preventScroll: true });
});
$('#dialogClose')?.addEventListener('click', closeDialog);
['#dialogPrev', '#dialogNext'].forEach((id) => $(id)?.addEventListener('click', (event) => {
  const target = event.currentTarget.dataset.target;
  if (!target || !latestReport) return;
  activeModule = target;
  paintModule(target);
  $('#dialogContent').scrollTop = 0;
  setText('#liveStatus', '');
  announce(`${$('#dialogTitle').textContent} opened.`);
}));
dialog?.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
dialog?.addEventListener('cancel', closeDialog);

function renderHistory() {
  const element = $('#historyList');
  if (!element) return;
  const entries = historyEntries(); // prunes expired and malformed entries before anything is shown
  element.innerHTML = entries.length ? entries.map((entry) => `<div class="history-item"><button data-history="${safe(entry.id)}" aria-label="Restore analysis: ${safe(entry.title)}, score ${safe(entry.score ?? 'Not available')}"><strong>${safe(entry.title)}</strong><span>${safe(entry.score == null ? 'Not available' : `${entry.score}/100`)} · ${safe(humanizeVerdict(entry.verdict || 'Analysis'))} · ${safe(entry.timestamp || 'Saved')}</span></button><button class="history-remove" data-history-remove="${safe(entry.id)}" aria-label="Delete saved analysis: ${safe(entry.title)}">Delete</button></div>`).join('') : '<span class="empty">No saved analyses yet.</span>';
  const action = $('#historySummaryAction');
  if (action) action.textContent = entries.length ? `${entries.length} saved` : 'None yet';
  const clear = $('#clearHistory');
  if (clear) clear.hidden = !entries.length;
  $$('[data-history]').forEach((button) => button.addEventListener('click', () => {
    if (abortController) { toast('An analysis is running. Cancel it or wait for it to finish first.'); return; }
    const entry = historyEntries().find((item) => String(item.id) === String(button.dataset.history));
    if (!entry) { renderHistory(); toast('That saved analysis has expired or was removed.'); return; }
    renderReport(entry.report, { save: false });
    $('#report')?.scrollIntoView({ behavior: scrollMode(), block: 'start' });
  }));
  $$('[data-history-remove]').forEach((button) => button.addEventListener('click', () => {
    writeHistory(removeHistoryEntry(historyEntries(), button.dataset.historyRemove));
    renderHistory();
    toast('Saved analysis deleted from this device.');
  }));
}
// The only reader of the history store. Expired, malformed and legacy entries are removed or migrated here, so display,
// restore and update can never see them (see normalizeHistory in report-model.js for the policy).
function historyEntries() {
  const { entries, changed } = normalizeHistory(storage.get(HISTORY_KEY), Date.now());
  if (changed) writeHistory(entries);
  return entries;
}
function writeHistory(entries) {
  if (entries.length) storage.set(HISTORY_KEY, JSON.stringify(entries));
  else storage.remove(HISTORY_KEY);
}
function saveHistory(report) {
  const title = historyTitle(report);
  const entry = { id: Date.now(), title, score: numberOrNull(report?.overallMatchScore), verdict: humanizeVerdict(report?.eligibilityVerdict || 'Analysis'), timestamp: new Date().toLocaleString(), report };
  writeHistory(addHistoryEntry(historyEntries(), entry, entry.id));
  return entry.id;
}
function updateHistory(id, report) {
  if (id == null) return;
  const entries = historyEntries();
  const index = entries.findIndex((item) => item.id === id);
  if (index === -1) return; // deleted or expired meanwhile: never resurrect it
  // Spread keeps savedAt/expiresAt: editing an entry does not extend how long it is kept.
  const title = historyTitle(report);
  entries[index] = { ...entries[index], ...(title === 'Analysis' ? {} : { title }), score: numberOrNull(report?.overallMatchScore), report };
  writeHistory(entries);
}
$('#clearHistory')?.addEventListener('click', () => { storage.remove(HISTORY_KEY); renderHistory(); toast('History cleared from this device.'); });

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
function renderNarrativeBanner(status) {
  const banner = $('#narrativeBanner');
  if (!banner) return;
  const state = narrativeBanner(status);
  banner.classList.toggle('hidden', !state);
  banner.dataset.kind = state?.kind || '';
  setText('#narrativeBannerText', state?.text || '');
  const retry = $('#narrativeRetry');
  if (retry) retry.hidden = !state?.canRetry;
}
function renderInsightPanels() {
  const report = latestReport || {};
  const status = uiState().insights;
  const header = reportHeader(report, status);
  setText('#reportTitle', header.title);
  setText('#reportSubtitle', header.subtitle);
  setText('#contextOpportunity', header.opportunity);
  setText('#contextOpportunityMeta', header.opportunityMeta);
  setText('#contextCandidate', header.candidate);
  setText('#contextCandidateMeta', header.candidateMeta);
  $('#report')?.classList.toggle('details-pending', status === 'loading');
  renderNarrativeBanner(status);
  const pending = ['loading', 'error', 'unavailable'].includes(status);
  const countsData = statusCounts(report);
  const strengths = arr(report.strengths);
  const gaps = arr(report.missingSkills);
  const risks = arr(report.riskAnalysis);
  const documents = NovaReport.documentGroups(report);
  const waiting = { loading: 'Generating…', error: 'Could not be prepared · Open to retry', unavailable: 'Not saved with this analysis' }[status];

  setText('#moduleRequirementsMeta', countsData.total ? `${countsData.met} / ${countsData.total} matched · View evidence` : 'No requirements mapped');
  if (pending) {
    ['Strengths', 'Gaps', 'Documents', 'Risks', 'Resources'].forEach((name) => setText(`#module${name}Meta`, waiting));
    setText('#moduleStrategyMeta', 'Cover letter · Interview prep · On request');
  } else {
    const weaknessCount = arr(report.weaknesses).length;
    setText('#moduleStrengthsMeta', `${strengths.length} strength${strengths.length === 1 ? '' : 's'} · ${weaknessCount} weakness${weaknessCount === 1 ? '' : 'es'} · View evidence`);
    setText('#moduleGapsMeta', `${gaps.length} important gap${gaps.length === 1 ? '' : 's'} · View analysis`);
    setText('#moduleDocumentsMeta', `${documents.fromOpportunity.length} from the opportunity · ${documents.suggested.length} suggested · View checklist`);
    setText('#moduleRisksMeta', `${risks.length} identified · View risks`);
    const resourceCount = NovaResources.resolveResources(report).length;
    setText('#moduleResourcesMeta', resourceCount ? `${resourceCount} resource${resourceCount === 1 ? '' : 's'} · View links` : 'No skill gaps');
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
    renderHistory();
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
  setText('#decisionRequirements', NovaReport.requirementsMatchText(latestReport) || (countsData.total ? `${countsData.met} / ${countsData.total}` : 'Not mapped'));
  setText('#decisionConfidence', confidence === null ? notAvailable() : `${confidence}%`);
  const match = NovaReport.requirementsMatch(latestReport);
  $('#decisionRequirements')?.setAttribute('title', match?.fitExplanation || '');
  $('#decisionConfidence')?.setAttribute('title', match?.evidenceExplanation || 'Share of requirement statuses that rest on a quote verified in your profile. Not confidence in the verdict.');
  setText('#contextReadiness', latestReport.readinessCategory ? presentationText(latestReport.readinessCategory) : (readiness === null ? notAvailable() : `${readiness}% ready`));
  const glance = requirementsGlance(latestReport);
  setHTML('#glanceList', glance.html);
  const more = $('#glanceMore');
  if (more) { more.hidden = !glance.hidden; more.textContent = glance.hidden ? `${glance.hidden} more in the evidence view.` : ''; }
  $('#requirementsGlance')?.classList.toggle('hidden', !glance.total);
  $('.callout.concern')?.setAttribute('data-severity', /not[\s_-]*eligible/i.test(String(latestReport.eligibilityVerdict || '')) ? 'blocking' : 'normal');
  renderInsightPanels();

  document.body.classList.remove('analysis-mode');
  document.body.classList.add('report-mode');
  $('#workspace')?.classList.add('hidden');
  $('#report')?.classList.remove('hidden');
  $('#errorCard')?.classList.add('hidden');
  if (save && !latestReportSaved) { latestHistoryId = saveHistory(latestReport); latestReportSaved = true; renderHistory(); }
  icons();
  updateNav();
  if (inputs) { loadSection('insights'); announce('Assessment ready. Supporting details are loading.'); }
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
  profileSource = null;
  fieldMessage(profileInput, '');
  fieldMessage(opportunityInput, '');
  latestReport = null;
  latestReportSaved = false;
  latestHistoryId = null;
  resetNarrative(null);
  counts();
  closeDialog();
  showWorkspace();
  updateNav();
}
$$('[data-reset]').forEach((button) => button.addEventListener('click', reset));

// ---- primary navigation: every item performs one action with existing behaviour -----------------
function showReport() {
  if (!latestReport) return;
  document.body.classList.remove('analysis-mode');
  document.body.classList.add('report-mode');
  $('#workspace')?.classList.add('hidden');
  $('#report')?.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: scrollMode() });
  window.requestAnimationFrame(() => $('#report')?.focus({ preventScroll: true }));
}
function updateNav() {
  const hasReport = Boolean(latestReport) && !abortController;
  const reportVisible = document.body.classList.contains('report-mode');
  $$('[data-nav="report"], [data-nav="resources"]').forEach((item) => { item.hidden = !hasReport; });
  $$('[data-nav]').forEach((item) => {
    const current = (item.dataset.nav === 'report' && reportVisible) || (item.dataset.nav === 'home' && !reportVisible);
    if (current) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  // On narrow screens the nav scrolls sideways; keep the current item visible. Set scrollLeft directly, because scrollIntoView
  // would also scroll the page vertically.
  const nav = $('.header-actions');
  const active = nav?.querySelector('[aria-current="page"]');
  if (nav && active && nav.scrollWidth > nav.clientWidth) {
    const target = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, target), behavior: scrollMode() });
  }
}
function focusInput(card, field) {
  showWorkspace({ scroll: false });
  $(card)?.scrollIntoView({ behavior: scrollMode(), block: 'start' });
  field?.focus({ preventScroll: true });
}
$$('[data-nav]').forEach((item) => item.addEventListener('click', (event) => {
  event.preventDefault();
  if (abortController) { toast('An analysis is running. Cancel it or wait for it to finish first.'); return; }
  switch (item.dataset.nav) {
    case 'home': showWorkspace({ scroll: false }); window.scrollTo({ top: 0, behavior: scrollMode() }); break;
    case 'profile': focusInput('#profileCard', profileInput); break;
    case 'opportunity': focusInput('#opportunityCard', opportunityInput); break;
    case 'reports': { const history = $('#history'); if (history) history.open = true; history?.scrollIntoView({ behavior: scrollMode(), block: 'start' }); $('#history > summary')?.focus({ preventScroll: true }); break; }
    case 'report': showReport(); break;
    case 'resources': openModule('resources'); break;
    default: break;
  }
  updateNav();
}));
new MutationObserver(updateNav).observe(document.body, { attributes: true, attributeFilter: ['class'] });

icons();
counts();
updateNav();
setupConstellation();
renderHistory();




