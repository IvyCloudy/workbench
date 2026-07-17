/**
 * ============================================================================
 *  handlers/editorMessageHandlers.ts
 *  编辑器 webview 消息分发（表驱动）
 * ----------------------------------------------------------------------------
 *  职责：
 *    从 BaseEditorProvider.resolveCustomEditor.onDidReceiveMessage 抽出的消息处理表。
 *    每个 handler 只关心自身语义，共享的 try/catch 由外层 dispatch 统一兜底，
 *    新增消息类型只需在 buildHandlers 中加一项。
 *
 *  典型 handler 上下文（EditorMsgCtx）：
 *    - session / filePath：会话状态与路径
 *    - webviewPanel / log：VSCode 侧对象与日志
 *    - pusher：WebviewDataPusher，用于统一走 pushDataToWebview 通道
 *    - onSelfSave：写盘时刷新自保存时间戳的钩子
 *    - onReady：init 到达后 resolve panel ready promise
 *    - pushStrategy / extensionContext / typeName：pushTestCase 走既有推送策略
 *    - documentUri：openTextEditor 需要用到的原始 uri
 *    - onHeaderLabelsSubs：init 时注册的表头映射变更监听（生命周期由外层维护）
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { WebviewDataPusher } from '../services/webviewDataPusher';
import { applyDiffHighlight, type EditorSession } from '../services/diffHighlight';
import { getMarks, setMarks, clearMarks } from '../utils/markStore';
import { getHeaderLabels, onHeaderLabelsChange } from '../utils/headerLabels';
import { showSaveResult, showPushErrorModal } from '../utils/message';
import { TelemetryService } from '../utils/telemetry';
import { buildErrorProps } from '../services/utils';
import type { PushStrategy, PushContext } from '../providers/BaseEditorProvider';

export interface EditorMsgCtx {
    session: EditorSession;
    /** 当前文件路径（重命名时会由外部更新，通过 getter 保持最新） */
    getFilePath: () => string;
    webviewPanel: vscode.WebviewPanel;
    documentUri: vscode.Uri;
    log: (...args: any[]) => void;
    pusher: WebviewDataPusher;
    /** 打自保存时间戳（写盘前后调用） */
    onSelfSave: () => void;
    /** init 消息到达时通知外部：panel 已 ready */
    onReady: () => void;
    /** init 消息到达时注册的表头映射订阅需要挂到外部生命周期上 */
    registerHeaderLabelsSubs: (subs: vscode.Disposable[]) => void;
    /** pushTestCase 需要用到的推送策略与扩展上下文 */
    pushStrategy: PushStrategy;
    extensionContext?: vscode.ExtensionContext;
    /** 用于 dispose 顶层错误弹窗中的类型名（如 "CSV" / "YAML"） */
    typeName: string;
}

type Handler = (msg: any, ctx: EditorMsgCtx) => Promise<void> | void;

/**
 * 构造消息类型 -> handler 表。
 * 表驱动的好处：
 *   - 新增消息类型只需在此加一项；
 *   - 外层 dispatchEditorMessage 统一处理未知类型/异常。
 */
function buildHandlers(): Record<string, Handler> {
    return {
        init: handleInit,
        save: handleSave,
        pushTestCase: handlePushTestCase,
        openTextEditor: handleOpenTextEditor,
        reload: handleReload,
        mark: handleMark,
        setMarkRects: handleSetMarkRects,
        clearAllMarks: handleClearAllMarks,
    };
}

const HANDLERS = buildHandlers();

/**
 * webview 消息统一入口。
 * 保留原实现的错误分类（save / pushTestCase 各自的错误消息回推 + 网络类特殊弹窗）。
 */
export async function dispatchEditorMessage(msg: any, ctx: EditorMsgCtx): Promise<void> {
    const handler = HANDLERS[msg?.type];
    if (!handler) return; // 未识别消息类型：与原实现一致，静默忽略
    try {
        await handler(msg, ctx);
    } catch (err: any) {
        await handleDispatchError(err, msg, ctx);
    }
}

/** ============ 各消息 handler ============ */

async function handleInit(_msg: any, ctx: EditorMsgCtx): Promise<void> {
    ctx.log('📨 init from webview');
    // 差异比对由 pushDataToWebview 内部处理（init 原因触发快照 diff）
    await ctx.pusher.push(true, 'init');
    // 注册表头中英映射变更监听：设置项 / 工作区文件变化时实时热更新当前 panel
    const _hlSubs = onHeaderLabelsChange(() => {
        try {
            ctx.webviewPanel.webview.postMessage({
                type: 'headerLabelsUpdated',
                headerLabels: getHeaderLabels(),
            });
        } catch (_) { /* ignore */ }
    });
    ctx.registerHeaderLabelsSubs(_hlSubs);
    try { ctx.onReady(); } catch (_) { /* ignore */ }
    TelemetryService.sendTelemetryEvent('editor.opened', { fileFormat: ctx.session.type });
}

