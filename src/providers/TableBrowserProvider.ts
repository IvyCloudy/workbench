import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BaseWebviewProvider, type MessageHandler } from './BaseWebviewProvider';
import { loadCsvFromFile } from '../services/csv-parser';
import { sendSelectedData } from '../services/http-client';
import type { FileNode, WebviewMessage, ExcelData } from '../types';

// ============================================
// 表格浏览器 Provider
// ============================================

export class TableBrowserProvider extends BaseWebviewProvider {
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

    private buildFileTree(rootPath: string): FileNode[] {
        const result: FileNode[] = [];

        try {
            const firstLevelEntries = fs.readdirSync(rootPath, { withFileTypes: true });

            for (const firstEntry of firstLevelEntries) {
                if (!firstEntry.isDirectory() || (firstEntry.name !== '测试任务' && firstEntry.name !== 'testtask')) {
                    continue;
                }

                const testTaskPath = path.join(rootPath, firstEntry.name);
                const taskChildren: FileNode[] = [];

                try {
                    const secondLevelEntries = fs.readdirSync(testTaskPath, { withFileTypes: true });

                    for (const secondEntry of secondLevelEntries) {
                        if (!secondEntry.isDirectory()) continue;

                        const subTaskPath = path.join(testTaskPath, secondEntry.name);
                        const caseChildren: FileNode[] = [];

                        try {
                            const thirdLevelEntries = fs.readdirSync(subTaskPath, { withFileTypes: true });

                            for (const thirdEntry of thirdLevelEntries) {
                                if (!thirdEntry.isDirectory() || (thirdEntry.name !== '测试案例' && thirdEntry.name !== 'testcase')) {
                                    continue;
                                }

                                const casePath = path.join(subTaskPath, thirdEntry.name);
                                const csvFiles = this.getCsvFilesInDir(casePath);

                                if (csvFiles.length > 0) {
                                    caseChildren.push({
                                        name: thirdEntry.name,
                                        path: casePath,
                                        isDirectory: true,
                                        children: csvFiles
                                    });
                                }
                            }
                        } catch (e) {
                            console.error(`[TableBrowser] Error reading directory ${subTaskPath}:`, e);
                        }

                        if (caseChildren.length > 0) {
                            taskChildren.push({
                                name: secondEntry.name,
                                path: subTaskPath,
                                isDirectory: true,
                                children: caseChildren
                            });
                        }
                    }
                } catch (e) {
                    console.error(`[TableBrowser] Error reading directory ${testTaskPath}:`, e);
                }

                if (taskChildren.length > 0) {
                    result.push({
                        name: firstEntry.name,
                        path: testTaskPath,
                        isDirectory: true,
                        children: taskChildren
                    });
                }
            }
        } catch (e) {
            console.error('[TableBrowser] Error building file tree:', e);
        }

        return result;
    }

    private getCsvFilesInDir(dirPath: string): FileNode[] {
        const csvFiles: FileNode[] = [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() && /\.csv$/i.test(entry.name)) {
                    csvFiles.push({
                        name: entry.name,
                        path: path.join(dirPath, entry.name),
                        isDirectory: false
                    });
                }
            }
        } catch (e) {
            console.error(`[TableBrowser] Error reading directory ${dirPath}:`, e);
        }
        return csvFiles;
    }

    private async handleFetchWorkspaceFiles(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.postMessage({ command: 'workspaceFiles', data: [], error: '请先打开一个工作区文件夹' });
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const fileTree = this.buildFileTree(rootPath);
        this.postMessage({ command: 'workspaceFiles', data: fileTree });
    }

    private async handleReadCsvFile(msg: WebviewMessage): Promise<void> {
        const filePath = msg.filePath as string;
        if (!filePath) {
            this.postMessage({ command: 'csvData', data: null, error: '文件路径无效' });
            return;
        }

        try {
            const data = await loadCsvFromFile(filePath);
            const result = this.convertToTableData(data);

            if (!result) {
                this.postMessage({ command: 'csvData', data: null, error: 'CSV文件为空' });
                return;
            }

            this.postMessage({
                command: 'csvData',
                data: {
                    headers: result.headers,
                    rows: result.rows,
                    fileName: path.basename(filePath)
                }
            });
            console.log('[TableBrowser] CSV数据已发送，rows:', result.rows.length, 'headers:', result.headers.length);
        } catch (e: any) {
            this.postMessage({ command: 'csvData', data: null, error: e.message || '读取文件失败' });
        }
    }

    private convertToTableData(data: ExcelData): { headers: string[], rows: string[][] } | null {
        const sheet = data.sheets[0];
        if (!sheet) return null;

        const headers: string[] = [];
        const rows: string[][] = [];

        const row0 = sheet.rows[0];
        if (row0) {
            const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
        }

        const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
        rowKeys.forEach(ri => {
            if (ri === 0 && headers.length > 0) return;
            const row = sheet.rows[ri];
            if (!row) return;
            const rowData: string[] = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
            while (rowData.length < headers.length) rowData.push('');
            rows.push(rowData);
        });

        return { headers, rows };
    }

    private async handleSendSelectedData(msg: WebviewMessage): Promise<void> {
        const selectedRows = msg.selectedRows as any[];
        const headers = msg.headers as string[];

        if (!selectedRows || selectedRows.length === 0) {
            vscode.window.showWarningMessage('请先勾选要发送的数据');
            return;
        }

        try {
            const result = await sendSelectedData({ selectedRows, headers }, this.context);

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
