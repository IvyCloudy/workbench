/**
 * ============================================================================
 *  handlers/pushCore.ts
 *  推送流程公共核心 —— 资源管理器右键推送 & 编辑器内推送 共用
 * ----------------------------------------------------------------------------
 *  职责（只做数据/流程编排，不做 UI）：
 *    1. 校验 testcase_id 占位（'TESTCASE_ID' 大写占位）与空 tsId ——
 *       命中的行标记为"预校验失败"并从推送 payload 中剔除，剩余合规行继续推送；
 *       全部行都命中时，跳过后端调用直接以 onComplete 汇总展示。
 *    2. 静默过滤中文样例占位行（'案例唯一标识，不可修改' / '案例唯一标识'）；
 *       全部选中行都是样例时终止并返回样例失败明细。
 *    3. 构造 taskInfo、判定 pushSource、调用后端推送接口。
 *    4. 解析后端响应；生成失败泄露埋点数据；成功回写 testCaseNo & 快照。
 *    5. 汇总失败行号（多级降级）并将预校验失败合并进最终结果，统一由 onComplete 输出。
 *
 *  设计要点：
 *    - 所有 UI 反馈（webview 弹窗 / 独立 webview / postMessage）通过 hooks 回调
 *      交给调用方处理，本文件仅负责流程与数据。
 *    - 埋点前缀（explorerPush.* / editorPush.*）由调用方通过 telemetryPrefix 注入。
 *    - 行号解析优先级（供失败弹窗"第 N 行"点击跳转）：
 *        1) rowIndexMap[tsId]      —— 前端下发的 tsId → 主表 1-based 行号
 *        2) pushIndexToRow[bodyIndex] —— 前端下发的 payload 数组下标 → 主表行号
 *        3) tsIdToRowIndex[tsId]   —— 扩展端从 pushData 顺序自算（0-based → +1）
 *    - 校验/过滤阶段的行号解析函数由调用方注入（resolveRowIndex），
 *      因为右键推送用 `i+1`（整表原始下标），编辑器推送用 `pushIndexToRow[i]`。
 * ============================================================================
 */

import * as path from 'path';
import type * as vscode from 'vscode';
import { pushTestCase } from '../services/http';
import { parsePushResponse, PushSuccessMapping, PushResponseFailure } from '../utils/pushResponse';
import { getCurrentTaskInfo } from '../utils/commands';
import {
    isCreatedByCommand,
    filterTemplateExampleRows,
    TEMPLATE_EXAMPLE_TS_ID,
    isSampleTsId,
} from '../utils/fileIdentifier';
import { persistPushFailures } from '../utils/pushFailureStore';
import { savePushSnapshot } from '../utils/pushSnapshotStore';
import { normalizePushData } from '../utils/headerLabels';
import { TS_ID_COLUMN, stackHead } from '../services/utils';
import { sendTelemetryEvent, sendTelemetryErrorEvent } from '../utils/telemetry';
import { telemetryErrProps } from '../utils/extensionHelpers';
import { createParser, ensureTrackingColumns, applyTestCaseNos, detectFileType, type FileParser } from '../parsers';

// ============================================
// 类型定义
// ============================================

/** 推送失败明细项（送给 showPushResult 弹窗渲染） */
export interface PushFailureItem {
    tsId: string;
    reason: string;
    /** 主表 1-based 行号；undefined 时前端渲染为"(无)"不可点击 */
    rowIndex?: number;
}

/**
 * 推送核心 hooks —— UI 反馈全部收敛于此，本文件不直接调用 showXxx / postMessage。
 * 调用方按场景各自实现：右键推送走独立 webview 弹窗，编辑器推送走当前 panel 内嵌弹窗。
 */
