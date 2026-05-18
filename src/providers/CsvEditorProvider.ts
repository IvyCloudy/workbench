import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function detectDelimiter(line: string): string {
    const delimiters = [',', ';', '\t', '|'];
    const counts = delimiters.map(d => ({ delim: d, count: (line.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length }));
    const best = counts.filter(c => c.count >= 2).sort((a, b) => b.count - a.count)[0];
    return best ? best.delim : ',';
}

function parseCsvLine(line: string, delimiter: string = ','): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === delimiter && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

// 检查CSV文件是否满足目录要求
// 正确结构：测试任务/测试任务名称_子任务名称/测试案例/*.csv
function isQualifiedCsvFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !/\.csv$/i.test(uri.fsPath)) {
        return false;
    }
    const parts = uri.fsPath.split(path.sep);
    const len = parts.length;
    // 需要至少4层：测试任务/xxx_yyy/测试案例/xxx.csv
    if (len < 4) return false;
    const dirNames = parts.map(p => path.basename(p));
    const csvFileName = dirNames[len - 1];  // xxx.csv
    const caseDir = dirNames[len - 2];       // 测试案例
    const taskDir = dirNames[len - 3];       // 测试任务名称_子任务名称
    const rootDir = dirNames[len - 4];      // 测试任务

    // 检查：根目录=测试任务，倒数第二层=测试案例，文件名包含csv
    return (rootDir === '测试任务' || rootDir === 'testtask') &&
           (caseDir === '测试案例' || caseDir === 'testcase') &&
           /\.csv$/i.test(csvFileName);
}

export class CsvEditorProvider implements vscode.CustomEditorProvider {
    private onDidChangeCustomDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();

    constructor(private extensionUri: vscode.Uri) {}

    get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentEditEvent<vscode.CustomDocument>> {
        return this.onDidChangeCustomDocumentEmitter.event;
    }

    async openCustomDocument(uri: vscode.Uri, _openContext: { backupId?: string }, _token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
        return {
            uri: uri,
            dispose: () => {}
        } as vscode.CustomDocument;
    }

    async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
        const filePath = document.uri.fsPath;
        const nonce = getNonce();

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        // 检查是否满足目录要求
        if (!isQualifiedCsvFile(document.uri)) {
            webviewPanel.webview.html = this.getErrorHtml('该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.csv');
            return;
        }

