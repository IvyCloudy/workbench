import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { readConfig } from './storage';
import type { AppConfig, ApiResponse, QueryOptions } from '../types';

// ============================================
// 类型
// ============================================

export interface HttpResponse<T = any> {
    status: number;
    data: T;
}

// ============================================
// 配置
// ============================================

const DEFAULT_TIMEOUT = 10000;

async function getApiBaseUrl(context: vscode.ExtensionContext): Promise<string> {
    const cfg = await readConfig(context);
    let url = (cfg.apiUrl || 'http://127.0.0.1:8081').trim();
    // 去掉尾部斜杠
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
}

// ============================================
// 内部：构造请求头（含 SM2 签名）
// ============================================

async function buildHeaders(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    const appConfig = await readConfig(context);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };

    if (appConfig.authToken) headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId) headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName) headers['X-User-Name'] = encodeURIComponent(appConfig.userName);

    addSm2Signature(headers, appConfig);
    return headers;
}

function addSm2Signature(headers: Record<string, string>, appConfig: AppConfig): void {
    const publicKey = appConfig.sm2PublicKey;
    if (!publicKey) return;

    try {
        const sm2 = require('sm-crypto').sm2;
        const timestamp = Date.now();
        headers['X-Timestamp'] = String(timestamp);
        headers['X-Signature'] = sm2.doEncrypt(String(timestamp), publicKey);
    } catch (error) {
        console.error('[http] SM2 签名失败:', error);
    }
}

// ============================================
// 内部：执行 HTTP 请求
// ============================================

function makeRequest<T = any>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string
): Promise<HttpResponse<T>> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'localhost') urlObj.hostname = '127.0.0.1';

        const options: http.RequestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method,
            headers,
        };

        const client = urlObj.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const responseData = data ? JSON.parse(data) : {};
                    resolve({ status: res.statusCode || 200, data: responseData });
                } catch {
                    resolve({ status: res.statusCode || 200, data: { raw: data } as T });
                }
            });
        });

        req.on('error', (err: NodeJS.ErrnoException) => {
            const target = `${urlObj.hostname}:${urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80)}`;
            switch (err.code) {
                case 'ECONNREFUSED':
                    reject(new Error(`无法连接后端服务（${target}），请确认服务已启动`));
                    break;
                case 'ETIMEDOUT':
                    reject(new Error(`连接后端服务超时（${target}），请检查网络或服务状态`));
                    break;
                case 'ENOTFOUND':
                    reject(new Error(`无法解析后端服务地址（${urlObj.hostname}），请检查配置`));
                    break;
                case 'ECONNRESET':
                    reject(new Error(`后端服务连接被重置（${target}），请稍后重试`));
                    break;
                default:
                    reject(err);
            }
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时，请检查后端服务是否可用'));
        });
        req.setTimeout(DEFAULT_TIMEOUT);

        if (body) req.write(body);
        req.end();
    });
}

async function post<T = any>(
    context: vscode.ExtensionContext,
    url: string,
    data?: any
): Promise<HttpResponse<T>> {
    const headers = await buildHeaders(context);
    const body = data ? JSON.stringify(data) : undefined;
    return makeRequest<T>('POST', url, headers, body);
}

// ============================================
// 业务 API
// ============================================

/**
 * 获取测试任务树
 */
export async function fetchTaskTree(context: vscode.ExtensionContext): Promise<any[]> {
    const url = `${await getApiBaseUrl(context)}/test-task/task-tree`;
    const response = await post<ApiResponse<any[]>>(context, url, {});
    if (response.data.returnCode === 'SUC0000') {
        return response.data.body || [];
    }
    throw new Error(response.data.errorMsg || '获取任务树失败');
}

/**
 * 查询测试案例
 */
export async function queryTestCases(
    context: vscode.ExtensionContext,
    opts: QueryOptions
): Promise<ApiResponse> {
    const url = `${await getApiBaseUrl(context)}/test-task/test-case`;

    const body: Record<string, any> = {
        testTaskNo: opts.testTaskNo,
        subTestTaskName: opts.subTestTaskName,
        testPhaseName: opts.testPhaseName || '',
        currentPage: opts.currentPage,
        pageSize: opts.pageSize
    };
    if (opts.testCaseNo) body.testCaseNo = opts.testCaseNo;
    if (opts.testCaseName) body.testCaseName = opts.testCaseName;
    if (opts.testCasePath) body.testCasePath = opts.testCasePath;
    if (opts.testCasePriority) body.testCasePriority = opts.testCasePriority;
    if (opts.testType) body.testType = opts.testType;
    if (opts.type) body.type = opts.type;

    const response = await post<ApiResponse>(context, url, body);
    return response.data;
}

/**
 * 批量导入数据
 */
export async function batchImportData(
    context: vscode.ExtensionContext,
    opts: { selectedRows: any[]; headers: string[] }
): Promise<ApiResponse> {
    const url = `${await getApiBaseUrl(context)}/test-task/batch-import`;
    const body = { headers: opts.headers, rows: opts.selectedRows };
    const response = await post<ApiResponse>(context, url, body);
    return response.data;
}

/**
 * 推送测试案例数据
 */
export async function pushTestCase(
    context: vscode.ExtensionContext,
    data: any[]
): Promise<ApiResponse> {
    const url = `${await getApiBaseUrl(context)}/test-task/push-testcase`;
    const response = await post<ApiResponse>(context, url, data);
    return response.data;
}
