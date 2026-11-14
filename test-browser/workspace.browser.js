'use strict';

/*
 * Real-browser tests for the analysis workspace: usable field size, upload feedback (file name, honest truncation notice, inline
 * errors), drag-and-drop feedback, character-limit warnings and inline validation. Only the model-backed API routes are mocked. Run with `npm run test:browser`.
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
const UPLOAD = '#resumeUpload';
const file = (name, content, mimeType = 'text/plain') => ({ name, mimeType, buffer: Buffer.from(content) });

test('the fields are tall enough to work with a pasted resume and stay resizable', async () => {
  const { context, page } = await open();
  for (const id of ['profileInput', 'opportunityInput']) {
    const box = await page.locator(`#${id}`).boundingBox();
    assert.ok(box.height >= 220, `${id} is ${box.height}px tall`);
  }
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('profileInput')).resize), 'vertical');
  await context.close();
});

test('uploading a resume fills the profile, names the file in the status and clears when emptied', async () => {
  const { context, page } = await open();
  await page.setInputFiles(UPLOAD, file('priya-cv.txt', 'Priya Sharma. Third-year B.Tech CS student. Skills: JavaScript, React, Python, SQL. Built dashboards.'));
  await page.waitForFunction(() => document.getElementById('profileInput').value.startsWith('Priya Sharma'));
  assert.match(await page.locator('#profileState').innerText(), /Profile ready · priya-cv\.txt/);
  await page.fill('#profileInput', '');
  assert.equal(await page.locator('#profileState').innerText(), 'Waiting for profile');
  // Choosing the same file again must still load it.
  await page.setInputFiles(UPLOAD, file('priya-cv.txt', 'Priya Sharma. Third-year B.Tech CS student. Skills: JavaScript, React, Python, SQL. Built dashboards.'));
  await page.waitForFunction(() => document.getElementById('profileInput').value.startsWith('Priya Sharma'));
  await context.close();
});

test('a resume longer than the field says how much was kept instead of cutting it silently', async () => {
  const { context, page } = await open();
  await page.setInputFiles(UPLOAD, file('long.txt', 'x'.repeat(9000)));
  const message = page.locator('#profileMessage');
  await message.waitFor({ state: 'visible' });
  assert.match(await message.innerText(), /9,000 characters\. Only the first 8,000 were kept/);
  assert.equal(await message.getAttribute('data-kind'), 'warning');
  assert.equal((await page.inputValue('#profileInput')).length, 8000);
  assert.equal(await page.locator('#profileCount').evaluate((el) => el.classList.contains('near-limit')), true);
  await context.close();
});

test('an unsupported file gives an inline error that stays on screen, and does not touch the profile', async () => {
  const { context, page } = await open();
  await page.fill('#profileInput', 'Existing profile text that is long enough to count as a profile for Nova to read.');
  await page.setInputFiles(UPLOAD, file('resume.docx', 'binary', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  await page.locator('#profileMessage').waitFor({ state: 'visible' });
  assert.match(await page.locator('#profileMessage').innerText(), /TXT, Markdown, or PDF/);
  assert.equal(await page.locator('#profileMessage').getAttribute('data-kind'), 'error');
  assert.match(await page.inputValue('#profileInput'), /^Existing profile text/);
  await page.fill('#profileInput', 'Existing profile text, edited, still long enough to be a profile for Nova.');
  assert.equal(await page.locator('#profileMessage').isVisible(), false, 'editing clears the stale message');
  await context.close();
});

test('submitting too little explains which field and why, next to the field', async () => {
  const { context, page } = await open();
  await page.fill('#profileInput', 'too short');
  await page.fill('#opportunityInput', 'Internship at a company. Requires skills and experience, details to follow soon after.');
  await page.click('#analyzeBtn');
  const message = page.locator('#profileMessage');
  await message.waitFor({ state: 'visible' });
  assert.match(await message.innerText(), /profile seems too short/i);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'profileInput');
  assert.equal(await page.locator('#profileInput').getAttribute('aria-invalid'), 'true');
  assert.match(await page.locator('#profileInput').getAttribute('aria-describedby'), /profileMessage/);
  await context.close();
});

test('dragging a file highlights only the profile box, and the highlight clears when the drag leaves', async () => {
  const { context, page } = await open();
  const drag = (id, type) => page.evaluate(([target, name]) => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'cv.txt', { type: 'text/plain' }));
    document.getElementById(target).dispatchEvent(new DragEvent(name, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [id, type]);
  await drag('profileCard', 'dragenter');
  assert.equal(await page.locator('#profileCard').evaluate((el) => el.classList.contains('drag-over')), true);
  await drag('profileCard', 'dragleave');
  assert.equal(await page.locator('#profileCard').evaluate((el) => el.classList.contains('drag-over')), false);
  await drag('opportunityCard', 'dragenter');
  assert.equal(await page.locator('#opportunityCard').evaluate((el) => el.classList.contains('drag-over')), false);
  await context.close();
});

test('on a phone the Build and Reset actions share one compact row and nothing overflows sideways', async () => {
  const { context, page } = await open({ viewport: { width: 375, height: 812 } });
  const [build, reset] = await Promise.all([page.locator('#analyzeBtn').boundingBox(), page.locator('.analyze-actions .ghost-button').boundingBox()]);
  assert.ok(Math.abs(build.y - reset.y) < 8, 'Build and Reset sit on the same row');
  assert.ok(build.height >= 44 && reset.height >= 44);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await context.close();
});
