import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { loadCsvFromFile } from '../services/csv-parser';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function escapeHtml(str: string): string {
    if (!str) return '';
    // 只转义必要的 HTML 字符
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

function parseCsvData(filePath: string): { headers: string[], rows: string[][], cols: { [key: string]: { width: number } } } {
    try {
        const data = loadCsvFromFile(filePath);
        const sheet = data.sheets[0];
        if (!sheet) return { headers: [], rows: [], cols: {} };

        const headers: string[] = [];
        const rows: string[][] = [];
        const cols: { [key: string]: { width: number } } = sheet.cols || {};

        const row0 = sheet.rows[0];
        if (row0) {
            const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
        }

        const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
        rowKeys.forEach(ri => {
            if (ri === 0 && headers.length > 0) return;
            const row = sheet.rows[ri];
            if (!row) return;
            const rowData: string[] = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
            while (rowData.length < headers.length) rowData.push('');
            rows.push(rowData);
        });

        return { headers, rows, cols };
    } catch (e) {
        console.error('CSV parse error:', e);
        return { headers: [], rows: [], cols: {} };
    }
}

export class CsvEditorProvider implements vscode.CustomEditorProvider {
    private onDidChangeCustomDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();

    constructor(private extensionUri: vscode.Uri) {}

    get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentEditEvent<vscode.CustomDocument>> {
        return this.onDidChangeCustomDocumentEmitter.event;
    }

    async openCustomDocument(uri: vscode.Uri, _openContext: { backupId?: string }, _token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
        return { uri: uri, dispose: () => {} } as vscode.CustomDocument;
    }

    async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
        const filePath = document.uri.fsPath;
        const nonce = getNonce();

        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };

        if (!isQualifiedCsvFile(document.uri)) {
            webviewPanel.webview.html = this.getErrorHtml('该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.csv');
            return;
        }

        // Load CSV data
        const csvData = parseCsvData(filePath);

        // Set HTML first without data
        webviewPanel.webview.html = this.getHtmlContent(webviewPanel.webview, nonce);

        // Send data via message after HTML is loaded
        webviewPanel.webview.onDidReceiveMessage((msg: any) => {
            if (msg?.type === 'init') {
                // Send CSV data to webview
                const dataStr = JSON.stringify(csvData);
                const base64Data = Buffer.from(dataStr, 'utf-8').toString('base64');
                webviewPanel.webview.postMessage({ type: 'csvData', data: base64Data });
            }
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

    private async saveFile(filePath: string, csvData: { headers?: string[], rows?: string[][] }): Promise<void> {
        if (!csvData) throw new Error('没有数据可保存');
        const headers = csvData.headers || [];
        const rows = csvData.rows || [];
        const lines: string[] = [];
        lines.push(headers.map(h => '"' + (h || '').replace(/"/g, '""') + '"').join(','));
        rows.forEach(row => {
            lines.push((row || []).map(cell => '"' + ((cell || '').toString()).replace(/"/g, '""') + '"').join(','));
        });
        await fs.promises.writeFile(filePath, '\uFEFF' + lines.join('\r\n'), 'utf-8');
    }

    private getErrorHtml(message: string): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}
.msg{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.msg h3{color:#e34d59;margin:0 0 12px}.msg p{color:#666;font-size:14px;margin:0}
</style></head><body><div class="msg"><h3>不支持的文件位置</h3><p>${message}</p></div></body></html>`;
    }

    saveCustomDocument(_document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> { return Promise.resolve(); }
    saveCustomDocumentAs(_document: vscode.CustomDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> { return Promise.resolve(); }
    revertCustomDocument(_document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> { return Promise.resolve(); }
    backupCustomDocument(_document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return Promise.resolve({ id: context.destination.toString(), delete: () => {} });
    }

    private getHtmlContent(webview: vscode.Webview, nonce: string): string {
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
