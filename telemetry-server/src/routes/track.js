/**
 * ============================================================================
 *  src/routes/track.js
 *  POST /api/v1/track —— 批量埋点接收
 * ----------------------------------------------------------------------------
 *  请求体：
 *    {
 *      "sessionId": "xxx",
 *      "common":    { extName, extVersion, vscodeVersion, platform, ... },
 *      "events":    [ { name, props, measures, level, ts }, ... ]
 *    }
 *  约束：
 *    - events 必须是数组，长度 1..MAX_BATCH_SIZE
 *    - 单事件 name 必须存在，长度 1..128
 *    - 失败原则：尽量保留可用事件，单条非法事件被丢弃，不影响其他
 * ============================================================================
 */
'use strict';

const express = require('express');
const config = require('../config');
const { getClientIp } = require('../middleware/rateLimit');
const { writeBatch } = require('../sinks/mysqlSink');

const router = express.Router();

function isValidEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;
    if (typeof ev.name !== 'string' || !ev.name || ev.name.length > 128) return false;
    if (ev.level && !['info', 'warn', 'error'].includes(ev.level)) return false;
    return true;
}

router.post('/track', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
        return res.status(400).json({ ok: false, error: 'invalid_body' });
    }
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) {
        return res.status(400).json({ ok: false, error: 'empty_events' });
    }
    if (events.length > config.server.maxBatchSize) {
        return res.status(413).json({ ok: false, error: 'batch_too_large', max: config.server.maxBatchSize });
    }

    // 过滤非法事件，尽量收上来
    const valid = events.filter(isValidEvent);
    const dropped = events.length - valid.length;
    if (!valid.length) {
        return res.status(400).json({ ok: false, error: 'no_valid_events' });
    }

    const ctx = {
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
        common: body.common && typeof body.common === 'object' ? body.common : {},
        clientIp: getClientIp(req),
    };

    try {
        const affected = await writeBatch(valid, ctx);
        return res.json({ ok: true, accepted: affected, dropped });
    } catch (err) {
        // 写入失败给 5xx，让客户端可以重试
        console.error('[track] insert failed:', err && err.message);
        return res.status(500).json({ ok: false, error: 'sink_error' });
    }
});

module.exports = router;
