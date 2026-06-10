/**
 * ============================================================================
 *  scripts/cleanup.js
 *  清理超过 N 天的历史数据
 *  用法：
 *    node scripts/cleanup.js --keep-days=30           # 保留近 30 天
 *    node scripts/cleanup.js --keep-days=30 --batch=10000
 *  说明：
 *    - 大表删除分批进行，避免长事务/锁表
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
    const keepDays = parseInt(a['keep-days'] || '30', 10);
    const batch = Math.max(1, parseInt(a.batch || '5000', 10));

    if (!Number.isFinite(keepDays) || keepDays <= 0) {
        console.error('invalid --keep-days');
        process.exit(1);
    }

    const cutoff = new Date(Date.now() - keepDays * 86400_000);
    const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ');
    console.log(`cleanup events older than ${cutoffStr} (keep ${keepDays}d), batch=${batch}`);

    let totalDeleted = 0;
    try {
        // 取分批游标：每次按 id 范围删
        for (;;) {
            const [{ minId }] = await db.query(
                'SELECT MIN(id) AS minId FROM events WHERE created_at < ?',
                [cutoffStr],
            );
            if (!minId) break;
            const upperBoundary = Number(minId) + batch;
            const [result] = await db.getPool().query(
                'DELETE FROM events WHERE created_at < ? AND id < ?',
                [cutoffStr, upperBoundary],
            );
            const n = result.affectedRows || 0;
            totalDeleted += n;
            console.log(`  deleted ${n} (cum=${totalDeleted})`);
            if (n === 0) break;
            // 给 InnoDB 喘息时间
            await new Promise(r => setTimeout(r, 100));
        }
        console.log(`cleanup done. total deleted = ${totalDeleted}`);
    } catch (err) {
        console.error('cleanup failed:', err);
        process.exitCode = 1;
    } finally {
        await db.close();
    }
})();
