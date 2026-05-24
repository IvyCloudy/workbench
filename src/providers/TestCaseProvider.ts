/**
 * ============================================================================
 *  providers/TestCaseProvider.ts
 *  「查看测试案例（线上）」Webview
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 提供「查询参数」初始化：
 *       - testTaskNo / subTestTaskName 从路径解析（resolveTaskInfo）
 *       - testPhaseName 从文件内容提取（ParamExtractor）
 *    2. 中转前端「查询」/「获取任务树」请求到 services/http。
 *    3. 将本次使用的查询参数写入本地缓存（storage.writeParams）。
 *  设计要点：
 *    - 类内包含三块職责：ParamExtractor / QueryService / Provider，各取所需，便于单测。
 *    - testTaskNo / subTestTaskName 严格与推送链路保持一致来源，避免两路双存。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseWebviewProvider, type MessageHandler } from './BaseWebviewProvider';
import { writeParams } from '../services/storage';
import { queryTestCases, fetchTaskTree } from '../services/http';
import { resolveTaskInfo } from '../services/utils';
import type { WebviewMessage } from '../types';

// ============================================
// 类型定义
// ============================================

interface TestCaseParams {
    testTaskNo: string;
    subTestTaskName: string;
    testPhaseName: string;
}

interface ReadyParams extends TestCaseParams {
    apiUrl: string;
}

interface QueryOptions {
    currentPage?: number;
    pageSize?: string;
    testTaskNo?: string;
    subTestTaskName?: string;
    testPhaseName?: string;
    testCaseNo?: string;
    testCaseName?: string;
    testCasePath?: string;
    testCasePriority?: string;
    testType?: string;
    type?: string;
}

interface QueryResult {
    success: boolean;
    data?: any;
    error?: string;
    endOfData?: boolean;
}

const EMPTY_PARAMS: TestCaseParams = { testTaskNo: '', subTestTaskName: '', testPhaseName: '' };

// ============================================
// 文件参数提取
// ============================================
// testTaskNo / subTestTaskName 不再从文件内容提取，而是与推送链路保持一致，
// 由 parseTaskInfoFromPath 从第三层目录 {testTaskNo}_{subTestTaskName} 解析；
// 这里仅负责从 CSV / YAML / JSON 文件内容中提取 testPhaseName。

class ParamExtractor {
    async extractTestPhaseName(fileUri: string): Promise<string> {
        try {
            const content = await fs.promises.readFile(fileUri, 'utf-8');
            const ext = path.extname(fileUri).toLowerCase();

            if (ext === '.csv') return this.fromCsv(content);
            if (ext === '.yaml' || ext === '.yml') return this.fromYaml(content);
            if (ext === '.json') return this.fromJson(content);
        } catch {
            // fall through
        }
        return '';
    }

    private fromCsv(content: string): string {
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length < 2) return '';

        const headers = this.parseCsvLine(lines[0]);
        const data = this.parseCsvLine(lines[1]);
        const idx = headers.findIndex(h => h.trim().toLowerCase() === 'testphasename');
        return idx >= 0 ? (data[idx] || '').trim() : '';
    }

    private fromYaml(content: string): string {
        try {
            const YAML = require('yaml');
            const parsed = YAML.parse(content);
            const records = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
            return records.length > 0 ? this.searchKey(records[0], 'testPhaseName') : '';
        } catch {
            return '';
        }
    }

    private fromJson(content: string): string {
        try {
            const parsed = JSON.parse(content);
            const records = Array.isArray(parsed) ? parsed : [parsed];
            return records.length > 0 ? this.searchKey(records[0], 'testPhaseName') : '';
        } catch {
            return '';
        }
    }

    /** 在对象中递归查找指定 key（大小写不敏感），返回首个匹配字符串值 */
    private searchKey(obj: any, target: string): string {
        if (!obj || typeof obj !== 'object') return '';
        const lowerKey = target.toLowerCase();
        for (const k of Object.keys(obj)) {
            if (k.toLowerCase() === lowerKey) return String(obj[k] ?? '').trim();
            if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
                const v = this.searchKey(obj[k], target);
                if (v) return v;
            }
        }
        return '';
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

// ============================================
// 查询服务（HTTP 调用封装）
// ============================================

class QueryService {
    constructor(private context: vscode.ExtensionContext) {}

