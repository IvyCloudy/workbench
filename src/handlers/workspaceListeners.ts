/**
 * ============================================================================
 *  workspaceListeners.ts
 *  注册工作区文件变化监听器（重命名、删除）
 * ----------------------------------------------------------------------------
 *  案例文件删除拦截（移植自 884a8152，保留 modal 弹窗改进）：
 *    在 onWillDeleteFiles 阶段（文件被物理删除之前）通过 event.waitUntil
 *    调用线上删除接口（复用编辑器内删除案例的同一入口 syncDeletedRows），
 *    按返回按行区分成功/失败：
 *      - 全部成功 → 让 VSCode 正常完成物理删除
 *      - 部分失败 / 全部失败 / 接口整体失败 → 记录 needRestore，在
 *        onDidDeleteFiles 阶段用 parser.save 把文件重建回来（只写失败行），
 *        实现"不删除文件、只删除文件内满足条件的案例行"
 *    弹窗使用 showDeleteResult（案例编辑器 panel 内 modal），
 *    与"案例编辑器里右键删除案例行"的反馈方式保持一致。
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
import { syncDeletedRows } from '../utils/deletedRowsStore';
import { TS_ID_COLUMN } from '../services/utils';
import { TelemetryService } from '../utils/telemetry';
import { showDeleteResult, showConfirmDialog } from '../utils/message';
import type { PushFailure } from '../utils/message';

/** 案例编辑器 viewType（保持与 BaseEditorProvider 注册值一致） */
const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

/**
 * 用户在删除前确认框中点击「取消」时抛出，外层 onWillDeleteFiles 的 .catch 会识别它，
 * 静默放弃删除（不重建文件、不报错、不弹窗），使文件保持原样。
 */
class UserCancelledDeleteError extends Error {
    constructor(public readonly filePath: string) {
        super('用户取消删除');
        this.name = 'UserCancelledDeleteError';
    }
}

/**
 * 文件删除确认的 pending 解析器表：requestId -> { resolve, timer }。
 * webview 在已打开的案例文件中弹确认框，用户点击后回传 confirmResult，
 * 由 resolveDeleteConfirm 触发对应 promise，使 onWillDeleteFiles 的 waitUntil 落地。
 */
interface PendingDeleteConfirm {
    resolve: (confirmed: boolean) => void;
    timer: NodeJS.Timeout;
}
const pendingDeleteConfirms = new Map<string, PendingDeleteConfirm>();

/** 供 editorMessageHandlers 回传 webview 内的"文件删除确认"结果 */
export function resolveDeleteConfirm(requestId: string, confirmed: boolean): void {
    const entry = pendingDeleteConfirms.get(requestId);
    if (!entry) return;
    pendingDeleteConfirms.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(confirmed);
}

/**
 * 删除案例文件前的二次确认：删除会同步删除 TMS 平台上的全部案例，必须显式确认。
 *
 * 优先在「已打开该文件的案例编辑器 webview」内弹确认框（复用 xsConfirm 的 warning 样式：
 * 浅橙头部 + 橙色"!"圆形图标 + 橙色"继续删除"按钮），不额外开新 tab；
 * 仅当该文件并未在编辑器打开时，才回退到独立 webview 模态弹窗（showConfirmDialog）。
 *
 * @returns true=继续删除，false=用户取消。
 */
async function confirmCaseFileDelete(filePath: string, caseCount: number): Promise<boolean> {
    const fileName = path.basename(filePath);
    const message =
        `谨慎操作：删除「${fileName}」将同步删除 TMS 平台上的 ${caseCount} 条案例，` +
        `此操作不可恢复。是否继续删除？`;

    const panel = BaseEditorProvider.getPanel(filePath);
    if (panel) {
        const requestId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                if (pendingDeleteConfirms.delete(requestId)) resolve(false); // 兜底：超时视为取消
            }, 60_000);
            pendingDeleteConfirms.set(requestId, { resolve, timer });
            panel.webview.postMessage({
                type: 'requestConfirm',
                requestId,
                title: '删除案例',
                message,
                confirmType: 'warning',
                okText: '继续删除',
                cancelText: '取消',
            });
        });
    }

    // 兜底：文件未在编辑器打开，用独立 webview 面板弹同款样式弹窗
    return await showConfirmDialog({
        type: 'warning',
        title: '删除案例',
        message,
        okText: '继续删除',
        cancelText: '取消',
    });
}

/** 若某文件的扩展名属于 point/case 绑定域，才有必要通知绑定库 */
function isBindingRelevant(fp: string): boolean {
    const ext = (fp.match(/\.[^./\\]+$/) || [''])[0].toLowerCase();
    return ['.md', '.xmind', '.csv', '.yaml', '.yml', '.json'].includes(ext);
}