async function handleSave(msg: any, ctx: EditorMsgCtx): Promise<void> {
    if (!msg?.data) return;
    const filePath = ctx.getFilePath();
    const _saveStart = Date.now();
    const _inRows = (msg.data?.rows || []).length;
    const _inHeaders = (msg.data?.headers || []).length;
    // 空数据防御：如果前端发来的数据是 0 行且 cachedTableData 之前有 N>0 行，
    // 大概率是前端异常状态（例如渲染中途/竞态），直接落盘会导致用户数据被清空。
    // 与 pushDataToWebview 中的可疑空 reparse 拦截逻辑对称，是双向数据安全防线。
    const _prevRows = (ctx.session.cachedTableData?.rows || []).length;
    if (_prevRows > 0 && _inRows === 0 && _inHeaders === 0) {
        ctx.log(`⚠ skip suspicious empty save (prev=${_prevRows}, in=0/0) — likely webview transient state`);
        ctx.webviewPanel.webview.postMessage({
            type: 'saveError',
            message: '检测到异常的空数据保存请求，已跳过以避免覆盖磁盘内容。请刷新后重试。'
        });
        TelemetryService.sendTelemetryEvent('editor.save.skipEmpty', {
            fileFormat: ctx.session.type,
            prevRows: String(_prevRows),
        });
        return;
    }
    ctx.log(`💾 save begin rows=${_inRows} cols=${_inHeaders}`);
    // 写盘前先打时间戳，覆盖 watcher 在 await 期间就回包的极端竞态
    ctx.onSelfSave();
    await ctx.session.parser.save(filePath, msg.data, ctx.session.originalSourceData);
    const _saveDur = Date.now() - _saveStart;
    // 写盘后再次刷新时间戳：fsWatcher / onDidSaveTextDocument 的通知通常发生在
    // writeFile 返回之后，从这一刻开始算 SELF_SAVE_GUARD_MS 才能可靠拦截自反弹。
    ctx.onSelfSave();
    ctx.log(`💾 save done dur=${_saveDur}ms lastSelfSaveAt refreshed`);

    // Webview 编辑保存后，用当前数据与推送快照做差异比对
    const diffStats = await applyDiffHighlight(filePath, ctx.session, msg.data, ctx.log,
        { logPrefix: 'Webview 保存', emptyDiffHighlight: 'null' });
    const _addedRows = diffStats?.addedRows ?? 0;
    const _deletedRows = diffStats?.deletedRows ?? 0;
    const _modifiedRows = diffStats?.modifiedRows ?? 0;
    const _modifiedCells = diffStats?.modifiedCells ?? 0;
    TelemetryService.sendTelemetryEvent('editor.saved', {
        fileFormat: ctx.session.type,
        rows: String(_inRows),
        cols: String(_inHeaders),
        costMs: String(_saveDur),
        appendRows: String(_addedRows),
        changeRows: String(_modifiedRows),
        removeRows: String(_deletedRows),
        changeCells: String(_modifiedCells),
    });
    // 缓存与前端最新数据一致：直接复用 webview 提交上来的 data
    try { ctx.session.cachedTableData = msg.data; } catch (_) { ctx.session.cachedTableData = null; }
    // save 后始终推送高亮状态到 webview（有变化下发新格 / 无变化下发 null 清除残留）
    ctx.pusher.push(false, 'saveHighlight');
    showSaveResult(ctx.webviewPanel, true);
    ctx.log('💾 saved msg posted');
}

async function handlePushTestCase(msg: any, ctx: EditorMsgCtx): Promise<void> {
    if (!msg?.data) return;
    const pushCtx: PushContext = {
        session: ctx.session,
        filePath: ctx.getFilePath(),
        refresh: (reason) => ctx.pusher.push(true, reason, true),
        rowIndexMap: (msg.rowIndexMap && typeof msg.rowIndexMap === 'object') ? msg.rowIndexMap : undefined,
        pushIndexToRow: Array.isArray(msg.pushIndexToRow) ? msg.pushIndexToRow : undefined,
        markSelfSave: () => ctx.onSelfSave(),
    };
    await ctx.pushStrategy.push(msg.data, pushCtx, ctx.webviewPanel, ctx.extensionContext);
}

