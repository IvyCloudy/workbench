import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { FileTypeChecker } from '../providers/UnifiedEditorProvider';
import { parseFileToRows } from '../parsers';
import { showPushErrorModal, showModal, showPushResult } from '../utils/message';
import { createPushProgress, PushFileResult } from '../utils/pushUI';
import { TelemetryService } from '../utils/telemetry';
import { runPush, buildRowIndexMappings, buildFailDimensions, PushFailureItem } from './pushCore';
import { validateYamlContent, publishYamlDiagnostics } from '../utils/yamlValidator';
import { YAML_CMD_FIX_ALL } from '../utils/yamlConstants';
import {
    classifyFailure,
    failureFieldOf,
} from '../utils/pushFailureCategory';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

/** 支持的推送文件扩展名 */
const PUSH_EXTENSIONS = new Set(['.csv', '.yaml', '.yml', '.json']);

// ============================================
// 工具函数
// ============================================

/**
 * 递归扫描目录，收集所有可推送的测试案例文件。
 */
async function collectPushableFiles(dirOrFiles: vscode.Uri[]): Promise<{ uri: vscode.Uri; relativePath: string }[]> {
    const result: { uri: vscode.Uri; relativePath: string }[] = [];
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    for (const target of dirOrFiles) {
        const stats = await fs.promises.stat(target.fsPath);
        if (stats.isDirectory()) {
            const entries = await fs.promises.readdir(target.fsPath, { withFileTypes: true });
            // 按 VSCode 资源管理器相同的自然排序：不区分大小写 + 数字智能排序
            entries.sort((a, b) =>
                a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            );
            for (const entry of entries) {
                if (entry.isFile() && PUSH_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                    const fullPath = path.join(target.fsPath, entry.name);
                    result.push({
                        uri: vscode.Uri.file(fullPath),
                        relativePath: workspaceRoot ? path.relative(workspaceRoot, fullPath) : entry.name,
                    });
                } else if (entry.isDirectory()) {
                    const subDirUri = vscode.Uri.file(path.join(target.fsPath, entry.name));
                    const subFiles = await collectPushableFiles([subDirUri]);
                    result.push(...subFiles);
                }
            }
        } else if (stats.isFile() && PUSH_EXTENSIONS.has(path.extname(target.fsPath).toLowerCase())) {
            const filePath = target.fsPath;
            result.push({
                uri: target,
                relativePath: workspaceRoot ? path.relative(workspaceRoot, filePath) : path.basename(filePath),
            });
        }
    }
    return result;
}

/**
 * 确保指定文件以 testcase 编辑器打开，返回其 webview panel。
 * - 已打开：调用 reveal() 切到该 tab。
 * - 未打开：openWith 拉起 testcase 编辑器，并等待 webview ready（收到 init 后）。
 */
async function ensureOpenedInTestcaseEditor(uri: vscode.Uri): Promise<vscode.WebviewPanel | undefined> {
    const filePath = uri.fsPath;
    const existing = BaseEditorProvider.getPanel(filePath);
    if (existing) {
        try { existing.reveal(existing.viewColumn, false); } catch (_) { /* ignore */ }
        try { await BaseEditorProvider.waitReady(filePath, 3000); } catch (_) { /* ignore */ }
        return existing;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, TESTCASE_EDITOR_VIEWTYPE);
    try {
        await BaseEditorProvider.waitReady(filePath, 8000);
    } catch (e: any) {
        console.warn('[推送] 等待 webview 就绪超时:', e?.message || e);
    }
    return BaseEditorProvider.getPanel(filePath);
}

/**
 * 校验单个 YAML 文件语法，返回错误信息；无错误时返回 null。
 */
