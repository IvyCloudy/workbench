import * as vscode from 'vscode';
import * as path from 'path';
import { buildTableEditorHtml } from '../services/table-editor-template';
import { getNonce, escapeHtml, isInQualifiedDir, buildErrorHtml } from '../services/utils';
import { pushTestCase } from '../services/http-client';
import type { TableData, PushStrategy } from '../types';

export { getNonce, escapeHtml, isInQualifiedDir, buildErrorHtml };
export type { TableData, PushStrategy };

// ============================================
// 基础编辑器Provider
// ============================================

export class PushViaHttpClient implements PushStrategy {
    async push(data: any, _filePath: string, webviewPanel: vscode.WebviewPanel, context?: vscode.ExtensionContext): Promise<void> {
        if (!context) throw new Error('ExtensionContext 不可用，无法推送');
        console.log(`[推送] 推送数据 (${data.length} 行):`, JSON.stringify(data, null, 2));
        const result = await pushTestCase(data, context);
        if (result.returnCode === 'SUC0000') {
            webviewPanel.webview.postMessage({ type: 'pushSuccess' });
        } else {
            webviewPanel.webview.postMessage({ type: 'pushError', message: result.errorMsg || '推送失败' });
        }
    }
}

export abstract class BaseEditorProvider implements vscode.CustomEditorProvider {
    private onDidChangeCustomDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();
    protected context: vscode.ExtensionContext | undefined;

    constructor(protected extensionUri: vscode.Uri, context?: vscode.ExtensionContext) {
        this.context = context;
    }

    get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentEditEvent<vscode.CustomDocument>> {
        return this.onDidChangeCustomDocumentEmitter.event;
    }

    async openCustomDocument(uri: vscode.Uri, _openContext: { backupId?: string }, _token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
        return { uri: uri, dispose: () => {} } as vscode.CustomDocument;
    }

    async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
        const filePath = document.uri.fsPath;
        const nonce = getNonce();

        const fileName = filePath.split(path.sep).pop() || this.getTypeName();
        webviewPanel.title = fileName + ' - 测试案例编辑器';

        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };

        // 检查文件是否合格
        if (!this.isQualifiedFile(document.uri)) {
            webviewPanel.webview.html = buildErrorHtml(this.getErrorMessage());
            return;
        }

        // 设置HTML内容
        webviewPanel.webview.html = buildTableEditorHtml({
            nonce,
            dataType: this.getDataType(),
            onSave: 'autoSave',
            onOpenTextEditor: 'openTextEditor'
        });

        // 处理来自webview的消息
        webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                if (msg?.type === 'init') {
                    const freshData = await this.parseData(filePath);
                    const dataStr = JSON.stringify(freshData);
                    const encoder = new TextEncoder();
                    const uint8Array = encoder.encode(dataStr);
                    webviewPanel.webview.postMessage({ type: this.getDataType() + 'Data', data: Array.from(uint8Array) });
                } else if (msg?.type === 'save' && msg?.data) {
                    await this.saveFile(filePath, msg.data);
                    webviewPanel.webview.postMessage({ type: 'saved' });
                } else if (msg?.type === 'pushTestCase' && msg?.data) {
                    await this.pushStrategy.push(msg.data, filePath, webviewPanel, this.context);
                } else if (msg?.type === 'openTextEditor') {
                    await vscode.commands.executeCommand(this.getOpenCommand(), filePath);
                }
            } catch (err: any) {
                const errMsg = err?.message || String(err) || '操作失败';
                if (msg?.type === 'save') {
                    webviewPanel.webview.postMessage({ type: 'saveError', message: errMsg });
                } else if (msg?.type === 'pushTestCase') {
                    webviewPanel.webview.postMessage({ type: 'pushError', message: errMsg });
                }
                vscode.window.showErrorMessage(`[${this.getTypeName()}] ${errMsg}`);
            }
        });
    }

    // ==================== 抽象方法（子类实现） ====================

    /** 获取文件类型名称 */
    protected abstract getTypeName(): string;

    /** 获取数据类型标识 */
    protected abstract getDataType(): 'yaml' | 'json' | 'csv';

    /** 打开文本编辑器的命令名 */
    protected abstract getOpenCommand(): string;

    /** 错误消息 */
    protected abstract getErrorMessage(): string;

    /** 检查文件是否合格 */
    protected abstract isQualifiedFile(uri: vscode.Uri): boolean;

    /** 解析文件数据 */
    protected abstract parseData(filePath: string): Promise<TableData>;

    /** 保存文件 */
    protected abstract saveFile(filePath: string, data: TableData): Promise<void>;

    /** 推送策略 */
    protected abstract pushStrategy: PushStrategy;

    // ==================== 接口方法（默认实现） ====================

    saveCustomDocument(_document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        return Promise.resolve();
    }

    saveCustomDocumentAs(_document: vscode.CustomDocument, _destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        return Promise.resolve();
    }

    revertCustomDocument(_document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        return Promise.resolve();
    }

    backupCustomDocument(_document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return Promise.resolve({ id: context.destination.toString(), delete: () => {} });
    }
}
