/**
 * ============================================================================
 *  scripts/query.js
 *  命令行查询：按事件名 / 时间范围 / machine 查询事件
 *  用法：
 *    node scripts/query.js --event=push.success --from=2026-05-01 --to=2026-05-31 --limit=100
 *    node scripts/query.js --machine=abc123 --limit=20
 *    node scripts/query.js --level=error --from=2026-05-30
 * ============================================================================
 */
'use strict';

const db = require('../src/db');

function parseArgs(argv) {
    const args = {};
    for (const raw of argv.slice(2)) {
        const m = raw.match(/^--([^=]+)=(.*)$/);
        if (m) args[m[1]] = m[2];
    }
    return args;
}

(async () => {
    const a = parseArgs(process.argv);
    const where = [];
    const params = [];
    if (a.event)   { where.push('event_name = ?'); params.push(a.event); }
    if (a.level)   { where.push('level = ?');      params.push(a.level); }
    if (a.machine) { where.push('machine_id = ?'); params.push(a.machine); }
    if (a.from)    { where.push('created_at >= ?'); params.push(a.from); }
    if (a.to)      { where.push('created_at < ?');  params.push(a.to); }

    const limit = Math.min(parseInt(a.limit || '50', 10) || 50, 1000);
    const sql = `
        SELECT id, event_name, level, ext_version, platform, machine_id, props, measures, created_at
        FROM events
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC
        LIMIT ${limit}
    `;
    try {
        const rows = await db.query(sql, params);
        console.log(`# matched: ${rows.length}`);
        for (const r of rows) {
            console.log(JSON.stringify(r));
        }
    } catch (err) {
        console.error('query failed:', err);
        process.exitCode = 1;
    } finally {
        await db.close();
    }
})();
