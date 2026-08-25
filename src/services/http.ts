/**
 * ============================================================================
 *  services/http.ts
 *  与后端 API 交互的 HTTP 客户端
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 从 storage 读取 apiUrl / token 等配置，组装请求头
 *    2. 自动注入 SM2 时间戳签名（X-Timestamp / X-Signature）
 *    3. 封装 4 个业务接口：fetchTaskTree / queryTestCases / batchImportData / pushTestCase
 *    4. 统一翻译网络错误码（ECONNREFUSED 等）为可读中文提示
 *  设计要点：
 *    - 推送链路为关键链路：pushTestCase 会打印完整请求/响应日志（敏感头脱敏）
 *    - 所有 POST 请求超时统一为 DEFAULT_TIMEOUT(10s)
 *    - localhost 一律改写为 127.0.0.1，规避部分系统 IPv6 解析问题
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { execFile } from 'child_process';
import { readConfig } from './storage';
import { TelemetryService } from '../utils/telemetry';
import { stackHead } from './utils';
import { mapRowToCaseItem } from '../utils/pushDataMapper';
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
        TelemetryService.sendTelemetryErrorEvent('http.sm2.signFailed', { errorMessage: String((error as any)?.message || String(error)).slice(0, 500), stackHead: stackHead(error) });
    }
}

// ============================================
// 内部：curl 兜底请求
// ----------------------------------------------------------------------------
// 背景：VSCode 扩展宿主的 Node http 客户端在某些场景下会出现
//   "响应头拿到但 data 事件一次都不触发" 的诡异现象（chunked / Content-Length
//   都无法规避），curl / 独立 Node 进程均能正常拿到 body。
// 因此在 Node http 拿到 status=200 但 bytes=0 且 header 声明有 content-length
// 时，自动 fallback 到 curl 子进程重试一次。
// ============================================

interface CurlResult {
    status: number;
    bodyText: string;
}

function curlRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string
): Promise<CurlResult> {
    return new Promise((resolve, reject) => {
        const args: string[] = ['-sS', '-X', method, '-o', '-', '-w', '\n__CURL_HTTP_CODE__%{http_code}'];
        for (const [k, v] of Object.entries(headers)) {
            if (v == null) continue;
            args.push('-H', `${k}: ${v}`);
        }
        if (body != null && body !== '') {
            args.push('--data-binary', body);
        }
        args.push(url);

        execFile('curl', args, { timeout: DEFAULT_TIMEOUT, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`curl 兜底请求失败: ${(err as any).message || err}${stderr ? ' | ' + stderr : ''}`));
                return;
            }
            const out = String(stdout || '');
            const marker = '__CURL_HTTP_CODE__';
            const idx = out.lastIndexOf(marker);
            let status = 0;
            let bodyText = out;
            if (idx >= 0) {
                status = parseInt(out.slice(idx + marker.length).trim(), 10) || 0;
                bodyText = out.slice(0, idx);
                // 去掉我们自己插入的换行分隔符
                if (bodyText.endsWith('\n')) bodyText = bodyText.slice(0, -1);
            }
            resolve({ status, bodyText });
        });
    });
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

        // 禁用 keep-alive，避免扩展宿主中复用陈旧 socket 导致 res 只触发 end 而不触发 data
        // 同时显式带上 Content-Length，明确 body 边界，规避某些中间层/服务端识别问题
        const bodyBuffer = body ? Buffer.from(body, 'utf8') : undefined;
        const finalHeaders: Record<string, string> = { ...headers, 'Connection': 'close' };
        if (bodyBuffer) finalHeaders['Content-Length'] = String(bodyBuffer.length);

        const options: http.RequestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method,
            headers: finalHeaders,
            agent: false,
        };

        const client = urlObj.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
            res.setEncoding('utf8');
            let data = '';
            let chunkCount = 0;
            res.on('data', chunk => { data += chunk; chunkCount++; });
            res.on('end', async () => {
                // 诊断日志：对删除接口打印原始字节流，便于定位 body 为空/被中间层改写的问题
                if (urlObj.pathname && urlObj.pathname.indexOf('/delete-testcase') >= 0) {
                    console.log('[makeRequest][delete-testcase][原始响应] status=%d bytes=%d chunks=%d headers=%s raw=%s',
                        res.statusCode || 0,
                        Buffer.byteLength(data, 'utf8'),
                        chunkCount,
                        JSON.stringify(res.headers),
                        data.slice(0, 500));
                }

                // 兜底：Node http 拿到 status=2xx 但 bytes=0，而响应头里声明了非零 content-length
                // 这是 VSCode 扩展宿主的已知劫持问题，转用 curl 子进程重试
                const status = res.statusCode || 0;
                const bytes = Buffer.byteLength(data, 'utf8');
                const declaredLen = parseInt(String(res.headers['content-length'] || '0'), 10) || 0;
                if (bytes === 0 && status >= 200 && status < 300 && declaredLen > 0) {
                    console.warn('[makeRequest][fallback] Node http body 为空但服务端声明 content-length=%d，改用 curl 重试 url=%s',
                        declaredLen, url);
                    try {
                        const curlResp = await curlRequest(method, url, finalHeaders, body);
                        if (urlObj.pathname && urlObj.pathname.indexOf('/delete-testcase') >= 0) {
                            console.log('[makeRequest][delete-testcase][curl兜底] status=%d bytes=%d raw=%s',
                                curlResp.status,
                                Buffer.byteLength(curlResp.bodyText, 'utf8'),
                                curlResp.bodyText.slice(0, 500));
                        }
                        try {
                            const responseData = curlResp.bodyText ? JSON.parse(curlResp.bodyText) : {};
                            resolve({ status: curlResp.status || status, data: responseData });
                        } catch {
                            resolve({ status: curlResp.status || status, data: { raw: curlResp.bodyText } as T });
                        }
                        return;
                    } catch (fallbackErr) {
                        console.error('[makeRequest][fallback] curl 兜底失败:', (fallbackErr as any)?.message || fallbackErr);
                        // 兜底也失败则维持原逻辑（返回空 body）
                    }
                }

                try {
                    const responseData = data ? JSON.parse(data) : {};
                    resolve({ status: status || 200, data: responseData });
                } catch {
                    resolve({ status: status || 200, data: { raw: data } as T });
                }
            });
        });

        req.on('error', (err: NodeJS.ErrnoException) => {
            const target = `${urlObj.hostname}:${urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80)}`;
            const code = err.code || 'UNKNOWN';
            TelemetryService.sendTelemetryErrorEvent('http.request.error', { errCode: code, target });
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

        if (bodyBuffer) req.write(bodyBuffer);
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
    TelemetryService.sendTelemetryEvent('api.fetchTaskTree.start', {});
    const _start = Date.now();
    const response = await post<ApiResponse<any[]>>(context, url, {});
    const _costMs = String(Date.now() - _start);
    maybeReportAuthFailure(response.status, 'fetchTaskTree');
    if (response.data.returnCode === 'SUC0000') {
        TelemetryService.sendTelemetryEvent('api.fetchTaskTree.ok', { returnCode: response.data.returnCode, costMs: _costMs });
        return response.data.body || [];
    }
    TelemetryService.sendTelemetryErrorEvent('api.fetchTaskTree.fail', { returnCode: response.data.returnCode || '', costMs: _costMs });
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

    const _start = Date.now();
    const response = await post<ApiResponse>(context, url, body);
    maybeReportAuthFailure(response.status, 'queryTestCases');
    TelemetryService.sendTelemetryEvent('api.queryTestCases.done', {
        returnCode: response.data.returnCode || '',
        currentPage: String(opts.currentPage || 1),
        costMs: String(Date.now() - _start),
    });
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
    const _start = Date.now();
    const response = await post<ApiResponse>(context, url, body);
    maybeReportAuthFailure(response.status, 'batchImport');
    TelemetryService.sendTelemetryEvent('api.batchImport.done', {
        returnCode: response.data.returnCode || '',
        totalRows: String(opts.selectedRows.length),
        costMs: String(Date.now() - _start),
    });
    return response.data;
}

/**
 * 推送测试案例数据
 *
 * @param artifactId   推送的文件名（如 testcases.csv）
 * @param taskInfo     必填，从文件路径解析得到的任务信息
 *                     目录格式：测试任务/<testTaskNo>_<subTestTaskName>/测试案例/<file>
 *
 * 注：所有推送都会按 mapRowToCaseItem 进行字段映射（其内部按行表头自动选择
 *     中文 CSV / YAML 结构化分支），保证 caseList[] 始终符合后端契约。
 */
