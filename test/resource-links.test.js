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

// ---- F4: verified learning resources ----------------------------------------------------------------------------------
const links = require('../resource-links');
const report = require('../report-model');

test('catalogue: every entry is a specific https page on its own host, never a homepage, and each has a title and provider', () => {
  assert.ok(links.CATALOG.length >= 20);
  for (const entry of links.CATALOG) {
    const url = new URL(entry.url);
    assert.equal(url.protocol, 'https:', entry.id);
    assert.ok(url.pathname.length > 1 || url.hostname === 'sqlbolt.com' || url.hostname === 'javascript.info', `${entry.id}: ${entry.url} is a homepage`);
    assert.ok(entry.title.length > 5 && entry.provider.length > 2 && entry.keywords.length > 0, entry.id);
  }
  assert.equal(new Set(links.CATALOG.map((entry) => entry.id)).size, links.CATALOG.length, 'ids are unique');
});

test('generic homepage URLs from the model are never the destination: the gap decides the link', () => {
  const r = report.adaptNovaReport({ learningResources: [
    { skill: 'Docker', resource: 'Docker Essentials: A Developer Introduction', provider: 'YouTube', url: 'https://www.youtube.com' },
    { skill: 'AWS or another cloud platform', resource: 'AWS Cloud Practitioner Essentials', provider: 'Amazon Web Services', url: 'https://cloud.google.com/learn' },
    { skill: 'Contributions to open-source projects', resource: 'How to Contribute to Open Source', provider: 'YouTube', url: 'https://www.youtube.com' }
  ] });
  const resolved = links.resolveResources(r);
  assert.deepEqual(resolved.map((item) => [item.kind, item.url]), [
    ['verified', 'https://docs.docker.com/get-started/'],
    ['verified', 'https://aws.amazon.com/training/learn-about/cloud-practitioner/'],
    ['verified', 'https://opensource.guide/how-to-contribute/']
  ]);
  const html = report.moduleContent('resources', r).html;
  assert.doesNotMatch(html, /youtube\.com|cloud\.google\.com|Developer Introduction/);
});

test('malformed or hostile model URLs and titles cannot leak: only skill names are read from the model', () => {
  const r = report.adaptNovaReport({ learningResources: [
    { skill: 'Python', url: 'javascript:alert(1)', resource: '<img src=x onerror=1>', provider: 'x' },
    { skill: 'Git', url: 'https://user:pw@evil.example/git', resource: 'Hostile' },
    { skill: 'SQL', url: 'not a url at all' },
    { skill: 'Kubernetes', url: null }, 'junk', null, { url: 'https://docs.docker.com/get-started/' }
  ] });
  const resolved = links.resolveResources(r);
  assert.deepEqual(resolved.map((item) => item.id), ['python', 'git', 'sql', 'kubernetes']);
  const html = report.moduleContent('resources', r).html;
  assert.doesNotMatch(html, /javascript:|evil\.example|onerror|Hostile|not a url/);
  assert.equal(links.resolveResource(''), null);
  assert.equal(links.resolveResource(null), null);
  assert.equal(links.resolveResource('!!!').kind, 'none');
  assert.equal(links.resolveResource('a'.repeat(300)).skill.length, 120, 'skill names are capped');
});

test('mismatched resources: a gap maps only to its own topic, and the longest keyword wins', () => {
  const id = (skill) => links.resolveResource(skill).id;
  assert.equal(id('Familiarity with Docker'), 'docker');
  assert.equal(id('Experience with AWS or another cloud platform'), 'aws');
  assert.equal(id('GitHub Actions pipelines'), 'github-actions', 'not plain git');
  assert.equal(id('Git basics'), 'git');
  assert.equal(id('Responsive web design with CSS'), 'fcc-web', 'not the generic css entry');
  assert.equal(id('Node.js APIs'), 'node');
  assert.equal(id('Unit testing with pytest'), 'pytest');
  assert.equal(id('TypeScript'), 'typescript');
  assert.equal(links.resolveResource('Docker').url !== links.resolveResource('Kubernetes').url, true);
  assert.equal(links.catalogMatch('Gitlab CI'), null, 'substring "git" inside "gitlab" does not match');
  assert.equal(links.catalogMatch('Javascript'), links.CATALOG.find((entry) => entry.id === 'javascript'));
  assert.equal(links.catalogMatch('Kotlin'), null);
});

