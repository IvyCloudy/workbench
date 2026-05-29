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
 *    - tsId 由 ensureTrackingColumns 代为生成，生成后立即 save 落盘，保证推送响应能匹配。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce, isInQualifiedDir, buildErrorHtml, FILE_PATTERNS, TS_ID_COLUMN, escapeHtml } from '../services/utils';
import { getHeaderTaskInfoByFilePath } from '../utils/taskInfo';
import { pushTestCase } from '../services/http';
import { createParser, ensureTrackingColumns, applyTestCaseNos, type FileParser, type FileType } from '../parsers';

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
     * 前端选中行 tsId -> 表格中真实的 1-based 行号 映射。
     * 失败弹窗显示「第 X 行」时优先使用此映射，避免按推送数组下标导致行号错位。
     */
    rowIndexMap?: Record<string, number>;
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

        // 任务信息统一由 getHeaderTaskInfoByFilePath 提供：未绑定一律拒绝推送
        const header = getHeaderTaskInfoByFilePath(extensionContext, ctx.filePath);
        if (!header.bind) {
            const message = '未绑定任务，无法推送。请先在 task-bindings.json 中完成绑定。';
            webviewPanel.webview.postMessage({ type: 'pushError', message });
            throw new Error(message);
        }
        const taskInfo = {
            testTaskNo: header.testTaskNo,
            subTestTaskName: header.subTestTaskName,
        };

        // 重新解析文件获取原始结构化数据。
        // 前端 table 中嵌套对象/数组字段被渲染为显示文本（如 "[2 项]"），
        // 但文件落盘时 parser.save 通过 reconstructDetail 保留了正确结构。
        // 此处重新 parse 并用 tsId 匹配，确保推送的是原始数据而非显示文本。
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
        }

        const result = await pushTestCase(extensionContext, pushData, taskInfo, path.basename(ctx.filePath));
        if (result.returnCode !== 'SUC0000') {
            webviewPanel.webview.postMessage({ type: 'pushError', message: result.errorMsg || '推送失败' });
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

        // 成功项：扩展端按 tsId 回写 testCaseNo 到原文件，并刷新前端
        // 注意：cachedTableData 在 webview 调用 save 后会被置为 null（保证下次重新解析），
        // 因此这里不能依赖 session.cachedTableData，而是统一从磁盘最新状态重新解析回写。
        if (successMappings.length > 0) {
            try {
                const parsed = await ctx.session.parser.parse(ctx.filePath);
                ensureTrackingColumns(parsed.tableData, parsed.sourceData);
                applyTestCaseNos(parsed.tableData, parsed.sourceData, successMappings);
                await ctx.session.parser.save(ctx.filePath, parsed.tableData, parsed.sourceData);
                // 落盘后让缓存失效；refresh 内部 forceReparse=true 会重新解析并发给前端
                ctx.session.cachedTableData = null;
                ctx.session.originalSourceData = parsed.sourceData;
                await ctx.refresh('pushSuccess');
            } catch (err: any) {
                console.error('[推送] testCaseNo 回写失败:', err?.message || err);
            }
        }

        // 失败项按 tsId 反查行号，统一通过 webview 弹窗展示（与右键文件推送一致）
        // 优先使用前端传来的 rowIndexMap（真实表格 1-based 行号），缺省时退回按推送数组下标计算（旧逻辑）
        const frontRowIndexMap = ctx.rowIndexMap || {};
        const tsIdToRowIndex = new Map<string, number>();
        if (Array.isArray(pushData)) {
            pushData.forEach((rec: any, i: number) => {
                const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
                if (id) tsIdToRowIndex.set(id, i);
            });
        }
        const failureItems = failures.map(f => {
            const front = frontRowIndexMap[f.tsId];
            let rowIndex: number | undefined;
            if (typeof front === 'number' && front > 0) {
                rowIndex = front;
            } else if (tsIdToRowIndex.has(f.tsId)) {
                rowIndex = tsIdToRowIndex.get(f.tsId)! + 1;
            }
            return { tsId: f.tsId, reason: f.reason, rowIndex };
        });

        const total = Array.isArray(pushData) ? pushData.length : (successMappings.length + failures.length);

        // 编辑器内推送：直接复用前端 webview 弹窗（同一个 panel 内嵌），不再调用 showPushResult 走独立 webview
        webviewPanel.webview.postMessage({
            type: 'pushResult',
            fileName: path.basename(ctx.filePath),
            successCount: successMappings.length,
            failures: failureItems,
            total,
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

    /** 等待 webview 完成 init（已 ready 的立即 resolve） */
    static waitReady(filePath: string, timeoutMs = 5000): Promise<void> {
        const entry = BaseEditorProvider.panelMap.get(filePath);
        if (!entry) return Promise.reject(new Error('panel 未注册: ' + filePath));
        return Promise.race([
            entry.ready,
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('等待 webview 就绪超时')), timeoutMs)
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
        const filePath = document.uri.fsPath;
        const fileName = filePath.split(path.sep).pop() || '';
        // panel 唯一 ID，便于在多 tab 场景下区分日志
        const panelId = `${fileName}#${Math.random().toString(36).slice(2, 8)}`;
        const log = (...args: any[]) => console.log(`[TC-EDITOR][${panelId}]`, ...args);
        const nonce = getNonce();

        log('▶ open', filePath);

        // ⚠ 关键修复：单击文件打开时，VS Code 默认进入"预览 Tab"模式，
        // 同一个预览位仅保留 1 个，新文件会替换旧文件 → 视觉表现为"始终只有一个 tab"。
        // 调用 workbench.action.keepEditor 立即把当前 tab 固化为永久 tab，
        // 这样后续单击其他文件会新开 tab，而不是替换当前 tab。
        try {
            await vscode.commands.executeCommand('workbench.action.keepEditor');
        } catch (_) { /* ignore */ }

        // 先识别文件类型；不合格直接展示错误页
        const resolved = this.resolveFile(document.uri);
        webviewPanel.title = fileName + ' - 测试案例编辑器';
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };

        if (!resolved.qualified || !resolved.type) {
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

        // 自身落盘后短时间内忽略外部变更通知，避免触发自我反弹刷新
        let lastSelfSaveAt = 0;
        const SELF_SAVE_GUARD_MS = 800;

        const pushDataToWebview = async (forceReparse: boolean, reason: string, force?: boolean): Promise<void> => {
            try {
                if (forceReparse || !session.cachedTableData) {
                    const result = await session.parser.parse(filePath);
                    session.originalSourceData = result.sourceData;
                    // 仅确保 tsId 列存在；缺失时立刻落盘让 tsId 持久化
                    const ensured = ensureTrackingColumns(result.tableData, session.originalSourceData);
                    session.cachedTableData = ensured.tableData;
                    if (ensured.generated) {
                        try {
                            lastSelfSaveAt = Date.now();
                            await session.parser.save(filePath, session.cachedTableData, session.originalSourceData);
                            log('💾 tsId 已补全并落盘');
                        } catch (e: any) {
                            log('⚠ tsId 落盘失败:', e?.message || e);
                        }
                    }
                }
                const dataStr = JSON.stringify(session.cachedTableData);
                const uint8Array = new TextEncoder().encode(dataStr);
                const rowsLen = (session.cachedTableData?.rows || []).length;
                log(`📤 push (${reason}) rows=${rowsLen} visible=${webviewPanel.visible} force=${!!force}`);
                webviewPanel.webview.postMessage({
                    type: session.type + 'Data',
                    data: Array.from(uint8Array),
                    force: !!force,
                    reason
                });
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
                    await pushDataToWebview(false, 'visible');
                    return;
                }
                // 强制重新解析最新文件并下发；force=true 让前端绕过「未保存修改保护」直接覆盖
                session.cachedTableData = null;
                await pushDataToWebview(true, 'visible', true);
            } catch (err: any) {
                log('❌ visible-reload failed:', err?.message || err);
                // 兜底：解析失败时仍按缓存推送一次，保证前端有数据
                try { await pushDataToWebview(false, 'visible'); } catch (_) { /* ignore */ }
            }
        });

        // ============ 监听文件外部变更（如 TextEditor 修改保存） ============
        // 通过 FileSystemWatcher 捕获包括 VSCode 内/外的所有写入；
        // 同时通过 onDidSaveTextDocument 作为补充，确保 TextEditor 保存能被捕获到。
        let externalChangeTimer: NodeJS.Timeout | null = null;
        const handleExternalChange = (origin: string) => {
            // 自己刚刚 save 完短时间内的回声忽略
            if (Date.now() - lastSelfSaveAt < SELF_SAVE_GUARD_MS) {
                log(`🔁 ignore self-save echo (${origin})`);
                return;
            }
            if (externalChangeTimer) clearTimeout(externalChangeTimer);
            // 去抖：合并短时间内的多次变更
            externalChangeTimer = setTimeout(() => {
                externalChangeTimer = null;
                log(`📥 external change (${origin}), reload`);
                // 使缓存失效，强制重新解析并下发；force=true 让前端绕过 “未保存修改不覆盖” 的兜底
                session.cachedTableData = null;
                pushDataToWebview(true, 'externalChange', true);
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
            if (externalChangeTimer) { clearTimeout(externalChangeTimer); externalChangeTimer = null; }
            // 仅当当前 panel 仍是注册项时才移除（避免同一文件第二次 open 后误删新条目）
            const cur = BaseEditorProvider.panelMap.get(filePath);
            if (cur && cur.panel === webviewPanel) {
                BaseEditorProvider.panelMap.delete(filePath);
            }
        });

        // ⚠ 关键：必须先绑定 onDidReceiveMessage 再设置 webview.html
        webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                if (msg?.type === 'init') {
                    log('📨 init from webview');
                    await pushDataToWebview(true, 'init');
                    // 通知等待方：webview 已就绪，可以接收推送结果消息
                    try { markReady(); } catch (_) { /* ignore */ }
                } else if (msg?.type === 'save' && msg?.data) {
                    lastSelfSaveAt = Date.now();
                    await session.parser.save(filePath, msg.data, session.originalSourceData);
                    // 文件已落盘，使缓存失效；下次重新可见或下次 init 时会重新解析
                    session.cachedTableData = null;
                    webviewPanel.webview.postMessage({ type: 'saved' });
                } else if (msg?.type === 'pushTestCase' && msg?.data) {
                    const pushCtx: PushContext = {
                        session,
                        filePath,
                        refresh: (reason) => pushDataToWebview(true, reason),
                        rowIndexMap: (msg.rowIndexMap && typeof msg.rowIndexMap === 'object') ? msg.rowIndexMap : undefined,
                    };
                    await this.pushStrategy.push(msg.data, pushCtx, webviewPanel, this.context);
                } else if (msg?.type === 'openTextEditor') {
                    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                }
            } catch (err: any) {
                const errMsg = err?.message || String(err) || '操作失败';
                if (msg?.type === 'save') {
                    webviewPanel.webview.postMessage({ type: 'saveError', message: errMsg });
                } else if (msg?.type === 'pushTestCase') {
                    webviewPanel.webview.postMessage({ type: 'pushError', message: errMsg });
                }
                if (msg?.type === 'pushTestCase' && /无法连接后端服务|连接.*超时|连接被重置/.test(errMsg)) {
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
        const headerTaskInfo = this.context
            ? getHeaderTaskInfoByFilePath(this.context, filePath)
            : { bind: false, testTaskNo: '', testTaskName: '', subTestTaskName: '' };

        webviewPanel.webview.html = await this.buildEditorHtml(nonce, webviewPanel, session.type, headerTaskInfo);
        log('✅ html ready');
    }

    /**
     * 构建 Webview HTML（从模板文件加载并替换占位符）
     */
    private async buildEditorHtml(
        nonce: string,
        webviewPanel: vscode.WebviewPanel,
        dataType: FileType,
        taskInfo: { bind: boolean; testTaskNo: string; subTestTaskName: string; testTaskName: string }
    ): Promise<string> {
        const msgType = `${dataType}Data`;

        const stylesUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'common', 'styles', 'table-editor.css')
        );
        // 表格编辑器脚本已按职能拆分到 editor/ 子目录下，按顺序加载等价于原 editor.js 单文件。
        // 注意：因函数声明在每个 <script> 内部独立提升（不跨脚本），文件加载顺序必须保持。
        //   01-core         —— 全局状态 S、日志、撤销/重做、init 入口、消息分发、通用工具
        //   02-render-bind  —— renderTable 渲染 + 工具栏/全局/表格事件绑定 + 行选/全选
        //   03-cell-ops     —— 单元格编辑、右键菜单、行/列增删改、列宽列拖列选、行高行拖
        //   04-push-find    —— 推送/保存、查找替换面板、Excel 风格列筛选
        //   05-modals       —— 推送结果弹窗、通用 prompt/confirm、明细弹窗，并在末尾调用 init()
        const editorScriptFiles = [
            'editor/01-core.js',
            'editor/02-render-bind.js',
            'editor/03-cell-ops.js',
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
        const safeTestTaskNo = escapeHtml(taskInfo?.testTaskNo || PLACEHOLDER);
        const safeSubTestTaskName = escapeHtml(taskInfo?.subTestTaskName || PLACEHOLDER);
        const safeTestTaskName = escapeHtml(taskInfo?.testTaskName || PLACEHOLDER);

        // 绑定状态标签：首行最左侧展示“已绑定任务 / 未绑定任务”
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
}