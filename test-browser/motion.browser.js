'use strict';

/*
 * Real-browser tests for interaction and motion: reduced motion is honoured by scripted scrolling, the hero sample card holds still
 * under the pointer, the constellation never sits over readable text, and the sample menu closes the way a menu should.
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

async function open({ viewport = { width: 1280, height: 900 }, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__scrolls = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function patched(options) { window.__scrolls.push(options && options.behavior); return original.call(this, options); };
  });
  await page.route((url) => !url.href.startsWith(baseUrl), (route) => route.abort());
  await page.goto(baseUrl);
  return { context, page };
}

test('scripted scrolling is instant when the visitor prefers reduced motion, smooth otherwise', async () => {
  for (const [reducedMotion, expected] of [['reduce', 'auto'], ['no-preference', 'smooth']]) {
    const { context, page } = await open({ reducedMotion });
    await page.click('#sampleDecisionBtn');
    const scrolls = await page.evaluate(() => window.__scrolls);
    assert.ok(scrolls.length > 0, 'a scroll was requested');
    assert.ok(scrolls.every((behavior) => behavior === expected), `${reducedMotion}: ${scrolls.join(',')}`);
    await context.close();
  }
});

test('the hero sample card does not move under the pointer', async () => {
  const { context, page } = await open();
  const card = page.locator('[data-pointer-card]');
  const before = await card.boundingBox();
  const target = await card.boundingBox();
  await page.mouse.move(target.x + 8, target.y + 8);
  await page.mouse.move(target.x + target.width - 8, target.y + target.height - 8, { steps: 6 });
  await page.waitForTimeout(350);
  const after = await card.boundingBox();
  assert.deepEqual({ x: after.x, y: after.y }, { x: before.x, y: before.y });
  assert.equal(await card.evaluate((el) => getComputedStyle(el).transform), 'none');
  await context.close();
});

test('the constellation is decorative: hidden from assistive tech, never intercepts the pointer, and is stacked behind the hero text', async () => {
  const { context, page } = await open();
  const canvas = page.locator('#constellationField');
  assert.equal(await canvas.getAttribute('aria-hidden'), 'true');
  const style = await canvas.evaluate((el) => { const s = getComputedStyle(el); return { events: s.pointerEvents, z: s.zIndex }; });
  assert.equal(style.events, 'none');
  assert.ok(Number(style.z) < 0, `z-index ${style.z}`);
  // The headline and the CTA must stay clickable and on top.
  assert.equal(await page.evaluate(() => {
    const button = document.querySelector('.hero-cta');
    if (!button) return 'no-cta';
    const r = button.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).closest('a, button') === button;
  }), true);
  await context.close();
});

test('the sample menu closes on Escape (focus returns to its button) and on an outside click', async () => {
  const { context, page } = await open();
  const menu = page.locator('.sample-menu');
  const trigger = menu.locator('summary');
  await trigger.click();
  assert.equal(await menu.evaluate((el) => el.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await menu.evaluate((el) => el.open), false);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('sample-menu-trigger')), true);
  await trigger.click();
  assert.equal(await menu.evaluate((el) => el.open), true);
  await page.mouse.click(5, 5);
  assert.equal(await menu.evaluate((el) => el.open), false);
  await context.close();
});
