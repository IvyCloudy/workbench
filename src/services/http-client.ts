import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { readParams } from './store';
import { readConfig } from './config';

export interface QueryOpts {
    currentPage: number;
    pageSize: string;
    testCaseNo?: string;
    testCaseName?: string;
    testCasePath?: string;
    testCasePriority?: string;
    testType?: string;
    type?: string;
}

export interface ApiResponse {
    errorMsg: string;
    body: any[];
    returnCode: string;
    total?: number;
    currentPage?: number;
    pageSize?: string;
}

export async function queryApi(opts: QueryOpts, context: vscode.ExtensionContext): Promise<ApiResponse> {
    const appConfig = readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://localhost:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/test-case';
    const url = new URL(apiUrl);

    const params = readParams(context);
    const body: any = {
        testTaskNo: params.testTaskNo,
        subTestTaskName: params.subTestTaskName,
        testPhaseName: params.testPhaseName,
        currentPage: opts.currentPage,
        pageSize: opts.pageSize
    };
    if (opts.testCaseNo) body.testCaseNo = opts.testCaseNo;
    if (opts.testCaseName) body.testCaseName = opts.testCaseName;
    if (opts.testCasePath) body.testCasePath = opts.testCasePath;
    if (opts.testCasePriority) body.testCasePriority = opts.testCasePriority;
    if (opts.testType) body.testType = opts.testType;
    if (opts.type) body.type = opts.type;

    const postData = JSON.stringify(body);

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData).toString(),
    };
    if (appConfig.authToken) headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId) headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName) headers['X-User-Name'] = encodeURIComponent(appConfig.userName);

    return new Promise((resolve, reject) => {
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers,
        };

        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error('响应数据解析失败'));
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}