        webviewPanel.webview.html = this.getHtmlContent(filePath, nonce);
    }

    private getErrorHtml(message: string): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}
            .msg{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
            .msg h3{color:#e34d59;margin:0 0 12px}
            .msg p{color:#666;font-size:14px;margin:0}
        </style></head><body><div class="msg"><h3>不支持的文件位置</h3><p>${message}</p></div></body></html>`;
    }

    saveCustomDocument(_document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        return Promise.resolve();
    }

    saveCustomDocumentAs(_document: vscode.CustomDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        return Promise.resolve();
    }

    revertCustomDocument(_document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        return Promise.resolve();
    }

    backupCustomDocument(_document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return Promise.resolve({
            id: context.destination.toString(),
            delete: () => {}
        });
    }

    private getHtmlContent(filePath: string, nonce: string): string {
        let html = '<div style="padding:40px;text-align:center;color:#888;">加载中...</div>';
        let csvData: { headers: string[], rows: string[][] } = { headers: [], rows: [] };

        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n').filter(line => line.trim());

                if (lines.length > 0) {
                    const delimiter = detectDelimiter(lines[0]);
                    const headers = parseCsvLine(lines[0], delimiter);
                    const rows = lines.slice(1).map(line => parseCsvLine(line, delimiter));
                    csvData = { headers, rows };
                    html = this.buildCsvHtml(headers, rows);
                } else {
                    html = '<div style="padding:40px;text-align:center;color:#e34d59;">CSV文件为空</div>';
                }
            } else {
                html = '<div style="padding:40px;text-align:center;color:#e34d59;">文件不存在</div>';
            }
        } catch (e: any) {
            html = '<div style="padding:40px;text-align:center;color:#e34d59;">读取失败: ' + escapeHtml(e.message) + '</div>';
        }

        return this.getHtmlWrapper(html, csvData, nonce);
    }

    private buildCsvHtml(headers: string[], rows: string[][]): string {
        let html = '<table class="data-table"><thead><tr><th class="checkbox"><input type="checkbox" id="headerCheckbox" onclick="toggleAll(this)"></th>';
        headers.forEach((h, colIdx) => html += '<th>' + escapeHtml(h) + '</th>');
        html += '</tr></thead><tbody>';

        rows.forEach((row, rowIdx) => {
            html += '<tr data-row="'+rowIdx+'" oncontextmenu="showCtxMenu(event,'+rowIdx+')"><td class="checkbox"><input type="checkbox" class="row-checkbox" onclick="toggleRow(' + rowIdx + ')"></td>';
            row.forEach((cell, colIdx) => {
                html += '<td class="editable-cell" data-row="'+rowIdx+'" data-col="'+colIdx+'" ondblclick="startEdit(this)">' + escapeHtml(cell) + '</td>';
            });
            html += '</tr>';
        });

        html += '</tbody></table>';
        html += '<script nonce="NONCE_PLACEHOLDER">window.csvData=' + JSON.stringify({ headers, rows }) + ';Object.assign(csvData,window.csvData);</script>';
        return html;
    }

    private getHtmlWrapper(content: string, csvData: { headers: string[], rows: string[][] }, nonce: string): string {
        const htmlWithNonce = content.replace('NONCE_PLACEHOLDER', nonce);
        return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
            '*{margin:0;padding:0;box-sizing:border-box}' +
            'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;color:var(--vscode-editor-foreground,#1a1a1a);background:var(--vscode-editor-background,#fff);height:100vh;display:flex;flex-direction:column}' +
            '.toolbar{padding:10px 14px;border-bottom:1px solid #e5e9ef;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:#fff}' +
            '.toolbar-left{display:flex;align-items:center;gap:8px}' +
            '.toolbar-title{font-size:13px;font-weight:600;color:#1a1a1a}' +
            '.toolbar-right{display:flex;align-items:center;gap:10px}' +
            '.search-box{display:flex;align-items:center;background:#f5f5f5;border:1px solid transparent;border-radius:4px;padding:0 8px;height:28px;min-width:160px}' +
            '.search-box:focus-within{background:#fff;border-color:#0052d9}' +
            '.search-box .ic{color:#999;font-size:12px}' +
            '.search-box input{border:none;outline:none;background:transparent;font-size:12px;color:#333;width:100%}' +
            '.btn{padding:5px 12px;font-size:12px;border-radius:4px;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:4px;border:1px solid transparent}' +
            '.btn-primary{background:#0052d9;color:#fff}.btn-primary:hover{background:#0041b3}' +
            '.btn-secondary{background:#fff;color:#555;border-color:#dde3ea}.btn-secondary:hover{border-color:#0052d9;color:#0052d9}' +
            '.btn:disabled{opacity:0.5;cursor:not-allowed}' +
            '.selected-info{font-size:11.5px;color:#888}' +
            '.selected-info strong{color:#0052d9}' +
            '.modified-info{font-size:11.5px;color:#e37318;margin-left:8px}' +
            '.modified-info strong{color:#e34d59}' +
            '.table-container{flex:1;overflow:auto}' +
            '.data-table{width:100%;border-collapse:collapse;font-size:12px}' +
            '.data-table th,.data-table td{padding:7px 12px;text-align:left;border-bottom:1px solid #f0f2f5;white-space:nowrap}' +
            '.data-table th{background:#fafbfc;font-weight:600;color:#555;position:sticky;top:0;z-index:1}' +
            '.data-table th .checkbox{text-align:center;width:30px}' +
            '.data-table td{max-width:250px;overflow:hidden;text-overflow:ellipsis}' +
            '.data-table td.editable-cell{cursor:text}.data-table td.editable-cell:hover{background:#f0f6ff}' +
            '.data-table td.editing{overflow:visible}' +
            '.data-table td.modified{background:#fff3e0}.data-table td.modified::after{content:"";display:inline-block;width:6px;height:6px;background:#e37318;border-radius:50%;margin-left:4px}' +
            '.edit-input{width:100%;border:2px solid #0052d9;padding:4px 6px;font-size:12px;outline:none;background:#fff;margin:-8px -12px;padding:6px 8px;box-sizing:border-box}' +
            '.data-table tr:hover{background:#fafbfc}' +
            '.data-table tr.selected{background:#e8f3ff}' +
            '.data-table tr.hidden{display:none}' +
            '.data-table tr.search-match{background:#fffbe6}' +
            '.data-table .checkbox{width:30px;text-align:center}' +
            '.data-table .checkbox input{width:14px;height:14px;cursor:pointer}' +
            '.toast{position:fixed;bottom:20px;right:20px;padding:10px 16px;background:#333;color:#fff;border-radius:6px;font-size:12px;z-index:1000;opacity:0;transition:opacity .2s}' +
            '.toast.show{opacity:1}.toast.success{background:#2ba471}.toast.error{background:#e34d59}' +
            '.context-menu{position:fixed;background:#fff;border:1px solid #e5e9ef;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:1001;min-width:140px;padding:4px 0}' +
            '.context-menu-item{padding:8px 16px;cursor:pointer;font-size:13px;color:#333}.context-menu-item:hover{background:#f0f6ff}' +
            '.search-count{font-size:11px;color:#888;margin-left:8px}' +
            '</style></head><body>' +
            '<div class="toolbar">' +
            '<div class="toolbar-left">' +
            '<span class="toolbar-title">CSV数据</span>' +
            '<span class="modified-info" id="modifiedInfo" style="display:none">已修改 <strong id="modifiedCount">0</strong> 处</span>' +
            '</div>' +
            '<div class="toolbar-right">' +
            '<div class="search-box"><span class="ic">&#128269;</span><input type="text" id="searchInput" placeholder="搜索..." oninput="doSearch(this.value)"><span class="search-count" id="searchCount"></span></div>' +
            '<button class="btn btn-primary" id="pushBtn" onclick="pushTestCase()">推送测试案例</button>' +
            '<span class="selected-info">已选择 <strong id="selectedCount">0</strong> / <strong id="totalCount">0</strong></span>' +
            '</div>' +
            '</div>' +
            '<div class="table-container">' + htmlWithNonce + '</div>' +
            '<div class="toast" id="toast"></div>' +
            '<script nonce="' + nonce + '">' +
            'let selectedRows=new Set();let modifiedCells=new Set();if(!window.csvData)window.csvData={headers:[],rows:[]};' +
            'var csvData=window.csvData;' +
            'function updateInfo(){document.getElementById("totalCount").textContent=csvData.rows.length;}' +
            'function updateModified(){var count=modifiedCells.size;var el=document.getElementById("modifiedInfo");if(el)el.style.display=count>0?"inline":"none";var cnt=document.getElementById("modifiedCount");if(cnt)cnt.textContent=count;}' +
            'function updateUI(){var visibleRows=document.querySelectorAll("tbody tr:not(.hidden)");var visibleIndices=[];visibleRows.forEach(r=>{var idx=parseInt(r.getAttribute("data-row"));if(!isNaN(idx))visibleIndices.push(idx);});visibleIndices.forEach(i=>{var cb=document.querySelector("tr[data-row=\'"+i+"\'] .row-checkbox");if(cb)cb.checked=selectedRows.has(i);});document.querySelectorAll("tbody tr").forEach((r,i)=>{r.classList.toggle("selected",selectedRows.has(i));});var headerCb=document.getElementById("headerCheckbox");if(headerCb){var checkedCount=visibleIndices.filter(i=>selectedRows.has(i)).length;headerCb.checked=checkedCount>0&&checkedCount===visibleIndices.length;headerCb.indeterminate=checkedCount>0&&checkedCount<visibleIndices.length;}document.getElementById("selectedCount").textContent=selectedRows.size;document.getElementById("pushBtn").disabled=selectedRows.size===0;}' +
            'function toggleRow(i){selectedRows.has(i)?selectedRows.delete(i):selectedRows.add(i);updateUI();}' +
            'function selectAll(){selectedRows=new Set(csvData.rows.map((_,i)=>i));updateUI();}' +
            'function selectNone(){selectedRows.clear();updateUI();}' +
            'function showToast(m,t){const toast=document.getElementById("toast");toast.textContent=m;toast.className="toast show "+(t||"");setTimeout(()=>toast.classList.remove("show"),3000);}' +
            'function toggleAll(cb){if(cb.checked){selectAll();}else{selectNone();}}' +
            'function doSearch(keyword){const rows=document.querySelectorAll("tbody tr");let matchCount=0;keyword=keyword.toLowerCase();rows.forEach((row,i)=>{if(!keyword){row.classList.remove("hidden","search-match");matchCount++;}else{const text=row.textContent||"";if(text.toLowerCase().includes(keyword)){row.classList.remove("hidden");row.classList.add("search-match");matchCount++;}else{row.classList.add("hidden");row.classList.remove("search-match");}}});document.getElementById("searchCount").textContent=keyword?"匹配 "+matchCount+" 行":"";updateUI();}' +
            'var ctxMenu=null;function showCtxMenu(e,rowIdx){e.preventDefault();hideCtxMenu();selectedRows.add(rowIdx);updateUI();ctxMenu=document.createElement("div");ctxMenu.className="context-menu";ctxMenu.innerHTML=\'<div class="context-menu-item" onclick="pushTestCase()">推送测试案例</div>\';ctxMenu.style.left=e.clientX+"px";ctxMenu.style.top=e.clientY+"px";document.body.appendChild(ctxMenu);document.addEventListener("click",hideCtxMenu);}function hideCtxMenu(){if(ctxMenu){ctxMenu.remove();ctxMenu=null;}document.removeEventListener("click",hideCtxMenu);}' +
            "function startEdit(td){if(td.querySelector('input'))return;var rowIdx=parseInt(td.dataset.row);var colIdx=parseInt(td.dataset.col);var original=csvData.rows[rowIdx][colIdx];var input=document.createElement('input');input.type='text';input.className='edit-input';input.value=original;td.classList.add('editing');td.innerHTML='';td.appendChild(input);input.focus();input.select();input.onblur=function(){finishEdit(td,rowIdx,colIdx,original);};input.onkeydown=function(e){if(e.key==='Enter'){input.blur();}else if(e.key==='Escape'){td.innerHTML=original.replace(/</g,'&lt;').replace(/>/g,'&gt;');td.classList.remove('editing');}};}function finishEdit(td,rowIdx,colIdx,original){var val=td.querySelector('input').value;td.classList.remove('editing');td.textContent=val;if(val!==original){csvData.rows[rowIdx][colIdx]=val;var key=rowIdx+'-'+colIdx;if(!modifiedCells.has(key)){modifiedCells.add(key);td.classList.add('modified');}updateModified();}else{td.classList.remove('modified');modifiedCells.delete(rowIdx+'-'+colIdx);updateModified();}}" +
            'async function pushTestCase(){if(selectedRows.size===0){showToast("请先勾选要推送的测试案例","error");return;}var data=Array.from(selectedRows).map(i=>{var obj={};csvData.headers.forEach((h,j)=>{obj[h]=csvData.rows[i][j]||"";});return obj;});try{const res=await fetch("http://localhost:8081/test-task/push-testcase",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const result=await res.json();if(result.returnCode==="SUC0000"){showToast("推送成功","success");}else{showToast(result.errorMsg||"推送失败","error");}}catch(e){showToast("推送失败: "+e.message,"error");}}' +
            'updateInfo();updateModified();updateUI();' +
            '</script></body></html>';
    }
}
