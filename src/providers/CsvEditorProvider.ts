import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { loadCsvFromFile } from '../services/csv-parser';

/**
 * 生成随机字符串作为 CSP nonce
 * 用于内容安全策略，防止 XSS 攻击
 */
function getNonce(): string {
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
function escapeHtml(str: string): string {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 检查 CSV 文件是否符合安全目录要求
 * 只允许在特定目录下打开 CSV 文件，防止任意文件访问
 * @param uri 文件 URI
 * @returns 是否符合要求
 */
function isQualifiedCsvFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !/\.csv$/i.test(uri.fsPath)) return false;
    const parts = uri.fsPath.split(path.sep);
    const len = parts.length;
    if (len < 4) return false;
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
function parseCsvData(filePath: string): { headers: string[], rows: string[][], cols: { [key: string]: { width: number } } } {
    try {
        const data = loadCsvFromFile(filePath);
        const sheet = data.sheets[0];
        if (!sheet) return { headers: [], rows: [], cols: {} };

        // 提取表头
        const headers: string[] = [];
        const rows: string[][] = [];
        const cols: { [key: string]: { width: number } } = sheet.cols || {};

        const row0 = sheet.rows[0];
        if (row0) {
            const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
        }

        // 提取数据行（跳过表头行）
        const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
        rowKeys.forEach(ri => {
            if (ri === 0 && headers.length > 0) return; // 跳过表头
            const row = sheet.rows[ri];
            if (!row) return;
            const rowData: string[] = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
            // 补齐空单元格
            while (rowData.length < headers.length) rowData.push('');
            rows.push(rowData);
        });

        return { headers, rows, cols };
    } catch (e) {
        console.error('CSV parse error:', e);
        return { headers: [], rows: [], cols: {} };
    }
}

/**
 * CSV 自定义编辑器 Provider
 * 负责在 VS Code 中打开和渲染 CSV 文件
 */
export class CsvEditorProvider implements vscode.CustomEditorProvider {
    private onDidChangeCustomDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();

    constructor(private extensionUri: vscode.Uri) {}

    get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentEditEvent<vscode.CustomDocument>> {
        return this.onDidChangeCustomDocumentEmitter.event;
    }

    /**
     * 打开新的自定义文档
     */
    async openCustomDocument(uri: vscode.Uri, _openContext: { backupId?: string }, _token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
        return { uri: uri, dispose: () => {} } as vscode.CustomDocument;
    }

    /**
     * 解析并渲染 CSV 文件到 WebView
     */
    async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
        const filePath = document.uri.fsPath;
        const nonce = getNonce();

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
        webviewPanel.webview.onDidReceiveMessage((msg: any) => {
            // WebView 初始化完成后发送数据
            if (msg?.type === 'init') {
                const dataStr = JSON.stringify(csvData);
                const encoder = new TextEncoder();
                const uint8Array = encoder.encode(dataStr);
                // 使用 Uint8Array 传输以正确处理 UTF-8 中文
                webviewPanel.webview.postMessage({ type: 'csvData', data: Array.from(uint8Array) });
            }
            // 保存文件
            if (msg?.type === 'save' && msg?.data) {
                this.saveFile(filePath, msg.data).then(() => {
                    webviewPanel.webview.postMessage({ type: 'saved' });
                }).catch((err: Error) => {
                    const errMsg = err?.message || String(err) || '保存失败';
                    webviewPanel.webview.postMessage({ type: 'saveError', message: errMsg });
                });
            }
        });
    }

    /**
     * 保存 CSV 数据到文件
     * @param filePath 文件路径
     * @param csvData CSV 数据（表头和行）
     */
    private async saveFile(filePath: string, csvData: { headers?: string[], rows?: string[][] }): Promise<void> {
        if (!csvData) throw new Error('没有数据可保存');
        const headers = csvData.headers || [];
        const rows = csvData.rows || [];
        const lines: string[] = [];

        // 生成 CSV 行，处理引号转义
        lines.push(headers.map(h => '"' + (h || '').replace(/"/g, '""') + '"').join(','));
        rows.forEach(row => {
            lines.push((row || []).map(cell => '"' + ((cell || '').toString()).replace(/"/g, '""') + '"').join(','));
        });

        // UTF-8 BOM + CRLF 换行
        await fs.promises.writeFile(filePath, '\uFEFF' + lines.join('\r\n'), 'utf-8');
    }

    /**
     * 生成错误提示 HTML
     */
    private getErrorHtml(message: string): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}
.msg{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.msg h3{color:#e34d59;margin:0 0 12px}.msg p{color:#666;font-size:14px;margin:0}
</style></head><body><div class="msg"><h3>不支持的文件位置</h3><p>${message}</p></div></body></html>`;
    }

    // 以下为 CustomEditorProvider 接口要求的空实现
    saveCustomDocument(_document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> { return Promise.resolve(); }
    saveCustomDocumentAs(_document: vscode.CustomDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> { return Promise.resolve(); }
    revertCustomDocument(_document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> { return Promise.resolve(); }
    backupCustomDocument(_document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return Promise.resolve({ id: context.destination.toString(), delete: () => {} });
    }

    /**
     * 加载 HTML 模板并替换 nonce
     */
    private getHtmlContent(webview: vscode.Webview, nonce: string): string {
        const extensionUri = this.extensionUri;

        // 读取 HTML 模板
        const htmlPath = path.join(extensionUri.fsPath, 'media', 'pages', 'csveditor', 'csv-editor.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');

        // 替换 nonce 占位符
        html = html.replace(/\$\{nonce\}/g, nonce);

        return html;
    }
}