export interface PushCoreHooks {
    /** 未绑定任务 */
    onUnbound: () => void;
    /**
     * 拉取任务信息时抛出异常（网络抖动 / 后端 5xx 等）。
     * 未实现时会降级走 onBackendError；调用方可实现以给出更精准的文案。
     */
    onTaskInfoFailed?: (errorMsg: string) => void;
    /** 文件无数据（仅右键推送场景使用；编辑器推送场景忽略即可） */
    onNoData?: () => void;
    /**
     * 命中占位 TESTCASE_ID —— 弹窗展示 & 通知前端解锁 UI。
     * @deprecated 自 v?.? 起，占位行改为"标记失败 + 从 payload 剔除"，
     *             失败信息会随其他行的推送结果一起在 onComplete 中输出，
     *             该 hook 不再由 runPush 触发。保留仅用于向后兼容外部实现。
     */
    onPlaceholderTestcaseId: (failures: PushFailureItem[]) => void;
    /**
     * testcase_id 为空的行 —— 弹窗展示 & 通知前端解锁 UI。
     * @deprecated 自 v?.? 起，空 tsId 行改为"标记失败 + 从 payload 剔除"，
     *             失败信息随其他行的推送结果一起在 onComplete 中输出，该 hook 不再触发。
     *             未实现时会降级复用 onPlaceholderTestcaseId（历史行为，保持类型兼容）。
     */
    onEmptyTestcaseId?: (failures: PushFailureItem[]) => void;
    /** 全部行为样例数据 —— 弹窗展示 & 通知前端解锁 UI */
    onOnlySampleRows: (failures: PushFailureItem[]) => void;
    /** 后端 returnCode 非成功 —— 弹窗展示错误信息 & 通知前端解锁 UI */
    onBackendError: (errorMsg: string) => void;
    /**
     * runPush 顶层未捕获异常兜底。所有下游 hooks 都不会再触发。
     * 未实现时会降级走 onBackendError；主要作用是让前端解锁按钮 loading。
     */
    onUnexpectedError?: (errorMsg: string) => void;
    /**
     * 成功回写 testCaseNo 到原文件失败时的兜底通知。
     * 用户已经看到"推送成功 N 条"，但文件里的 testCaseNo 未写入 —— 需要显式提示，
     * 否则用户下次再推送同批行会重复创建案例。
     */
    onWriteBackFailed?: (errorMsg: string) => void;
    /**
     * 单次推送行数超过上限（RunPushOptions.maxRows，默认 5000）时的提示。
     * 未实现时会降级走 onBackendError；主要作用是让前端给出"请分批推送"的引导。
     */
    onExceedMaxRows?: (payload: { rows: number; limit: number; message: string }) => void;
    /**
     * 关键阶段进度反馈（可选）。用于让调用方在耗时较长的推送流程中给出用户反馈：
     *   - 'start'        —— 校验通过，即将调用后端
     *   - 'pushing'      —— 已发出后端请求
     *   - 'writingBack'  —— 后端返回成功，正在写盘 testCaseNo
     *   - 'done'         —— 全部结束（成功/部分成功/全部失败均会触发）
     * 未实现即可（无副作用）。
     */
    onProgress?: (stage: 'start' | 'pushing' | 'writingBack' | 'done', payload?: { rows?: number }) => void;
    /** 推送完成（成功/部分成功/全部失败）—— 弹窗展示结果 */
    onComplete: (payload: {
        successCount: number;
        failures: PushFailureItem[];
        total: number;
    }) => void;
    /**
     * 成功回写 testCaseNo 前后的钩子。用于编辑器场景标记 self-save 时间戳
     * 防止 fsWatcher 在 pushSuccess 刷新期间覆盖高亮状态；右键场景无需实现。
     */
    markSelfSave?: () => void;
    /**
     * 成功回写完成后的钩子。
     * - 编辑器场景：清空高亮 / 刷新 webview（当无失败时）；
     * - 右键场景：无需实现。
     */
    afterWriteBack?: (context: {
        parsedTableData: any;
        parsedSourceData: any;
        hasFailure: boolean;
    }) => Promise<void>;
    /**
     * 全部推送失败时的快照/高亮兜底钩子（仅编辑器场景需要）。
     * 右键推送不管前端高亮状态，可不实现。
     */
    onAllFailedSnapshot?: (context: {
        parsedTableData: any;
        parsedSourceData: any;
    }) => Promise<void>;
}

/** 校验/过滤阶段的输入行结构（只需 TS_ID_COLUMN 字段） */
type RowLike = Record<string, any>;

// ============================================
// 内部工具：traceId
// ============================================

/**
 * 生成一次推送流程的唯一 traceId，串联同一次 runPush 的所有埋点。
 * 格式：`${timestamp36}-${random36}`，长度约 12~14 字符，同批日志肉眼可对齐。
 * 不使用 crypto.randomUUID 以避免 Node <14.17 兼容问题；对定位问题足够。
 */
function newPushTraceId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 单次推送行数默认上限（可通过 RunPushOptions.maxRows 覆盖）。 */
const DEFAULT_MAX_PUSH_ROWS = 5000;

// ============================================
// 阶段 1：校验 —— TESTCASE_ID 占位
// ============================================

/**
 * 校验：testcase_id 为占位值 TESTCASE_ID 时不允许推送。
 * 注意：调用方必须在 filterTemplateExampleRows 之前调用本函数，
 * 才能保证 resolveRowIndex(i) 返回的行号与主表原始行号一致，
 * 弹窗中"第 N 行"点击跳转才准确。
 *
 * 说明：中文样例占位（'案例唯一标识，不可修改' / '案例唯一标识'）不走此分支，
 *      由 extractSampleRows 静默过滤；只有全部行都是样例时才提示"为样例数据"。
 *
 * @param rows              待校验的原始行数组（未经样例过滤）
 * @param resolveRowIndex   下标 → 主表 1-based 行号 的解析函数：
 *                          - 右键推送：`i => i + 1`（整表原始下标）
 *                          - 编辑器推送：`i => pushIndexToRow[i] ?? (i + 1)`（前端下发映射）
 */
export function collectPlaceholderTestcaseIdFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    const failures: PushFailureItem[] = [];
    if (!Array.isArray(rows)) return failures;
    rows.forEach((rec, i) => {
        const tsId = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]).trim() : '';
        if (tsId.toUpperCase() === 'TESTCASE_ID') {
            failures.push({
                tsId,
                reason: 'testcase_id 为占位值 TESTCASE_ID，请修改为真实的案例 ID 后再推送',
                rowIndex: resolveRowIndex(i),
            });
        }
    });
    return failures;
}

/**
 * 校验：testcase_id 为空时不允许推送。
 * 与 TESTCASE_ID 占位、样例占位并列的第三种前置校验，处理"用户漏填"场景。
 * 空 tsId 若放行到后端，会被判为 400 类失败，且弹窗中失败行的行号定位会因 tsId 缺失
 * 而三级降级都拿不到，导致用户看到"(无)"不可跳转。前置校验后可直接给出精确行号提示。
 *
 * 注意：与 collectPlaceholderTestcaseIdFailures 一样，需在 filterTemplateExampleRows 之前调用。
 *
 * @param rows              待校验行
 * @param resolveRowIndex   下标 → 主表 1-based 行号
 */
export function collectEmptyTestcaseIdFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    const failures: PushFailureItem[] = [];
    if (!Array.isArray(rows)) return failures;
    rows.forEach((rec, i) => {
        const raw = rec ? rec[TS_ID_COLUMN] : undefined;
        const tsId = raw == null ? '' : String(raw).trim();
        if (tsId === '') {
            failures.push({
                // 用一个稳定的伪 tsId 便于持久化标记不冲突（每行独立）；
                // 前端弹窗只显示 reason + rowIndex，用户看不到该字段，不影响 UX。
                tsId: `__EMPTY_TSID_ROW_${resolveRowIndex(i)}__`,
                reason: 'testcase_id 不能为空，请填写案例 ID 后再推送',
                rowIndex: resolveRowIndex(i),
            });
        }
    });
    return failures;
}

