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
exports.TestCaseWebviewProvider = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const BaseWebviewProvider_1 = require("./BaseWebviewProvider");
const storage_1 = require("../services/storage");
const http_client_1 = require("../services/http-client");
class TestCaseWebviewProvider extends BaseWebviewProvider_1.BaseWebviewProvider {
    constructor() {
        super(...arguments);
        this.readyParams = null;
        this.handleMessage = async (msg) => {
            if (msg.command === 'ready' && this.readyParams) {
                this.postMessage({
                    command: 'init',
                    ...this.readyParams,
                    pageSize: '15',
                    currentPage: 1
                });
            }
            else if (msg.command === 'fetchTaskTree') {
                try {
                    const treeData = await (0, http_client_1.fetchTaskTree)(this.context);
                    this.postMessage({ command: 'taskTreeData', data: treeData });
                }
                catch {
                    this.postMessage({ command: 'taskTreeData', data: [] });
                }
            }
            else if (msg.command === 'query') {
                this.postMessage({ command: 'loading' });
                try {
                    const opts = {
                        currentPage: msg.currentPage || 1,
                        pageSize: String(msg.pageSize || '20'),
                        testTaskNo: msg.testTaskNo || '',
                        subTestTaskName: msg.subTestTaskName || '',
                        testPhaseName: msg.testPhaseName || '',
                    };
                    if (msg.testCaseNo)
                        opts.testCaseNo = msg.testCaseNo;
                    if (msg.testCaseName)
                        opts.testCaseName = msg.testCaseName;
                    if (msg.testCasePath)
                        opts.testCasePath = msg.testCasePath;
                    if (msg.testCasePriority)
                        opts.testCasePriority = msg.testCasePriority;
                    if (msg.testType)
                        opts.testType = msg.testType;
                    if (msg.type)
                        opts.type = msg.type;
                    const result = await (0, http_client_1.queryApi)(opts, this.context);
                    if (result.returnCode === 'SUC0000') {
                        this.postMessage({ command: 'showData', data: result.body });
                    }
                    else if (result.returnCode === '2005' && result.errorMsg === '任务测试案例信息不存在') {
                        this.postMessage({ command: 'endOfData' });
                    }
                    else {
                        this.postMessage({ command: 'showError', message: result.errorMsg || '查询失败' });
                    }
                }
                catch (err) {
                    this.postMessage({ command: 'showError', message: err.message || '网络请求失败' });
                }
            }
        };
    }
    getPanelId() { return 'testcaseViewer'; }
    getPanelTitle() { return '测试案例'; }
    getViewColumn() { return vscode.ViewColumn.Beside; }
    getHtmlPath() {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'testcase', 'index.html');
    }
    getScriptPath() {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'testcase', 'main.js');
    }
    async showWebview(fileUri) {
        this.show();
        const params = await this.extractParamsFromFile(fileUri);
        const config = vscode.workspace.getConfiguration('testcaseViewer');
        const apiUrl = config.get('apiUrl') || 'http://localhost:8081';
        (0, storage_1.writeParams)(this.context, params);
        this.readyParams = { ...params, apiUrl };
    }
    async extractParamsFromFile(fileUri) {
        try {
            const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length < 2)
                return { testTaskNo: '', subTestTaskName: '', testPhaseName: '' };
            const headers = this.parseCsvLine(lines[0]);
            const data = this.parseCsvLine(lines[1]);
            const testTaskNoIdx = headers.findIndex(h => h.trim().toLowerCase() === 'testtaskno');
            const subTestTaskNameIdx = headers.findIndex(h => h.trim().toLowerCase() === 'subtesttaskname');
            const testPhaseNameIdx = headers.findIndex(h => h.trim().toLowerCase() === 'testphasename');
            return {
                testTaskNo: testTaskNoIdx >= 0 ? (data[testTaskNoIdx] || '').trim() : '',
                subTestTaskName: subTestTaskNameIdx >= 0 ? (data[subTestTaskNameIdx] || '').trim() : '',
                testPhaseName: testPhaseNameIdx >= 0 ? (data[testPhaseNameIdx] || '').trim() : '',
            };
        }
        catch {
            return { testTaskNo: '', subTestTaskName: '', testPhaseName: '' };
        }
    }
    parseCsvLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            }
            else if (ch === ',' && !inQuotes) {
                result.push(current);
                current = '';
            }
            else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }
}
exports.TestCaseWebviewProvider = TestCaseWebviewProvider;
//# sourceMappingURL=TestCaseProvider.js.map