/**
 * ============================================================================
 *  providers/BaseEditorProvider.ts
 *  自定义编辑器框架
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 实现 vscode.CustomEditorProvider 接口，为 CSV/YAML/JSON 三种文件提供统一编辑器能力。
 *    2. 为每个 webview panel 独享一份 EditorSession，避免多个 Tab 共享单例状态。
 *    3. 定义 PushStrategy 接口 + PushViaHttpClient 实现，接管「推送测试案例」主流程。
 *    4. 接收前端消息（init/save/pushTestCase/openTextEditor）并派发。
 *    5. 抽象出 resolveFile / getErrorMessage / formatTypeName / pushStrategy 供子类定制。
 *  子类：
 *    - UnifiedEditorProvider：全局唯一实现，复用 FileTypeChecker 与 PushViaHttpClient。
 *  关键设计：
 *    - resolveCustomEditor 里调用 workbench.action.keepEditor，避免「预览 Tab」被互相覆盖。
 *    - cachedTableData 作为可见性变化时的快照，避免反复重解。
 *    - testcase_id 由 ensureTrackingColumns 代为生成，生成后立即 save 落盘，保证推送响应能匹配。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce, isInQualifiedDir, buildErrorHtml, FILE_PATTERNS, TS_ID_COLUMN, escapeHtml, formatLogTime } from '../services/utils';
import { getCurrentTaskInfo, type CurrentTask } from '../utils/commands';
import { showPushErrorModal, showPushResult, showPushDone, showModal } from '../utils/message';
import { clearHighlight } from '../utils/highlightStore';
import { createParser, ensureTrackingColumns, type FileType } from '../parsers';
import { TelemetryService } from '../utils/telemetry';
import { buildErrorProps } from '../services/utils';
import { runPush } from '../handlers/pushCore';
import { type EditorSession } from '../services/diffHighlight';
import { WebviewDataPusher, type PrefetchResult } from '../services/webviewDataPusher';
import { FileWatchService } from '../services/fileWatchService';
import { dispatchEditorMessage, type EditorMsgCtx } from '../handlers/editorMessageHandlers';

// 重新导出工具，便于子类使用
export { isInQualifiedDir, FILE_PATTERNS };
// 重新导出 EditorSession，兼容原有从 BaseEditorProvider 引用该类型的调用方
export type { EditorSession } from '../services/diffHighlight';

// ============================================
// 推送策略
// ============================================

export interface PushContext {
    /** 当前打开的会话；用于推送成功后回写 testCaseNo 到原文件 */
    session: EditorSession;
    /** 当前文件路径 */
    filePath: string;
    /** 推送成功后请求重新解析并下发数据给前端 */
    refresh: (reason: string) => Promise<void>;
    /**
     * 前端选中行 testcase_id -> 表格中真实的 1-based 行号 映射。
     * 失败弹窗显示「第 X 行」时优先使用此映射，避免按推送数组下标导致行号错位。
     */
    rowIndexMap?: Record<string, number>;
    /**
     * 按 payload 数组下标 -> 表格 1-based 行号 的兜底映射。
     * 当行的 testcase_id 为空（首次推送场景）时，rowIndexMap 不会建键，
     * 此时通过 body[i] 与 pushIndexToRow[i] 的顺序对齐仍可定位失败行号。
     */
    pushIndexToRow?: number[];
    /**
     * 通知自保存防抖时间戳（推送回写 testCaseNo 到文件前调用），
     * 防止推送写盘触发的 fsWatcher 在 pushSuccess 刷新期间覆盖高亮状态。
     */
    markSelfSave?: () => void;
}

export interface PushStrategy {
    push(
        data: any,
        ctx: PushContext,
        webviewPanel: vscode.WebviewPanel,
        extensionContext?: vscode.ExtensionContext
    ): Promise<void>;
}

