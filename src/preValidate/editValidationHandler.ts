/**
 * ============================================================================
 *  preValidate/editValidationHandler.ts
 *  编辑期主动校验（B3）——「打开 / 编辑」文件时立刻跑一次 pushCore 校验规则，
 *  把结果同步写到 pushFailureStore，让表格视图能实时看到红/黄高亮。
 * ----------------------------------------------------------------------------
 *  从 handlers/editValidationHandler.ts 迁移过来（2026-09-19 解耦），
 *  语义与依赖完全不变。原路径保留为 re-export barrel（@deprecated）。
 *
 *  设计原则：
 *    1. 复用推送期的 DEFAULT_VALIDATORS —— 与 stepPreValidate 使用同一套规则。
 *    2. Y 方案：编辑期校验结果就是当前唯一权威源，覆盖之前的推送失败盘。
 *    3. 防抖：yaml 500ms / csv 800ms；解析失败静默降级为空清单。
 *    4. 只对合规目录下的 yaml/csv 生效。
 *    5. 通过 BaseEditorProvider.postEditValidationRefresh 通知已打开 webview 拉新。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { runValidatorsOnRowsPure } from './validators';
import type { RowLike } from '../handlers/pushCore.types';
import { persistPushFailures, clearFailures } from '../utils/pushFailureStore';
import { detectFileType, createParser, type FileType } from '../parsers';
import { FILE_PATTERNS, isInQualifiedDir } from '../services/utils';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { TelemetryService } from '../utils/telemetry';

// ----------------------------------------------------------------------------
// 防抖配置（依 B3 需求最终定稿：yaml 500ms / csv 800ms）
// ----------------------------------------------------------------------------
const DEBOUNCE_MS_YAML = 500;
const DEBOUNCE_MS_CSV = 800;

// filePath -> 待执行的 timer；连续编辑时后一个 timer 会取消前一个
const _pendingTimers: Map<string, NodeJS.Timeout> = new Map();

// filePath -> 最近一次 validate 序列号；用于异步竞态时丢弃过期结果
const _seqMap: Map<string, number> = new Map();

/**
 * 识别目标文件类型 + 合规目录：不合规的文件不参与编辑期校验。
 */
function resolveTargetType(filePath: string): FileType | null {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        return isInQualifiedDir(filePath, FILE_PATTERNS.YAML) ? 'yaml' : null;
    }
    if (lower.endsWith('.csv')) {
        return isInQualifiedDir(filePath, FILE_PATTERNS.CSV) ? 'csv' : null;
    }
    return null;
}

/**
 * 真正的校验执行体：parse → 跑规则 → 覆盖式写盘 → 通知 webview 刷新。
 */
async function _doValidate(filePath: string): Promise<void> {
    const seq = (_seqMap.get(filePath) || 0) + 1;
    _seqMap.set(filePath, seq);

    const fileType = detectFileType(filePath);
    if (!fileType) return;

    const parser = createParser(fileType);
    let sourceRows: RowLike[] = [];
    try {
        const parsed = await parser.parse(filePath);
        const src = parsed.sourceData;
        if (Array.isArray(src)) {
            sourceRows = src as RowLike[];
        } else if (src && typeof src === 'object') {
            sourceRows = [src as RowLike];
        } else {
            sourceRows = [];
        }
    } catch (_err) {
        sourceRows = [];
    }

    // 异步竞态保护：慢 parse 已被后续 fast parse 覆盖，不再写盘
    if (_seqMap.get(filePath) !== seq) return;

    // 编辑期视图：源数据的 1-based 索引即行号（parse 后已按文件顺序）
    const failures = runValidatorsOnRowsPure(sourceRows, i => i + 1);

    try {
        if (failures.length === 0) {
            await clearFailures(filePath);
        } else {
            await persistPushFailures(
                filePath,
                sourceRows as any[],
                failures.map(f => ({
                    tsId: f.tsId,
                    reason: f.reason,
                    category: f.category,
                    field: f.field,
                    severity: f.severity,
                    // B4：透传 stepIdx/subField/hits，供前端展开态 sub-td / dv2 弹窗精确高亮。
                    stepIdx: f.stepIdx,
                    subField: f.subField,
                    hits: f.hits,
                })),
                [],
            );
        }
    } catch (err: any) {
        console.warn('[EditValidation] 持久化失败盘失败:', err?.message || err);
        return;
    }

    // 通知已打开的 webview：让它拉一次新的失败盘并重绘
    try {
        BaseEditorProvider.postEditValidationRefresh(filePath);
    } catch (_) { /* ignore */ }

    // 埋点（低频）：只在有失败时上报一次
    if (failures.length > 0) {
        const errorCount = failures.filter(f => f.severity !== 'warn').length;
        const warnCount = failures.length - errorCount;
        TelemetryService.sendTelemetryEvent('editValidation.failuresDetected', {
            fileFormat: fileType,
            errorCount: String(errorCount),
            warnCount: String(warnCount),
        });
    }
}

/**
 * 请求一次编辑期校验（外部驱动入口，含防抖）。
 */
export function requestEditValidation(filePath: string, opts?: { immediate?: boolean }): void {
    if (!filePath) return;
    const type = resolveTargetType(filePath);
    if (!type) return;

    const existing = _pendingTimers.get(filePath);
    if (existing) {
        clearTimeout(existing);
        _pendingTimers.delete(filePath);
    }

    if (opts?.immediate) {
        void _doValidate(filePath).catch(err => {
            console.warn('[EditValidation] immediate validate 异常:', err?.message || err);
        });
        return;
    }

    const debounce = type === 'yaml' ? DEBOUNCE_MS_YAML : DEBOUNCE_MS_CSV;
    const timer = setTimeout(() => {
        _pendingTimers.delete(filePath);
        void _doValidate(filePath).catch(err => {
            console.warn('[EditValidation] debounced validate 异常:', err?.message || err);
        });
    }, debounce);
    _pendingTimers.set(filePath, timer);
}

/**
 * activate 时调用：注册文档打开 / 变更 / 保存监听。
 */
export function registerEditValidation(): vscode.Disposable[] {
    const subs: vscode.Disposable[] = [];

    subs.push(vscode.workspace.onDidChangeTextDocument(e => {
        const fp = e.document?.uri?.fsPath;
        if (!fp) return;
        requestEditValidation(fp);
    }));

    subs.push(vscode.workspace.onDidSaveTextDocument(doc => {
        const fp = doc?.uri?.fsPath;
        if (!fp) return;
        requestEditValidation(fp, { immediate: true });
    }));

    subs.push(vscode.workspace.onDidOpenTextDocument(doc => {
        const fp = doc?.uri?.fsPath;
        if (!fp) return;
        requestEditValidation(fp, { immediate: true });
    }));

    return subs;
}

/**
 * BaseEditorProvider 打开 webview 时调用：确保该文件"打开即刻校验一次"。
 */
export function triggerEditValidationOnWebviewOpen(filePath: string): void {
    requestEditValidation(filePath, { immediate: true });
}
