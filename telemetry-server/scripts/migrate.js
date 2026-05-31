/**
 * ============================================================================
 *  scripts/migrate.js
 *  独立执行表结构初始化（首次部署/升级表结构时使用）
 *  用法：node scripts/migrate.js
 * ============================================================================
 */
'use strict';

const db = require('../src/db');

(async () => {
    try {
        await db.ensureSchema();
        console.log('migrate ok');
    } catch (err) {
        console.error('migrate failed:', err);
        process.exitCode = 1;
    } finally {
        await db.close();
    }
})();
