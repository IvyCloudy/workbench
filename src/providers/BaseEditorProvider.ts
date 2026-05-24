import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce, isInQualifiedDir, buildErrorHtml, FILE_PATTERNS } from '../services/utils';
import { pushTestCase } from '../services/http';
import { createParser, type FileParser, type FileType } from '../parsers';

// 重新导出工具，便于子类使用
export { getNonce, isInQualifiedDir, FILE_PATTERNS };

// ============================================
// 推送策略
// ============================================

export interface PushStrategy {
    push(data: any, filePath: string, webviewPanel: vscode.WebviewPanel, context?: vscode.ExtensionContext): Promise<void>;
}

export class PushViaHttpClient implements PushStrategy {
    async push(data: any, _filePath: string, webviewPanel: vscode.WebviewPanel, context?: vscode.ExtensionContext): Promise<void> {
        if (!context) throw new Error('ExtensionContext 不可用，无法推送');
        console.log(`[推送] 数据 (${data.length} 行):`, JSON.stringify(data, null, 2));
        const result = await pushTestCase(context, data);
        if (result.returnCode === 'SUC0000') {
            webviewPanel.webview.postMessage({ type: 'pushSuccess' });
        } else {
            webviewPanel.webview.postMessage({ type: 'pushError', message: result.errorMsg || '推送失败' });
        }
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
                    session.cachedTableData = result.tableData;
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
                    await this.pushStrategy.push(msg.data, filePath, webviewPanel, this.context);
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

    /** 用于错误页/标题展示的默认类型名（无法识别文件类型时） */
    protected abstract getTypeName(): string;
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
interface EditorSession {
    type: FileType;
    parser: FileParser;
    originalSourceData: any;
    /** 已解析的表格数据缓存：用于切换 tab 重新可见时快速 repush，避免重读文件 */
    cachedTableData: any;
}