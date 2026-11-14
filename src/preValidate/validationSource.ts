/**
 * ============================================================================
 *  preValidate/validationSource.ts
 *  前置校验共用：合规目录/类型判定、一次性 parse + 行数据组装、文件级分组键
 * ----------------------------------------------------------------------------
 *  打开 / 编辑期（editValidationHandler）、批量前置（batchPreValidate）、
 *  单文件推送前置（stepPreValidate）共用，避免三处各写一份导致口径漂移。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { createParser, type FileType } from '../parsers';
import { FILE_PATTERNS, isInQualifiedDir } from '../services/utils';
import { buildCsvRowLikes } from './csvRowAdapter';
import type { RowLike } from '../handlers/pushCore.types';

/** 文件级 / 接口不可用伪分组键统一由 utils/failureTsIds 定义，此处 re-export 保持既有引入路径 */
export { FILE_LEVEL_TSID } from '../utils/failureTsIds';

/**
 * 识别目标文件类型 + 合规目录：不合规的文件不参与校验。
 *   · .yaml / .yml → 'yaml'；.csv → 'csv'；.json → 'json'
 *   · 三类均要求位于「测试任务/<任务>/测试案例/」合规目录内。
 *
 * 口径对齐（2026-10-07 修复）：isInQualifiedDir 要求 parts[0]==='测试任务'，
 * 必须传「相对工作区根」的路径而非绝对路径；与 FileTypeChecker.isQualifiedFile
 * 共用同一套 asRelativePath(filePath, false) 转换，保证打开 / 编辑 / 推送前全链路一致。
 */
export function resolveTargetType(filePath: string): FileType | null {
    const lower = filePath.toLowerCase();
    const relPath = vscode.workspace.asRelativePath(filePath, false);
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        return isInQualifiedDir(relPath, FILE_PATTERNS.YAML) ? 'yaml' : null;
    }
    if (lower.endsWith('.csv')) {
        return isInQualifiedDir(relPath, FILE_PATTERNS.CSV) ? 'csv' : null;
    }
    if (lower.endsWith('.json')) {
        return isInQualifiedDir(relPath, FILE_PATTERNS.JSON) ? 'json' : null;
    }
    return null;
}

/** 一次 parse 的结果：原始 parsed（供路径校验复用）+ 行级校验所需数据 */
export interface ValidationSource {
    parsed: any;
    parsedHeaders: string[] | undefined;
    parsedSourceData: any;
    sourceRows: RowLike[];
}

/**
 * parse 一次并组装行数据（CSV 走 buildCsvRowLikes，YAML/JSON 直接取 sourceData）。
 * parse 失败原样抛出：批量通路据此返回 skipped，编辑期通路降级为空清单，由调用方决定。
 */
export async function loadValidationSource(
    filePath: string,
    fileType: FileType,
): Promise<ValidationSource> {
    const parsed = await createParser(fileType).parse(filePath);
    const parsedHeaders = parsed?.tableData?.headers;
    const parsedSourceData = parsed?.sourceData;
    const src = parsed?.sourceData;

    let sourceRows: RowLike[];
    if (fileType === 'csv') {
        // CSV parser 的 sourceData 恒为 null，需从 headers + rows 组装以中文列名为 key 的对象数组
        sourceRows = buildCsvRowLikes(parsedHeaders, parsed?.tableData?.rows);
    } else if (Array.isArray(src)) {
        sourceRows = src as RowLike[];
    } else if (src && typeof src === 'object') {
        sourceRows = [src as RowLike];
    } else {
        sourceRows = [];
    }
    return { parsed, parsedHeaders, parsedSourceData, sourceRows };
}
