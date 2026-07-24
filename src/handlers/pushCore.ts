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
 *    3. 构造 taskInfo；按来源拆两批调用后端推送接口
 *       （testcase_id 为 TC+uuid.hex → testAgent，其余 → testAgentMA），结果合并。
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
import { isMapError, ROW_INDEX_META, mapRowToCaseItem } from '../utils/pushDataMapper';
import { parsePushResponse, PushSuccessMapping, PushResponseFailure } from '../utils/pushResponse';
import {
    classifyFailure,
    aggregateFailures,
    aggregateByField,
    summarizeCategoryBreakdown,
    summarizeFieldBreakdown,
    failureFieldOf,
    type PushFailCategory,
    type PushInterfaceField,
} from '../utils/pushFailureCategory';
import { pushDiag, showPushDiag } from '../utils/pushDiagnostics';
import { getCurrentTaskInfo } from '../utils/commands';
import {
    filterTemplateExampleRows,
    TEMPLATE_EXAMPLE_TS_ID,
    isSampleTsId,
} from '../utils/fileIdentifier';
import { persistPushFailures } from '../utils/pushFailureStore';
import { savePushSnapshot } from '../utils/pushSnapshotStore';
import { normalizePushData } from '../utils/headerLabels';
import { TS_ID_COLUMN, stackHead } from '../services/utils';
import { TelemetryService } from '../utils/telemetry';
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
    /** 失败分类码（统计/埋点维度；展示仍用 reason 原文） */
    category?: PushFailCategory;
    /** 命中的接口字段码（聚焦维度；字段类错误才有值，其余为 undefined） */
    field?: PushInterfaceField;
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
// 内部工具：小而美的通用辅助
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

/** 从行对象读取标准化后的 tsId（trim + 空值兜底为 ''）。 */
function readTsId(rec: RowLike | undefined | null): string {
    if (!rec) return '';
    const raw = rec[TS_ID_COLUMN];
    return raw == null ? '' : String(raw).trim();
}

/** 推送来源平台类型（与接口 sourcePlatform 取值对应）。 */
type PushSource = 'testAgent' | 'testAgentMA';

/** 来源判定：testcase_id 满足 TC + 32 位 uuid.hex → 'testAgent'，其余（含 MA / 标准 UUID）→ 'testAgentMA'。 */
const TC_SOURCE_PATTERN = /^TC[0-9a-f]{32}$/i;

function resolveRowSource(tsId: string): PushSource {
    return TC_SOURCE_PATTERN.test(tsId) ? 'testAgent' : 'testAgentMA';
}

/**
 * 按来源拆批：TC+uuid.hex 行归 testAgent，其余归 testAgentMA。
 * 保留各自内部相对顺序，便于后续按全局行号合并结果。
 */
function splitRowsByPushSource(rows: RowLike[]): Array<{ source: PushSource; rows: RowLike[] }> {
    const tc: RowLike[] = [];
    const ma: RowLike[] = [];
    for (const r of rows) {
        if (resolveRowSource(readTsId(r)) === 'testAgent') tc.push(r);
        else ma.push(r);
    }
    const batches: Array<{ source: PushSource; rows: RowLike[] }> = [];
    if (tc.length > 0) batches.push({ source: 'testAgent', rows: tc });
    if (ma.length > 0) batches.push({ source: 'testAgentMA', rows: ma });
    return batches;
}

/** 安全调用 hook：吞掉钩子异常，避免污染主流程；仅用于"通知型"钩子。 */
function safeInvoke<T extends (...args: any[]) => any>(fn: T | undefined, ...args: Parameters<T>): void {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (_) { /* 忽略钩子异常 */ }
}

/** 进度反馈统一入口，收敛 11 处 try/catch 样板。 */
function emitProgress(
    hooks: Pick<PushCoreHooks, 'onProgress'>,
    stage: 'start' | 'pushing' | 'writingBack' | 'done',
    payload?: { rows?: number },
): void {
    safeInvoke(hooks.onProgress, stage, payload);
}

// ============================================
// 阶段 1：可扩展的行级预校验（RowValidator 数组）
// ============================================

/**
 * 单条行级预校验规则。返回失败明细或 null（通过）。
 * 之所以采用"数组 + 驱动"结构：新加校验只需 push 一个对象，无需改动 runPush 本体。
 */
interface RowValidator {
    /** 校验类型标识；用于埋点事件名与 aborted reason 归类 */
    kind: 'placeholder' | 'empty' | (string & {});
    /** 判定是否命中该失败；命中返回失败明细（不含 rowIndex，由调度器统一补上） */
    check(row: RowLike, tsId: string): Omit<PushFailureItem, 'rowIndex'> | null;
}

/** 内置校验：占位 TESTCASE_ID（大写） */
const PLACEHOLDER_VALIDATOR: RowValidator = {
    kind: 'placeholder',
    check(_row, tsId) {
        if (tsId.toUpperCase() === 'TESTCASE_ID') {
            return {
                tsId,
                reason: 'testcase_id 为占位值 TESTCASE_ID，请修改为真实的案例 ID 后再推送',
            };
        }
        return null;
    },
};

/** 内置校验：testcase_id 为空 */
const EMPTY_VALIDATOR: RowValidator = {
    kind: 'empty',
    check(_row, tsId) {
        if (tsId === '') {
            // 稳定伪 tsId：便于持久化独立标记；用户可见字段只有 reason + rowIndex，不影响 UX
            return {
                tsId: '', // 占位；调度器会在补 rowIndex 时改成 `__EMPTY_TSID_ROW_${rowIndex}__`
                reason: 'testcase_id 不能为空，请填写案例 ID 后再推送',
            };
        }
        return null;
    },
};

/** 案例唯一标识（testcase_id）合法格式：标准 UUID，或 TC/MA 前缀 + 32 位 uuid.hex */
const TESTCASE_ID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(TC|MA)[0-9a-f]{32})$/i;

