/**
 * ============================================================================
 *  src/middleware/rateLimit.js
 *  极简内存令牌桶限流（按 IP）
 * ----------------------------------------------------------------------------
 *  - 单进程、内存级，足以覆盖阶段1预期流量（百万级/天）
 *  - 阶段2 多副本时需要切到 Redis；预留接口可平滑替换
 * ============================================================================
 */
'use strict';

const config = require('../config');

const WINDOW_MS = 60_000;
const buckets = new Map(); // ip -> { count, windowStart }

function getClientIp(req) {
    const xff = req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimitMiddleware(req, res, next) {
    const limit = config.server.rateLimitPerMinute;
    if (!limit || limit <= 0) return next();

    const ip = getClientIp(req);
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
        bucket = { count: 0, windowStart: now };
        buckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
        res.set('Retry-After', String(Math.ceil((WINDOW_MS - (now - bucket.windowStart)) / 1000)));
        return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    next();
}

// 周期性清理冷桶，避免内存膨胀
setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
        if (now - b.windowStart >= WINDOW_MS * 5) buckets.delete(ip);
    }
}, WINDOW_MS).unref();

module.exports = { rateLimitMiddleware, getClientIp };
