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

// Mean luminance of a 6px-tall band, read back from a real screenshot (decoded in the page; no image library needed).
async function bandLuma(page, x, y, width) {
  const png = await page.screenshot({ clip: { x, y, width, height: 6 } });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rows = [0, 0];
    const half = canvas.height / 2;
    for (let row = 0; row < canvas.height; row += 1) {
      for (let col = 0; col < canvas.width; col += 1) {
        const i = (row * canvas.width + col) * 4;
        rows[row < half ? 0 : 1] += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
    }
    const n = canvas.width * half;
    return [rows[0] / n, rows[1] / n];
  }, png.toString('base64'));
}

test('no rectangle edge shows at the hero boundary while the pointer is near it', async () => {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript((t) => localStorage.setItem('opportunity-theme', t), theme);
    await page.route((url) => !url.href.startsWith(baseUrl), (route) => route.abort());
    await page.goto(baseUrl);
    await page.addStyleTag({ content: '.site-header{position:static!important}' });
    const zone = await page.locator('[data-pointer-zone]').boundingBox();
    // Hold the pointer just inside the top of the hero, where the glow used to be cut off.
    await page.mouse.move(zone.x + 300, zone.y + 40);
    await page.waitForTimeout(1800); // let any trail marks fade before sampling
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [above, below] = await bandLuma(page, zone.x + 20, zone.y - 3, 560);
      best = Math.min(best, Math.abs(below - above));
      if (best < 2.5) break;
      await page.waitForTimeout(300);
    }
    assert.ok(best < 2.5, `${theme} top edge: luminance step of ${best.toFixed(1)}`);
    await context.close();
  }
});

