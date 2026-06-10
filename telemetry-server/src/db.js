/**
 * ============================================================================
 *  src/db.js
 *  MySQL 连接池 + 表结构初始化
 * ----------------------------------------------------------------------------
 *  本文件支持两种模式：
 *    - 生产/默认：连接 MySQL，使用 mysql2/promise 连接池
 *    - 本地零依赖：MEMORY_DB=1 时所有读写改走进程内数组，便于无 MySQL 环境冒烟
 *  内存模式仅实现极小子集，能够覆盖 ensureSchema / writeBatch / 健康检查 /
 *  scripts/query.js 的常用查询；scripts/cleanup.js 的 DELETE 也做了兼容。
 * ============================================================================
 */
'use strict';

const config = require('./config');

// =====================================================================
// 内存替身（仅当 MEMORY_DB=1 时启用）
// =====================================================================

const memStore = {
    events: [], // 顺序写入；id 自增
    nextId: 1n, // 用 BigInt 避免与生产 BIGINT 行为出现差异
};

/**
 * 极简 SQL 解析：
 *   - INSERT INTO events (...) VALUES (...),(...) -> push 到 memStore.events
 *   - SELECT ... FROM events ... -> 简单 LIKE/范围筛选 + ORDER BY id DESC + LIMIT
 *   - SELECT COUNT(*)            -> 返回 [{ 'COUNT(*)': n }]
 *   - DELETE FROM events WHERE created_at < ?  -> 按时间裁剪
 *   - CREATE TABLE IF NOT EXISTS  -> 直接忽略
 * 不试图做全功能 SQL，只服务于本仓库内的 SQL 形态。
 */
function memExecute(sql, params) {
    const trimmed = String(sql).trim();
    const upper = trimmed.toUpperCase();

    // 1) DDL：直接吞掉
    if (upper.startsWith('CREATE TABLE') || upper.startsWith('CREATE INDEX')) {
        return [{ affectedRows: 0 }, undefined];
    }

    // 2) ping 探测语句
    if (upper === 'SELECT 1' || upper.startsWith('SELECT 1 ')) {
        return [[{ 1: 1 }], undefined];
    }

    // 3) INSERT INTO events
    if (upper.startsWith('INSERT INTO EVENTS')) {
        // 我们只关心列顺序和 ?，从 mysqlSink 中已知 16 列
        const COLS = [
            'event_name', 'level',
            'ext_name', 'ext_version', 'vscode_version', 'platform', 'arch',
            'node_version', 'os_release', 'language',
            'machine_id', 'session_id', 'client_ip',
            'props', 'measures', 'client_ts',
        ];
        const rowSize = COLS.length;
        if (!params || params.length % rowSize !== 0) {
            throw new Error('memory_db: insert params length mismatch');
        }
        const now = new Date();
        let inserted = 0;
        for (let i = 0; i < params.length; i += rowSize) {
            const r = params.slice(i, i + rowSize);
            const row = { id: memStore.nextId++ };
            COLS.forEach((c, j) => { row[c] = r[j]; });
            // JSON 字段保持字符串（与 mysql2 行为一致）；created_at 用本地时间
            row.created_at = now.toISOString().slice(0, 23).replace('T', ' ');
            memStore.events.push(row);
            inserted++;
        }
        return [{ affectedRows: inserted, insertId: 0 }, undefined];
    }

    // 4) SELECT
    if (upper.startsWith('SELECT')) {
        // 解析 WHERE 中常见条件：event_name=?, machine_id=?, created_at>=?, created_at<?
        const isCount = /COUNT\s*\(\s*\*\s*\)/i.test(trimmed);
        const limitMatch = /LIMIT\s+(\d+)/i.exec(trimmed);
        const limit = limitMatch ? parseInt(limitMatch[1], 10) : 0;

        // 把 ? 占位符按顺序映射到识别出的条件
        const conds = [];
        const re = /(event_name|machine_id|level|ext_version|platform)\s*=\s*\?/gi;
        let m;
        while ((m = re.exec(trimmed)) !== null) {
            conds.push({ field: m[1].toLowerCase(), op: '=' });
        }
        const reGte = /created_at\s*>=\s*\?/gi;
        while ((m = reGte.exec(trimmed)) !== null) {
            conds.push({ field: 'created_at', op: '>=' });
        }
        const reLt = /created_at\s*<\s*\?/gi;
        while ((m = reLt.exec(trimmed)) !== null) {
            conds.push({ field: 'created_at', op: '<' });
        }

        const args = (params || []).slice();
        let rows = memStore.events.filter((row) => {
            return conds.every((c) => {
                const v = args.shift();
                if (c.op === '=') return String(row[c.field]) === String(v);
                if (c.op === '>=') return String(row[c.field]) >= String(v);
                if (c.op === '<') return String(row[c.field]) < String(v);
                return true;
            });
            // 注意：args 在每行都被 shift 完，下一行从新的 slice 开始
        });
        // 上面 args 在每行被消耗，需要每行复位
        rows = memStore.events.filter((row) => {
            const localArgs = (params || []).slice();
            return conds.every((c) => {
                const v = localArgs.shift();
                if (c.op === '=') return String(row[c.field]) === String(v);
                if (c.op === '>=') return String(row[c.field]) >= String(v);
                if (c.op === '<') return String(row[c.field]) < String(v);
                return true;
            });
        });

        // 默认按 id desc
        rows = rows.slice().sort((a, b) => Number(b.id - a.id));

        if (limit > 0) rows = rows.slice(0, limit);

        if (isCount) {
            return [[{ 'COUNT(*)': rows.length }], undefined];
        }
        return [rows.map((r) => ({ ...r, id: Number(r.id) })), undefined];
    }

    // 5) DELETE FROM events WHERE created_at < ?
    if (upper.startsWith('DELETE FROM EVENTS')) {
        const v = (params && params[0]) ? String(params[0]) : '';
        const before = memStore.events.length;
        memStore.events = memStore.events.filter((r) => String(r.created_at) >= v);
        return [{ affectedRows: before - memStore.events.length }, undefined];
    }

    // 其他语句：默认空结果
    return [[], undefined];
}

