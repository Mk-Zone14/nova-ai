'use strict';

/*
 * Real-browser tests for responsive layout at 375, 390, 768, 1024 and 1440px: no horizontal page scroll, labelled report actions,
 * 44px touch targets for controls, and a nav that keeps the current item in view.
 * Only the model-backed API routes are mocked. Run with `npm run test:browser`.
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

const WIDTHS = [[375, 812], [390, 844], [768, 1024], [1024, 768], [1440, 900]];

async function openReport([width, height]) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: width < 800 });
  const page = await context.newPage();
  await page.route((url) => !url.href.startsWith(baseUrl), (route) => route.abort());
  await page.route('**/api/analyze', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ response: JSON.stringify(MOCK.verdict) }) }));
  await page.route('**/api/narrative', (route) => {
    const section = JSON.parse(route.request().postData()).section;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ section, data: MOCK[section] }) });
  });
  await page.goto(baseUrl);
  return { context, page };
}
async function toReport(page) {
  await page.click('#sampleDecisionBtn');
  await page.click('#analyzeBtn');
  await page.waitForSelector('#report:not(.hidden)');
  await page.waitForSelector('#narrativeBanner.hidden', { state: 'attached' });
}
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('no screen scrolls the page sideways at any tested width', async () => {
  for (const size of WIDTHS) {
    const { context, page } = await openReport(size);
    assert.equal(await noHorizontalScroll(page), 0, `landing @${size[0]}`);
    await toReport(page);
    assert.equal(await noHorizontalScroll(page), 0, `report @${size[0]}`);
    await page.click('[data-module="requirements"]');
    assert.equal(await noHorizontalScroll(page), 0, `dialog @${size[0]}`);
    await context.close();
  }
});

test('every report action shows a text label on a phone, not just an icon', async () => {
  for (const size of [WIDTHS[0], WIDTHS[1]]) {
    const { context, page } = await openReport(size);
    await toReport(page);
    const labels = await page.$$eval('.report-actions button', (buttons) => buttons.filter((b) => b.offsetParent).map((b) => {
      const visibleText = [...b.querySelectorAll('span')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.textContent.trim()).join('');
      const box = b.getBoundingClientRect();
      return { id: b.id || 'reset', text: visibleText, height: Math.round(box.height), right: Math.round(box.right) };
    }));
    assert.equal(labels.length, 6);
    for (const item of labels) {
      assert.ok(item.text.length > 1, `${item.id} has no visible label @${size[0]}`);
      assert.ok(item.height >= 44, `${item.id} is ${item.height}px tall`);
      assert.ok(item.right <= size[0], `${item.id} overflows @${size[0]}`);
    }
    await context.close();
  }
});

test('buttons, links and requirement rows are at least 44px tall on a phone', async () => {
  const { context, page } = await openReport(WIDTHS[0]);
  const measure = () => page.evaluate(() => [...document.querySelectorAll('button, a[href], summary, select')]
    .filter((e) => e.offsetParent !== null && !e.closest('dialog:not([open])') && !e.closest('[hidden]') && !e.classList.contains('skip-link'))
    .map((e) => ({ name: `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} "${(e.getAttribute('aria-label') || e.textContent).trim().slice(0, 20)}"`, h: Math.round(e.getBoundingClientRect().height) }))
    .filter((e) => e.h < 44));
  assert.deepEqual(await measure(), [], 'landing');
  await toReport(page);
  assert.deepEqual(await measure(), [], 'report');
  await page.click('[data-module="requirements"]');
  assert.deepEqual(await measure(), [], 'dialog');
  await context.close();
});

test('the scrolling nav brings the current item into view', async () => {
  const { context, page } = await openReport(WIDTHS[0]);
  await toReport(page);
  const state = await page.evaluate(() => {
    const nav = document.querySelector('.header-actions');
    const current = nav.querySelector('[aria-current="page"]');
    const n = nav.getBoundingClientRect();
    const c = current.getBoundingClientRect();
    return { text: current.textContent.trim(), inside: c.left >= n.left - 1 && c.right <= n.right + 1 };
  });
  assert.equal(state.text, 'Current report');
  assert.equal(state.inside, true);
  await context.close();
});
