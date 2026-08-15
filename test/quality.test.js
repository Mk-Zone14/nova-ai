const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('production configuration applies browser security headers', () => {
  const config = JSON.parse(read('vercel.json'));
  const headers = config.headers.flatMap((entry) => entry.headers).map((header) => header.key);
  for (const name of ['Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    assert.ok(headers.includes(name), `missing ${name}`);
  }
  const csp = config.headers[0].headers.find((header) => header.key === 'Content-Security-Policy').value;
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
});

test('secrets and Vercel metadata are excluded from source control', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /\.env\*/);
  assert.match(ignore, /\.vercel/);
});

test('document retains critical accessibility landmarks and labels', () => {
  const html = read('index.html');
  assert.match(html, /href="#workspace">Skip to main content/);
  assert.match(html, /<main role="main">/);
  assert.match(html, /id="loadingPanel" aria-live="polite"/);
  assert.match(html, /id="errorCard" role="alert"/);
  assert.match(html, /for="resumeUpload"/);
  assert.match(html, /aria-label="Student profile or resume"/);
  assert.match(html, /aria-label="Opportunity details"/);
  assert.match(html, /aria-pressed="false"/);
});

test('client continues to escape dynamic report content before HTML insertion', () => {
  const client = read('client.js');
  assert.match(client, /replace\(\/\[&<>"'\]\//);
  assert.match(client, /safe\(x\.requirement\)/);
  assert.match(client, /safe\(para\)/);
});

test('browser input guards preserve intended file and text limits', () => {
  const client = read('client.js');
  assert.match(client, /f\.size > 2000000/);
  assert.match(client, /pdf\.numPages > 100/);
  assert.match(client, /slice\(0, 8000\)/);
  assert.match(client, /\(txt\|md\)/);
});

test('package scripts provide repeatable validation and test checks', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.check, /node --check/);
  assert.equal(pkg.scripts.lint, 'npm run check');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.match(pkg.scripts['test:coverage'], /experimental-test-coverage/);
});

test('theme initialization is externalized so CSP does not require inline script execution', () => {
  const html = read('index.html');
  const theme = read('theme-init.js');
  assert.match(html, /<script src="theme-init\.js"><\/script>/);
  assert.match(theme, /try \{/);
  assert.match(theme, /localStorage\.getItem/);
});

test('third-party icon dependency is version-pinned and downloads release resources safely', () => {
  const html = read('index.html');
  const client = read('client.js');
  assert.match(html, /lucide@0\.468\.0/);
  assert.match(client, /setTimeout\(\(\) => URL\.revokeObjectURL\(objectUrl\), 0\)/);
});
