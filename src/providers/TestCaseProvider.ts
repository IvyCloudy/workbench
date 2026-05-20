import * as vscode from 'vscode';
import * as fs from 'fs';
import { BaseWebviewProvider, type MessageHandler } from './BaseWebviewProvider';
import { writeParams } from '../services/storage';
import { queryApi, fetchTaskTree } from '../services/http-client';
import type { WebviewMessage } from '../types';

// ============================================
// 测试案例查看器 Provider
// ============================================

interface ReadyParams {
    testTaskNo: string;
    subTestTaskName: string;
    testPhaseName: string;
    apiUrl: string;
}

export class TestCaseWebviewProvider extends BaseWebviewProvider {
    private readyParams: ReadyParams | null = null;

    protected getPanelId(): string { return 'testcaseViewer'; }
    protected getPanelTitle(): string { return '测试案例'; }
    protected getViewColumn(): vscode.ViewColumn { return vscode.ViewColumn.Beside; }
    protected getHtmlPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'testcase', 'index.html');
    }
    protected getScriptPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'testcase', 'main.js');
    }

    async showWebview(fileUri: vscode.Uri): Promise<void> {
        await this.show();

        const params = await this.extractParamsFromFile(fileUri);
        const config = vscode.workspace.getConfiguration('testcaseViewer');
        const apiUrl = config.get<string>('apiUrl') || 'http://localhost:8081';

        await writeParams(this.context, params);
        this.readyParams = { ...params, apiUrl };
    }

    protected handleMessage: MessageHandler = async (msg: WebviewMessage) => {
        if (msg.command === 'ready' && this.readyParams) {
            this.postMessage({
                command: 'init',
                ...this.readyParams,
                pageSize: '15',
                currentPage: 1
            });
        } else if (msg.command === 'fetchTaskTree') {
            try {
                const treeData = await fetchTaskTree(this.context);
                this.postMessage({ command: 'taskTreeData', data: treeData });
            } catch {
                this.postMessage({ command: 'taskTreeData', data: [] });
            }
        } else if (msg.command === 'query') {
            this.postMessage({ command: 'loading' });
            try {
                const opts: any = {
                    currentPage: msg.currentPage || 1,
                    pageSize: String(msg.pageSize || '20'),
                    testTaskNo: msg.testTaskNo || '',
                    subTestTaskName: msg.subTestTaskName || '',
                    testPhaseName: msg.testPhaseName || '',
                };
                if (msg.testCaseNo) opts.testCaseNo = msg.testCaseNo;
                if (msg.testCaseName) opts.testCaseName = msg.testCaseName;
                if (msg.testCasePath) opts.testCasePath = msg.testCasePath;
                if (msg.testCasePriority) opts.testCasePriority = msg.testCasePriority;
                if (msg.testType) opts.testType = msg.testType;
                if (msg.type) opts.type = msg.type;

                const result = await queryApi(opts, this.context);
                if (result.returnCode === 'SUC0000') {
                    this.postMessage({ command: 'showData', data: result.body });
                } else if (result.returnCode === '2005' && result.errorMsg === '任务测试案例信息不存在') {
                    this.postMessage({ command: 'endOfData' });
                } else {
                    this.postMessage({ command: 'showError', message: result.errorMsg || '查询失败' });
                }
            } catch (err: any) {
                this.postMessage({ command: 'showError', message: err.message || '网络请求失败' });
            }
        }
    };

    private async extractParamsFromFile(fileUri: vscode.Uri): Promise<{ testTaskNo: string; subTestTaskName: string; testPhaseName: string }> {
        try {
            const content = await fs.promises.readFile(fileUri.fsPath, 'utf-8');
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
}
