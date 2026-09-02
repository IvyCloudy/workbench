/**
 * ============================================================================
 *  workspaceListeners.ts
 *  注册工作区文件变化监听器（重命名、删除）
 * ----------------------------------------------------------------------------
 *  案例文件删除拦截（resolve + did 阶段重建模式）：
 *    1. onWillDeleteFiles 阶段（文件被物理删除之前）通过 event.waitUntil
 *       调用线上删除接口（复用编辑器内删除案例的同一入口 syncDeletedRows），
 *       按返回按行区分成功/失败：
 *         - 全部成功 → 让 VSCode 正常完成物理删除
 *         - 部分失败 / 全部失败 / 接口整体失败 → 记录 needRestore，在
 *           onDidDeleteFiles 阶段用 parser.save 把文件重建回来（只写失败行），
 *           实现"不删除文件、只删除文件内满足条件的案例行"
 *         - 用户在自定义弹窗点取消 → 记录 isUserCancel=true，needRestore=true，
 *           did 阶段重建回原内容，**不**弹任何"删除结果"modal（取消≠错误）
 *    2. **关键设计：reject 模式不可靠**。VSCode 内部 `AsyncEmitter.fireAsync` 使用
 *       `Promise.allSettled(thenables)` 收口所有 waitUntil 的 rejection —— 即便
 *       我们 throw，VSCode 也只是把它当 unhandled error 吞掉，**不会中止文件物理删除**。
 *       因此本流程采取"resolve waitUntil，让 VSCode 删，did 阶段重建回原状"的方式。
 *    3. 弹窗使用 showDeleteResult（案例编辑器 panel 内 modal），与"案例编辑器里
 *       右键删除案例行"的反馈方式保持一致；但用户取消时不弹任何 modal。
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
import { resolveTaskInfoOrNull } from './pushCore.stages';
import { TelemetryService } from '../utils/telemetry';
import {
    notifyPrecheckFailure,
    confirmCaseFileDeleteWithDetails,
    reportDeleteResult,
} from '../utils/deleteFeedback';
import type { PushFailure, DeleteConfirmItem } from '../utils/deleteFeedback';
import { confirmDeleteTestCase } from '../services/http';

/** 案例编辑器 viewType（保持与 BaseEditorProvider 注册值一致） */
const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

/**
 * 确认删除案例文件 —— 使用 **VSCode 原生 modal**。
 *
 * 为什么不用 webview 内 xsConfirm（技术约束，非偏好）：
 *   1. webview 弹窗依赖已打开的 editor panel，而删除文件会销毁该 panel。
 *      不阻塞 waitUntil → panel 被销毁 → 弹窗根本显示不出来；
 *      阻塞 waitUntil → 必须设超时兜底，否则 Promise 永不结算。
 *   2. 超时兜底必然"等待不友好"：设短（3s）用户来不及点、弹窗被强制关闭；
 *      设长（30s）进度条一直转，用户感知为卡死。超时值无法两全。
 *   3. 原生 modal 由 VSCode 主线程管理，不依赖 webview/panel，且只有用户点按钮、
 *      关闭弹窗或按 ESC 才返回 —— **无需任何超时兜底**，用户可以从容选择。
 * 代价：弹窗样式为 VSCode 原生风格，与编辑器内 xsConfirm 不完全一致。
 *
 * @returns true=用户点"确定删除"；false=取消 / 关弹窗 / ESC / token 已取消
 */
async function confirmCaseFileDelete(
    filePath: string,
    caseCount: number,
    token?: vscode.CancellationToken,
): Promise<boolean> {
    const fileName = path.basename(filePath);
    const message =
        `谨慎操作：删除文件「${fileName}」会同步删除 TMS 平台上的 ${caseCount} 条案例及其关联的执行与缺陷关系，此操作不可恢复。是否确定删除？`;

    // 用户点了进度条上的 Cancel（event.token 取消）→ 立即取消，不再弹 modal
    if (token && token.isCancellationRequested) {
        console.log('[workspaceListeners] confirm 期间 token 已取消，立即取消删除:', fileName);
        return false;
    }

    const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        '确定删除',
    );
    // 只有点「确定删除」返回 true；点「取消」/ 关闭 / ESC 均返回 undefined → false（安全侧）
    const confirmed = choice === '确定删除';
    console.log('[workspaceListeners] 删除确认结果:', fileName, 'confirmed=', confirmed);
    return confirmed;
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