/** 内置校验：testcase_id 值必须符合案例唯一标识规范（UUID / TC+uuid.hex / MA+uuid.hex） */
const FORMAT_VALIDATOR: RowValidator = {
    kind: 'invalidFormat',
    check(_row, tsId) {
        if (!TESTCASE_ID_PATTERN.test(tsId)) {
            return {
                tsId,
                reason: 'testcase_id的值不符合案例唯一标识规范',
            };
        }
        return null;
    },
};

/** 内置校验器序列（按需扩展；语义即"按顺序对每行跑一遍所有校验"）。 */
const DEFAULT_VALIDATORS: RowValidator[] = [PLACEHOLDER_VALIDATOR, EMPTY_VALIDATOR, FORMAT_VALIDATOR];

/**
 * 通用校验驱动：按 validators 顺序对每行跑一遍，收集失败并按 kind 分桶。
 * 空 tsId 的失败项在此处补上 `__EMPTY_TSID_ROW_${rowIndex}__` 稳定伪 tsId。
 */
function runValidators(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
    validators: RowValidator[] = DEFAULT_VALIDATORS,
): { failuresByKind: Record<string, PushFailureItem[]>; droppedIndex: Set<number> } {
    const failuresByKind: Record<string, PushFailureItem[]> = {};
    const droppedIndex = new Set<number>();
    if (!Array.isArray(rows)) return { failuresByKind, droppedIndex };

    for (let i = 0; i < rows.length; i++) {
        const rec = rows[i];
        const tsId = readTsId(rec);
        // 中文样例占位行（'案例唯一标识，不可修改' / '案例唯一标识'）已由样例过滤识别，
        // 会在 step 3 静默剔除，无需再做预校验（占位/空/格式·唯一性），避免被误判为 fieldInvalid。
        if (isSampleTsId(tsId)) continue;
        for (const v of validators) {
            const hit = v.check(rec, tsId);
            if (hit) {
                const rowIndex = resolveRowIndex(i);
                const item: PushFailureItem = {
                    tsId: v.kind === 'empty' ? `__EMPTY_TSID_ROW_${rowIndex}__` : hit.tsId,
                    reason: hit.reason,
                    rowIndex,
                    category: classifyFailure({ reason: hit.reason, validatorKind: v.kind }),
                    field: failureFieldOf({ reason: hit.reason, validatorKind: v.kind }),
                };
                (failuresByKind[v.kind] ||= []).push(item);
                droppedIndex.add(i);
                break; // 同一行命中第一个校验即结束，避免重复 push
            }
        }
    }
    return { failuresByKind, droppedIndex };
}

// ============================================
// 阶段 1（对外兼容层）：TESTCASE_ID 占位 & 空 tsId
// ============================================

/**
 * 校验：testcase_id 为占位值 TESTCASE_ID 时不允许推送。
 *
 * 内部委托 `runValidators([PLACEHOLDER_VALIDATOR])`；对外签名保持不变。
 * 注意：调用方必须在 filterTemplateExampleRows 之前调用本函数，才能保证行号准确。
 */
export function collectPlaceholderTestcaseIdFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [PLACEHOLDER_VALIDATOR]).failuresByKind['placeholder'] || [];
}

/**
 * 校验：testcase_id 为空时不允许推送。
 *
 * 内部委托 `runValidators([EMPTY_VALIDATOR])`；对外签名保持不变。
 */
export function collectEmptyTestcaseIdFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [EMPTY_VALIDATOR]).failuresByKind['empty'] || [];
}

/**
 * 校验：testcase_id 值必须符合案例唯一标识规范（UUID / TC+uuid.hex / MA+uuid.hex）。
 *
 * 内部委托 `runValidators([FORMAT_VALIDATOR])`；对外签名保持不变。
 */
export function collectInvalidFormatFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [FORMAT_VALIDATOR]).failuresByKind['invalidFormat'] || [];
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
        const tsId = readTsId(src[i]);
        if (isSampleTsId(tsId)) {
            const rowIndex = resolveRowIndex(i);
            if (typeof rowIndex === 'number' && rowIndex > 0) {
                sampleFailures.push({
                    tsId: TEMPLATE_EXAMPLE_TS_ID,
                    reason: '为样例数据，不允许推送。请修改"案例唯一标识，不可修改"等占位字段为真实数据后再试',
                    rowIndex,
                    category: 'sample',
                });
            }
        }
    }
    // 复用现有过滤实现（保持行为一致），同时按同一规则手动构建 filteredIndex → originalIndex 映射。
    // 注意：filterTemplateExampleRows 内部对未通过插件创建的文件是否过滤有独立判断，
    // 我们必须以同一判定为准，否则映射就会与实际过滤结果错位。
    const filtered = filterTemplateExampleRows(filePath, src);
    // ⚠ 历史实现依赖 `src[i] === filtered[cursor]` 引用比对，一旦 filterTemplateExampleRows
    //   走浅拷贝/spread 分支，引用就会断开：
    //     - 场景 A（引用一致）：正常
    //     - 场景 B（引用完全不同）：命中兜底 identity 映射
    //     - 场景 C（部分对齐）：非样例行引用未变、样例行位置比对失败但 cursor 不推进 →
    //       后续非样例行错位命中 → 映射错乱，rowIndex 会漂移
    //   现改为「按 tsId 语义」构造映射：与 filterTemplateExampleRows 输入侧的过滤条件保持
    //   一致（是否为样例 tsId + filtered 是否真的少于 src）。
    const filteredToOriginal: number[] = [];
    if (filtered.length === src.length) {
        // filterTemplateExampleRows 未过滤任何行（未通过插件创建 / 无样例行）
        for (let i = 0; i < src.length; i++) filteredToOriginal.push(i);
    } else {
        // 按 tsId 是否为 sample 逐个决定是否保留下标；同时留 cursor 兜底避免映射长度不一致
        let cursor = 0;
        for (let i = 0; i < src.length && cursor < filtered.length; i++) {
            const tsId = readTsId(src[i]);
            if (!isSampleTsId(tsId)) {
                filteredToOriginal.push(i);
                cursor++;
            }
        }
    }
    // 兜底：极端情况下（例如 filterTemplateExampleRows 逻辑与 isSampleTsId 语义漂移），
    // 若映射长度仍与 filtered 不一致，退化为 identity 保证不越界。
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
// 阶段 4：失败行号汇总（可扩展责任链）
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
        const tsId = readTsId(rec);
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
 * 行号解析责任链上下文 —— 各 resolver 只读；由 buildFailureItems 一次组装。
 */
