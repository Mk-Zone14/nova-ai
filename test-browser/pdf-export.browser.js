'use strict';

/*
 * Real-browser tests for PDF export. They load the actual Nova page in Chromium and use the real,
 * vendored html2pdf.js / html2canvas: the library is never replaced by a stub. Failures are produced by
 * injecting faults into the browser's canvas APIs, so they originate inside html2canvas's own rendering.
 * The only wrapper around html2pdf is a pass-through that counts how often it is invoked.
 *
 * These tests are not part of `npm test` (they need a browser). Run them with:
 *   npm install --no-save playwright@1.63.0 && npx playwright install chromium   # once; not an app dependency
 *   npm run test:browser
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  throw new Error('These tests need Playwright: `npm install --no-save playwright && npx playwright install chromium`.');
}

const ROOT = path.join(__dirname, '..');
const MOCK = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mock-api.json'), 'utf8'));
const PROFILE = 'Priya Sharma, third-year B.Tech CS student at DTU. Skills: JavaScript, React, Python, SQL. Built dashboards.';
const OPPORTUNITY = 'Product Engineering Intern at Atlas Labs. Requires JavaScript or Python, SQL fundamentals, 15 hours per week. Preferred React.';
const SECTIONS = { insights: MOCK.insights, coverLetter: MOCK.coverLetter, interview: MOCK.interview };

let server;
let browser;
let baseUrl;

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

test.before(async () => {
  const port = await freePort();
  server = spawn(process.execPath, ['local-dev.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), GROQ_API_KEY: 'browser-test-key' }, stdio: 'ignore' });
  baseUrl = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(baseUrl)).ok) break; } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
});

test.after(async () => {
  await browser?.close();
  server?.kill();
});

/** Opens Nova with mocked API responses (the PDF library is the real one), analyses, and waits until exports are enabled. */
async function openReport() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseUrl), (route) => route.abort());
  await page.route('**/api/analyze', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ response: JSON.stringify(MOCK.verdict) }) }));
  await page.route('**/api/narrative', (route) => {
    const section = JSON.parse(route.request().postData()).section;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ section, data: SECTIONS[section] }) });
  });
  await page.goto(baseUrl);
  await page.fill('#profileInput', PROFILE);
  await page.fill('#opportunityInput', OPPORTUNITY);
  await page.click('#analyzeBtn');
  await page.waitForSelector('#report:not(.hidden)');
  await page.waitForFunction(() => document.querySelector('#pdfBtn').getAttribute('aria-disabled') !== 'true');
  // The score counts up; wait for it to settle so DOM snapshots are stable.
  await page.waitForFunction(() => { const score = document.querySelector('#execScore'); return score && score.textContent === score.getAttribute('aria-label'); });
  // Count calls into the real html2pdf (pass-through: it still runs the real library).
  await page.evaluate(() => {
    const real = window.html2pdf;
    window.__html2pdfCalls = 0;
    const counted = function (...args) { window.__html2pdfCalls += 1; return real.apply(this, args); };
    Object.assign(counted, real);
    window.html2pdf = counted;
  });
  return { context, page, pageErrors };
}

/** Faults injected into canvas APIs used by html2canvas's real rendering. 1x1 canvases (the app's own colour probe) are exempt. */
async function setFault(page, kind) {
  await page.evaluate((fault) => {
    if (!window.__faultInstalled) {
      window.__faultInstalled = true;
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (window.__novaFault === 'context' && type === '2d' && !(this.width === 1 && this.height === 1)) throw new Error('injected-context-failure');
        return getContext.call(this, type, ...rest);
      };
      const fillRect = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function (...args) {
        if (window.__novaFault === 'paint' && this.canvas.width > 1) throw new Error('injected-paint-failure');
        return fillRect.apply(this, args);
      };
    }
    window.__novaFault = fault;
  }, kind);
}

const leftovers = (page) => page.evaluate(() => ({
  overlays: document.querySelectorAll('.html2pdf__overlay').length,
  containers: document.querySelectorAll('.html2pdf__container').length,
  iframes: document.querySelectorAll('iframe').length
}));
const NONE = { overlays: 0, containers: 0, iframes: 0 };

