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
exports.BaseEditorProvider = exports.BaseDocumentContentProvider = exports.PREVIEW_SCRIPTS = exports.PREVIEW_STYLES = exports.HttpFetchPushStrategy = exports.buildErrorHtml = exports.isInQualifiedDir = exports.escapeHtml = exports.getNonce = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const table_editor_template_1 = require("../services/table-editor-template");
const utils_1 = require("../services/utils");
Object.defineProperty(exports, "getNonce", { enumerable: true, get: function () { return utils_1.getNonce; } });
Object.defineProperty(exports, "escapeHtml", { enumerable: true, get: function () { return utils_1.escapeHtml; } });
Object.defineProperty(exports, "isInQualifiedDir", { enumerable: true, get: function () { return utils_1.isInQualifiedDir; } });
Object.defineProperty(exports, "buildErrorHtml", { enumerable: true, get: function () { return utils_1.buildErrorHtml; } });
// HTTP Fetch 推送策略（统一使用）
class HttpFetchPushStrategy {
    async push(data, _filePath, webviewPanel) {
        const res = await fetch('http://localhost:8081/test-task/push-testcase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.returnCode === 'SUC0000') {
            webviewPanel.webview.postMessage({ type: 'pushSuccess' });
        }
        else {
            webviewPanel.webview.postMessage({ type: 'pushError', message: result.errorMsg || '推送失败' });
        }
    }
}
exports.HttpFetchPushStrategy = HttpFetchPushStrategy;
// ============================================
// 预览模式公共样式和脚本
// ============================================
exports.PREVIEW_STYLES = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;color:#333;background:#f5f6f8}
.toolbar{margin:-16px -16px 14px;padding:10px 14px;background:#f7f8fa;border:1px solid #e5e9ef;border-radius:6px 6px 0 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.search-box{display:flex;align-items:center;background:#fff;border:1px solid #dde3ea;border-radius:4px;padding:0 8px;height:30px;min-width:180px}
.search-box .ic{color:#999;font-size:13px;margin-right:4px}
.search-box input{border:none;outline:none;background:transparent;font-size:13px;color:#333;width:100%}
.search-count{font-size:11px;color:#888;white-space:nowrap}
.btn{padding:0 14px;height:30px;border:1px solid #dde3ea;border-radius:4px;background:#fff;color:#333;font-size:12.5px;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:#0052d9;color:#0052d9}
.btn.primary{background:#0052d9;color:#fff;border-color:#0052d9}
.btn.primary:hover{background:#003cab}
.result-info{margin-left:auto;font-size:12px;color:#888;white-space:nowrap}
.table-scroll{overflow:auto;border:1px solid #e5e9ef;border-radius:0 0 6px 6px}
table{border-collapse:collapse;width:100%;font-size:12px;min-width:900px}
th,td{padding:7px 12px;text-align:left;border-bottom:1px solid #f0f2f5}
th{white-space:nowrap;background:#f7f8fa;font-weight:600;color:#333;position:sticky;top:0;z-index:1}
tr:hover td{background:#f0f6ff}
tr.selected td{background:#e8f3ff}
tr.hidden{display:none}
tr.search-match td{background:#fffbe6}
td input[type="checkbox"]{cursor:pointer;width:14px;height:14px}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 16px;background:#333;color:#fff;border-radius:6px;font-size:12px;z-index:1000;opacity:0;transition:opacity .2s}
.toast.show{opacity:1}.toast.success{background:#2ba471}.toast.error{background:#e34d59}
.context-menu{position:fixed;background:#fff;border:1px solid #e5e9ef;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:1001;min-width:140px;padding:4px 0}
.context-menu-item{padding:8px 16px;cursor:pointer;font-size:13px;color:#333}.context-menu-item:hover{background:#f0f6ff}
`;
exports.PREVIEW_SCRIPTS = `
let selectedRows=new Set();
if(!window.csvData)window.csvData={headers:[],rows:[]};
var csvData=window.csvData;
function selectAll(){selectedRows=new Set(csvData.rows.map((_,i)=>i));updateUI();}
function deselectAll(){selectedRows.clear();updateUI();}
function updateUI(){
    var visibleRows=document.querySelectorAll("tbody tr:not(.hidden)");
    var visibleIndices=[];
    visibleRows.forEach(r=>{var idx=parseInt(r.getAttribute("data-row"));if(!isNaN(idx))visibleIndices.push(idx);});
    visibleIndices.forEach(i=>{var cb=document.querySelector(".row-checkbox[onclick*='toggleRow("+i+")']");if(cb)cb.checked=selectedRows.has(i);});
    document.querySelectorAll("tbody tr").forEach((r,i)=>{r.classList.toggle("selected",selectedRows.has(i));});
    var headerCb=document.getElementById("headerCheckbox");
    if(headerCb){var checkedCount=visibleIndices.filter(i=>selectedRows.has(i)).length;headerCb.checked=checkedCount>0&&checkedCount===visibleIndices.length;headerCb.indeterminate=checkedCount>0&&checkedCount<visibleIndices.length;}
    document.getElementById("selectedCount").textContent=selectedRows.size;
}
function toggleRow(i){selectedRows.has(i)?selectedRows.delete(i):selectedRows.add(i);updateUI();}
function showToast(m,t){const toast=document.getElementById("toast");toast.textContent=m;toast.className="toast show "+(t||"");setTimeout(()=>toast.classList.remove("show"),3000);}
function toggleAll(cb){if(cb.checked){selectedRows=new Set(csvData.rows.map((_,i)=>i));}else{selectedRows.clear();}updateUI();}
function doSearch(keyword){
    const rows=document.querySelectorAll("tbody tr");
    let matchCount=0;
    keyword=keyword.toLowerCase();
    rows.forEach((row,i)=>{
        if(!keyword){row.classList.remove("hidden","search-match");matchCount++;}
        else{const text=row.textContent||"";if(text.toLowerCase().includes(keyword)){row.classList.remove("hidden");row.classList.add("search-match");matchCount++;}else{row.classList.add("hidden");row.classList.remove("search-match");}}
    });
    document.getElementById("searchCount").textContent=keyword?"匹配 "+matchCount+" 行":"";
}
var ctxMenu=null;
function showCtxMenu(e,rowIdx){e.preventDefault();hideCtxMenu();selectedRows.add(rowIdx);updateUI();ctxMenu=document.createElement("div");ctxMenu.className="context-menu";ctxMenu.innerHTML='<div class="context-menu-item" onclick="pushTestCase()">推送测试案例</div>';ctxMenu.style.left=e.clientX+"px";ctxMenu.style.top=e.clientY+"px";document.body.appendChild(ctxMenu);document.addEventListener("click",hideCtxMenu);}
function hideCtxMenu(){if(ctxMenu){ctxMenu.remove();ctxMenu=null;}document.removeEventListener("click",hideCtxMenu);}
async function pushTestCase(){if(selectedRows.size===0){showToast("请先勾选要推送的测试案例","error");return;}var data=Array.from(selectedRows).map(i=>{var obj={};csvData.headers.forEach((h,j)=>{obj[h]=csvData.rows[i][j]||"";});return obj;});try{const res=await fetch("http://localhost:8081/test-task/push-testcase",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const result=await res.json();if(result.returnCode==="SUC0000"){showToast("推送成功","success");}else{showToast(result.errorMsg||"推送失败","error");}}catch(e){showToast("推送失败: "+e.message,"error");}}
`;
// ============================================
// 预览模式基础类
// ============================================
class BaseDocumentContentProvider {
    constructor() {
        this.onDidChangeEmitter = new vscode.EventEmitter();
        this.dataCache = new Map();
    }
    get onDidChange() {
        return this.onDidChangeEmitter.event;
    }
    provideTextDocumentContent(uri) {
        const nonce = (0, utils_1.getNonce)();
        const filePath = this.getFilePath(uri);
        let content = '<div style="padding:40px;text-align:center;color:#888;">加载中...</div>';
        try {
            if (fs.existsSync(filePath)) {
                const data = this.parseData(filePath);
                if (data.headers.length > 0 || data.rows.length > 0) {
                    this.dataCache.set(filePath, data);
                    content = this.buildTableHtml(data.headers, data.rows);
                }
                else {
                    content = '<div style="padding:40px;text-align:center;color:#e34d59;">文件为空</div>';
                }
            }
            else {
                content = '<div style="padding:40px;text-align:center;color:#e34d59;">文件不存在</div>';
            }
        }
        catch (e) {
            content = '<div style="padding:40px;text-align:center;color:#e34d59;">读取失败: ' + (0, utils_1.escapeHtml)(e.message) + '</div>';
        }
        return this.getHtmlWrapper(content, nonce);
    }
    /** 获取表格HTML */
    buildTableHtml(headers, rows) {
        let html = '<table><thead><tr><th style="width:40px;text-align:center"><input type="checkbox" id="headerCheckbox" onclick="toggleAll(this)"></th>';
        headers.forEach(h => html += '<th>' + (0, utils_1.escapeHtml)(h) + '</th>');
        html += '</tr></thead><tbody>';
        rows.forEach((row, i) => {
            html += '<tr data-row="' + i + '" oncontextmenu="showCtxMenu(event,' + i + ')"><td style="text-align:center"><input type="checkbox" class="row-checkbox" onclick="toggleRow(' + i + ')"></td>';
            row.forEach(cell => html += '<td>' + (0, utils_1.escapeHtml)(cell) + '</td>');
            html += '</tr>';
        });
        html += '</tbody></table>';
        const jsonData = JSON.stringify({ headers, rows }).replace(/<\/script>/gi, '<\\/script>');
        html += '<script nonce="' + (0, utils_1.getNonce)() + '">window.csvData=' + jsonData + ';Object.assign(csvData,window.csvData);</script>';
        return html;
    }
    /** 获取HTML包装器 */
    getHtmlWrapper(content, nonce) {
        return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + exports.PREVIEW_STYLES + '</style></head><body>' +
            '<div class="toolbar">' +
            '<div class="search-box"><span class="ic">&#128269;</span><input type="text" id="searchInput" placeholder="搜索..." oninput="doSearch(this.value)"><span class="search-count" id="searchCount"></span></div>' +
            '<button class="btn primary" onclick="pushTestCase()">推送测试案例</button>' +
            '<span class="result-info">已选择 <strong id="selectedCount">0</strong> 行</span>' +
            '</div><div class="table-scroll">' + content + '</div>' +
            '<div class="toast" id="toast"></div>' +
            '<script nonce="' + nonce + '">' + exports.PREVIEW_SCRIPTS + '</script></body></html>';
    }
}
exports.BaseDocumentContentProvider = BaseDocumentContentProvider;
// ============================================
// 基础编辑器Provider
// ============================================
class BaseEditorProvider {
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
        const nonce = (0, utils_1.getNonce)();
        const fileName = filePath.split(path.sep).pop() || this.getTypeName();
        webviewPanel.title = fileName + ' - 测试案例编辑器';
        webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        // 检查文件是否合格
        if (!this.isQualifiedFile(document.uri)) {
            webviewPanel.webview.html = (0, utils_1.buildErrorHtml)(this.getErrorMessage());
            return;
        }
        // 设置HTML内容
        webviewPanel.webview.html = (0, table_editor_template_1.buildTableEditorHtml)({
            nonce,
            dataType: this.getDataType(),
            onSave: 'autoSave',
            onOpenTextEditor: 'openTextEditor'
        });
        // 处理来自webview的消息
        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type === 'init') {
                const freshData = this.parseData(filePath);
                const dataStr = JSON.stringify(freshData);
                const encoder = new TextEncoder();
                const uint8Array = encoder.encode(dataStr);
                webviewPanel.webview.postMessage({ type: this.getDataType() + 'Data', data: Array.from(uint8Array) });
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
                console.log(`[${this.getTypeName()}推送] 收到推送请求`);
                try {
                    await this.pushStrategy.push(msg.data, filePath, webviewPanel, this.context);
                }
                catch (err) {
                    console.error(`[${this.getTypeName()}推送] 异常:`, err);
                    webviewPanel.webview.postMessage({ type: 'pushError', message: err?.message || '推送失败' });
                }
            }
            if (msg?.type === 'openTextEditor') {
                await vscode.commands.executeCommand(this.getOpenCommand(), filePath);
            }
        });
    }
    // ==================== 接口方法（默认实现） ====================
    saveCustomDocument(_document, _cancellation) {
        return Promise.resolve();
    }
    saveCustomDocumentAs(_document, _destination, _cancellation) {
        return Promise.resolve();
    }
    revertCustomDocument(_document, _cancellation) {
        return Promise.resolve();
    }
    backupCustomDocument(_document, context, _cancellation) {
        return Promise.resolve({ id: context.destination.toString(), delete: () => { } });
    }
}
exports.BaseEditorProvider = BaseEditorProvider;
//# sourceMappingURL=BaseEditorProvider.js.map