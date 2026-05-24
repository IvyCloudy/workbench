/**
 * ============================================================================
 *  providers/TableBrowserProvider.ts
 *  「表格浏览器」Webview
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 列出工作区下合规目录中的 CSV 文件树（委托 FileTreeService）。
 *    2. 读取选中文件的 CSV 内容并展示。
 *    3. 「发送选中行」：调用 batchImportData 将选中行推送到后端。
 *  与 UnifiedEditorProvider 的区别：
 *    - 本 Provider 面向「批量浏览/挑选」场景，不提供单文件编辑能力。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { BaseWebviewProvider, type MessageHandler } from './BaseWebviewProvider';
import { CsvFileParser } from '../parsers/csv-parser';
import { batchImportData } from '../services/http';
import { FileTreeService } from './common/FileTreeService';
import type { WebviewMessage } from '../types';

// ============================================
// 表格浏览器 Provider
// ============================================

export class TableBrowserProvider extends BaseWebviewProvider {
    private fileTreeService = new FileTreeService();
    private csvParser = new CsvFileParser();

    protected getPanelId(): string { return 'tableBrowser'; }
    protected getPanelTitle(): string { return '表格浏览器'; }
    protected getViewColumn(): vscode.ViewColumn { return vscode.ViewColumn.Two; }
    protected getHtmlPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'table-browser', 'index.html');
    }
    protected getScriptPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'table-browser', 'main.js');
    }

    protected handleMessage: MessageHandler = async (msg: WebviewMessage) => {
        switch (msg.command) {
            case 'fetchWorkspaceFiles':
                await this.handleFetchWorkspaceFiles();
                break;
            case 'readCsvFile':
                await this.handleReadCsvFile(msg);
                break;
            case 'sendSelectedData':
                await this.handleSendSelectedData(msg);
                break;
        }
    };

    private async handleFetchWorkspaceFiles(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.postMessage({ command: 'workspaceFiles', data: [], error: '请先打开一个工作区文件夹' });
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const fileTree = this.fileTreeService.buildWorkspaceFileTree(rootPath);
        this.postMessage({ command: 'workspaceFiles', data: fileTree });
    }

    private async handleReadCsvFile(msg: WebviewMessage): Promise<void> {
        const filePath = msg.filePath as string;
        if (!filePath) {
            this.postMessage({ command: 'csvData', data: null, error: '文件路径无效' });
            return;
        }

        try {
            const { tableData } = await this.csvParser.parse(filePath);

            if (!tableData.headers.length && !tableData.rows.length) {
                this.postMessage({ command: 'csvData', data: null, error: 'CSV 文件为空' });
                return;
            }

            this.postMessage({
                command: 'csvData',
                data: {
                    headers: tableData.headers,
                    rows: tableData.rows,
                    fileName: path.basename(filePath)
                }
            });
            console.log('[TableBrowser] CSV 数据已发送，rows:', tableData.rows.length, 'headers:', tableData.headers.length);
        } catch (e: any) {
            this.postMessage({ command: 'csvData', data: null, error: e.message || '读取文件失败' });
        }
    }

    private async handleSendSelectedData(msg: WebviewMessage): Promise<void> {
        const selectedRows = msg.selectedRows as any[];
        const headers = msg.headers as string[];

        if (!selectedRows || selectedRows.length === 0) {
            vscode.window.showWarningMessage('请先勾选要发送的数据');
            return;
        }

        try {
            const result = await batchImportData(this.context, { selectedRows, headers });

            if (result.returnCode === 'SUC0000') {
                this.postMessage({ command: 'sendResult', success: true, message: '数据发送成功' });
                vscode.window.showInformationMessage('数据发送成功');
            } else {
                this.postMessage({ command: 'sendResult', success: false, message: result.errorMsg || '发送失败' });
                vscode.window.showErrorMessage(result.errorMsg || '发送失败');
            }
        } catch (e: any) {
            this.postMessage({ command: 'sendResult', success: false, message: e.message || '发送失败' });
            vscode.window.showErrorMessage(e.message || '发送失败');
        }
    }
}