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
import { getCurrentTaskInfo, type GetCurrentTaskInfoResult } from '../utils/commands';
import { showPushErrorModal, showPushResult, showPushDone, showSaveResult } from '../utils/message';
import { setHighlight, clearHighlight } from '../utils/highlightStore';
import { savePushSnapshot, diffPushSnapshot, type RowDiff, type DiffResult, type DeletedRowInfo, type AddedRowInfo } from '../utils/pushSnapshotStore';
import { markDeletedRows } from '../utils/deletedRowsStore';
import { pushTestCase } from '../services/http';
import { createParser, ensureTrackingColumns, applyTestCaseNos, type FileParser, type FileType } from '../parsers';
import { sendTelemetryEvent, sendTelemetryErrorEvent, sendTelemetryException } from '../services/telemetry';
import { stackHead } from '../services/utils';

// 重新导出工具，便于子类使用
export { isInQualifiedDir, FILE_PATTERNS };

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
        const _pushStart = Date.now();
        const _ext = path.extname(ctx.filePath).toLowerCase();
        const _rowCount = Array.isArray(data) ? data.length : 0;
        sendTelemetryEvent('editorPush.start', { ext: _ext, totalRows: String(_rowCount) });

        // 任务信息统一由 getCurrentTaskInfo 提供：未绑定一律拒绝推送
        const currentTask = await getCurrentTaskInfo(ctx.filePath);
        if (!currentTask.bind) {
            sendTelemetryErrorEvent('editorPush.failed', {
                ext: _ext,
                returnCode: 'UNBOUND',
                totalRows: String(_rowCount),
                costMs: String(Date.now() - _pushStart),
            });
            showPushErrorModal(webviewPanel, path.basename(ctx.filePath),
                '未绑定任务，无法推送。请先在 task-bindings.json 中完成绑定。');
            return;
        }
        const taskInfo = {
            testTaskNo: currentTask.taskInfo.testTaskNo || '',
            subTestTaskName: currentTask.taskInfo.subTestTaskName || '',
        };

        // 重新解析文件获取原始结构化数据。
        // 前端 table 中嵌套对象/数组字段被渲染为显示文本（如 "[2 项]"），
        // 但文件落盘时 parser.save 通过 reconstructDetail 保留了正确结构。
        // 此处重新 parse 并用 testcase_id 匹配，确保推送的是原始数据而非显示文本。
        let pushData: any[] = data;
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
            sendTelemetryException('editorPush.reparseFailed', { ext: _ext, errorMessage: String(parseErr?.message || String(parseErr)).slice(0, 500), stackHead: stackHead(parseErr) });
        }

        const result = await pushTestCase(extensionContext, pushData, taskInfo, path.basename(ctx.filePath));
        if (result.returnCode !== 'SUC0000') {
            showPushErrorModal(webviewPanel, path.basename(ctx.filePath), result.errorMsg || '推送失败');
            webviewPanel.webview.postMessage({ type: 'pushError', message: result.errorMsg || '推送失败' });
            sendTelemetryErrorEvent('editorPush.failed', {
                ext: _ext,
                returnCode: result.returnCode || '',
                totalRows: String(_rowCount),
                costMs: String(Date.now() - _pushStart),
            });
            return;
        }

        // 解析后端返回：type=1 成功，data 即新的 testCaseNo；type=2 失败，data 为错误原因
        const body: any[] = Array.isArray(result.body) ? result.body : [];
        const successMappings: Array<{ tsId: string; testCaseNo: string }> = [];
        const failures: Array<{ tsId: string; reason: string }> = [];
        body.forEach(item => {
            if (!item) return;
            const t = String(item.type == null ? '' : item.type);
            const sid = String(item.sourceId == null ? '' : item.sourceId);
            const dataField = item.data == null ? '' : String(item.data);
            if (t === '1') successMappings.push({ tsId: sid, testCaseNo: dataField });
            else if (t === '2') failures.push({ tsId: sid, reason: dataField });
        });

        // 成功项：扩展端按 testcase_id 回写 testCaseNo 到原文件。
        // testCaseNo 落盘后刷新前端数据 —— 但有失败项时跳过刷新，
        // 避免刷新触发的 renderTable() 擦除 showPushResult 设置的失败行高亮。
        if (successMappings.length > 0) {
            try {
                // ⚠ 在异步 save() 之前快照当前高亮，防止文件监听器覆盖（若 watcher 发现快照无变化则置 undefined）
                const oldHL = ctx.session.highlightedCells;
                const parsed = await ctx.session.parser.parse(ctx.filePath);
                ensureTrackingColumns(parsed.tableData, parsed.sourceData);
                applyTestCaseNos(parsed.tableData, parsed.sourceData, successMappings);
                // 写盘前后打时间戳，防止 self-save 触发的 fsWatcher 在 pushSuccess 刷新期间覆盖高亮状态
                ctx.markSelfSave?.();
                await ctx.session.parser.save(ctx.filePath, parsed.tableData, parsed.sourceData);
                ctx.markSelfSave?.();
                // 所有已推送行（无论成功/失败）更新快照基线，使下次 diff 不再标记为修改
                const allPushedTsIds = new Set<string>();
                if (Array.isArray(pushData)) {
                    for (const rec of pushData) {
                        const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
                        if (id) allPushedTsIds.add(id);
                    }
                }
                await savePushSnapshot(ctx.filePath, parsed.tableData, allPushedTsIds);
                if (oldHL && oldHL.rowIndices && oldHL.rowIndices.length > 0) {
                    const rows = parsed.tableData.rows;
                    const tsIdIdx = parsed.tableData.headers.indexOf(TS_ID_COLUMN);
                    const remainingRows: number[] = [];
                    const remainingCells: [number, number][] = [];
                    for (const ri of oldHL.rowIndices) {
                        const id = tsIdIdx >= 0 && ri < rows.length ? String(rows[ri]?.[tsIdIdx] ?? '') : '';
                        if (!allPushedTsIds.has(id)) remainingRows.push(ri);
                    }
                    if (oldHL.cells) {
                        for (const [ri, ci] of oldHL.cells) {
                            const id = tsIdIdx >= 0 && ri < rows.length ? String(rows[ri]?.[tsIdIdx] ?? '') : '';
                            if (!allPushedTsIds.has(id)) remainingCells.push([ri, ci]);
                        }
                    }
                    ctx.session.highlightedCells = remainingRows.length > 0
                        ? { colIdx: oldHL.colIdx, rowIndices: remainingRows, cells: remainingCells.length > 0 ? remainingCells : undefined }
                        : null;
                } else {
                    ctx.session.highlightedCells = null;
                }
                await clearHighlight(ctx.filePath);
                // 落盘后让缓存失效，下次可见切换 / 手动刷新时自动重读最新文件
                ctx.session.cachedTableData = null;
                ctx.session.originalSourceData = parsed.sourceData;
                if (failures.length === 0) {
                    await ctx.refresh('pushSuccess');
                }
            } catch (err: any) {
                console.error('[推送] testCaseNo 回写失败:', err?.message || err);
                sendTelemetryException('editorPush.writeBackFailed', { ext: _ext, errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
            }
        } else if (failures.length > 0) {
            // 全部推送失败：仍更新快照基线，使下次 diff 不再标记为修改
            try {
                const allPushedTsIds = new Set<string>();
                if (Array.isArray(pushData)) {
                    for (const rec of pushData) {
                        const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
                        if (id) allPushedTsIds.add(id);
                    }
                }
                const parsed = await ctx.session.parser.parse(ctx.filePath);
                await savePushSnapshot(ctx.filePath, parsed.tableData, allPushedTsIds);
                ctx.session.cachedTableData = null;
            } catch (err: any) {
                console.error('[推送] 全部失败，快照更新失败:', err?.message || err);
                sendTelemetryException('editorPush.allFailSnapshotFailed', { ext: _ext, errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
            }
        }

        // 失败项按 testcase_id 反查行号，统一通过 webview 弹窗展示（与右键文件推送一致）
        // 优先使用前端传来的 rowIndexMap（真实表格 1-based 行号），缺省时退回按推送数组下标计算（旧逻辑）
        const frontRowIndexMap = ctx.rowIndexMap || {};
        const tsIdToRowIndex = new Map<string, number>();
        if (Array.isArray(pushData)) {
            pushData.forEach((rec: any, i: number) => {
                const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
                if (id) tsIdToRowIndex.set(id, i);
            });
        }
        console.log('[推送][调试] failures=', JSON.stringify(failures));
        console.log('[推送][调试] frontRowIndexMap=', JSON.stringify(frontRowIndexMap));
        console.log('[推送][调试] tsIdToRowIndex=', JSON.stringify(Array.from(tsIdToRowIndex.entries())));
        const failureItems = failures.map(f => {
            const front = frontRowIndexMap[f.tsId];
            let rowIndex: number | undefined;
            if (typeof front === 'number' && front > 0) {
                rowIndex = front;
            } else if (tsIdToRowIndex.has(f.tsId)) {
                rowIndex = tsIdToRowIndex.get(f.tsId)! + 1;
            }
            console.log(`[推送][调试] failure tsId="${f.tsId}" front=${front} rowIndex=${rowIndex}`);
            return { tsId: f.tsId, reason: f.reason, rowIndex };
        });

        const total = Array.isArray(pushData) ? pushData.length : (successMappings.length + failures.length);

        showPushResult(webviewPanel, path.basename(ctx.filePath), successMappings.length, failureItems, total);
        showPushDone(webviewPanel);
        // 编辑器内推送：直接复用前端 webview 弹窗（同一个 panel 内嵌），不再调用 showPushResult 走独立 webview
        webviewPanel.webview.postMessage({
            type: 'pushResult',
            fileName: path.basename(ctx.filePath),
            successCount: successMappings.length,
            failures: failureItems,
            total,
        });

        // 埋点：推送结果汇总
        sendTelemetryEvent('editorPush.complete', {
            ext: _ext,
            pushResult: failures.length === 0 ? 'allSuccess' : (successMappings.length === 0 ? 'allFail' : 'partial'),
            totalRows: String(total),
            successRows: String(successMappings.length),
            failedRows: String(failures.length),
            costMs: String(Date.now() - _pushStart),
        });

        // 通知前端推送流程已完成（用于隐藏 loading 之类的状态）
        webviewPanel.webview.postMessage({ type: 'pushDone' });
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
 */
interface PanelEntry {
    panel: vscode.WebviewPanel;
    ready: Promise<void>;
    markReady: () => void;
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
            sendTelemetryException('editor.keepEditor.failed', { errorMessage: String(e?.message || String(e)).slice(0, 500), stackHead: stackHead(e) });
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
        BaseEditorProvider.panelMap.set(filePath, { panel: webviewPanel, ready, markReady });

        // 自身落盘后短时间内忽略外部变更通知，避免触发自我反弹刷新。
        // 守护期需覆盖：parser.save 写盘耗时 + fsWatcher / onDidSaveTextDocument 通知延迟 + 防抖 150ms。
        // 大文件 YAML 序列化 + 写盘可能 > 800ms，故放宽到 3 秒。
        let lastSelfSaveAt = 0;
        const SELF_SAVE_GUARD_MS = 3000;

        const pushDataToWebview = async (forceReparse: boolean, reason: string, force?: boolean): Promise<void> => {
            try {
                if (forceReparse || !session.cachedTableData) {
                    // 解析前记录原 cache 的行数，用于识别"读到中间态空文件"的极端情况
                    const oldData = session.cachedTableData;
                    const prevRowsLen = (oldData?.rows || []).length;
                    const _parseStart = Date.now();
                    const result = await session.parser.parse(filePath);
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
                    const ensured = ensureTrackingColumns(result.tableData, session.originalSourceData);
                    session.cachedTableData = ensured.tableData;
                    if (ensured.generated) {
                        try {
                            lastSelfSaveAt = Date.now();
                            await session.parser.save(filePath, session.cachedTableData, session.originalSourceData);
                            log('💾 testcase_id 已补全并落盘');
                        } catch (e: any) {
                            log('⚠ testcase_id 落盘失败:', e?.message || e);
                            sendTelemetryException('editor.testcaseId.saveFailed', { fileFormat: resolved.type || '', errorMessage: String(e?.message || String(e)).slice(0, 500), stackHead: stackHead(e) });
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
                            if (changedRows.length > 0) {
                                const rowIndices = changedRows.map(d => d.rowIndex);
                                const flatCells: Array<[number, number]> = [];
                                for (const d of changedRows) {
                                    for (const ci of d.changedCols) flatCells.push([d.rowIndex, ci]);
                                }
                                session.highlightedCells = { colIdx: -1, rowIndices, cells: flatCells };
                                await setHighlight(filePath, session.highlightedCells);
                                log(`🟢 快照差异比对检测到 ${changedRows.length} 行变化 (reason=${reason})`);
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
                };
                if (highlighted !== undefined) {
                    msgPayload.highlightedCells = highlighted;
                }
                const deleted = session.deletedInfos;
                if (deleted !== undefined) {
                    msgPayload.deletedInfos = deleted;
                }
                const added = session.addedInfos;
                if (added !== undefined) {
                    msgPayload.addedInfos = added;
                }
                session.deletedInfos = undefined;
                session.addedInfos = undefined;
                log(`📤 push (${reason}) rows=${rowsLen} visible=${webviewPanel.visible} force=${!!force} external=${isExternal}`);
                webviewPanel.webview.postMessage(msgPayload);
            } catch (err: any) {
                log('❌ push failed:', err?.message || err);
            }
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
                sendTelemetryException('editor.visibleChange.failed', { fileFormat: session.type, errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
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
                        if (changedRows.length > 0) {
                            const rowIndices = changedRows.map(d => d.rowIndex);
                            const flatCells: Array<[number, number]> = [];
                            for (const d of changedRows) {
                                for (const ci of d.changedCols) flatCells.push([d.rowIndex, ci]);
                            }
                            _modifiedCells = flatCells.length;
                            session.highlightedCells = { colIdx: -1, rowIndices, cells: flatCells };
                            await setHighlight(filePath, session.highlightedCells);
                            log(`🟢 Webview 保存快照差异比对检测到 ${changedRows.length} 行发生 ${flatCells.length} 格变化`);
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
                }
            } catch (err: any) {
                const errMsg = err?.message || String(err) || '操作失败';
                sendTelemetryException('editor.message.error', { messageKind: msg?.type || '', fileFormat: session.type, errorMessage: errMsg.slice(0, 500), stackHead: stackHead(err) });
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
            : { bind: false, taskInfo: {} };

        webviewPanel.webview.html = await this.buildEditorHtml(nonce, webviewPanel, session.type, currentTask);
        log('✅ html ready');
    }

    /**
     * 构建 Webview HTML（从模板文件加载并替换占位符）
     */
    private async buildEditorHtml(
        nonce: string,
        webviewPanel: vscode.WebviewPanel,
        dataType: FileType,
        taskInfo: GetCurrentTaskInfoResult
    ): Promise<string> {
        const msgType = `${dataType}Data`;

        const stylesUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'common', 'styles', 'table-editor.css')
        );
        // 表格编辑器脚本已按职能拆分到 editor/ 子目录下，按顺序加载等价于原 editor.js 单文件。
        // 注意：因函数声明在每个 <script> 内部独立提升（不跨脚本），文件加载顺序必须保持。
        //   01-core            —— 全局状态 S、日志、撤销/重做、init 入口、消息分发、通用工具
        //   02a-render         —— renderTable + 虚拟滚动 + 单元格 patchCell
        //   02b-bind           —— 工具栏 / 全局快捷键 / 表格事件委托绑定
        //   02c-row-cell-sel   —— 行号格 mousedown / 单元格 mousedown（行选 / 单元格矩形拖选）
        //   02d-sel-utils      —— 选区辅助、信息统计、推送按钮 / 仅看失败按钮 状态同步
        //   03a-cell-edit      —— 单元格编辑、右键菜单、行/列数据增删改/复制粘贴/清空
        //   03b-resize-colsel  —— 列宽拖动 / 列选择（Excel 风格） / 行高拖动
        //   04-push-find       —— 推送/保存、查找替换面板、Excel 风格列筛选
        //   05-modals          —— 推送结果弹窗、通用 prompt/confirm、明细弹窗，并在末尾调用 init()
        const editorScriptFiles = [
            'editor/01-core.js',
            'editor/02a-render.js',
            'editor/02b-bind.js',
            'editor/02c-row-cell-sel.js',
            'editor/02d-sel-utils.js',
            'editor/03a-cell-edit.js',
            'editor/03b-resize-colsel.js',
            'editor/04-push-find.js',
            'editor/05-modals.js'
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
        const innerTask = taskInfo?.taskInfo;
        const safeTestTaskNo = escapeHtml((innerTask && innerTask.testTaskNo) || PLACEHOLDER);
        const safeSubTestTaskName = escapeHtml((innerTask && innerTask.subTestTaskName) || PLACEHOLDER);
        const safeTestTaskName = escapeHtml((innerTask && innerTask.testTaskName) || PLACEHOLDER);

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