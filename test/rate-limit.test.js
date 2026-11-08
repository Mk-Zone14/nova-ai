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

test('Redis config is only accepted for https URLs with a token', () => {
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

test('client key prefers the platform-set header and falls back safely', () => {
  assert.equal(rateLimit.getClientKey({ headers: { 'x-vercel-forwarded-for': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' } }), '1.1.1.1');
  assert.equal(rateLimit.getClientKey({ headers: { 'x-forwarded-for': '2.2.2.2, 3.3.3.3' } }), '2.2.2.2');
  assert.equal(rateLimit.getClientKey({ headers: { 'x-real-ip': '4.4.4.4' } }), '4.4.4.4');
  assert.equal(rateLimit.getClientKey({ headers: { 'x-forwarded-for': ['x'] } }), 'unknown');
  assert.equal(rateLimit.getClientKey({}), 'unknown');
});