    async queryTestCases(options: QueryOptions): Promise<QueryResult> {
        try {
            const opts: any = {
                currentPage: options.currentPage || 1,
                pageSize: String(options.pageSize || '20'),
                testTaskNo: options.testTaskNo || '',
                subTestTaskName: options.subTestTaskName || '',
                testPhaseName: options.testPhaseName || '',
            };
            if (options.testCaseNo) opts.testCaseNo = options.testCaseNo;
            if (options.testCaseName) opts.testCaseName = options.testCaseName;
            if (options.testCasePath) opts.testCasePath = options.testCasePath;
            if (options.testCasePriority) opts.testCasePriority = options.testCasePriority;
            if (options.testType) opts.testType = options.testType;
            if (options.type) opts.type = options.type;

            const result = await queryTestCases(this.context, opts);

            if (result.returnCode === 'SUC0000') {
                return { success: true, data: result.body };
            }
            if (result.returnCode === '2005' && result.errorMsg === '任务测试案例信息不存在') {
                return { success: true, endOfData: true };
            }
            return { success: false, error: result.errorMsg || '查询失败' };
        } catch (err: any) {
            return { success: false, error: err.message || '网络请求失败' };
        }
    }

    async getTaskTree(): Promise<any[]> {
        try {
            return await fetchTaskTree(this.context);
        } catch {
            return [];
        }
    }
}

// ============================================
// 测试案例 Webview Provider
// ============================================

export class TestCaseProvider extends BaseWebviewProvider {
    private paramExtractor = new ParamExtractor();
    private queryService: QueryService;
    private readyParams: ReadyParams | null = null;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        super(extensionUri, context);
        this.queryService = new QueryService(context);
    }

    protected getPanelId(): string { return 'testcaseViewer'; }
    protected getPanelTitle(): string { return '测试案例'; }
    protected getViewColumn(): vscode.ViewColumn { return vscode.ViewColumn.Beside; }
    protected getHtmlPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'testcase', 'index.html');
    }
    protected getScriptPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'testcase', 'main.js');
    }

    /**
     * 显示 Webview 并加载文件参数
     *
     * 参数来源（与推送链路保持一致）：
     *   - testTaskNo / subTestTaskName：从第三层目录 {编号}_{子任务名} 解析
     *     （路径形如 .../测试任务/<testTaskNo>_<subTestTaskName>/测试案例/<file>）
     *   - testPhaseName：从文件内容（CSV header / YAML / JSON 字段）提取
     */
    async showWebview(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        const r = resolveTaskInfo(filePath);
        const testPhaseName = await this.paramExtractor.extractTestPhaseName(filePath);

        const params: TestCaseParams = {
            testTaskNo: r.info.testTaskNo,
            subTestTaskName: r.info.subTestTaskName,
            testPhaseName,
        };

        if (!r.ok) {
            vscode.window.showWarningMessage(r.error);
        }

        const config = vscode.workspace.getConfiguration('testcaseViewer');
        const apiUrl = config.get<string>('apiUrl') || 'http://localhost:8081';

        this.readyParams = { ...params, apiUrl };

        await this.show();
        await writeParams(this.context, params);
    }

    /**
     * 处理来自 Webview 的消息
     */
    protected handleMessage: MessageHandler = async (msg: WebviewMessage) => {
        try {
            if (msg.command === 'ready' && this.readyParams) {
                this.postMessage({
                    command: 'init',
                    ...this.readyParams,
                    pageSize: '15',
                    currentPage: 1,
                });
                return;
            }

            if (msg.command === 'fetchTaskTree') {
                const treeData = await this.queryService.getTaskTree();
                this.postMessage({ command: 'taskTreeData', data: treeData });
                return;
            }

            if (msg.command === 'query') {
                const result = await this.queryService.queryTestCases({
                    currentPage: msg.currentPage || 1,
                    pageSize: msg.pageSize || '20',
                    testTaskNo: msg.testTaskNo || '',
                    subTestTaskName: msg.subTestTaskName || '',
                    testPhaseName: msg.testPhaseName || '',
                    testCaseNo: msg.testCaseNo,
                    testCaseName: msg.testCaseName,
                    testCasePath: msg.testCasePath,
                    testCasePriority: msg.testCasePriority,
                    testType: msg.testType,
                    type: msg.type,
                });

                if (!result.success) {
                    this.postMessage({ command: 'showError', message: result.error || '查询失败' });
                } else if (result.endOfData) {
                    this.postMessage({ command: 'endOfData' });
                } else {
                    this.postMessage({ command: 'showData', data: result.data });
                }
            }
        } catch (err: any) {
            this.postMessage({
                command: 'showError',
                message: `消息处理失败: ${err?.message || err}`,
            });
        }
    };
}