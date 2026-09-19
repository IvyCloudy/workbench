/**
 * utils/pushFailure/aggregate.ts
 * -------------------------------------------------------------
 * 推送失败聚合器 · 按 category / field 分桶统计
 *   · FailureFieldStat / FailureCategoryStat 统计结构
 *   · aggregateByField / aggregateFailures 聚合
 *   · summarize*  / splitFieldStatsByLevel / topFieldOfLevel 埋点辅助
 *
 * 从原 utils/pushFailureCategory.ts 拆出。
 */

import { classifyFailure, type PushFailCategory } from './categoryClassify';
import { failureFieldDetail, fieldLevelOf, type PushInterfaceField, type PushFieldLevel } from './fieldMapping';

// ============================================
// 按字段聚合
// ============================================

/** 单条失败的字段统计（含原文样本，供 UI / 埋点）。 */
export interface FailureFieldStat {
    field: PushInterfaceField;
    level: PushFieldLevel;
    count: number;
    samples: string[];
    auxSamples: string[];
}

/**
 * 按接口字段聚合（聚焦维度）。非字段类错误（field 为 undefined）不计入。
 */
export function aggregateByField(
    items: Array<{ reason: string; field?: PushInterfaceField; category?: PushFailCategory; validatorKind?: string; mapErrorReason?: string }>,
    maxSamples = 2,
): FailureFieldStat[] {
    const buckets = new Map<PushInterfaceField, FailureFieldStat>();
    for (const it of items || []) {
        const reason = it.reason || '';
        const detail = failureFieldDetail({
            reason,
            validatorKind: it.validatorKind,
            mapErrorReason: it.mapErrorReason,
            category: it.category,
        });
        const field = it.field ?? detail.field;
        if (!field) continue;
        let stat = buckets.get(field);
        if (!stat) {
            stat = { field, level: fieldLevelOf(field), count: 0, samples: [], auxSamples: [] };
            buckets.set(field, stat);
        }
        stat.count++;
        if (stat.samples.length < maxSamples && reason && !stat.samples.includes(reason)) {
            stat.samples.push(reason);
        }
        if (detail.source === 'aux' && reason && !stat.auxSamples.includes(reason)) {
            stat.auxSamples.push(reason);
        }
    }
    return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

/**
 * 把辅助兜底项的原样 reason 压成埋点友好的紧凑串（reason || reason 分隔，去重）。
 */
export function summarizeAuxFieldSamples(stats: FailureFieldStat[]): string {
    const all = (stats || []).flatMap(s => s.auxSamples);
    return Array.from(new Set(all.filter(Boolean))).join(' || ');
}

/**
 * 按字段级别（interface / case）拆分聚合结果，便于 UI 分两个 section 展示。
 */
export function splitFieldStatsByLevel(stats: FailureFieldStat[]): { interfaceStats: FailureFieldStat[]; caseStats: FailureFieldStat[] } {
    const interfaceStats: FailureFieldStat[] = [];
    const caseStats: FailureFieldStat[] = [];
    for (const s of stats || []) {
        (s.level === 'interface' ? interfaceStats : caseStats).push(s);
    }
    return { interfaceStats, caseStats };
}

/** 求某一层级中 count 最高的字段（用于埋点 topInterfaceFailField / topCaseFailField） */
export function topFieldOfLevel(stats: FailureFieldStat[], level: PushFieldLevel): FailureFieldStat | undefined {
    return (stats || []).find(s => s.level === level);
}

/**
 *  把字段聚合压成埋点友好紧凑串（field:count 逗号分隔），空聚合返回 ''。
 */
export function summarizeFieldBreakdown(stats: FailureFieldStat[], level?: PushFieldLevel): string {
    return (stats || [])
        .filter(s => !level || s.level === level)
        .map(s => `${s.field}:${s.count}`)
        .join(',');
}

// ============================================
// 按 category 聚合
// ============================================

/** 单条失败的分类统计（已含若干原文样本，供 UI 展示与埋点 sample） */
export interface FailureCategoryStat {
    category: PushFailCategory;
    count: number;
    samples: string[];
}

/**
 * 把一组失败按 category 分桶聚合。
 */
export function aggregateFailures(
    items: Array<{ reason: string; category?: PushFailCategory; validatorKind?: string; mapErrorReason?: string }>,
    maxSamples = 2,
): FailureCategoryStat[] {
    const buckets = new Map<PushFailCategory, FailureCategoryStat>();
    for (const it of items || []) {
        const reason = it.reason || '';
        const cat = it.category
            || classifyFailure({ reason, validatorKind: it.validatorKind, mapErrorReason: it.mapErrorReason });
        const limit = cat === 'unknown' ? Infinity : maxSamples;
        let stat = buckets.get(cat);
        if (!stat) {
            stat = { category: cat, count: 0, samples: [] };
            buckets.set(cat, stat);
        }
        stat.count++;
        if (stat.samples.length < limit && reason && !stat.samples.includes(reason)) {
            stat.samples.push(reason);
        }
    }
    return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

/**
 * 把聚合结果压成埋点友好的紧凑字符串（category:count 逗号分隔）。
 */
export function summarizeCategoryBreakdown(stats: FailureCategoryStat[]): string {
    return (stats || [])
        .map(s => `${s.category}:${s.count}`)
        .join(',');
}
