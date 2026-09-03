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
import { showSaveResult, showPushErrorModal, showModal } from '../utils/message';
import { reportDeleteResult } from '../utils/deleteFeedback';
import type { PushFailure } from '../utils/message';
import { syncDeletedRows } from '../utils/deletedRowsStore';
import { confirmDeleteTestCase } from '../services/http';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { TelemetryService } from '../utils/telemetry';
import { buildErrorProps } from '../services/utils';
import { resolveTaskInfoOrNull } from '../handlers/pushCore.stages';
import { TS_ID_COLUMN } from '../services/utils';
import { detectFileType, createParser } from '../parsers';
import type { PushStrategy, PushContext } from '../providers/BaseEditorProvider';
import { pushDiag, showPushDiag } from '../utils/pushDiagnostics';

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
        deleteRows: handleDeleteRows,
        confirmDeleteRows: handleConfirmDeleteRows,
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
    pushDiag(`[前端请求] 收到推送 | 前端下发行数=${Array.isArray(msg.data) ? msg.data.length : '非数组'} | pushIndexToRow长度=${Array.isArray(msg.pushIndexToRow) ? msg.pushIndexToRow.length : 0} | rowIndexMap键数=${msg.rowIndexMap && typeof msg.rowIndexMap === 'object' ? Object.keys(msg.rowIndexMap).length : 0} | filePath=${ctx.getFilePath()}`);
    const pushCtx: PushContext = {
        session: ctx.session,
        filePath: ctx.getFilePath(),
        refresh: (reason) => ctx.pusher.push(true, reason, true),
        rowIndexMap: (msg.rowIndexMap && typeof msg.rowIndexMap === 'object') ? msg.rowIndexMap : undefined,
        pushIndexToRow: Array.isArray(msg.pushIndexToRow) ? msg.pushIndexToRow : undefined,
        markSelfSave: () => ctx.onSelfSave(),
    };
    await ctx.pushStrategy.push(msg.data, pushCtx, ctx.webviewPanel, ctx.extensionContext);
    pushDiag('[前端请求] 推送流程结束');
    showPushDiag();
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

/**
 * 删除案例前的「线上预检」：调用删除确认接口，把需要用户二次确认的案例
 * （type=2，存在执行/缺陷关联）明细回传前端，用于在确认弹窗内以表格展示。
 *
 * 设计要点：
 *   - 本接口仅用于**增强提示**，任何失败都不阻断删除：失败时回传 ok=false，
 *     前端降级为「不展示关联表格、按原有简单确认继续」，保证删除链路可用。
 *   - 只回传 type=2 的案例（需要确认的），type=1（允许删除）/ type=3（不存在）
 *     无需用户额外确认，不进表格。
 *
 * 消息契约：
 *   前端 → 扩展：{ type: 'confirmDeleteRows', data: { tsIds: string[] } }
 *   扩展 → 前端：{ type: 'confirmDeleteRowsResult', ok: boolean,
 *                  items: [{ sourceId, testcaseNo, testCaseName, hasExec, hasBug }],
 *                  errorMessage?: string }
 */
