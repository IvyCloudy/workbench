import * as vscode from 'vscode';
import * as fs from 'fs';
import { writeParams } from '../services/store';
const { queryApi, fetchTaskTree } = require('../services/http-client');

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export class TestCaseWebviewProvider {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private readyParams: { testTaskNo: string; subTestTaskName: string; testPhaseName: string; apiUrl: string } | null = null;

    constructor(
        private extensionUri: vscode.Uri,
        private context: vscode.ExtensionContext
    ) { }

    async showWebview(fileUri: vscode.Uri): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
        } else {
            this.panel = vscode.window.createWebviewPanel(
                'testcaseViewer',
                '测试案例',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(this.extensionUri, 'media')
                    ]
                }
            );

            this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
            this.panel.webview.onDidReceiveMessage(
                msg => this.handleMessage(msg),
                null,
                this.disposables
            );
        }

        const params = await this.extractParamsFromFile(fileUri);
        const config = vscode.workspace.getConfiguration('testcaseViewer');
        const apiUrl = config.get<string>('apiUrl') || 'http://localhost:8081';

        writeParams(this.context, params);
        this.readyParams = { ...params, apiUrl };
        this.panel.webview.html = this.getHtmlContent();
    }

    private async handleMessage(msg: any): Promise<void> {
        if (msg.command === 'ready' && this.readyParams) {
            this.panel?.webview.postMessage({
                command: 'init',
                ...this.readyParams,
                pageSize: '15',
                currentPage: 1
            });
        } else if (msg.command === 'fetchTaskTree') {
            try {
                const treeData = await fetchTaskTree(this.context);
                this.panel?.webview.postMessage({ command: 'taskTreeData', data: treeData });
            } catch {
                this.panel?.webview.postMessage({ command: 'taskTreeData', data: [] });
            }
        } else if (msg.command === 'query') {
            this.panel?.webview.postMessage({ command: 'loading' });
            try {
                const opts = {
                    currentPage: msg.currentPage || 1,
                    pageSize: String(msg.pageSize || '20'),
                    testTaskNo: msg.testTaskNo || '',
                    subTestTaskName: msg.subTestTaskName || '',
                    testPhaseName: msg.testPhaseName || '',
                } as any;
                if (msg.testCaseNo) opts.testCaseNo = msg.testCaseNo;
                if (msg.testCaseName) opts.testCaseName = msg.testCaseName;
                if (msg.testCasePath) opts.testCasePath = msg.testCasePath;
                if (msg.testCasePriority) opts.testCasePriority = msg.testCasePriority;
                if (msg.testType) opts.testType = msg.testType;
                if (msg.type) opts.type = msg.type;

                const result = await queryApi(opts, this.context);
                if (result.returnCode === 'SUC0000') {
                    this.panel?.webview.postMessage({
                        command: 'showData',
                        data: result.body,
                    });
                } else if (result.returnCode === '2005' && result.errorMsg === '任务测试案例信息不存在') {
                    this.panel?.webview.postMessage({ command: 'endOfData' });
                } else {
                    this.panel?.webview.postMessage({ command: 'showError', message: result.errorMsg || '查询失败' });
                }
            } catch (err: any) {
                this.panel?.webview.postMessage({ command: 'showError', message: err.message || '网络请求失败' });
            }
        }
    }

    private async extractParamsFromFile(fileUri: vscode.Uri): Promise<{ testTaskNo: string; subTestTaskName: string; testPhaseName: string }> {
        try {
            const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length < 2) return { testTaskNo: '', subTestTaskName: '', testPhaseName: '' };

            const headers = this.parseCsvLine(lines[0]);
            const data = this.parseCsvLine(lines[1]);

            const testTaskNoIdx = headers.findIndex(h => h.trim().toLowerCase() === 'testtaskno');
            const subTestTaskNameIdx = headers.findIndex(h => h.trim().toLowerCase() === 'subtesttaskname');
            const testPhaseNameIdx = headers.findIndex(h => h.trim().toLowerCase() === 'testphasename');

            return {
                testTaskNo: testTaskNoIdx >= 0 ? (data[testTaskNoIdx] || '').trim() : '',
                subTestTaskName: subTestTaskNameIdx >= 0 ? (data[subTestTaskNameIdx] || '').trim() : '',
                testPhaseName: testPhaseNameIdx >= 0 ? (data[testPhaseNameIdx] || '').trim() : '',
            };
        } catch {
            return { testTaskNo: '', subTestTaskName: '', testPhaseName: '' };
        }
    }

    private parseCsvLine(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }

    private getHtmlContent(): string {
        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'testcase', 'index.html');
        const scriptUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'testcase', 'main.js')
        );
        const nonce = getNonce();
        let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');
        html = html.replace(/\$\{scriptUri\}/g, scriptUri.toString());
        html = html.replace(/\$\{nonce\}/g, nonce);
        return html;
    }

    private dispose(): void {
        this.panel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