function validateYamlSyntax(filePath: string, uri: vscode.Uri): string | null {
    let yamlText = '';
    try {
        const openedDoc = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === filePath || d.uri.toString() === uri.toString(),
        );
        yamlText = openedDoc ? openedDoc.getText() : fs.readFileSync(filePath, 'utf-8');
    } catch (readErr: any) {
        console.warn('[推送] YAML 校验读文件失败:', readErr?.message || readErr);
        return null;
    }
    if (!yamlText) return null;
    try {
        const issues = validateYamlContent(yamlText);
        publishYamlDiagnostics(uri, issues);
        const errIssues = issues.filter((iss) => iss.severity === 'error').sort((a, b) => a.line - b.line);
        if (errIssues.length === 0) return null;
        const first = errIssues[0];
        const errSummary = first.message
            .replace(/^YAML (解析|格式)错误 \(第 \d+ 行\): /, '')
            .split('\n')[0]
            .slice(0, 240);
        const countHint = errIssues.length > 1 ? `，共 ${errIssues.length} 处错误` : '';
        return `YAML 语法错误（首条：第 ${first.line} 行${countHint}）\n错误摘要：${errSummary}`;
    } catch (vErr: any) {
        console.warn('[推送] YAML 校验器异常:', vErr?.message || vErr);
        return `YAML 校验器异常：${vErr?.message || vErr}`;
    }
}

/**
 * 批量推送中推送单个文件（无 UI 反馈，仅返回结果对象）。
 * 所有异常在内部捕获并转换为结果对象中的 error 字段。
 */
