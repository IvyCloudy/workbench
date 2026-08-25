/**
 * ============================================================================
 *  workspaceListeners.ts
 *  注册工作区文件变化监听器（重命名、删除）
 * ----------------------------------------------------------------------------
 *  案例文件删除拦截：
 *    在 onWillDeleteFiles 阶段（文件被物理删除之前）先调用线上删除接口
 *    （POST /test-task/delete-testcase），按返回 type 区分每行删除结果：
 *      - type='1'（成功）：将成功行从文件物理剔除并保存（仅失败行保留）
 *      - type='2'（失败）或未返回：该行视为"无法删除"，保留在文件中
 *    随后：
 *      - 全部成功 → 文件被正常删除
 *      - 存在失败行 → onDidDeleteFiles 阶段重建文件，仅写入失败行，
 *        实现"不删除文件、只删除文件内满足条件的案例行"。
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { isCreatedByCommand, markAsCreatedByCommand, unmarkAsCreatedByCommand } from '../utils/fileIdentifier';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { removeHighlightFile } from '../utils/highlightStore';
import { removeFailureFile } from '../utils/pushFailureStore';
import { removeSnapshotFile } from '../utils/pushSnapshotStore';
import { removeDeletedRowsFile } from '../utils/deletedRowsStore';
import { removeMarkFile } from '../utils/markStore';
import {
    renamePathInBindings,
    removePathInBindings,
} from '../utils/pointCaseBindingStore';
import { detectFileType, createParser } from '../parsers';
import { deleteTestCase } from '../services/http';
import { resolveTaskInfoOrNull } from './pushCore.stages';
import { TS_ID_COLUMN } from '../services/utils';
import { TelemetryService } from '../utils/telemetry';
import { showPushSummary } from '../utils/pushUI';
import type { PushFileResult } from '../utils/pushUI';
import type { PushFailure } from '../utils/message';

/** 若某文件的扩展名属于 point/case 绑定域，才有必要通知绑定库 */
function isBindingRelevant(fp: string): boolean {
    const ext = (fp.match(/\.[^./\\]+$/) || [''])[0].toLowerCase();
    return ['.md', '.xmind', '.csv', '.yaml', '.yml', '.json'].includes(ext);
}

/** 是否可解析为案例文件（csv / yaml / json） */
function isCaseFile(fp: string): boolean {
    return detectFileType(fp) !== null;
}

/**
 * onWillDeleteFiles 阶段的处理结果缓存，供 onDidDeleteFiles 还原 + 弹窗使用。
 *   - needRestore=true：存在线上删除失败的案例行，did 阶段需重建文件仅保留失败行
 *   - needRestore=false：全部成功或无案例行，文件可正常被删除，走原清理逻辑
 *   - total / successCount / failedIds / error：用于构造与"推送案例结果"同款的弹窗
 */
interface WillDeleteResult {
    needRestore: boolean;
    restoreTableData: any;
    restoreSourceData: any;
    fileName: string;
    total: number;
    successCount: number;
    failedIds: string[];
    /** 是否纳入弹窗汇报（无 testcase_id 或无案例行的文件不汇报） */
    reportable: boolean;
    error?: string;
}