// ============================================
// 阶段 2：过滤 —— 中文样例占位
// ============================================

/**
 * 静默过滤中文样例占位行（'案例唯一标识，不可修改' / '案例唯一标识'）。
 * 无论文件是否通过插件命令创建，这些行都不参与推送，也无需在多选中提示；
 * 若过滤后仍剩余业务数据，正常推送；若全部行都是样例，则提示"为样例数据"，
 * 并按具体行号列出（弹窗中"第 N 行"可点击跳转到主表对应行）。
 *
 * @param filePath          文件路径（filterTemplateExampleRows 需要）
 * @param rows              待过滤行
 * @param resolveRowIndex   下标 → 主表 1-based 行号（同 collectPlaceholderTestcaseIdFailures）
 * @returns  { filtered, sampleFailures, skipped, filteredToOriginal }
 *          - filtered:            过滤后剩余的行（可能为空）
 *          - sampleFailures:      样例行的失败明细（用于全过滤空场景弹窗）
 *          - skipped:             过滤掉的样例行数（用于埋点 "skipped"）
 *          - filteredToOriginal:  过滤后下标 → 原始 rows 下标 的映射数组。
 *                                  用于修复 后端返回 bodyIndex（基于 filtered）与前端下发
 *                                  pushIndexToRow（基于 filtered 前 payload）之间的错位。
 */
export function extractSampleRows(
    filePath: string,
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): { filtered: RowLike[]; sampleFailures: PushFailureItem[]; skipped: number; filteredToOriginal: number[] } {
    const src = Array.isArray(rows) ? rows : [];
    const sampleFailures: PushFailureItem[] = [];
    // 先按原始下标收集样例行号，再执行过滤；保证行号与主表原始行号一致
    for (let i = 0; i < src.length; i++) {
        const rec = src[i];
        const tsId = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]).trim() : '';
        if (isSampleTsId(tsId)) {
            const rowIndex = resolveRowIndex(i);
            if (typeof rowIndex === 'number' && rowIndex > 0) {
                sampleFailures.push({
                    tsId: TEMPLATE_EXAMPLE_TS_ID,
                    reason: '为样例数据，不允许推送。请修改"案例唯一标识，不可修改"等占位字段为真实数据后再试',
                    rowIndex,
                });
            }
        }
    }
    // 复用现有过滤实现（保持行为一致），同时按同一规则手动构建 filteredIndex → originalIndex 映射。
    // 注意：filterTemplateExampleRows 内部对未通过插件创建的文件是否过滤有独立判断，
    // 我们这里只在"确实被过滤掉"时才建立映射差异，因此以最终 filtered 长度对齐来构建映射，
    // 通过 tsId 是否命中 isSampleTsId + 与 filtered 顺序对齐 双重校验。
    const filtered = filterTemplateExampleRows(filePath, src);
    const filteredToOriginal: number[] = [];
    let cursor = 0;
    for (let i = 0; i < src.length && cursor < filtered.length; i++) {
        if (src[i] === filtered[cursor]) {
            filteredToOriginal.push(i);
            cursor++;
        }
    }
    // 兜底：若同一对象引用比对没能覆盖 filtered 全部（例如 filterTemplateExampleRows 做了浅拷贝），
    // 退化为 identity 映射，等价于关闭错位修复；至少不会造成越界。
    if (filteredToOriginal.length !== filtered.length) {
        filteredToOriginal.length = 0;
        for (let i = 0; i < filtered.length; i++) filteredToOriginal.push(i);
    }
    return {
        filtered,
        sampleFailures,
        skipped: src.length - filtered.length,
        filteredToOriginal,
    };
}

// ============================================
// 阶段 3：任务信息
// ============================================

/** 任务信息拉取结果：区分"未绑定" / "异常" / "成功" 三种状态。 */
export type ResolveTaskInfoResult =
    | { status: 'ok'; taskInfo: { testTaskNo: string; subTestTaskId: string } }
    | { status: 'unbound' }
    | { status: 'error'; errorMessage: string; error: unknown };

/**
 * 拉取当前文件绑定的 taskInfo。
 * - 未绑定 → { status: 'unbound' }
 * - 抛异常（网络抖动 / 后端 5xx）→ { status: 'error' }
 * - 正常   → { status: 'ok', taskInfo }
 */
export async function resolveTaskInfoOrNull(filePath: string): Promise<ResolveTaskInfoResult> {
    try {
        const currentTask = await getCurrentTaskInfo(filePath);
        if (!currentTask.bind) return { status: 'unbound' };
        return {
            status: 'ok',
            taskInfo: {
                testTaskNo: currentTask.taskInfo.testTaskNo || '',
                subTestTaskId: currentTask.taskInfo.subTestTaskId || '',
            },
        };
    } catch (err: any) {
        return {
            status: 'error',
            errorMessage: String(err?.message || err || '未知错误'),
            error: err,
        };
    }
}

// ============================================
// 阶段 4：失败行号汇总（三级降级）
// ============================================

