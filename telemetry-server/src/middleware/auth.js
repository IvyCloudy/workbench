/**
 * ============================================================================
 *  src/middleware/auth.js
 *  固定 Token 鉴权
 * ----------------------------------------------------------------------------
 *  - Header: X-Telemetry-Token
 *  - 支持多 Token，便于灰度切换/回收
 *  - 统一返回 401 + 简短消息，不泄漏配置信息
 * ============================================================================
 */
'use strict';

const config = require('../config');

function authMiddleware(req, res, next) {
    const token = req.header('X-Telemetry-Token') || '';
    if (!config.auth.tokens.length || !config.auth.tokens.includes(token)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
}

module.exports = authMiddleware;
