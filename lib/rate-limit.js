'use strict';

/*
 * Rate limiting.
 *
 * Serverless instances don't share memory, so an in-memory Map only limits traffic that
 * happens to hit the same warm instance. When UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN are set, a fixed-window counter in Redis is shared by all
 * instances. If Redis is unconfigured or unreachable we fall back to the in-memory
 * limiter (fail-open: a Redis outage must not take the product down).
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10; // one analysis = three model calls, so this is deliberately modest
const MAX_TRACKED_CLIENTS = 1000;
const REDIS_TIMEOUT_MS = 1500;

const buckets = new Map();

function isRateLimitedLocal(clientKey, now = Date.now(), max = MAX_REQUESTS) {
    if (!buckets.has(clientKey) && buckets.size >= MAX_TRACKED_CLIENTS) {
        for (const [key, times] of buckets) {
            if (!times.some((time) => now - time < WINDOW_MS)) buckets.delete(key);
        }
        if (buckets.size >= MAX_TRACKED_CLIENTS) buckets.delete(buckets.keys().next().value);
    }
    const requests = (buckets.get(clientKey) || []).filter((time) => now - time < WINDOW_MS);
    if (requests.length >= max) {
        buckets.set(clientKey, requests);
        return true;
    }
    requests.push(now);
    buckets.set(clientKey, requests);
    return false;
}

function redisConfig(env = process.env) {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        return { endpoint: `${parsed.origin}/pipeline`, token };
    } catch {
        return null;
    }
}

/** Fixed-window counter via the Upstash REST pipeline: INCR, then EXPIRE on the first hit. */
async function isRateLimitedShared(clientKey, config, now = Date.now(), max = MAX_REQUESTS) {
    const windowId = Math.floor(now / WINDOW_MS);
    const key = `nova:rl:${clientKey}:${windowId}`;
    const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([['INCR', key], ['EXPIRE', key, Math.ceil((WINDOW_MS * 2) / 1000)]]),
        signal: AbortSignal.timeout(REDIS_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Redis status ${response.status}`);
    const results = await response.json();
    const count = Number(results?.[0]?.result);
    if (!Number.isFinite(count)) throw new Error('Unexpected Redis response');
    return count > max;
}

/** `clientKey` may carry a scope prefix (e.g. "narrative:1.2.3.4"); `max` overrides the per-window cap. */
async function isRateLimited(clientKey, now = Date.now(), max = MAX_REQUESTS) {
    const config = redisConfig();
    if (config) {
        try {
            return await isRateLimitedShared(clientKey, config, now, max);
        } catch (error) {
            console.error('Shared rate limiter unavailable, using local fallback:', error?.name || 'UnknownError');
        }
    }
    return isRateLimitedLocal(clientKey, now, max);
}

/**
 * Best-effort client identity. Vercel sets these headers itself, so they can't be spoofed by
 * the caller on a Vercel deployment; elsewhere (local dev) they are only a convenience.
 */
function getClientKey(req) {
    const headers = req.headers || {};
    const pick = (name) => (typeof headers[name] === 'string' && headers[name].trim() ? headers[name].split(',')[0].trim() : '');
    return pick('x-vercel-forwarded-for') || pick('x-forwarded-for') || pick('x-real-ip') || 'unknown';
}

module.exports = {
    isRateLimited, isRateLimitedLocal, getClientKey, redisConfig,
    resetRateLimits: () => buckets.clear(),
    limits: { WINDOW_MS, MAX_REQUESTS }
};
