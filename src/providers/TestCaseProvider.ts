/**
 * ============================================================================
 *  providers/TestCaseProvider.ts
 *  「查看测试案例（线上）」Webview
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 提供「查询参数」初始化：
 *       - 已绑定（task-bindings.json）：取后端真实 testTaskNo / subTestTaskName
 *         + 文件 testPhaseName
 *       - 未绑定：兜底取路径解析得到的 testTaskNo / subTestTaskName，testPhaseName
 *         仍从文件内容提取，保证查询功能可用。
 *    2. 中转前端「查询」/「获取任务树」请求到 services/http。
 *    3. 将本次使用的查询参数写入本地缓存（storage.writeParams）。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { BaseWebviewProvider, type MessageHandler } from './BaseWebviewProvider';
import { writeParams } from '../services/storage';
import { queryTestCases, fetchTaskTree } from '../services/http';
import { resolveTaskInfo } from '../services/utils';
import { getTaskInfoByFilePath, extractTestPhaseName } from '../utils/taskInfo';
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
     * 参数来源：
     *   - 优先走 getTaskInfoByFilePath（基于 task-bindings.json 的真实后端值）
     *   - 未绑定时回退到 resolveTaskInfo + 文件内容提取 testPhaseName
     */
    async showWebview(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        const result = await getTaskInfoByFilePath(this.context, filePath);

        let params: TestCaseParams;
        if (result.bind) {
            const info = result.taskInfo as any;
            params = {
                testTaskNo: info.testTaskNo,
                subTestTaskName: info.subTestTaskName,
                testPhaseName: info.testPhaseName,
            };
        } else {
            // 未绑定：兜底用路径解析 + 文件内容，保持原有可用性
            const r = resolveTaskInfo(filePath);
            const testPhaseName = await extractTestPhaseName(filePath);
            params = {
                testTaskNo: r.info.testTaskNo,
                subTestTaskName: r.info.subTestTaskName,
                testPhaseName,
            };
            if (!r.ok) {
                vscode.window.showWarningMessage(r.error);
            }
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