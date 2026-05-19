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
exports.CsvBrowserProvider = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
class CsvBrowserProvider {
    constructor(extensionUri, context) {
        this.extensionUri = extensionUri;
        this.context = context;
        this.disposables = [];
    }
    show() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Two);
            return;
        }
        this.panel = vscode.window.createWebviewPanel('csvBrowser', 'CSV文件浏览', vscode.ViewColumn.Two, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media')
            ]
        });
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg), null, this.disposables);
        this.panel.webview.html = this.getHtmlContent();
    }
    async handleMessage(msg) {
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
    }
    async handleFetchWorkspaceFiles() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.panel?.webview.postMessage({ command: 'workspaceFiles', data: [], error: '请先打开一个工作区文件夹' });
            return;
        }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const fileTree = this.buildFileTree(rootPath);
        this.panel?.webview.postMessage({ command: 'workspaceFiles', data: fileTree });
    }
    buildFileTree(rootPath) {
        const result = [];
        try {
            const firstLevelEntries = fs.readdirSync(rootPath, { withFileTypes: true });
            for (const firstEntry of firstLevelEntries) {
                // 第1层：只处理名为"测试任务"的目录
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
                                // 第3层：只处理名为"测试案例"的目录
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
                            console.error(`Error reading directory ${subTaskPath}:`, e);
                        }
                        // 如果有测试案例目录
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
                    console.error(`Error reading directory ${testTaskPath}:`, e);
                }
                // 如果有子任务目录
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
            console.error('Error building file tree:', e);
        }
        return result;
    }
    getCsvFilesInDir(dirPath) {
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
            console.error(`Error reading directory ${dirPath}:`, e);
        }
        return csvFiles;
    }
    async handleReadCsvFile(msg) {
        const filePath = msg.filePath;
        if (!filePath) {
            this.panel?.webview.postMessage({ command: 'csvData', data: null, error: '文件路径无效' });
            return;
        }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = this.parseCsvContent(content);
            if (!data) {
                this.panel?.webview.postMessage({ command: 'csvData', data: null, error: 'CSV文件为空' });
                return;
            }
            this.panel?.webview.postMessage({
                command: 'csvData',
                data: {
                    headers: data.headers,
                    rows: data.rows,
                    fileName: path.basename(filePath)
                }
            });
            console.log('[CsvBrowser] CSV数据已发送，rows:', data.rows.length, 'headers:', data.headers.length);
        }
        catch (e) {
            this.panel?.webview.postMessage({ command: 'csvData', data: null, error: e.message || '读取文件失败' });
        }
    }
    detectDelimiter(line) {
        const delimiters = [',', ';', '\t', '|'];
        const counts = delimiters.map(d => ({ delim: d, count: (line.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length }));
        const best = counts.filter(c => c.count >= 2).sort((a, b) => b.count - a.count)[0];
        return best ? best.delim : ',';
    }
    parseCsvLine(line, delimiter = ',') {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            }
            else if (ch === delimiter && !inQuotes) {
                result.push(current.trim());
                current = '';
            }
            else {
                current += ch;
            }
        }
        result.push(current.trim());
        return result;
    }
    parseCsvContent(content) {
        const lines = content.split('\n').filter(line => line.trim());
        if (lines.length === 0)
            return null;
        const delimiter = this.detectDelimiter(lines[0]);
        const headers = this.parseCsvLine(lines[0], delimiter);
        const rows = lines.slice(1).map(line => this.parseCsvLine(line, delimiter));
        return { headers, rows };
    }
    async handleSendSelectedData(msg) {
        const { selectedRows, headers } = msg;
        if (!selectedRows || selectedRows.length === 0) {
            vscode.window.showWarningMessage('请先勾选要发送的数据');
            return;
        }
        try {
            const { sendSelectedData } = require('../services/http-client');
            const result = await sendSelectedData({ selectedRows, headers }, this.context);
            if (result.returnCode === 'SUC0000') {
                this.panel?.webview.postMessage({ command: 'sendResult', success: true, message: '数据发送成功' });
                vscode.window.showInformationMessage('数据发送成功');
            }
            else {
                this.panel?.webview.postMessage({ command: 'sendResult', success: false, message: result.errorMsg || '发送失败' });
                vscode.window.showErrorMessage(result.errorMsg || '发送失败');
            }
        }
        catch (e) {
            this.panel?.webview.postMessage({ command: 'sendResult', success: false, message: e.message || '发送失败' });
            vscode.window.showErrorMessage(e.message || '发送失败');
        }
    }
    getHtmlContent() {
        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'csvbrowser', 'index.html');
        try {
            const nonce = getNonce();
            let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');
            // 记录 HTML 长度
            console.log('[CsvBrowserProvider] 原始 HTML 长度:', html.length);
            // 检查是否有未替换的占位符
            if (html.includes('${nonce}')) {
                console.log('[CsvBrowserProvider] 警告: ${nonce} 占位符未被替换');
            }
            if (html.includes('${scriptUri}')) {
                console.log('[CsvBrowserProvider] 警告: ${scriptUri} 占位符未被替换');
            }
            html = html.replace(/\$\{nonce\}/g, nonce);
            const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'csvbrowser', 'main.js')).toString();
            console.log('[CsvBrowserProvider] scriptUri:', scriptUri);
            html = html.replace(/\$\{scriptUri\}/g, scriptUri);
            // 检查替换后的 HTML
            console.log('[CsvBrowserProvider] 替换后 HTML 长度:', html.length);
            console.log('[CsvBrowserProvider] nonce 长度:', nonce.length);
            return html;
        }
        catch (e) {
            console.error('[CsvBrowserProvider] getHtmlContent 错误:', e);
            return this.getFallbackHtml();
        }
    }
    getFallbackHtml() {
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>CSV文件浏览</title></head>
<body style="padding:20px;font-family:sans-serif;color:#333;">
<h2>CSV文件浏览</h2>
<p style="color:#999;">页面加载中...</p>
</body></html>`;
    }
    dispose() {
        this.panel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
exports.CsvBrowserProvider = CsvBrowserProvider;
//# sourceMappingURL=CsvBrowserProvider.js.map