/** willDeleteResults 条目兜底清理时长：万一 did 阶段没触发，也不至于永久驻留 */
const WILL_DELETE_ENTRY_TTL_MS = 60_000;

/**
 * onWillDeleteFiles 阶段的处理结果缓存，供 onDidDeleteFiles 还原 + 弹窗使用。
 *   - needRestore=true：did 阶段需重建文件（用户取消=原内容；部分失败=仅失败行）
 *   - needRestore=false：文件可正常被删除
 *   - isUserCancel：用户最终意图（用户点取消=true；点确认=false）
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
    /** 线上删除成功的 tsId 列表（用于重建后回传前端 applyDeleteRowsResult，渲染删除高亮/tooltip） */
    syncedTsIds: string[];
    /** 逐条失败明细（tsId + 原因） */
    failures: PushFailure[];
    /** 删除前文件是否处于"已打开案例编辑器"状态（用于 will 阶段判定 needRestore 后是否自动重开） */
    wasOpen: boolean;
    /** 是否弹出"删除结果"modal（无 testcase_id 或无案例行的文件不弹）；用户取消不弹 */
    reportable: boolean;
    /** 整文件级错误（未绑定任务 / 接口整体失败） */
    error?: string;
    /** 用户取消删除（自定义 confirm 弹窗按取消 / 关闭 / 超时） */
    isUserCancel?: boolean;
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
 * 更新已有 willDeleteResults 条目（保留 onWillDeleteFiles 写入的 confirmPromise / 已回填备份）。
 * 用于 handleCaseFileWillDelete 在确认结果出来后回填最终意图。
 */
function updateWillDeleteResult(fp: string, patch: Partial<WillDeleteResult>): void {
    const r = willDeleteResults.get(fp);
    if (!r) return;
    Object.assign(r, patch);
}

/**
 * 注册所有工作区文件变化监听器
 */
