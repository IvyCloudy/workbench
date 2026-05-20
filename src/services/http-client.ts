import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { readConfig } from './storage';
import type { QueryOptions, ApiResponse } from '../types';

// ============================================
// SM2 签名
// ============================================

let sm2Module: any = null;
function getSm2(): any {
    if (!sm2Module) {
        try {
            sm2Module = require('sm-crypto').sm2;
        } catch (e) {
            console.error('[http-client] sm-crypto 加载失败:', e);
        }
    }
    return sm2Module;
}

async function addSm2Signature(headers: Record<string, string>, context: vscode.ExtensionContext): Promise<void> {
    const appConfig = await readConfig(context);
    const publicKey = appConfig.sm2PublicKey;
    if (!publicKey) return;
    const sm2 = getSm2();
    if (!sm2) return;

    const timestamp = Date.now();
    try {
        const encrypted = sm2.doEncrypt(String(timestamp), publicKey);
        headers['X-Timestamp'] = String(timestamp);
        headers['X-Signature'] = encrypted;
    } catch (e) {
        console.error('[http-client] SM2 encryption failed:', e);
    }
}

async function buildHeaders(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    const appConfig = await readConfig(context);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (appConfig.authToken) headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId) headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName) headers['X-User-Name'] = encodeURIComponent(appConfig.userName);
    await addSm2Signature(headers, context);
    return headers;
}

// ============================================
// HTTP 请求
// ============================================

function makeRequest<T = any>(apiUrl: string, method: string, headers: Record<string, string>, body?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const url = new URL(apiUrl);
        if (url.hostname === 'localhost') {
            url.hostname = '127.0.0.1';
        }

        const options: http.RequestOptions = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: method,
            headers: headers,
            agent: new (http.Agent)({ keepAlive: false }),
        };

        console.log('[http-client] Request:', options.hostname + ':' + options.port + options.path);

        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(options, res => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                console.log('[http-client] Response status:', res.statusCode);
                try {
                    resolve(JSON.parse(data) as T);
                } catch {
                    resolve({ raw: data } as T);
                }
            });
        });

        req.on('error', (e: Error & { code?: string }) => {
            console.error('[http-client] Request error:', e.code, e.message);
            reject(e);
        });

        req.on('timeout', () => {
            console.error('[http-client] Request timeout');
            req.destroy();
            reject(new Error('请求超时'));
        });

        req.setTimeout(10000);

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

// ============================================
// API 方法
// ============================================

export async function fetchTaskTree(context: vscode.ExtensionContext): Promise<any[]> {
    const appConfig = await readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/task-tree';
    const headers = await buildHeaders(context);

    const result = await makeRequest<ApiResponse<any[]>>(apiUrl, 'POST', headers, '{}');
    if (result.returnCode === 'SUC0000') {
        return result.body || [];
    }
    throw new Error(result.errorMsg || '获取任务树失败');
}

export async function queryApi(opts: QueryOptions, context: vscode.ExtensionContext): Promise<ApiResponse> {
    const appConfig = await readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/test-case';

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

    const headers = await buildHeaders(context);
    return await makeRequest<ApiResponse>(apiUrl, 'POST', headers, JSON.stringify(body));
}

export async function sendSelectedData(opts: { selectedRows: any[]; headers: string[] }, context: vscode.ExtensionContext): Promise<ApiResponse> {
    const appConfig = await readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/batch-import';

    const body = { headers: opts.headers, rows: opts.selectedRows };
    const headers = await buildHeaders(context);

    return await makeRequest<ApiResponse>(apiUrl, 'POST', headers, JSON.stringify(body));
}

/**
 * 推送测试案例数据（统一接口，各文件类型共用）
 */
export async function pushTestCase(data: any[], context: vscode.ExtensionContext): Promise<ApiResponse> {
    const appConfig = await readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/push-testcase';

    const headers = await buildHeaders(context);
    return await makeRequest<ApiResponse>(apiUrl, 'POST', headers, JSON.stringify(data));
}
