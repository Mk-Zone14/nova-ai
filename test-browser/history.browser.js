'use strict';

/*
 * Real-browser tests for the saved-history retention policy (30 days, delete one, clear all). They load the actual
 * Nova page in Chromium with the real localStorage; only the analysis API is mocked (as in the PDF tests).
 * Run with `npm run test:browser` (see pdf-export.browser.js for one-off Playwright setup).
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
const KEY = 'ocopilot-history';
const DAY = 24 * 60 * 60 * 1000;

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

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseUrl), (route) => route.abort());
  await page.route('**/api/analyze', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ response: JSON.stringify(MOCK.verdict) }) }));
  await page.route('**/api/narrative', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto(baseUrl);
  return { context, page, pageErrors };
}

/** Runs one real analysis so the app itself writes a saved entry; returns the stored entries. */
async function analyse(page) {
  await page.fill('#profileInput', PROFILE);
  await page.fill('#opportunityInput', OPPORTUNITY);
  await page.click('#analyzeBtn');
  await page.waitForSelector('#report:not(.hidden)');
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), KEY);
  return stored(page);
}
const stored = (page) => page.evaluate((key) => { const raw = localStorage.getItem(key); return raw === null ? null : JSON.parse(raw); }, KEY);
const seed = (page, value) => page.evaluate(([key, raw]) => localStorage.setItem(key, raw), [KEY, typeof value === 'string' ? value : JSON.stringify(value)]);
// The history panel is a collapsed <details> that is available from the initial state; open it to interact with entries.
const openHistory = (page) => page.evaluate(() => { document.querySelector('.history-card').open = true; });
const rendered = (page) => page.$$eval('#historyList .history-item strong', (nodes) => nodes.map((node) => node.textContent));