export function registerWorkspaceListeners(context: vscode.ExtensionContext): vscode.Disposable[] {
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

        // ★ 案例文件"将删除"拦截 —— resolve 模式 + did 阶段重建
        //   - 关键设计：VSCode 内部的 AsyncEmitter.fireAsync 用 `Promise.allSettled(thenables)`
        //     收口所有 waitUntil 的 rejection —— 即便我们 throw __isUserCancel 也**只会被吞为
        //     unhandled error**，不会中止文件物理删除（实测：用户取消后文件仍被删除）。
        //     唯一可靠的"阻止删除"方式是调用 progress 上的 Cancel 按钮（触发 cancellation token），
        //     但扩展 API 无法自动关闭该进度条。
        //   - 因此采"resolve + 重建"模式：
        //       · 用户取消 → 缓存 { isUserCancel:true, needRestore:true, restoreTableData=原内容 }
        //         到 willDeleteResults，resolve waitUntil（让 VSCode 完成物理删除）；
        //       · `onDidDeleteFiles` 阶段看到 isUserCancel=true → 立即用 `parser.save` 重建
        //         回原内容，**且跳过 showDeleteResultModal**（取消不是错误，不弹失败框）；
        //       · 用户确认 → 走 syncDeletedRows，全部成功则 needRestore=false，
        //         否则保留失败行。
        //   - 视觉效果：进度条"秒级"消失（resolve），文件被重建回来——用户视角"取消=文件还在"，
        //     且没有任何"删除失败"misleading 弹窗。
        vscode.workspace.onWillDeleteFiles((event) => {
            console.log('[workspaceListeners] onWillDeleteFiles 触发, files=', event.files.map(f => f.fsPath));
            const tasks: Promise<void>[] = [];
            for (const file of event.files) {
                const fp = file.fsPath;
                if (!isCaseFile(fp)) continue;
                console.log('[workspaceListeners] 命中案例文件删除拦截:', fp);

                // event.waitUntil 等待 confirm 走完（用户点完原生 modal 按钮才结算）。
                // 确认弹窗是 VSCode 原生 modal（不依赖 webview/panel、无超时兜底），
                // 用户点「确定删除」/「取消」/ 关闭弹窗后本 promise 立即结算，
                // VSCode 随后才执行 unlink 并触发 onDidDeleteFiles。
                tasks.push(
                    handleCaseFileWillDelete(fp, event.token, context).catch((err: any) => {
                        console.error('[workspaceListeners] handleCaseFileWillDelete 未捕获异常（已吞兜底）:', err?.message || err);
                        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.intercept.error', {
                            errorMessage: String(err?.message || err).slice(0, 500),
                            filePath: path.basename(fp),
                        });
                    }),
                );
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
                // willResult 存在即说明该文件走了案例拦截流程（原生 modal 确认已完成），
                // 交由 handleDidDeleteCaseFile 统一决定"重建 or 清理"，并 continue 跳过
                // 下方通用分支（避免重复清理；绑定库清理已在 handleDidDeleteCaseFile 内处理）。
                const willResult = consumeWillDeleteResult(fp);
                if (willResult) {
                    void handleDidDeleteCaseFile(fp, willResult);
                    continue;
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
 * 案例文件"将删除"拦截（waitUntil 等待 confirm + did 阶段按最终意图重建）：
 *   由 onWillDeleteFiles 调用，并通过 event.waitUntil 让 VSCode 等 confirm 走完再 unlink。
 *
 *   流程：
 *   1. 解析文件 → 写入 willDeleteResults 的 restoreTableData/sourceData（重建所需备份）；
 *   2. 无 testcase_id / 空文件 / 全本地未推送 → 标记 needRestore=false（无需线上操作）；
 *   3. 弹 **VSCode 原生 modal** 确认框：
 *      - 用户取消 / 关弹窗 / ESC / token 取消 → isUserCancel=true, needRestore=true；
 *        did 阶段重建回原状，**不弹**任何 modal。
 *      - 用户确认 → 调 syncDeletedRows：
 *          · 全部成功 → needRestore=false；
 *          · 任意失败 / 接口整体异常 → needRestore=true + 仅失败行，弹窗汇报。
 *   4. 关键设计：原生 modal 不依赖 webview/panel、且只在用户操作后返回，
 *      因此**无需超时兜底**，用户可以从容选择；waitUntil 在用户点完按钮后立即结算，
 *      VSCode 随后执行 unlink 并触发 onDidDeleteFiles。
 */
async function handleCaseFileWillDelete(
    filePath: string,
    token?: vscode.CancellationToken,
    extContext?: vscode.ExtensionContext,
): Promise<void> {
    const fileType = detectFileType(filePath);
    if (!fileType) return;

    // 入口处创建 willDeleteResults 条目（did 阶段消费 + 重建所需）。
    // 由于采用 waitUntil 等待 confirm 的阻塞方案（A'），did 阶段必然在 handler 完成之后
    // 才触发，因此这里直接以"待定状态"创建，后续用 updateWillDeleteResult 回填最终意图。
    setWillDeleteResult(filePath, {
        filePath,
        fileName: path.basename(filePath),
        needRestore: true, // 占位：最终意图由后续 updateWillDeleteResult 回填
        restoreTableData: null,
        restoreSourceData: null,
        total: 0,
        successCount: 0,
        deletedSuccess: 0,
        deletedSourceMissing: 0,
        syncedTsIds: [],
        failures: [],
        reportable: false,
        isUserCancel: undefined,
        // 删除前文件若已以案例编辑器打开，则重建后自动重新打开（见需求 1）
        wasOpen: !!BaseEditorProvider.getPanel(filePath),
    });

    const parser = createParser(fileType);
    const parsed = await parser.parse(filePath);
    const tableData = parsed.tableData;
    const sourceData = parsed.sourceData;
    const headers: string[] = tableData?.headers || [];
    const rows: any[][] = tableData?.rows || [];

    // 回填重建所需备份
    const pending = willDeleteResults.get(filePath);
    if (pending) {
        pending.restoreTableData = tableData;
        pending.restoreSourceData = sourceData;
    }

    const tsIdx = headers.indexOf(TS_ID_COLUMN);
    if (tsIdx < 0 || rows.length === 0) {
        // 无 testcase_id 列或空文件：无需线上删除，让 VSCode 正常删除文件
        // 埋点：文件删除删除案例「发起」事件（即便无 testcase_id 也上报，记录用户触发了文件级删除）
        TelemetryService.sendTelemetryEvent('caseFileDelete.intercept.init', {
            filePath: path.basename(filePath),
            totalRows: String(rows.length),
            hasTsId: 'false',
            nonEmptyIds: '0',
            artifactId: path.basename(filePath),
            testTaskNo: '',
            subTestTaskId: '',
            testcaseIds: '',
        });
        if (pending) { pending.needRestore = false; pending.isUserCancel = false; pending.reportable = false; pending.total = 0; pending.successCount = 0; }
        return;
    }

    // 收集每行的 tsId（可能为空）与非空 id 列表
    const rowTsIds: string[] = rows.map(r => (r[tsIdx] == null ? '' : String(r[tsIdx]).trim()));
    const nonEmptyIds = rowTsIds.filter(Boolean);

    // 拉取测试任务信息（失败不影响主流程，缺失时留空）
    let taskTestTaskNo = '';
    let taskSubTestTaskId = '';
    try {
        const t = await resolveTaskInfoOrNull(filePath);
        if (t.status === 'ok') {
            taskTestTaskNo = t.taskInfo.testTaskNo || '';
            taskSubTestTaskId = t.taskInfo.subTestTaskId || '';
        }
    } catch (_) { /* 任务信息缺失不阻断删除主流程与埋点 */ }

    // 埋点：文件删除删除案例「发起」事件（记录用户触发了一次案例文件删除，
    // 携带待删除的 testcase_id 列表与测试任务信息，与后续
    // caseFileDelete.intercept.done / .error 形成"发起→结果"闭环）
    TelemetryService.sendTelemetryEvent('caseFileDelete.intercept.init', {
        filePath: path.basename(filePath),
        totalRows: String(rows.length),
        hasTsId: 'true',
        nonEmptyIds: String(nonEmptyIds.length),
        artifactId: path.basename(filePath),
        testTaskNo: taskTestTaskNo,
        subTestTaskId: taskSubTestTaskId,
        testcaseIds: nonEmptyIds.join('|'),
    });

    if (nonEmptyIds.length === 0) {
        // 全部本地未推送：无需调接口，让 VSCode 正常删除文件
        if (pending) { pending.needRestore = false; pending.isUserCancel = false; pending.reportable = true; pending.total = rows.length; pending.successCount = rows.length; }
        return;
    }

    // 谨慎操作：删除案例文件会同步删除 TMS 平台上的全部案例，先向用户确认。
    //
    // 删除前先做「线上预检」（删除确认接口）：若存在带执行/缺陷关联的案例（type=2），
    // 用独立 webview 弹窗以表格形式展示这些案例；否则降级为 VSCode 原生 modal。
    // 预检失败（未绑定任务 / 接口异常）不阻断删除，同样走原生 modal 降级。
    let confirmItems: DeleteConfirmItem[] = [];
    try {
        const tInfo = await resolveTaskInfoOrNull(filePath);
        if (tInfo.status === 'ok' && extContext) {
            const resp = await confirmDeleteTestCase(extContext, tInfo.taskInfo, nonEmptyIds);
            if (resp.returnCode === 'SUC0000' && Array.isArray(resp.body)) {
                confirmItems = resp.body
                    .filter((it: any) => Number(it?.type) === 2)
                    .map((it: any) => ({
                        sourceId: String(it?.sourceId ?? '').trim(),
                        testcaseNo: String(it?.data?.testcaseNo ?? '').trim(),
                        testCaseName: String(it?.data?.testCaseName ?? '').trim(),
                        hasExec: !!it?.data?.hasExec,
                        hasBug: !!it?.data?.hasBug,
                    }))
                    .filter((it: DeleteConfirmItem) => !!it.sourceId);
            } else {
                // 预检接口返回非成功码：提示后端 errorMsg，降级为原生 modal（不阻断删除）
                notifyPrecheckFailure({
                    scenePrefix: '删除前校验未通过，已跳过确认步骤',
                    returnCode: resp.returnCode || '',
                    errorMsg: resp.errorMsg || '',
                    msgType: 'warning',
                });
            }
        }
    } catch (_ce) {
        // 预检失败（网络/异常）：降级为原生 modal（不阻断删除）
        confirmItems = [];
    }

    const userConfirmed = confirmItems.length > 0
        ? await confirmCaseFileDeleteWithDetails(
            { fileName: path.basename(filePath), caseCount: nonEmptyIds.length, items: confirmItems },
            token,
        )
        : await confirmCaseFileDelete(filePath, nonEmptyIds.length, token);
    if (!userConfirmed) {
        console.log('[workspaceListeners] 用户取消案例文件删除，标记 isUserCancel=true 到 willDeleteResults:', path.basename(filePath));
        if (pending) { pending.needRestore = true; pending.isUserCancel = true; pending.reportable = false; pending.total = nonEmptyIds.length; pending.successCount = 0; }
        return;
    }

    // 调用同款删除入口（内部会读取任务上下文、调 deleteTestCase 接口、维护本地记录）
    let syncResult: { synced: string[]; failed: Array<{ tsId: string; reason: string }>; deletedSuccess: string[]; deletedSourceMissing: string[] };
    try {
        syncResult = await syncDeletedRows(filePath, nonEmptyIds);
    } catch (err: any) {
        // 接口整体异常 / 网络错误：缓存失败结果，由 did 阶段重建原内容 + 弹窗告知用户。
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
        updateWillDeleteResult(filePath, {
            needRestore: true,
            restoreTableData: tableData,
            restoreSourceData: sourceData,
            total: nonEmptyIds.length,
            successCount: 0,
            deletedSuccess: 0,
            deletedSourceMissing: 0,
            syncedTsIds: [],
            failures,
            reportable: true,
            error: err?.message || String(err),
        });
        return;
    }

    const syncedSet = new Set(syncResult.synced.map(String));
    const failedMap = new Map(syncResult.failed.map(f => [String(f.tsId), String(f.reason || '线上删除失败')]));
    const failureTsIds = new Set(syncResult.failed.map(f => String(f.tsId)));

    // 逐行分派：剔除 syncedSet 中的行；保留所有非空失败行 + 所有本地未推送的空 id 行
    // 失败行的 rowIndex 使用「保留视图」的行号（即在 keepRows 里的位置）
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
        if (id && failureTsIds.has(id)) {
            const reason = failedMap.get(id) || '线上删除失败';
            failures.push({ tsId: id, reason, rowIndex: keepRows.length });
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

    // 保留视图用于 onDidDeleteFiles 阶段弹窗汇报（即便 reject 时也会用到）
    tableData.rows = keepRows;
    const finalSource = Array.isArray(sourceData) ? keepSource : sourceData;

    if (failures.length === 0) {
        // 全部成功：允许 VSCode 继续物理删除文件（无需重建）
        updateWillDeleteResult(filePath, {
            needRestore: false,
            restoreTableData: tableData,
            restoreSourceData: finalSource,
            total: nonEmptyIds.length,
            successCount,
            deletedSuccess: syncResult.deletedSuccess.length,
            deletedSourceMissing: syncResult.deletedSourceMissing.length,
            syncedTsIds: Array.from(syncedSet),
            failures: [],
            reportable: true,
        });
        return;
    }

    // 有失败行：did 阶段会重建"仅失败行"版本
    // （即"删成功行、保留失败行"）——这是真正的"部分删除成功"语义。
    updateWillDeleteResult(filePath, {
        needRestore: true,
        restoreTableData: tableData,
        restoreSourceData: finalSource,
        total: nonEmptyIds.length,
        successCount,
        deletedSuccess: syncResult.deletedSuccess.length,
        deletedSourceMissing: syncResult.deletedSourceMissing.length,
        syncedTsIds: Array.from(syncedSet),
        failures,
        reportable: true,
    });
    return;
}

/**
 * onDidDeleteFiles 阶段对案例文件的最终处理（fire-and-forget）。
 * 由于 onWillDeleteFiles 用 event.waitUntil 等待 handler 完成（A' 设计），did 阶段
 * 触发时 willDeleteResults 必然已是 handler 写入的最终意图，可直接读取。
 */
async function handleDidDeleteCaseFile(fp: string, willResult: WillDeleteResult): Promise<void> {
    try {
        if (!willResult.needRestore) {
            // 文件被真正删除：清理临时态缓存 + 同步 point↔case 绑定库（删除引用）。
            // 注意：案例文件走本分支时会被 onDidDeleteFiles 提前 continue，
            // 因此绑定库清理必须在这里补上，否则会残留失效的 point↔case 引用。
            const cleanupTask = Promise.allSettled([
                removeHighlightFile(fp),
                removeFailureFile(fp),
                removeSnapshotFile(fp),
                removeDeletedRowsFile(fp),
                removeMarkFile(fp),
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
                    }),
            ]);
            if (willResult.reportable) {
                cleanupTask.then(() => showDeleteResultModal(willResult));
            }
            return;
        }

        // needRestore=true：把文件重建回来
        if (willResult.isUserCancel) {
            // ★ 用户取消：重建回原状，但不弹任何 modal（取消≠错误）
            await restoreCaseFile(fp, willResult);
            console.log('[workspaceListeners] 用户取消 → 文件已重建回原状:', path.basename(fp));
            // 需求 1：若删除前文件处于"已打开"状态，重建后自动重新打开，避免"文件被关掉"
            if (willResult.wasOpen) {
                await reopenCaseFile(fp);
            }
            // 不清理任何缓存（文件回到原状）
            return;
        }

        // 有失败行：重建"仅失败行"版本，再弹窗汇报
        await restoreCaseFile(fp, willResult);

        // 需求 2：与编辑器内删除案例一致 —— 失败行需有"高亮"与"# 列删除 tooltips"。
        //   通过把删除结果回传前端 applyDeleteRowsResult 实现：
        //     - 成功行从表格移除（syncedTsIds）
        //     - 失败行保留，并标记 xs-tr-delete-failed（置灰+划线）+ # 列删除原因 tooltip
        //   该回传依赖"重建后文件被重新打开为案例编辑器"，故先确保 panel 存在。
        if (willResult.wasOpen) {
            await reopenCaseFile(fp);
        }

        // 回传 deleteRowsResult 到重建后的面板（渲染删除高亮 + # 列 tooltip）
        const panel = BaseEditorProvider.getPanel(fp);
        if (panel) {
            const reasons: Array<[string, string]> = willResult.failures.map(f => [String(f.tsId), String(f.reason || '')]);
            try {
                panel.webview.postMessage({
                    type: 'deleteRowsResult',
                    synced: willResult.syncedTsIds.map(String),
                    failed: willResult.failures.map(f => String(f.tsId)),
                    reasons,
                    deletedSuccess: willResult.deletedSuccess,
                    deletedSourceMissing: willResult.deletedSourceMissing,
                });
            } catch (_) { /* ignore */ }
        }

        if (willResult.reportable) {
            await showDeleteResultModal(willResult);
        }
        // 失败行仍在文件中，仅清理临时态高亮
        removeHighlightFile(fp).catch(() => {});
    } catch (err: any) {
        console.error('[workspaceListeners] handleDidDeleteCaseFile 异常:', err?.message || err);
        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.didHandler.error', {
            errorMessage: String(err?.message || err).slice(0, 500),
            filePath: path.basename(fp),
        });
        if (willResult.isUserCancel) {
            // 用户取消后重建失败：文件已真正被删，给用户留个线索
            try {
                vscode.window.showErrorMessage(
                    `取消失败：原文件已被删除且重建失败 —— ${path.basename(fp)}。请前往垃圾箱恢复。`,
                );
            } catch (_) { /* ignore */ }
        }
    }
}

