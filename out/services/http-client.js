"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchTaskTree = fetchTaskTree;
exports.queryApi = queryApi;
exports.sendSelectedData = sendSelectedData;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const storage_1 = require("./storage");
// ============================================
// SM2 签名
// ============================================
function addSm2Signature(headers, context) {
    const appConfig = (0, storage_1.readConfig)(context);
    const publicKey = appConfig.sm2PublicKey;
    if (!publicKey)
        return;
    const timestamp = Date.now();
    try {
        const sm2 = require('sm-crypto').sm2;
        const encrypted = sm2.doEncrypt(String(timestamp), publicKey);
        headers['X-Timestamp'] = String(timestamp);
        headers['X-Signature'] = encrypted;
    }
    catch (e) {
        console.error('[http-client] SM2 encryption failed:', e);
    }
}
// ============================================
// HTTP 请求
// ============================================
function makeRequest(apiUrl, method, headers, body) {
    return new Promise((resolve, reject) => {
        // 强制使用 127.0.0.1 替代 localhost
        const urlStr = apiUrl.replace('localhost', '127.0.0.1');
        const url = new URL(urlStr);
        const options = {
            hostname: '127.0.0.1',
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
                    resolve(JSON.parse(data));
                }
                catch {
                    resolve({ raw: data });
                }
            });
        });
        req.on('error', (e) => {
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
async function fetchTaskTree(context) {
    const appConfig = (0, storage_1.readConfig)(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/task-tree';
    const headers = { 'Content-Type': 'application/json' };
    if (appConfig.authToken)
        headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId)
        headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName)
        headers['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(headers, context);
    try {
        const result = await makeRequest(apiUrl, 'POST', headers, '{}');
        if (result.returnCode === 'SUC0000') {
            return result.body || [];
        }
        else {
            throw new Error(result.errorMsg || '获取任务树失败');
        }
    }
    catch (e) {
        console.error('[http-client] fetchTaskTree error:', e);
        throw e;
    }
}
async function queryApi(opts, context) {
    const appConfig = (0, storage_1.readConfig)(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/test-case';
    const body = {
        testTaskNo: opts.testTaskNo,
        subTestTaskName: opts.subTestTaskName,
        testPhaseName: opts.testPhaseName || '',
        currentPage: opts.currentPage,
        pageSize: opts.pageSize
    };
    // 可选参数
    if (opts.testCaseNo)
        body.testCaseNo = opts.testCaseNo;
    if (opts.testCaseName)
        body.testCaseName = opts.testCaseName;
    if (opts.testCasePath)
        body.testCasePath = opts.testCasePath;
    if (opts.testCasePriority)
        body.testCasePriority = opts.testCasePriority;
    if (opts.testType)
        body.testType = opts.testType;
    if (opts.type)
        body.type = opts.type;
    const headers = { 'Content-Type': 'application/json' };
    if (appConfig.authToken)
        headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId)
        headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName)
        headers['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(headers, context);
    try {
        return await makeRequest(apiUrl, 'POST', headers, JSON.stringify(body));
    }
    catch (e) {
        console.error('[http-client] queryApi error:', e);
        throw e;
    }
}
async function sendSelectedData(opts, context) {
    const appConfig = (0, storage_1.readConfig)(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/batch-import';
    const body = {
        headers: opts.headers,
        rows: opts.selectedRows
    };
    const requestHeaders = { 'Content-Type': 'application/json' };
    if (appConfig.authToken)
        requestHeaders['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId)
        requestHeaders['X-User-Id'] = appConfig.userId;
    if (appConfig.userName)
        requestHeaders['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(requestHeaders, context);
    try {
        return await makeRequest(apiUrl, 'POST', requestHeaders, JSON.stringify(body));
    }
    catch (e) {
        console.error('[http-client] sendSelectedData error:', e);
        throw e;
    }
}
//# sourceMappingURL=http-client.js.map