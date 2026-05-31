/**
 * ============================================================================
 *  src/sinks/mysqlSink.js
 *  MySQL 落盘：批量 INSERT 一条 SQL 写入
 * ============================================================================
 */
'use strict';

const db = require('../db');

const COLUMNS = [
    'event_name', 'level',
    'ext_name', 'ext_version', 'vscode_version', 'platform', 'arch',
    'node_version', 'os_release', 'language',
    'machine_id', 'session_id', 'client_ip',
    'props', 'measures', 'client_ts',
];

function pickStr(v, max) {
    if (v === undefined || v === null) return null;
    const s = String(v);
    return max && s.length > max ? s.slice(0, max) : s;
}

function safeJsonStringify(v) {
    if (v === undefined || v === null) return null;
    try {
        const s = JSON.stringify(v);
        // 单字段限制 16KB，避免单事件膨胀
        return s.length > 16 * 1024 ? s.slice(0, 16 * 1024) : s;
    } catch {
        return null;
    }
}

/**
 * 把一批事件写入 MySQL。
 * @param {Array} events 来自 /api/v1/track 的事件数组（已通过校验）
 * @param {Object} ctx   { sessionId, common, clientIp }
 */
async function writeBatch(events, ctx) {
    if (!events || !events.length) return 0;
    const common = ctx.common || {};
    const sessionId = ctx.sessionId || common.sessionId || null;
    const clientIp = ctx.clientIp || null;

    const rows = events.map(ev => {
        const p = ev.props || {};
        // 维度字段从 common 取，单事件 props 中允许覆写（少见）
        return [
            pickStr(ev.name, 128),
            pickStr(ev.level || 'info', 16),
            pickStr(p.extName || common.extName, 64),
            pickStr(p.extVersion || common.extVersion, 32),
            pickStr(p.vscodeVersion || common.vscodeVersion, 32),
            pickStr(p.platform || common.platform, 32),
            pickStr(p.arch || common.arch, 16),
            pickStr(p.nodeVersion || common.nodeVersion, 32),
            pickStr(p.osRelease || common.osRelease, 64),
            pickStr(p.language || common.language, 16),
            pickStr(p.machineId || common.machineId, 128),
            pickStr(sessionId, 64),
            pickStr(clientIp, 64),
            safeJsonStringify(ev.props),
            safeJsonStringify(ev.measures),
            Number.isFinite(ev.ts) ? ev.ts : Date.now(),
        ];
    });

    const placeholders = rows.map(() => `(${COLUMNS.map(() => '?').join(',')})`).join(',');
    const sql = `INSERT INTO events (${COLUMNS.join(',')}) VALUES ${placeholders}`;
    const flat = rows.flat();
    // 大批量 INSERT 用 query 而不是 prepare，避免 prepare 缓存膨胀
    const [result] = await db.getPool().query(sql, flat);
    return result.affectedRows || 0;
}

module.exports = { writeBatch };
