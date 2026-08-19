/**
 * pushCore · 阶段逻辑聚合（阶段 1~5）。
 * 原 pushCore.ts 的「阶段 1 预校验」「阶段 2 样例过滤」「阶段 3 任务信息」
 * 「阶段 4 失败行号」「阶段 5 成功回写」合并为单文件，减少拆分粒度。
 */

import { pushTestCase } from '../services/http';
import { getFileIds, toWorkspaceRelativePath } from '../utils/fileUtils';
import {
    classifyFailure,
    failureFieldOf,
    type PushFailCategory,
    type PushInterfaceField,
} from '../utils/pushFailureCategory';
import { isSampleTsId, filterTemplateExampleRows, TEMPLATE_EXAMPLE_TS_ID } from '../utils/fileIdentifier';
import { isTestAgentUuid, isTestFlowUuid } from '../utils/testcaseId';
import { TS_ID_COLUMN, stackHead } from '../services/utils';
import { TelemetryService } from '../utils/telemetry';
import { telemetryErrProps } from '../utils/extensionHelpers';
import { savePushSnapshot } from '../utils/pushSnapshotStore';
import { ensureTrackingColumns, applyTestCaseNos, detectFileType, createParser, type FileParser } from '../parsers';
import { getCurrentTaskInfo } from '../utils/commands';
import { isMapError, ROW_INDEX_META, mapRowToCaseItem } from '../utils/pushDataMapper';
import { pushDiag, showPushDiag } from '../utils/pushDiagnostics';
import { parsePushResponse } from '../utils/pushResponse';
import { persistPushFailures } from '../utils/pushFailureStore';
import { normalizePushData } from '../utils/headerLabels';
import { withFileLock } from '../utils/asyncLock';
import type { PushResponseFailure, PushSuccessMapping } from '../utils/pushResponse';
import type { PushFailureItem, WriteBackOptions, ExtractSampleRowsResult, RowIndexResolveCtx, ResolveTaskInfoResult, PreValidationResult, PushContext, RunPushOptions, PushCoreHooks, RowLike } from './pushCore.types';

/** 重新导出 RowLike，使 barrel（pushCore.ts）可透传该类型给调用方，无需直接依赖 pushCore.types。 */
export type { RowLike } from './pushCore.types';

// =============================================================
// 行级小工具（被各阶段共用）
// =============================================================

/** 从行对象读取标准化后的 tsId（trim + 空值兜底为 ''）。 */
export function readTsId(rec: RowLike | undefined | null): string {
    if (!rec) return '';
    const raw = rec[TS_ID_COLUMN];
    return raw == null ? '' : String(raw).trim();
}

// =============================================================
// 阶段 1：可扩展的行级预校验（RowValidator 数组）
// =============================================================

/** 单条行级预校验规则。返回失败明细或 null（通过）。 */
export interface RowValidator {
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
            return {
                tsId: '',
                reason: 'testcase_id 不能为空，请填写案例 ID 后再推送',
            };
        }
        return null;
    },
};

/** 案例唯一标识（testcase_id）合法格式：标准 UUID，或 TC/MA 前缀 + 32 位 uuid.hex */
const TESTCASE_ID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(TC|MA)[0-9a-f]{32})$/i;

/**
 * 综合校验 testcase_id 合法性，兼容两类 TC 前缀"掩码 uuid"场景：
 *   - 标准 UUID / TC|MA + 32 位 hex（TESTCASE_ID_PATTERN）
 *   - testagent 掩码 uuid（isTestAgentUuid）
 *   - testflow 掩码 uuid（isTestFlowUuid）
 * 掩码 uuid 的判定逻辑独立沉淀于 utils/testcaseId，便于其它模块复用。
 */
export function isTestcaseIdValid(tsId: string): boolean {
    return (
        TESTCASE_ID_PATTERN.test(tsId) ||
        isTestAgentUuid(tsId) ||
        isTestFlowUuid(tsId)
    );
}

/** 内置校验：testcase_id 值必须符合案例唯一标识规范（UUID / TC+uuid.hex / MA+uuid.hex / testagent / testflow） */
const FORMAT_VALIDATOR: RowValidator = {
    kind: 'invalidFormat',
    check(_row, tsId) {
        if (!isTestcaseIdValid(tsId)) {
            return {
                tsId,
                reason: 'testcase_id的值不符合案例唯一标识规范',
            };
        }
        return null;
    },
};

/** 内置校验器序列（按需扩展；语义即"按顺序对每行跑一遍所有校验"）。 */
export const DEFAULT_VALIDATORS: RowValidator[] = [PLACEHOLDER_VALIDATOR, EMPTY_VALIDATOR, FORMAT_VALIDATOR];

