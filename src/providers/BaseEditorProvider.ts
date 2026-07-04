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
import { getNonce, isInQualifiedDir, buildErrorHtml, FILE_PATTERNS, TS_ID_COLUMN, escapeHtml } from '../services/utils';
import { getCurrentTaskInfo, type CurrentTask } from '../utils/commands';
import { showPushErrorModal, showPushResult, showPushDone, showSaveResult, showModal } from '../utils/message';
import { setHighlight, clearHighlight } from '../utils/highlightStore';
import { getFailures } from '../utils/pushFailureStore';
import { diffPushSnapshot, type RowDiff, type DiffResult, type DeletedRowInfo, type AddedRowInfo } from '../utils/pushSnapshotStore';
import { markDeletedRows } from '../utils/deletedRowsStore';
import { getMarks, setMarks, clearMarks } from '../utils/markStore';
import { createParser, ensureTrackingColumns, type FileParser, type FileType } from '../parsers';
import { sendTelemetryEvent, sendTelemetryErrorEvent } from '../utils/telemetry';
import { getHeaderLabels, onHeaderLabelsChange } from '../utils/headerLabels';
import { stackHead } from '../services/utils';
import { runPush } from '../handlers/pushCore';

// 重新导出工具，便于子类使用
export { isInQualifiedDir, FILE_PATTERNS };

// ============================================
// 内部工具：把 addedInfos 展开为 (rowIdx, colIdx) 单元格清单
// ============================================
/**
 * 把 diffPushSnapshot 返回的 addedInfos（新增行）展开为逐单元格清单，
 * 用于把新增行也纳入 highlightedCells.cells，让新增行显示与"修改行"一致的黄色单元格高亮。
 *
 * 规则：
 *   - 跳过 testCaseNo 列（推送后台自动回写，不算用户输入）；
 *   - 跳过空值单元格（避免整行满行黄底、视觉噪声）；
 *   - 结果与 changedRows 展开的 flatCells 结构完全一致：Array<[rowIdx, colIdx]>。
 */
