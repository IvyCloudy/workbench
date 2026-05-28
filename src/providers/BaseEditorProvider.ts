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
import { getNonce, isInQualifiedDir, buildErrorHtml, FILE_PATTERNS, resolveTaskInfo, TS_ID_COLUMN } from '../services/utils';
import { pushTestCase } from '../services/http';
import { createParser, ensureTrackingColumns, applyTestCaseNos, type FileParser, type FileType } from '../parsers';
import { showPushResult } from './PushResultProvider';

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
        const r = resolveTaskInfo(ctx.filePath);
        if (!r.ok) {
            webviewPanel.webview.postMessage({ type: 'pushError', message: r.error });
            throw new Error(r.error);
        }
        const taskInfo = r.info;

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
        if (successMappings.length > 0 && ctx.session.cachedTableData) {
            try {
                applyTestCaseNos(ctx.session.cachedTableData, ctx.session.originalSourceData, successMappings);
                await ctx.session.parser.save(ctx.filePath, ctx.session.cachedTableData, ctx.session.originalSourceData);
                // 落盘后让缓存失效；refresh 内部 forceReparse=true 会重新解析并发给前端
                ctx.session.cachedTableData = null;
                await ctx.refresh('pushSuccess');
            } catch (err: any) {
                console.error('[推送] testCaseNo 回写失败:', err?.message || err);
            }
        }

        // 失败项按 tsId 反查行号，统一通过 webview 弹窗展示（与右键文件推送一致）
        const tsIdToRowIndex = new Map<string, number>();
        if (Array.isArray(pushData)) {
            pushData.forEach((rec: any, i: number) => {
                const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
                if (id) tsIdToRowIndex.set(id, i);
            });
        }
        const failureItems = failures.map(f => ({
            tsId: f.tsId,
            reason: f.reason,
            rowIndex: tsIdToRowIndex.has(f.tsId) ? (tsIdToRowIndex.get(f.tsId)! + 1) : undefined,
        }));

        const total = Array.isArray(pushData) ? pushData.length : (successMappings.length + failures.length);
        showPushResult(extensionContext, {
            fileName: path.basename(ctx.filePath),
            successCount: successMappings.length,
            failures: failureItems,
            total,
        });

        // 通知前端推送流程已完成（用于隐藏 loading 之类的状态；不再驱动前端弹窗）
        webviewPanel.webview.postMessage({ type: 'pushDone' });
    }
}

// ============================================
// 基础编辑器 Provider
// ============================================

export abstract class BaseEditorProvider implements vscode.CustomEditorProvider {
    private onDidChangeCustomDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();
    protected context: vscode.ExtensionContext | undefined;

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

        const pushDataToWebview = async (forceReparse: boolean, reason: string): Promise<void> => {
            try {
                if (forceReparse || !session.cachedTableData) {
                    const result = await session.parser.parse(filePath);
                    session.originalSourceData = result.sourceData;
                    // 仅确保 tsId 列存在；缺失时立刻落盘让 tsId 持久化
                    const ensured = ensureTrackingColumns(result.tableData, session.originalSourceData);
                    session.cachedTableData = ensured.tableData;
                    if (ensured.generated) {
                        try {
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
                log(`📤 push (${reason}) rows=${rowsLen} visible=${webviewPanel.visible}`);
                webviewPanel.webview.postMessage({
                    type: session.type + 'Data',
                    data: Array.from(uint8Array)
                });
            } catch (err: any) {
                log('❌ push failed:', err?.message || err);
            }
        };

        // 监听 panel 可见性变化（仅在变可见时打日志，并兜底重发数据）
        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.visible) {
                log('👁 visible');
                pushDataToWebview(false, 'visible');
            }
        });

        webviewPanel.onDidDispose(() => log('🗑 disposed'));

        // ⚠ 关键：必须先绑定 onDidReceiveMessage 再设置 webview.html
        webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                if (msg?.type === 'init') {
                    log('📨 init from webview');
                    await pushDataToWebview(true, 'init');
                } else if (msg?.type === 'save' && msg?.data) {
                    await session.parser.save(filePath, msg.data, session.originalSourceData);
                    // 文件已落盘，使缓存失效；下次重新可见或下次 init 时会重新解析
                    session.cachedTableData = null;
                    webviewPanel.webview.postMessage({ type: 'saved' });
                } else if (msg?.type === 'pushTestCase' && msg?.data) {
                    const pushCtx: PushContext = {
                        session,
                        filePath,
                        refresh: (reason) => pushDataToWebview(true, reason)
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

        webviewPanel.webview.html = await this.buildEditorHtml(nonce, webviewPanel, session.type);
        log('✅ html ready');
    }

    /**
     * 构建 Webview HTML（从模板文件加载并替换占位符）
     */
    private async buildEditorHtml(nonce: string, webviewPanel: vscode.WebviewPanel, dataType: FileType): Promise<string> {
        const msgType = `${dataType}Data`;

        const stylesUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'common', 'styles', 'table-editor.css')
        );
        const editorUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'table-editor', 'editor.js')
        );
        const cspSource = webviewPanel.webview.cspSource;

        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'table-editor', 'index.html');
        const htmlBytes = await vscode.workspace.fs.readFile(htmlPath);
        const template = Buffer.from(htmlBytes).toString('utf8');

        return template
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace(/\{\{dataType\}\}/g, dataType)
            .replace(/\{\{msgType\}\}/g, msgType)
            .replace(/\{\{cspSource\}\}/g, cspSource)
            .replace(/\{\{stylesUri\}\}/g, stylesUri.toString())
            .replace(/\{\{editorUri\}\}/g, editorUri.toString());
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