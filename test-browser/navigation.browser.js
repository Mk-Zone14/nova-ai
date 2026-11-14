'use strict';

/*
 * Real-browser tests for navigation and the first-visit-to-saved-report journey: every navigation item performs its advertised
 * action, items that need a report only appear when there is one, saved reports are named after their opportunity, and a
 * dropped file cannot overwrite the wrong field. Only the model-backed API routes are mocked. Run with `npm run test:browser`.
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
const KEY = 'ocopilot-history';

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

async function open({ viewport = { width: 1280, height: 900 }, hold = false } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const control = { release: null };
  const gate = new Promise((resolve) => { control.release = resolve; });
  await page.route((url) => !url.href.startsWith(baseUrl), (route) => route.abort());
  await page.route('**/api/analyze', async (route) => {
    if (hold) await gate;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ response: JSON.stringify(MOCK.verdict) }) });
  });
  await page.route('**/api/narrative', (route) => {
    const section = JSON.parse(route.request().postData()).section;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ section, data: MOCK[section] }) });
  });
  await page.goto(baseUrl);
  return { context, page, control };
}
const nav = (page, name) => page.locator(`[data-nav="${name}"]`);
const inView = (page, selector) => page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }, selector);
const analyse = async (page) => { await page.click('#sampleDecisionBtn'); await page.click('#analyzeBtn'); await page.waitForSelector('#report:not(.hidden)'); await page.waitForFunction(() => !document.getElementById('narrativeBanner') || document.getElementById('narrativeBanner').classList.contains('hidden')); };

test('first visit: Profile, Opportunity, My reports and Home each do what they say; report-only items stay hidden', async () => {
  const { context, page } = await open();
  assert.equal(await nav(page, 'report').isVisible(), false);
  assert.equal(await nav(page, 'resources').isVisible(), false);
  await nav(page, 'profile').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'profileInput');
  await page.waitForFunction(() => { const r = document.getElementById('profileCard').getBoundingClientRect(); return r.top >= 0 && r.top < 300; });
  await nav(page, 'opportunity').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'opportunityInput');
  await nav(page, 'reports').click();
  assert.equal(await page.evaluate(() => document.getElementById('history').open), true);
  await nav(page, 'home').click();
  await page.waitForFunction(() => window.scrollY < 5);
  assert.equal(await nav(page, 'home').getAttribute('aria-current'), 'page');
  await context.close();
});

test('with a report: Resources opens that dialog and Current report returns to the report after visiting the inputs', async () => {
  const { context, page } = await open();
  await analyse(page);
  assert.equal(await nav(page, 'report').isVisible(), true);
  assert.equal(await nav(page, 'report').getAttribute('aria-current'), 'page');
  await nav(page, 'resources').click();
  assert.equal(await page.evaluate(() => document.getElementById('analysisDialog').open), true);
  assert.match(await page.locator('#dialogTitle').innerText(), /resources/i);
  await page.click('#dialogClose');
  await nav(page, 'profile').click();
  assert.equal(await page.locator('#report').isVisible(), false);
  assert.equal(await page.locator('#profileCard').isVisible(), true);
  await nav(page, 'report').click();
  assert.equal(await page.locator('#report').isVisible(), true);
  await context.close();
});

test('navigation is held while an analysis runs, so it cannot corrupt the loading view', async () => {
  const { context, page, control } = await open({ hold: true });
  await page.click('#sampleDecisionBtn');
  await page.click('#analyzeBtn');
  await page.waitForSelector('#loadingPanel:not(.hidden)');
  await nav(page, 'profile').click();
  assert.equal(await page.locator('#loadingPanel').isVisible(), true);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.match(await page.locator('#toast').innerText(), /analysis is running/i);
  control.release();
  await page.waitForSelector('#report:not(.hidden)');
  await context.close();
});

test('a saved report is named after its opportunity once the details arrive, and reopens from My reports', async () => {
  const { context, page } = await open();
  await analyse(page);
  await page.waitForFunction((key) => { const raw = localStorage.getItem(key); return raw && JSON.parse(raw)[0]?.title !== 'Analysis'; }, KEY);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), KEY);
  assert.equal(stored[0].title, MOCK.insights.opportunitySummary.role);
  await page.click('.report-actions [data-reset]');
  await nav(page, 'reports').click();
  assert.match(await page.locator('#historyList').innerText(), new RegExp(MOCK.insights.opportunitySummary.role));
  await page.click('[data-history]');
  await page.waitForSelector('#report:not(.hidden)');
  assert.equal(await page.locator('#reportTitle').innerText(), MOCK.insights.opportunitySummary.role);
  await context.close();
});

test('input guidance counts characters toward the minimum, and a file dropped on the opportunity box leaves the profile alone', async () => {
  const { context, page } = await open();
  await page.fill('#profileInput', 'short');
  assert.match(await page.locator('#profileState').innerText(), /45 more characters needed/);
  await page.fill('#profileInput', 'Priya Sharma, third-year B.Tech CS student. Skills: JavaScript, React, SQL.');
  assert.equal(await page.locator('#profileState').innerText(), 'Profile ready');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['SOMEONE ELSES RESUME TEXT THAT MUST NOT LAND IN THE PROFILE BOX'], 'cv.txt', { type: 'text/plain' }));
    document.getElementById('opportunityCard').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  assert.doesNotMatch(await page.inputValue('#profileInput'), /SOMEONE ELSES/);
  assert.match(await page.locator('#toast').innerText(), /profile box/i);
  await context.close();
});
