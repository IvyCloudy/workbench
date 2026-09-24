/**
 * preValidate/stepPreValidate.ts
 * -------------------------------------------------------------
 * 前置校验（Pre-Validate）· 推送流程编排层
 * -------------------------------------------------------------
 * 本文件从 handlers/pushCore.stages.ts 抽出，专注"推送前一次性校验"的
 * 完整流程 —— 组合 validators.ts 的纯校验能力 + 埋点 + 磁盘持久化：
 *   · stampRowIndex           推送前对每行注入 __rowIndex 元数据
 *   · stepPreValidate         推送 step 2：执行校验 + 埋点 + 高亮持久化
 *   · applyPreValidationDrops 从 rows 剔除 error 级失败行 + 产出映射
 *   · pickAllDroppedReason    "全部行都被剔除"时的 aborted reason 归类
 *
 * 与 validators.ts 的边界：
 *   · validators.ts —— 纯 CPU、无副作用（可单测）
 *   · 本文件        —— 有副作用（埋点 / 落盘 / 依赖 PushContext）
 */

import { TelemetryService } from '../utils/telemetry';
import { persistPushFailures } from '../utils/pushFailureStore';
import { ROW_INDEX_META } from '../utils/pushDataMapper';
import { TS_ID_COLUMN } from '../services/utils';
import type { PushFailureItem, PreValidationResult, PushContext, RowLike } from '../handlers/pushCore.types';
import { runValidators } from './validators';
import { createParser, detectFileType } from '../parsers';
import {
    detectMissingColumns,
    buildMissingColumnReason,
    type MissingColumnHit,
} from './missingColumns';
import { classifyFailure } from '../utils/pushFailureCategory';

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
 * §2.3.5 · 必备列/字段结构性检查（推送前 · error 级）
 *
 * 独立于 runValidators（行级）之外，因为"文件级列缺失"无法通过逐行 validator 承载：
 *   - CSV 需要 headers（sourceData 为 null）；
 *   - YAML/JSON 需要"全文件所有案例聚合"判定，逐行 validator 拿不到整体视图。
 *
 * 策略：
 *   - 由 stepPreValidate 顶部调用一次 parser.parse（异步），检测缺失清单；
 *   - 每个缺失产出一条 PushFailureItem（rowIndex 用 1 兜底，供上层弹窗归位到文件首行）；
 *   - 命中时把"所有行"都加入 droppedIndex —— 结构性错误使本文件推送短路。
 *
 * 单测策略：本函数含 IO（parser.parse），核心判定逻辑已抽离到 preValidate/missingColumns.ts
 * 的纯函数中做单测；此处仅做 IO + 组装 + 埋点。
 */
async function detectMissingColumnFailures(ctx: PushContext): Promise<PushFailureItem[]> {
    const filePath = ctx.opts.filePath;
    const fileType = detectFileType(filePath);
    if (!fileType) return [];
    // 优先复用调用方注入的 parser（编辑器场景），否则内部自建（右键场景）
    const parser = ctx.opts.parser || createParser(fileType);
    let headers: string[] | null | undefined;
    let sourceData: any;
    try {
        const parsed = await parser.parse(filePath);
        headers = parsed?.tableData?.headers;
        sourceData = parsed?.sourceData;
    } catch (err: any) {
        // parse 失败时不阻断推送 —— 交给下游 pushCore 的 fileError / yamlSyntax 分类处理；
        // 此处只需返回空数组即可，避免"重复弹解析错误"的糟糕体验。
        console.warn(`[推送][${ctx.traceId}] 结构性检查 parse 失败，跳过 missingColumns 检查:`, err?.message || err);
        return [];
    }
    const result = detectMissingColumns(fileType, headers, sourceData);
    if (result.ok || result.missing.length === 0) return [];
    // §2.3.5：缺列/字段是"文件级"错误，不属于任何一行 ——
    //   · rowIndex 传 undefined，让前端 05g 不渲染"第 N 行"，也不挂"点击定位"跳转；
    //   · tsId 用固定伪值 '__FILE_LEVEL__'，让 05g 分组键落到同一组（不按行拆散）；
    //   · reason 文案已在 missingColumns.ts 中明确"当前文件缺少..."，避免误导为单行问题。
    return result.missing.map((hit: MissingColumnHit) => {
        const reason = buildMissingColumnReason(hit, fileType);
        return {
            tsId: '__FILE_LEVEL__',
            reason,
            // rowIndex 有意留空 —— 前端据此走"文件级"渲染分支
            category: classifyFailure({ reason, validatorKind: 'missingColumn' }),
            severity: hit.severity,
        } as PushFailureItem;
    });
}

/**
 * step 2：预校验 —— 通用 validators 驱动 + 差异化埋点 + 占位/格式失败持久化。
 *
 * severity 语义（Y 方案：软拦截项进入 failures 但不进 droppedIndex）：
 *   - error 级（占位/空/格式非法）→ 加入 failures & droppedIndex，行被剔除；
 *   - warn  级（「待补充」等）    → 加入 failures 但不剔除；行仍参与推送。
 * 汇总顺序：结构性错误在最前（missingColumn），其次 error 级（placeholder → empty →
 * invalidFormat → 内容层 error），warn 级在最后（todoPlaceholder），便于上层
 * "先展示结构性硬拦截 → 行级硬拦截 → 软拦截"。
 */