/**
 * 通用校验驱动：按 validators 顺序对每行跑一遍，收集失败并按 kind 分桶。
 * 空 tsId 的失败项在此处补上 `__EMPTY_TSID_ROW_${rowIndex}__` 稳定伪 tsId。
 */
export function runValidators(
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
                break;
            }
        }
    }
    return { failuresByKind, droppedIndex };
}

export function collectPlaceholderTestcaseIdFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [PLACEHOLDER_VALIDATOR]).failuresByKind['placeholder'] || [];
}

export function collectEmptyTestcaseIdFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [EMPTY_VALIDATOR]).failuresByKind['empty'] || [];
}

export function collectInvalidFormatFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [FORMAT_VALIDATOR]).failuresByKind['invalidFormat'] || [];
}

// =============================================================
// 阶段 2：样例过滤（中文样例占位）
// =============================================================

export function extractSampleRows(
    filePath: string,
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): ExtractSampleRowsResult {
    const src = Array.isArray(rows) ? rows : [];
    const sampleFailures: PushFailureItem[] = [];
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
                    field: 'sourceId',
                });
            }
        }
    }
    const filtered = filterTemplateExampleRows(filePath, src);
    const filteredToOriginal: number[] = [];
    if (filtered.length === src.length) {
        for (let i = 0; i < src.length; i++) filteredToOriginal.push(i);
    } else {
        let cursor = 0;
        for (let i = 0; i < src.length && cursor < filtered.length; i++) {
            const tsId = readTsId(src[i]);
            if (!isSampleTsId(tsId)) {
                filteredToOriginal.push(i);
                cursor++;
            }
        }
    }
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

// =============================================================
// 阶段 3：任务信息拉取
// =============================================================

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

// =============================================================
// 阶段 4：失败行号汇总（可扩展责任链）
// =============================================================

export function buildRowIndexMappings(
    rows: RowLike[],
): { rowIndexMap: Record<string, number>; pushIndexToRow: number[] } {
    const rowIndexMap: Record<string, number> = {};
    const pushIndexToRow: number[] = [];
    if (!Array.isArray(rows)) return { rowIndexMap, pushIndexToRow };
    rows.forEach((rec, i) => {
        const tsId = readTsId(rec);
        if (tsId !== '') rowIndexMap[tsId] = i + 1;
        pushIndexToRow.push(i + 1);
    });
    return { rowIndexMap, pushIndexToRow };
}

export function buildTsIdToIndex(pushData: RowLike[]): Map<string, number> {
    const map = new Map<string, number>();
    if (!Array.isArray(pushData)) return map;
    pushData.forEach((rec, i) => {
        const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
        if (id) map.set(id, i);
    });
    return map;
}

type RowIndexResolver = (ctx: RowIndexResolveCtx) => number | undefined;

const resolveByFrontTsIdMap: RowIndexResolver = ({ failure, frontRowIndexMap }) => {
    const v = frontRowIndexMap[failure.tsId];
    return typeof v === 'number' && v > 0 ? v : undefined;
};