export function registerWorkspaceListeners(context: vscode.ExtensionContext): vscode.Disposable[] {
    /** filePath → WillDeleteResult（仅案例文件在处理后写入） */
    const willDeleteResults = new Map<string, WillDeleteResult>();
    /** 本次删除操作中被拦截处理的案例文件结果（用于弹窗汇总） */
    const caseDeleteResults: PushFileResult[] = [];

    return [
        // 监听文件重命名，同步更新记录
        vscode.workspace.onDidRenameFiles((event) => {
            for (const file of event.files) {
                const oldPath = file.oldUri.fsPath;
                const newPath = file.newUri.fsPath;

                if (isCreatedByCommand(oldPath)) {
                    unmarkAsCreatedByCommand(oldPath);
                    markAsCreatedByCommand(newPath);
                }

                BaseEditorProvider.updatePanelMapKey(oldPath, newPath);

                // 同步 point ↔ case 绑定库（重命名或跨目录移动）
                if (isBindingRelevant(oldPath) || isBindingRelevant(newPath)) {
                    renamePathInBindings(oldPath, newPath)
                        .then(changed => {
                            if (changed) {
                                TelemetryService.sendTelemetryEvent('pointCaseBindings.rename.synced', {
                                    ext: (path.extname(newPath) || '').toLowerCase(),
                                });
                            }
                        })
                        .catch(err => {
                            TelemetryService.sendTelemetryErrorEvent('pointCaseBindings.rename.error', {
                                errorMessage: String(err?.message || err).slice(0, 500),
                            });
                        });
                }
            }
        }),

        // 文件删除"之前"：案例文件先调用线上删除接口，剔除成功行（失败行保留）
        vscode.workspace.onWillDeleteFiles((event) => {
            const tasks: Promise<void>[] = [];
            for (const file of event.files) {
                const fp = file.fsPath;
                if (!isCaseFile(fp)) continue;
                tasks.push(handleCaseFileWillDelete(fp, context, willDeleteResults).then(() => {
                    // 收集删除结果用于弹窗（与推送案例结果同款）
                    const r = willDeleteResults.get(fp);
                    if (r && r.reportable) {
                        caseDeleteResults.push(buildCaseDeleteFileResult(r));
                    }
                }).catch(err => {
                    // 异常时保守处理：保留文件全部行，不删除文件
                    console.error('[workspaceListeners] 案例文件删除拦截异常:', err?.message || err);
                    TelemetryService.sendTelemetryErrorEvent('caseFileDelete.intercept.error', {
                        errorMessage: String(err?.message || err).slice(0, 500),
                        filePath: path.basename(fp),
                    });
                }));
            }
            if (tasks.length > 0) {
                event.waitUntil(Promise.all(tasks).then(() => {
                    // 删除动作完成后统一弹窗反馈（仅当有案例文件被拦截处理）
                    if (caseDeleteResults.length > 0) {
                        showPushSummary(caseDeleteResults.slice());
                    }
                }));
            }
        }),

        // 监听文件删除，同步清理所有本地缓存记录
        vscode.workspace.onDidDeleteFiles((event) => {
            for (const file of event.files) {
                const fp = file.fsPath;
                if (isCreatedByCommand(fp)) {
                    unmarkAsCreatedByCommand(fp);
                }

                // 案例文件删除拦截的还原处理
                const willResult = willDeleteResults.get(fp);
                willDeleteResults.delete(fp);
                if (willResult && willResult.needRestore) {
                    // 有失败行：重建文件，仅写入失败行（即"不删除文件，只删成功行"）
                    restoreCaseFile(fp, willResult).catch(err => {
                        console.error('[workspaceListeners] 案例文件还原失败:', err?.message || err);
                        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.restore.error', {
                            errorMessage: String(err?.message || err).slice(0, 500),
                            filePath: path.basename(fp),
                        });
                    });
                    // 失败行仍在文件中，不清理 highlight/failure/snapshot/mark 之外的追踪；
                    // 这里仅清理 highlight（临时态），其余保留以便后续可重试同步删除
                    removeHighlightFile(fp).catch(() => {});
                    removeFailureFile(fp).catch(() => {});
                    continue;
                }

                // 清理各存储中该文件的缓存（原逻辑）
                removeHighlightFile(fp).catch(() => {});
                removeFailureFile(fp).catch(() => {});
                removeSnapshotFile(fp).catch(() => {});
                removeDeletedRowsFile(fp).catch(() => {});
                removeMarkFile(fp).catch(() => {});

                // 同步 point ↔ case 绑定库（删除引用）
                if (isBindingRelevant(fp)) {
                    removePathInBindings(fp)
                        .then(changed => {
                            if (changed) {
                                TelemetryService.sendTelemetryEvent('pointCaseBindings.delete.synced', {
                                    ext: (path.extname(fp) || '').toLowerCase(),
                                });
                            }
                        })
                        .catch(err => {
                            TelemetryService.sendTelemetryErrorEvent('pointCaseBindings.delete.error', {
                                errorMessage: String(err?.message || err).slice(0, 500),
                            });
                        });
                }
            }
        }),
    ];
}

