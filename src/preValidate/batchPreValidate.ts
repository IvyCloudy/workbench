/**
 * ============================================================================
 *  preValidate/batchPreValidate.ts
 *  批量推送前置校验 — 纯校验（无埋点、无落盘），供 pushHandler 批量循环前调用
 * ----------------------------------------------------------------------------
 *  背景：
 *    批量推送前，需要先对所有待推送文件跑一遍前置校验，汇总所有 error / warn，
 *    在推送启动前用 05g 弹窗一次性告知用户；有 error → 阻断整批；
 *    纯 warn → 允许"忽略并继续推送"；全清白 → 直接进入推送循环（无打扰）。
 *
 *  与 editValidationHandler._doValidate 的差异：
 *    · 不持久化到 pushFailureStore（这一阶段还没到"编辑高亮口径"）
 *    · 不做任何埋点（批量场景埋点应聚合到 batch.preValidate.*，而非误挂到编辑期口径）
 *    · 不通知 webview 刷新（当前文件可能还没打开 webview）
 *    · 不做防抖（批量循环内串行调用，各自独立）
 *
 *  与推送流程 stepPreValidate 的差异：
 *    · 不依赖 PushContext（无 traceId / telemetryPrefix / hooks）
 *    · 只产出 failures 清单，不做行剔除 / 短路 / 后端调用
 *
 *  校验规则完全一致（复用同一套 detectMissingColumns + runValidatorsOnRowsPure）：
 *    · 结构性检查（缺必备列/字段）→ 一条 file-level failure，severity 依必填/非必填分级（error/warn）
 *    · 行级校验（占位/空/格式/枚举/待补充/…）→ 每行按规则产出 failure
 * ============================================================================
 */
import { classifyFailure } from '../utils/pushFailure';
import { detectFileType } from '../parsers';
import { runValidators, flattenFailuresByKind } from './validators';
import { detectMissingColumns, buildMissingColumnReason } from './missingColumns';
import {
    resolveTargetType, loadValidationSource, FILE_LEVEL_TSID, type ValidationSource,
} from './validationSource';
import { collectPathFailuresForFile } from '../utils/casePathValidator';
import type { PushFailureItem } from '../handlers/pushCore.types';

/** 单文件批量前置校验结果。 */
export interface BatchPreValidateFileResult {
    /** 文件绝对路径 */
    filePath: string;
    /** 显示名（相对路径），供 05g 分组头展示 */
    fileName: string;
    /** 该文件命中的所有 failures（文件级置顶 + 行级） */
    failures: PushFailureItem[];
    /** 是否含 error 级问题（严重程度：结构性缺列 / 枚举非法 / 类型非法 / 占位/空 / 格式非法 / 名称空） */
    hasError: boolean;
    /** 是否只含 warn 级问题（如「待补充」） */
    hasOnlyWarn: boolean;
    /** parse 失败或不合规目录时置 true —— 本函数不作为致命错误处理，仅返回空 failures 供上层跳过 */
    skipped?: boolean;
    /** 跳过原因（调试用） */
    skipReason?: string;
}

/**
 * 对单个文件跑一次前置校验（纯函数：无埋点 / 无落盘 / 无 UI 副作用）。
 *
 * 返回策略：
 *   · 不合规目录 / 类型不支持 → skipped=true, failures=[]（上层视为"无问题"）
 *   · parse 失败                 → skipped=true, failures=[]（parse 错误由推送阶段的
 *                                    fileError / yamlSyntax 归口处理，避免"重复弹解析错误"）
 *   · 结构性错误（缺必备列/字段） → 一条 file-level failure（tsId=FILE_LEVEL_TSID），severity=error
 *   · 行级失败                   → 每行产出 failure，含 severity（error/warn）
 */
export async function validateFileForPush(
    filePath: string,
    fileName: string,
): Promise<BatchPreValidateFileResult> {
    const fileType = detectFileType(filePath);
    const targetType = resolveTargetType(filePath);
    if (!fileType || !targetType) {
        return { filePath, fileName, failures: [], hasError: false, hasOnlyWarn: false, skipped: true, skipReason: 'unsupportedType' };
    }

    let source: ValidationSource;
    try {
        source = await loadValidationSource(filePath, fileType);
    } catch (err: any) {
        return {
            filePath, fileName, failures: [], hasError: false, hasOnlyWarn: false,
            skipped: true, skipReason: `parseError:${err?.message || err}`,
        };
    }
    const { parsed, parsedHeaders, parsedSourceData, sourceRows } = source;

    // §2.3.5 · 结构性检查（缺列）—— 与 stepPreValidate / editValidationHandler 完全一致
    let fileLevelFailures: PushFailureItem[] = [];
    if (parsedHeaders !== undefined || parsedSourceData !== undefined) {
        const missingResult = detectMissingColumns(fileType, parsedHeaders, parsedSourceData);
        if (!missingResult.ok && missingResult.missing.length > 0) {
            fileLevelFailures = missingResult.missing.map(hit => {
                const reason = buildMissingColumnReason(hit, fileType);
                return {
                    tsId: FILE_LEVEL_TSID,
                    reason,
                    category: classifyFailure({ reason, validatorKind: 'missingColumn' }),
                    severity: hit.severity,
                } as PushFailureItem;
            });
        }
    }

    // 行级校验 + 文件级 / 路径校验结果统一归入 kind，由 PRE_VALIDATE_KIND_ORDER 排序
    const { failuresByKind } = runValidators(sourceRows, i => i + 1);
    if (fileLevelFailures.length > 0) failuresByKind['missingColumn'] = fileLevelFailures;

    // 案例路径合法性校验：只判定非空 path，接口异常时跳过
    let pathFailures: PushFailureItem[] = [];
    try {
        pathFailures = await collectPathFailuresForFile(filePath, sourceRows, i => i + 1);
    } catch (e: any) {
        console.warn('[批量前置校验] 案例路径校验异常，跳过:', e?.message || e);
    }
    failuresByKind['pathInvalid'] = pathFailures;

    const failures: PushFailureItem[] = flattenFailuresByKind(failuresByKind);

    const hasError = failures.some(f => f.severity !== 'warn');
    const hasOnlyWarn = !hasError && failures.length > 0;
    return { filePath, fileName, failures, hasError, hasOnlyWarn };
}
