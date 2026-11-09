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
  // Each textarea is named by its visible <label>. An aria-label would override it, and the
  // accessible name would then differ from the text sighted users see (WCAG 2.5.3 Label in Name).
  for (const id of ['profileInput', 'opportunityInput']) {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`), `${id} needs a visible label`);
    assert.doesNotMatch(html, new RegExp(`<textarea id="${id}"[^>]*aria-label=`), `${id}: aria-label would override the visible label`);
  }
  assert.match(html, /aria-pressed="false"/);
});

test('accessibility wiring: live region, top-layer toast, loading focus, no role-less aria-label', () => {
  const html = read('index.html');
  const client = read('client.js');
  const css = read('styles.css');
  assert.match(html, /<div class="sr-only" id="liveStatus" role="status" aria-live="polite"/, 'announcements need an always-rendered live region');
  assert.match(html, /id="toast"[^>]*aria-hidden="true"/, 'the visual toast must not be announced twice');
  assert.match(html, /id="loadingTitle" tabindex="-1"/, 'focus moves here when the form is hidden');
  assert.match(client, /\$\('#loadingTitle'\)\?\.focus/);
  assert.match(client, /function announce\(/);
  assert.match(css, /\.toast\s*\{[^}]*position:\s*fixed/, 'toast must be positioned in the viewport, not left at the bottom of the page');
  assert.match(css, /\.sr-only\s*\{/);
  assert.match(css, /\.strategy-grid\s*\{[^}]*minmax\(0,\s*1fr\)/, 'single-column grids must not size to their widest child');
  const bare = [...html.matchAll(/<(div|span)\b[^>]*\baria-label=[^>]*>/g)].filter((m) => !/\brole=/.test(m[0]));
  assert.deepEqual(bare.map((m) => m[0]), [], 'aria-label on an element without a role is ignored by assistive tech');
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

test('only the insights section loads automatically; drafts are never requested without a click', () => {
  const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
  const calls = [...client.matchAll(/loadSection\(([^)]*)\)/g)].map((m) => m[1].trim()).filter((arg) => arg && arg !== 'section');
  assert.deepEqual(calls, ["'insights'"], 'loadSection may only be called with a literal for insights; drafts go through the click handler');
  assert.match(client, /generate-cover-letter/);
  assert.match(client, /\/api\/narrative/);
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.ok(vercel.functions['api/narrative.js'], 'narrative function needs its own maxDuration');
});

test('PDF export: private clone, colour sanitising, state guard and honest error handling stay wired', () => {
  const client = read('client.js');
  const css = read('styles.css');
  const start = client.indexOf('async function exportPdf');
  const body = client.slice(start, client.indexOf("$('#pdfBtn')?.addEventListener", start));
  assert.ok(start > -1 && body.length > 200, 'exportPdf not found');
  assert.match(body, /exportBlocked\(\)/, 'export must be rejected while details are loading');
  assert.match(body, /onclone:\s*prepareCloneForPdf/, 'html2canvas must sanitise colours it cannot parse');
  assert.match(body, /cloneNode\(true\)/, 'the live report must not be modified for export');
  assert.match(body, /pdf-export/);
  assert.match(body, /pdfExporting/, 'concurrent exports must be ignored');
  const catchBlock = body.slice(body.indexOf('catch (error)'), body.indexOf('finally'));
  assert.match(catchBlock, /console\.error/, 'failures must be logged');
  assert.doesNotMatch(catchBlock, /window\.print/, 'a real failure must not silently fall back to print');
  const prep = client.slice(client.indexOf('function prepareCloneForPdf'), client.indexOf('const PDF_AVOID_BREAKS'));
  assert.match(prep, /setProperty\([^)]*'important'\)/, 'sanitised colours must beat !important stylesheet rules');
  assert.match(client, /The PDF library is unavailable/, 'the intentional print fallback must say so');
  for (const id of ['copyBtn', 'jsonBtn', 'pdfBtn', 'printBtn']) assert.ok(client.includes(`'${id}'`), `${id} must be guarded`);
  assert.match(css, /\[data-theme="light"\],\s*\.pdf-export\s*\{/, 'PDF clone must reuse the light palette');
  assert.match(css, /\.pdf-export \.report-actions[^{]*\{[^}]*display:\s*none/, 'toolbar must be hidden in the PDF');
  assert.match(css, /\.pdf-export \.decision-hero[^{]*\{[^}]*break-inside:\s*avoid/s, 'cards must not split across pages');
});

test('client error handling: one request helper, bounded timeouts, no duplicate runs, no swallowed errors', () => {
  const client = read('client.js');
  assert.equal([...client.matchAll(/\bfetch\(/g)].length, 1, 'all network calls must go through postJson');
  assert.match(client, /ANALYZE_TIMEOUT_MS\s*=\s*75_000/);
  assert.match(client, /SECTION_TIMEOUT_MS\s*=\s*65_000/);
  assert.match(client, /if \(abortController\) return;/, 'a second analysis must not start while one is running');
  assert.doesNotMatch(client, /catch\s*(\([^)]*\))?\s*\{\s*\}/, 'empty catch blocks swallow errors');
  assert.doesNotMatch(client, /console\.error\([^)]*,\s*(error|err|e)\s*\)/, 'log error names/messages, never whole error objects (may carry payloads)');
  assert.doesNotMatch(client, /alert\(|\.stack\b/, 'no alert() and no stack traces in the UI');
  assert.match(client, /copyText\(/, 'clipboard access goes through the guarded helper');
});

test('form validation moves focus to the field and marks it invalid; decorative icons are hidden', () => {
  const client = read('client.js');
  assert.match(client, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(client, /fields\[0\]\.focus\(\)/, 'validation must move focus to the offending field');
  assert.match(client, /removeAttribute\('aria-invalid'\)/, 'the invalid flag must clear when the user edits');
  const icons = client.slice(client.indexOf('function icons'), client.indexOf('// Visible toast'));
  assert.match(icons, /aria-hidden/, 'lucide icons are decorative');
});
