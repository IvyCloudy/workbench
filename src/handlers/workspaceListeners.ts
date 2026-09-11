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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCreatedByCommand, markAsCreatedByCommand, unmarkAsCreatedByCommand } from '../utils/fileIdentifier';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { removeHighlightFile } from '../utils/highlightStore';
import { cleanupCaseFileTraces } from '../utils/caseFileCleanup';
import {
    renamePathInBindings,
    removePathInBindings,
} from '../utils/pointCaseBindingStore';
import { detectFileType, createParser } from '../parsers';
import { syncDeletedRows } from '../utils/deletedRowsStore';
import { TS_ID_COLUMN } from '../services/utils';
import { resolveTaskInfoOrNull } from './pushCore.stages';
import { TelemetryService } from '../utils/telemetry';
import { showModal } from '../utils/message';
import {
    confirmCaseFileDeleteWithDetails,
    reportDeleteResult,
} from '../utils/deleteFeedback';
import { showDeleteConfirmSimpleModal } from '../utils/messageExtras';
import type { PushFailure, DeleteConfirmItem } from '../utils/deleteFeedback';
import { confirmDeleteTestCase } from '../services/http';

/** 案例编辑器 viewType（保持与 BaseEditorProvider 注册值一致） */
const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

/**
 * 确认删除案例文件 —— 使用**插件封装的独立 webview 模态框**（无关联表格的简单版）。
 *
 * 历史说明：早期曾用 vscode.window.showWarningMessage（VSCode 原生 modal）实现，
 * 但样式与「案例编辑器内删除」弹窗不一致。现改用独立 webview 模态框：
 *   - 独立 webview panel 由本函数自己创建，**不依赖案例编辑器 panel**，
 *     即便文件没在编辑器里打开也能稳定显示。
 *   - 用户点按钮/关弹窗/ESC/Cancel 进度条均可结算，无需超时兜底。
 *   - 视觉与编辑器内删除、删除确认接口异常提示等所有插件弹窗保持一致。
 *
 * @returns true=用户点"确定删除"；false=取消 / 关弹窗 / ESC / token 已取消
 */
async function confirmCaseFileDelete(
    filePath: string,
    caseCount: number,
    token?: vscode.CancellationToken,
): Promise<boolean> {
    const fileName = path.basename(filePath);
    // 用户点了进度条上的 Cancel（event.token 取消）→ 立即取消，不再弹 modal
    if (token && token.isCancellationRequested) {
        console.log('[workspaceListeners] confirm 期间 token 已取消，立即取消删除:', fileName);
        // 标记：用户在「删除确认弹窗显示之前」就被取消（进度条 Cancel / waitUntil 超时），
        // 其从未看到任何确认弹窗 —— did 阶段据此补一个反馈，避免"静默取消"让用户误以为删除已发生。
        updateWillDeleteResult(filePath, { cancelledBeforeConfirm: true });
        return false;
    }
    const confirmed = await showDeleteConfirmSimpleModal(
        { fileName, caseCount },
        token,
    );
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

/** 是否测试要点（point）文件（.md/.xmind 且位于「测试任务/xxx/测试大纲/」下） */
function isPointFile(fp: string): boolean {
    const norm = (fp || '').replace(/\\/g, '/');
    if (!/\/测试任务\/[^/]+\/测试大纲\//.test(norm)) return false;
    const ext = (norm.match(/\.[^./]+$/) || [''])[0].toLowerCase();
    return ext === '.md' || ext === '.xmind';
}

/** willDeleteResults 条目兜底清理时长：万一 did 阶段没触发，也不至于永久驻留 */
const WILL_DELETE_ENTRY_TTL_MS = 60_000;

/**
 * 删除前线上「确认接口」(confirmDeleteTestCase) 的最长等待时间（8 分钟）。
 *
 * 背景：真实环境实测确认接口约 5 分钟才返回。本值是**外层兜底**，必须严格大于
 * 底层 HTTP 超时 CONFIRM_DELETE_DEFAULT_TIMEOUT(6 分钟，见 services/http.ts)，
 * 否则外层会先于 HTTP 触发，把「接口即将正常返回」误判为超时：
 *   · 6 分钟内返回（HTTP 层判定）→ 正常按 returnCode 决定放行 / 阻断；
 *   · 6 分钟 HTTP 超时 → 由 HTTP 层 reject 并携带具体错误，视为「预检异常」；
 *   · 超过 8 分钟仍未返回（兜底）→ 抛出 PrecheckTimeoutError，同样按「预检异常」
 *     处理（needRestore=true，did 阶段重建原文件，阻断删除）。
 *
 * 另注：VSCode 的 onWillDeleteFiles 的 event.waitUntil 存在**不可控的内部超时**，
 * 且实测明显短于 5 分钟。一旦该超时到期，VSCode 会强制放行物理删除并取消 token，
 * 使本值实际上难以生效——详见 handleDidDeleteCaseFile 中的「中断占位」兜底分支。
 * 因此本值只解决"配置层误判"，无法消除 VSCode 强制放行导致的删除中断。
 */
const PRECHECK_TIMEOUT_MS = 8 * 60 * 1000;

/** 确认接口超时专用错误，便于在 catch 分支中识别并上报专门的埋点事件 */
class PrecheckTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`删除确认接口超时（已超过 ${Math.round(timeoutMs / 1000)} 秒未返回）`);
        this.name = 'PrecheckTimeoutError';
    }
}