test('missing resources: no catalogue match gives a labelled search for the gap words, or nothing for gaps gained through work', () => {
  const excel = links.resolveResource('Experience with Microsoft Excel');
  assert.deepEqual([excel.kind, excel.url], ['search', 'https://www.coursera.org/search?query=Microsoft%20Excel']);
  assert.equal(links.searchQuery('Familiarity with basic Tableau dashboards'), 'Tableau dashboards');
  for (const skill of ['Prior internship experience', '2+ years of experience', 'Industry experience in fintech']) {
    const item = links.resolveResource(skill);
    assert.equal(item.kind, 'none', skill);
    assert.equal(item.url, null);
  }
  assert.equal(links.resolveResource('experience with').kind, 'none', 'nothing left after removing filler');
  assert.deepEqual(links.resolveResources({}), []);
  assert.deepEqual(links.resolveResources({ missingSkills: 'x', learningResources: 7 }), []);
});

test('resolveResources: missingSkills come first, duplicates collapse, two gaps on one page show it once, linked cards are capped', () => {
  const r = {
    missingSkills: [{ skill: 'Docker' }, { skill: 'docker containers' }, { skill: 'Prior internship experience' }],
    learningResources: [{ skill: 'Docker' }, { skill: 'Python' }, { skill: 'SQL' }, { skill: 'React' }, { skill: 'Git' }, { skill: 'Linux' }, { skill: 'Statistics' }, { skill: 'TypeScript' }, { skill: 'Kubernetes' }]
  };
  const resolved = links.resolveResources(r);
  assert.deepEqual(resolved.map((item) => item.skill), ['Docker', 'Prior internship experience', 'Python', 'SQL', 'React', 'Git', 'Linux', 'Statistics', 'TypeScript']);
  assert.equal(resolved.filter((item) => item.url).length, 8, 'eight linked cards at most; a "No link" card does not use a slot');
});

test('real-model regression (Preview, 2026-11-11): a gap naming two topics gives both pages, and a seventh gap is not dropped', () => {
  const gaps = ['Google Cloud Platform (GCP) or another cloud platform', 'Docker and Kubernetes', 'Unit testing with pytest', 'Advanced SQL (window functions, indexing)', 'Microsoft Excel for reporting', 'Prior internship experience', 'Contributions to open\u2011source projects'];
  const resolved = links.resolveResources({ missingSkills: gaps.map((skill) => ({ skill })) });
  assert.deepEqual(resolved.map((item) => [item.kind, item.id || item.url]), [
    ['search', 'https://www.coursera.org/search?query=Google%20Cloud%20Platform%20GCP%20cloud%20platform'],
    ['verified', 'kubernetes'],
    ['verified', 'docker'],
    ['verified', 'pytest'],
    ['verified', 'sql'],
    ['search', 'https://www.coursera.org/search?query=Microsoft%20Excel%20for%20reporting'],
    ['none', null],
    ['verified', 'open-source']
  ]);
  assert.deepEqual(links.resolveAll('Docker and Kubernetes').map((item) => item.id), ['kubernetes', 'docker']);
  assert.deepEqual(links.resolveAll('Prior internship experience').map((item) => item.kind), ['none']);
  assert.deepEqual(links.resolveAll(''), []);
});