function expandAddedRowsToCells(
    addedInfos: AddedRowInfo[],
    tableData: { headers: string[]; rows: any[][] } | null | undefined,
): Array<[number, number]> {
    if (!addedInfos || addedInfos.length === 0 || !tableData) return [];
    const headers = tableData.headers || [];
    const rows = tableData.rows || [];
    const tcIdx = headers.indexOf('testCaseNo');
    const out: Array<[number, number]> = [];
    for (const info of addedInfos) {
        const ri = info.rowIndex;
        const row = rows[ri];
        if (!Array.isArray(row)) continue;
        for (let ci = 0; ci < headers.length; ci++) {
            if (ci === tcIdx) continue;
            const v = ci < row.length ? row[ci] : undefined;
            if (v == null) continue;
            const s = String(v);
            if (s === '') continue;
            out.push([ri, ci]);
        }
    }
    return out;
}

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

        // ---- 编辑器场景独有：用文件源数据覆盖前端渲染文本 ----
        // 前端 table 中嵌套对象/数组字段被渲染为显示文本（如 "[2 项]"），
        // 但文件落盘时 parser.save 通过 reconstructDetail 保留了正确结构。
        // 此处重新 parse 并用 testcase_id 匹配，确保推送的是原始数据而非显示文本。
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
                pushData = data.map((rec: any) => {
                    const tsId = rec?.[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
                    if (tsId && sourceByTsId.has(tsId)) {
                        return sourceByTsId.get(tsId);
                    }
                    return rec; // 回退：新行可能尚未写入文件
                });
                console.log(`[推送] 已用文件源数据替换 ${pushData.filter((_, i) => pushData[i] !== data[i]).length} 行，共 ${pushData.length} 行`);
            }
        } catch (parseErr: any) {
            console.warn('[推送] 重新解析文件失败，使用前端数据兜底:', parseErr?.message || parseErr);
            sendTelemetryErrorEvent('editorPush.reparseFailed', { ext: _ext, errorMessage: String(parseErr?.message || String(parseErr)).slice(0, 500), stackHead: stackHead(parseErr) });
        }

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
            hooks: {
                onUnbound: () => {
                    showPushErrorModal(webviewPanel, baseName,
                        '未绑定任务，无法推送。请在测试任务插件绑定后再试。');
                    webviewPanel.webview.postMessage({ type: 'pushError', message: '未绑定任务，无法推送' });
                },
                onPlaceholderTestcaseId: (failures) => {
                    // 弹窗展示"第 N 行"可点击跳转 + 通知前端解锁按钮 UI
                    showPushResult(webviewPanel, baseName, 0, failures, failures.length);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: 'testcase_id 为占位值 TESTCASE_ID，不允许推送' });
                },
                onEmptyTestcaseId: (failures) => {
                    // testcase_id 为空的行：与占位类校验展示一致，仅文案不同
                    showPushResult(webviewPanel, baseName, 0, failures, failures.length);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: 'testcase_id 不能为空' });
                },
                onOnlySampleRows: (failures) => {
                    showPushResult(webviewPanel, baseName, 0, failures, failures.length);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: '为样例数据，不允许推送' });
                },
                onTaskInfoFailed: (errorMsg) => {
                    // taskInfo 拉取异常（网络/后端 5xx）：告知用户并解锁按钮
                    showPushErrorModal(webviewPanel, baseName, errorMsg);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: errorMsg });
                },
                onBackendError: (errorMsg) => {
                    showPushErrorModal(webviewPanel, baseName, errorMsg);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: errorMsg });
                },
                onUnexpectedError: (errorMsg) => {
                    // runPush 顶层未处理异常兜底：确保按钮解锁 + 用户看到失败原因
                    showPushErrorModal(webviewPanel, baseName, errorMsg);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: errorMsg });
                },
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
            },
        });
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
                    sendTelemetryErrorEvent('editor.waitReady.timeout', { targetFile: filePath });
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
            const d = new Date();
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            const ms = String(d.getMilliseconds()).padStart(3, '0');
            console.log(`[TC-EDITOR][${hh}:${mm}:${ss}.${ms}][${panelId}]`, ...args);
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
            sendTelemetryErrorEvent('editor.keepEditor.failed', { errorMessage: String(e?.message || String(e)).slice(0, 500), stackHead: stackHead(e) });
        }

        // 先识别文件类型；不合格直接展示错误页
        const resolved = this.resolveFile(document.uri);
        webviewPanel.title = fileName + ' - 测试案例编辑器';
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };

        if (!resolved.qualified || !resolved.type) {
            sendTelemetryEvent('editor.opened.unqualified', { targetFile: fileName });
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
                    sendTelemetryEvent('editor.unqualified.openText', { targetFile: fileName });
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
        const prefetchPromise: Promise<{ tableData: any; sourceData: any; generated: boolean } | null> =
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

        const pushDataToWebview = async (forceReparse: boolean, reason: string, force?: boolean, clearAllMods?: boolean): Promise<void> => {
            try {
                if (forceReparse || !session.cachedTableData) {
                    // 解析前记录原 cache 的行数，用于识别"读到中间态空文件"的极端情况
                    const oldData = session.cachedTableData;
                    const prevRowsLen = (oldData?.rows || []).length;
                    const _parseStart = Date.now();
                    // ⚡ init 场景优先复用 resolveCustomEditor 启动时的预解析结果，避免重复 parse
                    let result: { tableData: any; sourceData: any };
                    let prefetchHit: { tableData: any; sourceData: any; generated: boolean } | null = null;
                    if (reason === 'init') {
                        try { prefetchHit = await prefetchPromise; } catch (_) { prefetchHit = null; }
                    }
                    if (prefetchHit) {
                        result = { tableData: prefetchHit.tableData, sourceData: prefetchHit.sourceData };
                        log(`⚡ prefetch hit on init, skip reparse`);
                    } else {
                        result = await session.parser.parse(filePath);
                    }
                    const _parseDur = Date.now() - _parseStart;
                    const newRowsLen = (result.tableData?.rows || []).length;
                    const newColsLen = (result.tableData?.headers || []).length;
                    log(`🔍 parse done reason=${reason} prevRows=${prevRowsLen} newRows=${newRowsLen} cols=${newColsLen} dur=${_parseDur}ms force=${!!force}`);
                    log(`📋 headers: [${result.tableData?.headers?.join(', ')}]`);
                    // 调试：如果表头只有 testcase_id，记录文件内容前 500 字符
                    if (result.tableData?.headers?.length <= 1) {
                        try {
                            const content = await require('fs').promises.readFile(filePath, 'utf-8');
                            log(`⚠️ 表头异常！文件内容预览: ${content.slice(0, 500)}`);
                        } catch (e: any) {
                            log(`⚠️ 无法读取文件: ${e?.message}`);
                        }
                    }
                    // 防御：force=true 时若新解析为 0 行而旧 cache > 0 行，
                    // 多半是 fs.writeFile 尚未完全 flush，watcher 提前触发读到部分/空文件。
                    // 直接放弃本次推送，保留旧缓存与前端现状，下次正常事件会重新触发。
                    if (force && prevRowsLen > 0 && newRowsLen === 0) {
                        log(`⚠ skip suspicious empty reparse (prev=${prevRowsLen}, reason=${reason}) — likely fs flush midway`);
                        return;
                    }
                    session.originalSourceData = result.sourceData;
                    // 仅确保 testcase_id 列存在；缺失时立刻落盘让 testcase_id 持久化
                    // prefetch 命中时 ensureTrackingColumns 已执行过，无需重复
                    const ensured = prefetchHit
                        ? { tableData: prefetchHit.tableData, generated: prefetchHit.generated }
                        : ensureTrackingColumns(result.tableData, session.originalSourceData);
                    session.cachedTableData = ensured.tableData;
                    if (ensured.generated) {
                        try {
                            lastSelfSaveAt = Date.now();
                            await session.parser.save(filePath, session.cachedTableData, session.originalSourceData);
                            log('💾 testcase_id 已补全并落盘');
                        } catch (e: any) {
                            log('⚠ testcase_id 落盘失败:', e?.message || e);
            sendTelemetryErrorEvent('editor.testcaseId.saveFailed', { fileFormat: resolved.type || '', errorMessage: String(e?.message || String(e)).slice(0, 500), stackHead: stackHead(e) });
                        }
                    }
                    // init / 外部变更 / 推送成功 / 重置刷新时，用当前数据与推送快照做差异比对（均排除 testCaseNo 列）
                    // 差异结果持久化到 highlightStore，并通过 Data 消息下发前端高亮。
                    // pushSuccess 时快照已更新，被推送的行无差异 → 高亮自动清除；未推送的修改行仍正确保留高亮。
                    // reload 时前端已完成重置清空，重新 diff 下发 deletedInfos 确保幽灵行不丢失。
                    if (reason === 'init' || reason.startsWith('externalChange:') || reason === 'pushSuccess' || reason === 'reload') {
                        const diffResult = diffPushSnapshot(filePath, ensured.tableData);
                        if (diffResult) {
                            const { changed: changedRows, deletedInfos, addedInfos } = diffResult;
                            // 新增行也纳入黄色单元格高亮，与"修改行"保持一致的心智模型：
                            // "任何相对最新推送快照的差异 = 黄色高亮"。避免出现"新增行编辑不显示黄"的割裂感。
                            const addedFlatCells = expandAddedRowsToCells(addedInfos, ensured.tableData);
                            if (changedRows.length > 0 || addedFlatCells.length > 0) {
                                const rowIndicesSet = new Set<number>();
                                changedRows.forEach(d => rowIndicesSet.add(d.rowIndex));
                                addedInfos.forEach(a => rowIndicesSet.add(a.rowIndex));
                                const rowIndices = Array.from(rowIndicesSet);
                                const flatCells: Array<[number, number]> = [];
                                for (const d of changedRows) {
                                    for (const ci of d.changedCols) flatCells.push([d.rowIndex, ci]);
                                }
                                for (const cell of addedFlatCells) flatCells.push(cell);
                                session.highlightedCells = { colIdx: -1, rowIndices, cells: flatCells };
                                await setHighlight(filePath, session.highlightedCells);
                                log(`🟢 快照差异比对检测到 ${changedRows.length} 行修改 + ${addedInfos.length} 行新增 (reason=${reason})`);
                            } else {
                                // pushSuccess / reload 时 diff 无变化，显式发送 null 告知前端清空高亮；
                                // 其他场景设 undefined 以免覆盖前端已有状态（如 visible 场景保留旧高亮）
                                session.highlightedCells = (reason === 'pushSuccess' || reason === 'reload') ? null : undefined;
                                await clearHighlight(filePath);
                            }
                            session.deletedInfos = deletedInfos;
                            if (deletedInfos.length > 0) {
                                log(`🗑  快照差异比对检测到 ${deletedInfos.length} 行被删除 (reason=${reason})`);
                                const tsIds = deletedInfos.map(d => d.tsId);
                                markDeletedRows(filePath, tsIds).catch(err => log('⚠ 标记删除行失败:', err?.message));
                            }
                            session.addedInfos = addedInfos;
                            if (addedInfos.length > 0) {
                                log(`➕ 快照差异比对检测到 ${addedInfos.length} 行新增 (reason=${reason})`);
                            }
                        }
                        // diffResult === null 表示无快照（首次使用或未推送过），保留前端已有状态
                    }
                }
                const dataStr = JSON.stringify(session.cachedTableData);
                const uint8Array = new TextEncoder().encode(dataStr);
                const rowsLen = (session.cachedTableData?.rows || []).length;
                // 标记是否来自外部修改（fsWatcher / onDidSaveTextDocument）：
                // 前端在用户有未保存修改时收到此标记会弹冲突合并对话框，避免静默覆盖。
                const isExternal = reason.indexOf('externalChange') === 0;
                // 高亮信息：
                // - undefined = 不发送字段（前端保留已有高亮，如 visible）
                // - null       = 明确发送 null（前端清空已有高亮，如 pushSuccess）
                // - 对象       = 发送具体高亮数据
                // 注意：不清空 session.highlightedCells，push handler 后续需要读取过滤
                const highlighted = session.highlightedCells;
                const msgPayload: any = {
                    type: session.type + 'Data',
                    data: Array.from(uint8Array),
                    force: !!force,
                    reason,
                    externalChange: isExternal,
                    // 文件绝对路径：前端用它作为 UI 状态（列宽/行高/筛选/搜索/滚动）
                    // 的命名空间隔离 key，避免同 dataType 的不同文件互相串扰。
                    filePath,
                };
                if (highlighted !== undefined) {
                    msgPayload.highlightedCells = highlighted;
                }
                // clearAllMods：仅在 postExplorerPushRefresh（资源管理器右键推送）时传 true，
                // 告知前端本帧属于"整文件一次性提交"，需无条件清空全量本地修改状态。
                if (clearAllMods) {
                    msgPayload.clearAllMods = true;
                }
                // 推送失败标记：从 store 读取，每次推送数据时都下发，
                // 确保关闭/重开文件后失败行高亮可恢复（按 testcase_id 关联，行号变动也不影响）
                try {
                    msgPayload.pushFailures = getFailures(filePath);
                } catch { /* ignore */ }
                const deleted = session.deletedInfos;
                if (deleted !== undefined) {
                    msgPayload.deletedInfos = deleted;
                }
                const added = session.addedInfos;
                if (added !== undefined) {
                    msgPayload.addedInfos = added;
                }
                // 用户手动标记高亮（持久化，随 Data 消息下发）
                // 注意：saveHighlight / pushSuccess 等"由 webview 主动 save 触发的内部回推"
                // 与 webview 同步发出的 setMarkRects 在扩展端是【并发处理】的，
                // 此时 getMarks() 可能读到 setMarks 写盘前的旧值，进而把 userMarks=旧值
                // 推回 webview 覆盖最新的 redo/mark 状态。
                // 这两类 reason 下 webview 端已持有最新 marks，无需扩展端再推回；
                // 真正的标记变化由独立的 userMarksUpdated 消息可靠投递。
                const _skipUserMarksReasons = new Set(['saveHighlight', 'pushSuccess']);
                if (!_skipUserMarksReasons.has(reason)) {
                    try { msgPayload.userMarks = getMarks(filePath); } catch { /* ignore */ }
                }
                // 表头中英映射（仅用于显示，不写回数据；每次下发都带上以保证刚打开/可见性切换时也能拿到）
                try { msgPayload.headerLabels = getHeaderLabels(); } catch { /* ignore */ }
                session.deletedInfos = undefined;
                session.addedInfos = undefined;
                log(`📤 push (${reason}) rows=${rowsLen} visible=${webviewPanel.visible} force=${!!force} external=${isExternal}`);
                webviewPanel.webview.postMessage(msgPayload);
            } catch (err: any) {
                log('❌ push failed:', err?.message || err);
                // 兜底：diff/highlight 等周边逻辑出错时，已经成功 parse 的数据仍要推给前端，
                // 否则前端会一直停在 loading 状态，必须切换文件触发 visible reload 才能恢复。
                try {
                    if (session.cachedTableData) {
                        const dataStr = JSON.stringify(session.cachedTableData);
                        const uint8Array = new TextEncoder().encode(dataStr);
                        const fallbackPayload: any = {
                            type: session.type + 'Data',
                            data: Array.from(uint8Array),
                            force: !!force,
                            reason: reason + ':fallback',
                            externalChange: false,
                            filePath,
                        };
                        log(`📤 push (fallback) rows=${(session.cachedTableData.rows || []).length}`);
                        webviewPanel.webview.postMessage(fallbackPayload);
                    }
                } catch (e2: any) {
                    log('❌ fallback push also failed:', e2?.message || e2);
                }
            }
        };

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
                    sendTelemetryEvent('editor.visibleChange.skipped', { reason: 'selfSaveGuard', fileFormat: session.type });
                    await pushDataToWebview(false, 'visible');
                    return;
                }
                // 强制重新解析最新文件并下发；force=true 让前端绕过「未保存修改保护」直接覆盖
                session.cachedTableData = null;
                await pushDataToWebview(true, 'visible', true);
            } catch (err: any) {
                log('❌ visible-reload failed:', err?.message || err);
            sendTelemetryErrorEvent('editor.visibleChange.failed', { fileFormat: session.type, errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
                // 兜底：解析失败时仍按缓存推送一次，保证前端有数据
                try { await pushDataToWebview(false, 'visible'); } catch (_) { /* ignore */ }
            }
        });

        // ============ 监听文件外部变更（如 TextEditor 修改保存） ============
        // 通过 FileSystemWatcher 捕获包括 VSCode 内/外的所有写入；
        // 同时通过 onDidSaveTextDocument 作为补充，确保 TextEditor 保存能被捕获到。
        let externalChangeTimer: NodeJS.Timeout | null = null;
        const handleExternalChange = (origin: string) => {
            const now = Date.now();
            const sinceSelfSave = lastSelfSaveAt ? (now - lastSelfSaveAt) : -1;
            // 自己刚刚 save 完短时间内的回声忽略
            if (lastSelfSaveAt && sinceSelfSave < SELF_SAVE_GUARD_MS) {
                sendTelemetryEvent('editor.externalChange.skipped', { origin, fileFormat: session.type });
                log(`🔁 ignore self-save echo (${origin}) sinceSelfSave=${sinceSelfSave}ms < ${SELF_SAVE_GUARD_MS}ms`);
                return;
            }
            log(`📥 external change scheduled (${origin}) sinceSelfSave=${sinceSelfSave}ms`);
            if (externalChangeTimer) clearTimeout(externalChangeTimer);
            // 去抖：合并短时间内的多次变更
            externalChangeTimer = setTimeout(() => {
                externalChangeTimer = null;
                sendTelemetryEvent('editor.externalChange.fired', { origin, fileFormat: session.type });
                log(`📥 external change fired (${origin}), reload`);
                // 不提前置空缓存：pushDataToWebview 内部会比对旧缓存与重解析结果，
                // 若 testCaseNo 列有变化则自动记录高亮并持久化。
                pushDataToWebview(true, 'externalChange:' + origin, true);
            }, 150);
        };

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath))
        );
        const watcherChangeSub = watcher.onDidChange(() => handleExternalChange('fsWatcher'));
        const watcherCreateSub = watcher.onDidCreate(() => handleExternalChange('fsWatcher:create'));

        const saveDocSub = vscode.workspace.onDidSaveTextDocument((doc) => {
            try {
                if (doc && doc.uri.fsPath === filePath) {
                    handleExternalChange('onDidSaveTextDocument');
                }
            } catch (_) { /* ignore */ }
        });

        webviewPanel.onDidDispose(() => {
            log('🗑 disposed');
            try { watcherChangeSub.dispose(); } catch (_) { /* ignore */ }
            try { watcherCreateSub.dispose(); } catch (_) { /* ignore */ }
            try { watcher.dispose(); } catch (_) { /* ignore */ }
            try { saveDocSub.dispose(); } catch (_) { /* ignore */ }
            try { renameSub.dispose(); } catch (_) { /* ignore */ }
            if (externalChangeTimer) { clearTimeout(externalChangeTimer); externalChangeTimer = null; }
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
                    // 更新 panelMap 中的键值
                    BaseEditorProvider.updatePanelMapKey(file.oldUri.fsPath, filePath);
                }
            }
        });

        // ⚠ 关键：必须先绑定 onDidReceiveMessage 再设置 webview.html
        webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                if (msg?.type === 'init') {
                    log('📨 init from webview');
                    // 差异比对由 pushDataToWebview 内部处理（init 原因触发快照 diff）
                    await pushDataToWebview(true, 'init');
                    // 注册表头中英映射变更监听：设置项 / 工作区文件变化时实时热更新当前 panel
                    const _hlSubs = onHeaderLabelsChange(() => {
                        try {
                            webviewPanel.webview.postMessage({
                                type: 'headerLabelsUpdated',
                                headerLabels: getHeaderLabels(),
                            });
                        } catch (_) { /* ignore */ }
                    });
                    webviewPanel.onDidDispose(() => {
                        _hlSubs.forEach(d => { try { d.dispose(); } catch (_) { /* ignore */ } });
                    });
                    // 通知等待方：webview 已就绪，可以接收推送结果消息
                    try { markReady(); } catch (_) { /* ignore */ }
                    sendTelemetryEvent('editor.opened', { fileFormat: session.type });
                } else if (msg?.type === 'save' && msg?.data) {
                    const _saveStart = Date.now();
                    const _inRows = (msg.data?.rows || []).length;
                    const _inHeaders = (msg.data?.headers || []).length;
                    log(`💾 save begin rows=${_inRows} cols=${_inHeaders}`);
                    // 写盘前先打时间戳，覆盖 watcher 在 await 期间就回包的极端竞态
                    lastSelfSaveAt = _saveStart;
                    await session.parser.save(filePath, msg.data, session.originalSourceData);
                    const _saveDur = Date.now() - _saveStart;
                    // 写盘后再次刷新时间戳：fsWatcher / onDidSaveTextDocument 的通知通常发生在
                    // writeFile 返回之后，从这一刻开始算 SELF_SAVE_GUARD_MS 才能可靠拦截自反弹。
                    lastSelfSaveAt = Date.now();
                    log(`💾 save done dur=${_saveDur}ms lastSelfSaveAt refreshed`);
                    // Webview 编辑保存后，用当前数据与推送快照做差异比对（均排除 testCaseNo 列）
                    const diffResult = diffPushSnapshot(filePath, msg.data);
                    let _addedRows = 0;
                    let _deletedRows = 0;
                    let _modifiedRows = 0;
                    let _modifiedCells = 0;
                    if (diffResult) {
                        const { changed: changedRows, deletedInfos, addedInfos } = diffResult;
                        _addedRows = addedInfos.length;
                        _deletedRows = deletedInfos.length;
                        _modifiedRows = changedRows.length;
                        // 新增行也纳入黄色单元格高亮，与"修改行"保持一致的心智模型：
                        // "任何相对最新推送快照的差异 = 黄色高亮"，避免出现"新增行编辑保存后不显示黄"的割裂感。
                        const addedFlatCells = expandAddedRowsToCells(addedInfos, msg.data);
                        if (changedRows.length > 0 || addedFlatCells.length > 0) {
                            const rowIndicesSet = new Set<number>();
                            changedRows.forEach(d => rowIndicesSet.add(d.rowIndex));
                            addedInfos.forEach(a => rowIndicesSet.add(a.rowIndex));
                            const rowIndices = Array.from(rowIndicesSet);
                            const flatCells: Array<[number, number]> = [];
                            for (const d of changedRows) {
                                for (const ci of d.changedCols) flatCells.push([d.rowIndex, ci]);
                            }
                            for (const cell of addedFlatCells) flatCells.push(cell);
                            _modifiedCells = flatCells.length;
                            session.highlightedCells = { colIdx: -1, rowIndices, cells: flatCells };
                            await setHighlight(filePath, session.highlightedCells);
                            log(`🟢 Webview 保存快照差异比对检测到 ${changedRows.length} 行修改 + ${addedInfos.length} 行新增，共 ${flatCells.length} 格`);
                        } else {
                            // 使用 null 而非 undefined，确保 pushDataToWebview 将 highlightedCells=null
                            // 显式发送给 webview，让前端清除旧高亮（关键：值恢复到快照基线时需清除残留高亮）
                            session.highlightedCells = null;
                            await clearHighlight(filePath);
                        }
                        session.deletedInfos = deletedInfos;
                        if (deletedInfos.length > 0) {
                            log(`🗑  Webview 保存快照差异比对检测到 ${deletedInfos.length} 行被删除`);
                            const tsIds = deletedInfos.map(d => d.tsId);
                            markDeletedRows(filePath, tsIds).catch(err => log('⚠ 标记删除行失败:', err?.message));
                        }
                        session.addedInfos = addedInfos;
                        if (addedInfos.length > 0) {
                            log(`➕ Webview 保存快照差异比对检测到 ${addedInfos.length} 行新增`);
                        }
                    }
                    sendTelemetryEvent('editor.saved', {
                        fileFormat: session.type,
                        rows: String(_inRows),
                        cols: String(_inHeaders),
                        costMs: String(_saveDur),
                        appendRows: String(_addedRows),
                        changeRows: String(_modifiedRows),
                        removeRows: String(_deletedRows),
                        changeCells: String(_modifiedCells),
                    });
                    // 缓存与前端最新数据一致：直接复用 webview 提交上来的 data，
                    // 避免置 null 后被外部触发的 reparse 在 fs flush 中读到部分内容/空数据。
                    try { session.cachedTableData = msg.data; } catch (_) { session.cachedTableData = null; }
                    // save 后始终推送高亮状态到 webview：
                    // - 有变化时下发新 highllight 格
                    // - 无变化时下发 null 显式清除 webview 残留高亮（值恢复到快照基线的场景）
                    pushDataToWebview(false, 'saveHighlight');
                    showSaveResult(webviewPanel, true);
                    log(`💾 saved msg posted`);
                } else if (msg?.type === 'pushTestCase' && msg?.data) {
                    const pushCtx: PushContext = {
                        session,
                        filePath,
                        refresh: (reason) => pushDataToWebview(true, reason, true),
                        rowIndexMap: (msg.rowIndexMap && typeof msg.rowIndexMap === 'object') ? msg.rowIndexMap : undefined,
                        pushIndexToRow: Array.isArray(msg.pushIndexToRow) ? msg.pushIndexToRow : undefined,
                        markSelfSave: () => { lastSelfSaveAt = Date.now(); },
                    };
                    await this.pushStrategy.push(msg.data, pushCtx, webviewPanel, this.context);
                } else if (msg?.type === 'openTextEditor') {
                    sendTelemetryEvent('editor.switchedToText', { fileFormat: session.type });
                    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                } else if (msg?.type === 'reload') {
                    // 用户在前端工具栏点击 "刷新" / "重置并获取最新数据"：
                    // 强制丢弃缓存重新解析磁盘文件，并以 force=true 让前端绕过 "未保存修改保护" 直接覆盖。
                    log('📨 reload from webview');
                    session.cachedTableData = null;
                    await pushDataToWebview(true, 'reload', true);
                    sendTelemetryEvent('editor.reloaded', { fileFormat: session.type });
                } else if (msg?.type === 'mark' && Array.isArray(msg?.rects)) {
                    // 用户手动标记：追加标记区域（含颜色）并持久化
                    log(`📌 mark ${msg.rects.length} rects`);
                    const existing = getMarks(filePath);
                    const now = Date.now();
                    const newRects = msg.rects.filter((r: any) => r && typeof r.r1 === 'number').map((r: any) => {
                        const entry: any = { r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2, timestamp: now };
                        if (msg.bgColor) entry.bgColor = msg.bgColor;
                        if (msg.fontColor) entry.fontColor = msg.fontColor;
                        return entry;
                    });
                    await setMarks(filePath, [...existing, ...newRects]);
                    webviewPanel.webview.postMessage({ type: 'userMarksUpdated', userMarks: getMarks(filePath) });
                    sendTelemetryEvent('editor.marked', { fileFormat: session.type, count: String(newRects.length) });
                } else if (msg?.type === 'unmark' && Array.isArray(msg?.rects)) {
                    // 用户取消标记：移除匹配的标记区域并持久化
                    log(`🗑  unmark ${msg.rects.length} rects`);
                    const existing = getMarks(filePath);
                    const toRemove = msg.rects.filter((r: any) => r && typeof r.r1 === 'number');
                    const kept = existing.filter((er: any) => {
                        return !toRemove.some((tr: any) =>
                            tr.r1 === er.r1 && tr.c1 === er.c1 && tr.r2 === er.r2 && tr.c2 === er.c2
                        );
                    });
                    if (kept.length === 0) {
                        await clearMarks(filePath);
                    } else {
                        await setMarks(filePath, kept);
                    }
                    webviewPanel.webview.postMessage({ type: 'userMarksUpdated', userMarks: getMarks(filePath) });
                    sendTelemetryEvent('editor.unmarked', { fileFormat: session.type, count: String(toRemove.length) });
				} else if (msg?.type === 'setMarkRects' && Array.isArray(msg?.rects)) {
					// 前端取消标记后发回完整矩形列表（已做 cell-by-cell 减法）
					log(`🔄 setMarkRects ${msg.rects.length} rects`);
					if (msg.rects.length === 0) {
						await clearMarks(filePath);
					} else {
						await setMarks(filePath, msg.rects);
					}
					webviewPanel.webview.postMessage({ type: 'userMarksUpdated', userMarks: getMarks(filePath) });
					sendTelemetryEvent('editor.unmarked', { fileFormat: session.type, count: String(msg.rects.length) });
				} else if (msg?.type === 'clearAllMarks') {
					// 清除所有标记
					log('🧹 clearAllMarks');
					await clearMarks(filePath);
					webviewPanel.webview.postMessage({ type: 'userMarksUpdated', userMarks: [] });
					sendTelemetryEvent('editor.clearAllMarks', { fileFormat: session.type });
				}
            } catch (err: any) {
                const errMsg = err?.message || String(err) || '操作失败';
            sendTelemetryErrorEvent('editor.message.error', { messageKind: msg?.type || '', fileFormat: session.type, errorMessage: errMsg.slice(0, 500), stackHead: stackHead(err) });
                if (msg?.type === 'save') {
                    sendTelemetryErrorEvent('editor.save.error', { fileFormat: session.type, errorMessage: errMsg.slice(0, 500) });
                    webviewPanel.webview.postMessage({ type: 'saveError', message: errMsg });
                } else if (msg?.type === 'pushTestCase') {
                    sendTelemetryErrorEvent('editor.push.error', { fileFormat: session.type, errorMessage: errMsg.slice(0, 500) });
                    showPushErrorModal(webviewPanel, path.basename(filePath), errMsg);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: errMsg });
                }
                if (msg?.type === 'pushTestCase' && /无法连接后端服务|连接.*超时|连接被重置/.test(errMsg)) {
                    sendTelemetryErrorEvent('editor.network.error', { fileFormat: session.type });
                    const pick = await vscode.window.showErrorMessage(
                        `[${this.formatTypeName(session.type)}] ${errMsg}`,
                        '打开配置', '查看帮助'
                    );
                    if (pick === '打开配置') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'testcaseViewer.apiUrl');
                    } else if (pick === '查看帮助') {
                        vscode.window.showInformationMessage(
                            '本地调试请先启动 Mock 服务：在终端执行 `node mock-server.js`，默认监听 127.0.0.1:8081。'
                        );
                    }
                } else {
                    vscode.window.showErrorMessage(`[${this.formatTypeName(session.type)}] ${errMsg}`);
                }
            }
        });

        // 表头展示：仅用 task-bindings.json 中的真实后端值；
        // 未绑定（或未命中）时三项为空串，由 buildEditorHtml 渲染为 "-"
        const currentTask = this.context
            ? await getCurrentTaskInfo(filePath)
            : { bind: false, taskInfo: {} as Record<string, never> };
        const info = currentTask.taskInfo as { testTaskNo?: string; testTaskName?: string; subTestTaskName?: string };
        const taskInfoForWebView = {
            bind: currentTask.bind,
            testTaskNo: info.testTaskNo || '',
            testTaskName: info.testTaskName || '',
            subTestTaskName: info.subTestTaskName || ''
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

/** 单个 webview panel 独享的会话状态 */
export interface EditorSession {
    type: FileType;
    parser: FileParser;
    originalSourceData: any;
    /** 已解析的表格数据缓存：用于切换 tab 重新可见时快速 repush，避免重读文件 */
    cachedTableData: any;
    /** 推送成功后回写了 testCaseNo 的单元格信息（下次 pushDataToWebview 消费后清空）；null 表示明确通知前端清空 */
    highlightedCells?: { colIdx: number; rowIndices: number[]; cells?: Array<[number, number]> } | null;
    /** 快照差异检测到的被删除行信息（下次 pushDataToWebview 消费后清空） */
    deletedInfos?: DeletedRowInfo[];
    /** 快照差异检测到的新增行信息（下次 pushDataToWebview 消费后清空） */
    addedInfos?: AddedRowInfo[];
}
