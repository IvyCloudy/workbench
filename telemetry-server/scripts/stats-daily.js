/**
 * ============================================================================
 *  scripts/stats-daily.js
 *  日报：DAU、事件分布、Top 命令、错误率
 *  用法：
 *    node scripts/stats-daily.js               # 默认昨天
 *    node scripts/stats-daily.js 2026-05-30
 * ============================================================================
 */
'use strict';

const db = require('../src/db');

function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

(async () => {
    const arg = process.argv[2];
    let day;
    if (arg) {
        day = arg;
    } else {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        day = fmtDate(d);
    }
    const start = `${day} 00:00:00`;
    const end   = `${day} 23:59:59.999`;

    const where = 'created_at >= ? AND created_at <= ?';
    const params = [start, end];

    try {
        const [{ total }] = await db.query(
            `SELECT COUNT(*) AS total FROM events WHERE ${where}`, params,
        );
        const [{ dau }] = await db.query(
            `SELECT COUNT(DISTINCT machine_id) AS dau FROM events WHERE ${where}`, params,
        );
        const [{ errors }] = await db.query(
            `SELECT COUNT(*) AS errors FROM events WHERE ${where} AND level = 'error'`, params,
        );
        const topEvents = await db.query(
            `SELECT event_name, COUNT(*) AS cnt
             FROM events WHERE ${where}
             GROUP BY event_name ORDER BY cnt DESC LIMIT 20`,
            params,
        );
        const topErrors = await db.query(
            `SELECT event_name, COUNT(*) AS cnt
             FROM events WHERE ${where} AND level = 'error'
             GROUP BY event_name ORDER BY cnt DESC LIMIT 10`,
            params,
        );
        const topPlatforms = await db.query(
            `SELECT platform, COUNT(DISTINCT machine_id) AS users
             FROM events WHERE ${where}
             GROUP BY platform ORDER BY users DESC`,
            params,
        );

        const errorRate = total > 0 ? ((errors / total) * 100).toFixed(2) + '%' : '-';

        console.log(`============== Daily Stats: ${day} ==============`);
        console.log(`total events : ${total}`);
        console.log(`DAU          : ${dau}`);
        console.log(`errors       : ${errors}  (rate=${errorRate})`);
        console.log('\n-- Top Events --');
        for (const r of topEvents) console.log(`  ${r.cnt.toString().padStart(8)}  ${r.event_name}`);
        console.log('\n-- Top Errors --');
        for (const r of topErrors) console.log(`  ${r.cnt.toString().padStart(8)}  ${r.event_name}`);
        console.log('\n-- Platforms (DAU) --');
        for (const r of topPlatforms) console.log(`  ${String(r.users).padStart(6)}  ${r.platform || '(unknown)'}`);
    } catch (err) {
        console.error('stats failed:', err);
        process.exitCode = 1;
    } finally {
        await db.close();
    }
})();