export class PushViaHttpClient implements PushStrategy {
    async push(
        data: any,
        ctx: PushContext,
        webviewPanel: vscode.WebviewPanel,
        extensionContext?: vscode.ExtensionContext
    ): Promise<void> {
        if (!extensionContext) throw new Error('ExtensionContext 不可用，无法推送');
        const baseName = path.basename(ctx.filePath);
        const _ext = path.extname(ctx.filePath).toLowerCase();

        const pushData = await this.rebuildPushDataFromDisk(data, ctx, _ext);

        // 委托给公共核心 handlers/pushCore.ts 的 runPush：
        // - 校验/过滤/后端调用/回写快照/汇总失败等重合逻辑全部在核心内完成；
        // - 编辑器场景独有的 UI 反馈（webview postMessage / 高亮清空 / 刷新 webview）通过 hooks 注入。
        // 编辑器内推送 pushData 仅包含前端选中行，因此 resolveRowIndex 必须使用 ctx.pushIndexToRow[i]（
        // payload 数组下标 -> 主表 1-based 行号）；缺失时兜底 i+1，与占位 TESTCASE_ID 校验保持一致。
        await runPush({
            extensionContext,
            filePath: ctx.filePath,
            rows: pushData,
            resolveRowIndex: (i: number) => {
                const arr = ctx.pushIndexToRow;
                if (Array.isArray(arr) && typeof arr[i] === 'number' && arr[i] > 0) return arr[i];
                return i + 1;
            },
            frontRowIndexMap: ctx.rowIndexMap,
            frontPushIndexToRow: ctx.pushIndexToRow,
            parser: ctx.session.parser,
            telemetryPrefix: 'editorPush',
            hooks: this.buildRunPushHooks(ctx, webviewPanel, baseName),
        });
    }