const memoryPool = {
    query: async (sql, params) => memExecute(sql, params),
    execute: async (sql, params) => memExecute(sql, params),
    getConnection: async () => ({
        ping: async () => { /* always ok */ },
        release: () => { /* noop */ },
        query: async (sql, params) => memExecute(sql, params),
        execute: async (sql, params) => memExecute(sql, params),
    }),
    end: async () => { /* noop */ },
};

// =====================================================================
// MySQL 真实实现
// =====================================================================

let pool = null;

function getPool() {
    if (config.memoryDb) return memoryPool;
    if (pool) return pool;
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database,
        waitForConnections: true,
        connectionLimit: config.mysql.connectionLimit,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
        // 时间字段统一返回字符串，避免时区漂移
        dateStrings: true,
    });
    return pool;
}

/**
 * 执行 SQL 并返回结果。
 */
async function query(sql, params) {
    const [rows] = await getPool().execute(sql, params || []);
    return rows;
}

/**
 * 健康检查：探测一次连接。
 */
async function ping() {
    if (config.memoryDb) return; // 内存模式始终健康
    const conn = await getPool().getConnection();
    try {
        await conn.ping();
    } finally {
        conn.release();
    }
}

/**
 * 自动建表（首次启动幂等执行）。
 *  - events: 事件主表，按天分表过重，先单表 + 索引；后续可改造为按月分区
 *  - 关键索引：(event_name, created_at), (machine_id, created_at)
 */
const SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        event_name VARCHAR(128) NOT NULL,
        level VARCHAR(16) NOT NULL DEFAULT 'info',
        ext_name VARCHAR(64) DEFAULT NULL,
        ext_version VARCHAR(32) DEFAULT NULL,
        vscode_version VARCHAR(32) DEFAULT NULL,
        platform VARCHAR(32) DEFAULT NULL,
        arch VARCHAR(16) DEFAULT NULL,
        node_version VARCHAR(32) DEFAULT NULL,
        os_release VARCHAR(64) DEFAULT NULL,
        language VARCHAR(16) DEFAULT NULL,
        machine_id VARCHAR(128) DEFAULT NULL,
        session_id VARCHAR(64) DEFAULT NULL,
        client_ip VARCHAR(64) DEFAULT NULL,
        props JSON DEFAULT NULL,
        measures JSON DEFAULT NULL,
        client_ts BIGINT NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        KEY idx_event_created (event_name, created_at),
        KEY idx_machine_created (machine_id, created_at),
        KEY idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function ensureSchema() {
    for (const sql of SCHEMA_SQL) {
        await query(sql);
    }
}

async function close() {
    if (config.memoryDb) return;
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = { getPool, query, ping, ensureSchema, close };