test('resourceMarkup renders the three kinds honestly and escapes everything', () => {
  const verified = report.resourceMarkup(links.resolveResource('Docker'));
  assert.match(verified, /Verified page[\s\S]*Get started with Docker[\s\S]*href="https:\/\/docs\.docker\.com\/get-started\/"[\s\S]*Open page/);
  assert.match(verified, /rel="noopener noreferrer"/);
  const search = report.resourceMarkup(links.resolveResource('Excel <b>macros</b>'));
  assert.match(search, /Search results[\s\S]*Open search/);
  assert.doesNotMatch(search, /<b>/);
  assert.match(search, /&lt;b&gt;/);
  const none = report.resourceMarkup(links.resolveResource('Prior internship experience'));
  assert.match(none, /No link[\s\S]*No direct link/);
  assert.doesNotMatch(none, /<a /);
  assert.equal(report.resourceMarkup({ skill: '' }), '');
});

test('mismatch regressions: a generic or differently-vendored gap never gets another vendor\'s page', () => {
  const kind = (skill) => links.resolveResource(skill).kind;
  const id = (skill) => links.resolveResource(skill).id;
  assert.equal(kind('Google Cloud Platform (GCP)'), 'search', 'GCP is not AWS');
  assert.equal(kind('Cloud deployment'), 'search', 'a vendor is not chosen for a generic cloud gap');
  assert.equal(id('Experience with AWS or another cloud platform'), 'aws', 'a named vendor still matches');
  assert.equal(kind('Testing'), 'search', 'language-agnostic testing is not pytest');
  assert.equal(kind('regression testing'), 'search', 'not machine learning');
  assert.equal(kind('classification of documents'), 'search', 'not machine learning');
  assert.equal(id('Unit testing with pytest'), 'pytest');
  assert.equal(kind('Next.js'), 'search', 'a framework name containing "js" is not the JavaScript tutorial');
  assert.equal(kind('Terminal velocity physics'), 'search', '"terminal" alone is not Linux');
  assert.equal(id('Shell scripting'), 'linux');
  const shortAllowed = new Set(['ml']); // "ML" is common posting shorthand and only matches as a whole word
  for (const entry of links.CATALOG) for (const keyword of entry.keywords) assert.ok(keyword.length >= 3 || shortAllowed.has(keyword), `${entry.id}: keyword "${keyword}" is too short to be safe`);
  assert.equal(links.catalogMatch('HTML and XML'), links.CATALOG.find((entry) => entry.id === 'web'), '"ml" inside html/xml does not match');
});

test('two gaps that resolve to the same search show one card', () => {
  const resolved = links.resolveResources({ missingSkills: [{ skill: 'Excel' }, { skill: 'excel' }, { skill: 'Familiarity with Excel' }] });
  assert.deepEqual(resolved.map((item) => item.url), ['https://www.coursera.org/search?query=Excel']);
});

test('real-model regression (Preview, 2026-11-11, second run): a search for a topic is shown once even when the gap and the model word it differently', () => {
  const r = {
    missingSkills: [{ skill: 'Google Cloud Platform (GCP) or other cloud platform' }, { skill: 'Docker' }, { skill: 'Microsoft Excel (working knowledge)' }, { skill: 'Unit testing with pytest' }, { skill: 'Advanced SQL (window functions, indexing)' }],
    learningResources: [{ skill: 'Google Cloud Platform (GCP)', resource: 'Google Cloud Fundamentals', url: 'https://developers.google.com' }, { skill: 'Docker' }, { skill: 'Microsoft Excel' }, { skill: 'pytest' }, { skill: 'Advanced SQL', resource: 'SQL Advanced Topics', url: 'https://www.khanacademy.org' }]
  };
  const resolved = links.resolveResources(r);
  assert.deepEqual(resolved.map((item) => [item.kind, item.id || item.url]), [
    ['search', 'https://www.coursera.org/search?query=Google%20Cloud%20Platform%20GCP%20cloud%20platform'],
    ['verified', 'docker'],
    ['search', 'https://www.coursera.org/search?query=Microsoft%20Excel'],
    ['verified', 'pytest'],
    ['verified', 'sql']
  ]);
  assert.deepEqual(links.resolveResources({ missingSkills: [{ skill: 'Tableau' }, { skill: 'Power BI' }] }).map((item) => item.url), ['https://www.coursera.org/search?query=Tableau', 'https://www.coursera.org/search?query=Power%20BI'], 'different topics keep separate searches');
});