const resolveByBodyIndex: RowIndexResolver = ({ failure, frontPushIndexToRow, filteredToOriginal }) => {
    if (typeof failure.bodyIndex !== 'number' || failure.bodyIndex < 0) return undefined;
    if (frontPushIndexToRow.length === 0) return undefined;
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

const resolveByExtensionTsIdIndex: RowIndexResolver = ({ failure, tsIdToRowIndex }) => {
    if (!failure.tsId || !tsIdToRowIndex.has(failure.tsId)) return undefined;
    return tsIdToRowIndex.get(failure.tsId)! + 1;
};

const DEFAULT_ROW_INDEX_RESOLVERS: RowIndexResolver[] = [
    resolveByFrontTsIdMap,
    resolveByBodyIndex,
    resolveByExtensionTsIdIndex,
];

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

// =============================================================
// 阶段 5：成功回写 testCaseNo & 快照
// =============================================================

export async function writeBackTestCaseNos(opts: WriteBackOptions): Promise<void> {
    if (!opts.successMappings || opts.successMappings.length === 0) return;
    // 与 pointCaseDeleter 共用同一把 per-file 异步锁，避免"推送成功回写"与"删除案例"并发
    // 覆盖同一案例文件（parse → mutate → save 三步链路互斥）。
    return withFileLock(opts.filePath, () => writeBackTestCaseNosLocked(opts));
}

async function writeBackTestCaseNosLocked(opts: WriteBackOptions): Promise<void> {
    try {
        let parser: FileParser | undefined = opts.parser;
        if (!parser) {
            const fileType = detectFileType(opts.filePath);
            if (!fileType) return;
            parser = createParser(fileType);
        }

        const parsed = await parser.parse(opts.filePath);
        ensureTrackingColumns(parsed.tableData, parsed.sourceData);
        applyTestCaseNos(parsed.tableData, parsed.sourceData, opts.successMappings);

        opts.hooks?.markSelfSave?.();

        await savePushSnapshot(opts.filePath, parsed.tableData);

        await parser.save(opts.filePath, parsed.tableData, parsed.sourceData);
        opts.hooks?.markSelfSave?.();

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
        try {
            opts.hooks?.onWriteBackFailed?.(String(err?.message || err || '案例编号回写失败'));
        } catch (_) { /* hook 抛错不影响主流程 */ }
    }
}

// =============================================================
// 主流程编排（拆分为若干私有 step）
// =============================================================

/** 单次推送行数默认上限（可通过 RunPushOptions.maxRows 覆盖）。 */
const DEFAULT_MAX_PUSH_ROWS = 5000;

/** 推送来源平台类型（与接口 sourcePlatform 取值对应）。 */
type PushSource = 'testAgent' | 'testAgentMA';

/**
 * 来源判定：testcase_id 满足 TC + 32 位 uuid.hex → 'testAgent'，其余（含 MA / 标准 UUID）→ 'testAgentMA'。
 * TC 前缀的"掩码 uuid"（testagent / testflow）同样归属 testAgent 批次。
 */
const TC_SOURCE_PATTERN = /^TC[0-9a-f]{32}$/i;

function resolveRowSource(tsId: string): PushSource {
    if (TC_SOURCE_PATTERN.test(tsId) || isTestAgentUuid(tsId) || isTestFlowUuid(tsId)) {
        return 'testAgent';
    }
    return 'testAgentMA';
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

/** 埋点事件的公共字段（ext + traceId），所有 step 共用。 */
function baseTelemetryProps(ctx: PushContext): Record<string, string> {
    return { ext: ctx.fileExt, traceId: ctx.traceId };
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
export function applyPreValidationDrops(rows: RowLike[], droppedIndex: Set<number>): { rows: RowLike[]; preFilterToOriginal: number[] } {
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
export function pickAllDroppedReason(byKind: Record<string, PushFailureItem[]>): string {
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
export async function stepInvokeBackend(
    ctx: PushContext,
    rows: RowLike[],
    taskInfo: { testTaskNo: string; subTestTaskId: string },
): Promise<{ successMappings: PushSuccessMapping[]; failures: PushResponseFailure[] }> {
    console.log(`[推送][${ctx.traceId}] 文件: ${ctx.opts.filePath}, ${rows.length} 行`);
    // 文件/文件夹的 fs 标识（inode / dev），来自 getFileIds；
    // 读取失败/路径不存在时 getFileIds 返回 { file_id: '', device_id: '' }，
    // 这里再做一次空值兜底，避免 fileFields 为 null/undefined 时访问属性抛错。
    const fileFields = (await getFileIds(ctx.opts.filePath)) || { file_id: '', device_id: '' };
    // 文件路径仅保留基于工作区根的相对路径
    const relativeFilePath = toWorkspaceRelativePath(ctx.opts.filePath);
    TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.start`, {
        ...baseTelemetryProps(ctx),
        totalRows: String(rows.length),
        caseCount: String(rows.length),
        testTaskNo: taskInfo.testTaskNo || '',
        subTestTaskId: taskInfo.subTestTaskId || '',
        file_id: fileFields.file_id,
        device_id: fileFields.device_id,
        filePath: relativeFilePath,
    });
    emitProgress(ctx.hooks, 'start', { rows: rows.length });
    emitProgress(ctx.hooks, 'pushing', { rows: rows.length });

    const batches = splitRowsByPushSource(rows);
    if (batches.length === 0) {
        pushDiag(`[接口] 来源分流后无任何批次（rows=${rows.length}），跳过接口调用`);
        return { successMappings: [], failures: [] };
    }
    pushDiag(`[接口] 分批=${batches.map((b) => `${b.source}:${b.rows.length}行`).join(', ')}`);

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

        const normRows = normalizePushData(batch.rows);
        const validRows: any[] = [];
        const validGlobalIdx: number[] = [];
        for (let bi = 0; bi < normRows.length; bi++) {
            const r = normRows[bi];
            try {
                mapRowToCaseItem(r);
                validRows.push(r);
                validGlobalIdx.push(gidx[bi] ?? bi);
            } catch (e: any) {
                if (isMapError(e)) {
                    pushDiag(`[映射] 行=${e.rowIndex ?? (gidx[bi] ?? bi)} tsId=${readTsId(r) || e.caseTag} 映射失败 reason=${e.reason} :: ${e.message}`);
                    allFailures.push({
                        tsId: readTsId(r) || e.caseTag || '(未知)',
                        reason: e.message || '数据映射失败',
                        bodyIndex: gidx[bi] ?? bi,
                        mapErrorReason: e.reason,
                        category: classifyFailure({ reason: e.message || '数据映射失败', mapErrorReason: e.reason }),
                    });
                } else {
                    throw e;
                }
            }
        }
        if (validRows.length === 0) {
            pushDiag(`[接口] 批次${batch.source}全部行映射失败，跳过接口调用`);
            continue;
        }
        pushDiag(`[接口] 批次${batch.source}预映射通过=${validRows.length}/${batch.rows.length} 行`);
        pushDiag(`[接口] 批次${batch.source}请求数据(${validRows.length}行):`, validRows);

        const pushResult = await pushTestCase(
            ctx.opts.extensionContext,
            validRows,
            taskInfo,
            fileFields.file_id,
            batch.source,
        );
        pushDiag(`[接口] 批次${batch.source}返回 | returnCode=${pushResult.returnCode || '(空)'} | errorMsg=${(pushResult.errorMsg || '').slice(0, 120)} | body长度=${Array.isArray(pushResult.body) ? pushResult.body.length : '非数组'}`);

        if (pushResult.body && Array.isArray(pushResult.body)) {
            pushDiag(`[接口] 原始body明细:`, pushResult.body.map((b: any) => ({ type: b.type ?? '(缺失)', sourceId: b.sourceId, data: String(b.data || '').slice(0, 80) })));
        }
        if (pushResult.returnCode !== 'SUC0000') {
            let errorMsg = pushResult.errorMsg;
            if (!errorMsg) {
                const rcText = pushResult.returnCode ? String(pushResult.returnCode) : '空';
                let bodyText: string;
                if (Array.isArray(pushResult.body)) {
                    bodyText = `数组(len=${pushResult.body.length})`;
                } else if (pushResult.body && typeof pushResult.body === 'object') {
                    let jsonSnippet: string;
                    try {
                        jsonSnippet = JSON.stringify(pushResult.body).slice(0, 60);
                    } catch {
                        jsonSnippet = String(pushResult.body).slice(0, 60);
                    }
                    bodyText = `非数组(${jsonSnippet})`;
                } else {
                    bodyText = `非数组(${String(pushResult.body)})`;
                }
                errorMsg = `推送失败（后端返回码=${rcText}，body=${bodyText}，无错误详情，请联系后端排查）`;
            }
            TelemetryService.sendTelemetryErrorEvent(`${ctx.telemetryPrefix}.failed`, {
                ...baseTelemetryProps(ctx),
                returnCode: pushResult.returnCode || '',
                totalRows: String(validRows.length),
                source: batch.source,
                topFailCategory: classifyFailure({ reason: errorMsg }),
                topFailField: failureFieldOf({ reason: errorMsg }) || '',
                costMs: String(Date.now() - ctx.pushStart),
            });
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
            continue;
        }
        const parsed = parsePushResponse(pushResult.body, validRows);
        pushDiag(`[解析] 批次${batch.source}解析结果 | successMappings=${parsed.successMappings.length} failures=${parsed.failures.length}`);
        if (parsed.failures.length) pushDiag(`[解析] 失败明细:`, parsed.failures.map((f: any) => ({ tsId: f.tsId, reason: f.reason, bodyIndex: f.bodyIndex })));
        if (parsed.successMappings.length) pushDiag(`[解析] 成功明细:`, parsed.successMappings.map((m: any) => ({ tsId: m.tsId, testCaseNo: m.testCaseNo })));
        for (const f of parsed.failures) {
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
export function sanitizeSampleLeaks(
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
export async function refreshAllFailedSnapshot(ctx: PushContext): Promise<void> {
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
export function handleUnexpectedError(
    ctx: PushContext,
    err: any,
    originalRowsCount: number,
    extraFailures?: PushFailureItem[],
): void {
    const errorMessage = String(err?.message || err || '未知错误');
    console.error(`[推送][${ctx.traceId}] runPush 未预期异常:`, errorMessage, err);

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
        const merged = [...(extraFailures || []), mapFailure];
        try {
            ctx.hooks.onComplete({
                successCount: 0,
                failures: merged,
                total: originalRowsCount,
                preValidationFailCount: extraFailures?.length ?? 0,
                traceId: ctx.traceId,
                costMs: Date.now() - ctx.pushStart,
            });
        } catch (hookErr: any) {
            console.error(`[推送][${ctx.traceId}] onComplete 钩子抛错:`, hookErr?.message || hookErr);
        }
        emitProgress(ctx.hooks, 'done', { rows: originalRowsCount });
        return;
    }

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