async function handleConfirmDeleteRows(msg: any, ctx: EditorMsgCtx): Promise<void> {
    const filePath = ctx.getFilePath();
    const tsIds: string[] = Array.isArray(msg?.data?.tsIds)
        ? msg.data.tsIds.map((x: any) => String(x)).filter(Boolean)
        : [];
    if (tsIds.length === 0 || !ctx.extensionContext) {
        ctx.webviewPanel.webview.postMessage({
            type: 'confirmDeleteRowsResult', ok: false, items: [],
            errorMessage: '无可确认的案例或未初始化',
        });
        return;
    }
    try {
        const t = await resolveTaskInfoOrNull(filePath);
        if (t.status !== 'ok') {
            // 任务信息获取失败（未绑定 / 解析异常）：**阻断删除**并用插件封装的模态框告知用户，
            // 与下方「接口返回非成功码」「网络异常」分支行为保持一致 —— 避免前端
            // 在无校验结论的情况下继续走简单确认弹窗，导致"两个弹窗同框"的体验问题。
            // 文案与「案例文件删除」路径（workspaceListeners.handleCaseFileWillDelete）保持一致
            const _errTxt = t.status === 'unbound'
                ? '当前文件未绑定测试任务，无法定位线上案例，请先绑定测试任务后再删除。'
                : (t.errorMessage || '获取任务信息失败');
            showModal(
                ctx.webviewPanel,
                'warning',
                '提示',
                `删除前校验未通过，已取消删除操作。\n\n错误信息：${_errTxt}`,
            );
            ctx.webviewPanel.webview.postMessage({
                type: 'confirmDeleteRowsResult', ok: false, items: [], blocked: true,
                errorMessage: _errTxt,
            });
            return;
        }
        const resp = await confirmDeleteTestCase(ctx.extensionContext, t.taskInfo, tsIds);
        if (resp.returnCode !== 'SUC0000') {
            // 删除确认接口返回非成功码：**阻断删除**，并用插件封装的模态框告知用户。
            //
            // 与「案例文件删除」路径（workspaceListeners.handleCaseFileWillDelete）保持行为一致：
            // 校验未通过即中止，不允许用户在无校验结论的情况下继续删除线上案例。
            //
            // 弹窗选型：用 showModal（插件封装的独立/内嵌 webview 模态框，带「确定」按钮、
            // 需用户主动关闭）而非 notifyPrecheckFailure（2 秒自动消失的 toast）——
            // toast 一闪而过，用户极易错过，表现为「校验失败但删除照样继续、且没有任何提醒」。
            //
            // blocked:true 通知前端「不要继续删除」，并清理行的 pending（置灰+划线）态。
            // 错误信息只用后端 errorMsg（无则用占位文案），**不与 returnCode 拼接** ——
            // 弹窗已有独立的「返回码：xxx」行，拼接会导致 returnCode 重复出现两次。
            // 与「案例文件删除」路径（workspaceListeners）的文案口径保持一致。
            const _errTxt = resp.errorMsg || '请稍后重试或联系管理员';
            showModal(
                ctx.webviewPanel,
                'warning',
                '提示',
                `删除前校验未通过，已取消删除操作。\n\n返回码：${resp.returnCode || '-'}\n错误信息：${_errTxt}`,
            );
            ctx.webviewPanel.webview.postMessage({
                type: 'confirmDeleteRowsResult', ok: false, items: [], blocked: true,
                errorMessage: _errTxt,
            });
            return;
        }
        // 只取 type=2（需要确认后删除）的案例，映射为前端表格所需字段
        const raw: any[] = Array.isArray(resp.body) ? resp.body : [];
        const items = raw
            .filter((it: any) => Number(it?.type) === 2)
            .map((it: any) => ({
                sourceId: String(it?.sourceId ?? '').trim(),
                testcaseNo: String(it?.data?.testcaseNo ?? '').trim(),
                testCaseName: String(it?.data?.testCaseName ?? '').trim(),
                hasExec: !!it?.data?.hasExec,
                hasBug: !!it?.data?.hasBug,
            }))
            .filter((it: any) => !!it.sourceId);
        ctx.webviewPanel.webview.postMessage({ type: 'confirmDeleteRowsResult', ok: true, items });
    } catch (err: any) {
        // 预检异常（网络 / 解析 / 后端 5xx）：同样**阻断删除**并弹插件封装的模态框，
        // 与案例文件删除路径行为一致（见 handleConfirmDeleteRows 内非成功码分支的说明）。
        const _errTxt = String(err?.message || err || '删除确认接口调用失败');
        showModal(
            ctx.webviewPanel,
            'warning',
            '提示',
            `删除前校验异常，已取消删除操作。\n\n错误信息：${_errTxt}`,
        );
        ctx.webviewPanel.webview.postMessage({
            type: 'confirmDeleteRowsResult', ok: false, items: [], blocked: true,
            errorMessage: _errTxt,
        });
    }
}

/**
 * 编辑器右键"删除该行 / 删除选中行"后，由前端把本次删除的 testcase_id 列表
 * 通过 postMessage 上报，本 handler 直接调用线上删除接口并弹窗反馈。
 *
 * 与命令面板「同步已删除行」的区别：本 handler 只同步"本次删除"的行
 * （显式传入 tsIds），而不是文件内全部待同步行。
 */