/**
 * 从"整表原始 rows（未过滤样例）"构造前端级别的行号映射（供右键推送使用）。
 *
 * 目的：让右键推送与编辑器推送在 buildFailureItems 三级降级中走同一条路径 ——
 *   编辑器推送：前端下发 rowIndexMap / pushIndexToRow（走第 1、2 级）
 *   右键推送 ：无前端参与 → 由本函数在扩展端按同样规则构造，避免走第 3 级降级
 *              （tsIdToIndex 基于「样例过滤后 filtered」，会导致有样例行时行号 -1 错位）。
 *
 * 语义与前端 04-push-find.js 中 rowIndexMap/pushIndexToRow 的构造完全对齐：
 *   - rowIndexMap[tsId]        = 原始 rows 下标 + 1（即 UI 上"#"列显示的行号）
 *   - pushIndexToRow[origIdx]  = 原始 rows 下标 + 1
 *
 * @param rows 整表原始行数据（parseFileToRows 返回值）；以每条记录的 TS_ID_COLUMN 字段作为 tsId。
 */
export function buildRowIndexMappings(
    rows: RowLike[],
): { rowIndexMap: Record<string, number>; pushIndexToRow: number[] } {
    const rowIndexMap: Record<string, number> = {};
    const pushIndexToRow: number[] = [];
    if (!Array.isArray(rows)) return { rowIndexMap, pushIndexToRow };
    rows.forEach((rec, i) => {
        const raw = rec ? rec[TS_ID_COLUMN] : undefined;
        const tsId = raw == null ? '' : String(raw).trim();
        // 空 tsId 不建键（与前端一致：pushIndexToRow 兜底才起作用）
        if (tsId !== '') rowIndexMap[tsId] = i + 1;
        pushIndexToRow.push(i + 1);
    });
    return { rowIndexMap, pushIndexToRow };
}

/**
 * 根据 pushData 建立 tsId → 0-based 下标 的映射，
 * 供失败行号第 3 级（扩展端自算）降级使用。
 */
export function buildTsIdToIndex(pushData: RowLike[]): Map<string, number> {
    const map = new Map<string, number>();
    if (!Array.isArray(pushData)) return map;
    pushData.forEach((rec, i) => {
        const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
        if (id) map.set(id, i);
    });
    return map;
}

/**
 * 失败行号定位（三级降级）：
 *   1) frontRowIndexMap[tsId]        —— 前端 tsId → 主表 1-based 行号（最准）
 *   2) frontPushIndexToRow[originalIndex] —— 前端 payload 下标 → 主表行号（兜底 tsId 为空的场景）
 *      注意：后端返回的 bodyIndex 是"过滤后 rows"的下标；
 *            frontPushIndexToRow 是"过滤前 payload"的下标。
 *            若过滤过样例行，两者会错位。通过 filteredToOriginal[bodyIndex] 转换回原始下标后再查询。
 *   3) tsIdToRowIndex[tsId]          —— 扩展端自算（0-based → +1）
 * 三级都拿不到 → rowIndex=undefined，前端显示"(无)"不可跳转。
 *
 * @param filteredToOriginal  过滤后下标 → 原始下标 的映射；不传/空数组时视为 identity（不做转换）。
 */
export function buildFailureItems(
    failures: PushResponseFailure[],
    tsIdToRowIndex: Map<string, number>,
    frontRowIndexMap?: Record<string, number>,
    frontPushIndexToRow?: number[],
    filteredToOriginal?: number[],
): PushFailureItem[] {
    const map1 = frontRowIndexMap || {};
    const arr2: number[] = Array.isArray(frontPushIndexToRow) ? frontPushIndexToRow : [];
    const idxMap: number[] = Array.isArray(filteredToOriginal) ? filteredToOriginal : [];
    return failures.map(f => {
        let rowIndex: number | undefined;
        const front = map1[f.tsId];
        if (typeof front === 'number' && front > 0) {
            rowIndex = front;
        } else if (
            typeof f.bodyIndex === 'number' &&
            f.bodyIndex >= 0 &&
            arr2.length > 0
        ) {
            // bodyIndex（过滤后下标）→ originalIndex（过滤前下标） → mainTableRowIndex
            const originalIndex = idxMap.length > f.bodyIndex ? idxMap[f.bodyIndex] : f.bodyIndex;
            if (
                typeof originalIndex === 'number' &&
                originalIndex >= 0 &&
                originalIndex < arr2.length &&
                typeof arr2[originalIndex] === 'number' &&
                arr2[originalIndex] > 0
            ) {
                rowIndex = arr2[originalIndex];
            }
        }
        if (rowIndex === undefined && f.tsId && tsIdToRowIndex.has(f.tsId)) {
            rowIndex = tsIdToRowIndex.get(f.tsId)! + 1;
        }
        return { tsId: f.tsId, reason: f.reason, rowIndex };
    });
}

// ============================================
// 阶段 5：成功回写 testCaseNo & 快照
// ============================================

/**
 * 成功回写选项。两个入口的差异：
 *  - 右键推送：不复用外部 parser，从头 detectFileType + createParser；无 markSelfSave / afterWriteBack 需求
 *  - 编辑器推送：复用调用方注入的 parser（session.parser）；markSelfSave 前后包一层，
 *    afterWriteBack 处理清空高亮/刷新 webview
 *
 * 快照更新策略：两条路径统一全量刷新（见 writeBackTestCaseNos 内注释），
 * 不再区分「增量 vs 全量」，也不再需要向 savePushSnapshot 传 pushedTsIds。
 */
export interface WriteBackOptions {
    filePath: string;
    successMappings: PushSuccessMapping[];
    /** 若为 undefined，函数内部会 detectFileType + createParser 自建（用于右键推送） */
    parser?: FileParser;
    hooks?: Pick<PushCoreHooks, 'markSelfSave' | 'afterWriteBack' | 'onWriteBackFailed'>;
    hasFailure: boolean;
    /** 用于埋点错误上下文的额外字段（如 ext） */
    telemetryContext: Record<string, string>;
    telemetryPrefix: string;
}

