'use strict';

/*
 * Real-browser accessibility checks that automated scanners cannot do: keyboard order, visible focus, dialog focus management,
 * announcements, accessible names and heading structure. (An axe-core scan was run separately and is reported in the phase report.)
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

async function open({ width = 1280, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
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
const activeInfo = (page) => page.evaluate(() => { const e = document.activeElement; return { tag: e.tagName, id: e.id, cls: e.className, text: (e.textContent || '').trim().slice(0, 30), inDialog: Boolean(e.closest('dialog')) }; });

test('the first Tab stop is the skip link, and it moves focus past the header', async () => {
  const { context, page } = await open();
  await page.keyboard.press('Tab');
  const first = await activeInfo(page);
  assert.match(first.cls, /skip-link/);
  await page.keyboard.press('Enter');
  const hash = await page.evaluate(() => location.hash);
  assert.equal(hash, '#workspace');
  await context.close();
});

test('every control that takes keyboard focus shows a visible focus indicator', async () => {
  const { context, page } = await open();
  await page.click('#sampleDecisionBtn');
  const missing = [];
  await page.evaluate(() => document.activeElement.blur());
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const e = document.activeElement;
      const s = getComputedStyle(e);
      const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      const ring = s.boxShadow && s.boxShadow !== 'none';
      return { name: `${e.tagName.toLowerCase()}#${e.id || ''}.${String(e.className).split(' ')[0]}`, visible: outline || ring, parentRing: Boolean(e.closest('.input-card:focus-within')) };
    });
    if (info.name.startsWith('body')) break; // tabbed out of the page into browser UI
    if (!info.visible && !info.parentRing) missing.push(info.name);
  }
  assert.deepEqual(missing, []);
  await context.close();
});

test('the evidence dialog takes focus, keeps it inside while tabbing, and returns it on Escape', async () => {
  const { context, page } = await open();
  await toReport(page);
  const opener = page.locator('[data-module="requirements"]').first();
  await opener.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open]');
  assert.equal((await activeInfo(page)).inDialog, true, 'focus moved into the dialog');
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Tab');
    // A native modal makes everything behind it inert. Past the last control focus may rest on the browser's own UI (body here),
    // but never on the page behind.
    const info = await activeInfo(page);
    assert.ok(info.inDialog || info.tag === 'BODY', `focus reached the page behind the dialog on Tab ${i + 1}: ${info.tag}#${info.id}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  const back = await page.evaluate(() => document.activeElement?.getAttribute('data-module'));
  assert.equal(back, 'requirements', 'focus returned to the control that opened the dialog');
  await context.close();
});

test('analysis results and field problems are announced through live regions', async () => {
  const { context, page } = await open();
  assert.equal(await page.locator('#liveStatus').getAttribute('aria-live'), 'polite');
  await page.click('#analyzeBtn');
  await page.waitForFunction(() => document.querySelector('#profileMessage:not([hidden])')?.textContent.trim().length > 0);
  assert.equal(await page.locator('#profileMessage').getAttribute('role'), 'status');
  await page.click('#sampleDecisionBtn');
  await page.click('#analyzeBtn');
  await page.waitForSelector('#report:not(.hidden)');
  await page.waitForFunction(() => /ready|complete|assessment/i.test(document.getElementById('liveStatus').textContent));
  await context.close();
});

test('every visible form control has an accessible name', async () => {
  const { context, page } = await open();
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('input, textarea, select, button, a[href], summary')]
    .filter((e) => e.offsetParent !== null && !e.closest('[hidden]') && e.type !== 'hidden')
    .filter((e) => {
      const labelled = e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || (e.labels && e.labels.length) || (e.textContent || '').trim() || e.getAttribute('title');
      return !labelled;
    }).map((e) => e.outerHTML.slice(0, 80)));
  assert.deepEqual(unnamed, []);
  await context.close();
});

test('the brand link name contains its visible text, so voice control can say it', async () => {
  const { context, page } = await open();
  const { name, visible } = await page.evaluate(() => { const a = document.querySelector('.brand'); return { name: a.getAttribute('aria-label') || '', visible: a.textContent.replace(/\s+/g, ' ').trim() }; });
  assert.ok(name.toLowerCase().includes(visible.toLowerCase()), `"${name}" should include "${visible}"`);
  await context.close();
});

test('each screen has exactly one visible h1 and heading levels never skip', async () => {
  const { context, page } = await open();
  const headings = () => page.evaluate(() => [...document.querySelectorAll('h1,h2,h3,h4')].filter((h) => h.offsetParent !== null).map((h) => Number(h.tagName[1])));
  const check = (levels, where) => {
    assert.equal(levels.filter((l) => l === 1).length, 1, `${where}: one h1`);
    levels.reduce((prev, level) => { assert.ok(level - prev <= 1, `${where}: h${prev} then h${level}`); return level; }, 0);
  };
  check(await headings(), 'landing');
  await toReport(page);
  check(await headings(), 'report');
  await context.close();
});

test('the fit score is announced once as a labelled image, not as a number counting up', async () => {
  const { context, page } = await open();
  await toReport(page);
  const score = page.locator('#execScore');
  assert.equal(await score.getAttribute('role'), 'img');
  assert.match(await score.getAttribute('aria-label'), /^Fit score \d+ out of 100$/);
  await context.close();
});