/**
 * 案例文件"将删除"拦截：
 *   1. 解析文件，提取每行的 testcase_id
 *   2. 调用线上删除接口（sourceIds = testcase_id 列表）
 *   3. 按返回 type 区分成功/失败行
 *   4. 物理剔除成功行并保存（失败行保留）；记录 needRestore 供 did 阶段还原
 */
async function handleCaseFileWillDelete(
    filePath: string,
    context: vscode.ExtensionContext,
    willDeleteResults: Map<string, WillDeleteResult>,
): Promise<void> {
    const fileType = detectFileType(filePath);
    if (!fileType) return;

    const parser = createParser(fileType);
    const parsed = await parser.parse(filePath);
    const tableData = parsed.tableData;
    const sourceData = parsed.sourceData;
    const headers: string[] = tableData?.headers || [];
    const rows: any[][] = tableData?.rows || [];

    const tsIdx = headers.indexOf(TS_ID_COLUMN);
    if (tsIdx < 0 || rows.length === 0) {
        // 无 testcase_id 列或空文件：无需线上删除，允许文件被正常删除（不纳入弹窗）
        willDeleteResults.set(filePath, {
            needRestore: false,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            fileName: path.basename(filePath),
            total: 0,
            successCount: 0,
            failedIds: [],
            reportable: false,
        });
        return;
    }

    const ids = rows.map(r => (r[tsIdx] == null ? '' : String(r[tsIdx]).trim())).filter(Boolean);
    if (ids.length === 0) {
        willDeleteResults.set(filePath, {
            needRestore: false,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            fileName: path.basename(filePath),
            total: 0,
            successCount: 0,
            failedIds: [],
            reportable: false,
        });
        return;
    }

    // 调用线上删除接口前先取任务上下文
    const taskInfo = await resolveTaskInfoOrNull(filePath);
    if (taskInfo.status !== 'ok') {
        // 未绑定测试任务：无法调用线上删除，保守保留全部行（不删除文件）
        willDeleteResults.set(filePath, {
            needRestore: true,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            fileName: path.basename(filePath),
            total: ids.length,
            successCount: 0,
            failedIds: ids,
            reportable: true,
            error: taskInfo.status === 'unbound' ? '文件未绑定测试任务，无法执行线上删除' : (taskInfo.errorMessage || '获取测试任务信息失败'),
        });
        return;
    }

    const resp = await deleteTestCase(
        context,
        { testTaskNo: taskInfo.taskInfo.testTaskNo, subTestTaskId: taskInfo.taskInfo.subTestTaskId },
        ids,
    );

    if (resp.returnCode !== 'SUC0000') {
        // 接口整体失败：保守保留全部行（不删除文件）
        willDeleteResults.set(filePath, {
            needRestore: true,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            fileName: path.basename(filePath),
            total: ids.length,
            successCount: 0,
            failedIds: ids,
            reportable: true,
            error: resp.errorMsg || `接口返回 ${resp.returnCode}`,
        });
        return;
    }

    // 依据 body 中 sourceId → type 判定每行结果
    const typeBySourceId = new Map<string, string>();
    const resultBody: Array<{ sourceId?: string; type?: string }> = Array.isArray(resp.body) ? resp.body : [];
    for (const item of resultBody) {
        const sid = String(item?.sourceId ?? '').trim();
        if (sid) typeBySourceId.set(sid, String(item?.type ?? ''));
    }

    const successIdx: number[] = [];
    const failedIdx: number[] = [];
    const failedIds: string[] = [];
    for (let i = 0; i < rows.length; i++) {
        const id = (rows[i][tsIdx] == null ? '' : String(rows[i][tsIdx]).trim());
        if (!id) { failedIdx.push(i); failedIds.push(id); continue; }
        if (typeBySourceId.get(id) === '1') {
            successIdx.push(i);
        } else {
            failedIdx.push(i);
            failedIds.push(id);
        }
    }

    if (successIdx.length === 0) {
        // 全部失败：保留文件全部行，不删除文件
        willDeleteResults.set(filePath, {
            needRestore: true,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            fileName: path.basename(filePath),
            total: ids.length,
            successCount: 0,
            failedIds,
            reportable: true,
        });
        return;
    }

    // 物理剔除成功行，仅保留失败行并保存
    const keepRows = failedIdx.map(i => rows[i]);
    const keepSource = Array.isArray(sourceData)
        ? failedIdx.map(i => sourceData[i])
        : sourceData;
    tableData.rows = keepRows;
    const newTableData = tableData;
    const newSourceData = keepSource;

    await parser.save(filePath, newTableData, newSourceData);

    if (failedIdx.length === 0) {
        // 全部成功：文件将被正常删除，无需还原
        willDeleteResults.set(filePath, {
            needRestore: false,
            restoreTableData: newTableData,
            restoreSourceData: newSourceData,
            fileName: path.basename(filePath),
            total: ids.length,
            successCount: successIdx.length,
            failedIds: [],
            reportable: true,
        });
    } else {
        // 部分失败：did 阶段重建文件仅保留失败行
        willDeleteResults.set(filePath, {
            needRestore: true,
            restoreTableData: newTableData,
            restoreSourceData: newSourceData,
            fileName: path.basename(filePath),
            total: ids.length,
            successCount: successIdx.length,
            failedIds,
            reportable: true,
        });
    }

    TelemetryService.sendTelemetryEvent('caseFileDelete.intercept.done', {
        total: String(rows.length),
        success: String(successIdx.length),
        failed: String(failedIdx.length),
        filePath: path.basename(filePath),
    });
}