/** Clicks Export PDF and waits until the export has settled (button no longer busy and a result announced). Fails fast on the wrong outcome. */
async function exportAndSettle(page, { expect }) {
  let download = null;
  page.once('download', (d) => { download = d; });
  await page.click('#pdfBtn');
  await page.waitForFunction(() => /PDF downloaded|PDF export failed/.test(document.querySelector('#liveStatus').textContent) && !document.querySelector('#pdfBtn').hasAttribute('aria-busy'), null, { timeout: 90_000 });
  const status = await page.textContent('#liveStatus');
  assert.match(status, expect === 'success' ? /PDF downloaded/ : /PDF export failed/, `unexpected export outcome: ${status}`);
  if (expect === 'success') {
    for (let i = 0; i < 100 && !download; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(download, 'a download was triggered');
  }
  return download;
}

const interactive = async (page) => {
  // Real user-level click on an app control: Playwright refuses to click if another element intercepts the pointer.
  await page.click('[data-module="requirements"]', { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.getElementById('analysisDialog').open), true, 'the click reached the app and opened the dialog');
  await page.click('#dialogClose', { timeout: 3000 });
};

test('success path: a PDF is produced and nothing is left behind', async () => {
  const { context, page, pageErrors } = await openReport();
  try {
    const download = await exportAndSettle(page, { expect: 'success' });
    assert.match(download.suggestedFilename(), /^nova-fit-brief-.*\d{4}-\d{2}-\d{2}\.pdf$/);
    assert.equal(fs.readFileSync(await download.path()).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(await leftovers(page), NONE);
    assert.equal(await page.getAttribute('#pdfBtn', 'aria-busy'), null);
    assert.equal(await page.evaluate(() => document.querySelector('#report').classList.contains('pdf-export')), false, 'the live report is never styled for export');
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

for (const fault of ['context', 'paint']) {
  test(`failure inside html2canvas (${fault} fault): cleanup, toast, page interactive, retry works`, async () => {
    const { context, page, pageErrors } = await openReport();
    try {
      const reportBefore = await page.evaluate(() => document.querySelector('#report').innerHTML);
      await setFault(page, fault);
      await exportAndSettle(page, { expect: 'failure' });

      // 1. Nothing created by the export remains.
      assert.deepEqual(await leftovers(page), NONE);
      // 2. The failure is reported, visibly.
      assert.match(await page.textContent('#toast').catch(() => ''), /PDF export failed\. Please try again, or use Print/);
      assert.equal(await page.isVisible('#toast'), true);
      // 3. The original report is untouched and its handlers still work; the page is immediately usable.
      assert.equal(await page.evaluate(() => document.querySelector('#report').innerHTML), reportBefore);
      await interactive(page);
      // 4. The export button is back to normal.
      assert.equal(await page.getAttribute('#pdfBtn', 'aria-busy'), null);
      assert.equal(await page.getAttribute('#pdfBtn', 'aria-disabled'), null);

      // 5. Retry while the fault persists: the operation really starts again and fails cleanly again.
      await exportAndSettle(page, { expect: 'failure' });
      assert.equal(await page.evaluate(() => window.__html2pdfCalls), 2);
      assert.deepEqual(await leftovers(page), NONE);

      // 6. Retry once the fault is gone: succeeds.
      await setFault(page, null);
      const download = await exportAndSettle(page, { expect: 'success' });
      assert.equal(fs.readFileSync(await download.path()).subarray(0, 5).toString(), '%PDF-');
      assert.deepEqual(await leftovers(page), NONE);

      // 7. The Edit inputs button receives the click and returns to the form.
      await page.click('#editInputsBtn', { timeout: 3000 });
      assert.equal(await page.isVisible('#profileInput'), true);
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

test('double click starts exactly one export', async () => {
  const { context, page } = await openReport();
  try {
    let download = null;
    page.once('download', (d) => { download = d; });
    await page.evaluate(() => { const button = document.querySelector('#pdfBtn'); button.click(); button.click(); button.click(); });
    await page.waitForFunction(() => /PDF downloaded|PDF export failed/.test(document.querySelector('#liveStatus').textContent) && !document.querySelector('#pdfBtn').hasAttribute('aria-busy'), null, { timeout: 90_000 });
    assert.match(await page.textContent('#liveStatus'), /PDF downloaded/);
    assert.ok(download, 'one download');
    assert.equal(await page.evaluate(() => window.__html2pdfCalls), 1);
    assert.deepEqual(await leftovers(page), NONE);
  } finally { await context.close(); }
});

test('cleanup only removes what the export created', async () => {
  const { context, page } = await openReport();
  try {
    // Unrelated elements that merely look like the library's: an app iframe, a pre-existing html2canvas iframe, a look-alike overlay.
    await page.evaluate(() => {
      const add = (html) => document.body.insertAdjacentHTML('beforeend', html);
      add('<iframe id="app-frame" src="about:blank"></iframe>');
      add('<iframe id="old-h2c" class="html2canvas-container" src="about:blank"></iframe>');
      add('<div id="lookalike" class="html2pdf__overlay"><p>not ours</p></div>');
    });
    await setFault(page, 'context');
    await exportAndSettle(page, { expect: 'failure' });
    const survivors = () => page.evaluate(() => ['app-frame', 'old-h2c', 'lookalike'].filter((id) => document.getElementById(id)));
    assert.deepEqual(await survivors(), ['app-frame', 'old-h2c', 'lookalike']);
    assert.deepEqual(await page.evaluate(() => ({ overlays: document.querySelectorAll('.html2pdf__overlay').length, iframes: document.querySelectorAll('iframe').length })), { overlays: 1, iframes: 2 }, 'only the unrelated elements remain');
    await setFault(page, null);
    await exportAndSettle(page, { expect: 'success' });
    assert.deepEqual(await survivors(), ['app-frame', 'old-h2c', 'lookalike']);
  } finally { await context.close(); }
});

test('modern colour functions under !important rules do not break the export (real library, computed result)', async () => {
  const { context, page } = await openReport();
  try {
    // Hostile author stylesheet: !important rules beat any plain inline style, so only an !important override can neutralise them.
    await page.addStyleTag({ content: '.pdf-export, .pdf-export * { color: oklch(0.45 0.2 30) !important; border-color: color-mix(in oklab, red 40%, blue) !important; background-color: color(display-p3 1 0.5 0 / 0.15) !important; }' });

    // Control: without the app's sanitiser the real library cannot render this page. (Proves the stylesheet is effective.)
    const control = await page.evaluate(async () => {
      const clone = document.querySelector('#report').cloneNode(true);
      clone.removeAttribute('id'); clone.classList.add('pdf-export');
      try { await window.html2pdf().set({ html2canvas: { scale: 1 } }).from(clone).toPdf(); return 'rendered'; } catch (error) { return String(error?.message || error); }
    });
    assert.match(control, /unsupported color function/i, `control should fail inside html2canvas, got: ${control}`);
    // The control run leaked its own overlay (the library bug); remove it so it cannot influence the app run.
    await page.evaluate(() => document.querySelectorAll('.html2pdf__overlay, iframe.html2canvas-container').forEach((element) => element.remove()));

    // The app's export succeeds through the same real library and produces a valid PDF.
    const download = await exportAndSettle(page, { expect: 'success' });
    assert.equal(fs.readFileSync(await download.path()).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(await leftovers(page), NONE);
  } finally { await context.close(); }
});

test('transition-enabled elements with unsupported computed colours export successfully, and the live page keeps its transitions', async () => {
  const { context, page } = await openReport();
  try {
    // Reproduces the regression: module buttons have CSS transitions; their authored colours are unsupported (oklch/color-mix/p3).
    await page.addStyleTag({ content: '.analysis-module { transition: color 400ms, background-color 400ms, border-color 400ms !important; color: oklch(0.5 0.2 250); background-color: color-mix(in oklab, red 30%, blue); border-color: color(display-p3 0.2 0.8 0.4); }' });
    const live = () => page.evaluate(() => {
      const button = document.querySelector('.analysis-module');
      return { transition: getComputedStyle(button).transitionDuration, color: getComputedStyle(button).color, stableStyleInLiveDoc: [...document.querySelectorAll('style')].some((node) => node.textContent.includes('animation: none')) };
    });
    await page.waitForTimeout(700); // let the live button finish its own transition to the new colours
    const before = await live();
    assert.match(before.transition, /0\.4s/);
    assert.equal(before.stableStyleInLiveDoc, false);

    const download = await exportAndSettle(page, { expect: 'success' });
    assert.equal(fs.readFileSync(await download.path()).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(await leftovers(page), NONE);
    // The live application is unchanged: same transitions, same colours, no injected export styles.
    assert.deepEqual(await live(), before);
  } finally { await context.close(); }
});

test('export-only styles reach the private clone document, not the live page', async () => {
  const { context, page } = await openReport();
  try {
    // Observe the real html2canvas clone document through the library's own onclone hook (pass-through; the library still renders).
    await page.evaluate(() => {
      const counted = window.html2pdf;
      window.__clone = null;
      window.html2pdf = function (...args) {
        const worker = counted.apply(this, args);
        const set = worker.set.bind(worker);
        worker.set = (options) => {
          const original = options.html2canvas.onclone;
          options.html2canvas.onclone = (doc) => {
            original(doc);
            const probe = doc.querySelector('.pdf-export .analysis-module');
            const cs = doc.defaultView.getComputedStyle(probe);
            window.__clone = { transition: cs.transitionDuration, animationName: cs.animationName, hasStyle: [...doc.querySelectorAll('style')].some((n) => n.textContent.includes('animation: none')) };
          };
          return set(options);
        };
        return worker;
      };
      Object.assign(window.html2pdf, counted);
    });
    await exportAndSettle(page, { expect: 'success' });
    assert.deepEqual(await page.evaluate(() => window.__clone), { transition: '0s', animationName: 'none', hasStyle: true });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.analysis-module')).transitionDuration !== '0s'), true, 'live buttons still transition');
  } finally { await context.close(); }
});
