/**
 * ============================================================================
 *  handlers/pushCore.ts
 *  推送流程公共核心 —— 资源管理器右键推送 & 编辑器内推送 共用
 * ----------------------------------------------------------------------------
 *  本文件为「barrel + 埋点封装」：仅保留对外类型导出、主流程 re-export，
 *  以及契约测试所需的埋点 marker 函数（emitAborted / buildFailDimensions）。
 *  具体编排与阶段逻辑见：
 *    - pushCore.stages.ts   通用辅助 + 阶段 1~5 + step* + runPush 主编排
 *    - pushCore.types.ts    全部类型（PushCoreHooks / RunPushOptions / PushContext 等）
 * ============================================================================
 */

import * as path from 'path';
import { TelemetryService } from '../utils/telemetry';

/** 单次推送行数默认上限（可通过 RunPushOptions.maxRows 覆盖）。 */
const DEFAULT_MAX_PUSH_ROWS = 5000;
import { telemetryErrProps } from '../utils/extensionHelpers';
import { stackHead } from '../services/utils';
import { pushDiag, showPushDiag } from '../utils/pushDiagnostics';
import { persistPushFailures } from '../utils/pushFailureStore';
import {
    classifyFailure,
    failureFieldOf,
    aggregateFailures,
    aggregateByField,
    summarizeCategoryBreakdown,
    summarizeFieldBreakdown,
    summarizeAuxFieldSamples,
    topFieldOfLevel,
} from '../utils/pushFailureCategory';
import type { PushFailureItem, PushCoreHooks, RunPushOptions, PushContext } from './pushCore.types';

// 子模块：类型 + 阶段逻辑 + 主编排（保留原导出名，便于调用方零改动）。
import {
    readTsId,
    runValidators,
    DEFAULT_VALIDATORS,
    collectPlaceholderTestcaseIdFailures,
    collectEmptyTestcaseIdFailures,
    collectInvalidFormatFailures,
    buildRowIndexMappings,
    buildTsIdToIndex,
    buildFailureItems,
    resolveTaskInfoOrNull,
    extractSampleRows,
    writeBackTestCaseNos,
    stampRowIndex,
    stepPreValidate,
    applyPreValidationDrops,
    pickAllDroppedReason,
    stepInvokeBackend,
    sanitizeSampleLeaks,
    refreshAllFailedSnapshot,
    handleUnexpectedError,
    type RowLike,
    type RowValidator,
} from './pushCore.stages';

export type {
    PushFailureItem,
    PushCoreHooks,
    RunPushOptions,
    PushContext,
    WriteBackOptions,
    ExtractSampleRowsResult,
    RowIndexResolveCtx,
    ResolveTaskInfoResult,
    PreValidationResult,
} from './pushCore.types';
export {
    readTsId,
    runValidators,
    DEFAULT_VALIDATORS,
    collectPlaceholderTestcaseIdFailures,
    collectEmptyTestcaseIdFailures,
    collectInvalidFormatFailures,
    buildRowIndexMappings,
    buildTsIdToIndex,
    buildFailureItems,
    resolveTaskInfoOrNull,
    extractSampleRows,
    writeBackTestCaseNos,
    stampRowIndex,
    stepPreValidate,
    type RowLike,
    type RowValidator,
} from './pushCore.stages';

// ============================================
// 埋点封装（保留在 barrel：契约测试读源码 marker）
// ============================================

/** 埋点事件的公共字段（ext + traceId），所有 step 共用。 */
function baseTelemetryProps(ctx: PushContext): Record<string, string> {
    return { ext: ctx.fileExt, traceId: ctx.traceId };
}

/**
 * 发送 `.aborted` 中断埋点的统一封装。
 * 内聚各中断分支的公共字段（ext / traceId）与耗时（costMs），避免每个调用点重复拼装。
 * extra 透传中断原因专属维度（如 totalRows / count / sampleCount / buildFailDimensions 结果）。
 */
