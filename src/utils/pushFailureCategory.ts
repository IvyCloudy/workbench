/**
 * ============================================================================
 *  utils/pushFailureCategory.ts   （@deprecated · 2026-09-19 拆分）
 * ----------------------------------------------------------------------------
 *  本文件已拆分为 `utils/pushFailure/` 目录下的 3 个子模块：
 *    - categoryClassify.ts  分类枚举 + 归类器
 *    - fieldMapping.ts      接口字段抽取 + 字段聚焦
 *    - aggregate.ts         按 field / category 聚合器
 *
 *  为保持向后兼容，本文件已改为纯 re-export barrel。新代码请从
 *  `utils/pushFailure` 引入；本 barrel 会保留但不再新增导出。
 * ============================================================================
 */

export * from './pushFailure';