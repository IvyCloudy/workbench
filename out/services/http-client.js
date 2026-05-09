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
exports.queryApi = queryApi;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const store_1 = require("./store");
const config_1 = require("./config");
async function queryApi(opts, context) {
    const appConfig = (0, config_1.readConfig)(context);
    const baseUrl = appConfig.apiUrl || 'http://localhost:8081';
    const apiUrl = baseUrl.replace(/\/+$/, '') + '/test-task/test-case';
    const url = new URL(apiUrl);
    const params = (0, store_1.readParams)(context);
    const body = {
        testTaskNo: params.testTaskNo,
        subTestTaskName: params.subTestTaskName,
        testPhaseName: params.testPhaseName,
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
//# sourceMappingURL=http-client.js.map