/**
 * 重建案例文件，仅写入失败行（即保留"无法删除"的案例）。
 * 用于 onDidDeleteFiles 阶段：文件已被 VSCode 删除后还原为"仅失败行"版本，
 * 实现"有不能删除的案例时不删除文件，只删除满足条件的案例行"。
 */
async function restoreCaseFile(filePath: string, result: WillDeleteResult): Promise<void> {
    const fileType = detectFileType(filePath);
    if (!fileType) return;
    const parser = createParser(fileType);
    // 文件已被删除，这里直接以"失败行"内容重建
    await parser.save(filePath, result.restoreTableData, result.restoreSourceData);
    TelemetryService.sendTelemetryEvent('caseFileDelete.restore.done', {
        failedRows: String(result.failedIds.length),
        filePath: path.basename(filePath),
    });
}

// ============================================================
// 结果弹窗构造（与"推送案例结果"同款）
// ============================================================

/**
 * 由 WillDeleteResult 构造 PushFileResult，供 showPushSummary 弹窗渲染。
 * 与推送案例结果弹窗保持一致的字段与展示口径：
 *   - successCount / failCount / total 统计
 *   - failures：逐条失败（testcase_id + 原因）
 *   - error：整文件级错误（未绑定任务 / 接口失败）时填充
 */
function buildCaseDeleteFileResult(result: WillDeleteResult): PushFileResult {
    const failures: PushFailure[] = result.failedIds.map(id => ({
        tsId: id,
        reason: result.error || '线上删除失败',
    }));
    return {
        filePath: '',
        fileName: result.fileName,
        successCount: result.successCount,
        failCount: failures.length,
        total: result.total,
        failures,
        error: result.error,
    };
}