export async function pushTestCase(
    context: vscode.ExtensionContext,
    data: any[],
    taskInfo: { testTaskNo: string; subTestTaskId: string },
    artifactId: string,
    sourcePlatform: string = 'testAgent'
): Promise<ApiResponse> {
    const url = `${await getApiBaseUrl(context)}/test-task/push-testcase`;
    const caseList = data.map(mapRowToCaseItem);
    const body = {
        testTaskNo: taskInfo.testTaskNo,
        subTestTaskId: taskInfo.subTestTaskId,
        designer: "",
        artifactId,
        sourcePlatform,
        caseList
    };

    // 打印完整请求（headers 中的敏感字段做脱敏）
    const headers = await buildHeaders(context);
    const safeHeaders = maskSensitiveHeaders(headers);
    const bodyStr = JSON.stringify(body);
    console.log('[推送][请求] ───────────────────────────────');
    console.log('[推送][请求] POST', url);
    console.log('[推送][请求] headers:', JSON.stringify(safeHeaders, null, 2));
    console.log('[推送][请求] body  :', JSON.stringify(body, null, 2));
    console.log(`[推送][请求] 数据行数=${data.length}, body 字节=${Buffer.byteLength(bodyStr, 'utf8')}`);

    const _apiStart = Date.now();
    try {
        const response = await makeRequest<ApiResponse>('POST', url, headers, bodyStr);
        console.log('[推送][响应] status=', response.status,
            'returnCode=', (response.data as any)?.returnCode,
            'errorMsg=', (response.data as any)?.errorMsg || '');
        console.log('[推送][响应] body  :', JSON.stringify(response.data, null, 2));

        maybeReportAuthFailure(response.status, 'pushTestCase');
        const _rc = (response.data as any)?.returnCode || '';
        const _success = _rc === 'SUC0000';
        if (_success) {
            TelemetryService.sendTelemetryEvent('api.pushTestCase.ok', {
                httpStatus: String(response.status),
                totalRows: String(data.length),
                bytes: String(Buffer.byteLength(bodyStr, 'utf8')),
                costMs: String(Date.now() - _apiStart),
            });
        } else {
            TelemetryService.sendTelemetryErrorEvent('api.pushTestCase.fail', {
                httpStatus: String(response.status),
                returnCode: _rc,
                totalRows: String(data.length),
                costMs: String(Date.now() - _apiStart),
            });
        }
        return response.data;
    } catch (err: any) {
        TelemetryService.sendTelemetryErrorEvent('api.pushTestCase.exception', {
            totalRows: String(data.length),
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
        throw err;
    }
}

/**
 * 删除测试案例（线上）。
 *
 * @param taskInfo  必填，从文件路径解析得到的任务信息
 *                  { testTaskNo, subTestTaskId }
 * @param sourceIds 必填，待删除案例的 testcase_id 列表（对应后端入参 sourceIds: List<string>）
 *
 * 入参与后端契约（POST /test-task/delete-testcase）一一对应：
 *   - testTaskNo   → testTaskNo
 *   - subTestTaskId→ subTestTaskId
 *   - sourceIds   → sourceIds（每个元素即案例的 testcase_id 字段值）
 *
 * 出参与推送接口（pushTestCase）保持一致：
 *   - 外层：returnCode / errorMsg / body
 *   - body[]：{ data, sourceId, type }，type:'1' 成功 / type:'2' 失败
 *
 * @returns 后端原始响应（ApiResponse），由调用方解析 body 逐条结果。
 */
export async function deleteTestCase(
    context: vscode.ExtensionContext,
    taskInfo: { testTaskNo: string; subTestTaskId: string },
    sourceIds: string[],
): Promise<ApiResponse> {
    const url = `${await getApiBaseUrl(context)}/test-task/delete-testcase`;
    const body = {
        testTaskNo: taskInfo.testTaskNo,
        subTestTaskId: taskInfo.subTestTaskId,
        sourceIds: Array.isArray(sourceIds) ? sourceIds : [],
    };

    const headers = await buildHeaders(context);
    const safeHeaders = maskSensitiveHeaders(headers);
    console.log('[删除案例][请求] ───────────────────────────────');
    console.log('[删除案例][请求] POST', url);
    console.log('[删除案例][请求] headers:', JSON.stringify(safeHeaders, null, 2));
    console.log('[删除案例][请求] body  :', JSON.stringify(body, null, 2));

    const _apiStart = Date.now();
    try {
        const response = await makeRequest<ApiResponse>('POST', url, headers, JSON.stringify(body));
        console.log('[删除案例][响应] status=', response.status,
            'returnCode=', (response.data as any)?.returnCode,
            'errorMsg=', (response.data as any)?.errorMsg || '');
        console.log('[删除案例][响应] body  :', JSON.stringify(response.data, null, 2));

        maybeReportAuthFailure(response.status, 'deleteTestCase');
        const _rc = (response.data as any)?.returnCode || '';
        const _costMs = String(Date.now() - _apiStart);
        if (_rc === 'SUC0000') {
            TelemetryService.sendTelemetryEvent('api.deleteTestCase.ok', {
                httpStatus: String(response.status),
                totalRows: String(sourceIds.length),
                costMs: _costMs,
            });
        } else {
            TelemetryService.sendTelemetryErrorEvent('api.deleteTestCase.fail', {
                httpStatus: String(response.status),
                returnCode: _rc,
                totalRows: String(sourceIds.length),
                costMs: _costMs,
            });
        }
        return response.data;
    } catch (err: any) {
        TelemetryService.sendTelemetryErrorEvent('api.deleteTestCase.exception', {
            totalRows: String(sourceIds.length),
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
        throw err;
    }
}

/**
 * 当响应状态码为 401/403 时，上报一次鉴权失效事件。
 * 用于运营侧观察：登录态过期 / token 失效 / 权限被收回 的整体趋势。
 */
function maybeReportAuthFailure(httpStatus: number, api: string): void {
    if (httpStatus === 401 || httpStatus === 403) {
        TelemetryService.sendTelemetryErrorEvent('api.auth.unauthorized', { api, httpStatus: String(httpStatus) });
    }
}

/** 对日志输出的请求头做脱敏，避免泄漏 token / 签名 */
function maskSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
    const SENSITIVE = ['Authorization', 'X-Signature'];
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (SENSITIVE.some(s => s.toLowerCase() === k.toLowerCase())) {
            masked[k] = v ? `${v.slice(0, 6)}***(len=${v.length})` : '';
        } else {
            masked[k] = v;
        }
    }
    return masked;
}