/** 给 promise 加最长等待时间；超时则 reject 由 buildErr 构造的错误 */
async function withTimeout<T>(p: Promise<T>, ms: number, buildErr: () => Error): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(buildErr()), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

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
    /** 删除前同步备份的文件绝对路径（位于 os.tmpdir，用于 VSCode 内部 waitUntil 超时
     *  强制物理删除后仍能可靠恢复；成功删除场景在 did 阶段清理该备份） */
    backupPath?: string;
    /** 是否弹出"删除结果"modal（无 testcase_id 或无案例行的文件不弹）；用户取消不弹 */
    reportable: boolean;
    /** 整文件级错误（未绑定任务 / 接口整体失败） */
    error?: string;
    /** 删除前校验失败的场景前缀（由 did 阶段在文件重建完成后弹插件封装的模态框）：
     *   - "删除前校验未通过"：删除确认接口返回非 SUC0000
     *   - "删除前校验异常"：删除确认接口网络/解析/5xx 异常
     * 仅当 error 有值时设置。设了但 isUserCancel=true 时不弹（用户取消优先）。 */
    precheckScenePrefix?: string;
    /** 删除前校验失败时，删除确认接口的返回码（如 'SYS5001'）。
     * 仅在 returnCode 非空时设置；did 阶段弹窗会在文案中单独显示「返回码：xxx」一行，
     * 与编辑器内删除的弹窗格式保持一致。
     * 网络/解析异常等无 returnCode 的场景不设置。 */
    precheckReturnCode?: string;
    /** 用户取消删除（自定义 confirm 弹窗按取消 / 关闭 / 超时） */
    isUserCancel?: boolean;
    /** 确认弹窗显示前就被 token 取消（进度条 Cancel / waitUntil 超时），用户从未看到确认弹窗 */
    cancelledBeforeConfirm?: boolean;
    /** 最终意图是否已由 handler 正常回填（用于识别"被 VSCode 内部 waitUntil 超时强制中断"的占位条目） */
    intentSet: boolean;
    /** will 阶段 handler 是否已结束（false 期间兜底 TTL 只重排队、不清理条目与备份） */
    handlerDone: boolean;
    /** 是否因 onWillDeleteFiles 阶段被 VSCode 内部 waitUntil 超时强制中断而未能完成预检 */
    interrupted?: boolean;
}

/** filePath → WillDeleteResult（仅案例文件在处理后写入） */
const willDeleteResults = new Map<string, WillDeleteResult>();

/** filePath → 兜底清理定时器句柄，避免条目泄漏 */
const willDeleteEvictTimers = new Map<string, NodeJS.Timeout>();

/**
 * 注册（或复位）条目的兜底清理定时器。
 *
 * ★ 关键约束：handler 仍在执行期间**绝不能清理条目与删前备份**。
 *   - willDeleteResults 条目是 did 阶段判断"是否重建文件"的唯一依据；
 *   - backupPath 备份是文件原始内容的唯一副本。
 *   若确认接口响应很慢（或用户迟迟未操作确认弹窗）导致 handler 耗时超过
 *   WILL_DELETE_ENTRY_TTL_MS，提前清理会让 did 阶段 consume 到 undefined
 *   → 既拿不到重建依据、备份也已被删 → 文件被 VSCode 物理删除后再也无法恢复
 *   （用户取消 / 预检阻断场景下即表现为"文件莫名丢失"）。
 *   因此：handler 未结束时只重新排队等待，绝不清理。
 */