async function handleOpenTextEditor(_msg: any, ctx: EditorMsgCtx): Promise<void> {
    TelemetryService.sendTelemetryEvent('editor.switchedToText', { fileFormat: ctx.session.type });
    await vscode.commands.executeCommand('vscode.openWith', ctx.documentUri, 'default');
}

async function handleReload(_msg: any, ctx: EditorMsgCtx): Promise<void> {
    // 用户在前端工具栏点击 "刷新" / "重置并获取最新数据"：
    // 强制丢弃缓存重新解析磁盘文件，并以 force=true 让前端绕过 "未保存修改保护" 直接覆盖。
    ctx.log('📨 reload from webview');
    ctx.session.cachedTableData = null;
    await ctx.pusher.push(true, 'reload', true);
    TelemetryService.sendTelemetryEvent('editor.reloaded', { fileFormat: ctx.session.type });
}

async function handleMark(msg: any, ctx: EditorMsgCtx): Promise<void> {
    if (!Array.isArray(msg?.rects)) return;
    const filePath = ctx.getFilePath();
    ctx.log(`📌 mark ${msg.rects.length} rects`);
    const existing = getMarks(filePath);
    const now = Date.now();
    const newRects = msg.rects.filter((r: any) => r && typeof r.r1 === 'number').map((r: any) => {
        const entry: any = { r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2, timestamp: now };
        if (msg.bgColor) entry.bgColor = msg.bgColor;
        if (msg.fontColor) entry.fontColor = msg.fontColor;
        return entry;
    });
    await setMarks(filePath, [...existing, ...newRects]);
    ctx.webviewPanel.webview.postMessage({ type: 'userMarksUpdated', userMarks: getMarks(filePath) });
    TelemetryService.sendTelemetryEvent('editor.marked', { fileFormat: ctx.session.type, count: String(newRects.length) });
}

async function handleSetMarkRects(msg: any, ctx: EditorMsgCtx): Promise<void> {
    if (!Array.isArray(msg?.rects)) return;
    const filePath = ctx.getFilePath();
    ctx.log(`🔄 setMarkRects ${msg.rects.length} rects`);
    if (msg.rects.length === 0) {
        await clearMarks(filePath);
    } else {
        await setMarks(filePath, msg.rects);
    }
    ctx.webviewPanel.webview.postMessage({ type: 'userMarksUpdated', userMarks: getMarks(filePath) });
    TelemetryService.sendTelemetryEvent('editor.unmarked', { fileFormat: ctx.session.type, count: String(msg.rects.length) });
}

async function handleClearAllMarks(_msg: any, ctx: EditorMsgCtx): Promise<void> {
    const filePath = ctx.getFilePath();
    ctx.log('🧹 clearAllMarks');
    await clearMarks(filePath);
    ctx.webviewPanel.webview.postMessage({ type: 'userMarksUpdated', userMarks: [] });
    TelemetryService.sendTelemetryEvent('editor.clearAllMarks', { fileFormat: ctx.session.type });
}

/** ============ 顶层错误处理 ============ */

async function handleDispatchError(err: any, msg: any, ctx: EditorMsgCtx): Promise<void> {
    const errMsg = err?.message || String(err) || '操作失败';
    const kind = msg?.type || '';
    TelemetryService.sendTelemetryErrorEvent('editor.message.error', buildErrorProps(err, {
        messageKind: kind, fileFormat: ctx.session.type, errorMessage: errMsg.slice(0, 500),
    }));
    if (kind === 'save') {
        TelemetryService.sendTelemetryErrorEvent('editor.save.error', { fileFormat: ctx.session.type, errorMessage: errMsg.slice(0, 500) });
        ctx.webviewPanel.webview.postMessage({ type: 'saveError', message: errMsg });
    } else if (kind === 'pushTestCase') {
        TelemetryService.sendTelemetryErrorEvent('editor.push.error', { fileFormat: ctx.session.type, errorMessage: errMsg.slice(0, 500) });
        showPushErrorModal(ctx.webviewPanel, path.basename(ctx.getFilePath()), errMsg);
        ctx.webviewPanel.webview.postMessage({ type: 'pushError', message: errMsg });
    }
    // 网络类错误：展示更友好的操作按钮
    if (kind === 'pushTestCase' && /无法连接后端服务|连接.*超时|连接被重置/.test(errMsg)) {
        TelemetryService.sendTelemetryErrorEvent('editor.network.error', { fileFormat: ctx.session.type });
        const pick = await vscode.window.showErrorMessage(
            `[${ctx.typeName}] ${errMsg}`,
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
        vscode.window.showErrorMessage(`[${ctx.typeName}] ${errMsg}`);
    }
}