interface RowIndexResolveCtx {
    failure: PushResponseFailure;
    frontRowIndexMap: Record<string, number>;
    frontPushIndexToRow: number[];
    filteredToOriginal: number[];
    tsIdToRowIndex: Map<string, number>;
}

/** 单个行号解析器：命中返回 1-based 行号；未命中返回 undefined，交给下一级。 */
type RowIndexResolver = (ctx: RowIndexResolveCtx) => number | undefined;

/** L1：前端 tsId → 主表行号（最准） */
const resolveByFrontTsIdMap: RowIndexResolver = ({ failure, frontRowIndexMap }) => {
    const v = frontRowIndexMap[failure.tsId];
    return typeof v === 'number' && v > 0 ? v : undefined;
};

/** L2：后端 bodyIndex → filteredToOriginal → frontPushIndexToRow 主表行号（兜底 tsId 空/重复） */
const resolveByBodyIndex: RowIndexResolver = ({ failure, frontPushIndexToRow, filteredToOriginal }) => {
    if (typeof failure.bodyIndex !== 'number' || failure.bodyIndex < 0) return undefined;
    if (frontPushIndexToRow.length === 0) return undefined;
    // bodyIndex（过滤后下标）→ originalIndex（过滤前下标） → mainTableRowIndex
    const originalIndex =
        filteredToOriginal.length > failure.bodyIndex
            ? filteredToOriginal[failure.bodyIndex]
            : failure.bodyIndex;
    if (
        typeof originalIndex !== 'number' ||
        originalIndex < 0 ||
        originalIndex >= frontPushIndexToRow.length
    ) return undefined;
    const v = frontPushIndexToRow[originalIndex];
    return typeof v === 'number' && v > 0 ? v : undefined;
};

/** L3：扩展端 tsId → 0-based → +1（最后兜底） */
const resolveByExtensionTsIdIndex: RowIndexResolver = ({ failure, tsIdToRowIndex }) => {
    if (!failure.tsId || !tsIdToRowIndex.has(failure.tsId)) return undefined;
    return tsIdToRowIndex.get(failure.tsId)! + 1;
};

/**
 * 默认的行号解析责任链，顺序即优先级。
 * 未来若需要新增解析级（例如"后端直接返回 rowIndex"），push 一个新的 resolver 即可。
 */
const DEFAULT_ROW_INDEX_RESOLVERS: RowIndexResolver[] = [
    resolveByFrontTsIdMap,
    resolveByBodyIndex,
    resolveByExtensionTsIdIndex,
];

/**
 * 失败行号定位（三级降级）—— 责任链实现。
 * 对外行为与旧版严格一致：L1 → L2 → L3 → undefined。
 *
 * @param filteredToOriginal  过滤后下标 → 原始下标 的映射；不传/空数组时视为 identity。
 */