async function pushSingleFile(
    context: vscode.ExtensionContext,
    fileUri: vscode.Uri,
    relativePath: string,
): Promise<PushFileResult> {
    const filePath = fileUri.fsPath;

    // 检查是否在合规目录
    const fileCheck = FileTypeChecker.isQualifiedFile(fileUri);
    if (!fileCheck.qualified) {
        const reason = '文件不在合规目录下（测试任务/<任务文件夹>/测试案例/）';
        const failure: PushFailureItem = {
            tsId: '',
            reason,
            category: classifyFailure({ reason }),
            field: failureFieldOf({ reason }),
        };
        return { filePath, fileName: relativePath, successCount: 0, failCount: 1, total: 1, failures: [failure], error: reason };
    }

    // YAML 前置校验
    if (/\.ya?ml$/i.test(filePath)) {
        const yamlErr = validateYamlSyntax(filePath, fileUri);
        if (yamlErr) {
            // 构造一条带分类的失败项，使批量埋点 failCategoryBreakdown 能聚合到 yamlSyntax，
            // 不再因走 error 字符串分支而漏统计（单文件场景仍由 handleFilePush 的
            // explorerPush.aborted{yamlSyntaxError} 单独埋点）。
            const yamlFailure: PushFailureItem = {
                tsId: '',
                reason: yamlErr,
                category: classifyFailure({ reason: yamlErr }),
                field: failureFieldOf({ reason: yamlErr }),
            };
            return { filePath, fileName: relativePath, successCount: 0, failCount: 1, total: 1, failures: [yamlFailure], error: yamlErr };
        }
    }

    // 解析文件
    let rows: any[] | null = null;
    try {
        rows = await parseFileToRows(filePath);
    } catch (err: any) {
        const reason = `文件解析失败: ${err.message || err}`;
        const failure: PushFailureItem = {
            tsId: '',
            reason,
            category: classifyFailure({ reason }),
            field: failureFieldOf({ reason }),
        };
        return { filePath, fileName: relativePath, successCount: 0, failCount: 1, total: 1, failures: [failure], error: reason };
    }
    if (!rows || rows.length === 0) {
        const reason = '文件无有效数据';
        const failure: PushFailureItem = {
            tsId: '',
            reason,
            category: classifyFailure({ reason }),
            field: failureFieldOf({ reason }),
        };
        return { filePath, fileName: relativePath, successCount: 0, failCount: 1, total: 1, failures: [failure], error: reason };
    }

    const { rowIndexMap, pushIndexToRow } = buildRowIndexMappings(rows);

    // 收集结果
    let finalResult: { successCount: number; failures: PushFailureItem[]; total: number; skipped?: number } | null = null;
    let pushError: string | null = null;
    let resolved = false;

    try {
        await runPush({
            extensionContext: context,
            filePath,
            rows,
            resolveRowIndex: (i: number) => i + 1,
            frontRowIndexMap: rowIndexMap,
            frontPushIndexToRow: pushIndexToRow,
            telemetryPrefix: 'explorerPush',
            // 批量推送：逐文件结果由本函数的 explorerPush.batch.fileResult +
            // 批次 explorerPush.batch.done 统一上报，跳过 runPush 自身的 .complete 避免重复计数。
            skipCompleteTelemetry: true,
            hooks: {
                markSelfSave: () => BaseEditorProvider.markPanelSelfSave(filePath),
                // 批量推送不在此处逐文件刷新 webview（避免循环期间多次全量渲染抖动），
                // 由 handleFilePush 在批次结束后统一遍历 results 对"已打开的面板"调用 postExplorerPushRefresh。
                afterWriteBack: async ({ hasFailure }) => { /* 批量推送不做单文件刷新，见 handleFilePush 批次末尾 */ },
                onAllFailedSnapshot: async () => { /* 批量推送不做单文件刷新，见 handleFilePush 批次末尾 */ },
                onUnbound: () => {
                    // 未绑定任务 → taskNotFound 分类，纳入统计
                    const reason = '未绑定任务，无法推送';
                    finalResult = { successCount: 0, failures: [{ tsId: '', reason, category: classifyFailure({ reason }), field: failureFieldOf({ reason }) }], total: rows.length, skipped: 0 };
                    resolved = true;
                },
                onNoData: () => {
                    // 文件无数据 → emptyFile 分类，纳入统计
                    const reason = '文件无数据';
                    finalResult = { successCount: 0, failures: [{ tsId: '', reason, category: classifyFailure({ reason }), field: failureFieldOf({ reason }) }], total: rows.length, skipped: 0 };
                    resolved = true;
                },
                onPlaceholderTestcaseId: (_f) => { /* 已废弃：runPush 不再调用此钩子，失败信息统一在 onComplete 中输出 */ },
                onEmptyTestcaseId: (_f) => { /* 已废弃：同 onPlaceholderTestcaseId */ },
                onOnlySampleRows: (failures) => {
                    // 全样例数据：构造带 sample 分类的 finalResult（而非 error 字符串），
                    // 使批量埋点 failCategoryBreakdown 能聚合到 sample，不再漏统计。
                    finalResult = { successCount: 0, failures, total: rows.length, skipped: 0 };
                    resolved = true;
                },
                onTaskInfoFailed: (errorMsg) => {
                    // 任务信息获取失败 → 通常网络/权限问题，归 network 或 auth
                    const reason = `任务信息获取失败: ${errorMsg}`;
                    finalResult = { successCount: 0, failures: [{ tsId: '', reason, category: classifyFailure({ reason }), field: failureFieldOf({ reason }) }], total: rows.length, skipped: 0 };
                    resolved = true;
                },
                onBackendError: (errorMsg) => {
                    // 后端返回失败 → 文本归类（bizReject/serverError 等）
                    const reason = `后端返回失败: ${errorMsg}`;
                    finalResult = { successCount: 0, failures: [{ tsId: '', reason, category: classifyFailure({ reason }), field: failureFieldOf({ reason }) }], total: rows.length, skipped: 0 };
                    resolved = true;
                },
                onUnexpectedError: (errorMsg) => {
                    // 意外错误 → unknown 兜底（但带 reason 便于回流补充规则）
                    const reason = errorMsg;
                    finalResult = { successCount: 0, failures: [{ tsId: '', reason, category: classifyFailure({ reason }), field: failureFieldOf({ reason }) }], total: rows.length, skipped: 0 };
                    resolved = true;
                },
                onWriteBackFailed: (errorMsg) => {
                    // 后端已成功但编号回写失败：保留 onComplete 的成功结果，追加一条带分类的回写失败项。
                    const reason = `案例编号回写失败: ${errorMsg}`;
                    const wbFailure: PushFailureItem = { tsId: '', reason, category: classifyFailure({ reason }), field: failureFieldOf({ reason }) };
                    const base = finalResult || { successCount: 0, failures: [], total: rows.length, skipped: 0 };
                    finalResult = {
                        successCount: base.successCount,
                        failures: [...(base.failures || []), wbFailure],
                        total: base.total,
                        skipped: base.skipped ?? 0,
                    };
                    resolved = true;
                },
                onComplete: (payload) => {
                    finalResult = payload;
                    resolved = true;
                },
            },
        });
    } catch (err: any) {
        pushError = `推送流程异常: ${err.message || err}`;
        resolved = true;
    }

    if (!resolved) {
        pushError = '推送未能完成（回调未触发）';
    }

    if (pushError) {
        return {
            filePath,
            fileName: relativePath,
            successCount: 0,
            failCount: 0,
            total: rows.length,
            failures: [],
            error: pushError,
            // 整文件异常：reason 维度对齐 .aborted 的 reason，供批量下钻分析
            reason: pushError,
        };
    }

    const result = finalResult!;
    return {
        filePath,
        fileName: relativePath,
        successCount: result.successCount,
        failCount: result.failures.length,
        total: result.total,
        failures: result.failures,
        skipped: result.skipped ?? 0,
        // 透传 runPush 回传的链路字段，使 batch.fileResult 与单文件 .complete 格式对齐
        preValidationFailCount: result.preValidationFailCount,
        traceId: result.traceId,
        costMs: result.costMs,
    };
}