function emitAborted(ctx: PushContext, reason: string, extra?: Record<string, string>): void {
    TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.aborted`, {
        ...baseTelemetryProps(ctx),
        reason,
        costMs: String(Date.now() - ctx.pushStart),
        ...extra,
    });
}

/**
 * 失败分类/字段维度的公共埋点 props 组装器。
 * 把一组 PushFailureItem 聚合并产出「失败结局事件」共用的维度对象，
 * 供 `.aborted` / `.complete` / `batch.fileResult` / `batch.done` 直接展开复用，
 * 消除各事件手工重复拼装 summarizeFieldBreakdown / topFieldOfLevel / auxFieldRawSamples / *Samples 的问题。
 *
 * 维度含：failCategoryBreakdown / topFailCategory / failFieldBreakdown / topFailField /
 *        interfaceFailBreakdown / topInterfaceFailField / caseFailBreakdown / topCaseFailField /
 *        auxFieldRawSamples / taskNotFoundSamples / testPointMissingSamples /
 *        pathNotMatchPointSamples / sourceNotSupportedSamples / paramFormatSamples /
 *        fieldInvalidSamples / unknownSamples（全量未归类原文，不受 3 条上限约束）。
 *
 * 空 failures 时各维度返回 '' / [] 安全值，调用方可直接展开。
 */
export function buildFailDimensions(failures: PushFailureItem[]): Record<string, string> {
    const stats = failures.length > 0 ? aggregateFailures(failures, 3) : [];
    const fieldStats = failures.length > 0 ? aggregateByField(failures, 1) : [];
    const pick = (cat: string) =>
        (stats.find(s => s.category === cat)?.samples ?? [])
            .map(s => (s || '').slice(0, 200))
            .join(' || ');
    const unknownSamples = Array.from(
        new Set(
            failures
                .filter(f => (f.category ?? classifyFailure(f)) === 'unknown')
                .map(f => (f.reason || '').slice(0, 200)),
        ),
    ).filter(Boolean).join(' || ');
    return {
        failCategoryBreakdown: summarizeCategoryBreakdown(stats),
        topFailCategory: stats.length ? stats[0].category : '',
        failFieldBreakdown: summarizeFieldBreakdown(fieldStats),
        topFailField: fieldStats.length ? fieldStats[0].field : '',
        interfaceFailBreakdown: summarizeFieldBreakdown(fieldStats, 'interface'),
        topInterfaceFailField: topFieldOfLevel(fieldStats, 'interface')?.field || '',
        caseFailBreakdown: summarizeFieldBreakdown(fieldStats, 'case'),
        topCaseFailField: topFieldOfLevel(fieldStats, 'case')?.field || '',
        auxFieldRawSamples: summarizeAuxFieldSamples(fieldStats),
        taskNotFoundSamples: pick('taskNotFound'),
        testPointMissingSamples: pick('testPointMissing'),
        pathNotMatchPointSamples: pick('pathNotMatchPoint'),
        sourceNotSupportedSamples: pick('sourceNotSupported'),
        paramFormatSamples: pick('paramFormat'),
        fieldInvalidSamples: pick('fieldInvalid'),
        unknownSamples,
    };
}

/** 安全调用 hook：吞掉钩子异常，避免污染主流程；仅用于"通知型"钩子。 */
function safeInvoke<T extends (...args: any[]) => any>(fn: T | undefined, ...args: Parameters<T>): void {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (_) { /* 忽略钩子异常 */ }
}

/** 进度反馈统一入口，收敛多处 try/catch 样板。 */
function emitProgress(
    hooks: Pick<PushCoreHooks, 'onProgress'>,
    stage: 'start' | 'pushing' | 'writingBack' | 'done',
    payload?: { rows?: number },
): void {
    safeInvoke(hooks.onProgress, stage, payload);
}

// ============================================
// 主流程编排（stepResolveTaskInfo / stepCheckMaxRows / runPush）
// 这三个函数直接调用本文件内的 emitAborted / buildFailDimensions，
// 故留在 barrel；其余 step 见 pushCore.stages.ts。
// ============================================

/** step 0：任务信息拉取 + 分派对应 hook。返回 taskInfo 或 null（表示已中断）。 */
async function stepResolveTaskInfo(ctx: PushContext): Promise<{ testTaskNo: string; subTestTaskId: string } | null> {
    const { filePath } = ctx.opts;
    const result = await resolveTaskInfoOrNull(filePath);
    if (result.status === 'unbound') {
        emitAborted(ctx, 'unbound');
        ctx.hooks.onUnbound();
        return null;
    }
    if (result.status === 'error') {
        console.error(`[推送][${ctx.traceId}] 获取任务信息异常:`, result.errorMessage);
        TelemetryService.sendTelemetryErrorEvent(`${ctx.telemetryPrefix}.taskInfoFailed`, {
            ...baseTelemetryProps(ctx),
            ...telemetryErrProps(result.error),
            errorMessage: result.errorMessage.slice(0, 500),
            stackHead: stackHead(result.error),
        });
        const uiMsg = `未能获取任务信息，推送已中断：${result.errorMessage}`;
        if (ctx.hooks.onTaskInfoFailed) ctx.hooks.onTaskInfoFailed(uiMsg);
        else ctx.hooks.onBackendError(uiMsg);
        return null;
    }
    return result.taskInfo;
}

/** step 1.5：行数上限保护。命中返回 true 表示已中断。 */
function stepCheckMaxRows(ctx: PushContext, rowCount: number): boolean {
    if (rowCount <= ctx.maxRows) return false;
    emitAborted(ctx, 'exceedMaxRows', {
        totalRows: String(rowCount),
        limit: String(ctx.maxRows),
    });
    const uiMsg = `本次待推送 ${rowCount} 行，超过单次上限 ${ctx.maxRows} 行。请分批选择后再推送，避免请求超时。`;
    if (ctx.hooks.onExceedMaxRows) ctx.hooks.onExceedMaxRows({ rows: rowCount, limit: ctx.maxRows, message: uiMsg });
    else ctx.hooks.onBackendError(uiMsg);
    return true;
}

/**
 * 主推送流程。执行顺序（含短路）：
 *   0. taskInfo 未绑定 → onUnbound + return
 *   1. 空数据 → onNoData + return（右键场景才有 onNoData 钩子）
 *   2. 预校验失败（占位/空 tsId） → 分别埋点/持久化，全部剔除则短路走 onComplete
 *   3. 样例过滤后无剩余 → onOnlySampleRows + return
 *   4. pushTestCase → returnCode 失败 → onBackendError + return
 *   5. parsePushResponse → 泄露埋点 + 清洗
 *   6. 成功回写 testCaseNo（含快照更新）/ 全部失败快照兜底
 *   7. 汇总 failureItems（三级降级） → onComplete + persistPushFailures
 */
export async function runPush(opts: RunPushOptions): Promise<void> {
    const ctx: PushContext = {
        opts,
        baseName: path.basename(opts.filePath),
        fileExt: path.extname(opts.filePath).toLowerCase(),
        pushStart: Date.now(),
        traceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        maxRows: typeof opts.maxRows === 'number' && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_PUSH_ROWS,
        telemetryPrefix: opts.telemetryPrefix,
        hooks: opts.hooks,
    };
    const originalRowsCount = Array.isArray(opts.rows) ? opts.rows.length : 0;
    pushDiag(`[入口] runPush 开始 | 原始行数=${originalRowsCount} | frontPushIndexToRow长度=${opts.frontPushIndexToRow?.length ?? 0} | frontRowIndexMap键数=${opts.frontRowIndexMap ? Object.keys(opts.frontRowIndexMap).length : 0} | maxRows=${ctx.maxRows} | filePath=${opts.filePath}`);
    let preValidationFailures: PushFailureItem[] = [];

    try {
        const taskInfo = await stepResolveTaskInfo(ctx);
        if (!taskInfo) return;

        let rows: RowLike[] = Array.isArray(opts.rows) ? opts.rows : [];
        if (rows.length === 0) {
            emitAborted(ctx, 'noData');
            ctx.hooks.onNoData?.();
            return;
        }

        rows = stampRowIndex(rows, opts.resolveRowIndex);

        if (stepCheckMaxRows(ctx, rows.length)) return;

        const pre = await stepPreValidate(ctx, rows);
        preValidationFailures = pre.failures;

        const applied = applyPreValidationDrops(rows, pre.droppedIndex);
        rows = applied.rows;
        const preFilterToOriginal = applied.preFilterToOriginal;
        {
            const byCat: Record<string, number> = {};
            pre.failures.forEach((f: any) => { const c = f?.category || '未知'; byCat[c] = (byCat[c] || 0) + 1; });
            pushDiag(`[预校验] 预校验失败=${pre.failures.length} 类别分布=${JSON.stringify(byCat)} | 剔除后剩余可推送行=${rows.length} | 是否短路=${rows.length === 0 ? '是（不调接口）' : '否'}`);
            if (pre.failures.length) pushDiag('[预校验] 失败明细:', pre.failures.map((f: any) => ({ row: f.rowIndex, tsId: f.tsId, cat: f.category, reason: f.reason })));
        }

        if (rows.length === 0) {
            emitAborted(ctx, pickAllDroppedReason(pre.byKind), {
                count: String(preValidationFailures.length),
                ...buildFailDimensions(preValidationFailures),
            });
            pushDiag(`[短路-全部预校验失败] 总数=${originalRowsCount} 失败=${preValidationFailures.length} | 不调用接口`);
            pushDiag('[短路] 失败明细:', preValidationFailures.map((f: any) => ({ row: f.rowIndex, tsId: f.tsId, cat: f.category, reason: f.reason })));
            showPushDiag();
            ctx.hooks.onComplete({
                successCount: 0,
                failures: preValidationFailures,
                total: originalRowsCount,
                skipped: 0,
                preValidationFailCount: preValidationFailures.length,
                traceId: ctx.traceId,
                costMs: Date.now() - ctx.pushStart,
            });
            emitProgress(ctx.hooks, 'done', { rows: 0 });
            return;
        }

        const { filtered, sampleFailures, skipped, filteredToOriginal } = extractSampleRows(
            opts.filePath, rows, opts.resolveRowIndex,
        );
        if (filtered.length === 0) {
            if (preValidationFailures.length > 0) {
                emitAborted(ctx, 'onlyTemplateExampleAndPreValidationFailed', {
                    sampleCount: String(sampleFailures.length),
                    preValidationCount: String(preValidationFailures.length),
                    ...buildFailDimensions([...preValidationFailures, ...sampleFailures]),
                });
                pushDiag(`[短路-仅样例+预校验失败] 总数=${originalRowsCount} 预校验失败=${preValidationFailures.length} 样例失败=${sampleFailures.length} | 不调用接口`);
                showPushDiag();
                ctx.hooks.onComplete({
                    successCount: 0,
                    failures: [...preValidationFailures, ...sampleFailures],
                    total: originalRowsCount,
                    skipped: 0,
                    preValidationFailCount: preValidationFailures.length,
                    traceId: ctx.traceId,
                    costMs: Date.now() - ctx.pushStart,
                });
                emitProgress(ctx.hooks, 'done', { rows: 0 });
                return;
            }
            emitAborted(ctx, 'onlyTemplateExample', {
                count: String(sampleFailures.length),
                ...buildFailDimensions(sampleFailures),
            });
            if (!ctx.opts.skipCompleteTelemetry) {
                TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.complete`, {
                    ...baseTelemetryProps(ctx),
                    pushResult: 'allFail',
                    totalRows: String(originalRowsCount),
                    successRows: '0',
                    failedRows: String(sampleFailures.length),
                    preValidationFailedRows: '0',
                    ...buildFailDimensions(sampleFailures),
                    costMs: String(Date.now() - ctx.pushStart),
                });
            }
            ctx.hooks.onOnlySampleRows(sampleFailures);
            return;
        }
        if (skipped > 0) {
            console.log(`[推送][${ctx.traceId}] 已过滤 ${skipped} 行模板示例数据`);
            TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.skipTemplateExample`, {
                ...baseTelemetryProps(ctx), skipped: String(skipped),
            });
        }
        rows = filtered;
        pushDiag(`[样例过滤] 过滤后剩余=${rows.length} 行 | 跳过样例=${skipped} | 样例失败=${sampleFailures.length} | filteredToOriginal映射长度=${filteredToOriginal.length}`);

        pushDiag(`[接口] 即将调用后端推送 | 实际推送行数=${rows.length} ${rows.length === 0 ? '⚠️ 无合法行，将不调用接口' : ''}`);
        const invoked = await stepInvokeBackend(ctx, rows, taskInfo);

        pushDiag('[step5] sanitizeSampleLeaks 开始');
        const cleaned = sanitizeSampleLeaks(ctx, invoked.successMappings, invoked.failures);
        const successMappings = cleaned.successMappings;
        const failures = cleaned.failures;
        pushDiag(`[step5] 清洗后 success=${successMappings.length} failures=${failures.length}`);

        if (successMappings.length > 0) {
            emitProgress(ctx.hooks, 'writingBack', { rows: successMappings.length });
            await writeBackTestCaseNos({
                filePath: opts.filePath,
                successMappings,
                parser: opts.parser,
                hooks: {
                    markSelfSave: ctx.hooks.markSelfSave,
                    afterWriteBack: ctx.hooks.afterWriteBack,
                    onWriteBackFailed: ctx.hooks.onWriteBackFailed,
                },
                hasFailure: failures.length > 0,
                telemetryContext: baseTelemetryProps(ctx),
                telemetryPrefix: ctx.telemetryPrefix,
            });
        } else if (failures.length > 0) {
            await refreshAllFailedSnapshot(ctx);
        }
        pushDiag('[step6] 回写/快照完成');

        const tsIdToIndex = buildTsIdToIndex(rows);
        const composedFilteredToOriginal: number[] = filteredToOriginal.map(idx =>
            typeof preFilterToOriginal[idx] === 'number' ? preFilterToOriginal[idx] : idx,
        );
        const failureItems = buildFailureItems(
            failures, tsIdToIndex, opts.frontRowIndexMap, opts.frontPushIndexToRow, composedFilteredToOriginal,
        );
        const mergedFailures: PushFailureItem[] = [...preValidationFailures, ...failureItems].sort(
            (a, b) => (a.rowIndex ?? Number.MAX_SAFE_INTEGER) - (b.rowIndex ?? Number.MAX_SAFE_INTEGER),
        );
        const total = originalRowsCount;
        pushDiag(`[step7] 合并后 total=${total} success=${successMappings.length} failures=${mergedFailures.length}（预校验=${preValidationFailures.length} 接口=${failureItems.length}）`);

        pushDiag(`[汇总] 总数=${total} 成功=${successMappings.length} 失败=${mergedFailures.length}（其中预校验=${preValidationFailures.length} / 接口=${mergedFailures.length - preValidationFailures.length}）`);
        pushDiag('[汇总] 失败明细(按行号):', mergedFailures.map((f: any) => ({ row: f.rowIndex, tsId: f.tsId, cat: f.category, field: f.field, reason: f.reason })));
        showPushDiag();
        ctx.hooks.onComplete({
            successCount: successMappings.length,
            failures: mergedFailures,
            total,
            skipped,
            preValidationFailCount: preValidationFailures.length,
            traceId: ctx.traceId,
            costMs: Date.now() - ctx.pushStart,
        });
        try {
            await persistPushFailures(opts.filePath, rows, failures, successMappings);
        } catch (err: any) {
            console.error(`[推送][${ctx.traceId}] 持久化失败标记失败:`, err?.message || err);
        }

        const failDimensions = buildFailDimensions(mergedFailures);

        if (!ctx.opts.skipCompleteTelemetry) {
            TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.complete`, {
                ...baseTelemetryProps(ctx),
                pushResult: mergedFailures.length === 0
                    ? 'allSuccess'
                    : (successMappings.length === 0 ? 'allFail' : 'partial'),
                totalRows: String(total),
                successRows: String(successMappings.length),
                failedRows: String(mergedFailures.length),
                preValidationFailedRows: String(preValidationFailures.length),
                ...failDimensions,
                costMs: String(Date.now() - ctx.pushStart),
            });
        }
        emitProgress(ctx.hooks, 'done', { rows: total });
    } catch (err: any) {
        pushDiag(`[异常] runPush catch | err=${err?.message || err} | stack=${(err?.stack || '').slice(0, 300)}`);
        showPushDiag();
        handleUnexpectedError(ctx, err, originalRowsCount, preValidationFailures);
    }
}
