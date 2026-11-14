'use strict';

/*
 * Real-browser tests for honest loading states: the report must not show generic stand-ins as final information while the
 * supporting details load, the failure banner must offer a working retry, and a duplicate click must not start a second
 * analysis. Only the model-backed API routes are mocked. Run with `npm run test:browser`.
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
const GENERIC = /^(Eligibility assessment|Opportunity|Candidate profile|Not available from Nova\.)$/;

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

/** `narrative` decides each /api/narrative reply: 'hold' (until release()), 'fail', or 'ok'. */
async function open({ viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const control = { mode: 'hold', analyzeCalls: 0, narrativeCalls: 0, release: null };
  let gate = new Promise((resolve) => { control.release = resolve; });
  await page.route((url) => !url.href.startsWith(baseUrl), (route) => route.abort());
  await page.route('**/api/analyze', async (route) => {
    control.analyzeCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ response: JSON.stringify(MOCK.verdict) }) });
  });
  await page.route('**/api/narrative', async (route) => {
    control.narrativeCalls += 1;
    const section = JSON.parse(route.request().postData()).section;
    if (control.mode === 'hold') await gate;
    if (control.mode === 'fail') return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ section, data: MOCK[section] }) });
  });
  await page.goto(baseUrl);
  return { context, page, control };
}

const startAnalysis = async (page) => { await page.click('#sampleDecisionBtn'); await page.click('#analyzeBtn'); await page.waitForSelector('#report:not(.hidden)'); };
const text = (page, selector) => page.locator(selector).innerText();

test('the landing sample is labelled as an illustration, never as a live analysis', async () => {
  const { context, page } = await open();
  const card = await text(page, '#sample-decision');
  assert.match(card, /Illustrative example/i);
  assert.match(card, /Not a real analysis/i);
  assert.doesNotMatch(card, /\blive\b/i);
  assert.match(card, /Example score/i);
  await context.close();
});

test('while details load, the header says so, the banner has no retry, and nothing generic is shown as final', async () => {
  const { context, page, control } = await open();
  await startAnalysis(page);
  assert.match(await text(page, '#reportTitle'), /Reading opportunity details/);
  assert.match(await text(page, '#contextCandidate'), /Loading candidate information/);
  assert.equal(await page.locator('#narrativeBanner').isVisible(), true);
  assert.match(await text(page, '#narrativeBannerText'), /Assessment ready/);
  assert.equal(await page.locator('#narrativeRetry').isVisible(), false);
  assert.doesNotMatch(await text(page, '#reportTitle'), GENERIC);
  // The decision itself is already complete and is not hidden behind the loading state.
  assert.match(await text(page, '#execVerdict'), /\S/);
  control.mode = 'ok'; control.release();
  await page.waitForFunction(() => !/Reading opportunity/.test(document.getElementById('reportTitle').textContent));
  assert.equal(await text(page, '#reportTitle'), MOCK.insights.opportunitySummary.role);
  assert.equal(await page.locator('#narrativeBanner').isVisible(), false);
  await context.close();
});

test('the report title never flashes a generic stand-in on the way to the real name', async () => {
  const { context, page, control } = await open();
  await page.evaluate(() => {
    window.__titles = [];
    new MutationObserver(() => window.__titles.push(document.getElementById('reportTitle').textContent))
      .observe(document.getElementById('reportTitle'), { childList: true, characterData: true, subtree: true });
  });
  await startAnalysis(page);
  control.mode = 'ok'; control.release();
  await page.waitForFunction(() => window.__titles.at(-1) === window.latestReport?.opportunitySummary?.role);
  const titles = await page.evaluate(() => window.__titles);
  assert.deepEqual(titles.filter((title) => GENERIC.test(title)), [], `saw ${JSON.stringify(titles)}`);
  await context.close();
});

test('a failed details request leaves the assessment intact, says so, and Try again recovers', async () => {
  const { context, page, control } = await open();
  control.mode = 'fail';
  await startAnalysis(page);
  await page.waitForSelector('#narrativeRetry:not([hidden])');
  assert.match(await text(page, '#narrativeBannerText'), /could not be prepared/);
  assert.match(await text(page, '#narrativeBannerText'), /assessment above is unaffected/);
  assert.doesNotMatch(await text(page, '#reportTitle'), /Reading/);
  assert.match(await text(page, '#execVerdict'), /\S/);
  assert.equal(await page.locator('#narrativeBanner').getAttribute('data-kind'), 'error');
  const before = control.narrativeCalls;
  control.mode = 'ok';
  await page.click('#narrativeRetry');
  await page.waitForFunction(() => document.getElementById('narrativeBanner').classList.contains('hidden'));
  assert.equal(control.narrativeCalls, before + 1, 'retry makes exactly one new request');
  assert.equal(await text(page, '#reportTitle'), MOCK.insights.opportunitySummary.role);
  await context.close();
});

test('clicking Build twice starts one analysis, and Cancel then a fresh run still completes', async () => {
  const { context, page, control } = await open();
  control.mode = 'ok';
  await page.click('#sampleDecisionBtn');
  await page.evaluate(() => { const b = document.getElementById('analyzeBtn'); b.click(); b.click(); });
  await page.waitForSelector('#report:not(.hidden)');
  assert.equal(control.analyzeCalls, 1, 'duplicate click must not start a second request');
  await page.click('.report-actions [data-reset]');
  await page.click('#sampleDecisionBtn');
  await page.click('#analyzeBtn');
  await page.click('#cancelLoading');
  await page.click('#analyzeBtn');
  await page.waitForSelector('#report:not(.hidden)');
  assert.equal(await page.locator('#loadingPanel').isVisible(), false);
  assert.match(await text(page, '#execVerdict'), /\S/);
  await context.close();
});
