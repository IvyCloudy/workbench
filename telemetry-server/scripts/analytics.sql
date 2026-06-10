-- ============================================================================
--  analytics.sql  ——  埋点数据开箱即用分析手册
-- ----------------------------------------------------------------------------
--  使用方式：
--    1) 在 DBeaver 里连上本地 MySQL（库名：workbench_telemetry）
--    2) 选中下面任意一段（-- @block 之间），按 Ctrl/Cmd + Enter 执行即可
--    3) 所有 SQL 都是只读 SELECT，可放心运行
--
--  数据表：events
--    关键字段：event_name / level / ext_version / platform / machine_id
--             props (JSON) / measures (JSON) / client_ts / created_at
--  时间口径：created_at 为服务端落库时间（DATETIME(3)），客户端时间见 client_ts
-- ============================================================================


-- @block 1) 今日事件总量 + 同比昨日
--   用途：看整体活跃度，一眼判断"今天是不是异常"
SELECT
    DATE(created_at)         AS day,
    COUNT(*)                 AS total_events,
    COUNT(DISTINCT machine_id) AS active_machines,
    COUNT(DISTINCT session_id) AS sessions
FROM events
WHERE created_at >= CURDATE() - INTERVAL 1 DAY
GROUP BY DATE(created_at)
ORDER BY day DESC;


-- @block 2) Top 10 事件名（最近 7 天）
--   用途：看用户最常做什么、哪些埋点最热
SELECT
    event_name,
    COUNT(*) AS cnt,
    COUNT(DISTINCT machine_id) AS uniq_machines,
    ROUND(COUNT(*) * 100 / SUM(COUNT(*)) OVER (), 2) AS pct
FROM events
WHERE created_at >= NOW() - INTERVAL 7 DAY
GROUP BY event_name
ORDER BY cnt DESC
LIMIT 10;


-- @block 3) 24 小时事件趋势（按小时聚合）
--   用途：看波峰波谷，定位用户活跃时段
SELECT
    DATE_FORMAT(created_at, '%Y-%m-%d %H:00') AS hour_bucket,
    COUNT(*)                                  AS events,
    COUNT(DISTINCT machine_id)                AS active_machines
FROM events
WHERE created_at >= NOW() - INTERVAL 24 HOUR
GROUP BY hour_bucket
ORDER BY hour_bucket ASC;


-- @block 4) 最近 7 天 DAU（按机器去重）
--   用途：看用户增长曲线
SELECT
    DATE(created_at)            AS day,
    COUNT(DISTINCT machine_id)  AS dau,
    COUNT(DISTINCT session_id)  AS sessions,
    COUNT(*)                    AS events
FROM events
WHERE created_at >= CURDATE() - INTERVAL 6 DAY
GROUP BY DATE(created_at)
ORDER BY day ASC;


-- @block 5) 扩展版本分布（看升级渗透率）
--   用途：判断新版本铺量速度，老版本是否需要强制升级
SELECT
    ext_version,
    COUNT(DISTINCT machine_id) AS machines,
    COUNT(*)                   AS events,
    MIN(created_at)            AS first_seen,
    MAX(created_at)            AS last_seen
FROM events
WHERE created_at >= NOW() - INTERVAL 7 DAY
  AND ext_version IS NOT NULL
GROUP BY ext_version
ORDER BY machines DESC;


-- @block 6) 平台 / 系统分布（用户画像）
--   用途：看用户群分布，决定后续兼容性优先级
SELECT
    platform,
    arch,
    COUNT(DISTINCT machine_id) AS machines,
    COUNT(*)                   AS events
FROM events
WHERE created_at >= NOW() - INTERVAL 7 DAY
GROUP BY platform, arch
ORDER BY machines DESC;


-- @block 7) props 字段 TOP 值（业务自定义维度分析）
--   用途：分析某个事件的某个 props 字段分布
--   示例：分析 'cmd.execute' 事件的 'cmdName' 字段 TOP 10
--   👉 把下面的 'cmd.execute' 和 '$.cmdName' 改成你关心的事件和字段
SELECT
    JSON_UNQUOTE(JSON_EXTRACT(props, '$.cmdName')) AS prop_value,
    COUNT(*)                                       AS cnt,
    COUNT(DISTINCT machine_id)                     AS uniq_machines
FROM events
WHERE event_name = 'cmd.execute'
  AND created_at >= NOW() - INTERVAL 7 DAY
  AND JSON_EXTRACT(props, '$.cmdName') IS NOT NULL
GROUP BY prop_value
ORDER BY cnt DESC
LIMIT 10;


-- @block 8) 异常事件占比（健康度）
--   用途：看 level=error/warn 的占比，及时发现异常爆发
SELECT
    DATE(created_at) AS day,
    level,
    COUNT(*)         AS cnt,
    ROUND(COUNT(*) * 100 / SUM(COUNT(*)) OVER (PARTITION BY DATE(created_at)), 2) AS pct
FROM events
WHERE created_at >= CURDATE() - INTERVAL 6 DAY
GROUP BY DATE(created_at), level
ORDER BY day DESC, cnt DESC;


-- ============================================================================
--  💡 进阶玩法（可选，按需取用）
-- ============================================================================

-- @block 9) 单个用户的完整事件流（排查问题神器）
--   用途：把某台机器最近一段时间的所有事件按时序拉出来
--   👉 把 'YOUR_MACHINE_ID' 替换成你关心的 machine_id
-- SELECT
--     id, event_name, level, ext_version, props,
--     created_at, FROM_UNIXTIME(client_ts / 1000) AS client_time
-- FROM events
-- WHERE machine_id = 'YOUR_MACHINE_ID'
--   AND created_at >= NOW() - INTERVAL 1 DAY
-- ORDER BY id DESC
-- LIMIT 200;


-- @block 10) 留存分析（次日留存简版）
--   用途：今天活跃的机器，明天还有多少回来
-- SELECT
--     d0.day                                 AS cohort_day,
--     COUNT(DISTINCT d0.machine_id)          AS cohort_size,
--     COUNT(DISTINCT d1.machine_id)          AS retained_d1,
--     ROUND(COUNT(DISTINCT d1.machine_id) * 100
--           / NULLIF(COUNT(DISTINCT d0.machine_id), 0), 2) AS retention_pct
-- FROM (
--     SELECT DATE(created_at) AS day, machine_id
--     FROM events
--     WHERE created_at >= CURDATE() - INTERVAL 7 DAY
--     GROUP BY day, machine_id
-- ) d0
-- LEFT JOIN (
--     SELECT DATE(created_at) AS day, machine_id
--     FROM events
--     WHERE created_at >= CURDATE() - INTERVAL 7 DAY
--     GROUP BY day, machine_id
-- ) d1
--   ON d1.machine_id = d0.machine_id
--  AND d1.day        = d0.day + INTERVAL 1 DAY
-- GROUP BY d0.day
-- ORDER BY d0.day ASC;
