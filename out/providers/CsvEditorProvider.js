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
exports.CsvEditorProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const csv_parser_1 = require("../services/csv-parser");
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
function escapeHtml(str) {
    if (!str)
        return '';
    // 只转义必要的 HTML 字符
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function isQualifiedCsvFile(uri) {
    if (uri.scheme !== 'file' || !/\.csv$/i.test(uri.fsPath))
        return false;
    const parts = uri.fsPath.split(path.sep);
    const len = parts.length;
    if (len < 4)
        return false;
    const dirNames = parts.map(p => path.basename(p));
    const csvFileName = dirNames[len - 1];
    const caseDir = dirNames[len - 2];
    const rootDir = dirNames[len - 4];
    return (rootDir === '测试任务' || rootDir === 'testtask') &&
        (caseDir === '测试案例' || caseDir === 'testcase') &&
        /\.csv$/i.test(csvFileName);
}
function parseCsvData(filePath) {
    try {
        console.log('[CsvEditorProvider] 开始解析 CSV:', filePath);
        const data = (0, csv_parser_1.loadCsvFromFile)(filePath);
        console.log('[CsvEditorProvider] loadCsvFromFile 返回, rows:', data.sheets[0]?.rows ? Object.keys(data.sheets[0].rows).length : 0);
        const sheet = data.sheets[0];
        if (!sheet)
            return { headers: [], rows: [], cols: {} };
        const headers = [];
        const rows = [];
        const cols = sheet.cols || {};
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
        return { headers, rows, cols };
    }
    catch (e) {
        console.error('CSV parse error:', e);
        return { headers: [], rows: [], cols: {} };
    }
}
class CsvEditorProvider {
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
        this.onDidChangeCustomDocumentEmitter = new vscode.EventEmitter();
    }
    get onDidChangeCustomDocument() {
        return this.onDidChangeCustomDocumentEmitter.event;
    }
    async openCustomDocument(uri, _openContext, _token) {
        return { uri: uri, dispose: () => { } };
    }
    async resolveCustomEditor(document, webviewPanel, _token) {
        const filePath = document.uri.fsPath;
        const nonce = getNonce();
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        if (!isQualifiedCsvFile(document.uri)) {
            webviewPanel.webview.html = this.getErrorHtml('该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.csv');
            return;
        }
        // Load CSV data
        const csvData = parseCsvData(filePath);
        console.log('[CsvEditorProvider] parseCsvData 返回, headers:', JSON.stringify(csvData.headers).substring(0, 100));
        console.log('[CsvEditorProvider] 第一行数据:', JSON.stringify(csvData.rows[0]).substring(0, 200));
        // Set HTML first without data
        webviewPanel.webview.html = this.getHtmlContent(webviewPanel.webview, nonce);
        // Send data via message after HTML is loaded
        webviewPanel.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === 'init') {
                // Send CSV data to webview - 使用 Uint8Array 避免编码问题
                const dataStr = JSON.stringify(csvData);
                console.log('[CsvEditorProvider] JSON.stringify 长度:', dataStr.length);
                const encoder = new TextEncoder();
                const uint8Array = encoder.encode(dataStr);
                webviewPanel.webview.postMessage({ type: 'csvData', data: Array.from(uint8Array) });
            }
            if (msg?.type === 'save' && msg?.data) {
                this.saveFile(filePath, msg.data).then(() => {
                    webviewPanel.webview.postMessage({ type: 'saved' });
                }).catch((err) => {
                    const errMsg = err?.message || String(err) || '保存失败';
                    webviewPanel.webview.postMessage({ type: 'saveError', message: errMsg });
                });
            }
        });
    }
    async saveFile(filePath, csvData) {
        if (!csvData)
            throw new Error('没有数据可保存');
        const headers = csvData.headers || [];
        const rows = csvData.rows || [];
        const lines = [];
        lines.push(headers.map(h => '"' + (h || '').replace(/"/g, '""') + '"').join(','));
        rows.forEach(row => {
            lines.push((row || []).map(cell => '"' + ((cell || '').toString()).replace(/"/g, '""') + '"').join(','));
        });
        await fs.promises.writeFile(filePath, '\uFEFF' + lines.join('\r\n'), 'utf-8');
    }
    getErrorHtml(message) {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}
.msg{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.msg h3{color:#e34d59;margin:0 0 12px}.msg p{color:#666;font-size:14px;margin:0}
</style></head><body><div class="msg"><h3>不支持的文件位置</h3><p>${message}</p></div></body></html>`;
    }
    saveCustomDocument(_document, _cancellation) { return Promise.resolve(); }
    saveCustomDocumentAs(_document, destination, _cancellation) { return Promise.resolve(); }
    revertCustomDocument(_document, _cancellation) { return Promise.resolve(); }
    backupCustomDocument(_document, context, _cancellation) {
        return Promise.resolve({ id: context.destination.toString(), delete: () => { } });
    }
    getHtmlContent(webview, nonce) {
        const extensionUri = this.extensionUri;
        // Load HTML template
        const htmlPath = path.join(extensionUri.fsPath, 'src', 'services', 'csv-editor.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');
        // Replace nonce placeholder
        html = html.replace(/\$\{nonce\}/g, nonce);
        console.log('[CsvEditorProvider] HTML 模板已加载，长度:', html.length, 'nonce:', nonce.substring(0, 10) + '...');
        return html;
    }
}
exports.CsvEditorProvider = CsvEditorProvider;
//# sourceMappingURL=CsvEditorProvider.js.map