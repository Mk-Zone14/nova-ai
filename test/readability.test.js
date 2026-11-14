'use strict';

// Phase 2 guards: text floor, no information hidden behind ellipses, and WCAG AA contrast for the text colour tokens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const model = require('../report-model');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const dark = tokens(css.match(/:root\s*\{[^}]*\}/)[0]);
const light = { ...dark, ...tokens(css.match(/\[data-theme="light"\][^{]*\{[^}]*\}/)[0]) };
const hex = (c) => [0, 2, 4].map((i) => parseInt(c.replace('#', '').slice(i, i + 2), 16));
const mix = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

for (const [name, t] of [['dark', dark], ['light', light]]) {
  test(`${name} theme: text tokens reach 4.5:1 on every surface they sit on`, () => {
    for (const surface of ['bg', 'surface', 'surface-strong', 'surface-soft']) {
      for (const fg of ['ink', 'muted', 'faint', 'accent-strong', 'success', 'warning', 'danger', 'unknown']) {
        const ratio = contrast(hex(t[fg]), hex(t[surface]));
        assert.ok(ratio >= 4.5, `${name}: --${fg} on --${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
    // --accent is used as text on the page and card surfaces (not on the soft inset surface).
    for (const surface of ['bg', 'surface', 'surface-strong']) assert.ok(contrast(hex(t.accent), hex(t[surface])) >= 4.5, `${name}: --accent on --${surface}`);
  });
  test(`${name} theme: status tags (text on a 13% tint of itself) reach 4.5:1`, () => {
    // Tags sit on the page and on cards. (--surface-soft only backs form fields and progress tracks, so tags are not checked there.)
    for (const surface of ['bg', 'surface', 'surface-strong']) {
      for (const status of ['success', 'warning', 'danger', 'unknown']) {
        const tint = mix(hex(t[status]), hex(t[surface]), 0.13);
        const ratio = contrast(hex(t[status]), tint);
        assert.ok(ratio >= 4.5, `${name}: ${status} tag on --${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  });
}

test('light theme: the warning tag reaches 4.5:1 on the darker background axe measured behind it (#e9e1d6)', () => {
  assert.ok(contrast(hex(light.warning), hex('#e9e1d6')) >= 4.5);
});

for (const [name, t] of [['dark', dark], ['light', light]]) {
  test(`${name} theme: the text field boundary reaches 3:1 against the page and the field (WCAG 1.4.11)`, () => {
    const percent = Number(t['field-edge'].match(/var\(--ink\)\s+(\d+)%/)[1]) / 100;
    for (const behind of ['bg', 'surface-soft']) {
      const edge = mix(hex(t.ink), hex(t[behind]), percent);
      const ratio = contrast(edge, hex(t[behind]));
      assert.ok(ratio >= 3, `${name}: field edge on --${behind} is ${ratio.toFixed(2)}:1`);
    }
    assert.match(css, /textarea \{[^}]*border: 1px solid var\(--field-edge\)/);
  });
}

test('no text is set below 12px', () => {
  const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  const shorthand = [...css.matchAll(/font:\s*(?:\d{3}\s+)?(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  // Icon sizing and similar are not text; every text declaration in the stylesheet is checked here.
  for (const size of [...sizes, ...shorthand]) assert.ok(size >= 12, `found a ${size}px text declaration`);
});

test('information is wrapped, never hidden behind an ellipsis, outside the print override', () => {
  const rules = css.split('}').filter((rule) => /text-overflow:\s*ellipsis/.test(rule));
  for (const rule of rules) assert.match(rule, /\.pdf-export|\.sr-only/, `ellipsis found in: ${rule.trim().slice(0, 80)}`);
});

test('the requirements dialog keeps the scoring method collapsed behind "How this is scored"', () => {
  const report = model.adaptNovaReport({ response: JSON.stringify(require('./fixtures/nova-report.json')) });
  report.requirementsMatch = { required: { total: 2, matched: 1, partial: 0, missing: 1, unknown: 0, percent: 50 }, preferred: { total: 0, matched: 0, partial: 0, missing: 0, unknown: 0, percent: 0 }, fitExplanation: 'Fit score 50 = x', evidenceExplanation: 'Evidence coverage 40% = y' };
  const { html } = model.moduleContent('requirements', report);
  const disclosure = html.indexOf('<details class="how-scored">');
  assert.ok(disclosure > -1);
  assert.doesNotMatch(html.slice(disclosure, disclosure + 40), /open/, 'collapsed by default');
  assert.match(html, /<summary>How this is scored<\/summary>/);
  const method = html.indexOf('Fit score 50 = x');
  assert.ok(method > disclosure && method < html.indexOf('</details>', disclosure), 'the scoring explanation lives inside the disclosure');
  assert.ok(html.indexOf('detail-list') > html.indexOf('</details>', disclosure), 'the requirement list follows the collapsed method');
  assert.ok(html.indexOf('Evidence coverage 40% = y') < html.indexOf('detail-list'));
});
