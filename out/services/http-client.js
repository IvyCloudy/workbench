"use strict";
const http = require('http');
const https = require('https');
const vscode = require('vscode');
const { readConfig } = require('./config');
function addSm2Signature(headers, context) {
    const appConfig = readConfig(context);
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
        console.error('[testcase-viewer] SM2 encryption failed:', e);
    }
}
async function fetchTaskTree(context) {
    const appConfig = readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://localhost:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/task-tree';
    const url = new URL(apiUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (appConfig.authToken)
        headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId)
        headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName)
        headers['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(headers, context);
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
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.returnCode === 'SUC0000') {
                        resolve(result.body || []);
                    }
                    else {
                        reject(new Error(result.errorMsg || '获取任务树失败'));
                    }
                }
                catch {
                    reject(new Error('响应数据解析失败'));
                }
            });
        });
        req.on('error', reject);
        req.write('{}');
        req.end();
    });
}
async function queryApi(opts, context) {
    const appConfig = readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://localhost:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/test-case';
    const url = new URL(apiUrl);
    const body = {
        testTaskNo: opts.testTaskNo,
        subTestTaskName: opts.subTestTaskName,
        testPhaseName: opts.testPhaseName || '',
        currentPage: opts.currentPage,
        pageSize: opts.pageSize
    };
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
    const postData = JSON.stringify(body);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData).toString(),
    };
    if (appConfig.authToken)
        headers['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId)
        headers['X-User-Id'] = appConfig.userId;
    if (appConfig.userName)
        headers['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(headers, context);
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
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    reject(new Error('响应数据解析失败'));
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}
async function sendSelectedData(opts, context) {
    const { selectedRows, headers } = opts;
    const appConfig = readConfig(context);
    const baseUrl = appConfig.apiUrl || 'http://localhost:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/batch-import';
    const url = new URL(apiUrl);
    const body = {
        headers: headers,
        rows: selectedRows
    };
    const postData = JSON.stringify(body);
    const requestHeaders = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData).toString(),
    };
    if (appConfig.authToken)
        requestHeaders['Authorization'] = 'Bearer ' + appConfig.authToken;
    if (appConfig.userId)
        requestHeaders['X-User-Id'] = appConfig.userId;
    if (appConfig.userName)
        requestHeaders['X-User-Name'] = encodeURIComponent(appConfig.userName);
    addSm2Signature(requestHeaders, context);
    return new Promise((resolve, reject) => {
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: requestHeaders,
        };
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(options, res => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    reject(new Error('响应数据解析失败'));
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}
module.exports = { addSm2Signature, fetchTaskTree, queryApi, sendSelectedData };
//# sourceMappingURL=http-client.js.map