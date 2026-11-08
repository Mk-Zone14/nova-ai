const assert = require('node:assert/strict');
const test = require('node:test');
const { safeResourceUrl } = require('../resource-links');

test('allowed hosts resolve to a fixed canonical URL and model-supplied paths are discarded', () => {
  assert.equal(safeResourceUrl('https://www.freecodecamp.org/news/some-invented-article', 'x'), 'https://www.freecodecamp.org');
  assert.equal(safeResourceUrl('https://developer.mozilla.org/en-US/docs/Web/JavaScript?utm=1#frag', ''), 'https://developer.mozilla.org');
  assert.equal(safeResourceUrl('https://kaggle.com/anything', ''), 'https://www.kaggle.com/learn');
  assert.equal(safeResourceUrl('https://learn.freecodecamp.org/x', ''), 'https://www.freecodecamp.org');
});

test('user-content hosts are not trusted: arbitrary GitHub, LinkedIn and YouTube-style URLs only get canonical roots', () => {
  assert.equal(safeResourceUrl('https://github.com/attacker/payload', ''), null);
  assert.equal(safeResourceUrl('https://www.linkedin.com/in/someone', ''), null);
  assert.equal(safeResourceUrl('https://docs.github.com/en/actions', ''), 'https://docs.github.com');
});

test('only https URLs without credentials are accepted', () => {
  for (const url of ['http://www.coursera.org', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://coursera.org', 'https://user:pw@www.coursera.org', '//coursera.org', 'coursera.org']) {
    assert.equal(safeResourceUrl(url, ''), null, url);
  }
});

test('lookalike and suffix-spoofed hosts are rejected', () => {
  for (const url of ['https://coursera.org.evil.com', 'https://evilcoursera.org', 'https://coursera.org@evil.com', 'https://notreact.dev']) {
    assert.equal(safeResourceUrl(url, ''), null, url);
  }
});

test('provider fallback is an exact match, never fuzzy', () => {
  assert.equal(safeResourceUrl('', 'Coursera'), 'https://www.coursera.org');
  assert.equal(safeResourceUrl(undefined, '  MDN   Web Docs '), 'https://developer.mozilla.org');
  assert.equal(safeResourceUrl('', 'Go'), null);
  assert.equal(safeResourceUrl('', 'Udemy'), null);
  assert.equal(safeResourceUrl('', 'Google Cloud Skills Boost Advanced'), null);
  assert.equal(safeResourceUrl('', 'constructor'), null);
  assert.equal(safeResourceUrl(null, null), null);
});

test('a bad URL falls through to a valid provider', () => {
  assert.equal(safeResourceUrl('https://evil.example/x', 'edX'), 'https://www.edx.org');
});
