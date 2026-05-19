const http = require('http');
const https = require('https');
const { readConfig } = require('./config');

function addSm2Signature(headers, context) {
    const appConfig = readConfig(context);
    const publicKey = appConfig.sm2PublicKey;
    if (!publicKey) return;

    const timestamp = Date.now();
    try {
        const sm2 = require('sm-crypto').sm2;
        const encrypted = sm2.doEncrypt(String(timestamp), publicKey);
        headers['X-Timestamp'] = String(timestamp);
        headers['X-Signature'] = encrypted;
    } catch (e) {
        console.error('[testcase-viewer] SM2 encryption failed:', e);
    }
}

function makeRequest(apiUrl, method, headers, body) {
    return new Promise((resolve, reject) => {
        // 强制使用 127.0.0.1 替代 localhost
        const urlStr = apiUrl.replace('localhost', '127.0.0.1');
        const url = new URL(urlStr);
        
        const options = {
            hostname: '127.0.0.1',  // 强制使用 IP
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: method,
            headers: headers,
            // 禁用代理
            agent: new (http.Agent)({ keepAlive: false, proxy: false }),
        };

        console.log('[HTTP] 请求:', options.hostname + ':' + options.port + options.path);

        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(options, res => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                console.log('[HTTP] 响应状态:', res.statusCode);
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve({ raw: data });
                }
            });
        });
        
        req.on('error', (e) => {
            console.error('[HTTP] 请求错误:', e.code, e.message);
            reject(e);
        });
        
        req.on('timeout', () => {
            console.error('[HTTP] 请求超时');
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

async function fetchTaskTree(context) {
    const appConfig = readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/task-tree';

    const headers = { 'Content-Type': 'application/json' };
    if (appConfig.authToken) headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId) headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName) headers['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(headers, context);

    try {
        const result = await makeRequest(apiUrl, 'POST', headers, '{}');
        if (result.returnCode === 'SUC0000') {
            return result.body || [];
        } else {
            throw new Error(result.errorMsg || '获取任务树失败');
        }
    } catch (e) {
        console.error('[testcase-viewer] fetchTaskTree error:', e);
        throw e;
    }
}

async function queryApi(opts, context) {
    const appConfig = readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/test-case';

    const body = {
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

    const headers = {
        'Content-Type': 'application/json',
    };
    if (appConfig.authToken) headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId) headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName) headers['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(headers, context);

    try {
        return await makeRequest(apiUrl, 'POST', headers, JSON.stringify(body));
    } catch (e) {
        console.error('[testcase-viewer] queryApi error:', e);
        throw e;
    }
}

async function sendSelectedData(opts, context) {
    const { selectedRows, headers } = opts;
    const appConfig = readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://127.0.0.1:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/batch-import';

    const body = {
        headers: headers,
        rows: selectedRows
    };

    const requestHeaders = {
        'Content-Type': 'application/json',
    };
    if (appConfig.authToken) requestHeaders['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId) requestHeaders['X-User-Id'] = appConfig.userId;
    if (appConfig.userName) requestHeaders['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(requestHeaders, context);

    try {
        return await makeRequest(apiUrl, 'POST', requestHeaders, JSON.stringify(body));
    } catch (e) {
        console.error('[testcase-viewer] sendSelectedData error:', e);
        throw e;
    }
}

module.exports = { addSm2Signature, fetchTaskTree, queryApi, sendSelectedData };
