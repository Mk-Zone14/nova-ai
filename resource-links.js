/*
 * Learning-resource link resolution.
 *
 * Model-supplied URLs are never rendered as-is. A link is only ever one of the fixed,
 * known-good URLs below, chosen by the URL's host or, failing that, by an exact provider
 * name. Paths and query strings from the model are discarded, so a hallucinated or hostile
 * URL on an allowed host (e.g. an arbitrary github.com repo) cannot become a link.
 *
 * Works as a browser global (NovaResources) and as a CommonJS module for tests.
 */
(function (root) {
  'use strict';

  // hostname (no "www.") -> canonical URL
  const CANONICAL_BY_HOST = {
    'freecodecamp.org': 'https://www.freecodecamp.org',
    'developer.mozilla.org': 'https://developer.mozilla.org',
    'coursera.org': 'https://www.coursera.org',
    'edx.org': 'https://www.edx.org',
    'kaggle.com': 'https://www.kaggle.com/learn',
    'youtube.com': 'https://www.youtube.com',
    'ocw.mit.edu': 'https://ocw.mit.edu',
    'developers.google.com': 'https://developers.google.com',
    'learn.microsoft.com': 'https://learn.microsoft.com',
    'docs.aws.amazon.com': 'https://docs.aws.amazon.com',
    'cloud.google.com': 'https://cloud.google.com/learn',
    'khanacademy.org': 'https://www.khanacademy.org',
    'docs.python.org': 'https://docs.python.org/3/tutorial/',
    'docs.docker.com': 'https://docs.docker.com',
    'git-scm.com': 'https://git-scm.com/doc',
    'react.dev': 'https://react.dev',
    'typescriptlang.org': 'https://www.typescriptlang.org/docs/',
    'nodejs.org': 'https://nodejs.org/en/learn',
    'docs.github.com': 'https://docs.github.com',
    'postgresql.org': 'https://www.postgresql.org/docs/',
    'redis.io': 'https://redis.io/docs/',
    'flask.palletsprojects.com': 'https://flask.palletsprojects.com',
    'fastapi.tiangolo.com': 'https://fastapi.tiangolo.com'
  };

  // Exact (normalised) provider name -> canonical URL. No fuzzy matching.
  const CANONICAL_BY_PROVIDER = {
    'freecodecamp': CANONICAL_BY_HOST['freecodecamp.org'],
    'mdn': CANONICAL_BY_HOST['developer.mozilla.org'],
    'mdn web docs': CANONICAL_BY_HOST['developer.mozilla.org'],
    'mozilla developer network': CANONICAL_BY_HOST['developer.mozilla.org'],
    'coursera': CANONICAL_BY_HOST['coursera.org'],
    'edx': CANONICAL_BY_HOST['edx.org'],
    'kaggle': CANONICAL_BY_HOST['kaggle.com'],
    'kaggle learn': CANONICAL_BY_HOST['kaggle.com'],
    'youtube': CANONICAL_BY_HOST['youtube.com'],
    'mit opencourseware': CANONICAL_BY_HOST['ocw.mit.edu'],
    'mit ocw': CANONICAL_BY_HOST['ocw.mit.edu'],
    'google developers': CANONICAL_BY_HOST['developers.google.com'],
    'microsoft learn': CANONICAL_BY_HOST['learn.microsoft.com'],
    'aws': CANONICAL_BY_HOST['docs.aws.amazon.com'],
    'aws documentation': CANONICAL_BY_HOST['docs.aws.amazon.com'],
    'amazon web services': CANONICAL_BY_HOST['docs.aws.amazon.com'],
    'google cloud': CANONICAL_BY_HOST['cloud.google.com'],
    'khan academy': CANONICAL_BY_HOST['khanacademy.org'],
    'python.org': CANONICAL_BY_HOST['docs.python.org'],
    'python docs': CANONICAL_BY_HOST['docs.python.org'],
    'docker docs': CANONICAL_BY_HOST['docs.docker.com'],
    'git': CANONICAL_BY_HOST['git-scm.com'],
    'react': CANONICAL_BY_HOST['react.dev'],
    'typescript': CANONICAL_BY_HOST['typescriptlang.org'],
    'node.js': CANONICAL_BY_HOST['nodejs.org'],
    'github docs': CANONICAL_BY_HOST['docs.github.com'],
    'postgresql': CANONICAL_BY_HOST['postgresql.org'],
    'redis': CANONICAL_BY_HOST['redis.io']
  };

  function canonicalForHost(hostname) {
    const host = hostname.toLowerCase().replace(/^www\./, '');
    if (Object.prototype.hasOwnProperty.call(CANONICAL_BY_HOST, host)) return CANONICAL_BY_HOST[host];
    // subdomain of an allowed host, e.g. "learn.freecodecamp.org"
    const parent = Object.keys(CANONICAL_BY_HOST).find((trusted) => host.endsWith(`.${trusted}`));
    return parent ? CANONICAL_BY_HOST[parent] : null;
  }

  function safeResourceUrl(url, provider) {
    if (typeof url === 'string') {
      try {
        const parsed = new URL(url.trim());
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
          const canonical = canonicalForHost(parsed.hostname);
          if (canonical) return canonical;
        }
      } catch { /* not a URL: fall through to the provider lookup */ }
    }
    if (typeof provider === 'string') {
      const key = provider.toLowerCase().replace(/\s+/g, ' ').trim();
      if (Object.prototype.hasOwnProperty.call(CANONICAL_BY_PROVIDER, key)) return CANONICAL_BY_PROVIDER[key];
    }
    return null;
  }

  // ---- F4: verified learning resources ---------------------------------------------------------------------------------
  // The model is not allowed to decide where a link goes. A gap is matched, in code, to a page from this catalogue; every
  // URL below was checked by a person before it was added, and it is the page for that topic, not a provider's homepage.
  // A gap with no catalogue entry gets a clearly labelled search-results link, or no link at all. Nothing here is
  // generated: titles, providers and URLs are fixed strings.
  const CATALOG = [
    { id: 'aws', keywords: ['aws', 'amazon web services', 'cloud platform', 'cloud computing', 'cloud'], title: 'AWS Cloud Practitioner Essentials (free digital course)', provider: 'AWS Training', url: 'https://aws.amazon.com/training/course-descriptions/cloud-practitioner-essentials/', type: 'Course' },
    { id: 'azure', keywords: ['azure', 'microsoft cloud'], title: 'Microsoft Learn: Azure training', provider: 'Microsoft Learn', url: 'https://learn.microsoft.com/training/azure', type: 'Learning path' },
    { id: 'docker', keywords: ['docker', 'container', 'containers', 'containerisation', 'containerization'], title: 'Get started with Docker', provider: 'Docker Docs', url: 'https://docs.docker.com/get-started/', type: 'Documentation' },
    { id: 'kubernetes', keywords: ['kubernetes', 'k8s'], title: 'Learn Kubernetes Basics', provider: 'kubernetes.io', url: 'https://kubernetes.io/docs/tutorials/kubernetes-basics/', type: 'Tutorial' },
    { id: 'git', keywords: ['git', 'version control'], title: 'Pro Git (2nd edition), free online', provider: 'git-scm.com', url: 'https://git-scm.com/book/en/v2', type: 'Book' },
    { id: 'github-actions', keywords: ['github actions', 'ci/cd', 'ci cd', 'continuous integration', 'continuous delivery'], title: 'Quickstart for GitHub Actions', provider: 'GitHub Docs', url: 'https://docs.github.com/en/actions/get-started/quickstart', type: 'Documentation' },
    { id: 'open-source', keywords: ['open-source', 'open source', 'oss contribution', 'oss'], title: 'How to Contribute to Open Source', provider: 'Open Source Guides', url: 'https://opensource.guide/how-to-contribute/', type: 'Guide' },
    { id: 'python', keywords: ['python'], title: 'The Python Tutorial', provider: 'docs.python.org', url: 'https://docs.python.org/3/tutorial/', type: 'Documentation' },
    { id: 'pandas', keywords: ['pandas', 'data analysis', 'data wrangling'], title: '10 minutes to pandas', provider: 'pandas docs', url: 'https://pandas.pydata.org/docs/user_guide/10min.html', type: 'Documentation' },
    { id: 'sql', keywords: ['sql', 'database queries', 'relational database', 'postgresql', 'mysql'], title: 'SQLBolt: interactive SQL lessons', provider: 'SQLBolt', url: 'https://sqlbolt.com/', type: 'Interactive lessons' },
    { id: 'javascript', keywords: ['javascript', 'js', 'es6'], title: 'The Modern JavaScript Tutorial', provider: 'javascript.info', url: 'https://javascript.info/', type: 'Tutorial' },
    { id: 'typescript', keywords: ['typescript', 'ts'], title: 'The TypeScript Handbook', provider: 'typescriptlang.org', url: 'https://www.typescriptlang.org/docs/handbook/intro.html', type: 'Documentation' },
    { id: 'react', keywords: ['react', 'react.js', 'reactjs'], title: 'React: Quick Start', provider: 'react.dev', url: 'https://react.dev/learn', type: 'Documentation' },
    { id: 'node', keywords: ['node.js', 'nodejs', 'node', 'express', 'express.js'], title: 'Introduction to Node.js', provider: 'nodejs.org', url: 'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs', type: 'Documentation' },
    { id: 'web', keywords: ['html', 'css', 'web development', 'front-end', 'frontend', 'responsive design'], title: 'Learn web development', provider: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Learn_web_development', type: 'Curriculum' },
    { id: 'fcc-web', keywords: ['responsive web design'], title: 'Responsive Web Design Certification', provider: 'freeCodeCamp', url: 'https://www.freecodecamp.org/learn/responsive-web-design/', type: 'Course' },
    { id: 'ml', keywords: ['machine learning', 'ml', 'supervised learning', 'classification', 'regression'], title: 'Machine Learning Crash Course', provider: 'Google for Developers', url: 'https://developers.google.com/machine-learning/crash-course', type: 'Course' },
    { id: 'kaggle-ml', keywords: ['scikit-learn', 'sklearn', 'model building'], title: 'Intro to Machine Learning', provider: 'Kaggle Learn', url: 'https://www.kaggle.com/learn/intro-to-machine-learning', type: 'Course' },
    { id: 'deep-learning', keywords: ['deep learning', 'neural network', 'neural networks', 'tensorflow', 'keras'], title: 'Intro to Deep Learning', provider: 'Kaggle Learn', url: 'https://www.kaggle.com/learn/intro-to-deep-learning', type: 'Course' },
    { id: 'statistics', keywords: ['statistics', 'probability', 'statistical'], title: 'Statistics and probability', provider: 'Khan Academy', url: 'https://www.khanacademy.org/math/statistics-probability', type: 'Course' },
    { id: 'linux', keywords: ['linux', 'command line', 'bash', 'shell', 'terminal'], title: 'The Linux command line for beginners', provider: 'Ubuntu documentation', url: 'https://documentation.ubuntu.com/desktop/en/latest/tutorial/the-linux-command-line-for-beginners/', type: 'Tutorial' },
    { id: 'pytest', keywords: ['pytest', 'unit testing', 'unit tests', 'test automation', 'testing'], title: 'pytest: Get Started', provider: 'docs.pytest.org', url: 'https://docs.pytest.org/en/stable/getting-started.html', type: 'Documentation' }
  ];

  // Longest keyword wins, so "github actions" beats "git" and "responsive web design" beats "css".
  const KEYWORD_INDEX = CATALOG.flatMap((entry) => entry.keywords.map((keyword) => ({ keyword, entry }))).sort((a, b) => b.keyword.length - a.keyword.length);

  const normaliseSkill = (text) => String(text ?? '').normalize('NFKC').replace(/[‐-―−]/g, '-').toLowerCase().replace(/\s+/g, ' ').trim();
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word boundaries that also work next to punctuation such as "node.js" or "ci/cd".
  const keywordPattern = (keyword) => new RegExp(`(?:^|[^a-z0-9+#])${escapeRegExp(keyword)}(?=$|[^a-z0-9+#])`, 'i');

  function catalogMatch(skill) {
    const text = normaliseSkill(skill);
    if (!text) return null;
    const hit = KEYWORD_INDEX.find(({ keyword }) => keywordPattern(keyword).test(text));
    return hit ? hit.entry : null;
  }

  // Gaps that are gained through work or time, not a course. These get no link rather than a meaningless search.
  const NOT_LEARNABLE = /\b(?:internship|internships|work experience|years? of experience|professional experience|industry experience|prior experience|track record|employment|job experience)\b/i;
  const FILLER = /\b(?:experience|familiarity|familiar|knowledge|proficiency|proficient|understanding|exposure|basic|basics|prior|previous|strong|good|solid|working|hands-on|with|in|of|or|and|the|a|an|to|skills?|ability|using|use)\b/gi;

  // The search query is the gap's own words with filler removed: "Experience with AWS or another cloud platform" -> "AWS another cloud platform".
  function searchQuery(skill) {
    const cleaned = String(skill ?? '').normalize('NFKC').replace(FILLER, ' ').replace(/[^\p{L}\p{N}+#. -]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 2 || cleaned.length > 80 || !/\p{L}/u.test(cleaned)) return null;
    return cleaned;
  }

  const MAX_RESOURCES = 6;

  /** One resolved resource for one gap, or null when the gap is empty. kind: 'verified' | 'search' | 'none'. */
  function resolveResource(skill) {
    const name = String(skill ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) return null;
    const entry = catalogMatch(name);
    if (entry) return { skill: name, kind: 'verified', id: entry.id, title: entry.title, provider: entry.provider, url: entry.url, type: entry.type };
    if (NOT_LEARNABLE.test(name)) return { skill: name, kind: 'none', title: name, provider: '', url: null, type: '' };
    const query = searchQuery(name);
    if (!query) return { skill: name, kind: 'none', title: name, provider: '', url: null, type: '' };
    return { skill: name, kind: 'search', title: `Coursera search: ${query}`, provider: 'Coursera', url: `https://www.coursera.org/search?query=${encodeURIComponent(query)}`, type: 'Search results' };
  }

  /**
   * Resources for a report: one per skill gap, missingSkills first (they are ordered by priority), then any further skills
   * the model's learningResources name. The model's titles and URLs are never used; only its skill names are.
   */
  function resolveResources(report) {
    const gaps = [];
    const missing = Array.isArray(report?.missingSkills) ? report.missingSkills : [];
    for (const item of missing) if (item && typeof item === 'object' && typeof item.skill === 'string') gaps.push(item.skill);
    const suggested = Array.isArray(report?.learningResources) ? report.learningResources : [];
    for (const item of suggested) if (item && typeof item === 'object' && typeof item.skill === 'string') gaps.push(item.skill);
    const out = [];
    const seenSkills = new Set();
    const seenEntries = new Set();
    for (const gap of gaps) {
      const resolved = resolveResource(gap);
      if (!resolved) continue;
      const key = normaliseSkill(resolved.skill);
      if (seenSkills.has(key)) continue;
      if (resolved.kind === 'verified' && seenEntries.has(resolved.id)) continue; // two gaps, one page: show it once
      seenSkills.add(key);
      if (resolved.kind === 'verified') seenEntries.add(resolved.id);
      out.push(resolved);
      if (out.length === MAX_RESOURCES) break;
    }
    return out;
  }

  const api = { safeResourceUrl, resolveResource, resolveResources, catalogMatch, searchQuery, CATALOG };
  root.NovaResources = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
