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
exports.YamlEditorProvider = exports.YamlDocumentContentProvider = void 0;
exports.isQualifiedYamlFile = isQualifiedYamlFile;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const yaml_parser_1 = require("../services/yaml-parser");
const http_client_1 = require("../services/http-client");
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
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 检查YAML文件是否满足目录要求
function isQualifiedYamlFile(uri) {
    if (uri.scheme !== 'file' || !/\.ya?ml$/i.test(uri.fsPath)) {
        return false;
    }
    const parts = uri.fsPath.split(path.sep);
    const len = parts.length;
    if (len < 4)
        return false;
    const dirNames = parts.map(p => path.basename(p));
    const caseDir = dirNames[len - 2];
    const rootDir = dirNames[len - 4];
    return (rootDir === '测试任务' || rootDir === 'testtask') &&
        (caseDir === '测试案例' || caseDir === 'testcase') &&
        /\.ya?ml$/i.test(dirNames[len - 1]);
}
// 解析YAML文件数据
function parseYamlData(filePath) {
    try {
        const data = (0, yaml_parser_1.loadYamlFromFile)(filePath);
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
        console.error('YAML parse error:', e);
        return { headers: [], rows: [], cols: {} };
    }
}
// YAML 文档内容提供者
class YamlDocumentContentProvider {
    constructor() {
        this.onDidChangeEmitter = new vscode.EventEmitter();
    }
    get onDidChange() {
        return this.onDidChangeEmitter.event;
    }
    provideTextDocumentContent(uri) {
        const nonce = getNonce();
        const filePath = uri.fsPath.replace(/^yaml-preview:/, '');
        let html = '<div style="padding:40px;text-align:center;color:#888;">加载中...</div>';
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                if (content.trim()) {
                    const data = parseYamlData(filePath);
                    if (data.headers.length > 0) {
                        html = this.buildYamlHtml(data.headers, data.rows, nonce);
                    }
                    else {
                        html = '<div style="padding:40px;text-align:center;color:#e34d59;">YAML解析失败或数据为空</div>';
                    }
                }
                else {
                    html = '<div style="padding:40px;text-align:center;color:#e34d59;">YAML文件为空</div>';
                }
            }
            else {
                html = '<div style="padding:40px;text-align:center;color:#e34d59;">文件不存在</div>';
            }
        }
        catch (e) {
            html = '<div style="padding:40px;text-align:center;color:#e34d59;">读取失败: ' + escapeHtml(e.message) + '</div>';
        }
        return this.getHtmlWrapper(html, nonce);
    }
    getHtmlWrapper(content, nonce) {
        return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
            '*{margin:0;padding:0;box-sizing:border-box}' +
            'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;color:#333;background:#f5f6f8}' +
            '.toolbar{margin:-16px -16px 14px;padding:10px 14px;background:#f7f8fa;border:1px solid #e5e9ef;border-radius:6px 6px 0 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
            '.search-box{display:flex;align-items:center;background:#fff;border:1px solid #dde3ea;border-radius:4px;padding:0 8px;height:30px;min-width:180px}' +
            '.search-box .ic{color:#999;font-size:13px;margin-right:4px}' +
            '.search-box input{border:none;outline:none;background:transparent;font-size:13px;color:#333;width:100%}' +
            '.search-count{font-size:11px;color:#888;white-space:nowrap}' +
            '.btn{padding:0 14px;height:30px;border:1px solid #dde3ea;border-radius:4px;background:#fff;color:#333;font-size:12.5px;cursor:pointer;white-space:nowrap}' +
            '.btn:hover{border-color:#0052d9;color:#0052d9}' +
            '.btn.primary{background:#0052d9;color:#fff;border-color:#0052d9}' +
            '.btn.primary:hover{background:#003cab}' +
            '.result-info{margin-left:auto;font-size:12px;color:#888;white-space:nowrap}' +
            '.table-scroll{overflow:auto;border:1px solid #e5e9ef;border-radius:0 0 6px 6px}' +
            'table{border-collapse:collapse;width:100%;font-size:12px;min-width:900px}' +
            'th,td{padding:7px 12px;text-align:left;border-bottom:1px solid #f0f2f5}' +
            'th{white-space:nowrap;background:#f7f8fa;font-weight:600;color:#333;position:sticky;top:0;z-index:1}' +
            'tr:hover td{background:#f0f6ff}' +
            'tr.selected td{background:#e8f3ff}' +
            'tr.hidden{display:none}' +
            'tr.search-match td{background:#fffbe6}' +
            'td input[type="checkbox"]{cursor:pointer;width:14px;height:14px}' +
            '.toast{position:fixed;bottom:20px;right:20px;padding:10px 16px;background:#333;color:#fff;border-radius:6px;font-size:12px;z-index:1000;opacity:0;transition:opacity .2s}' +
            '.toast.show{opacity:1}.toast.success{background:#2ba471}.toast.error{background:#e34d59}' +
            '.context-menu{position:fixed;background:#fff;border:1px solid #e5e9ef;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:1001;min-width:140px;padding:4px 0}' +
            '.context-menu-item{padding:8px 16px;cursor:pointer;font-size:13px;color:#333}.context-menu-item:hover{background:#f0f6ff}' +
            '</style></head><body>' +
            '<div class="toolbar">' +
            '<div class="search-box"><span class="ic">&#128269;</span><input type="text" id="searchInput" placeholder="搜索..." oninput="doSearch(this.value)"><span class="search-count" id="searchCount"></span></div>' +
            '<button class="btn primary" onclick="pushTestCase()">推送测试案例</button>' +
            '<span class="result-info">已选择 <strong id="selectedCount">0</strong> 行</span>' +
            '</div><div class="table-scroll">' + content + '</div>' +
            '<div class="toast" id="toast"></div>' +
            '<script nonce="' + nonce + '">' +
            '(function(){const vscode=acquireVsCodeApi();let selectedRows=new Set();if(!window.yamlData)window.yamlData={headers:[],rows:[]};' +
            'var yamlData=window.yamlData;' +
            'function selectAll(){selectedRows=new Set(yamlData.rows.map((_,i)=>i));updateUI();}' +
            'function deselectAll(){selectedRows.clear();updateUI();}' +
            'function updateUI(){var visibleRows=document.querySelectorAll("tbody tr:not(.hidden)");var visibleIndices=[];visibleRows.forEach(r=>{var idx=parseInt(r.getAttribute("data-row"));if(!isNaN(idx))visibleIndices.push(idx);});visibleIndices.forEach(i=>{var cb=document.querySelector(".row-checkbox[onclick*=\'toggleRow("+i+")\']");if(cb)cb.checked=selectedRows.has(i);});document.querySelectorAll("tbody tr").forEach((r,i)=>{r.classList.toggle("selected",selectedRows.has(i));});var headerCb=document.getElementById("headerCheckbox");if(headerCb){var checkedCount=visibleIndices.filter(i=>selectedRows.has(i)).length;headerCb.checked=checkedCount>0&&checkedCount===visibleIndices.length;headerCb.indeterminate=checkedCount>0&&checkedCount<visibleIndices.length;}document.getElementById("selectedCount").textContent=selectedRows.size;}' +
            'function toggleRow(i){selectedRows.has(i)?selectedRows.delete(i):selectedRows.add(i);updateUI();}' +
            'function showToast(m,t){const toast=document.getElementById("toast");toast.textContent=m;toast.className="toast show "+(t||"");setTimeout(()=>toast.classList.remove("show"),3000);}' +
            'function toggleAll(cb){if(cb.checked){selectedRows=new Set(yamlData.rows.map((_,i)=>i));}else{selectedRows.clear();}updateUI();}' +
            'function doSearch(keyword){const rows=document.querySelectorAll("tbody tr");let matchCount=0;keyword=keyword.toLowerCase();rows.forEach((row,i)=>{if(!keyword){row.classList.remove("hidden","search-match");matchCount++;}else{const text=row.textContent||"";if(text.toLowerCase().includes(keyword)){row.classList.remove("hidden");row.classList.add("search-match");matchCount++;}else{row.classList.add("hidden");row.classList.remove("search-match");}}});document.getElementById("searchCount").textContent=keyword?"匹配 "+matchCount+" 行":"";}' +
            'var ctxMenu=null;function showCtxMenu(e,rowIdx){e.preventDefault();hideCtxMenu();selectedRows.add(rowIdx);updateUI();ctxMenu=document.createElement("div");ctxMenu.className="context-menu";ctxMenu.innerHTML=\'<div class="context-menu-item" onclick="pushTestCase()">推送测试案例</div>\';ctxMenu.style.left=e.clientX+"px";ctxMenu.style.top=e.clientY+"px";document.body.appendChild(ctxMenu);document.addEventListener("click",hideCtxMenu);}function hideCtxMenu(){if(ctxMenu){ctxMenu.remove();ctxMenu=null;}document.removeEventListener("click",hideCtxMenu);}' +
            'function pushTestCase(){if(selectedRows.size===0){showToast("请先勾选要推送的测试案例","error");return;}var data=Array.from(selectedRows).map(i=>{var obj={};yamlData.headers.forEach((h,j)=>{obj[h]=yamlData.rows[i][j]||"";});return obj;});vscode.postMessage({type:"pushTestCase",data:data});showToast("推送中...","");}' +
            'window.addEventListener("message",function(e){var msg=e.data;if(msg.type==="pushSuccess"){showToast("推送成功","success");}if(msg.type==="pushError"){showToast("推送失败: "+msg.message,"error");}});' +
            'window.toggleRow=toggleRow;window.toggleAll=toggleAll;window.showCtxMenu=showCtxMenu;window.pushTestCase=pushTestCase;window.doSearch=doSearch;' +
            '})()' +
            '</script></body></html>';
    }
    buildYamlHtml(headers, rows, nonce) {
        let html = '<table><thead><tr><th style="width:40px;text-align:center"><input type="checkbox" id="headerCheckbox" onclick="toggleAll(this)"></th>';
        headers.forEach(h => html += '<th>' + escapeHtml(h) + '</th>');
        html += '</tr></thead><tbody>';
        rows.forEach((row, i) => {
            html += '<tr data-row="' + i + '" oncontextmenu="showCtxMenu(event,' + i + ')"><td style="text-align:center"><input type="checkbox" class="row-checkbox" onclick="toggleRow(' + i + ')"></td>';
            row.forEach(cell => html += '<td>' + escapeHtml(cell) + '</td>');
            html += '</tr>';
        });
        html += '</tbody></table>';
        const jsonData = JSON.stringify({ headers, rows }).replace(/<\/script>/gi, '<\\/script>');
        html += '<script nonce="' + nonce + '">window.yamlData=' + jsonData + ';Object.assign(yamlData,window.yamlData);</script>';
        return html;
    }
}
exports.YamlDocumentContentProvider = YamlDocumentContentProvider;
// YAML 自定义编辑器 Provider
class YamlEditorProvider {
    constructor(extensionUri, context) {
        this.extensionUri = extensionUri;
        this.onDidChangeCustomDocumentEmitter = new vscode.EventEmitter();
        this.context = context;
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
        const fileName = filePath.split(path.sep).pop() || 'YAML';
        webviewPanel.title = fileName + ' - 测试案例编辑器';
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        if (!isQualifiedYamlFile(document.uri)) {
            webviewPanel.webview.html = this.getErrorHtml('该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.yaml 或 *.yml');
            return;
        }
        const yamlData = parseYamlData(filePath);
        webviewPanel.webview.html = this.getHtmlContent(webviewPanel.webview, nonce);
        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type === 'init') {
                const freshData = parseYamlData(filePath);
                const dataStr = JSON.stringify(freshData);
                const encoder = new TextEncoder();
                const uint8Array = encoder.encode(dataStr);
                webviewPanel.webview.postMessage({ type: 'yamlData', data: Array.from(uint8Array) });
            }
            if (msg?.type === 'save' && msg?.data) {
                this.saveFile(filePath, msg.data).then(() => {
                    webviewPanel.webview.postMessage({ type: 'saved' });
                }).catch((err) => {
                    const errMsg = err?.message || String(err) || '保存失败';
                    webviewPanel.webview.postMessage({ type: 'saveError', message: errMsg });
                });
            }
            if (msg?.type === 'pushTestCase' && msg?.data) {
                console.log('[YAML推送] 收到推送请求');
                console.log('[YAML推送] 文件路径:', filePath);
                console.log('[YAML推送] 数据:', JSON.stringify(msg.data, null, 2));
                try {
                    const ctx = this.context;
                    if (!ctx) {
                        webviewPanel.webview.postMessage({ type: 'pushError', message: '扩展上下文未初始化' });
                        return;
                    }
                    const parts = filePath.split(path.sep);
                    console.log('[YAML推送] 路径部分:', parts);
                    const testTaskNo = parts.find((p, i) => p.startsWith('TT') || /^\d+$/.test(p.slice(0, 2))) || '';
                    console.log('[YAML推送] testTaskNo:', testTaskNo);
                    const result = await (0, http_client_1.queryApi)({
                        testTaskNo: testTaskNo,
                        currentPage: 1,
                        pageSize: 10
                    }, ctx);
                    console.log('[YAML推送] API 返回:', result);
                    webviewPanel.webview.postMessage({ type: 'pushSuccess', result });
                }
                catch (err) {
                    console.error('[YAML推送] 异常:', err);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: err?.message || '推送失败' });
                }
            }
            if (msg?.type === 'openTextEditor') {
                await vscode.commands.executeCommand('yamlEditor.openWithFile', filePath);
            }
        });
    }
    async saveFile(filePath, yamlData) {
        if (!yamlData)
            throw new Error('没有数据可保存');
        const headers = yamlData.headers || [];
        const rows = yamlData.rows || [];
        const yaml = require('yaml');
        const records = rows.map(row => {
            const record = {};
            headers.forEach((h, i) => {
                record[h] = row[i] || '';
            });
            return record;
        });
        const yamlContent = yaml.stringify(records.length === 1 ? records[0] : records);
        await fs.promises.writeFile(filePath, yamlContent, 'utf-8');
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
        // 使用与CSV相同的HTML模板
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline';">
<style nonce="${nonce}">
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#fff;--tl:#666;--bd:#ddd;--p:#0078d4;--s:#107c10;--d:#e34d59;--sh:0 2px 8px rgba(0,0,0,.1)}
body{font-family:system-ui,-apple-system,sans-serif;font-size:13px;background:var(--bg);color:#333;overflow:hidden}
.xs-app{height:100vh;display:flex;flex-direction:column}
.xs-toolbar{display:flex;align-items:center;padding:8px 12px;background:var(--bg);border-bottom:1px solid var(--bd);gap:8px;flex-shrink:0}
.xs-title{font-weight:600;color:#333}
.xs-sp{flex:1}
.xs-mod{display:none;font-size:12px;color:var(--tl)}
.xs-mod strong{color:var(--d)}
.xs-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:4px;cursor:pointer;background:#f5f5f5;border:1px solid var(--bd);transition:all .15s;flex-shrink:0}
.xs-icon-btn:hover{background:#e8e8e8;border-color:var(--p)}
.xs-icon-btn svg{width:14px;height:14px;fill:var(--tl)}
.xs-icon-btn:hover svg{fill:var(--p)}
.xs-btn{background:#f5f5f5;border:1px solid var(--bd);border-radius:3px;padding:4px 12px;cursor:pointer;font-size:12px;transition:all .15s}
.xs-btn:hover{background:#e8e8e8}
.xs-btn:disabled{opacity:.5;cursor:not-allowed}
.xs-btn-p{background:var(--p);color:#fff;border-color:var(--p)}
.xs-btn-p:hover{background:#006cbd}
.xs-search{display:flex;align-items:center;background:#f5f5f5;border-radius:4px;padding:4px 8px;gap:4px}
.xs-search input{background:transparent;border:none;outline:none;font-size:12px;width:140px}
.xs-container{flex:1;overflow:auto;padding:0}
.xs-container table{width:100%;table-layout:fixed}
.xs-table{border-collapse:collapse;table-layout:fixed;width:100%}
.xs-th{background:#f5f5f5;border:1px solid var(--bd);padding:8px 24px 8px 8px;position:relative;user-select:none;font-weight:500;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box}
.xs-th[data-sort]{background:#e3f2fd}
.xs-th[data-sort]::after{content:'\\25b2';margin-left:4px;font-size:10px;opacity:.5}
.xs-th[data-sort="desc"]::after{content:'\\25bc'}
.xs-th-cb{width:50px;text-align:center;padding:8px;box-sizing:border-box;position:sticky;left:0;top:0;z-index:5;background:#f5f5f5}
.xs-th:not(.xs-th-cb){position:sticky;top:0;z-index:2;background:#f5f5f5}
.xs-th-text{display:inline;vertical-align:middle}
.xs-th-filter{position:absolute;right:18px;top:50%;transform:translateY(-50%);cursor:pointer;opacity:.5;font-size:10px}
.xs-th:hover .xs-th-filter{opacity:1}
.xs-resizer{position:absolute;right:0;top:0;bottom:0;width:16px;cursor:col-resize;background:transparent;z-index:1}
.xs-th:hover .xs-resizer{background:rgba(0,120,212,.1)}
.xs-resizer:hover{background:var(--p)!important}
.xs-td{border:1px solid var(--bd);padding:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box}
.xs-td-cb{width:50px;text-align:center;cursor:row-resize;position:sticky;left:0;z-index:3;background:#fff;overflow:visible}
.xs-cell-wrap{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-word}
.xs-td-cb:hover{background:rgba(0,120,212,.1)}
.xs-td-cb::after{content:'';position:absolute;left:2px;right:2px;bottom:2px;height:3px;background:transparent;border-radius:1px}
tbody tr:hover .xs-td-cb::after{background:rgba(0,120,212,.3)}
.xs-td-cb:active::after{background:var(--p)}
.xs-editable{cursor:cell}
.xs-editable.active{outline:2px solid var(--p);outline-offset:-2px}
.xs-editable.modified{background:#fffbe6}
.xs-editable.highlight{background:#fff59d}
.xs-td input{width:100%;border:none;outline:none;padding:0;margin:0;font:inherit;background:transparent}
tbody tr{position:relative}
tbody tr:hover{background:#f8f8f8}
tbody tr.selected{background:#e3f2fd}
tbody tr.hidden{display:none}
tbody tr td:first-child{text-align:center;background:inherit}
tbody tr td:first-child input{width:16px;height:16px;cursor:pointer}
tbody tr.selected td.xs-td-cb{background:#e3f2fd}
tbody tr:hover td.xs-td-cb{background:#f8f8f8}
.xs-cm{display:none;position:fixed;background:#fff;border:1px solid var(--bd);border-radius:4px;box-shadow:var(--sh);z-index:1000;min-width:160px;padding:4px 0}
.xs-mi{padding:6px 12px;cursor:pointer;font-size:12px}
.xs-mi:hover{background:#f5f5f5}
.xs-mi.disabled{opacity:.4;cursor:not-allowed}
.xs-mi.disabled:hover{background:transparent}
.xs-div{height:1px;background:var(--bd);margin:4px 0}
.lb{float:right;color:var(--tl);font-size:11px}
.xs-sf{display:none;position:fixed;background:#fff;border:1px solid var(--bd);border-radius:4px;box-shadow:var(--sh);z-index:1000;min-width:120px;padding:4px 0}
.xs-sfi{padding:6px 12px;cursor:pointer;font-size:12px}
.xs-sfi:hover{background:#f5f5f5}
.xs-sfi.active{color:var(--p);font-weight:600}
.xs-find{display:none;position:fixed;top:44px;right:10px;z-index:999;background:#fff;border-radius:4px;box-shadow:var(--sh);padding:8px;min-width:280px}
.xs-find.show{display:block}
.xs-find-row{display:flex;gap:6px;margin-bottom:6px}
.xs-find input{flex:1;padding:4px 8px;border:1px solid var(--bd);border-radius:3px;outline:none;font-size:12px}
.xs-find input:focus{border-color:var(--p)}
.xs-find input[type="checkbox"]{width:auto}
.xs-find-btns{display:flex;gap:4px;flex-wrap:wrap}
.xs-find-info{font-size:11px;color:var(--tl);padding:4px 0}
.xs-toast{position:fixed;z-index:2000;background:#fff;border:1px solid rgba(0,0,0,.1);border-radius:4px;padding:12px 16px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.15);display:none;left:50%;top:50%;transform:translate(-50%,-50%)}
.xs-toast.success{border-color:var(--s);color:var(--s)}
.xs-toast.error{border-color:var(--d);color:var(--d)}
.xs-load{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,.9);display:flex;align-items:center;justify-content:center;z-index:3000}
.xs-spin{width:40px;height:40px;border:3px solid var(--bd);border-top-color:var(--p);border-radius:50%;animation:xs-spin .8s linear infinite}
@keyframes xs-spin{to{transform:rotate(360deg)}}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:#ccc;border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:#aaa}
</style>
</head>
<body>
<div class="xs-app">
    <div class="xs-toolbar">
        <div class="xs-icon-btn" data-action="openTextEditor" title="用 Text Editor 打开">
            <svg viewBox="0 0 16 16"><path d="M4 1h5.5L13 4.5v9a.5.5 0 01-.5.5h-8a.5.5 0 01-.5-.5V1.5A.5.5 0 014 1zm5 .5V4h2.5L9 1.5zM5 7h5v1H5V7zm0 2h5v1H5V9zm0 2h3v1H5v-1z"/></svg>
        </div>
        <span class="xs-title">测试案例</span>
        <div class="xs-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="searchInput" placeholder="搜索...">
        </div>
        <button class="xs-btn xs-btn-p" id="pushBtn" disabled>推送</button>
        <span class="xs-sp"></span>
        <span class="xs-mod" id="modInfo">已修改 <strong id="modCount">0</strong></span>
        <div class="xs-icon-btn" id="findBtn" title="查找">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
        <span id="selInfo" style="font-size:12px;color:#666">已选 0 行，共 0 行</span>
    </div>
    <div class="xs-container" id="tableContainer"></div>
    <div class="xs-load" id="loading" style="display:none"><div class="xs-spin"></div></div>
    <div class="xs-cm" id="ctxMenu"></div>
    <div class="xs-sf" id="sortFilter"></div>
    <div class="xs-find" id="findPanel">
        <div class="xs-find-row">
            <input type="text" id="findInput" placeholder="查找...">
            <button class="xs-btn" id="prevBtn">上一个</button>
            <button class="xs-btn" id="nextBtn">下一个</button>
        </div>
        <div class="xs-find-row">
            <input type="text" id="replaceInput" placeholder="替换为...">
            <button class="xs-btn" id="replaceBtn">替换</button>
            <button class="xs-btn" id="replaceAllBtn">全部</button>
        </div>
        <div class="xs-find-info" id="findInfo"></div>
    </div>
    <div class="xs-toast" id="toast"></div>
</div>
<script nonce="${nonce}">
var S={data:{},sel:new Set(),cell:null,clip:null,mods:new Set(),hist:[],hIdx:-1,sCol:null,sOrder:'asc',colWidths:{},vscode:null,editing:false};
function init(){S.vscode=acquireVsCodeApi();S.vscode.postMessage({type:'init'});}
window.addEventListener('focus',function(){if(S.vscode)S.vscode.postMessage({type:'init'});});
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
window.addEventListener('message',function(e){var msg=e.data;
if(msg.type==='yamlData'){try{var decoder=new TextDecoder('utf-8');var uint8Array=new Uint8Array(msg.data);var decoded=decoder.decode(uint8Array);S.data=JSON.parse(decoded);}catch(ex){S.data={headers:[],rows:[]};}S.sel.clear();S.cell=null;S.clip=null;S.mods.clear();S.hist=[];S.hIdx=-1;saveHist();bindEv();updUI();reRender();var loading=document.getElementById('loading');if(loading)loading.style.display='none';}
if(msg.type==='saved'){S.mods.clear();document.querySelectorAll('.xs-editable.modified').forEach(function(td){td.classList.remove('modified');});updUI();}
if(msg.type==='saveError'){toast('保存失败: '+msg.message,'error');}
if(msg.type==='pushSuccess'){toast('推送成功','success');}
if(msg.type==='pushError'){toast('推送失败: '+msg.message,'error');}
});
function saveHist(){var snap=JSON.stringify(S.data);if(S.hIdx<S.hist.length-1)S.hist=S.hist.slice(0,S.hIdx+1);S.hist.push(snap);S.hIdx=S.hist.length-1;if(S.hist.length>50){S.hist.shift();S.hIdx--;}}
function undo(){if(S.hIdx>0){S.hIdx--;S.data=JSON.parse(S.hist[S.hIdx]);reRender();updUI();toast('撤销成功','success');}else{toast('无法撤销','error');}}
function redo(){if(S.hIdx<S.hist.length-1){S.hIdx++;S.data=JSON.parse(S.hist[S.hIdx]);reRender();updUI();toast('重做成功','success');}else{toast('无法重做','error');}}
function bindEv(){var hcb=document.getElementById('headerCheckbox');if(hcb)hcb.addEventListener('change',function(){this.checked?selAll():deselAll();});var tbl=document.querySelector('.xs-table');if(tbl)tbl.addEventListener('contextmenu',function(e){e.preventDefault();document.getElementById('ctxMenu').style.display='none';document.getElementById('sortFilter').style.display='none';var td=e.target.closest('td');if(td&&td.classList.contains('xs-editable')){S.cell=td;updCellSel();}showCtx(e.clientX,e.clientY);});document.addEventListener('mousedown',function(e){var isMenuClick=e.target.closest('.xs-cm')||e.target.closest('.xs-sf')||e.target.closest('.xs-find');if(!isMenuClick){document.getElementById('ctxMenu').style.display='none';document.getElementById('sortFilter').style.display='none';document.getElementById('findPanel').classList.remove('show');}});document.addEventListener('click',function(e){var iconBtn=e.target.closest('.xs-icon-btn');if(iconBtn){var action=iconBtn.dataset.action;if(action==='openTextEditor')openTextEditor();return;}var cb=e.target.closest('.row-cb');if(cb){var tr=cb.closest('tr');var idx=parseInt(tr.dataset.row);if(cb.checked)S.sel.add(idx);else S.sel.delete(idx);updSel();e.stopPropagation();return;}var td=e.target.closest('.xs-editable');if(td){setCell(td);return;}if(!e.target.closest('.xs-cm')&&!e.target.closest('.xs-sf')&&!e.target.closest('.xs-find')){document.getElementById('ctxMenu').style.display='none';document.getElementById('sortFilter').style.display='none';document.getElementById('findPanel').classList.remove('show');}});document.addEventListener('dblclick',function(e){var td=e.target.closest('.xs-editable');if(td){startEdit(td);}});document.addEventListener('click',function(e){var btn=e.target.closest('.xs-th-filter');if(btn){e.stopPropagation();var th=btn.closest('th');var col=parseInt(th.dataset.col);showSortF(col,th);return;}});document.addEventListener('mousedown',function(e){var res=e.target.closest('.xs-resizer');if(res){e.preventDefault();e.stopPropagation();var th=res.parentElement;var startX=e.clientX;var startW=th.offsetWidth;document.body.style.cursor='col-resize';function onMove(ev){var w=Math.max(40,startW+(ev.clientX-startX));th.style.width=w+'px';S.colWidths[parseInt(th.dataset.col)]=w;}function onUp(){document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);document.body.style.cursor='';}document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);return;}var tdCb=e.target.closest('.xs-td-cb');if(tdCb&&!e.target.closest('input')){e.preventDefault();e.stopPropagation();var tr=tdCb.closest('tr');var startY=e.clientY;var startH=tr.getBoundingClientRect().height;var rowIdx=parseInt(tr.dataset.row);var tdSample=tr.querySelector('.xs-td:not(.xs-td-cb)');var lineH=tdSample?tdSample.offsetHeight:28;document.body.style.cursor='row-resize';function updateWrap(h){var lines=Math.max(1,Math.round(h/lineH));var wraps=tr.querySelectorAll('.xs-cell-wrap');wraps.forEach(function(w){w.style.whiteSpace=lines>1?'normal':'nowrap';w.style.overflow='hidden';w.style.textOverflow='ellipsis';w.style.wordBreak='break-word';w.style.display=lines>1?'-webkit-box':'';w.style.webkitBoxOrient='vertical';w.style.webkitLineClamp=lines>1?lines:'';});}function onMove(ev){var h=Math.max(lineH,startH+(ev.clientY-startY));tr.style.height=h+'px';S.rowHeights=S.rowHeights||{};S.rowHeights[rowIdx]=h;updateWrap(h);}function onUp(){document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);document.body.style.cursor='';}document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);return;}});document.getElementById('pushBtn').addEventListener('click',pushTC);document.getElementById('findBtn').addEventListener('click',toggleFind);document.getElementById('searchInput').addEventListener('input',function(){doSearch(this.value);});document.getElementById('findInput').addEventListener('input',function(){doFind();});document.getElementById('prevBtn').addEventListener('click',doPrev);document.getElementById('nextBtn').addEventListener('click',doNext);document.getElementById('replaceBtn').addEventListener('click',doReplace);document.getElementById('replaceAllBtn').addEventListener('click',doReplaceAll);}
document.addEventListener('keydown',function(e){if(document.activeElement.tagName==='INPUT')return;var c=e.ctrlKey||e.metaKey;if(c&&e.key==='c'){e.preventDefault();copySel();}if(c&&e.key==='x'){e.preventDefault();cutSel();}if(c&&e.key==='v'){e.preventDefault();pasteClip();}if(c&&e.key==='a'){e.preventDefault();selAll();}if(c&&e.key==='z'){e.preventDefault();undo();}if(c&&e.key==='y'){e.preventDefault();redo();}if(c&&e.key==='f'){e.preventDefault();toggleFind();}if((e.key==='Delete'||e.key==='Backspace')&&S.cell){e.preventDefault();clearCell();}if(e.key==='Enter'&&S.cell){e.preventDefault();startEdit(S.cell);}if(e.key==='Escape'){cancelEdit();}});
function updUI(){var si=document.getElementById('selInfo');if(si)si.textContent='已选 '+S.sel.size+' 行，共 '+S.data.rows.length+' 行';var mi=document.getElementById('modInfo');var mc=document.getElementById('modCount');if(mi)mi.style.display=S.mods.size>0?'inline':'none';if(mc)mc.textContent=S.mods.size;updSel();updSearch();}
function updSel(){document.querySelectorAll('tbody tr').forEach(function(tr){var idx=parseInt(tr.dataset.row);var cb=tr.querySelector('.row-cb');if(cb)cb.checked=S.sel.has(idx);tr.classList.toggle('selected',S.sel.has(idx));});var si=document.getElementById('selInfo');if(si)si.textContent='已选 '+S.sel.size+' 行，共 '+S.data.rows.length+' 行';var hcb=document.getElementById('headerCheckbox');if(hcb){var vr=document.querySelectorAll('tbody tr:not(.hidden)');var vi=Array.from(vr).map(function(r){return parseInt(r.dataset.row);});var sv=vi.filter(function(i){return S.sel.has(i);}).length;hcb.checked=sv>0&&sv===vi.length;hcb.indeterminate=sv>0&&sv<vi.length;}var pb=document.getElementById('pushBtn');if(pb)pb.disabled=S.sel.size===0;}
function updCellSel(){document.querySelectorAll('.xs-editable').forEach(function(td){td.classList.remove('active');});if(S.cell)S.cell.classList.add('active');}
function updSearch(){var kw=(document.getElementById('searchInput').value||'').toLowerCase();document.querySelectorAll('tbody tr').forEach(function(tr){var matchKw=!kw||(tr.textContent||'').toLowerCase().includes(kw);tr.classList.toggle('hidden',!matchKw);});updSel();}
function selAll(){document.querySelectorAll('tbody tr:not(.hidden)').forEach(function(tr){S.sel.add(parseInt(tr.dataset.row));});updSel();}
function deselAll(){S.sel.clear();updSel();}
function setCell(td){document.querySelectorAll('.xs-editable').forEach(function(t){t.classList.remove('active');});S.cell=td;if(td){td.classList.add('active');var idx=parseInt(td.dataset.row);if(!S.sel.has(idx)){S.sel.clear();S.sel.add(idx);}updSel();}}
function startEdit(td){if(td.querySelector('input'))return;setCell(td);S.editing=true;var ri=parseInt(td.dataset.row);var ci=parseInt(td.dataset.col);var orig=S.data.rows[ri]&&S.data.rows[ri][ci]||'';td.innerHTML='<input type="text" value="'+escHtml(orig)+'">';var inp=td.querySelector('input');inp.focus();inp.select();inp.addEventListener('blur',function(){S.editing=false;finEdit(td,ri,ci,orig);});inp.addEventListener('keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();S.editing=false;finEdit(td,ri,ci,orig);var nt=document.querySelector('.xs-editable[data-row="'+(ri+1)+'"][data-col="'+ci+'"]');if(nt){setCell(nt);startEdit(nt);}}if(ev.key==='Escape'){td.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text">'+escHtml(orig)+'</span></div>';S.editing=false;setCell(td);}});}
function finEdit(td,ri,ci,orig){try{var inp=td&&td.querySelector&&td.querySelector('input');if(!inp)return;var val=inp.value;var parent=td.parentNode;if(!parent)return;td.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text">'+escHtml(val)+'</span></div>';if(val!==orig){if(!S.data.rows[ri])S.data.rows[ri]=[];S.data.rows[ri][ci]=val;var k=ri+'-'+ci;if(!S.mods.has(k)){S.mods.add(k);}td.classList.add('modified');saveHist();updUI();autoSave();}var newTd=document.querySelector('.xs-editable[data-row="'+ri+'"][data-col="'+ci+'"]');if(newTd)setCell(newTd);}catch(e){}}
function cancelEdit(){document.querySelectorAll('.xs-editable input').forEach(function(inp){inp.blur();});}
function clearCell(){if(!S.cell)return;var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);S.data.rows[ri][ci]='';S.cell.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text"></span></div>';var k=ri+'-'+ci;S.mods.add(k);S.cell.classList.add('modified');saveHist();updUI();autoSave();}
function copySel(){if(S.cell){var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);S.clip={type:'cell',data:S.data.rows[ri]&&S.data.rows[ri][ci]||''};navigator.clipboard.writeText(S.clip.data);toast('已复制单元格','success');}else if(S.sel.size>0){var rows=Array.from(S.sel).sort(function(a,b){return a-b;});var text=rows.map(function(i){return(S.data.rows[i]||[]).join('\\t');}).join('\\n');S.clip={type:'rows',data:rows.map(function(i){return[...(S.data.rows[i]||[])];})};navigator.clipboard.writeText(text);toast('已复制 '+rows.length+' 行','success');}}
function cutSel(){copySel();if(S.cell){var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);S.data.rows[ri][ci]='';S.cell.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text"></span></div>';saveHist();updUI();autoSave();}toast('已剪切','success');}
function pasteClip(){if(!S.clip)return;if(S.clip.type==='cell'&&S.cell){var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);if(!S.data.rows[ri])S.data.rows[ri]=[];S.data.rows[ri][ci]=S.clip.data;S.cell.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text">'+escHtml(S.clip.data)+'</span></div>';saveHist();updUI();autoSave();toast('已粘贴','success');}else if(S.clip.type==='rows'){var sr=S.sel.size>0?Math.min(...S.sel):0;S.clip.data.forEach(function(row,i){if(S.data.rows[sr+i]){row.forEach(function(val,j){S.data.rows[sr+i][j]=val;});}});reRender();saveHist();updUI();autoSave();toast('已粘贴 '+S.clip.data.length+' 行','success');}}
function insertRow(){var idx=S.cell?parseInt(S.cell.dataset.row)+1:S.data.rows.length;var nr=new Array(S.data.headers.length).fill('');S.data.rows.splice(idx,0,nr);saveHist();reRender();updUI();autoSave();toast('已插入行','success');}
function duplicateRow(){var idx=S.cell?parseInt(S.cell.dataset.row):(S.sel.size>0?Math.min(...S.sel):S.data.rows.length-1);if(S.data.rows.length===0){toast('无数据可复制','error');return;}var src=S.data.rows[idx];if(!src){toast('源行不存在','error');return;}var copy=[...src];S.data.rows.splice(idx+1,0,copy);S.sel.clear();S.sel.add(idx+1);saveHist();reRender();updUI();autoSave();toast('已复制行','success');}
function autoSave(){S.vscode.postMessage({type:'save',data:{headers:S.data.headers,rows:S.data.rows}});}
function insertCol(){var idx=S.cell?parseInt(S.cell.dataset.col)+1:S.data.headers.length;S.data.headers.splice(idx,0,'新列');S.data.rows.forEach(function(r){r.splice(idx,0,'');});saveHist();reRender();updUI();autoSave();toast('已插入列','success');}
function deleteRows(){if(S.sel.size===0)return;var rows=Array.from(S.sel).sort(function(a,b){return b-a;});rows.forEach(function(i){S.data.rows.splice(i,1);});S.sel.clear();saveHist();reRender();updUI();autoSave();toast('已删除 '+rows.length+' 行','success');}
function deleteCol(){if(!S.cell)return;var colIdx=parseInt(S.cell.dataset.col);if(S.data.headers.length<=1){toast('至少保留一列','error');return;}S.data.headers.splice(colIdx,1);S.data.rows.forEach(function(r){r.splice(colIdx,1);});S.sel.clear();S.cell=null;saveHist();reRender();updUI();autoSave();toast('已删除列','success');}
function showCtx(x,y){var menu=document.getElementById('ctxMenu');menu.innerHTML='<div class="xs-mi'+(S.sel.size>0?'':' disabled')+'" id="ctxPush">推送测试案例</div><div class="xs-div"></div><div class="xs-mi" id="ctxCopy">复制 <span class="lb">Ctrl+C</span></div><div class="xs-mi" id="ctxCut">剪切 <span class="lb">Ctrl+X</span></div><div class="xs-mi'+(S.clip?'':' disabled')+'" id="ctxPaste">粘贴 <span class="lb">Ctrl+V</span></div><div class="xs-div"></div><div class="xs-mi" id="ctxInsertRow">插入行</div><div class="xs-mi" id="ctxDuplicateRow">复制行</div><div class="xs-mi" id="ctxInsertCol">插入列</div><div class="xs-div"></div><div class="xs-mi'+(S.sel.size>0?'':' disabled')+'" id="ctxDeleteRows">删除行</div><div class="xs-mi'+(S.cell?'':' disabled')+'" id="ctxDeleteCol">删除列</div><div class="xs-mi'+(S.cell?'':' disabled')+'" id="ctxClearCell">清除内容</div><div class="xs-div"></div><div class="xs-mi" id="ctxSelAll">全选 <span class="lb">Ctrl+A</span></div>';document.getElementById('ctxCopy').addEventListener('click',copySel);document.getElementById('ctxCut').addEventListener('click',cutSel);document.getElementById('ctxPaste').addEventListener('click',pasteClip);document.getElementById('ctxInsertRow').addEventListener('click',insertRow);document.getElementById('ctxDuplicateRow').addEventListener('click',duplicateRow);document.getElementById('ctxInsertCol').addEventListener('click',insertCol);document.getElementById('ctxDeleteRows').addEventListener('click',deleteRows);document.getElementById('ctxDeleteCol').addEventListener('click',deleteCol);document.getElementById('ctxClearCell').addEventListener('click',clearCell);document.getElementById('ctxSelAll').addEventListener('click',selAll);document.getElementById('ctxPush').addEventListener('click',pushTC);menu.querySelectorAll('.xs-mi:not(.disabled)').forEach(function(mi){mi.addEventListener('click',function(){menu.style.display='none';});});menu.style.display='block';menu.style.left=Math.min(x,window.innerWidth-menu.offsetWidth-10)+'px';menu.style.top=Math.min(y,window.innerHeight-menu.offsetHeight-10)+'px';}
function showSortF(col,th){var rect=th.getBoundingClientRect();var sf=document.getElementById('sortFilter');var aA=(S.sCol===col&&S.sOrder==='asc')?' active':'';var dA=(S.sCol===col&&S.sOrder==='desc')?' active':'';sf.innerHTML='<div class="xs-sfi'+aA+'" data-col="'+col+'" data-dir="asc">升序</div><div class="xs-sfi'+dA+'" data-col="'+col+'" data-dir="desc">降序</div><div class="xs-div"></div><div class="xs-sfi" id="clearSortBtn">清除排序</div>';sf.querySelectorAll('.xs-sfi[data-col]').forEach(function(el){el.addEventListener('click',function(){var c=parseInt(el.dataset.col);var d=el.dataset.dir;sortBy(c,d);});});document.getElementById('clearSortBtn').addEventListener('click',clearSort);sf.style.display='block';sf.style.left=rect.left+'px';sf.style.top=rect.bottom+'px';}
function sortBy(col,order){S.sCol=col;S.sOrder=order;S.data.rows.sort(function(a,b){var va=(a[col]||'').toString().toLowerCase();var vb=(b[col]||'').toString().toLowerCase();var na=parseFloat(va);var nb=parseFloat(vb);if(!isNaN(na)&&!isNaN(nb)){return order==='asc'?na-nb:nb-na;}return order==='asc'?va.localeCompare(vb):vb.localeCompare(va);});saveHist();reRender();updUI();document.getElementById('sortFilter').style.display='none';document.querySelectorAll('.xs-th').forEach(function(th){th.removeAttribute('data-sort');});var thEl=document.querySelector('.xs-th[data-col="'+col+'"]');if(thEl)thEl.setAttribute('data-sort',order);}
function clearSort(){S.sCol=null;S.sOrder='asc';document.querySelectorAll('.xs-th').forEach(function(th){th.removeAttribute('data-sort');});document.getElementById('sortFilter').style.display='none';}
function doSearch(kw){updSearch();clearHighlights();if(!kw)return;var kwLower=kw.toLowerCase();S.data.rows.forEach(function(row,ri){row.forEach(function(cell,ci){if((cell||'').toString().toLowerCase().includes(kwLower)){var td=document.querySelector('.xs-editable[data-row="'+ri+'"][data-col="'+ci+'"]');if(td)td.classList.add('highlight');}});});}
var findMatches=[],findIdx=0;
function toggleFind(){var p=document.getElementById('findPanel');p.classList.toggle('show');if(p.classList.contains('show')){document.getElementById('findInput').focus();doFind();}else{clearHighlights();}}
function clearHighlights(){document.querySelectorAll('.xs-editable.highlight').forEach(function(td){td.classList.remove('highlight');});findMatches=[];findIdx=0;}
function doFind(){clearHighlights();var kw=(document.getElementById('findInput').value||'').toLowerCase();if(!kw)return;var info=document.getElementById('findInfo');S.data.rows.forEach(function(row,ri){row.forEach(function(cell,ci){if((cell||'').toString().toLowerCase().includes(kw)){var td=document.querySelector('.xs-editable[data-row="'+ri+'"][data-col="'+ci+'"]');if(td){td.classList.add('highlight');findMatches.push(td);}}});});info.textContent=findMatches.length>0?findMatches.length+' 个匹配':'';if(findMatches.length>0){findIdx=0;scrollToMatch(findMatches[0]);}}
function doNext(){if(findMatches.length===0)return;findIdx=(findIdx+1)%findMatches.length;scrollToMatch(findMatches[findIdx]);}
function doPrev(){if(findMatches.length===0)return;findIdx=(findIdx-1+findMatches.length)%findMatches.length;scrollToMatch(findMatches[findIdx]);}
function scrollToMatch(td){td.scrollIntoView({behavior:'smooth',block:'center'});document.querySelectorAll('.xs-editable').forEach(function(t){t.classList.remove('active');});td.classList.add('active');S.cell=td;}
function escHtml(s){if(!s)return'';return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function esc(s){var r='';var sp='.*+?^$()|[]\\\\';for(var i=0;i<s.length;i++){var c=s[i];if(sp.indexOf(c)>=0){r=r+'\\\\'+c;}else{r=r+c;}}return r;}
function doReplace(){var oldVal=(document.getElementById('findInput').value||'');var newVal=(document.getElementById('replaceInput').value||'');if(!oldVal||!S.cell)return;var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);var cell=S.data.rows[ri]&&S.data.rows[ri][ci]||'';var regex=new RegExp(esc(oldVal),'gi');if(regex.test(cell)){regex.lastIndex=0;S.data.rows[ri][ci]=cell.replace(regex,newVal);S.cell.querySelector('.xs-cell-text').textContent=S.data.rows[ri][ci];var k=ri+'-'+ci;S.mods.add(k);S.cell.classList.add('modified');saveHist();updUI();doFind();autoSave();toast('已替换','success');clearHighlights();document.getElementById('findPanel').classList.remove('show');}}
function doReplaceAll(){var oldVal=(document.getElementById('findInput').value||'');var newVal=(document.getElementById('replaceInput').value||'');if(!oldVal)return;var regex=new RegExp(esc(oldVal),'gi');var count=0;S.data.rows.forEach(function(row,ri){row.forEach(function(cell,ci){if(cell&&regex.test(cell)){regex.lastIndex=0;S.data.rows[ri][ci]=cell.replace(regex,newVal);var k=ri+'-'+ci;S.mods.add(k);count++;}});});if(count>0){saveHist();reRender();updUI();autoSave();toast('已替换 '+count+' 处','success');}clearHighlights();document.getElementById('findPanel').classList.remove('show');}
function yamlValue(v){v=String(v||'');if(v.includes(',')||v.includes('"')||v.includes('\\n')||v.includes('\\r')){return'"'+v.replace(/"/g,'""')+'"';}return v;}
function openTextEditor(){var lines=[];if(S.data.headers)lines.push(S.data.headers.map(yamlValue).join(','));S.data.rows.forEach(function(row){lines.push(row.map(yamlValue).join(','));});var csvText=lines.join('\\n');S.vscode.postMessage({type:'openTextEditor',data:csvText});}
function pushTC(){if(S.sel.size===0){toast('请先选择测试案例','error');return;}var data=Array.from(S.sel).map(function(i){var obj={};S.data.headers.forEach(function(h,j){obj[h]=S.data.rows[i]&&S.data.rows[i][j]||'';});return obj;});S.vscode.postMessage({type:'pushTestCase',data:data});toast('推送中...','');}
function reRender(){var container=document.getElementById('tableContainer');if(!container)return;if(S.editing)return;var h=S.data.headers||[];var r=S.data.rows||[];var html='<table class="xs-table"><thead><tr><th class="xs-th xs-th-cb"><input type="checkbox" id="headerCheckbox"></th>';h.forEach(function(ht,i){var sa=S.sCol===i?'data-sort="'+S.sOrder+'"':'';var sw=S.colWidths&&S.colWidths[i]?S.colWidths[i]:(ht.length*9+30);var wStyle=' style="width:'+sw+'px"';var htEsc=escHtml(ht);html=html+'<th class="xs-th" data-col="'+i+'" '+sa+wStyle+'><span class="xs-th-text" title="'+htEsc+'">'+htEsc+'</span><span class="xs-th-filter">▼</span><div class="xs-resizer" data-col="'+i+'"></div></th>';});html=html+'</tr></thead><tbody>';r.forEach(function(row,ri){var savedH=S.rowHeights&&S.rowHeights[ri];var rowStyle=savedH?' style="height:'+savedH+'px"':'';var lines=1;var wrapStyle='';if(savedH){var tmpDiv=document.createElement('div');tmpDiv.className='xs-td';tmpDiv.style.visibility='hidden';tmpDiv.style.position='absolute';tmpDiv.style.width='100px';tmpDiv.textContent='test';document.body.appendChild(tmpDiv);var lineH=tmpDiv.offsetHeight;document.body.removeChild(tmpDiv);lines=Math.max(1,Math.round(savedH/lineH));wrapStyle=' style="white-space:normal;overflow:hidden;text-overflow:ellipsis;word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:'+lines+'"';}html=html+'<tr data-row="'+ri+'"'+rowStyle+'><td class="xs-td xs-td-cb"><input type="checkbox" class="row-cb"></td>';row.forEach(function(cell,ci){var k=ri+'-'+ci;var mod=S.mods.has(k)?' modified':'';var cellEsc=escHtml(cell);html=html+'<td class="xs-td xs-editable'+mod+'" data-row="'+ri+'" data-col="'+ci+'" title="'+cellEsc+'"><div class="xs-cell-wrap"'+wrapStyle+'><span class="xs-cell-text">'+cellEsc+'</span></div></td>';});html=html+'</tr>';});html=html+'</tbody></table>';container.innerHTML=html;bindEv();}
function toast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='xs-toast '+(type||'');t.style.display='block';setTimeout(function(){t.style.display='none';},2000);}
</script>
</body>
</html>`;
    }
}
exports.YamlEditorProvider = YamlEditorProvider;
//# sourceMappingURL=YamlDocumentProvider.js.map