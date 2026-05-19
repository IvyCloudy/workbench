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
const http_client_1 = require("../services/http-client");
/**
 * 生成随机字符串作为 CSP nonce
 * 用于内容安全策略，防止 XSS 攻击
 */
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
/**
 * HTML 特殊字符转义
 * 防止 XSS 和 HTML 解析错误
 */
function escapeHtml(str) {
    if (!str)
        return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/**
 * 检查 CSV 文件是否符合安全目录要求
 * 只允许在特定目录下打开 CSV 文件，防止任意文件访问
 * @param uri 文件 URI
 * @returns 是否符合要求
 */
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
/**
 * 解析 CSV 文件数据为可渲染的格式
 * @param filePath CSV 文件路径
 * @returns 包含表头、行数据和列宽信息的对象
 */
function parseCsvData(filePath) {
    try {
        const data = (0, csv_parser_1.loadCsvFromFile)(filePath);
        const sheet = data.sheets[0];
        if (!sheet)
            return { headers: [], rows: [], cols: {} };
        // 提取表头
        const headers = [];
        const rows = [];
        const cols = sheet.cols || {};
        const row0 = sheet.rows[0];
        if (row0) {
            const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
        }
        // 提取数据行（跳过表头行）
        const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
        rowKeys.forEach(ri => {
            if (ri === 0 && headers.length > 0)
                return; // 跳过表头
            const row = sheet.rows[ri];
            if (!row)
                return;
            const rowData = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
            // 补齐空单元格
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
/**
 * CSV 自定义编辑器 Provider
 * 负责在 VS Code 中打开和渲染 CSV 文件
 */
class CsvEditorProvider {
    constructor(extensionUri, context) {
        this.extensionUri = extensionUri;
        this.onDidChangeCustomDocumentEmitter = new vscode.EventEmitter();
        this.context = context;
    }
    get onDidChangeCustomDocument() {
        return this.onDidChangeCustomDocumentEmitter.event;
    }
    /**
     * 打开新的自定义文档
     */
    async openCustomDocument(uri, _openContext, _token) {
        return { uri: uri, dispose: () => { } };
    }
    /**
     * 解析并渲染 CSV 文件到 WebView
     */
    async resolveCustomEditor(document, webviewPanel, _token) {
        const filePath = document.uri.fsPath;
        const nonce = getNonce();
        // 设置标题区分插件编辑器与 TextEditor
        const fileName = filePath.split(path.sep).pop() || 'CSV';
        webviewPanel.title = fileName + ' - 测试案例编辑器';
        // 配置 WebView 允许执行脚本
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        // 安全检查：只允许特定目录下的 CSV 文件
        if (!isQualifiedCsvFile(document.uri)) {
            webviewPanel.webview.html = this.getErrorHtml('该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.csv');
            return;
        }
        // 加载 CSV 数据
        const csvData = parseCsvData(filePath);
        // 先设置 HTML 内容
        webviewPanel.webview.html = this.getHtmlContent(webviewPanel.webview, nonce);
        // 监听 WebView 消息
        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            // WebView 初始化完成后发送数据（每次都重新读取文件确保最新）
            if (msg?.type === 'init') {
                const freshData = parseCsvData(filePath);
                const dataStr = JSON.stringify(freshData);
                const encoder = new TextEncoder();
                const uint8Array = encoder.encode(dataStr);
                // 使用 Uint8Array 传输以正确处理 UTF-8 中文
                webviewPanel.webview.postMessage({ type: 'csvData', data: Array.from(uint8Array) });
            }
            // 保存文件
            if (msg?.type === 'save' && msg?.data) {
                this.saveFile(filePath, msg.data).then(() => {
                    webviewPanel.webview.postMessage({ type: 'saved' });
                }).catch((err) => {
                    const errMsg = err?.message || String(err) || '保存失败';
                    webviewPanel.webview.postMessage({ type: 'saveError', message: errMsg });
                });
            }
            // 推送测试案例
            if (msg?.type === 'pushTestCase' && msg?.data) {
                console.log('[CSV推送] 收到推送请求');
                console.log('[CSV推送] 文件路径:', filePath);
                console.log('[CSV推送] 数据:', JSON.stringify(msg.data, null, 2));
                try {
                    const ctx = this.context;
                    console.log('[CSV推送] context:', ctx ? '已初始化' : '未初始化');
                    if (!ctx) {
                        webviewPanel.webview.postMessage({ type: 'pushError', message: '扩展上下文未初始化' });
                        return;
                    }
                    // 解析文件路径获取任务信息
                    const parts = filePath.split(path.sep);
                    console.log('[CSV推送] 路径部分:', parts);
                    const testTaskNo = parts.find((p, i) => p.startsWith('TT') || /^\d+$/.test(p.slice(0, 2))) || '';
                    console.log('[CSV推送] testTaskNo:', testTaskNo);
                    const result = await (0, http_client_1.queryApi)({
                        testTaskNo: testTaskNo,
                        currentPage: 1,
                        pageSize: 10
                    }, ctx);
                    console.log('[CSV推送] API 返回:', result);
                    webviewPanel.webview.postMessage({ type: 'pushSuccess', result });
                }
                catch (err) {
                    console.error('[CSV推送] 异常:', err);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: err?.message || '推送失败' });
                }
            }
            // 打开 TextEditor（不关闭插件面板，TextEditor 在当前列叠在插件上方）
            if (msg?.type === 'openTextEditor') {
                await vscode.commands.executeCommand('csvEditor.openWithFile', filePath);
            }
        });
    }
    /**
     * 保存 CSV 数据到文件
     * @param filePath 文件路径
     * @param csvData CSV 数据（表头和行）
     */
    async saveFile(filePath, csvData) {
        if (!csvData)
            throw new Error('没有数据可保存');
        const headers = csvData.headers || [];
        const rows = csvData.rows || [];
        const lines = [];
        // 辅助函数：只有包含逗号、引号或换行时才加引号
        const formatCell = (v) => {
            const s = v || '';
            if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
                return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        };
        // 生成 CSV 行
        lines.push(headers.map(formatCell).join(','));
        rows.forEach(row => {
            lines.push((row || []).map(cell => formatCell((cell || '').toString())).join(','));
        });
        // UTF-8 BOM + CRLF 换行
        await fs.promises.writeFile(filePath, '\uFEFF' + lines.join('\r\n'), 'utf-8');
    }
    /**
     * 生成错误提示 HTML
     */
    getErrorHtml(message) {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}
.msg{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.msg h3{color:#e34d59;margin:0 0 12px}.msg p{color:#666;font-size:14px;margin:0}
</style></head><body><div class="msg"><h3>不支持的文件位置</h3><p>${message}</p></div></body></html>`;
    }
    // 以下为 CustomEditorProvider 接口要求的空实现
    saveCustomDocument(_document, _cancellation) { return Promise.resolve(); }
    saveCustomDocumentAs(_document, destination, _cancellation) { return Promise.resolve(); }
    revertCustomDocument(_document, _cancellation) { return Promise.resolve(); }
    backupCustomDocument(_document, context, _cancellation) {
        return Promise.resolve({ id: context.destination.toString(), delete: () => { } });
    }
    /**
     * 加载 HTML 模板并替换 nonce
     */
    getHtmlContent(webview, nonce) {
        const extensionUri = this.extensionUri;
        // 读取 HTML 模板
        const htmlPath = path.join(extensionUri.fsPath, 'media', 'pages', 'csveditor', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');
        // 替换 nonce 占位符
        html = html.replace(/\$\{nonce\}/g, nonce);
        return html;
    }
}
exports.CsvEditorProvider = CsvEditorProvider;
//# sourceMappingURL=CsvEditorProvider.js.map