test('a saved analysis carries a timestamp and a 30-day expiry, and the notice says so', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    const before = Date.now();
    const entries = await analyse(page);
    const after = Date.now();
    assert.equal(entries.length, 1);
    assert.ok(entries[0].savedAt >= before && entries[0].savedAt <= after);
    assert.equal(entries[0].expiresAt - entries[0].savedAt, 30 * DAY);
    assert.match(await page.textContent('#historyNotice'), /30 days/);
    assert.match(await page.textContent('#historyNotice'), /not encrypted/i);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('on startup, expired and malformed entries are deleted from storage and never shown; legacy entries are migrated', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    const [base] = await analyse(page);
    const now = Date.now();
    const make = (title, over) => ({ ...base, title, ...over });
    const legacy = (title, id) => { const { savedAt, expiresAt, ...rest } = make(title, { id }); return rest; };
    await seed(page, [
      make('Fresh', { id: now - DAY, savedAt: now - DAY, expiresAt: now - DAY + 30 * DAY }),
      make('Expired', { id: now - 40 * DAY, savedAt: now - 40 * DAY, expiresAt: now - 10 * DAY }),
      legacy('Legacy recent', now - 3 * DAY),
      legacy('Legacy ancient', now - 45 * DAY),
      { id: 'junk', report: null },
      null
    ]);
    await page.reload();
    await page.waitForSelector('#historyList .history-item', { state: 'attached' });
    assert.deepEqual(await rendered(page), ['Fresh', 'Legacy recent']);
    const after = await stored(page);
    assert.deepEqual(after.map((entry) => entry.title), ['Fresh', 'Legacy recent']);
    assert.ok(after.every((entry) => typeof entry.expiresAt === 'number' && entry.expiresAt > Date.now()), 'storage itself was cleaned, not just the view');
    assert.ok(Math.abs(after[1].savedAt - (now - 3 * DAY)) < 1000, 'legacy save time recovered from its id');
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('unreadable storage is removed on startup and the page still works', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    await seed(page, '{not json');
    await page.reload();
    await page.waitForSelector('#historyList .empty', { state: 'attached' });
    assert.equal(await stored(page).catch(() => 'unreadable'), null, 'the broken value was deleted');
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('Delete removes exactly one saved analysis, from the page and from storage', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    const [base] = await analyse(page);
    const now = Date.now();
    await seed(page, ['Alpha', 'Beta', 'Gamma'].map((title, index) => ({ ...base, title, id: now - index, savedAt: now - index, expiresAt: now - index + 30 * DAY })));
    await page.reload();
    await page.waitForSelector('#historyList .history-item', { state: 'attached' });
    await openHistory(page);
    await page.click('[aria-label="Delete saved analysis: Beta"]');
    assert.equal(await page.locator('#report').isHidden(), true, 'deleting from the initial view does not open a report');
    assert.deepEqual(await rendered(page), ['Alpha', 'Gamma']);
    assert.deepEqual((await stored(page)).map((entry) => entry.title), ['Alpha', 'Gamma']);
    await page.reload();
    assert.deepEqual(await rendered(page), ['Alpha', 'Gamma'], 'still gone after a reload');
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('Clear history removes every saved analysis and the storage key', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    await analyse(page);
    await page.reload(); // initial view: no report on screen
    assert.equal(await page.locator('#report').isHidden(), true);
    await openHistory(page);
    assert.equal(await page.locator('#historyList .history-item').count(), 1);
    await page.click('#clearHistory');
    assert.equal(await stored(page), null);
    assert.equal(await page.locator('#historyList .history-item').count(), 0);
    assert.equal(await page.locator('#clearHistory').isVisible(), false, 'nothing left to clear');
    await page.reload();
    assert.equal(await page.locator('#historyList .history-item').count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('an entry that expires while the page is open cannot be restored', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    const [base] = await analyse(page);
    const now = Date.now();
    await seed(page, [{ ...base, title: 'About to expire', id: now - 1, savedAt: now - 1, expiresAt: now + 60_000 }]);
    await page.reload();
    await page.waitForSelector('#historyList .history-item', { state: 'attached' });
    // Time passes: the stored expiry is now in the past, but the list on screen has not re-rendered yet.
    await page.evaluate(([key]) => { const entries = JSON.parse(localStorage.getItem(key)); entries[0].expiresAt = Date.now() - 1; localStorage.setItem(key, JSON.stringify(entries)); }, [KEY]);
    await openHistory(page);
    await page.click('#historyList [data-history]');
    await page.waitForFunction(() => /expired or was removed/.test(document.querySelector('#toast')?.textContent || ''));
    assert.equal(await stored(page), null, 'the expired entry was deleted when the restore was attempted');
    assert.equal(await page.locator('#historyList .history-item').count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

// ---- history is reachable from the initial state (no report, no new analysis) --------------------------------------------

const entryFor = (base, title, id, recommendation) => ({ ...base, title, id, savedAt: id, expiresAt: id + 30 * DAY, report: { ...base.report, executiveRecommendation: recommendation } });

test('with saved history and no report, the history panel is visible and lists the entries', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    const [base] = await analyse(page);
    const now = Date.now();
    await seed(page, [entryFor(base, 'Alpha', now - 1, 'Alpha recommendation'), entryFor(base, 'Beta', now - 2, 'Beta recommendation')]);
    await page.reload();
    assert.equal(await page.locator('#report').isHidden(), true, 'no report is showing');
    assert.equal(await page.locator('#workspace').isVisible(), true);
    assert.equal(await page.locator('.history-card').isVisible(), true);
    assert.equal(await page.locator('#history').evaluate((node) => node.closest('#report, #workspace')), null, 'not nested in a view that can be hidden');
    assert.match(await page.textContent('#historySummaryAction'), /2 saved/);
    await openHistory(page);
    assert.deepEqual(await rendered(page), ['Alpha', 'Beta']);
    assert.equal(await page.locator('#historyList .history-item').first().isVisible(), true);
    assert.equal(await page.locator('#clearHistory').isVisible(), true);
    assert.match(await page.textContent('#historyNotice'), /30 days/);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('with no saved history, the panel shows a short empty state and no clear button', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    assert.equal(await page.locator('.history-card').isVisible(), true);
    assert.match(await page.textContent('#historySummaryAction'), /None yet/);
    await openHistory(page);
    assert.equal((await page.textContent('#historyList')).trim(), 'No saved analyses yet.');
    assert.equal(await page.locator('#clearHistory').isVisible(), false);
    assert.equal(await page.locator('#report').isHidden(), true);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('after a reload, clicking a saved entry restores exactly that report without a new analysis', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    const [base] = await analyse(page);
    const now = Date.now();
    await seed(page, [entryFor(base, 'Alpha', now - 1, 'Alpha recommendation'), entryFor(base, 'Beta', now - 2, 'Beta recommendation')]);
    let analyseCalls = 0;
    await page.route('**/api/analyze', (route) => { analyseCalls += 1; return route.abort(); });
    await page.reload();
    await openHistory(page);
    await page.click('[aria-label^="Restore analysis: Beta"]');
    await page.waitForSelector('#report:not(.hidden)');
    assert.equal((await page.textContent('#execRecommendation')).trim(), 'Beta recommendation');
    assert.equal(await page.locator('#workspace').isHidden(), true);
    assert.equal(analyseCalls, 0, 'restoring never calls the analysis API');
    // The history stays available beside the restored report, and restoring another entry switches reports.
    assert.equal(await page.locator('.history-card').isVisible(), true);
    await openHistory(page);
    await page.click('[aria-label^="Restore analysis: Alpha"]');
    await page.waitForFunction(() => document.querySelector('#execRecommendation').textContent.trim() === 'Alpha recommendation');
    assert.equal((await stored(page)).length, 2, 'restoring does not add or remove entries');
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('the initial history view is fully keyboard operable (open, restore and delete without a mouse)', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    const [base] = await analyse(page);
    const now = Date.now();
    await seed(page, [entryFor(base, 'Alpha', now - 1, 'Alpha recommendation'), entryFor(base, 'Beta', now - 2, 'Beta recommendation')]);
    await page.reload();
    await page.focus('.history-card > summary');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.history-card').evaluate((node) => node.open), true);
    await page.focus('[aria-label="Delete saved analysis: Alpha"]');
    await page.keyboard.press('Enter');
    assert.deepEqual(await rendered(page), ['Beta']);
    await page.focus('[aria-label^="Restore analysis: Beta"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#execRecommendation').textContent.trim() === 'Beta recommendation');
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test('restoring is refused while an analysis is in flight', async () => {
  const { context, page, pageErrors } = await newPage();
  try {
    const [base] = await analyse(page);
    const now = Date.now();
    await seed(page, [entryFor(base, 'Alpha', now - 1, 'Alpha recommendation')]);
    await page.unroute('**/api/analyze');
    await page.route('**/api/analyze', () => { /* never answers: the request stays in flight */ });
    await page.reload();
    await page.fill('#profileInput', PROFILE);
    await page.fill('#opportunityInput', OPPORTUNITY);
    await page.click('#analyzeBtn');
    await page.waitForSelector('#loadingPanel:not(.hidden)');
    await openHistory(page);
    await page.locator('#historyList [data-history]').evaluate((button) => button.click());
    await page.waitForFunction(() => /analysis is running/i.test(document.querySelector('#toast')?.textContent || ''));
    assert.equal(await page.locator('#report').isHidden(), true);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