    /**
     * 编辑器场景独有：用文件源数据覆盖前端渲染文本，避免嵌套字段推送成 "[2 项]" 之类显示文本。
     * 前端 table 中嵌套对象/数组字段被渲染为显示文本（如 "[2 项]"），
     * 但文件落盘时 parser.save 通过 reconstructDetail 保留了正确结构。
     * 此处重新 parse 并用 testcase_id 匹配，确保推送的是原始数据而非显示文本；
     * 解析失败时回退到前端提交的数据，保证推送流程仍可进行（并发送埋点）。
     */
    private async rebuildPushDataFromDisk(data: any, ctx: PushContext, ext: string): Promise<any[]> {
        let pushData: any[] = Array.isArray(data) ? data : [];
        try {
            const parsed = await ctx.session.parser.parse(ctx.filePath);
            const sourceRecords: any[] = Array.isArray(parsed.sourceData)
                ? parsed.sourceData
                : (parsed.sourceData ? [parsed.sourceData] : []);

            const sourceByTsId = new Map<string, any>();
            sourceRecords.forEach((rec: any) => {
                const id = rec?.[TS_ID_COLUMN];
                if (id != null && id !== '') sourceByTsId.set(String(id), rec);
            });

            if (Array.isArray(data)) {
                let replacedCount = 0;
                pushData = data.map((rec: any) => {
                    const tsId = rec?.[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
                    if (tsId && sourceByTsId.has(tsId)) {
                        replacedCount++;
                        return sourceByTsId.get(tsId);
                    }
                    return rec; // 回退：新行可能尚未写入文件
                });
                console.log(`[推送] 已用文件源数据替换 ${replacedCount} 行，共 ${pushData.length} 行`);
            }
        } catch (parseErr: any) {
            console.warn('[推送] 重新解析文件失败，使用前端数据兜底:', parseErr?.message || parseErr);
            TelemetryService.sendTelemetryErrorEvent('editorPush.reparseFailed', buildErrorProps(parseErr, { ext }));
        }
        return pushData;
    }

    /**
     * 构造 runPush 需要的完整 hooks 集：
     * - 弹窗 + pushError 消息组合的错误钩子（占 7/9 个）通过 postWebviewError 统一处理，避免重复样板；
     * - 写盘/快照/完成三类副作用钩子仍独立编写，方便看清与 session/webview 的具体交互点。
     */
    private buildRunPushHooks(
        ctx: PushContext,
        webviewPanel: vscode.WebviewPanel,
        baseName: string,
    ): NonNullable<Parameters<typeof runPush>[0]['hooks']> {
        // 「弹窗 + 通知前端 pushError」组合是所有校验/网络类失败钩子的共同模式，
        // 抽出为闭包避免在 7 个钩子里重复写「showPushErrorModal + postMessage」两行。
        // modalMessage 可选：弹窗需要更完整的用户引导文案时传入；不传则复用 message。
        const postWebviewError = (
            message: string,
            mode: 'modal' | 'result' = 'modal',
            failures?: any[],
            modalMessage?: string,
        ) => {
            if (mode === 'result' && failures) {
                showPushResult(webviewPanel, baseName, 0, failures, failures.length);
            } else {
                showPushErrorModal(webviewPanel, baseName, modalMessage ?? message);
            }
            webviewPanel.webview.postMessage({ type: 'pushError', message });
        };

        return {
            onUnbound: () => postWebviewError(
                '未绑定任务，无法推送',
                'modal',
                undefined,
                '未绑定任务，无法推送。请在测试任务插件绑定后再试。',
            ),
            // 校验类失败：需要在弹窗中列出具体行号，交给 showPushResult 而非 modal
            onPlaceholderTestcaseId: (failures) =>
                postWebviewError('testcase_id 为占位值 TESTCASE_ID，不允许推送', 'result', failures),
            onEmptyTestcaseId: (failures) =>
                postWebviewError('testcase_id 不能为空', 'result', failures),
            onOnlySampleRows: (failures) =>
                postWebviewError('为样例数据，不允许推送', 'result', failures),
            // 网络/后端类失败：直接弹 modal
            onTaskInfoFailed: (errorMsg) => postWebviewError(errorMsg),
            onBackendError: (errorMsg) => postWebviewError(errorMsg),
            onUnexpectedError: (errorMsg) => postWebviewError(errorMsg),
            onWriteBackFailed: (errorMsg) => {
                // 后端已成功但 testCaseNo 未能写回：追加一个警告弹窗，避免用户无感知重复推送。
                // 注意：此处不发 pushError，避免覆盖后续 onComplete 的成功摘要。
                showModal(webviewPanel, 'warning', '案例编号回写失败',
                    `${baseName}\n\n后端推送已成功，但案例编号未能写回本地文件。请稍后手动刷新或重新打开文件。\n\n错误信息：${errorMsg}`);
            },
            markSelfSave: () => ctx.markSelfSave?.(),
            afterWriteBack: async ({ parsedSourceData, hasFailure }) => {
                // 快照已是全量基线，旧高亮信息无需保留 → 清空
                ctx.session.highlightedCells = null;
                await clearHighlight(ctx.filePath);
                // 落盘后让缓存失效，下次可见切换 / 手动刷新时自动重读最新文件
                ctx.session.cachedTableData = null;
                ctx.session.originalSourceData = parsedSourceData;
                // 有失败项时跳过刷新，避免刷新触发的 renderTable() 擦除失败行高亮
                if (!hasFailure) {
                    await ctx.refresh('pushSuccess');
                }
            },
            onAllFailedSnapshot: async () => {
                // 全部推送失败：核心已更新快照基线，此处只需清空前端高亮状态
                ctx.session.highlightedCells = null;
                await clearHighlight(ctx.filePath);
                ctx.session.cachedTableData = null;
            },
            onComplete: ({ successCount, failures, total }) => {
                // 编辑器内推送：直接复用前端 webview 弹窗（同一个 panel 内嵌）
                showPushResult(webviewPanel, baseName, successCount, failures, total);
                showPushDone(webviewPanel);
                webviewPanel.webview.postMessage({
                    type: 'pushResult',
                    fileName: baseName,
                    successCount,
                    failures,
                    total,
                });
                // 通知前端推送流程已完成（用于隐藏 loading 之类的状态）
                webviewPanel.webview.postMessage({ type: 'pushDone' });
            },
        };
    }
}

// ============================================
// 基础编辑器 Provider
// ============================================

/**
 * 静态注册表条目：跟踪每个已打开 webview panel 的 ready 状态。
 * - panel：webview panel 实例
 * - ready：webview 收到 init 消息后 resolve 的 Promise（前端就绪）
 * - markReady：在 init 消息处理处调用，将 ready resolve
 * - refresh：由外部（如资源管理器右键推送）触发的重新解析 + 差异比对刷新（等同 pushDataToWebview）
 * - markSelfSave：由外部（如右键推送写盘前后）打自保存时间戳，避免 fsWatcher 自反弹
 * - clearHighlightState：由外部（推送成功/全部失败）清空前端高亮基线（session.highlightedCells）
 */
interface PanelEntry {
    panel: vscode.WebviewPanel;
    ready: Promise<void>;
    markReady: () => void;
    /**
     * 主动触发一次数据推送。
     * @param clearAllMods true 时在 full-data 消息中携带 clearAllMods 标志，前端会
     *   无条件清空 S.mods / _detailModCellKeys / _history / _future / _addedRowSet /
     *   _lastPushBatch，用于"整文件一次性提交"语义（如资源管理器右键推送），
     *   避免与 pushSuccess 帧默认的"选择性保留 mods"策略冲突。
     */
    refresh?: (reason: string, force?: boolean, clearAllMods?: boolean) => Promise<void>;
    markSelfSave?: () => void;
    clearHighlightState?: () => void;
}

export abstract class BaseEditorProvider implements vscode.CustomEditorProvider {
    private onDidChangeCustomDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();
    protected context: vscode.ExtensionContext | undefined;

