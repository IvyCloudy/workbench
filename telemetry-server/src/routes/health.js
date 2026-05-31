/**
 * ============================================================================
 *  src/routes/health.js
 *  健康检查 / 就绪探针
 * ----------------------------------------------------------------------------
 *  - GET /healthz  : 进程存活（不查数据库）
 *  - GET /readyz   : 就绪（探测 MySQL）；K8s 用作 readinessProbe
 * ============================================================================
 */
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/healthz', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

router.get('/readyz', async (_req, res) => {
    try {
        await db.ping();
        res.json({ ok: true });
    } catch (err) {
        res.status(503).json({ ok: false, error: err && err.message });
    }
});

module.exports = router;