test('the field is a fixed full-viewport layer, so it continues behind the workspace and the report', async () => {
  const { context, page } = await open();
  const box = () => page.locator('#constellationField').evaluate((el) => { const r = el.getBoundingClientRect(); return { pos: getComputedStyle(el).position, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; });
  const before = await box();
  assert.equal(before.pos, 'fixed');
  assert.deepEqual({ w: before.w, h: before.h, top: before.top }, { w: 1280, h: 900, top: 0 });
  await page.click('#sampleDecisionBtn');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(200);
  assert.deepEqual(await box(), before, 'the layer does not scroll away');
  await context.close();
});

test('no radial-gradient cursor glow is drawn and the old card glow is gone', async () => {
  const { context, page } = await open();
  const cardAfter = await page.locator('[data-pointer-card]').evaluate((el) => getComputedStyle(el, '::after').backgroundImage);
  assert.equal(cardAfter, 'none');
  const usesGradient = await page.evaluate(() => {
    let used = false;
    const original = CanvasRenderingContext2D.prototype.createRadialGradient;
    CanvasRenderingContext2D.prototype.createRadialGradient = function patched(...args) { used = true; return original.apply(this, args); };
    return new Promise((resolve) => setTimeout(() => resolve(used), 400));
  });
  assert.equal(usesGradient, false);
  await context.close();
});

test('the pointer leaves a sparse trail: marks per distance travelled, not per mousemove event', async () => {
  const { context, page } = await open();
  const marks = async () => Number(await page.locator('#constellationField').getAttribute('data-trail'));
  // 400px in 80 small steps: a per-event trail would hold ~80 marks, a per-34px one about 12.
  await page.mouse.move(100, 700);
  // Record the high-water mark while moving: under load, frames may run between steps and start fading early marks.
  await page.evaluate(() => {
    const el = document.getElementById('constellationField');
    window.__peak = 0;
    new MutationObserver(() => { window.__peak = Math.max(window.__peak, Number(el.dataset.trail)); }).observe(el, { attributes: true, attributeFilter: ['data-trail'] });
  });
  await page.mouse.move(500, 700, { steps: 80 });
  const peak = await page.evaluate(() => window.__peak);
  assert.ok(peak >= 8 && peak <= 20, `expected a sparse trail, got ${peak} marks`);
  await page.waitForFunction(() => document.getElementById('constellationField').dataset.trail === '0', null, { timeout: 4000 });
  await context.close();
});

test('the field scrolls with the page (parallax) instead of sitting still behind it', async () => {
  const { context, page } = await open();
  await page.click('#sampleDecisionBtn');
  // Sample a column of pixels before and after a scroll; a static field would leave the column unchanged apart from drift.
  const snap = () => page.locator('#constellationField').evaluate((el) => {
    const ctx = el.getContext('2d');
    const d = ctx.getImageData(0, 0, el.width, el.height).data;
    let sum = 0; let n = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 40) { sum += Math.floor(i / 4 / el.width); n += 1; } }
    return n ? sum / n : 0; // mean row of painted pixels
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  const before = await snap();
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(120);
  const after = await snap();
  assert.ok(Math.abs(after - before) > 10, `mean painted row moved only ${(after - before).toFixed(1)}px for a 900px scroll`);
  await context.close();
});

test('clicking the hero background adds a star and a ripple; clicking a control does not', async () => {
  const { context, page } = await open();
  const stars = () => page.locator('#constellationField').getAttribute('data-stars');
  assert.equal(await stars(), '0');
  const zone = await page.locator('[data-pointer-zone]').boundingBox();
  await page.mouse.click(zone.x + 640, zone.y + zone.height - 40); // empty space under the card
  assert.equal(await stars(), '1');
  await page.locator('.hero-secondary').click();
  assert.equal(await stars(), '1', 'a link click must not add a star');
  await page.locator('[data-pointer-card]').click({ position: { x: 20, y: 20 } });
  assert.equal(await stars(), '1', 'a click on the sample card must not add a star');
  for (let i = 0; i < 14; i += 1) await page.mouse.click(zone.x + 300 + i * 20, zone.y + zone.height - 30);
  assert.ok(Number(await stars()) <= 10, 'stars are capped');
  await context.close();
});

test('the interaction hint is shown, then fades once the visitor has used the field', async () => {
  const { context, page } = await open();
  const hint = page.locator('#constellationHint');
  assert.match(await hint.innerText(), /click empty space to add a star/i);
  assert.equal(await hint.getAttribute('aria-hidden'), 'true');
  const zone = await page.locator('[data-pointer-zone]').boundingBox();
  await page.mouse.click(zone.x + 640, zone.y + zone.height - 40);
  await page.waitForFunction(() => document.getElementById('constellationHint').classList.contains('is-used'));
  await context.close();
});

test('with reduced motion the field is static: no hint, no stars', async () => {
  const { context, page } = await open({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#constellationHint').isHidden(), true);
  const zone = await page.locator('[data-pointer-zone]').boundingBox();
  await page.mouse.click(zone.x + 640, zone.y + zone.height - 40);
  assert.equal(await page.locator('#constellationField').getAttribute('data-stars'), '0');
  await context.close();
});

test('only one animation loop runs, even after resizes and theme changes (each used to start another)', async () => {
  const { context, page } = await open();
  await page.evaluate(() => {
    window.__clears = 0;
    const original = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function patched(...args) { window.__clears += 1; return original.apply(this, args); };
  });
  const perSecond = async () => { await page.evaluate(() => { window.__clears = 0; }); await page.waitForTimeout(1000); return page.evaluate(() => window.__clears); };
  const baseline = await perSecond();
  for (const size of [{ width: 1100, height: 800 }, { width: 1280, height: 900 }, { width: 900, height: 700 }]) await page.setViewportSize(size);
  await page.click('#themeToggle');
  await page.click('#themeToggle');
  const after = await perSecond();
  assert.ok(after <= baseline * 1.25 + 4, `${baseline} frames/s before, ${after} after resizes and theme toggles`);
  await context.close();
});

test('a star added on top of the headline area is still clearly visible', async () => {
  const { context, page } = await open();
  const zone = await page.locator('.hero-copy').boundingBox();
  // Click the empty strip below the hint, inside the text block's quiet zone, then read the painted alpha at that spot.
  const x = Math.round(zone.x + 40); const y = Math.round(zone.y + zone.height + 4);
  await page.mouse.click(x, y);
  await page.waitForTimeout(700);
  const alpha = await page.locator('#constellationField').evaluate((el, [px, py]) => {
    const ratio = el.width / el.getBoundingClientRect().width;
    const d = el.getContext('2d').getImageData(Math.round((px - 6) * ratio), Math.round((py - 6) * ratio), Math.round(12 * ratio), Math.round(12 * ratio)).data;
    let max = 0; for (let i = 3; i < d.length; i += 4) max = Math.max(max, d[i]);
    return max;
  }, [x, y]);
  assert.ok(alpha > 80, `star painted at alpha ${alpha}/255`);
  await context.close();
});