export function buildFailureItems(
    failures: PushResponseFailure[],
    tsIdToRowIndex: Map<string, number>,
    frontRowIndexMap?: Record<string, number>,
    frontPushIndexToRow?: number[],
    filteredToOriginal?: number[],
): PushFailureItem[] {
    const ctxBase = {
        frontRowIndexMap: frontRowIndexMap || {},
        frontPushIndexToRow: Array.isArray(frontPushIndexToRow) ? frontPushIndexToRow : [],
        filteredToOriginal: Array.isArray(filteredToOriginal) ? filteredToOriginal : [],
        tsIdToRowIndex,
    };
    return failures.map(failure => {
        let rowIndex: number | undefined;
        for (const resolver of DEFAULT_ROW_INDEX_RESOLVERS) {
            rowIndex = resolver({ failure, ...ctxBase });
            if (rowIndex !== undefined) break;
        }
        return { tsId: failure.tsId, reason: failure.reason, rowIndex, category: failure.category, field: failure.field };
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
        TelemetryService.sendTelemetryErrorEvent(`${opts.telemetryPrefix}.writeBackFailed`, {
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
// 阶段 6：主流程编排（拆分为若干私有 step）
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
 * runPush 内部状态。用类型收敛"跨 step 共享"的字段，避免 800 行大函数里满地飞的局部变量。
 */
interface PushContext {
    readonly opts: RunPushOptions;
    readonly baseName: string;
    readonly fileExt: string;
    readonly pushStart: number;
    readonly traceId: string;
    readonly maxRows: number;
    readonly telemetryPrefix: string;
    readonly hooks: PushCoreHooks;
}

/** 埋点事件的公共字段（ext + traceId），所有 step 共用。 */
function baseTelemetryProps(ctx: PushContext): Record<string, string> {
    return { ext: ctx.fileExt, traceId: ctx.traceId };
}

/** step 0：任务信息拉取 + 分派对应 hook。返回 taskInfo 或 null（表示已中断）。 */
async function stepResolveTaskInfo(ctx: PushContext): Promise<{ testTaskNo: string; subTestTaskId: string } | null> {
    const { filePath } = ctx.opts;
    const result = await resolveTaskInfoOrNull(filePath);
    if (result.status === 'unbound') {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.aborted`, { ...baseTelemetryProps(ctx), reason: 'unbound' });
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

/**
 * step 1：贴 __rowIndex（浅注入，不改变行引用）。
 *
 * 导出仅供测试用（ν 修复回归）：验证浅注入不改变行引用、幂等（已有 __rowIndex 不覆盖）、
 * 对非对象行安全跳过。生产代码请勿在本文件外调用。
 */
export function stampRowIndex(rows: RowLike[], resolveRowIndex: (i: number) => number): RowLike[] {
    return rows.map((r, i) => {
        if (r && typeof r === 'object' && (r as any)[ROW_INDEX_META] === undefined) {
            (r as any)[ROW_INDEX_META] = resolveRowIndex(i);
        }
        return r;
    });
}

/** step 1.5：行数上限保护。命中返回 true 表示已中断。 */
function stepCheckMaxRows(ctx: PushContext, rowCount: number): boolean {
    if (rowCount <= ctx.maxRows) return false;
    TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.aborted`, {
        ...baseTelemetryProps(ctx),
        reason: 'exceedMaxRows',
        totalRows: String(rowCount),
        limit: String(ctx.maxRows),
    });
    const uiMsg = `本次待推送 ${rowCount} 行，超过单次上限 ${ctx.maxRows} 行。请分批选择后再推送，避免请求超时。`;
    if (ctx.hooks.onExceedMaxRows) ctx.hooks.onExceedMaxRows({ rows: rowCount, limit: ctx.maxRows, message: uiMsg });
    else ctx.hooks.onBackendError(uiMsg);
    return true;
}

/** step 2 结果：预校验产出。 */
interface PreValidationResult {
    /** 预校验失败明细（占位 + 空 + 格式，按此顺序） */
    failures: PushFailureItem[];
    /** 需要从 payload 剔除的原始下标集合 */
    droppedIndex: Set<number>;
    /** 分桶明细（用于差异化埋点） */
    byKind: Record<string, PushFailureItem[]>;
}

/**
 * step 2：预校验 —— 通用 validators 驱动 + 差异化埋点 + 占位/格式失败持久化。
 */
export async function stepPreValidate(ctx: PushContext, rows: RowLike[]): Promise<PreValidationResult> {
    const { failuresByKind, droppedIndex } = runValidators(rows, ctx.opts.resolveRowIndex);
    const placeholderFailures = failuresByKind['placeholder'] || [];
    const emptyFailures = failuresByKind['empty'] || [];
    const formatFailures = failuresByKind['invalidFormat'] || [];
    const failures: PushFailureItem[] = [...placeholderFailures, ...emptyFailures, ...formatFailures];
    if (failures.length === 0) {
        return { failures, droppedIndex, byKind: failuresByKind };
    }
    // 差异化埋点（保持事件名不变）
    if (placeholderFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.placeholderTestcaseIdSkipped`, {
            ...baseTelemetryProps(ctx),
            count: String(placeholderFailures.length),
        });
    }
    if (emptyFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.emptyTestcaseIdSkipped`, {
            ...baseTelemetryProps(ctx),
            count: String(emptyFailures.length),
        });
    }
    if (formatFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.invalidFormatSkipped`, {
            ...baseTelemetryProps(ctx),
            count: String(formatFailures.length),
        });
    }
    // 对"占位失败"与"格式非法失败"做持久化红色高亮（二者都带稳定真实 tsId，可作 key）；
    // 空 tsId 无稳定 key（伪 tsId 无法匹配行），跳过。
    const highlightFailures = [...placeholderFailures, ...formatFailures];
    if (highlightFailures.length > 0) {
        try {
            const highlightRows = highlightFailures.map(f => ({ [TS_ID_COLUMN]: f.tsId } as RowLike));
            await persistPushFailures(
                ctx.opts.filePath,
                highlightRows,
                highlightFailures.map(f => ({ tsId: f.tsId, reason: f.reason, category: f.category, field: f.field })),
                [],
            );
        } catch (err: any) {
            console.error(`[推送][${ctx.traceId}] 持久化预校验失败标记失败:`, err?.message || err);
        }
    }
    return { failures, droppedIndex, byKind: failuresByKind };
}

/**
 * step 2 收尾：从 rows 中剔除预校验失败下标，产出新 rows + preFilterToOriginal 映射。
 */
function applyPreValidationDrops(rows: RowLike[], droppedIndex: Set<number>): { rows: RowLike[]; preFilterToOriginal: number[] } {
    if (droppedIndex.size === 0) {
        return { rows, preFilterToOriginal: rows.map((_, i) => i) };
    }
    const kept: RowLike[] = [];
    const preFilterToOriginal: number[] = [];
    for (let i = 0; i < rows.length; i++) {
        if (!droppedIndex.has(i)) {
            kept.push(rows[i]);
            preFilterToOriginal.push(i);
        }
    }
    return { rows: kept, preFilterToOriginal };
}

/**
 * 计算"全部行都被剔除"的 aborted reason（用于埋点归类）。
 */
function pickAllDroppedReason(byKind: Record<string, PushFailureItem[]>): string {
    const p = (byKind['placeholder'] || []).length;
    const e = (byKind['empty'] || []).length;
    const f = (byKind['invalidFormat'] || []).length;
    if (p > 0 && e > 0 && f > 0) return 'placeholderEmptyAndInvalidFormat';
    if (p > 0 && e > 0) return 'placeholderAndEmptyTestcaseId';
    if (p > 0 && f > 0) return 'placeholderAndInvalidFormat';
    if (e > 0 && f > 0) return 'emptyAndInvalidFormat';
    if (p > 0) return 'placeholderTestcaseIdOnly';
    if (e > 0) return 'emptyTestcaseIdOnly';
    if (f > 0) return 'invalidFormatOnly';
    return 'unknown';
}

/**
 * step 4：调用后端 & 校验 returnCode。
 * 成功返回解析后的 successMappings/failures；
 * 接口失败时也返回结构化结果（每行一条失败），不再 return null，
 * 保证 runPush 能统一走到 onComplete 展示完整结果（含预校验失败 + 接口失败）。
 */
async function stepInvokeBackend(
    ctx: PushContext,
    rows: RowLike[],
    taskInfo: { testTaskNo: string; subTestTaskId: string },
): Promise<{ successMappings: PushSuccessMapping[]; failures: PushResponseFailure[] }> {
    console.log(`[推送][${ctx.traceId}] 文件: ${ctx.opts.filePath}, ${rows.length} 行`);
    TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.start`, {
        ...baseTelemetryProps(ctx), totalRows: String(rows.length),
    });
    emitProgress(ctx.hooks, 'start', { rows: rows.length });
    emitProgress(ctx.hooks, 'pushing', { rows: rows.length });

    // 按来源分两批推送：TC+uuid.hex → testAgent；其余（MA / 标准 UUID）→ testAgentMA。
    // 各自独立调用接口，响应结果再按「全局行下标」合并，保证最终弹窗与行号一致、按行顺序呈现。
    const batches = splitRowsByPushSource(rows);
    if (batches.length === 0) {
        pushDiag(`[接口] 来源分流后无任何批次（rows=${rows.length}），跳过接口调用`);
        return { successMappings: [], failures: [] };
    }
    pushDiag(`[接口] 分批=${batches.map((b) => `${b.source}:${b.rows.length}行`).join(', ')}`);

    // 预计算每批行在全局 rows 中的下标，用于把批内 bodyIndex 重映射回全局行号。
    const tcGlobalIdx: number[] = [];
    const maGlobalIdx: number[] = [];
    rows.forEach((r, gi) => {
        if (resolveRowSource(readTsId(r)) === 'testAgent') tcGlobalIdx.push(gi);
        else maGlobalIdx.push(gi);
    });

    const allSuccess: PushSuccessMapping[] = [];
    const allFailures: PushResponseFailure[] = [];
    for (const batch of batches) {
        const gidx = batch.source === 'testAgent' ? tcGlobalIdx : maGlobalIdx;
        pushDiag(`[接口] 开始调用批次 source=${batch.source} 行数=${batch.rows.length}`);

        // 逐行预映射（dry-run）：探测 mapRowToCaseItem 会抛错的行，剔除后只推送合法行，
        // 避免单行映射失败（如缺步骤描述）杀死整批。http.ts 内 data.map(mapRowToCaseItem)
        // 任一行为抛错即整体失败，故在调用前先在这里逐行容错。
        const normRows = normalizePushData(batch.rows);
        const validRows: any[] = [];
        const validGlobalIdx: number[] = [];
        for (let bi = 0; bi < normRows.length; bi++) {
            const r = normRows[bi];
            try {
                mapRowToCaseItem(r);   // 仅探测是否抛错，结果不收集
                validRows.push(r);
                validGlobalIdx.push(gidx[bi] ?? bi);
            } catch (e: any) {
                if (isMapError(e)) {
                    pushDiag(`[映射] 行=${e.rowIndex ?? (gidx[bi] ?? bi)} tsId=${readTsId(r) || e.caseTag} 映射失败 reason=${e.reason} :: ${e.message}`);
                    allFailures.push({
                        tsId: readTsId(r) || e.caseTag || '(未知)',
                        reason: e.message || '数据映射失败',
                        bodyIndex: gidx[bi] ?? bi,
                        category: classifyFailure({ reason: e.reason || 'dataMappingError' }),
                    });
                } else {
                    // 非映射类异常（程序 bug），原样上抛由 runPush 顶层 catch 兜底
                    throw e;
                }
            }
        }
        if (validRows.length === 0) {
            pushDiag(`[接口] 批次${batch.source}全部行映射失败，跳过接口调用`);
            continue;
        }
        pushDiag(`[接口] 批次${batch.source}预映射通过=${validRows.length}/${batch.rows.length} 行`);
        // 打印本次将发送给后端的请求数据（validRows），便于排查字段/时序问题。
        // 仅观测、不改变流程；真实请求体由 http.ts 的 pushTestCase 组装并发送。
        pushDiag(`[接口] 批次${batch.source}请求数据(${validRows.length}行):`, validRows);

        const pushResult = await pushTestCase(
            ctx.opts.extensionContext,
            validRows,
            taskInfo,
            ctx.baseName,
            batch.source,
        );
        pushDiag(`[接口] 批次${batch.source}返回 | returnCode=${pushResult.returnCode || '(空)'} | errorMsg=${(pushResult.errorMsg || '').slice(0, 120)} | body长度=${Array.isArray(pushResult.body) ? pushResult.body.length : '非数组'}`);

        if (pushResult.body && Array.isArray(pushResult.body)) {
            pushDiag(`[接口] 原始body明细:`, pushResult.body.map((b: any) => ({ type: b.type ?? '(缺失)', sourceId: b.sourceId, data: String(b.data || '').slice(0, 80) })));
        }
        if (pushResult.returnCode !== 'SUC0000') {
            const errorMsg = pushResult.errorMsg || '推送失败';
            // 不再调 onBackendError / return null —— 改为将接口错误逐行拆成失败项，
            // 由 runPush 的 step 7/8 统一合并预校验失败后在 onComplete 中一次性展示。
            TelemetryService.sendTelemetryErrorEvent(`${ctx.telemetryPrefix}.failed`, {
                ...baseTelemetryProps(ctx),
                returnCode: pushResult.returnCode || '',
                totalRows: String(validRows.length),
                source: batch.source,
                topFailCategory: classifyFailure({ reason: errorMsg }),
                topFailField: failureFieldOf({ reason: errorMsg }) || '',
                costMs: String(Date.now() - ctx.pushStart),
            });
            // 为该批每行都生成一条失败记录（bodyIndex 使用全局行下标）
            for (let vi = 0; vi < validRows.length; vi++) {
                const tsId = readTsId(validRows[vi]);
                allFailures.push({
                    tsId,
                    reason: errorMsg,
                    bodyIndex: validGlobalIdx[vi] ?? vi,
                    category: classifyFailure({ reason: errorMsg }),
                    field: failureFieldOf({ reason: errorMsg }),
                });
            }
            continue; // 继续处理剩余批次（而非整体终止）
        }
        const parsed = parsePushResponse(pushResult.body, validRows);
        pushDiag(`[解析] 批次${batch.source}解析结果 | successMappings=${parsed.successMappings.length} failures=${parsed.failures.length}`);
        if (parsed.failures.length) pushDiag(`[解析] 失败明细:`, parsed.failures.map((f: any) => ({ tsId: f.tsId, reason: f.reason, bodyIndex: f.bodyIndex })));
        if (parsed.successMappings.length) pushDiag(`[解析] 成功明细:`, parsed.successMappings.map((m: any) => ({ tsId: m.tsId, testCaseNo: m.testCaseNo })));
        for (const f of parsed.failures) {
            // 批内 bodyIndex → 全局行下标，确保与 buildTsIdToIndex(rows) / composedFilteredToOriginal 对齐
            f.bodyIndex = validGlobalIdx[f.bodyIndex] ?? f.bodyIndex;
        }
        allSuccess.push(...parsed.successMappings);
        allFailures.push(...parsed.failures);
    }
    pushDiag(`[接口] 全批结束 | 总success=${allSuccess.length} 总failures=${allFailures.length}`);
    return { successMappings: allSuccess, failures: allFailures };
}

/**
 * step 5：样例泄露清洗 —— 埋点 + 从成功/失败列表移除样例 tsId。
 */
function sanitizeSampleLeaks(
    ctx: PushContext,
    successMappings: PushSuccessMapping[],
    failures: PushResponseFailure[],
): { successMappings: PushSuccessMapping[]; failures: PushResponseFailure[] } {
    const leakedSuccess = successMappings.filter(m => m && isSampleTsId(m.tsId)).length;
    const leakedFailure = failures.filter(f => f && isSampleTsId(f.tsId)).length;
    if (leakedSuccess === 0 && leakedFailure === 0) return { successMappings, failures };
    TelemetryService.sendTelemetryErrorEvent(`${ctx.telemetryPrefix}.templateExampleLeaked`, {
        ...baseTelemetryProps(ctx),
        leakedSuccess: String(leakedSuccess),
        leakedFailure: String(leakedFailure),
    });
    return {
        successMappings: successMappings.filter(m => !(m && isSampleTsId(m.tsId))),
        failures: failures.filter(f => !(f && isSampleTsId(f.tsId))),
    };
}

/**
 * step 6b：全部失败场景下，同样刷新一次快照基线并触发 onAllFailedSnapshot。
 */
async function refreshAllFailedSnapshot(ctx: PushContext): Promise<void> {
    try {
        let allFailParser: FileParser | undefined = ctx.opts.parser;
        if (!allFailParser) {
            const fileType = detectFileType(ctx.opts.filePath);
            if (fileType) allFailParser = createParser(fileType);
        }
        if (!allFailParser) return;
        const parsed = await allFailParser.parse(ctx.opts.filePath);
        await savePushSnapshot(ctx.opts.filePath, parsed.tableData);
        if (ctx.hooks.onAllFailedSnapshot) {
            await ctx.hooks.onAllFailedSnapshot({
                parsedTableData: parsed.tableData,
                parsedSourceData: parsed.sourceData,
            });
        }
    } catch (err: any) {
        console.error(`[推送][${ctx.traceId}] 全部失败，快照更新失败:`, err?.message || err);
        TelemetryService.sendTelemetryErrorEvent(`${ctx.telemetryPrefix}.allFailSnapshotFailed`, {
            ...baseTelemetryProps(ctx),
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
    }
}

/**
 * 顶层未预期异常统一兜底 —— 区分 MapError（结构化）与普通 Error（纯文本）。
 * 保证前端一定能解锁 loading。
 *
 * @param extraFailures 异常发生前已收集的失败项（如预校验拦截），
 *                     合并到 onComplete 中避免丢弃；异常本身的错误信息排在最后。
 */
function handleUnexpectedError(
    ctx: PushContext,
    err: any,
    originalRowsCount: number,
    extraFailures?: PushFailureItem[],
): void {
    const errorMessage = String(err?.message || err || '未知错误');
    console.error(`[推送][${ctx.traceId}] runPush 未预期异常:`, errorMessage, err);

    // 分支 A：MapError —— pushDataMapper 已把主表行号写到 err.rowIndex，直接组装 PushFailureItem
    if (isMapError(err)) {
        const mapFailure: PushFailureItem = {
            tsId: err.caseTag || '',
            reason: errorMessage,
            rowIndex: err.rowIndex,
            category: classifyFailure({ reason: errorMessage, mapErrorReason: err.reason }),
            field: failureFieldOf({ reason: errorMessage, mapErrorReason: err.reason }),
        };
        TelemetryService.sendTelemetryErrorEvent(`${ctx.telemetryPrefix}.mapError`, {
            ...baseTelemetryProps(ctx),
            mapErrorReason: err.reason || '',
            mapErrorRowIndex: err.rowIndex !== undefined ? String(err.rowIndex) : '',
            errorMessage: errorMessage.slice(0, 500),
            costMs: String(Date.now() - ctx.pushStart),
        });
        // 合并已有失败 + 本次异常，避免预校验等已收集的失败被吞掉
        const merged = [...(extraFailures || []), mapFailure];
        try {
            ctx.hooks.onComplete({ successCount: 0, failures: merged, total: originalRowsCount });
        } catch (hookErr: any) {
            console.error(`[推送][${ctx.traceId}] onComplete 钩子抛错:`, hookErr?.message || hookErr);
        }
        emitProgress(ctx.hooks, 'done', { rows: originalRowsCount });
        return;
    }

    // 分支 B：非 MapError —— 弹纯文本
    TelemetryService.sendTelemetryErrorEvent(`${ctx.telemetryPrefix}.unexpectedError`, {
        ...baseTelemetryProps(ctx),
        ...telemetryErrProps(err),
        errorMessage: errorMessage.slice(0, 500),
        stackHead: stackHead(err),
        costMs: String(Date.now() - ctx.pushStart),
    });
    try {
        const uiMsg = `推送异常：${errorMessage}`;
        if (ctx.hooks.onUnexpectedError) ctx.hooks.onUnexpectedError(uiMsg);
        else ctx.hooks.onBackendError(uiMsg);
    } catch (hookErr: any) {
        console.error(`[推送][${ctx.traceId}] onUnexpectedError 钩子抛错:`, hookErr?.message || hookErr);
    }
    emitProgress(ctx.hooks, 'done', { rows: originalRowsCount });
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
        traceId: newPushTraceId(),
        maxRows: typeof opts.maxRows === 'number' && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_PUSH_ROWS,
        telemetryPrefix: opts.telemetryPrefix,
        hooks: opts.hooks,
    };
    const originalRowsCount = Array.isArray(opts.rows) ? opts.rows.length : 0;
    pushDiag(`[入口] runPush 开始 | 原始行数=${originalRowsCount} | frontPushIndexToRow长度=${opts.frontPushIndexToRow?.length ?? 0} | frontRowIndexMap键数=${opts.frontRowIndexMap ? Object.keys(opts.frontRowIndexMap).length : 0} | maxRows=${ctx.maxRows} | filePath=${opts.filePath}`);
    // 提升到 try 外层，使 catch 兜底能访问——避免异常路径丢弃已收集的预校验失败
    let preValidationFailures: PushFailureItem[] = [];

    try {
        // ---- 0. 任务绑定校验 ----
        const taskInfo = await stepResolveTaskInfo(ctx);
        if (!taskInfo) return;

        // ---- 1. 空数据短路 ----
        let rows: RowLike[] = Array.isArray(opts.rows) ? opts.rows : [];
        if (rows.length === 0) {
            TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.aborted`, {
                ...baseTelemetryProps(ctx), reason: 'noData',
            });
            ctx.hooks.onNoData?.();
            return;
        }

        // ---- 1.a 贴 __rowIndex（早于任何过滤，行号永远跟着行走） ----
        rows = stampRowIndex(rows, opts.resolveRowIndex);

        // ---- 1.b 行数上限保护 ----
        if (stepCheckMaxRows(ctx, rows.length)) return;

        // ---- 2. 预校验（占位 + 空 tsId + 格式） ----
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

        // 预校验剔除后已无可推送行 —— 直接短路
        if (rows.length === 0) {
            const abortStats = aggregateFailures(preValidationFailures, 1);
            const abortFieldStats = aggregateByField(preValidationFailures, 1);
            TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.aborted`, {
                ...baseTelemetryProps(ctx),
                reason: pickAllDroppedReason(pre.byKind),
                count: String(preValidationFailures.length),
                failCategoryBreakdown: summarizeCategoryBreakdown(abortStats),
                topFailCategory: abortStats.length ? abortStats[0].category : '',
                failFieldBreakdown: summarizeFieldBreakdown(abortFieldStats),
                topFailField: abortFieldStats.length ? abortFieldStats[0].field : '',
            });
            pushDiag(`[短路-全部预校验失败] 总数=${originalRowsCount} 失败=${preValidationFailures.length} | 不调用接口`);
            pushDiag('[短路] 失败明细:', preValidationFailures.map((f: any) => ({ row: f.rowIndex, tsId: f.tsId, cat: f.category, reason: f.reason })));
            showPushDiag();
            ctx.hooks.onComplete({
                successCount: 0,
                failures: preValidationFailures,
                total: originalRowsCount,
            });
            emitProgress(ctx.hooks, 'done', { rows: 0 });
            return;
        }

        // ---- 3. 样例占位过滤 ----
        const { filtered, sampleFailures, skipped, filteredToOriginal } = extractSampleRows(
            opts.filePath, rows, opts.resolveRowIndex,
        );
        if (filtered.length === 0) {
            // 混合场景：样例 + 预校验失败 → 一起在 onComplete 展示
            if (preValidationFailures.length > 0) {
                const abortStats = aggregateFailures([...preValidationFailures, ...sampleFailures], 1);
                const abortFieldStats = aggregateByField([...preValidationFailures, ...sampleFailures], 1);
                TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.aborted`, {
                    ...baseTelemetryProps(ctx),
                    reason: 'onlyTemplateExampleAndPreValidationFailed',
                    sampleCount: String(sampleFailures.length),
                    preValidationCount: String(preValidationFailures.length),
                    failCategoryBreakdown: summarizeCategoryBreakdown(abortStats),
                    topFailCategory: abortStats.length ? abortStats[0].category : '',
                    failFieldBreakdown: summarizeFieldBreakdown(abortFieldStats),
                    topFailField: abortFieldStats.length ? abortFieldStats[0].field : '',
                });
                pushDiag(`[短路-仅样例+预校验失败] 总数=${originalRowsCount} 预校验失败=${preValidationFailures.length} 样例失败=${sampleFailures.length} | 不调用接口`);
                showPushDiag();
                ctx.hooks.onComplete({
                    successCount: 0,
                    failures: [...preValidationFailures, ...sampleFailures],
                    total: originalRowsCount,
                });
                emitProgress(ctx.hooks, 'done', { rows: 0 });
                return;
            }
            const sampleStats = aggregateFailures(sampleFailures, 1);
            const sampleFieldStats = aggregateByField(sampleFailures, 1);
            TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.aborted`, {
                ...baseTelemetryProps(ctx),
                reason: 'onlyTemplateExample',
                count: String(sampleFailures.length),
                failCategoryBreakdown: summarizeCategoryBreakdown(sampleStats),
                topFailCategory: sampleStats.length ? sampleStats[0].category : '',
                failFieldBreakdown: summarizeFieldBreakdown(sampleFieldStats),
                topFailField: sampleFieldStats.length ? sampleFieldStats[0].field : '',
            });
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

        // ---- 4. 后端推送（按来源拆两批：TC+uuid.hex → testAgent；其余 → testAgentMA）----
        pushDiag(`[接口] 即将调用后端推送 | 实际推送行数=${rows.length} ${rows.length === 0 ? '⚠️ 无合法行，将不调用接口' : ''}`);
        const invoked = await stepInvokeBackend(ctx, rows, taskInfo);

        // ---- 5. 泄露清洗（响应已在 stepInvokeBackend 内按批解析并合并）----
        pushDiag('[step5] sanitizeSampleLeaks 开始');
        const cleaned = sanitizeSampleLeaks(ctx, invoked.successMappings, invoked.failures);
        const successMappings = cleaned.successMappings;
        const failures = cleaned.failures;
        pushDiag(`[step5] 清洗后 success=${successMappings.length} failures=${failures.length}`);

        // ---- 6. 成功回写 / 全部失败快照兜底 ----
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

        // ---- 7. 汇总失败行号（三级降级）----
        const tsIdToIndex = buildTsIdToIndex(rows);
        // 组合 filteredToOriginal（sample 过滤后 → preFilter 后）+ preFilterToOriginal（preFilter 后 → 原始）
        const composedFilteredToOriginal: number[] = filteredToOriginal.map(idx =>
            typeof preFilterToOriginal[idx] === 'number' ? preFilterToOriginal[idx] : idx,
        );
        const failureItems = buildFailureItems(
            failures, tsIdToIndex, opts.frontRowIndexMap, opts.frontPushIndexToRow, composedFilteredToOriginal,
        );
        // 两批推送的失败已合并，按主表行号升序排列，保证弹窗按行顺序呈现（无行号的排最后）
        const mergedFailures: PushFailureItem[] = [...preValidationFailures, ...failureItems].sort(
            (a, b) => (a.rowIndex ?? Number.MAX_SAFE_INTEGER) - (b.rowIndex ?? Number.MAX_SAFE_INTEGER),
        );
        // total 使用原始总行数（含预校验拦截/样例过滤/接口推送全部行），而非过滤后的 rows.length
        const total = originalRowsCount;
        pushDiag(`[step7] 合并后 total=${total} success=${successMappings.length} failures=${mergedFailures.length}（预校验=${preValidationFailures.length} 接口=${failureItems.length}）`);

        // ---- 8. 输出结果 & 持久化 ----
        pushDiag(`[汇总] 总数=${total} 成功=${successMappings.length} 失败=${mergedFailures.length}（其中预校验=${preValidationFailures.length} / 接口=${mergedFailures.length - preValidationFailures.length}）`);
        pushDiag('[汇总] 失败明细(按行号):', mergedFailures.map((f: any) => ({ row: f.rowIndex, tsId: f.tsId, cat: f.category, field: f.field, reason: f.reason })));
        showPushDiag();
        ctx.hooks.onComplete({ successCount: successMappings.length, failures: mergedFailures, total });
        try {
            await persistPushFailures(opts.filePath, rows, failures, successMappings);
        } catch (err: any) {
            console.error(`[推送][${ctx.traceId}] 持久化失败标记失败:`, err?.message || err);
        }

        // 失败分类聚合（并入本次推送结果埋点，不单独发事件，避免重复计数）：
        //   - 用户仍看到完整中文原文 reason；
        //   - category 为稳定短码，供后台按错误类型聚合统计。
        const failStats = aggregateFailures(mergedFailures, 1);
        const failCategoryBreakdown = summarizeCategoryBreakdown(failStats);
        const topFailCategory = failStats.length ? failStats[0].category : '';

        // 字段聚焦维度（仅字段类错误计入）：failFieldBreakdown 'sourceId:3,testCaseName:1' + topFailField
        const failFieldStats = aggregateByField(mergedFailures, 1);
        const failFieldBreakdown = summarizeFieldBreakdown(failFieldStats);
        const topFailField = failFieldStats.length ? failFieldStats[0].field : '';

        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.complete`, {
            ...baseTelemetryProps(ctx),
            pushResult: mergedFailures.length === 0
                ? 'allSuccess'
                : (successMappings.length === 0 ? 'allFail' : 'partial'),
            totalRows: String(total),
            successRows: String(successMappings.length),
            failedRows: String(mergedFailures.length),
            preValidationFailedRows: String(preValidationFailures.length),
            failCategoryBreakdown,
            topFailCategory,
            failFieldBreakdown,
            topFailField,
            costMs: String(Date.now() - ctx.pushStart),
        });
        emitProgress(ctx.hooks, 'done', { rows: total });
    } catch (err: any) {
        // 顶层未预期异常兜底：MapError / 普通 Error
        // 携带 preValidationFailures 避免异常路径丢弃已收集的预校验失败（如占位/格式非法）
        pushDiag(`[异常] runPush catch | err=${err?.message || err} | stack=${(err?.stack || '').slice(0, 300)}`);
        showPushDiag();
        handleUnexpectedError(ctx, err, originalRowsCount, preValidationFailures);
    }
}