    /**
     * 已打开的 testcase 编辑器 panel 注册表（按 filePath 索引）。
     * 用于资源管理器右键推送时定位到对应 webview，把推送结果直接 post 给该 webview 弹窗显示。
     * 同一文件可在多个 tab group 中独立打开，但右键推送只针对单文件，取最后注册的一个即可。
     */
    private static panelMap: Map<string, PanelEntry> = new Map();

    /** 查询某文件是否已被 testcase 编辑器打开 */
    static getPanel(filePath: string): vscode.WebviewPanel | undefined {
        return BaseEditorProvider.panelMap.get(filePath)?.panel;
    }

    /** 更新 panelMap 中的键值（文件重命名时调用） */
    static updatePanelMapKey(oldPath: string, newPath: string): void {
        const entry = BaseEditorProvider.panelMap.get(oldPath);
        if (entry) {
            BaseEditorProvider.panelMap.delete(oldPath);
            BaseEditorProvider.panelMap.set(newPath, entry);
        }
    }

    /** 等待 webview 完成 init（已 ready 的立即 resolve） */
    static waitReady(filePath: string, timeoutMs = 5000): Promise<void> {
        const entry = BaseEditorProvider.panelMap.get(filePath);
        if (!entry) return Promise.reject(new Error('panel 未注册: ' + filePath));
        return Promise.race([
            entry.ready,
            new Promise<void>((_, reject) =>
                setTimeout(() => {
                    TelemetryService.sendTelemetryErrorEvent('editor.waitReady.timeout', { targetFile: filePath });
                    reject(new Error('等待 webview 就绪超时'));
                }, timeoutMs)
            ),
        ]);
    }

    /**
     * 供资源管理器右键推送等外部入口调用：
     * 推送成功回写 testCaseNo 到磁盘之后，
     * 通知已打开的 webview panel 清空旧高亮基线并重新走 pushSuccess 差异比对流程。
     *
     * 使用时机：
     *   - 由外部推送流程在写盘 markSelfSave 完成后调用；
     *   - 若目标文件未被 testcase 编辑器打开（panel 不存在），本函数为 no-op。
     *
     * 与编辑器内推送 hooks（afterWriteBack/onAllFailedSnapshot）等价：
     *   1. 清空 session.highlightedCells 与 highlightStore（避免旧的黄色残留）；
     *   2. 触发 refresh('pushSuccess')，让 pushDataToWebview 内部重新 diff 快照并下发新高亮，
     *      同时前端会拿到最新的 pushFailures 进行红色失败标记。
     *
     * @param filePath   目标文件绝对路径
     * @param hasFailure 是否存在推送失败（有失败时也走 pushSuccess，让前端统一按 diff 结果重绘高亮）
     */
    static async postExplorerPushRefresh(filePath: string, _hasFailure: boolean): Promise<void> {
        const entry = BaseEditorProvider.panelMap.get(filePath);
        if (!entry) return;
        // 直接走 pushSuccess 通道且携带 clearAllMods=true：
        //   1) pushDataToWebview 会重新 parse + diffPushSnapshot，并将最新 highlightedCells
        //      （无差异时为 null）同步到 session、highlightStore 与前端，
        //      因此无需再手动 clearHighlightState / clearHighlight（这两项会被后续流程覆盖）。
        //   2) full-data 帧带上 clearAllMods=true 后，前端将无条件清空
        //      S.mods / _detailModCellKeys / _history / _future / _addedRowSet / _lastPushBatch，
        //      避免 pushSuccess 帧默认的"选择性保留 mods"策略导致小三角残留，
        //      根治以往"关闭推送弹窗后修改高亮复现"的时序问题，
        //      不再需要 pre/post 两次 clearMods 夹住中间帧的兼底写法。
        //   注意 _pushFailedTsIds / _userMarks 等不受影响，与编辑器内推送成功后的行为一致。
        try {
            await entry.refresh?.('pushSuccess', true, true);
        } catch (e: any) {
            console.warn('[postExplorerPushRefresh] refresh pushSuccess failed:', e?.message || e);
        }
    }

    /** 供外部推送流程在写盘前后调用，避免 fsWatcher 自反弹覆盖高亮状态 */
    static markPanelSelfSave(filePath: string): void {
        const entry = BaseEditorProvider.panelMap.get(filePath);
        if (!entry) return;
        try { entry.markSelfSave?.(); } catch (_) { /* ignore */ }
    }

    constructor(protected extensionUri: vscode.Uri, context?: vscode.ExtensionContext) {
        this.context = context;
    }