// ============================================
// 主入口
// ============================================

/**
 * 资源管理器右键「推送测试案例」入口（支持单文件 / 多文件 / 文件夹）。
 *
 * 单文件：复用编辑器内推送完整流程（打开编辑器 → runPush → 内嵌弹窗展示结果）。
 * 多文件：批量推送模式（自定义进度面板 + 总结弹窗）。
 */
export async function handleFilePush(targets: vscode.Uri[], context: vscode.ExtensionContext): Promise<void> {
    if (!targets || targets.length === 0) return;

    // 调度层链路追踪：一次用户操作的统一 traceId + 起始时刻，
    // 使 handleFilePush 内的 .aborted 与 runPush 内的 .aborted / .complete 字段口径对齐（traceId / costMs / ext）。
    const batchTraceId = Math.random().toString(36).slice(2, 10);
    const batchStart = Date.now();

    // ─── 阶段 1：收集可推送文件 ─────────────────────────────────────────────
    const files = await collectPushableFiles(targets);
    if (files.length === 0) {
        TelemetryService.sendTelemetryEvent('explorerPush.aborted', {
            reason: 'noFiles', ext: '', traceId: batchTraceId, costMs: String(Date.now() - batchStart),
        });
        showModal('default', 'warning', '无可推送文件',
            '所选目录或文件中未找到可推送的测试案例文件（.csv / .yaml / .yml / .json）。\n\n请确认文件位于 测试任务/<任务文件夹>/测试案例/ 目录下。');
        return;
    }

    TelemetryService.sendTelemetryEvent('explorerPush.start', {
        fileCount: String(files.length),
        isMulti: String(files.length > 1),
    });

    const totalFiles = files.length;

    // ====================================================================
    //  单文件推送 — 与原「编辑器内推送」完全一致
    // ====================================================================
    if (totalFiles === 1) {
        const target = files[0].uri;
        const filePath = target.fsPath;
        const baseName = path.basename(filePath);

        // 先确保 webview 已打开，以便校验错误也能在页面居中弹窗展示
        let panel: vscode.WebviewPanel | undefined;
        try {
            panel = await ensureOpenedInTestcaseEditor(target);
        } catch (_) {
            // webview 打开失败，继续走校验兜底
        }

        const fileCheck = FileTypeChecker.isQualifiedFile(target);
        if (!fileCheck.qualified) {
            TelemetryService.sendTelemetryEvent('explorerPush.aborted', {
                reason: 'dirNotQualified', ext: '', traceId: batchTraceId, costMs: String(Date.now() - batchStart),
            });
            showPushErrorModal(panel, baseName, `文件不在合规目录下\n\n请将文件放入 测试任务/<任务文件夹>/测试案例/ 目录结构中。\n当前文件：${baseName}`);
            return;
        }

        // ─── YAML 格式校验前置拦截 ─────────────────────────────────────────────
        if (/\.ya?ml$/i.test(filePath)) {
            let yamlText = '';
            try {
                const openedDoc = vscode.workspace.textDocuments.find(
                    (d) => d.uri.fsPath === filePath || d.uri.toString() === target.toString(),
                );
                yamlText = openedDoc ? openedDoc.getText() : fs.readFileSync(filePath, 'utf-8');
            } catch (readErr: any) {
                console.warn('[推送] YAML 校验读文件失败:', readErr?.message || readErr);
            }
            if (yamlText) {
                try {
                    const issues = validateYamlContent(yamlText);
                    publishYamlDiagnostics(target, issues);
                    const errIssues = issues
                        .filter((iss) => iss.severity === 'error')
                        .sort((a, b) => a.line - b.line);
                    if (errIssues.length > 0) {
                        const first = errIssues[0];
                        const errSummary = first.message
                            .replace(/^YAML (解析|格式)错误 \(第 \d+ 行\): /, '')
                            .split('\n')[0]
                            .slice(0, 240);
                        const countHint = errIssues.length > 1 ? `，共 ${errIssues.length} 处错误` : '';
                        const yamlFailures: PushFailureItem[] = errIssues.map((iss) => ({
                            reason: `YAML 语法错误（第 ${iss.line} 行）`,
                            category: classifyFailure({ reason: `YAML 语法错误（第 ${iss.line} 行）` }),
                        }));
                        TelemetryService.sendTelemetryEvent('explorerPush.aborted', {
                            reason: 'yamlSyntaxError',
                            ext: 'yaml',
                            errorLine: String(first.line),
                            traceId: batchTraceId,
                            costMs: String(Date.now() - batchStart),
                            ...buildFailDimensions(yamlFailures),
                        });
                        vscode.window.showWarningMessage(
                            `${baseName} 存在 YAML 语法错误（首条：第 ${first.line} 行${countHint}），已终止推送。错误摘要：${errSummary}`,
                            'YAML 修复全部',
                            '查看问题面板',
                        ).then((choice) => {
                            if (choice === 'YAML 修复全部') {
                                vscode.commands.executeCommand(YAML_CMD_FIX_ALL, target);
                            } else if (choice === '查看问题面板') {
                                vscode.commands.executeCommand('workbench.actions.view.problems');
                            }
                        });
                        showPushErrorModal(panel, baseName,
                            `YAML 文件存在语法错误，已终止推送。\n\n首条错误（第 ${first.line} 行${countHint}）：\n${errSummary}\n\n请修复语法后再次推送。可通过命令面板「YAML 修复全部」或 Problems 面板定位问题。`);
                        return;
                    }
                } catch (vErr: any) {
                    console.warn('[推送] YAML 校验器异常:', vErr?.message || vErr);
                    const crashMsg = vErr?.message || 'YAML 校验器异常';
                    TelemetryService.sendTelemetryEvent('explorerPush.aborted', {
                        reason: 'yamlValidatorCrash',
                        ext: 'yaml',
                        traceId: batchTraceId,
                        costMs: String(Date.now() - batchStart),
                        ...buildFailDimensions([{ reason: crashMsg, category: classifyFailure({ reason: crashMsg }) }]),
                    });
                    showPushErrorModal(panel, baseName, `YAML 校验器异常，已终止推送。\n\n请手动检查文件语法后重试。\n错误信息：${vErr?.message || vErr}`);
                    return;
                }
            }
        }

        // 解析文件
        let rows: any[] | null = null;
        try {
            rows = await parseFileToRows(filePath);
        } catch (err: any) {
            TelemetryService.sendTelemetryEvent('explorerPush.aborted', {
                reason: 'parseError', ext: path.extname(filePath).toLowerCase(),
                traceId: batchTraceId, costMs: String(Date.now() - batchStart),
            });
            showPushErrorModal(panel, baseName, `文件解析失败\n\n${baseName} 无法解析为有效的测试案例数据。\n错误信息：${err.message || err}`);
            return;
        }
        if (!rows || rows.length === 0) {
            TelemetryService.sendTelemetryEvent('explorerPush.aborted', {
                reason: 'emptyFile', ext: path.extname(filePath).toLowerCase(),
                traceId: batchTraceId, costMs: String(Date.now() - batchStart),
            });
            showPushErrorModal(panel, baseName, `文件无数据\n\n${baseName} 中未检测到有效的测试案例数据，请检查文件内容。`);
            return;
        }

        const { rowIndexMap, pushIndexToRow } = buildRowIndexMappings(rows);

        // ─── 调用公共推送核心（与编辑器内推送共用 hooks） ──────────────────────
        await runPush({
            extensionContext: context,
            filePath,
            rows,
            resolveRowIndex: (i: number) => i + 1,
            frontRowIndexMap: rowIndexMap,
            frontPushIndexToRow: pushIndexToRow,
            telemetryPrefix: 'explorerPush',
            hooks: {
                markSelfSave: () => BaseEditorProvider.markPanelSelfSave(filePath),
                afterWriteBack: async ({ hasFailure }) => {
                    await BaseEditorProvider.postExplorerPushRefresh(filePath, hasFailure);
                },
                onAllFailedSnapshot: async () => {
                    await BaseEditorProvider.postExplorerPushRefresh(filePath, true);
                },
                onUnbound: () => {
                    showPushErrorModal(panel, baseName, '未绑定任务，无法推送。请在测试任务插件绑定后再试。');
                },
                onNoData: () => {
                    showPushErrorModal(panel, baseName, `文件无数据\n\n${baseName} 中未检测到有效的测试案例数据，请检查文件内容。`);
                },
                onPlaceholderTestcaseId: (failures) => {
                    showPushResult(panel, baseName, 0, failures, failures.length);
                },
                onEmptyTestcaseId: (failures) => {
                    showPushResult(panel, baseName, 0, failures, failures.length);
                },
                onOnlySampleRows: (failures) => {
                    showPushResult(panel, baseName, 0, failures, failures.length);
                },
                onTaskInfoFailed: (errorMsg) => {
                    showPushErrorModal(panel, baseName, errorMsg);
                },
                onBackendError: (errorMsg) => {
                    showPushErrorModal(panel, baseName, `后端返回失败: ${errorMsg}`);
                },
                onUnexpectedError: (errorMsg) => {
                    showPushErrorModal(panel, baseName, errorMsg);
                },
                onWriteBackFailed: (errorMsg) => {
                    showModal(panel, 'warning', '案例编号回写失败',
                        `${baseName}\n\n后端推送已成功，但案例编号未能写回本地文件。请稍后手动刷新或重新打开文件。\n\n错误信息：${errorMsg}`);
                },
                onComplete: ({ successCount, failures, total, skipped }) => {
                    showPushResult(panel, baseName, successCount, failures, total, undefined, skipped ?? 0);
                    if (!panel) {
                        TelemetryService.sendTelemetryEvent('explorerPush.noPanelFallback', {
                            totalRows: String(successCount + failures.length),
                            successRows: String(successCount),
                            failedRows: String(failures.length),
                            ext: path.extname(filePath).toLowerCase(),
                        });
                    }
                },
            },
        });
        return;
    }

    // ====================================================================
    //  多文件推送 — 自定义进度面板 + 总结弹窗
    // ====================================================================
    const batchStartTs = Date.now();
    const results: PushFileResult[] = [];
    const progressPanel = createPushProgress(totalFiles);

    // 批次启动埋点：文件类型分布
    const extCount: Record<string, number> = {};
    for (const f of files) {
        const ext = path.extname(f.uri.fsPath).toLowerCase().slice(1) || 'unknown';
        extCount[ext] = (extCount[ext] || 0) + 1;
    }
    const extBreakdown = Object.entries(extCount)
        .map(([ext, count]) => `${ext}:${count}`)
        .join(',');
    TelemetryService.sendTelemetryEvent('explorerPush.batch.start', {
        fileCount: String(totalFiles),
        extBreakdown,
    });

    let cancelled = false;
    for (let i = 0; i < files.length; i++) {
        progressPanel.update({
            fileName: files[i].relativePath,
            status: 'pushing',
            text: '推送中...',
        });

        if (progressPanel.cancelled) {
            cancelled = true;
            break;
        }

        const result = await pushSingleFile(context, files[i].uri, files[i].relativePath);
        results.push(result);

        const fileExt = path.extname(files[i].uri.fsPath).toLowerCase();
        const statusText = result.error
            ? `错误: ${result.error.slice(0, 120)}${result.error.length > 120 ? '…' : ''}`
            : `成功 ${result.successCount} / 失败 ${result.failCount} / 共 ${result.total} 条`;

        let status: 'done' | 'error' | 'warning' = 'done';
        let pushResult: 'allSuccess' | 'allFail' | 'partial' = 'allSuccess';
        if (result.error) {
            status = 'error';
            pushResult = 'allFail';
        } else if (result.failCount > 0) {
            status = 'warning';
            pushResult = result.successCount > 0 ? 'partial' : 'allFail';
        }

        // 每文件结果埋点：字段命名与单文件 `${prefix}.complete` 对齐，便于后台统一聚合。
        //   - pushResult 取代原 resultType（allSuccess/allFail/partial，与 .complete 同口径）
        //   - 新增 preValidationFailedRows（区分预校验拦截 vs 接口实推失败）
        //   - 新增 traceId / costMs（逐文件链路追踪与耗时，原 .complete 自带、批量此前缺失）
        //   - 整文件 error 时带 reason（对齐 .aborted 的 reason 维度，原批量丢失）
        TelemetryService.sendTelemetryEvent('explorerPush.batch.fileResult', {
            ext: fileExt,
            pushResult,
            successRows: String(result.successCount),
            failedRows: String(result.failCount),
            totalRows: String(result.total),
            preValidationFailedRows: String(result.preValidationFailCount ?? 0),
            traceId: result.traceId ?? '',
            costMs: String(result.costMs ?? 0),
            ...(result.reason ? { reason: result.reason } : {}),
            ...buildFailDimensions(result.failures || []),
        });

        progressPanel.update({
            fileName: files[i].relativePath,
            status,
            text: statusText,
        });

        if (progressPanel.cancelled) {
            cancelled = true;
            break;
        }
    }

    // 批次取消埋点
    if (cancelled) {
        const completedCount = results.length;
        TelemetryService.sendTelemetryEvent('explorerPush.batch.cancelled', {
            fileCount: String(totalFiles),
            completed: String(completedCount),
            remaining: String(totalFiles - completedCount),
            durationMs: String(Date.now() - batchStartTs),
        });
    }

    // ─── 批次结束后统一刷新已打开的 webview 面板 ────────────────────────────
    // 说明：pushSingleFile 内部的 afterWriteBack / onAllFailedSnapshot 为空，
    //      避免在循环中每文件都触发 webview 全量刷新造成性能抖动。
    //      这里在批次结束后集中处理，仅对"当前已打开"的面板执行一次刷新，
    //      使前端 mods / _addedRowSet / _highlightedCells / _pushFailedTsIds
    //      与磁盘/持久化状态对齐（符合《高亮逻辑说明.md》9 类高亮规则）。
    //      未打开的文件无需刷新——其失败态由 pushFailureStore.json 持久化，
    //      用户点总结页打开时经由 init 流程自动恢复。
    let refreshedPanelCount = 0;
    for (const result of results) {
        try {
            if (!BaseEditorProvider.getPanel(result.filePath)) {
                continue; // 面板未打开，跳过
            }
            const hasFailure = !!result.error || result.failCount > 0;
            await BaseEditorProvider.postExplorerPushRefresh(result.filePath, hasFailure);
            refreshedPanelCount++;
        } catch (err: any) {
            console.warn('[推送] 批次结束刷新面板失败:', result.filePath, err?.message || err);
        }
    }
    if (refreshedPanelCount > 0) {
        TelemetryService.sendTelemetryEvent('explorerPush.batch.postRefresh', {
            refreshed: String(refreshedPanelCount),
            total: String(results.length),
        });
    }

    // ─── 汇总埋点（含耗时、文件类型分布、取消状态）────────────────────────────
    // 必须在「展示总结视图」之前发出：progressPanel.done() 内部会 await 面板被用户关闭
    // 才 resolve（见 pushUI.ts），若先 await 它，函数会挂起直到用户手动关面板，
    // 导致 batch.done 汇总事件迟迟不发、丢失「每天批量推送成功/失败总数」统计。
    // 这里 try/catch 兜底：无论刷新/展示逻辑是否异常，汇总事件都必须发出。
    try {
        const totalSucc = results.reduce((s, r) => s + r.successCount, 0);
        const totalFail = results.reduce((s, r) => s + r.failCount, 0);
        const errorFiles = results.filter(r => r.error).length;
        const resultExtBreakdown = (() => {
            const map: Record<string, number> = {};
            for (const r of results) {
                const ext = path.extname(r.filePath).toLowerCase().slice(1) || 'unknown';
                map[ext] = (map[ext] || 0) + 1;
            }
            return Object.entries(map).map(([ext, count]) => `${ext}:${count}`).join(',');
        })();
        // 批量失败分类聚合：合并所有文件的 failures（每项已是 PushFailureItem，含 category/field），
        // 使 batch.done 也能按错误类型/字段下钻分析（与单文件 .complete 同维度）。
        // 失败维度（分类/字段/分层/原文样本）统一由 buildFailDimensions 产出，消除重复拼装。
        const batchFailItems = results.flatMap(r => r.failures || []);
            TelemetryService.sendTelemetryEvent('explorerPush.batch.done', {
                fileCount: String(totalFiles),
                totalRows: String(totalSucc + totalFail),
                successRows: String(totalSucc),
                failedRows: String(totalFail),
                errorFiles: String(errorFiles),
                cancelled: cancelled ? '1' : '0',
                durationMs: String(Date.now() - batchStartTs),
                extBreakdown: resultExtBreakdown,
                ...buildFailDimensions(batchFailItems),
            });
    } catch (summaryErr: any) {
        // 兜底：即使主汇总计算/发送异常，results 中已完成的逐文件结果仍有效，
        // 必须基于 results 重新安全累加真实的部分成功/失败数，绝不能清零，
        // 否则会丢失「分批次已成功推送」的统计数据。带 summaryError 标记便于监控识别。
        try {
            const safeNum = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
            const partSucc = results.reduce((s, r) => s + safeNum(r?.successCount), 0);
            const partFail = results.reduce((s, r) => s + safeNum(r?.failCount), 0);
            const partErrFiles = results.reduce((s, r) => s + (r?.error ? 1 : 0), 0);
            const partExtBreakdown = (() => {
                const map: Record<string, number> = {};
                for (const r of results) {
                    if (!r || !r.filePath) continue;
                    const ext = path.extname(r.filePath).toLowerCase().slice(1) || 'unknown';
                    map[ext] = (map[ext] || 0) + 1;
                }
                return Object.entries(map).map(([ext, count]) => `${ext}:${count}`).join(',');
            })();
            TelemetryService.sendTelemetryEvent('explorerPush.batch.done', {
                fileCount: String(totalFiles),
                totalRows: String(partSucc + partFail),
                successRows: String(partSucc),
                failedRows: String(partFail),
                errorFiles: String(partErrFiles),
                cancelled: cancelled ? '1' : '0',
                durationMs: String(Date.now() - batchStartTs),
                extBreakdown: partExtBreakdown,
                summaryError: '1',
            });
        } catch { /* 上报通道本身不可用则放弃，避免二次异常 */ }
        console.error('[推送][批量] 汇总埋点异常，已兜底上报真实部分数据:', summaryErr?.message || summaryErr);
    }

    // 汇总埋点已发出，下面仅负责展示总结视图（不 await：done() 会等用户关闭面板才 resolve，
    // 不能让它阻塞主流程，否则埋点要等用户手动关面板才"算完成"）。点击文件回调内展示结果弹窗。
    void progressPanel.done(results, async (result) => {
        const uri = vscode.Uri.file(result.filePath);
        const fileExt = path.extname(result.filePath).toLowerCase();
        // 总结面板点击文件埋点
        TelemetryService.sendTelemetryEvent('explorerPush.batch.openFile', {
            ext: fileExt,
            hasError: result.error ? '1' : '0',
        });
        const panel = await ensureOpenedInTestcaseEditor(uri);
        // 等待 webview 前端消息监听器就绪（waitReady 仅保证扩展端就绪）
        await new Promise(resolve => setTimeout(resolve, 400));
        if (result.error) {
            showPushResult(panel, result.fileName, 0, [], result.total, result.error, result.skipped ?? 0);
        } else {
            showPushResult(panel, result.fileName, result.successCount, result.failures, result.total, undefined, result.skipped ?? 0);
        }
    });
}
