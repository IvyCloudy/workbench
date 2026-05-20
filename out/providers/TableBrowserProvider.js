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
exports.TableBrowserProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const BaseWebviewProvider_1 = require("./BaseWebviewProvider");
const csv_parser_1 = require("../services/csv-parser");
const http_client_1 = require("../services/http-client");
// ============================================
// 表格浏览器 Provider
// ============================================
class TableBrowserProvider extends BaseWebviewProvider_1.BaseWebviewProvider {
    constructor() {
        super(...arguments);
        this.handleMessage = async (msg) => {
            switch (msg.command) {
                case 'fetchWorkspaceFiles':
                    await this.handleFetchWorkspaceFiles();
                    break;
                case 'readCsvFile':
                    await this.handleReadCsvFile(msg);
                    break;
                case 'sendSelectedData':
                    await this.handleSendSelectedData(msg);
                    break;
            }
        };
    }
    getPanelId() { return 'tableBrowser'; }
    getPanelTitle() { return '表格浏览器'; }
    getViewColumn() { return vscode.ViewColumn.Two; }
    getHtmlPath() {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'table-browser', 'index.html');
    }
    getScriptPath() {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'table-browser', 'main.js');
    }
    async handleFetchWorkspaceFiles() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.postMessage({ command: 'workspaceFiles', data: [], error: '请先打开一个工作区文件夹' });
            return;
        }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const fileTree = this.buildFileTree(rootPath);
        this.postMessage({ command: 'workspaceFiles', data: fileTree });
    }
    buildFileTree(rootPath) {
        const result = [];
        const fs = require('fs');
        try {
            const firstLevelEntries = fs.readdirSync(rootPath, { withFileTypes: true });
            for (const firstEntry of firstLevelEntries) {
                if (!firstEntry.isDirectory() || (firstEntry.name !== '测试任务' && firstEntry.name !== 'testtask')) {
                    continue;
                }
                const testTaskPath = path.join(rootPath, firstEntry.name);
                const taskChildren = [];
                try {
                    const secondLevelEntries = fs.readdirSync(testTaskPath, { withFileTypes: true });
                    for (const secondEntry of secondLevelEntries) {
                        if (!secondEntry.isDirectory())
                            continue;
                        const subTaskPath = path.join(testTaskPath, secondEntry.name);
                        const caseChildren = [];
                        try {
                            const thirdLevelEntries = fs.readdirSync(subTaskPath, { withFileTypes: true });
                            for (const thirdEntry of thirdLevelEntries) {
                                if (!thirdEntry.isDirectory() || (thirdEntry.name !== '测试案例' && thirdEntry.name !== 'testcase')) {
                                    continue;
                                }
                                const casePath = path.join(subTaskPath, thirdEntry.name);
                                const csvFiles = this.getCsvFilesInDir(casePath);
                                if (csvFiles.length > 0) {
                                    caseChildren.push({
                                        name: thirdEntry.name,
                                        path: casePath,
                                        isDirectory: true,
                                        children: csvFiles
                                    });
                                }
                            }
                        }
                        catch (e) {
                            console.error(`[TableBrowser] Error reading directory ${subTaskPath}:`, e);
                        }
                        if (caseChildren.length > 0) {
                            taskChildren.push({
                                name: secondEntry.name,
                                path: subTaskPath,
                                isDirectory: true,
                                children: caseChildren
                            });
                        }
                    }
                }
                catch (e) {
                    console.error(`[TableBrowser] Error reading directory ${testTaskPath}:`, e);
                }
                if (taskChildren.length > 0) {
                    result.push({
                        name: firstEntry.name,
                        path: testTaskPath,
                        isDirectory: true,
                        children: taskChildren
                    });
                }
            }
        }
        catch (e) {
            console.error('[TableBrowser] Error building file tree:', e);
        }
        return result;
    }
    getCsvFilesInDir(dirPath) {
        const fs = require('fs');
        const csvFiles = [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() && /\.csv$/i.test(entry.name)) {
                    csvFiles.push({
                        name: entry.name,
                        path: path.join(dirPath, entry.name),
                        isDirectory: false
                    });
                }
            }
        }
        catch (e) {
            console.error(`[TableBrowser] Error reading directory ${dirPath}:`, e);
        }
        return csvFiles;
    }
    async handleReadCsvFile(msg) {
        const filePath = msg.filePath;
        if (!filePath) {
            this.postMessage({ command: 'csvData', data: null, error: '文件路径无效' });
            return;
        }
        try {
            const data = (0, csv_parser_1.loadCsvFromFile)(filePath);
            const result = this.convertToTableData(data);
            if (!result) {
                this.postMessage({ command: 'csvData', data: null, error: 'CSV文件为空' });
                return;
            }
            this.postMessage({
                command: 'csvData',
                data: {
                    headers: result.headers,
                    rows: result.rows,
                    fileName: path.basename(filePath)
                }
            });
            console.log('[TableBrowser] CSV数据已发送，rows:', result.rows.length, 'headers:', result.headers.length);
        }
        catch (e) {
            this.postMessage({ command: 'csvData', data: null, error: e.message || '读取文件失败' });
        }
    }
    convertToTableData(data) {
        const sheet = data.sheets[0];
        if (!sheet)
            return null;
        const headers = [];
        const rows = [];
        const row0 = sheet.rows[0];
        if (row0) {
            const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
        }
        const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
        rowKeys.forEach(ri => {
            if (ri === 0 && headers.length > 0)
                return;
            const row = sheet.rows[ri];
            if (!row)
                return;
            const rowData = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
            while (rowData.length < headers.length)
                rowData.push('');
            rows.push(rowData);
        });
        return { headers, rows };
    }
    async handleSendSelectedData(msg) {
        const selectedRows = msg.selectedRows;
        const headers = msg.headers;
        if (!selectedRows || selectedRows.length === 0) {
            vscode.window.showWarningMessage('请先勾选要发送的数据');
            return;
        }
        try {
            const result = await (0, http_client_1.sendSelectedData)({ selectedRows, headers }, this.context);
            if (result.returnCode === 'SUC0000') {
                this.postMessage({ command: 'sendResult', success: true, message: '数据发送成功' });
                vscode.window.showInformationMessage('数据发送成功');
            }
            else {
                this.postMessage({ command: 'sendResult', success: false, message: result.errorMsg || '发送失败' });
                vscode.window.showErrorMessage(result.errorMsg || '发送失败');
            }
        }
        catch (e) {
            this.postMessage({ command: 'sendResult', success: false, message: e.message || '发送失败' });
            vscode.window.showErrorMessage(e.message || '发送失败');
        }
    }
}
exports.TableBrowserProvider = TableBrowserProvider;
//# sourceMappingURL=TableBrowserProvider.js.map