/**
 * 以案例编辑器重新打开文件（需求 1：删除前处于打开状态的文件，重建后自动重开）。
 * 非阻塞、失败静默（重开失败不阻塞主流程）。
 */
async function reopenCaseFile(filePath: string): Promise<void> {
    try {
        const uri = vscode.Uri.file(filePath);
        await vscode.commands.executeCommand('vscode.openWith', uri, TESTCASE_EDITOR_VIEWTYPE);
        TelemetryService.sendTelemetryEvent('caseFileDelete.reopen', {
            filePath: path.basename(filePath),
        });
    } catch (err: any) {
        console.warn('[workspaceListeners] 重建后重开文件失败（已忽略）:', err?.message || err);
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
        reportDeleteResult({
            panel,
            fileName: r.fileName,
            successCount: r.successCount,
            failures: r.failures,
            total: r.total,
            error: r.error,
            deletedSuccess: r.deletedSuccess,
            deletedSourceMissing: r.deletedSourceMissing,
        });
    } catch (err: any) {
        console.warn('[workspaceListeners] 弹出删除结果失败:', err?.message || err);
        // 兜底：直接原生通知
        try {
            vscode.window.showErrorMessage(`删除结果反馈异常：${r.fileName}`);
        } catch (_) { /* ignore */ }
    }
}