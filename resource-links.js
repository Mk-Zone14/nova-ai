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

  const api = { safeResourceUrl };
  root.NovaResources = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
