const assert = require('node:assert/strict');
const test = require('node:test');
const rateLimit = require('../lib/rate-limit');

const originalFetch = global.fetch;
const originalEnv = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
const { MAX_REQUESTS, WINDOW_MS } = rateLimit.limits;

function restoreEnv() {
  for (const [key, value] of [['UPSTASH_REDIS_REST_URL', originalEnv.url], ['UPSTASH_REDIS_REST_TOKEN', originalEnv.token]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.beforeEach(() => {
  rateLimit.resetRateLimits();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});
test.after(() => {
  global.fetch = originalFetch;
  restoreEnv();
});

const configureRedis = () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://example-123.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'secret-token';
};

test('without Redis config the local limiter allows MAX_REQUESTS then blocks, and the window expires', async () => {
  global.fetch = async () => { throw new Error('must not call the network'); };
  for (let index = 0; index < MAX_REQUESTS; index++) assert.equal(await rateLimit.isRateLimited('a', 0), false);
  assert.equal(await rateLimit.isRateLimited('a', 0), true);
  assert.equal(await rateLimit.isRateLimited('b', 0), false, 'other clients are unaffected');
  assert.equal(await rateLimit.isRateLimited('a', WINDOW_MS + 1), false);
});

test('Redis config is only accepted for https URLs (or loopback http for a local emulator) with a token', () => {
  assert.equal(rateLimit.redisConfig({}), null);
  assert.equal(rateLimit.redisConfig({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' }), null);
  assert.equal(rateLimit.redisConfig({ UPSTASH_REDIS_REST_URL: 'http://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }), null);
  assert.equal(rateLimit.redisConfig({ UPSTASH_REDIS_REST_URL: 'not a url', UPSTASH_REDIS_REST_TOKEN: 't' }), null);
  assert.deepEqual(rateLimit.redisConfig({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io/', UPSTASH_REDIS_REST_TOKEN: 't' }), { endpoint: 'https://x.upstash.io/pipeline', token: 't' });
});

test('with Redis configured the shared counter decides, using a per-window key and bearer auth', async () => {
  configureRedis();
  const calls = [];
  let count = 0;
  global.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    count += 1;
    return { ok: true, status: 200, json: async () => [{ result: count }, { result: 1 }] };
  };
  assert.equal(await rateLimit.isRateLimited('203.0.113.9', 5 * WINDOW_MS), false);
  assert.equal(calls[0].url, 'https://example-123.upstash.io/pipeline');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].body[0][0], 'INCR');
  assert.equal(calls[0].body[0][1], 'nova:rl:203.0.113.9:5');
  assert.equal(calls[0].body[1][0], 'EXPIRE');

  count = MAX_REQUESTS; // the next INCR returns MAX_REQUESTS + 1
  assert.equal(await rateLimit.isRateLimited('203.0.113.9', 5 * WINDOW_MS), true);
});

test('Redis failures fail open to the local limiter instead of rejecting users', async () => {
  configureRedis();
  const failures = [
    async () => { throw new Error('network down'); },
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, json: async () => [{ error: 'WRONGTYPE' }] })
  ];
  for (const failure of failures) {
    rateLimit.resetRateLimits();
    global.fetch = failure;
    assert.equal(await rateLimit.isRateLimited('c', 0), false);
  }
  // the local fallback still enforces the limit during an outage
  global.fetch = failures[0];
  rateLimit.resetRateLimits();
  for (let index = 0; index < MAX_REQUESTS; index++) await rateLimit.isRateLimited('d', 0);
  assert.equal(await rateLimit.isRateLimited('d', 0), true);
});

test('forwarding headers are ignored off Vercel, so they cannot be rotated to evade the limit', () => {
  const socket = { remoteAddress: '203.0.113.9' };
  const hostile = { 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'x-vercel-forwarded-for': '3.3.3.3' };
  assert.equal(rateLimit.getClientKey({ headers: hostile, socket }, {}), 'ip:203.0.113.9');
  const rotated = new Set(Array.from({ length: 50 }, (_, index) => rateLimit.getClientKey({ headers: { 'x-forwarded-for': `10.0.0.${index}` }, socket }, {})));
  assert.equal(rotated.size, 1, 'fifty different spoofed headers are still one client');
});

test('on Vercel the platform headers are used, in order of trust, and invalid values are skipped', () => {
  const env = { VERCEL: '1' };
  const key = (headers, socket) => rateLimit.getClientKey({ headers, socket }, env);
  assert.equal(key({ 'x-vercel-forwarded-for': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }), 'ip:1.1.1.1');
  assert.equal(key({ 'x-real-ip': '4.4.4.4', 'x-forwarded-for': '2.2.2.2' }), 'ip:4.4.4.4');
  assert.equal(key({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }), 'ip:2.2.2.2', 'first hop only');
  assert.equal(key({ 'x-vercel-forwarded-for': 'not-an-ip', 'x-forwarded-for': '2.2.2.2' }), 'ip:2.2.2.2', 'junk falls through to the next header');
  assert.equal(key({ 'x-vercel-forwarded-for': ['1.1.1.1'] }, { remoteAddress: '5.5.5.5' }), 'ip:5.5.5.5', 'non-string header values are ignored');
  assert.match(key({}), /^anon:/);
});

test('IP normalisation validates input, maps IPv4-in-IPv6, and groups IPv6 by /64', () => {
  const n = rateLimit.normalizeIp;
  assert.equal(n('203.0.113.9'), '203.0.113.9');
  assert.equal(n(' 203.0.113.9 '), '203.0.113.9');
  assert.equal(n('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(n('2001:db8:abcd:12:ffff:ffff:ffff:ffff'), '2001:0db8:abcd:0012::/64');
  assert.equal(n('2001:db8:abcd:12::1'), n('2001:db8:abcd:12:aaaa:bbbb:cccc:dddd'), 'same /64 is one client');
  assert.notEqual(n('2001:db8:abcd:12::1'), n('2001:db8:abcd:13::1'), 'different /64 are different clients');
  assert.equal(n('[2001:DB8::1]'), n('2001:db8::1'));
  assert.equal(n('fe80::1%eth0'), n('fe80::1'));
  assert.equal(n('64:ff9b::192.0.2.33'), '0064:ff9b:0000:0000::/64');
  for (const bad of ['', ' ', 'garbage', '1.2.3', '1.2.3.4.5', '999.1.1.1', '1.2.3.4:8080', '1.2.3.4, 5.6.7.8', "1.1.1.1'; DROP", 'a'.repeat(500), '::g', null, undefined, 42, {}, ['1.1.1.1']]) {
    assert.equal(n(bad), '', String(bad).slice(0, 30));
  }
});

test('with no usable address, clients are separated by a header fingerprint rather than pooled as "unknown"', () => {
  const key = (headers) => rateLimit.getClientKey({ headers }, {});
  assert.match(key({ 'user-agent': 'A' }), /^anon:[0-9a-f]{16}$/);
  assert.equal(key({ 'user-agent': 'A' }), key({ 'user-agent': 'A' }), 'stable for the same client');
  assert.notEqual(key({ 'user-agent': 'A' }), key({ 'user-agent': 'B' }));
  assert.notEqual(key({ 'user-agent': 'A', 'accept-language': 'en' }), key({ 'user-agent': 'A', 'accept-language': 'fr' }));
  for (const missing of [undefined, null, {}, { headers: null }, { headers: 'nope' }, { socket: {} }, { socket: { remoteAddress: undefined } }]) {
    assert.match(rateLimit.getClientKey(missing, {}), /^anon:[0-9a-f]{16}$/, JSON.stringify(missing));
  }
  assert.ok(key({ 'user-agent': 'x'.repeat(100_000) }).length < 30, 'hostile header sizes cannot inflate the key');
  assert.ok(![key({}), key({ 'user-agent': 'A' })].includes('unknown'));
});

test('in-memory mode warns once in production-like environments, never claims to be sufficient, and stays quiet in dev', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await rateLimit.isRateLimited('dev-client', 0, MAX_REQUESTS, {});
    assert.equal(warnings.length, 0, 'no noise in local development or tests');
    await rateLimit.isRateLimited('p1', 0, MAX_REQUESTS, { VERCEL: '1' });
    await rateLimit.isRateLimited('p2', 0, MAX_REQUESTS, { VERCEL: '1' });
    await rateLimit.isRateLimited('p3', 0, MAX_REQUESTS, { NODE_ENV: 'production' });
    assert.equal(warnings.length, 1, 'warned once, not per request');
    assert.match(warnings[0], /per-instance/);
    assert.match(warnings[0], /UPSTASH_REDIS_REST_URL/);
    assert.match(warnings[0], /UPSTASH_REDIS_REST_TOKEN/);
    assert.doesNotMatch(warnings[0], /secret-token/);
  } finally {
    console.warn = original;
  }
});

// ---- Redis path against a local emulator of the Upstash REST pipeline ------------------------
// This exercises the real fetch/HTTP stack with real counters, but it is an emulator written for these tests:
// it proves our request/response handling, NOT behaviour against a real Upstash database.

const http = require('node:http');

function startUpstashEmulator({ token = 'emu-token', behaviour = {} } = {}) {
  const store = new Map(); // key -> { count, ttl }
  const log = { requests: 0, authFailures: 0, maxInFlight: 0 };
  let inFlight = 0;
  const server = http.createServer((req, res) => {
    log.requests += 1;
    inFlight += 1;
    log.maxInFlight = Math.max(log.maxInFlight, inFlight);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const finish = () => {
        inFlight -= 1;
        if (req.url !== '/pipeline' || req.method !== 'POST') { res.writeHead(404); return res.end('{}'); }
        if (req.headers.authorization !== `Bearer ${token}`) { log.authFailures += 1; res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"Unauthorized"}'); }
        if (behaviour.status) { res.writeHead(behaviour.status); return res.end(behaviour.body ?? '{"error":"boom"}'); }
        if (behaviour.rawBody !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(behaviour.rawBody); }
        const commands = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const results = commands.map(([command, key, arg]) => {
          if (command === 'INCR') { const entry = store.get(key) || { count: 0, ttl: null }; entry.count += 1; store.set(key, entry); return { result: entry.count }; }
          if (command === 'EXPIRE') { const entry = store.get(key); if (!entry) return { result: 0 }; entry.ttl = Number(arg); return { result: 1 }; }
          return { error: `ERR unknown command '${command}'` };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      };
      if (behaviour.delayMs) setTimeout(finish, behaviour.delayMs); else finish();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, token, store, log, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); })
  })));
}

async function withEmulator(options, body) {
  const emulator = await startUpstashEmulator(options);
  global.fetch = originalFetch;
  process.env.UPSTASH_REDIS_REST_URL = emulator.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = emulator.token;
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try { await body(emulator, errors); } finally { console.error = original; await emulator.close(); }
}

test('emulated Redis: requests below the limit pass, the next one is limited, and other clients are unaffected', async () => {
  await withEmulator({}, async (emulator) => {
    for (let index = 0; index < MAX_REQUESTS; index++) assert.equal(await rateLimit.isRateLimited('ip:1.1.1.1', 1000), false, `request ${index + 1}`);
    assert.equal(await rateLimit.isRateLimited('ip:1.1.1.1', 1000), true);
    assert.equal(await rateLimit.isRateLimited('ip:2.2.2.2', 1000), false);
    assert.equal(await rateLimit.isRateLimited('narrative:ip:1.1.1.1', 1000), false, 'scoped keys count separately');
    assert.equal(emulator.log.authFailures, 0);
    const [key, entry] = [...emulator.store.entries()].find(([k]) => k === `nova:rl:ip:1.1.1.1:${Math.floor(1000 / WINDOW_MS)}`);
    assert.equal(entry.count, MAX_REQUESTS + 1);
    assert.equal(entry.ttl, (WINDOW_MS * 2) / 1000, `${key} expires on its own`);
  });
});

test('emulated Redis: the limit resets when the window rolls over', async () => {
  await withEmulator({}, async () => {
    for (let index = 0; index < MAX_REQUESTS; index++) await rateLimit.isRateLimited('ip:3.3.3.3', 5_000);
    assert.equal(await rateLimit.isRateLimited('ip:3.3.3.3', 5_000), true);
    assert.equal(await rateLimit.isRateLimited('ip:3.3.3.3', 59_999), true, 'still the same window');
    assert.equal(await rateLimit.isRateLimited('ip:3.3.3.3', WINDOW_MS + 1), false, 'new window, fresh allowance');
  });
});

test('emulated Redis: concurrent requests are counted atomically across "instances"', async () => {
  await withEmulator({ behaviour: { delayMs: 25 } }, async (emulator) => {
    const outcomes = await Promise.all(Array.from({ length: 40 }, () => rateLimit.isRateLimited('ip:4.4.4.4', 1000)));
    assert.equal(outcomes.filter((limited) => !limited).length, MAX_REQUESTS, 'exactly MAX_REQUESTS get through');
    assert.equal(outcomes.filter(Boolean).length, 40 - MAX_REQUESTS);
    assert.ok(emulator.log.maxInFlight > 1, 'requests really overlapped');
  });
});

test('emulated Redis: outages and bad responses fall back to the local limiter without leaking infrastructure details', async () => {
  const cases = {
    'server error (500)': { behaviour: { status: 500 } },
    'service unavailable (503)': { behaviour: { status: 503, body: 'upstream down' } },
    'not JSON': { behaviour: { rawBody: '<html>oops</html>' } },
    'JSON of the wrong shape': { behaviour: { rawBody: '{"result":1}' } },
    'per-command error object': { behaviour: { rawBody: '[{"error":"ERR max requests limit exceeded"}]' } },
    'non-numeric counter': { behaviour: { rawBody: '[{"result":"lots"}]' } }
  };
  for (const [label, options] of Object.entries(cases)) {
    rateLimit.resetRateLimits();
    await withEmulator(options, async (emulator, errors) => {
      for (let index = 0; index < MAX_REQUESTS; index++) assert.equal(await rateLimit.isRateLimited('ip:5.5.5.5', 1000), false, `${label}: request ${index + 1} fails open`);
      assert.equal(await rateLimit.isRateLimited('ip:5.5.5.5', 1000), true, `${label}: the local limiter still enforces the limit`);
      assert.equal(errors.length, 1, `${label}: outage logged once, not per request`);
      assert.doesNotMatch(errors.join('\n'), new RegExp(`${emulator.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${emulator.token}|Bearer|127\\.0\\.0\\.1`), `${label}: log has no endpoint or token`);
    });
  }
});

test('emulated Redis: a wrong token, a hung server, and a dead server all fail open quickly', async () => {
  await withEmulator({ token: 'right-token' }, async (emulator) => {
    process.env.UPSTASH_REDIS_REST_TOKEN = 'wrong-token';
    assert.equal(await rateLimit.isRateLimited('ip:6.6.6.6', 1000), false);
    assert.ok(emulator.log.authFailures >= 1, 'the emulator really rejected the credentials');
  });
  rateLimit.resetRateLimits();
  await withEmulator({ behaviour: { delayMs: 4000 } }, async () => {
    const started = Date.now();
    assert.equal(await rateLimit.isRateLimited('ip:7.7.7.7', 1000), false);
    assert.ok(Date.now() - started < 3000, `gave up on a hung server in ${Date.now() - started}ms`);
  });
  rateLimit.resetRateLimits();
  const dead = await startUpstashEmulator({});
  const deadUrl = dead.url;
  await dead.close();
  global.fetch = originalFetch;
  process.env.UPSTASH_REDIS_REST_URL = deadUrl;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'emu-token';
  const original = console.error;
  console.error = () => {};
  try {
    for (let index = 0; index < MAX_REQUESTS; index++) assert.equal(await rateLimit.isRateLimited('ip:8.8.8.8', 1000), false);
    assert.equal(await rateLimit.isRateLimited('ip:8.8.8.8', 1000), true, 'connection refused: still limited locally');
  } finally { console.error = original; }
});

test('plain-http Redis URLs are refused unless they point at loopback, so the token never crosses a network unencrypted', () => {
  const config = (url) => rateLimit.redisConfig({ UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: 't' });
  assert.deepEqual(config('http://127.0.0.1:8079'), { endpoint: 'http://127.0.0.1:8079/pipeline', token: 't' });
  assert.deepEqual(config('http://localhost:8079'), { endpoint: 'http://localhost:8079/pipeline', token: 't' });
  for (const refused of ['http://example.com', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'http://evil.com/127.0.0.1', 'http://10.0.0.5', 'ftp://127.0.0.1', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(config(refused), null, refused);
  }
});