function scheduleWillDeleteEvict(fp: string): void {
    const prev = willDeleteEvictTimers.get(fp);
    if (prev) { try { clearTimeout(prev); } catch (_) { /* ignore */ } }
    const timer = setTimeout(() => {
        const evicted = willDeleteResults.get(fp);
        if (evicted) {
            if (!evicted.handlerDone) {
                // handler 仍在执行（确认接口慢 / 等待用户确认）→ 重新排队，保留条目与备份
                scheduleWillDeleteEvict(fp);
                return;
            }
            willDeleteResults.delete(fp);
            // 同步清理删前备份，避免 did 阶段始终未触发时备份文件泄漏在 os.tmpdir
            if (evicted.backupPath) {
                fs.promises.unlink(evicted.backupPath).catch(() => { /* ignore */ });
            }
            TelemetryService.sendTelemetryEvent('caseFileDelete.willResult.evictTimeout', {
                filePath: path.basename(fp),
            });
        }
        willDeleteEvictTimers.delete(fp);
    }, WILL_DELETE_ENTRY_TTL_MS);
    willDeleteEvictTimers.set(fp, timer);
}

/** 写入 willDeleteResults 时同步注册兜底清理定时器，如果 did 阶段没触发，避免永久驻留 */
function setWillDeleteResult(fp: string, result: WillDeleteResult): void {
    willDeleteResults.set(fp, result);
    scheduleWillDeleteEvict(fp);
}

/**
 * 标记 will 阶段 handler 已结束（无论成功/失败/抛错）。
 * 只有标记为已完成，兜底 TTL 才会真正清理条目与备份（见 scheduleWillDeleteEvict）。
 * 注意：刻意不使用 updateWillDeleteResult，避免把"handler 结束"误记为"最终意图已回填"。
 */
function markWillHandlerDone(fp: string): void {
    const r = willDeleteResults.get(fp);
    if (r) r.handlerDone = true;
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
    // 回填即代表"最终意图已确定"，除非调用方显式指定 intentSet
    // （例如删前备份路径回填 —— 它发生在流程中段，并非最终意图）。
    if (patch.intentSet === undefined) r.intentSet = true;
}

/**
 * 只读读取 willDeleteResults 条目（不消费、不清除兜底定时器）。
 * 仅供单元测试断言「onWillDeleteFiles 阶段写入的最终意图」使用，生产逻辑请走 consumeWillDeleteResult。
 */