/**
 * 成功回写 testCaseNo 到原文件；写盘后更新 pushSnapshot 基线。
 * - 若失败，抛出的错误已内部埋点/日志，不再向上抛（保持原有行为）。
 */
export async function writeBackTestCaseNos(opts: WriteBackOptions): Promise<void> {
    if (!opts.successMappings || opts.successMappings.length === 0) return;
    try {
        // 右键场景：外部未提供 parser，需自建
        let parser: FileParser | undefined = opts.parser;
        if (!parser) {
            const fileType = detectFileType(opts.filePath);
            if (!fileType) return;
            parser = createParser(fileType);
        }

        const parsed = await parser.parse(opts.filePath);
        ensureTrackingColumns(parsed.tableData, parsed.sourceData);
        applyTestCaseNos(parsed.tableData, parsed.sourceData, opts.successMappings);

        // 编辑器场景：写盘前后打时间戳，防止 self-save 触发的 fsWatcher 在 pushSuccess 刷新期间覆盖高亮状态
        opts.hooks?.markSelfSave?.();

        // 快照基线更新策略：
        //   右键推送 / 编辑器推送 均采用「全量更新快照基线」——语义上一次推送操作代表用户已认可
        //   当前磁盘状态为新基线，未推送但已编辑的行不应残留旧快照导致下次打开被误判为「修改」高亮。
        //   失败行的红色高亮由 pushFailures 机制独立管理，不依赖快照差异。
        //   （历史 bug：右键推送曾使用增量更新，只覆盖成功行 tsId 的快照，导致失败行编辑后
        //     快照仍是旧值，弹窗关闭后残留黄色修改高亮 —— 详见 019f2bea 会话诊断日志。）
        await savePushSnapshot(opts.filePath, parsed.tableData);

        await parser.save(opts.filePath, parsed.tableData, parsed.sourceData);
        opts.hooks?.markSelfSave?.();

        // 编辑器场景：清空高亮 / 决定是否刷新 webview
        if (opts.hooks?.afterWriteBack) {
            await opts.hooks.afterWriteBack({
                parsedTableData: parsed.tableData,
                parsedSourceData: parsed.sourceData,
                hasFailure: opts.hasFailure,
            });
        }
    } catch (err: any) {
        console.error(`[推送] 回写 testCaseNo 失败: ${err?.message || err}`);
        sendTelemetryErrorEvent(`${opts.telemetryPrefix}.writeBackFailed`, {
            ...opts.telemetryContext,
            ...telemetryErrProps(err),
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
        // 显式通知调用方：本次推送后端已成功，但案例编号未能写回本地文件；
        // 若不提示，用户下次可能再次推送同一批行导致重复创建案例。
        try {
            opts.hooks?.onWriteBackFailed?.(String(err?.message || err || '案例编号回写失败'));
        } catch (_) { /* hook 抛错不影响主流程 */ }
    }
}

// ============================================
// 阶段 6：主流程编排
// ============================================

export interface RunPushOptions {
    /** 扩展上下文（pushTestCase 需要） */
    extensionContext: vscode.ExtensionContext;
    /** 目标文件路径 */
    filePath: string;
    /** 待推送的行数据（右键=整表；编辑器=选中子集且已用文件源覆盖显示文本） */
    rows: RowLike[];
    /**
     * 下标 → 主表 1-based 行号 解析函数。校验/过滤阶段共用。
     * - 右键推送：`i => i + 1`
     * - 编辑器推送：`i => pushIndexToRow[i] ?? (i + 1)`
     */
    resolveRowIndex: (i: number) => number;
    /** 前端下发的 tsId → 主表行号映射（编辑器场景使用；右键场景可不传） */
    frontRowIndexMap?: Record<string, number>;
    /** 前端下发的 payload 下标 → 主表行号映射（编辑器场景使用；右键场景可不传） */
    frontPushIndexToRow?: number[];
    /** 是否复用外部 parser（编辑器场景）；不传则内部按 fileType 自建（右键场景） */
    parser?: FileParser;
    /** 埋点前缀：'explorerPush' | 'editorPush' */
    telemetryPrefix: string;
    /**
     * 单次推送行数上限。超过时短路，不发出后端请求。默认 5000。
     * 主要用于防御用户误操作（例如全选一个 10w 行的文件）导致后端超时/雪崩。
     */
    maxRows?: number;
    /** UI 反馈钩子 */
    hooks: PushCoreHooks;
}

/**
 * 主推送流程。执行顺序（含短路）：
 *   0. taskInfo 未绑定 → onUnbound + return
 *   1. 空数据 → onNoData + return（右键场景才有 onNoData 钩子）
 *   2. TESTCASE_ID 占位命中 → onPlaceholderTestcaseId + persistPushFailures + return
 *   3. 样例过滤后无剩余 → onOnlySampleRows + return
 *   4. pushTestCase → returnCode 失败 → onBackendError + return
 *   5. parsePushResponse → 泄露埋点
 *   6. 成功回写 testCaseNo（含快照更新）
 *   7. 全部失败兜底快照（onAllFailedSnapshot）
 *   8. 汇总 failureItems（三级降级） → onComplete + persistPushFailures
 */
export async function runPush(opts: RunPushOptions): Promise<void> {
    const {
        extensionContext,
        filePath,
        rows: originalRows,
        resolveRowIndex,
        frontRowIndexMap,
        frontPushIndexToRow,
        parser,
        telemetryPrefix,
        hooks,
    } = opts;

    const baseName = path.basename(filePath);
    const fileExt = path.extname(filePath).toLowerCase();
    const pushStart = Date.now();
    // P2-1：贯穿本次流程的 traceId，全部埋点都会带上，方便定位同一次推送
    const traceId = newPushTraceId();
    // P2-3：fileMeta 提前算一次，避免下游多处重复 IO
    const createdByCommand = isCreatedByCommand(filePath);
    const pushSource = createdByCommand ? 'testAgentMA' : 'testAgent';
    // P3-1：行数上限（防御用户全选大文件）
    const maxRows = typeof opts.maxRows === 'number' && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_PUSH_ROWS;

    try {

    // ---- 0. 任务绑定校验 ----
    const taskInfoResult = await resolveTaskInfoOrNull(filePath);
    if (taskInfoResult.status === 'unbound') {
        sendTelemetryEvent(`${telemetryPrefix}.aborted`, { reason: 'unbound', ext: fileExt, traceId });
        hooks.onUnbound();
        return;
    }
    if (taskInfoResult.status === 'error') {
        console.error(`[推送][${traceId}] 获取任务信息异常:`, taskInfoResult.errorMessage);
        sendTelemetryErrorEvent(`${telemetryPrefix}.taskInfoFailed`, {
            ext: fileExt,
            traceId,
            ...telemetryErrProps(taskInfoResult.error),
            errorMessage: taskInfoResult.errorMessage.slice(0, 500),
            stackHead: stackHead(taskInfoResult.error),
        });
        const uiMsg = `未能获取任务信息，推送已中断：${taskInfoResult.errorMessage}`;
        // 优先使用专用钩子；未实现时降级走 onBackendError 以保证前端能解锁按钮。
        if (hooks.onTaskInfoFailed) hooks.onTaskInfoFailed(uiMsg);
        else hooks.onBackendError(uiMsg);
        return;
    }
    const taskInfo = taskInfoResult.taskInfo;

    // ---- 1. 空数据 ----
    let rows: RowLike[] = Array.isArray(originalRows) ? originalRows : [];
    if (rows.length === 0) {
        sendTelemetryEvent(`${telemetryPrefix}.aborted`, { reason: 'noData', ext: fileExt, traceId });
        hooks.onNoData?.();
        return;
    }

    // ---- 1.1 行数上限保护（P3-1） ----
    if (rows.length > maxRows) {
        sendTelemetryEvent(`${telemetryPrefix}.aborted`, {
            reason: 'exceedMaxRows',
            ext: fileExt,
            traceId,
            totalRows: String(rows.length),
            limit: String(maxRows),
        });
        const uiMsg = `本次待推送 ${rows.length} 行，超过单次上限 ${maxRows} 行。请分批选择后再推送，避免请求超时。`;
        if (hooks.onExceedMaxRows) hooks.onExceedMaxRows({ rows: rows.length, limit: maxRows, message: uiMsg });
        else hooks.onBackendError(uiMsg);
        return;
    }

    // ---- 2. 前置校验：TESTCASE_ID 占位 & 空 tsId ----
    // 与旧逻辑（命中即整批中断）不同：现在把占位/空 tsId 行标记为"预校验失败"并从推送
    // payload 中剔除，剩余合规行继续走后端；若全部行都命中，则跳过后端调用直接由
    // onComplete 汇总输出。这样"部分合规 + 部分占位"的选中集能拿到完整结果。
    // 注意：必须在 filterTemplateExampleRows 之前执行，行号才与主表原始行号一致。
    const placeholderFailures = collectPlaceholderTestcaseIdFailures(rows, resolveRowIndex);
    const emptyFailures = collectEmptyTestcaseIdFailures(rows, resolveRowIndex);
    // 预校验失败合集：进入最终 onComplete 与失败弹窗；顺序 = 占位在前、空在后（人肉排查更直观）
    const preValidationFailures: PushFailureItem[] = [...placeholderFailures, ...emptyFailures];
    // 剔除标记：命中占位或空 tsId 的下标不再进入后端 payload
    const droppedIndexSet = new Set<number>();
    if (preValidationFailures.length > 0) {
        rows.forEach((rec, i) => {
            const raw = rec ? rec[TS_ID_COLUMN] : undefined;
            const tsId = raw == null ? '' : String(raw).trim();
            if (tsId === '' || tsId.toUpperCase() === 'TESTCASE_ID') {
                droppedIndexSet.add(i);
            }
        });
        // 埋点：不阻断，只记录预校验剔除数量（区别于旧的 aborted）
        if (placeholderFailures.length > 0) {
            sendTelemetryEvent(`${telemetryPrefix}.placeholderTestcaseIdSkipped`, {
                ext: fileExt,
                traceId,
                count: String(placeholderFailures.length),
            });
        }
        if (emptyFailures.length > 0) {
            sendTelemetryEvent(`${telemetryPrefix}.emptyTestcaseIdSkipped`, {
                ext: fileExt,
                traceId,
                count: String(emptyFailures.length),
            });
        }
        // 持久化占位失败标记：以真实占位 tsId 为 key 写盘，保证关闭弹窗/重开文件后
        // 占位行仍保持红色高亮。空 tsId 行由于没有可用的 tsId 无法参与红色高亮。
        // 只把"占位失败行"作为本次持久化 batch 传入，避免 batchTsIds 混入合规行 tsId
        // 导致合规行的历史失败标记被误清（真正的推送结果持久化在 step 8 完成）。
        if (placeholderFailures.length > 0) {
            try {
                const placeholderRows = placeholderFailures.map(f => ({ [TS_ID_COLUMN]: f.tsId } as RowLike));
                await persistPushFailures(
                    filePath,
                    placeholderRows,
                    placeholderFailures.map(f => ({ tsId: f.tsId, reason: f.reason })),
                    [],
                );
            } catch (err: any) {
                console.error(`[推送][${traceId}] 持久化占位失败标记失败:`, err?.message || err);
            }
        }
    }
    // 剔除占位/空 tsId 行，同时构建 preFilterToOriginal：新数组下标 → 原 rows 下标
    // 后续如果还需要与前端 pushIndexToRow 对齐，需要把该映射与 filteredToOriginal 串联起来。
    let preFilterToOriginal: number[];
    if (droppedIndexSet.size > 0) {
        const kept: RowLike[] = [];
        preFilterToOriginal = [];
        for (let i = 0; i < rows.length; i++) {
            if (!droppedIndexSet.has(i)) {
                kept.push(rows[i]);
                preFilterToOriginal.push(i);
            }
        }
        rows = kept;
    } else {
        preFilterToOriginal = rows.map((_, i) => i);
    }

    // 若剔除后已无可推送行 —— 直接由 onComplete 汇总输出，不再调后端
    if (rows.length === 0) {
        sendTelemetryEvent(`${telemetryPrefix}.aborted`, {
            reason: placeholderFailures.length > 0 && emptyFailures.length > 0
                ? 'placeholderAndEmptyTestcaseId'
                : (placeholderFailures.length > 0 ? 'placeholderTestcaseIdOnly' : 'emptyTestcaseIdOnly'),
            ext: fileExt,
            traceId,
            count: String(preValidationFailures.length),
        });
        hooks.onComplete({
            successCount: 0,
            failures: preValidationFailures,
            total: preValidationFailures.length,
        });
        try { hooks.onProgress?.('done', { rows: 0 }); } catch (_) { /* 忽略 */ }
        return;
    }

    // ---- 3. 静默过滤中文样例占位行 ----
    const { filtered, sampleFailures, skipped, filteredToOriginal } = extractSampleRows(filePath, rows, resolveRowIndex);
    if (filtered.length === 0) {
        // 边界：过滤后无剩余行。
        //   - 若同时存在预校验失败（占位/空 tsId），说明用户选的行是"样例 + 占位/空"混合，
        //     不能只提示"为样例数据"，需把预校验失败一起在 onComplete 弹窗中展示；
        //   - 否则（纯样例）维持原语义，走 onOnlySampleRows。
        if (preValidationFailures.length > 0) {
            sendTelemetryEvent(`${telemetryPrefix}.aborted`, {
                reason: 'onlyTemplateExampleAndPreValidationFailed',
                ext: fileExt,
                traceId,
                sampleCount: String(sampleFailures.length),
                preValidationCount: String(preValidationFailures.length),
            });
            hooks.onComplete({
                successCount: 0,
                failures: [...preValidationFailures, ...sampleFailures],
                total: preValidationFailures.length + sampleFailures.length,
            });
            try { hooks.onProgress?.('done', { rows: 0 }); } catch (_) { /* 忽略 */ }
            return;
        }
        sendTelemetryEvent(`${telemetryPrefix}.aborted`, {
            reason: 'onlyTemplateExample',
            ext: fileExt,
            traceId,
            count: String(sampleFailures.length),
        });
        hooks.onOnlySampleRows(sampleFailures);
        return;
    }
    if (skipped > 0) {
        console.log(`[推送][${traceId}] 已过滤 ${skipped} 行模板示例数据`);
        sendTelemetryEvent(`${telemetryPrefix}.skipTemplateExample`, {
            ext: fileExt,
            traceId,
            skipped: String(skipped),
        });
    }
    rows = filtered;

    // ---- 4. 调用后端推送接口 ----
    console.log(`[推送][${traceId}] 文件: ${filePath}, ${rows.length} 行`);
    sendTelemetryEvent(`${telemetryPrefix}.start`, { ext: fileExt, traceId, totalRows: String(rows.length) });
    // P3-2：进度反馈 —— 让调用方可选提示用户
    try { hooks.onProgress?.('start', { rows: rows.length }); } catch (_) { /* 忽略 */ }
    try { hooks.onProgress?.('pushing', { rows: rows.length }); } catch (_) { /* 忽略 */ }
    const pushResult = await pushTestCase(
        extensionContext,
        normalizePushData(rows),
        taskInfo,
        baseName,
        pushSource,
    );
    if (pushResult.returnCode !== 'SUC0000') {
        hooks.onBackendError(pushResult.errorMsg || '推送失败');
        sendTelemetryErrorEvent(`${telemetryPrefix}.failed`, {
            ext: fileExt,
            traceId,
            returnCode: pushResult.returnCode || '',
            totalRows: String(rows.length),
            costMs: String(Date.now() - pushStart),
        });
        return;
    }

    // ---- 5. 解析响应 & 泄露埋点/清理 ----
    let { successMappings, failures } = parsePushResponse(pushResult.body, rows);

    // 防御埋点：样例行按设计不应进入后端推送结果。一旦在 successMappings/failures 中出现样例 tsId，
    // 说明过滤逻辑被绕过（文件标识丢失 / 上下文变量异常等），需以该事件快速定位问题。
    const leakedSuccess = successMappings.filter(m => m && isSampleTsId(m.tsId)).length;
    const leakedFailure = failures.filter(f => f && isSampleTsId(f.tsId)).length;
    if (leakedSuccess > 0 || leakedFailure > 0) {
        sendTelemetryErrorEvent(`${telemetryPrefix}.templateExampleLeaked`, {
            ext: fileExt,
            traceId,
            leakedSuccess: String(leakedSuccess),
            leakedFailure: String(leakedFailure),
        });
        // P2-2：泄露自动清理 —— 避免样例 tsId 被写入 pushSnapshot / pushFailureStore 后污染高亮状态。
        //        埋点已记录，后续处理只使用清理后的干净数据。
        successMappings = successMappings.filter(m => !(m && isSampleTsId(m.tsId)));
        failures = failures.filter(f => !(f && isSampleTsId(f.tsId)));
    }

    // ---- 6. 成功回写 testCaseNo & 快照 ----
    if (successMappings.length > 0) {
        try { hooks.onProgress?.('writingBack', { rows: successMappings.length }); } catch (_) { /* 忽略 */ }
        await writeBackTestCaseNos({
            filePath,
            successMappings,
            parser,
            hooks: {
                markSelfSave: hooks.markSelfSave,
                afterWriteBack: hooks.afterWriteBack,
                onWriteBackFailed: hooks.onWriteBackFailed,
            },
            hasFailure: failures.length > 0,
            // traceId 会自动带入 writeBackFailed 埋点
            telemetryContext: { ext: fileExt, traceId },
            telemetryPrefix,
        });
    } else if (failures.length > 0) {
        // 全部推送失败：与"成功回写"路径保持一致的快照策略 —— 全量刷新快照基线，
        // 避免用户在推送前编辑过的行残留旧快照，下次 diff 误判为"修改"黄色高亮。
        // 失败行的红色高亮由 pushFailures 独立管理。
        //   - 编辑器场景：parser 已注入 → 复用；同时触发 onAllFailedSnapshot 让 UI 层清高亮。
        //   - 右键推送场景：外部无 parser → 内部按 fileType 自建（与 writeBackTestCaseNos 逻辑对齐）。
        try {
            let allFailParser: FileParser | undefined = parser;
            if (!allFailParser) {
                const fileType = detectFileType(filePath);
                if (fileType) allFailParser = createParser(fileType);
            }
            if (allFailParser) {
                const parsed = await allFailParser.parse(filePath);
                await savePushSnapshot(filePath, parsed.tableData);
                if (hooks.onAllFailedSnapshot) {
                    await hooks.onAllFailedSnapshot({
                        parsedTableData: parsed.tableData,
                        parsedSourceData: parsed.sourceData,
                    });
                }
            }
        } catch (err: any) {
            console.error(`[推送][${traceId}] 全部失败，快照更新失败:`, err?.message || err);
            sendTelemetryErrorEvent(`${telemetryPrefix}.allFailSnapshotFailed`, {
                ext: fileExt,
                traceId,
                errorMessage: String(err?.message || String(err)).slice(0, 500),
                stackHead: stackHead(err),
            });
        }
    }

    // ---- 7. 汇总失败行号（三级降级）----
    const tsIdToIndex = buildTsIdToIndex(rows);
    // filteredToOriginal 的语义此处需要与"预剔除（占位/空）"级联：
    //   extractSampleRows 返回的 filteredToOriginal 是"过滤后 rows 下标 → 预剔除后 rows 下标"，
    //   我们再串上 preFilterToOriginal（"预剔除后下标 → 原始 rows 下标"），
    //   得到"过滤后 rows 下标 → 原始 rows 下标"，供 buildFailureItems 与 frontPushIndexToRow 对齐。
    const composedFilteredToOriginal: number[] = filteredToOriginal.map(idx => {
        return typeof preFilterToOriginal[idx] === 'number' ? preFilterToOriginal[idx] : idx;
    });
    const failureItems = buildFailureItems(failures, tsIdToIndex, frontRowIndexMap, frontPushIndexToRow, composedFilteredToOriginal);
    // 合并预校验失败（占位 / 空 tsId）与后端返回失败：预校验失败排在前面，便于用户按行号定位
    const mergedFailures: PushFailureItem[] = [...preValidationFailures, ...failureItems];
    // total 覆盖"用户最初选中的所有案例"：预校验失败行数 + 实际推送到后端的行数
    const total = preValidationFailures.length + rows.length;

    // ---- 8. 输出结果 & 持久化失败标记 ----
    hooks.onComplete({ successCount: successMappings.length, failures: mergedFailures, total });

    try {
        await persistPushFailures(filePath, rows, failures, successMappings);
    } catch (err: any) {
        console.error(`[推送][${traceId}] 持久化失败标记失败:`, err?.message || err);
    }

    sendTelemetryEvent(`${telemetryPrefix}.complete`, {
        ext: fileExt,
        traceId,
        pushResult: mergedFailures.length === 0 ? 'allSuccess' : (successMappings.length === 0 ? 'allFail' : 'partial'),
        totalRows: String(total),
        successRows: String(successMappings.length),
        failedRows: String(mergedFailures.length),
        // 附带预校验剔除数量，方便对账
        preValidationFailedRows: String(preValidationFailures.length),
        costMs: String(Date.now() - pushStart),
    });
    try { hooks.onProgress?.('done', { rows: total }); } catch (_) { /* 忽略 */ }

    } catch (err: any) {
        // 顶层兜底：任何未处理的异常都不能冒泡到调用方，
        // 否则前端推送按钮会永久 loading，用户看不到任何提示。
        const errorMessage = String(err?.message || err || '未知错误');
        console.error(`[推送][${traceId}] runPush 未预期异常:`, errorMessage, err);
        sendTelemetryErrorEvent(`${telemetryPrefix}.unexpectedError`, {
            ext: fileExt,
            traceId,
            ...telemetryErrProps(err),
            errorMessage: errorMessage.slice(0, 500),
            stackHead: stackHead(err),
            costMs: String(Date.now() - pushStart),
        });
        try {
            const uiMsg = `推送异常：${errorMessage}`;
            if (hooks.onUnexpectedError) hooks.onUnexpectedError(uiMsg);
            else hooks.onBackendError(uiMsg);
        } catch (hookErr: any) {
            // 钩子也抛错：仅埋点，不再往外抛。
            console.error(`[推送][${traceId}] onUnexpectedError 钩子抛错:`, hookErr?.message || hookErr);
        }
        try { hooks.onProgress?.('done', { rows: Array.isArray(originalRows) ? originalRows.length : 0 }); } catch (_) { /* 忽略 */ }
    }
}