    get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentEditEvent<vscode.CustomDocument>> {
        return this.onDidChangeCustomDocumentEmitter.event;
    }

    async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} } as vscode.CustomDocument;
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // 使用 let 定义 filePath，使其可在文件重命名时更新
        let filePath = document.uri.fsPath;
        const fileName = filePath.split(path.sep).pop() || '';
        // panel 唯一 ID，便于在多 tab 场景下区分日志
        const panelId = `${fileName}#${Math.random().toString(36).slice(2, 8)}`;
        // 带毫秒时间戳的日志，方便比对前后端事件先后顺序
        const log = (...args: any[]) => {
            console.log(`[TC-EDITOR][${formatLogTime()}][${panelId}]`, ...args);
        };
        const nonce = getNonce();

        log('▶ open', filePath);

        // ⚠ 关键修复：单击文件打开时，VS Code 默认进入"预览 Tab"模式，
        // 同一个预览位仅保留 1 个，新文件会替换旧文件 → 视觉表现为"始终只有一个 tab"。
        // 调用 workbench.action.keepEditor 立即把当前 tab 固化为永久 tab，
        // 这样后续单击其他文件会新开 tab，而不是替换当前 tab。
        try {
            await vscode.commands.executeCommand('workbench.action.keepEditor');
        } catch (e: any) {
            TelemetryService.sendTelemetryErrorEvent('editor.keepEditor.failed', buildErrorProps(e));
        }

        // 先识别文件类型；不合格直接展示错误页
        const resolved = this.resolveFile(document.uri);
        webviewPanel.title = fileName + ' - 测试案例编辑器';
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };

        if (!resolved.qualified || !resolved.type) {
            TelemetryService.sendTelemetryEvent('editor.opened.unqualified', { targetFile: fileName });
            log('⚠ unqualified, render error page');
            webviewPanel.webview.html = buildErrorHtml(
                this.getErrorMessage(resolved.type),
                '不支持的文件',
                [
                    { label: '用文本编辑器打开', action: 'openTextEditor', primary: true }
                ]
            );
            webviewPanel.webview.onDidReceiveMessage(async (m: any) => {
                if (m?.type === 'openTextEditor') {
                    TelemetryService.sendTelemetryEvent('editor.unqualified.openText', { targetFile: fileName });
                    try { webviewPanel.dispose(); } catch (_) { /* ignore */ }
                    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                }
            });
            webviewPanel.onDidDispose(() => log('🗑 disposed (error page)'));
            return;
        }

        // 每个 panel 独享的会话状态：避免多 panel 共用单例时被覆盖
        const session: EditorSession = {
            type: resolved.type,
            parser: createParser(resolved.type),
            originalSourceData: null,
            cachedTableData: null,
        };

        // 注册到 panelMap：右键推送时可定位到该 webview 进行结果展示
        let markReady: () => void = () => {};
        const ready = new Promise<void>((resolve) => { markReady = resolve; });
        // refresh / markSelfSave / clearHighlightState 三个回调将在下方闭包定义完成后回填，
        // 用于让 BaseEditorProvider.postExplorerPushRefresh 等外部入口驱动本 panel 刷新高亮。
        const panelEntry: PanelEntry = { panel: webviewPanel, ready, markReady };
        BaseEditorProvider.panelMap.set(filePath, panelEntry);

        // ⚡ 预解析（Prefetch）：在 webview 脚本加载的同时并行解析文件，
        // 避免出现「webview 加载完 → 发 init → 才开始 parse」的串行等待延迟。
        // 等 init 消息到达时若 prefetch 已完成，则直接复用结果立即推送，显著缩短首屏数据展示时间。
        const _prefetchStart = Date.now();
        const prefetchPromise: Promise<PrefetchResult> =
            (async () => {
                try {
                    const result = await session.parser.parse(filePath);
                    const ensured = ensureTrackingColumns(result.tableData, result.sourceData);
                    log(`⚡ prefetch parse done dur=${Date.now() - _prefetchStart}ms rows=${(ensured.tableData?.rows || []).length} generated=${ensured.generated}`);
                    return { tableData: ensured.tableData, sourceData: result.sourceData, generated: ensured.generated };
                } catch (err: any) {
                    log('⚠ prefetch parse failed:', err?.message || err);
                    return null;
                }
            })();

        // 自身落盘后短时间内忽略外部变更通知，避免触发自我反弹刷新。
        // 守护期需覆盖：parser.save 写盘耗时 + fsWatcher / onDidSaveTextDocument 通知延迟 + 防抖 150ms。
        // 大文件 YAML 序列化 + 写盘可能 > 800ms，故放宽到 3 秒。
        let lastSelfSaveAt = 0;
        const SELF_SAVE_GUARD_MS = 3000;
        const markSelfSave = () => { lastSelfSaveAt = Date.now(); };

        // 数据推送器：封装 parse → diff → 组装 Data 帧 → postMessage 的完整流程
        const pusher = new WebviewDataPusher({
            webviewPanel,
            session,
            filePath,
            log,
            prefetchPromise,
            onSelfSave: markSelfSave,
        });
        const pushDataToWebview = (forceReparse: boolean, reason: string, force?: boolean, clearAllMods?: boolean) =>
            pusher.push(forceReparse, reason, force, clearAllMods);

        // 回填 panelEntry 的外部驱动 hook：
        //   - refresh：外部（如资源管理器右键推送）可复用编辑器内推送同一套 pushSuccess 差异比对通道；
        //   - markSelfSave：外部写盘前后打自保存时间戳，避免 fsWatcher 自反弹覆盖高亮；
        //   - clearHighlightState：外部推送成功/全部失败时清空 session 内的高亮基线。
        panelEntry.refresh = (reason: string, force?: boolean, clearAllMods?: boolean) => pushDataToWebview(true, reason, force, clearAllMods);
        panelEntry.markSelfSave = () => { lastSelfSaveAt = Date.now(); };
        panelEntry.clearHighlightState = () => {
            session.highlightedCells = null;
            session.cachedTableData = null;
        };

        // 监听 panel 可见性变化：每次切回为可见时都强制重新解析最新文件并静默覆盖前端，
        // 避免出现「外部修改未被监听捕获，导致切回 tab 仍是旧内容」的边缘情况。
        webviewPanel.onDidChangeViewState(async () => {
            if (!webviewPanel.visible) return;
            log('👁 visible -> reload from disk');
            try {
                // 自身刚落盘 800ms 内的可见切换没必要重读，缓存即为最新
                if (Date.now() - lastSelfSaveAt < SELF_SAVE_GUARD_MS) {
                    TelemetryService.sendTelemetryEvent('editor.visibleChange.skipped', { reason: 'selfSaveGuard', fileFormat: session.type });
                    await pushDataToWebview(false, 'visible');
                    return;
                }
                // 强制重新解析最新文件并下发；force=true 让前端绕过「未保存修改保护」直接覆盖
                session.cachedTableData = null;
                await pushDataToWebview(true, 'visible', true);
            } catch (err: any) {
                log('❌ visible-reload failed:', err?.message || err);
            TelemetryService.sendTelemetryErrorEvent('editor.visibleChange.failed', buildErrorProps(err, { fileFormat: session.type }));
                // 兜底：解析失败时仍按缓存推送一次，保证前端有数据
                try { await pushDataToWebview(false, 'visible'); } catch (_) { /* ignore */ }
            }
        });

        // ============ 监听文件外部变更（已抽出至 services/fileWatchService.ts）============
        // 服务内部封装：fsWatcher.onDidChange/Create + workspace.onDidSaveTextDocument
        // 自保存守护 + 150ms 防抖；外部仅需处理实际业务动作。
        const fileWatchSvc = new FileWatchService({
            filePath,
            fileFormat: session.type,
            log,
            getLastSelfSaveAt: () => lastSelfSaveAt,
            selfSaveGuardMs: SELF_SAVE_GUARD_MS,
            onExternalChange: (origin) => {
                // 不提前置空缓存：pushDataToWebview 内部会比对旧缓存与重解析结果，
                // 若 testCaseNo 列有变化则自动记录高亮并持久化。
                pushDataToWebview(true, 'externalChange:' + origin, true);
            },
        });

        webviewPanel.onDidDispose(() => {
            log('🗑 disposed');
            try { fileWatchSvc.dispose(); } catch (_) { /* ignore */ }
            try { renameSub.dispose(); } catch (_) { /* ignore */ }
            // 仅当当前 panel 仍是注册项时才移除（避免同一文件第二次 open 后误删新条目）
            const cur = BaseEditorProvider.panelMap.get(filePath);
            if (cur && cur.panel === webviewPanel) {
                BaseEditorProvider.panelMap.delete(filePath);
            }
        });

        // 监听文件重命名，更新内部 filePath 引用
        const renameSub = vscode.workspace.onDidRenameFiles((event) => {
            for (const file of event.files) {
                if (file.oldUri.fsPath === filePath) {
                    log(`🔄 文件重命名: ${filePath} -> ${file.newUri.fsPath}`);
                    filePath = file.newUri.fsPath;
                    // 同步更新 pusher / fileWatchSvc 内部的 filePath 引用，避免闭包老引用
                    pusher.updateFilePath(filePath);
                    fileWatchSvc.updateFilePath(filePath);
                    // 更新 panelMap 中的键值
                    BaseEditorProvider.updatePanelMapKey(file.oldUri.fsPath, filePath);
                }
            }
        });

        // ⚠ 关键：必须先绑定 onDidReceiveMessage 再设置 webview.html
        // 消息分发已抽出到 handlers/editorMessageHandlers.ts，通过表驱动方式处理各类消息，
        // 新增消息类型只需在 buildHandlers 中加一项，错误处理由 dispatchEditorMessage 内部统一兜底。
        const _headerLabelsSubs: vscode.Disposable[] = [];
        const msgCtx: EditorMsgCtx = {
            session,
            getFilePath: () => filePath,
            webviewPanel,
            documentUri: document.uri,
            log,
            pusher,
            onSelfSave: markSelfSave,
            onReady: () => { try { markReady(); } catch (_) { /* ignore */ } },
            registerHeaderLabelsSubs: (subs) => {
                _headerLabelsSubs.push(...subs);
            },
            pushStrategy: this.pushStrategy,
            extensionContext: this.context,
            typeName: this.formatTypeName(session.type),
        };
        webviewPanel.onDidDispose(() => {
            _headerLabelsSubs.forEach(d => { try { d.dispose(); } catch (_) { /* ignore */ } });
        });
        webviewPanel.webview.onDidReceiveMessage((msg: any) => dispatchEditorMessage(msg, msgCtx));

        // 表头展示：仅用 task-bindings.json 中的真实后端值；
        // 未绑定（或未命中）时三项为空串，由 buildEditorHtml 渲染为 "-"
        const currentTask = this.context
            ? await getCurrentTaskInfo(filePath)
            : { bind: false, taskInfo: {} as Record<string, never> };
        const info = currentTask.taskInfo as { testTaskNo?: string; testTaskName?: string; subTestTaskName?: string };
        const taskInfoForWebView = {
            bind: currentTask.bind,
            testTaskNo: info?.testTaskNo || '',
            testTaskName: info?.testTaskName || '',
            subTestTaskName: info?.subTestTaskName || ''
        }
        webviewPanel.webview.html = await this.buildEditorHtml(nonce, webviewPanel, session.type, taskInfoForWebView);
        log('✅ html ready');
    }

    /**
     * 构建 Webview HTML（从模板文件加载并替换占位符）
     */
    private async buildEditorHtml(
        nonce: string,
        webviewPanel: vscode.WebviewPanel,
        dataType: FileType,
        taskInfo: { bind: boolean, testTaskNo: string, testTaskName: string, subTestTaskName: string }
    ): Promise<string> {
        const msgType = `${dataType}Data`;

        const stylesUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'common', 'styles', 'table-editor.css')
        );
        // 表格编辑器脚本已按职能拆分到 editor/ 子目录下，按顺序加载等价于原 editor.js 单文件。
        // 注意：因函数声明在每个 <script> 内部独立提升（不跨脚本），文件加载顺序必须保持。
        //   01-core             —— 全局状态 S、日志、撤销/重做、init 入口、消息分发、通用工具
        //   02a-render          —— renderTable + 虚拟滚动 + 单元格 patchCell
        //   02b-bind            —— 工具栏 / 全局快捷键 / 表格事件委托绑定
        //   02c-row-cell-sel    —— 行号格 mousedown / 单元格 mousedown（行选 / 单元格矩形拖选）
        //   02d-sel-utils       —— 选区辅助、信息统计、推送按钮 / 仅看失败按钮 状态同步
        //   03a-cell-edit       —— 单元格编辑（双击进入编辑 / 提交 / 批量写入）
        //   03b-resize-colsel   —— 列宽拖动 / 列选择（Excel 风格） / 行高拖动
        //   03c-context-menu    —— 右键菜单（构造 / 显示 / 隐藏）
        //   03d-row-ops         —— 行操作（增 / 删 / 复制 / 推送）
        //   03e-mark            —— 用户标记 / 取消标记 / 颜色选择器
        //   03f-col-ops         —— 列操作（增 / 删 / 重命名）
        //   03g-clipboard       —— 单元格剪贴板 / 清空 / 批量填充
        //   03h-detail-helpers  —— 明细列辅助函数（_inferDetailColKind 等）
        //   04-push-find        —— 推送/保存、查找替换面板、Excel 风格列筛选
        //   05a-push-result     —— 推送结果弹窗（成功/失败明细 + 行联动）
        //   05b-prompt-confirm  —— 通用 Prompt / Confirm 弹窗（替代 sandbox 受限 API）
        //   05c-detail-modal    —— 明细弹窗（v2 双栏）主体 + 渲染
        //   05d-detail-write    —— 明细弹窗（v2）写操作（增删 step / 字段写入 / 保存）
        //   05e-array-editor    —— 数组列编辑器，并在末尾调用 init()
        const editorScriptFiles = [
            'editor/01-core.js',
            'editor/02a-render.js',
            'editor/02b-bind.js',
            'editor/02c-row-cell-sel.js',
            'editor/02d-sel-utils.js',
            'editor/03a-cell-edit.js',
            'editor/03b-resize-colsel.js',
            'editor/03c-context-menu.js',
            'editor/03d-row-ops.js',
            'editor/03e-mark.js',
            'editor/03f-col-ops.js',
            'editor/03g-clipboard.js',
            'editor/03h-detail-helpers.js',
            'editor/04-push-find.js',
            'editor/05a-push-result.js',
            'editor/05b-prompt-confirm.js',
            'editor/05c-detail-modal.js',
            'editor/05d-detail-write.js',
            'editor/05e-array-editor.js'
        ];
        const editorScriptsHtml = editorScriptFiles.map((rel) => {
            const uri = webviewPanel.webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'table-editor', ...rel.split('/'))
            );
            return `<script nonce="${nonce}" src="${uri.toString()}"></script>`;
        }).join('\n');
        const cspSource = webviewPanel.webview.cspSource;

        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'table-editor', 'index.html');
        const htmlBytes = await vscode.workspace.fs.readFile(htmlPath);
        const template = Buffer.from(htmlBytes).toString('utf8');

        // 未命中绑定时，表头三项统一展示占位符 "-"
        const PLACEHOLDER = '-';
        const safeTestTaskNo = escapeHtml(taskInfo?.testTaskNo || PLACEHOLDER);
        const safeTestTaskName = escapeHtml(taskInfo?.testTaskName || PLACEHOLDER);
        const safeSubTestTaskName = escapeHtml(taskInfo?.subTestTaskName || PLACEHOLDER);

        // 绑定状态标签：首行最左侧展示"已绑定任务 / 未绑定任务"
        const isBound = !!taskInfo?.bind;
        const bindStatusText = isBound ? '已绑定任务' : '未绑定任务';
        const bindStatusClass = isBound ? 'xs-bind-tag-on' : 'xs-bind-tag-off';

        return template
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace(/\{\{dataType\}\}/g, dataType)
            .replace(/\{\{msgType\}\}/g, msgType)
            .replace(/\{\{cspSource\}\}/g, cspSource)
            .replace(/\{\{stylesUri\}\}/g, stylesUri.toString())
            .replace(/\{\{editorScripts\}\}/g, editorScriptsHtml)
            .replace(/\{\{testTaskNo\}\}/g, safeTestTaskNo)
            .replace(/\{\{subTestTaskName\}\}/g, safeSubTestTaskName)
            .replace(/\{\{testTaskName\}\}/g, safeTestTaskName)
            .replace(/\{\{bindStatusText\}\}/g, escapeHtml(bindStatusText))
            .replace(/\{\{bindStatusClass\}\}/g, bindStatusClass);
    }

    // ==================== 抽象方法（子类实现） ====================

    /** 识别文件并返回是否合格及类型；不要在子类内保存状态 */
    protected abstract resolveFile(uri: vscode.Uri): { qualified: boolean; type: FileType | null };
    /** 错误信息：未识别类型时 type 为 null */
    protected abstract getErrorMessage(type: FileType | null): string;
    /** 类型友好名（用于日志/错误提示） */
    protected abstract formatTypeName(type: FileType): string;
    protected abstract pushStrategy: PushStrategy;

    // ==================== 接口方法（默认实现） ====================

    saveCustomDocument(): Promise<void> { return Promise.resolve(); }
    saveCustomDocumentAs(): Promise<void> { return Promise.resolve(); }
    revertCustomDocument(): Promise<void> { return Promise.resolve(); }
    backupCustomDocument(_doc: vscode.CustomDocument, ctx: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        return Promise.resolve({ id: ctx.destination.toString(), delete: () => {} });
    }
}


