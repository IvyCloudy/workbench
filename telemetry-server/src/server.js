/**
 * ============================================================================
 *  src/server.js
 *  Express 入口
 * ----------------------------------------------------------------------------
 *  - 启动顺序：加载配置 -> 建表 -> 监听端口
 *  - 优雅关闭：SIGTERM/SIGINT 时停止接收新请求 -> 关闭 MySQL 连接池
 * ============================================================================
 */
'use strict';

const express = require('express');
const config = require('./config');
const db = require('./db');

const authMiddleware = require('./middleware/auth');
const { rateLimitMiddleware } = require('./middleware/rateLimit');

const trackRouter = require('./routes/track');
const healthRouter = require('./routes/health');

async function bootstrap() {
    // 启动前：尝试建表（首次启动幂等）
    try {
        await db.ensureSchema();
        console.log('[server] schema ready');
    } catch (err) {
        console.error('[server] ensureSchema failed:', err && err.message);
        // 表建不出来直接退出，避免后续静默失败
        process.exit(1);
    }

    const app = express();
    // 信任反向代理头（K8s/Nginx 部署），便于取真实 IP
    app.set('trust proxy', true);
    app.use(express.json({ limit: config.server.maxBodyBytes }));

    // 健康检查不走鉴权
    app.use('/', healthRouter);

    // 调试路由：仅 MEMORY_DB=1 时启用，便于本地查看进程内数据
    if (config.memoryDb) {
        app.get('/__debug/events', async (_req, res) => {
            try {
                const rows = await db.query(
                    'SELECT id, event_name, level, ext_version, platform, machine_id, props, measures, client_ts, created_at FROM events ORDER BY id DESC LIMIT 100',
                    []
                );
                res.json({ ok: true, count: rows.length, rows });
            } catch (err) {
                res.status(500).json({ ok: false, error: String(err && err.message || err) });
            }
        });
    }

    // 业务接口走鉴权 + 限流
    app.use('/api/v1', authMiddleware, rateLimitMiddleware, trackRouter);

    // 兜底 404
    app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

    // 兜底错误处理
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        console.error('[server] unhandled error:', err && err.stack);
        res.status(500).json({ ok: false, error: 'internal_error' });
    });

    const server = app.listen(config.server.port, config.server.host, () => {
        console.log(`[server] listening on ${config.server.host}:${config.server.port} (env=${config.env})`);
    });

    const shutdown = (sig) => {
        console.log(`[server] receive ${sig}, shutting down...`);
        server.close(async () => {
            try { await db.close(); } catch { /* ignore */ }
            process.exit(0);
        });
        // 兜底：10s 强退
        setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch(err => {
    console.error('[server] bootstrap failed:', err);
    process.exit(1);
});