async function handleDeleteRows(msg: any, ctx: EditorMsgCtx): Promise<void> {
    const filePath = ctx.getFilePath();
    const tsIds: string[] = Array.isArray(msg?.data?.tsIds)
        ? msg.data.tsIds.map((x: any) => String(x)).filter(Boolean)
        : [];
    // 前端一并提供的「当前表格 testcase_id 有序快照」，用于失败行「删除后视图行号」计算
    // 优先使用此数据（内存态、最新），磁盘解析仅作兜底
    const tsIdOrderFromWebview: string[] = Array.isArray(msg?.data?.tsIdOrder)
        ? msg.data.tsIdOrder.map((x: any) => String(x)).filter(Boolean)
        : [];
    ctx.log(`🗑 deleteRows from webview tsIds=${JSON.stringify(tsIds)} filePath=${filePath}`);
    console.log(`[editor.deleteRows] 收到消息 tsIds=${JSON.stringify(tsIds)} filePath=${filePath}`);
    if (tsIds.length === 0) {
        // 没有可同步的已推送行（例如删除的是未推送行），无需调接口
        return;
    }
    // 埋点：编辑器内删除案例「发起」事件（无论最终是否同步、是否成功都上报，
    // 用于观测"用户在编辑器里触发了删除案例"这一动作本身，与后续
    // editor.deleteRows.synced / .error 形成"发起→结果"闭环）。
    // 携带本次删除的 testcase_id 列表与测试任务信息，便于线上按任务/案例维度归因。
    let taskTestTaskNo = '';
    let taskSubTestTaskId = '';
    try {
        const t = await resolveTaskInfoOrNull(filePath);
        if (t.status === 'ok') {
            taskTestTaskNo = t.taskInfo.testTaskNo || '';
            taskSubTestTaskId = t.taskInfo.subTestTaskId || '';
        }
    } catch (_) { /* 任务信息缺失不阻断删除主流程与埋点 */ }
    TelemetryService.sendTelemetryEvent('editor.deleteRows.init', {
        fileFormat: ctx.session.type,
        requestRows: String(tsIds.length),
        filePath: path.basename(filePath || ''),
        artifactId: path.basename(filePath || ''),
        testTaskNo: taskTestTaskNo,
        subTestTaskId: taskSubTestTaskId,
        testcaseIds: tsIds.join('|'),
    });
    try {
        // 优先使用前端提供的 tsIdOrder；缺失时才降级为读磁盘（历史前端版本兼容）
        let effectiveTsIdOrder: string[] = tsIdOrderFromWebview;
        if (effectiveTsIdOrder.length === 0) {
            try {
                const fileType = detectFileType(filePath);
                if (fileType) {
                    const parser = createParser(fileType);
                    const parsed = await parser.parse(filePath);
                    const parsedHeaders: string[] = parsed?.tableData?.headers || [];
                    const parsedRows: any[][] = parsed?.tableData?.rows || [];
                    const tsIdxInFile = parsedHeaders.indexOf(TS_ID_COLUMN);
                    if (tsIdxInFile >= 0) {
                        effectiveTsIdOrder = [];
                        for (let i = 0; i < parsedRows.length; i++) {
                            const raw = parsedRows[i]?.[tsIdxInFile];
                            const id = raw == null ? '' : String(raw).trim();
                            if (id) effectiveTsIdOrder.push(id);
                        }
                    }
                }
            } catch (_pe) { /* 解析失败不阻断主流程，弹窗降级为不显示行号 */ }
        }

        const result = await syncDeletedRows(filePath, tsIds);

        // 「删除后视图」行号：跳过成功行，其余行按新顺序 1-based 编号
        // 用 tsId 反查每一条失败行在剩余表格中的位置
        const syncedSet = new Set(result.synced.map(String));
        const tsIdToPostRowIndex = new Map<string, number>();
        let cursor = 0;
        for (const id of effectiveTsIdOrder) {
            if (syncedSet.has(id)) continue; // 成功行被删除，不占位
            cursor++;
            if (!tsIdToPostRowIndex.has(id)) tsIdToPostRowIndex.set(id, cursor);
        }

        // 一方面把成功/失败的 tsId 回传前端，前端据此真正删除成功行（失败行保留不丢，
        // 并在表格内以置灰+划线 + 失败原因标记）；另一方面弹“删除结果”汇总弹窗
        // （与文件删除的弹窗同款）罗列失败行及原因。
        const failedTsIds = result.failed.map(f => f.tsId);
        const reasonsById = new Map<string, string>();
        result.failed.forEach(f => reasonsById.set(f.tsId, f.reason));
        try {
            const panel = BaseEditorProvider.getPanel(filePath);
            if (panel) {
                panel.webview.postMessage({
                    type: 'deleteRowsResult',
                    synced: result.synced,
                    failed: failedTsIds,
                    reasons: Array.from(reasonsById.entries()),
                    // 汇总分档：区分 type=1（删除成功）与 type=3（sourceId 不存在，仍算成功）
                    deletedSuccess: result.deletedSuccess,
                    deletedSourceMissing: result.deletedSourceMissing,
                });
            }
        } catch (_e) { /* ignore */ }

        // 弹删除结果弹窗（在当前案例编辑器内嵌 modal，同款样式；见 05f-delete-result.js）
        try {
            const failures: PushFailure[] = result.failed
                .map(f => ({
                    tsId: f.tsId,
                    reason: f.reason || '线上删除失败',
                    rowIndex: tsIdToPostRowIndex.get(f.tsId),
                }))
                // 按行号升序展示；无行号的排最后，其内部按 tsId 稳定排序
                .sort((a, b) => {
                    const ai = a.rowIndex == null ? Number.POSITIVE_INFINITY : a.rowIndex;
                    const bi = b.rowIndex == null ? Number.POSITIVE_INFINITY : b.rowIndex;
                    if (ai !== bi) return ai - bi;
                    return String(a.tsId).localeCompare(String(b.tsId));
                });
            const panel = BaseEditorProvider.getPanel(filePath);
            reportDeleteResult({
                panel,
                fileName: path.basename(filePath || ''),
                successCount: result.synced.length,
                failures,
                total: tsIds.length,
                error: undefined,
                deletedSuccess: result.deletedSuccess.length,
                deletedSourceMissing: result.deletedSourceMissing.length,
            });
        } catch (_e) { /* ignore */ }

        TelemetryService.sendTelemetryEvent('editor.deleteRows.synced', {
            syncedTotal: String(result.synced.length),
            failedRows: String(result.failed.length),
            // 汇总分档：区分 type=1 / type=3（均计入 synced，但口径不同）
            deletedSuccess: String(result.deletedSuccess.length),
            deletedSourceMissing: String(result.deletedSourceMissing.length),
        });
    } catch (err: any) {
        console.error('[editor.deleteRows] 同步失败:', err?.message || err);
        TelemetryService.sendTelemetryErrorEvent('editor.deleteRows.error', buildErrorProps(err, {
            fileFormat: ctx.session.type,
            errorMessage: String(err?.message || String(err)).slice(0, 500),
        }));
        // 兜底：把本次删除的所有 tsId 作为「失败」回传给前端，避免行永远停在
        // "删除中（置灰+划线）" 的 pending 态直到用户 F5。前端 applyDeleteRowsResult
        // 会清理 _pendingDeleteTsIds 并把行标为删除失败，同时展示接口异常原因。
        try {
            const panel = BaseEditorProvider.getPanel(filePath);
            if (panel) {
                const errText = String(err?.message || err || '删除接口调用异常');
                const reasons: Array<[string, string]> = tsIds.map(id => [String(id), errText]);
                panel.webview.postMessage({
                    type: 'deleteRowsResult',
                    synced: [],
                    failed: tsIds.map(String),
                    reasons,
                });
            }
        } catch (_e) { /* ignore */ }
        // 用插件封装的模态框告知用户（前端 applyDeleteRowsResult 只在表格内标记失败行、
        // 不弹窗，因此此处是唯一的用户提示入口）。
        // 改用 showModal 而非 vscode.window.showErrorMessage，
        // 保证与「案例文件删除」等其余插件弹窗样式一致。
        const _errText = String(err?.message || err || '删除接口调用异常');
        showModal(
            ctx.webviewPanel,
            'error',
            '删除案例同步失败',
            `删除案例同步失败，本次删除的 ${tsIds.length} 条案例均已保留（未删除）。\n\n错误信息：${_errText}`,
        );
    }
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
