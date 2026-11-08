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

test('client has no new raw HTML sinks and loads the tested model before itself', () => {
  const client = read('client.js');
  // Escaping itself is tested behaviourally in report-model.test.js. Here we only guard the DOM
  // boundary: the two known innerHTML writes (setHTML helper, history list) must not multiply.
  assert.equal((client.match(/\.innerHTML\s*=/g) || []).length, 2, 'new innerHTML assignment: route it through report-model.js and add a test');
  assert.doesNotMatch(client, /insertAdjacentHTML|document\.write|outerHTML\s*=/);
  assert.match(client, /safe\(entry\.title\)/, 'history titles must stay escaped');
  const html = read('index.html');
  assert.ok(html.indexOf('src="resource-links.js"') < html.indexOf('src="report-model.js"'));
  assert.ok(html.indexOf('src="report-model.js"') < html.indexOf('src="client.js"'));
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

test('no third-party script is loaded and script execution is limited to this origin', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//);
  const config = JSON.parse(read('vercel.json'));
  const csp = config.headers[0].headers.find((header) => header.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /worker-src 'self' blob:;/);
  assert.doesNotMatch(csp, /cdnjs|unpkg/);
});

test('vendored scripts are present, referenced, and match their recorded SHA-256', () => {
  const crypto = require('node:crypto');
  const manifest = read('vendor/README.md');
  const html = read('index.html');
  const files = ['pdf.min.js', 'pdf.worker.min.js', 'html2pdf.bundle.min.js', 'lucide.min.js'];
  for (const file of files) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'vendor', file))).digest('hex');
    assert.ok(manifest.includes(`\`${file}\``) && manifest.includes(hash), `${file} does not match vendor/README.md`);
  }
  for (const file of ['pdf.min.js', 'html2pdf.bundle.min.js', 'lucide.min.js']) assert.ok(html.includes(`src="vendor/${file}"`), file);
  assert.match(read('client.js'), /workerSrc = 'vendor\/pdf\.worker\.min\.js'/);
});

test('icon library is loaded before the client and release resources are revoked after download', () => {
  const html = read('index.html');
  const client = read('client.js');
  assert.ok(html.indexOf('vendor/lucide.min.js') < html.indexOf('src="client.js"'));
  assert.ok(html.indexOf('src="resource-links.js"') < html.indexOf('src="client.js"'));
  assert.match(client, /setTimeout\(\(\) => URL\.revokeObjectURL\(objectUrl\), 0\)/);
});

test('privacy notice names the AI provider and local history next to the analyze button', () => {
  const html = read('index.html');
  const note = html.match(/<p class="privacy-note"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(note, 'privacy note missing');
  assert.match(note[1], /Groq/);
  assert.match(note[1], /this browser only/);
  assert.ok(html.indexOf('id="privacyNote"') > html.indexOf('id="analyzeBtn"'));
});

test('local logs are not tracked and .env.example documents every server variable', () => {
  const example = read('.env.example');
  for (const name of ['GROQ_API_KEY', 'GROQ_MODEL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) assert.match(example, new RegExp(name));
  assert.doesNotMatch(example, /=\s*[A-Za-z0-9_-]{20,}/, 'example must not contain real-looking secrets');
  assert.match(read('.gitignore'), /!\.env\.example/);
  assert.equal(fs.existsSync(path.join(root, 'nova-dev.log')), false);
});