export async function stepPreValidate(ctx: PushContext, rows: RowLike[]): Promise<PreValidationResult> {
    // §2.3.5：先做结构性检查；命中即所有行剔除、短路推送。
    const missingColumnFailures = await detectMissingColumnFailures(ctx);
    if (missingColumnFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.missingColumnsDetected`, {
            ...baseTelemetryProps(ctx),
            count: String(missingColumnFailures.length),
        });
    }
    const { failuresByKind, droppedIndex } = runValidators(rows, ctx.opts.resolveRowIndex);
    // 结构性缺失列：
    //   · error（必填）缺失 → 所有行加入 droppedIndex，本文件推送短路；
    //   · warn（非必填，如 description / type / preconditions）缺失 → 仅进入 failures 展示，不阻断。
    const hasErrorMissing = missingColumnFailures.some(f => f.severity !== 'warn');
    if (hasErrorMissing) {
        for (let i = 0; i < rows.length; i++) droppedIndex.add(i);
    }
    if (missingColumnFailures.length > 0) {
        failuresByKind['missingColumn'] = missingColumnFailures;
    }
    const placeholderFailures = failuresByKind['placeholder'] || [];
    const emptyFailures = failuresByKind['empty'] || [];
    const formatFailures = failuresByKind['invalidFormat'] || [];
    // B2 · error 级：枚举字段取值非法 / 计划执行次数类型非法（tsId 合法后才有意义扫描内容字段）
    const enumInvalidFailures = failuresByKind['enumInvalid'] || [];
    const planExecNumFailures = failuresByKind['planExecNumInvalid'] || [];
    const nameEmptyFailures = failuresByKind['nameEmpty'] || [];
    // D5 · 案例唯一性（name+path 同文件内重复）：error 级，与 nameEmpty 同层
    const duplicateNameFailures = failuresByKind['duplicateName'] || [];
    const todoFailures = failuresByKind['todoPlaceholder'] || [];
    // §2.3.5：结构性错误在最前展示，让用户先看到"文件级缺列"再看到行级错误
    const failures: PushFailureItem[] = [
        ...missingColumnFailures,
        ...placeholderFailures,
        ...emptyFailures,
        ...formatFailures,
        ...enumInvalidFailures,
        ...planExecNumFailures,
        ...nameEmptyFailures,
        ...duplicateNameFailures,
        ...todoFailures,
    ];
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
    // B2 · error 级枚举/类型命中埋点：与 tsId 硬拦截同族的 `.xxxSkipped` 命名，
    // 便于看板下钻"内容层硬拦截"与"tsId 层硬拦截"两类指标（同为剔除行）。
    if (enumInvalidFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.enumInvalidSkipped`, {
            ...baseTelemetryProps(ctx),
            count: String(enumInvalidFailures.length),
        });
    }
    if (planExecNumFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.planExecNumInvalidSkipped`, {
            ...baseTelemetryProps(ctx),
            count: String(planExecNumFailures.length),
        });
    }
    if (nameEmptyFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.nameEmptySkipped`, {
            ...baseTelemetryProps(ctx),
            count: String(nameEmptyFailures.length),
        });
    }
    // D5 · 重复案例名称命中埋点（error 级，属内容层硬拦截 → 同族命名）
    if (duplicateNameFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.duplicateNameSkipped`, {
            ...baseTelemetryProps(ctx),
            count: String(duplicateNameFailures.length),
        });
    }
    // 「待补充」软拦截命中埋点（不区分 skipped/pushed，因为软拦截行仍会被推送）。
    if (todoFailures.length > 0) {
        TelemetryService.sendTelemetryEvent(`${ctx.telemetryPrefix}.todoPlaceholderDetected`, {
            ...baseTelemetryProps(ctx),
            count: String(todoFailures.length),
        });
    }
    // 高亮持久化：将命中项写入 pushFailureStore，供编辑器侧渲染黄/红底色。
    // 需求 2.2.1：占位/格式非法用红色（error），「待补充」用黄色（warn）；
    //   B2 新增：枚举取值非法 / 计划执行次数非法 也用红色（error），
    //   由渲染侧根据 severity（或 category）区分底色，本处仅保证"应高亮的都持久化"。
    const highlightFailures = [
        ...placeholderFailures,
        ...formatFailures,
        ...enumInvalidFailures,
        ...planExecNumFailures,
        ...nameEmptyFailures,
        // D5 · 重复 name+path 也需高亮（红色）：持久化以便编辑器 hover 时看到字段级 reason
        ...duplicateNameFailures,
        ...todoFailures,
    ];
    if (highlightFailures.length > 0) {
        try {
            const highlightRows = highlightFailures.map(f => ({ [TS_ID_COLUMN]: f.tsId } as RowLike));
            await persistPushFailures(
                ctx.opts.filePath,
                highlightRows,
                highlightFailures.map(f => ({
                    tsId: f.tsId,
                    reason: f.reason,
                    category: f.category,
                    field: f.field,
                    severity: f.severity,
                    stepIdx: f.stepIdx,
                    subField: f.subField,
                    hits: f.hits,
                })),
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
    const mc = (byKind['missingColumn'] || []).length;
    // §2.3.5：结构性错误优先归类（本文件根本无法正确解析/推送）
    if (mc > 0) return 'missingColumnsOnly';
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
