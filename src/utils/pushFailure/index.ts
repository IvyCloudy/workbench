/**
 * utils/pushFailure/index.ts
 * -------------------------------------------------------------
 * 推送失败模块 · 对外统一出口（barrel）
 * -------------------------------------------------------------
 * 使用建议：新代码请从 '../utils/pushFailure' 引用；老路径
 * '../utils/pushFailureCategory' 仍通过 re-export 保持兼容，但已 @deprecated。
 */

export {
    classifyBackendFailure,
    classifyFailure,
    isFieldRelatedCategory,
    fieldOfComposite,
} from './categoryClassify';
export type { FailNature, PushFailCategory } from './categoryClassify';

export {
    fieldLevelOf,
    extractInterfaceField,
    auxiliaryFieldOf,
    failureFieldDetail,
    failureFieldOf,
} from './fieldMapping';
export type { PushInterfaceField, PushFieldLevel, FieldSource } from './fieldMapping';

export {
    aggregateByField,
    aggregateFailures,
    summarizeAuxFieldSamples,
    splitFieldStatsByLevel,
    topFieldOfLevel,
    summarizeFieldBreakdown,
    summarizeCategoryBreakdown,
} from './aggregate';
export type { FailureFieldStat, FailureCategoryStat } from './aggregate';