/** 是否位于「测试任务/xxx/测试案例/」下且可解析为案例文件（csv/yaml/json） */
function isCaseFile(fp: string): boolean {
    if (!fp) return false;
    const norm = fp.replace(/\\/g, '/');
    if (!/\/测试任务\/[^/]+\/测试案例\//.test(norm)) return false;
    return detectFileType(fp) !== null;
}

/** waitUntil 超时时长：接口若卡住，不能让 VSCode 的删除确认框无限挂起 */
const DELETE_INTERCEPT_TIMEOUT_MS = 30_000;

/** willDeleteResults 条目兜底清理时长：万一 did 阶段没触发，也不至于永久驻留 */
const WILL_DELETE_ENTRY_TTL_MS = 60_000;

/**
 * onWillDeleteFiles 阶段的处理结果缓存，供 onDidDeleteFiles 还原 + 弹窗使用。
 *   - needRestore=true：存在线上删除失败的案例行，did 阶段需重建文件仅保留失败行
 *   - needRestore=false：全部成功或无案例行，文件可正常被删除
 */
interface WillDeleteResult {
    filePath: string;
    fileName: string;
    needRestore: boolean;
    restoreTableData: any;
    restoreSourceData: any;
    total: number;
    successCount: number;
    /** type=1 线上真实删除成功数（与 deletedSourceMissing 之和 === successCount） */
    deletedSuccess: number;
    /** type=3 sourceId 不存在、仍算删除成功数 */
    deletedSourceMissing: number;
    /** 逐条失败明细（tsId + 原因） */
    failures: PushFailure[];
    /** 是否弹出"删除结果"modal（无 testcase_id 或无案例行的文件不弹） */
    reportable: boolean;
    /** 整文件级错误（未绑定任务 / 接口整体失败） */
    error?: string;
}

/** filePath → WillDeleteResult（仅案例文件在处理后写入） */
const willDeleteResults = new Map<string, WillDeleteResult>();

/** filePath → 兜底清理定时器句柄，避免条目泄漏 */
const willDeleteEvictTimers = new Map<string, NodeJS.Timeout>();

/** 写入 willDeleteResults 时同步注册兜底清理定时器，如果 did 阶段没触发，避免永久驻留 */
function setWillDeleteResult(fp: string, result: WillDeleteResult): void {
    willDeleteResults.set(fp, result);
    // 复位已有定时器
    const prev = willDeleteEvictTimers.get(fp);
    if (prev) { try { clearTimeout(prev); } catch (_) { /* ignore */ } }
    const timer = setTimeout(() => {
        if (willDeleteResults.has(fp)) {
            willDeleteResults.delete(fp);
            TelemetryService.sendTelemetryEvent('caseFileDelete.willResult.evictTimeout', {
                filePath: path.basename(fp),
            });
        }
        willDeleteEvictTimers.delete(fp);
    }, WILL_DELETE_ENTRY_TTL_MS);
    willDeleteEvictTimers.set(fp, timer);
}

/** did 阶段消费条目时同步取消兜底清理定时器 */
function consumeWillDeleteResult(fp: string): WillDeleteResult | undefined {
    const r = willDeleteResults.get(fp);
    willDeleteResults.delete(fp);
    const timer = willDeleteEvictTimers.get(fp);
    if (timer) { try { clearTimeout(timer); } catch (_) { /* ignore */ } }
    willDeleteEvictTimers.delete(fp);
    return r;
}

/**
 * 注册所有工作区文件变化监听器
 */
export function registerWorkspaceListeners(_context: vscode.ExtensionContext): vscode.Disposable[] {
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

        // ★ 案例文件"将删除"拦截（同步注册 waitUntil，让 VSCode 等待接口完成）
        //   - 解析文件 → 调线上删除接口 → 剔除成功行、保存文件
        //   - 部分失败会记录 needRestore=true，did 阶段重建文件
        //   - 加了 30s 超时保护：接口卡住时不无限阻塞 VSCode 的删除确认框
        vscode.workspace.onWillDeleteFiles((event) => {
            const tasks: Promise<void>[] = [];
            for (const file of event.files) {
                const fp = file.fsPath;
                if (!isCaseFile(fp)) continue;
                // 单个文件的处理承诺：正常/异常/超时 三种结果都要在有限时间内落地为 willDeleteResults 条目
                const singleTask = Promise.race<void>([
                    handleCaseFileWillDelete(fp),
                    new Promise<void>((_, reject) => {
                        setTimeout(() => reject(new Error(`删除拦截超时（${DELETE_INTERCEPT_TIMEOUT_MS / 1000}s）`)),
                            DELETE_INTERCEPT_TIMEOUT_MS);
                    }),
                ]).catch(err => {
                    // 用户主动取消删除：reject waitUntil 以中止本次文件删除（VSCode 会保留文件）。
                    // 消息以中性措辞呈现，仅作为反馈，不算异常。
                    if (err instanceof UserCancelledDeleteError) {
                        console.log('[workspaceListeners] 用户取消删除案例文件:', path.basename(fp));
                        throw err;
                    }
                    console.error('[workspaceListeners] 案例文件删除拦截异常:', err?.message || err);
                    TelemetryService.sendTelemetryErrorEvent('caseFileDelete.intercept.error', {
                        errorMessage: String(err?.message || err).slice(0, 500),
                        filePath: path.basename(fp),
                    });
                    // 异常保底：保留文件全部行不删除
                    setWillDeleteResult(fp, {
                        filePath: fp,
                        fileName: path.basename(fp),
                        needRestore: true,
                        restoreTableData: null,
                        restoreSourceData: null,
                        total: 0,
                        successCount: 0,
                        deletedSuccess: 0,
                        deletedSourceMissing: 0,
                        failures: [],
                        reportable: true,
                        error: `拦截异常: ${err?.message || err}`,
                    });
                });
                tasks.push(singleTask);
            }
            if (tasks.length > 0) {
                event.waitUntil(Promise.all(tasks));
            }
        }),

        // 监听文件删除，同步清理所有本地缓存记录 + 案例文件失败还原
        vscode.workspace.onDidDeleteFiles((event) => {
            for (const file of event.files) {
                const fp = file.fsPath;
                if (isCreatedByCommand(fp)) {
                    unmarkAsCreatedByCommand(fp);
                }

                // 案例文件删除拦截的还原处理
                const willResult = consumeWillDeleteResult(fp);
                if (willResult && willResult.needRestore) {
                    // 有失败行：重建文件，仅写入失败行（即"不删除文件，只删成功行"）
                    restoreCaseFile(fp, willResult)
                        .then(() => {
                            // 还原完成后再弹窗，避免用户先看到弹窗再看到文件闪现
                            if (willResult.reportable) {
                                showDeleteResultModal(willResult);
                            }
                        })
                        .catch(err => {
                            console.error('[workspaceListeners] 案例文件还原失败:', err?.message || err);
                            TelemetryService.sendTelemetryErrorEvent('caseFileDelete.restore.error', {
                                errorMessage: String(err?.message || err).slice(0, 500),
                                filePath: path.basename(fp),
                            });
                            if (willResult.reportable) {
                                showDeleteResultModal({
                                    ...willResult,
                                    error: (willResult.error ? willResult.error + '；' : '') + `文件还原失败: ${err?.message || err}`,
                                });
                            }
                        });
                    // 失败行仍在文件中，仅清理临时态高亮/失败
                    removeHighlightFile(fp).catch(() => {});
                    removeFailureFile(fp).catch(() => {});
                    continue;
                }

                // 全部成功或非案例文件：先并行清理本地缓存，再弹窗汇报（确保用户看到通知时状态一致）
                const cleanupTask = Promise.allSettled([
                    removeHighlightFile(fp),
                    removeFailureFile(fp),
                    removeSnapshotFile(fp),
                    removeDeletedRowsFile(fp),
                    removeMarkFile(fp),
                ]);
                if (willResult && willResult.reportable) {
                    cleanupTask.then(() => showDeleteResultModal(willResult));
                }

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
 *   2. 调用线上删除接口（syncDeletedRows，与编辑器内右键删除行走同一入口）
 *   3. 按返回逐条区分成功/失败行
 *   4. 全部成功 → 允许删除；部分/全部失败 → needRestore=true 交给 did 阶段重建
 */
async function handleCaseFileWillDelete(filePath: string): Promise<void> {
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
        // 无 testcase_id 列或空文件：无需线上删除，允许文件被正常删除
        // reportable=false：空文件删除无实质业务动作，静默即可（避免噪音通知）
        setWillDeleteResult(filePath, {
            filePath,
            fileName: path.basename(filePath),
            needRestore: false,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            total: 0,
            successCount: 0,
            deletedSuccess: 0,
            deletedSourceMissing: 0,
            failures: [],
            reportable: false,
        });
        return;
    }

    // 收集每行的 tsId（可能为空）与非空 id 列表
    const rowTsIds: string[] = rows.map(r => (r[tsIdx] == null ? '' : String(r[tsIdx]).trim()));
    const nonEmptyIds = rowTsIds.filter(Boolean);

    if (nonEmptyIds.length === 0) {
        // 全部本地未推送：无需调接口，允许文件被正常删除
        // reportable=true：让用户明确知道"文件已删除（无线上案例）"，避免误删无反馈
        setWillDeleteResult(filePath, {
            filePath,
            fileName: path.basename(filePath),
            needRestore: false,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            total: rows.length,
            successCount: rows.length,
            deletedSuccess: 0,
            deletedSourceMissing: 0,
            failures: [],
            reportable: true,
        });
        return;
    }

    // 谨慎操作：删除案例文件会同步删除 TMS 平台上的全部案例，先向用户确认。
    // 用户取消 → 抛出 UserCancelledDeleteError，由外层 .catch 静默放弃删除（文件保留）。
    const confirmed = await confirmCaseFileDelete(filePath, nonEmptyIds.length);
    if (!confirmed) {
        throw new UserCancelledDeleteError(filePath);
    }

    // 调用同款删除入口（内部会读取任务上下文、调 deleteTestCase 接口、维护本地记录）
    let syncResult: { synced: string[]; failed: Array<{ tsId: string; reason: string }>; deletedSuccess: string[]; deletedSourceMissing: string[] };
    try {
        syncResult = await syncDeletedRows(filePath, nonEmptyIds);
    } catch (err: any) {
        // 接口调用整体异常：保守保留全部行、不删除文件
        const idToRowIndex = new Map<string, number>();
        for (let i = 0; i < rows.length; i++) {
            const id = rowTsIds[i];
            if (id) idToRowIndex.set(id, i + 1);
        }
        const failures: PushFailure[] = nonEmptyIds.map(id => ({
            tsId: id,
            reason: err?.message ? String(err.message) : '删除接口调用失败',
            rowIndex: idToRowIndex.get(id),
        }));
        setWillDeleteResult(filePath, {
            filePath,
            fileName: path.basename(filePath),
            needRestore: true,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            total: nonEmptyIds.length,
            successCount: 0,
            deletedSuccess: 0,
            deletedSourceMissing: 0,
            failures,
            reportable: true,
            error: err?.message || String(err),
        });
        return;
    }

    const syncedSet = new Set(syncResult.synced.map(String));
    const failedMap = new Map(syncResult.failed.map(f => [String(f.tsId), String(f.reason || '线上删除失败')]));

    // 逐行分派：有 tsId 且落在 syncedSet 则视为成功；其余保留
    // 失败行的 rowIndex 使用「删除后视图」的行号（即在 keepRows 里的位置），
    // 这样弹窗行号与用户看到的表格顺序一致
    const keepRows: any[][] = [];
    const keepSource: any[] = [];
    const failures: PushFailure[] = [];
    let successCount = 0;
    for (let i = 0; i < rows.length; i++) {
        const id = rowTsIds[i];
        if (id && syncedSet.has(id)) {
            successCount++;
            continue; // 剔除
        }
        keepRows.push(rows[i]);
        if (Array.isArray(sourceData)) keepSource.push(sourceData[i]);
        if (id) {
            const reason = failedMap.get(id) || (syncedSet.has(id) ? '' : '线上删除失败');
            if (reason) failures.push({ tsId: id, reason, rowIndex: keepRows.length });
        }
    }
    // 弹窗展示时按行号升序（无行号排最后）——文件删除路径下 rowIndex 天然递增，
    // 这里做一次稳定排序保底，避免上游改动后顺序错乱
    failures.sort((a, b) => {
        const ai = a.rowIndex == null ? Number.POSITIVE_INFINITY : a.rowIndex;
        const bi = b.rowIndex == null ? Number.POSITIVE_INFINITY : b.rowIndex;
        if (ai !== bi) return ai - bi;
        return String(a.tsId).localeCompare(String(b.tsId));
    });

    TelemetryService.sendTelemetryEvent('caseFileDelete.intercept.done', {
        total: String(nonEmptyIds.length),
        success: String(successCount),
        failed: String(failures.length),
        filePath: path.basename(filePath),
    });

    // 注意：此处不再 parser.save 剔除成功行后的内容。
    //   - 全部成功场景：VSCode 紧接着物理删除整个文件，写盘完全无意义；
    //   - 部分失败场景：restoreCaseFile 会在 onDidDeleteFiles 阶段以同样的 keepRows 写一次，
    //     此处再写只会多触发一次 fsWatcher → panel reload，导致页面刷新多余抖动。
    // 因此把要写盘的数据放到 restoreTableData/restoreSourceData 里，did 阶段统一写。
    tableData.rows = keepRows;
    const finalSource = Array.isArray(sourceData) ? keepSource : sourceData;

    if (failures.length === 0) {
        // 全部成功：允许 VSCode 继续物理删除文件（无需重建）
        setWillDeleteResult(filePath, {
            filePath,
            fileName: path.basename(filePath),
            needRestore: false,
            restoreTableData: tableData,
            restoreSourceData: finalSource,
            total: nonEmptyIds.length,
            successCount,
            deletedSuccess: syncResult.deletedSuccess.length,
            deletedSourceMissing: syncResult.deletedSourceMissing.length,
            failures: [],
            reportable: true,
        });
    } else {
        // 有失败行：did 阶段重建文件仅保留失败行（表现为"文件未删除、仅删了成功行"）
        setWillDeleteResult(filePath, {
            filePath,
            fileName: path.basename(filePath),
            needRestore: true,
            restoreTableData: tableData,
            restoreSourceData: finalSource,
            total: nonEmptyIds.length,
            successCount,
            deletedSuccess: syncResult.deletedSuccess.length,
            deletedSourceMissing: syncResult.deletedSourceMissing.length,
            failures,
            reportable: true,
        });
    }
}

/**
 * 重建案例文件，仅写入失败行（即保留"无法删除"的案例）。
 * 用于 onDidDeleteFiles 阶段：文件已被 VSCode 删除后还原为"仅失败行"版本。
 */
async function restoreCaseFile(filePath: string, result: WillDeleteResult): Promise<void> {
    const fileType = detectFileType(filePath);
    if (!fileType) return;
    if (!result.restoreTableData) return; // 拦截异常场景，无法重建
    const parser = createParser(fileType);
    await parser.save(filePath, result.restoreTableData, result.restoreSourceData);
    TelemetryService.sendTelemetryEvent('caseFileDelete.restore.done', {
        failedRows: String(result.failures.length),
        filePath: path.basename(filePath),
    });
}

/**
 * 弹出"删除结果"反馈：
 *   - 部分/全部失败（needRestore=true，文件已被 restoreCaseFile 重建）：
 *     重新以案例编辑器打开该文件 → 等待 webview ready → postMessage 到 panel 内 modal
 *     （与"编辑器内右键删除案例行"、"推送案例结果"完全一致的弹窗形态）
 *   - 全部成功（文件已被物理删除）：
 *     没有可承载 modal 的"当前案例页面"，改用 VSCode 原生 information 通知，
 *     避免打开一个独立的新 webview 窗口。
 */
async function showDeleteResultModal(r: WillDeleteResult): Promise<void> {
    try {
        const failCount = r.failures.length;

        // 场景 A：全部成功 —— 文件已被删除，用 VSCode 原生通知
        if (failCount === 0 && !r.needRestore) {
            if (r.error) {
                vscode.window.showErrorMessage(`删除失败：${r.fileName} —— ${r.error}`);
            } else if (r.successCount > 0) {
                vscode.window.showInformationMessage(`删除成功：${r.fileName}（共 ${r.successCount} 条）`);
            }
            return;
        }

        // 场景 B：需要还原（部分/全部失败）—— 文件被 restoreCaseFile 重建后再打开为案例编辑器
        const uri = vscode.Uri.file(r.filePath);
        let panel = BaseEditorProvider.getPanel(r.filePath);
        if (!panel) {
            try {
                await vscode.commands.executeCommand('vscode.openWith', uri, TESTCASE_EDITOR_VIEWTYPE);
            } catch (err: any) {
                console.warn('[workspaceListeners] 打开案例编辑器承载删除结果 modal 失败:', err?.message || err);
            }
            // 等待 panel 注册（resolveCustomEditor 完成后 panelMap 才被写入）
            for (let i = 0; i < 30; i++) {
                await new Promise(res => setTimeout(res, 100));
                panel = BaseEditorProvider.getPanel(r.filePath);
                if (panel) break;
            }
        }
        if (panel) {
            // 再等 webview ready（避免消息被丢弃）
            try {
                await BaseEditorProvider.waitReady(r.filePath, 3000);
            } catch (_) { /* ignore：超时也尝试 post，前端已就绪的场景下仍能收到 */ }
        }
        showDeleteResult(panel, r.fileName, r.successCount, r.failures, r.total, r.error, r.deletedSuccess, r.deletedSourceMissing);
    } catch (err: any) {
        console.warn('[workspaceListeners] 弹出删除结果失败:', err?.message || err);
        // 兜底：直接原生通知
        try {
            vscode.window.showErrorMessage(`删除结果反馈异常：${r.fileName}`);
        } catch (_) { /* ignore */ }
    }
}