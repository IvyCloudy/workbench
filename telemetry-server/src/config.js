/**
 * ============================================================================
 *  src/config.js
 *  环境变量配置加载
 * ============================================================================
 */
'use strict';

function getEnv(key, defaultVal) {
    const v = process.env[key];
    return v === undefined || v === '' ? defaultVal : v;
}

function getEnvInt(key, defaultVal) {
    const v = process.env[key];
    if (v === undefined || v === '') return defaultVal;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? defaultVal : n;
}

const config = {
    env: getEnv('NODE_ENV', 'production'),
    // 本地零依赖验证开关：MEMORY_DB=1 时不连接 MySQL，所有写入仅落到进程内存
    // 仅供功能联调使用；进程重启即丢，禁止用于任何生产环境
    memoryDb: getEnv('MEMORY_DB', '') === '1',
    server: {
        host: getEnv('HOST', '0.0.0.0'),
        port: getEnvInt('PORT', 8080),
        // 单 IP 每分钟限流次数；0 表示不限流
        rateLimitPerMinute: getEnvInt('RATE_LIMIT_PER_MINUTE', 600),
        // 单次批量上报最大事件数
        maxBatchSize: getEnvInt('MAX_BATCH_SIZE', 100),
        // body 体最大字节数
        maxBodyBytes: getEnvInt('MAX_BODY_BYTES', 1024 * 1024),
    },
    auth: {
        // 鉴权 Token；多个用英文逗号分隔，方便 Token 轮换
        tokens: getEnv('TELEMETRY_TOKENS', '')
            .split(',')
            .map(t => t.trim())
            .filter(Boolean),
    },
    mysql: {
        host: getEnv('MYSQL_HOST', '127.0.0.1'),
        port: getEnvInt('MYSQL_PORT', 3306),
        user: getEnv('MYSQL_USER', 'telemetry'),
        password: getEnv('MYSQL_PASSWORD', ''),
        database: getEnv('MYSQL_DATABASE', 'workbench_telemetry'),
        connectionLimit: getEnvInt('MYSQL_POOL_SIZE', 10),
    },
};

if (!config.auth.tokens.length) {
    // 启动时给出明确警示，避免误用未鉴权服务
    console.warn('[config] 未配置 TELEMETRY_TOKENS，所有请求将被拒绝（仅 /healthz 可访问）');
}

module.exports = config;
