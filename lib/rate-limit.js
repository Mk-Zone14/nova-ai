'use strict';

/*
 * Rate limiting.
 *
 * Serverless instances don't share memory, so an in-memory Map only limits traffic that
 * happens to hit the same warm instance: it is NOT production-grade abuse protection on
 * Vercel. When UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, a fixed-window
 * counter in Redis is shared by all instances. If Redis is unconfigured or unreachable we
 * fall back to the in-memory limiter (fail-open: a Redis outage must not take the product
 * down) and say so in the logs.
 *
 * Client identity: forwarding headers are only trusted on Vercel, where the platform sets
 * them itself. Anywhere else a caller could send a fresh X-Forwarded-For on every request
 * and never be limited, so only the socket address is used.
 */

const net = require('node:net');
const crypto = require('node:crypto');

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10; // one analysis = two model calls, so this is deliberately modest
const MAX_TRACKED_CLIENTS = 1000;
const REDIS_TIMEOUT_MS = 1500;
const LOG_INTERVAL_MS = 60_000;

const buckets = new Map();
let warnedLocalMode = false;
let lastFallbackLog = 0;

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
        // The bearer token must never cross a network unencrypted; plain http is only for a local emulator.
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
        return { endpoint: `${parsed.origin}/pipeline`, token };
    } catch {
        return null;
    }
}

/** Fixed-window counter via the Upstash REST pipeline: INCR, then EXPIRE (the window id is part of the key, so stale keys age out). */
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
    if (!Array.isArray(results) || results[0]?.error || !Number.isFinite(count)) throw new Error('Unexpected Redis response');
    return count > max;
}

/** `clientKey` may carry a scope prefix (e.g. "narrative:ip:1.2.3.4"); `max` overrides the per-window cap. */
async function isRateLimited(clientKey, now = Date.now(), max = MAX_REQUESTS, env = process.env) {
    const config = redisConfig(env);
    if (config) {
        try {
            return await isRateLimitedShared(clientKey, config, now, max);
        } catch (error) {
            // Name only: the error text can contain the endpoint. Throttled so an outage does not flood the logs.
            const logTime = Date.now();
            if (logTime - lastFallbackLog >= LOG_INTERVAL_MS) {
                lastFallbackLog = logTime;
                console.error('Shared rate limiter unavailable; using per-instance fallback, which is weaker:', error?.name || 'UnknownError');
            }
        }
    } else if (!warnedLocalMode && (env.VERCEL || env.NODE_ENV === 'production')) {
        warnedLocalMode = true;
        console.warn('Rate limiting is per-instance (in-memory) and does not protect production traffic across serverless instances. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for shared limiting.');
    }
    return isRateLimitedLocal(clientKey, now, max);
}

/** Expands a valid IPv6 address to eight 4-digit groups. Only call with something net.isIP() accepted. */
function expandIpv6(address) {
    let text = address.toLowerCase();
    const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
    if (v4) {
        const [a, b, c, d] = v4.slice(1).map(Number);
        text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const halves = text.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const groups = halves.length > 1 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return groups.map((group) => group.padStart(4, '0'));
}

/**
 * Returns a canonical IP (IPv4, or the /64 prefix of an IPv6 address, since one subscriber normally controls a whole
 * /64 and could otherwise rotate addresses to dodge the limit), or '' for anything that is not a valid IP.
 */
function normalizeIp(raw) {
    if (typeof raw !== 'string') return '';
    let value = raw.trim();
    if (!value || value.length > 64) return '';
    value = value.replace(/^\[|\]$/g, '').replace(/%[\w.-]*$/, '');
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
    if (mapped) value = mapped[1];
    const family = net.isIP(value);
    if (family === 4) return value;
    if (family === 6) return `${expandIpv6(value).slice(0, 4).join(':')}::/64`;
    return '';
}

function headerFingerprint(headers) {
    const parts = ['user-agent', 'accept-language', 'accept-encoding'].map((name) => (typeof headers[name] === 'string' ? headers[name].slice(0, 256) : ''));
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Client identity for rate limiting. Always returns a bounded, validated key.
 * - On Vercel (the platform sets VERCEL and the forwarding headers itself) the platform headers are used.
 * - Elsewhere only the socket address is used: client-supplied forwarding headers are ignored so they cannot be
 *   rotated to evade the limit.
 * - With no usable address at all, clients are separated by a hash of stable request headers rather than being
 *   pooled into a single shared bucket.
 */
function getClientKey(req, env = process.env) {
    const headers = req?.headers && typeof req.headers === 'object' ? req.headers : {};
    const firstHop = (name) => (typeof headers[name] === 'string' ? normalizeIp(headers[name].split(',')[0]) : '');
    let ip = '';
    if (env.VERCEL) ip = firstHop('x-vercel-forwarded-for') || firstHop('x-real-ip') || firstHop('x-forwarded-for');
    if (!ip) ip = normalizeIp(req?.socket?.remoteAddress);
    return ip ? `ip:${ip}` : `anon:${headerFingerprint(headers)}`;
}

module.exports = {
    isRateLimited, isRateLimitedLocal, getClientKey, redisConfig,
    normalizeIp,
    resetRateLimits: () => { buckets.clear(); warnedLocalMode = false; lastFallbackLog = 0; },
    limits: { WINDOW_MS, MAX_REQUESTS }
};