export function peekWillDeleteResult(fp: string): WillDeleteResult | undefined {
    return willDeleteResults.get(fp);
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
                // handler 结束后（无论成功/失败）标记完成，兜底 TTL 才允许清理条目与备份。
                // 不放在 handler 内部 finally 是为了覆盖"handler 尚未开始执行就被中断"的场景。
                tasks.push(
                    handleCaseFileWillDelete(fp, event.token, context)
                        .catch((err: any) => {
                            console.error('[workspaceListeners] handleCaseFileWillDelete 未捕获异常（已吞兜底）:', err?.message || err);
                            TelemetryService.sendTelemetryErrorEvent('caseFileDelete.intercept.error', {
                                errorMessage: String(err?.message || err).slice(0, 500),
                                filePath: path.basename(fp),
                            });
                        })
                        .finally(() => markWillHandlerDone(fp)),
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
                // 注：测试要点文件（.md/.xmind）不在此处清理绑定 —— 其「取消删除→重建」与
                // 「真正删除」的绑定语义由专门的还原流程负责（与案例文件一致：案例文件也通过
                // willDeleteResults 还原流程精确控制，不会落入此通用分支）。若在此无差别清理，
                // 会导致用户取消删除要点文件时把已绑定的测试案例关系一并清掉。
                if (isBindingRelevant(fp) && !isPointFile(fp)) {
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
export async function handleCaseFileWillDelete(
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
        cancelledBeforeConfirm: false,
        intentSet: false, // 占位：最终意图由后续 updateWillDeleteResult 回填
        handlerDone: false, // handler 正在执行，兜底 TTL 期间不得清理条目/备份
        interrupted: false,
        // 删除前文件若已以案例编辑器打开，则重建后自动重新打开（见需求 1）
        wasOpen: !!BaseEditorProvider.getPanel(filePath),
    });

    const parser = createParser(fileType);
    const parsed = await parser.parse(filePath);
    const tableData = parsed.tableData;
    const sourceData = parsed.sourceData;
    const headers: string[] = tableData?.headers || [];
    const rows: any[][] = tableData?.rows || [];

    // ★ 删前同步备份：VSCode 的 onWillDeleteFiles.waitUntil 有不可控的内部超时，
    //   一旦超时 VSCode 会强制物理删除文件，而我们的确认接口可能还在等待返回。
    //   为此在删除发生前先把原文件 copy 到 os.tmpdir，后续：
    //     · 成功删除（needRestore=false）→ did 阶段清理备份；
    //     · 取消 / 预检失败 / 接口超时（needRestore=true）→ 用备份 copy 回原路径恢复，
    //       比 parser.save 重建更可靠（保留原始字节与格式，避免重建引入的格式漂移）。
    try {
        const backupPath = path.join(
            os.tmpdir(),
            `caseDelBak-${Date.now()}-${process.pid}-${path.basename(filePath)}`,
        );
        fs.copyFileSync(filePath, backupPath);
        // 备份回填发生在流程中段，**不是**最终意图 —— 显式保持 intentSet=false，
        // 确保"预检未完成即被中断"的场景仍能被 did 阶段正确识别。
        updateWillDeleteResult(filePath, { backupPath, intentSet: false });
    } catch (bkErr: any) {
        // 备份失败不阻断删除主流程；后续还原会降级为 parser.save 重建（与旧逻辑一致）
        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.backup.failed', {
            filePath: path.basename(filePath),
            errorMessage: String(bkErr?.message || bkErr).slice(0, 500),
        });
    }

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

    // 拉取测试任务信息（仅解析一次，后续埋点与确认接口校验复用，避免重复网络/IO）。
    // 失败不影响主流程，缺失时留空。
    const taskInfoResult = await resolveTaskInfoOrNull(filePath);
    let taskTestTaskNo = '';
    let taskSubTestTaskId = '';
    if (taskInfoResult.status === 'ok') {
        taskTestTaskNo = taskInfoResult.taskInfo.testTaskNo || '';
        taskSubTestTaskId = taskInfoResult.taskInfo.subTestTaskId || '';
    }

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
    // 删除前的两道校验（任一不通过即**阻断删除**，与编辑器内删除行为一致）：
    //   1. 测试任务绑定校验：文件必须已绑定测试任务，否则无法定位要删除哪些线上案例。
    //      （走到此处时 nonEmptyIds.length > 0，即文件内存在 testcase_id，可能线上已有数据；
    //        若全为本地未推送行，已在上方 nonEmptyIds.length === 0 分支提前放行。）
    //   2. 线上预检（删除确认接口）：存在带执行/缺陷关联的案例（type=2）时，
    //      用独立 webview 弹窗以表格形式展示；否则走无表格的简单确认。
    // 预检异常（网络 / 返回非成功码）同样阻断删除，由 did 阶段弹插件封装的模态框。
    let confirmItems: DeleteConfirmItem[] = [];
    try {
        const tInfo = taskInfoResult;
        // 校验 1：未绑定测试任务 / 任务信息获取失败 → 阻断删除
        if (tInfo.status !== 'ok') {
            const _errTxt = tInfo.status === 'unbound'
                ? '当前文件未绑定测试任务，无法定位线上案例，请先绑定测试任务后再删除。'
                : (tInfo.errorMessage || '获取测试任务信息失败');
            if (pending) {
                pending.needRestore = true;
                pending.restoreTableData = tableData;
                pending.restoreSourceData = sourceData;
                pending.total = nonEmptyIds.length;
                pending.successCount = 0;
                pending.deletedSuccess = 0;
                pending.deletedSourceMissing = 0;
                pending.syncedTsIds = [];
                pending.failures = [];
                pending.error = _errTxt;
                pending.reportable = false;
                pending.precheckScenePrefix = '删除前校验未通过';
            }
            return;
        }
        if (!extContext) {
            // 扩展上下文缺失，无法调用线上接口：同样阻断，避免"本地删了线上还在"
            if (pending) {
                pending.needRestore = true;
                pending.restoreTableData = tableData;
                pending.restoreSourceData = sourceData;
                pending.total = nonEmptyIds.length;
                pending.successCount = 0;
                pending.deletedSuccess = 0;
                pending.deletedSourceMissing = 0;
                pending.syncedTsIds = [];
                pending.failures = [];
                pending.error = '扩展上下文未初始化，无法调用线上删除接口';
                pending.reportable = false;
                pending.precheckScenePrefix = '删除前校验未通过';
            }
            return;
        }
        {
            const resp = await withTimeout(
                confirmDeleteTestCase(extContext, tInfo.taskInfo, nonEmptyIds),
                PRECHECK_TIMEOUT_MS,
                () => new PrecheckTimeoutError(PRECHECK_TIMEOUT_MS),
            );
            if (resp.returnCode === 'SUC0000' && Array.isArray(resp.body)) {
                confirmItems = resp.body
                    .filter((it: any) => Number(it?.type) === 2)
                    .flatMap((it: any) => {
                        const sid = String(it?.sourceId ?? '').trim();
                        const list = Array.isArray(it?.data) ? it.data : [];
                        return list.map((d: any) => ({
                            sourceId: String(d?.sourceId ?? sid).trim(),
                            testCaseNo: String(d?.testCaseNo ?? '').trim(),
                            testCaseName: String(d?.testCaseName ?? '').trim(),
                            hasExec: String(d?.hasExec ?? 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
                            hasBug: String(d?.hasBug ?? 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
                        }));
                    })
                    .filter((it: DeleteConfirmItem) => !!it.sourceId);
            } else {
                // 删除确认接口返回非成功码：标记 needRestore 中止物理删除并还原文件；
                // reportable=false 避免 did 阶段再弹一个空的「删除结果」modal；
                // 弹窗**不**在这里同步弹出 —— onWillDeleteFiles 阶段创建 webview panel
                // 会被随后 did 阶段 file.unlink + restoreCaseFile + reopenCaseFile 流程
                // 抢焦点/顶掉，实际表现为「用户看不到任何弹窗」。
                // 改为由 did 阶段在文件重建完成后再用插件封装的 showModal('default', ...) 弹出。
                // 弹窗文案会单独展示「返回码：xxx」与「错误信息：yyy」两行，
                // 与编辑器内删除的弹窗格式（见 editorMessageHandlers.handleConfirmDeleteRows）保持一致。
                if (pending) {
                    pending.needRestore = true;
                    pending.restoreTableData = tableData;
                    pending.restoreSourceData = sourceData;
                    pending.total = nonEmptyIds.length;
                    pending.successCount = 0;
                    pending.deletedSuccess = 0;
                    pending.deletedSourceMissing = 0;
                    pending.syncedTsIds = [];
                    pending.failures = [];
                    // 错误信息只保留后端 errorMsg（无则用占位文案），不与 returnCode 拼接
                    pending.error = resp.errorMsg || '请稍后重试或联系管理员';
                    // 返回码非空时单独保存，did 阶段弹窗按「返回码：xxx」格式展示
                    if (resp.returnCode) pending.precheckReturnCode = String(resp.returnCode).trim();
                    pending.reportable = false;
                    pending.precheckScenePrefix = '删除前校验未通过';
                }
                return;
            }
        }
    } catch (ce) {
        // 确认接口超时（超过 PRECHECK_TIMEOUT_MS）：单独上报埋点，便于监控慢接口；
        // 后续仍按「预检异常」统一处理（needRestore=true，did 阶段重建文件、阻断删除）。
        if (ce instanceof PrecheckTimeoutError) {
            TelemetryService.sendTelemetryErrorEvent('caseFileDelete.precheck.timeout', {
                filePath: path.basename(filePath),
                timeoutMs: String(PRECHECK_TIMEOUT_MS),
                caseCount: String(nonEmptyIds.length),
            });
        }
        // 预检失败（网络 / 解析 / 后端 5xx 异常）：标记 needRestore=true、reportable=false
        // 中止物理删除并由 did 阶段重建文件；弹窗延后到 did 阶段文件重建完成后再弹，
        // 避免在 onWillDeleteFiles 阶段同步创建 webview panel 被后续流程抢焦点/覆盖。
        const _errMsg = ce instanceof Error ? ce.message : String(ce || '');
        if (pending) {
            pending.needRestore = true;
            pending.restoreTableData = tableData;
            pending.restoreSourceData = sourceData;
            pending.total = nonEmptyIds.length;
            pending.successCount = 0;
            pending.deletedSuccess = 0;
            pending.deletedSourceMissing = 0;
            pending.syncedTsIds = [];
            pending.failures = [];
            pending.error = _errMsg || '删除确认接口调用失败';
            pending.reportable = false;
            pending.precheckScenePrefix = '删除前校验异常';
        }
        return;
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

    // ★ 竞态守卫：确认接口响应较长时，VSCode 内部 waitUntil 超时会先强制放行物理删除，
    // 此时 onDidDeleteFiles 已消费 willDeleteResults 条目并把文件重建回来；
    // 而本 will handler 仍在继续（token 若未被取消，用户甚至可能在随后弹出的确认框里点"确定"）。
    // 若不加守卫，会走到 syncDeletedRows 真实调用线上删除接口，造成
    // 「线上案例已删除、本地文件却已被重建保留」的数据不一致。
    // 因此：条目已被 did 阶段消费（不在 map 中）即中止，不再触碰线上数据。
    if (!willDeleteResults.has(filePath)) {
        console.warn('[workspaceListeners] will 阶段检测到条目已被 did 消费（文件已重建），中止线上删除:', path.basename(filePath));
        TelemetryService.sendTelemetryErrorEvent('caseFileDelete.willAbortedAfterDid', {
            filePath: path.basename(filePath),
            caseCount: String(nonEmptyIds.length),
        });
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
            // 统一走 cleanupCaseFileTraces（与「通过要点删除清空案例文件」共用同一清理清单）。
            // 同时清理删前备份（删除已成功，备份不再需要）。
            if (willResult.backupPath) {
                fs.promises.unlink(willResult.backupPath).catch(() => { /* ignore */ });
            }
            const cleanupTask = cleanupCaseFileTraces(fp);
            if (willResult.reportable) {
                cleanupTask.then(() => showDeleteResultModal(willResult));
            }
            return;
        }

        // needRestore=true：把文件重建回来
        if (willResult.isUserCancel) {
            // ★ 用户取消：重建回原状
            await restoreCaseFile(fp, willResult);
            console.log('[workspaceListeners] 用户取消 → 文件已重建回原状:', path.basename(fp));
            // 需求 1：若删除前文件处于"已打开"状态，重建后自动重新打开，避免"文件被关掉"
            if (willResult.wasOpen) {
                await reopenCaseFile(fp);
            }
            // 区分两种取消：
            //   (a) 用户在「删除确认弹窗」里点取消/关闭 —— 已交互过，无需重复提示；
            //   (b) 确认弹窗「尚未显示」就被 token 取消（进度条 Cancel / waitUntil 超时），
            //       用户从未看到任何确认弹窗，此时应给一个明确反馈，避免"文件还在但毫无提示"的困惑。
            if (willResult.cancelledBeforeConfirm) {
                try {
                    showModal('default', 'info', '提示',
                        '已取消删除操作，文件已保留。\n\n如仍需删除，请重新执行删除操作。');
                } catch (_) { /* ignore */ }
            }
            // 不清理任何缓存（文件回到原状）
            return;
        }

        // ★ 中断占位兜底：onWillDeleteFiles 阶段的 waitUntil 被 VSCode 内部超时强制放行，
        // 导致 handleCaseFileWillDelete 在"预检完成前"就被中断，willDeleteResults 仍停留在
        // 入口占位状态（needRestore=true，但 error/isUserCancel/precheckScenePrefix 全空、
        // total=0、failures=[]）。此时文件已被强制物理删除、随后由下方 restoreCaseFile 重建回来，
        // 但用户既没收到确认弹窗、也没收到任何结果反馈（静默重建）——这正是「文件重建了但没弹窗」的根因。
        // 此处显式识别该场景，重建文件后补一个独立 webview 模态框告知用户「删除前校验未完成/被中断」，
        // 与下方「删除前校验失败/异常」弹窗保持一致的样式与文案风格。
        const isInterruptedPlaceholder =
            !willResult.error &&
            !willResult.precheckScenePrefix &&
            willResult.total === 0 &&
            willResult.failures.length === 0;
        if (isInterruptedPlaceholder) {
            await restoreCaseFile(fp, willResult);
            console.warn('[workspaceListeners] 删除前校验被中断（waitUntil 超时强制放行）→ 文件已重建回原状:', path.basename(fp));
            TelemetryService.sendTelemetryErrorEvent('caseFileDelete.precheck.interrupted', {
                filePath: path.basename(fp),
            });
            try {
                showModal('default', 'warning', '提示',
                    '删除前校验未完成，已取消删除操作，文件已保留。\n\n如仍要删除，请稍后重试。');
            } catch (_) { /* ignore */ }
            if (willResult.wasOpen) {
                await reopenCaseFile(fp);
            }
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

        // ★ 删除前校验失败/异常场景：在文件重建 + 重开完成后再用插件封装的
        //   showModal('default', ...) 弹出独立 webview 模态框（与用户提供的样例一致）。
        //   不在 onWillDeleteFiles 阶段同步弹的原因：那时创建 webview panel
        //   会被随后 file.unlink + restoreCaseFile + reopenCaseFile 抢焦点/覆盖。
        if (willResult.precheckScenePrefix && willResult.error && !willResult.isUserCancel) {
            // 文案格式与「编辑器内删除」弹窗（editorMessageHandlers.handleConfirmDeleteRows）保持一致：
            //   - 有 returnCode → "返回码：xxx\n错误信息：yyy"（参考用户样例截图）
            //   - 无 returnCode（网络/解析异常）→ "错误信息：yyy"（与编辑器内 catch 分支同款）
            const _rcPart = willResult.precheckReturnCode
                ? `返回码：${willResult.precheckReturnCode}\n错误信息：${willResult.error}`
                : `错误信息：${willResult.error}`;
            showModal('default', 'warning', '提示',
                `${willResult.precheckScenePrefix}，已取消删除操作。\n\n${_rcPart}`);
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
            // 用插件封装的独立 webview 模态框（文件已不存在，无面板可承载内嵌 modal）
            try {
                showModal('default', 'error', '取消失败',
                    `取消失败：原文件已被删除且重建失败 —— ${path.basename(fp)}。\n\n请前往垃圾箱恢复。`);
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
    // 优先用删前同步备份恢复（保留原始字节与格式，最可靠）；
    // 备份缺失/拷贝失败时降级为 parser.save 重建（与旧逻辑一致）。
    if (result.backupPath && fs.existsSync(result.backupPath)) {
        await fs.promises.copyFile(result.backupPath, filePath);
        try { await fs.promises.unlink(result.backupPath); } catch { /* ignore */ }
        TelemetryService.sendTelemetryEvent('caseFileDelete.restore.done', {
            failedRows: String(result.failures.length),
            filePath: path.basename(filePath),
            via: 'backup',
        });
        return;
    }
    const fileType = detectFileType(filePath);
    if (!fileType) return;
    if (!result.restoreTableData) return; // 拦截异常场景，无法重建
    const parser = createParser(fileType);
    await parser.save(filePath, result.restoreTableData, result.restoreSourceData);
    TelemetryService.sendTelemetryEvent('caseFileDelete.restore.done', {
        failedRows: String(result.failures.length),
        filePath: path.basename(filePath),
        via: 'parser',
    });
}

/**
 * 弹出"删除结果"反馈：
 *   - 全部成功（文件已被物理删除，无承载页面）：用插件封装的**独立 webview 模态框**
 *     （showModal('default', ...)），与其余插件弹窗样式一致。
 *   - 部分/全部失败（needRestore=true，文件已被 restoreCaseFile 重建）：
 *     重新以案例编辑器打开该文件 → 等待 webview ready → postMessage 到 panel 内 modal
 *     （与"编辑器内右键删除案例行"、"推送案例结果"完全一致的弹窗形态）
 */
async function showDeleteResultModal(r: WillDeleteResult): Promise<void> {
    try {
        const failCount = r.failures.length;

        // 场景 A：全部成功 / 整文件级失败 —— 文件已被删除，无承载页面，用独立 webview 模态框
        if (failCount === 0 && !r.needRestore) {
            if (r.error) {
                showModal('default', 'error', '删除失败',
                    `删除失败：${r.fileName}\n\n${r.error}`);
            } else if (r.successCount > 0) {
                const _hint = r.deletedSourceMissing > 0
                    ? `\n（其中 ${r.deletedSourceMissing} 条线上本不存在，已同步清理）`
                    : '';
                showModal('default', 'success', '删除成功',
                    `删除成功：${r.fileName}\n共 ${r.successCount} 条全部删除成功。${_hint}`);
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
        // 兜底：用插件封装的独立 webview 模态框告知（与其余插件弹窗样式一致）
        try {
            showModal('default', 'error', '删除结果',
                `删除结果反馈异常：${r.fileName}\n\n${err?.message || err || '未知错误'}`);
        } catch (_) { /* ignore */ }
    }
}