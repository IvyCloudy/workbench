import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// 检测分隔符
function detectDelimiter(line: string): string {
    const delimiters = [',', ';', '\t', '|'];
    const counts = delimiters.map(d => ({ delim: d, count: (line.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length }));
    // 优先返回计数最高的分隔符，最少需要2个
    const best = counts.filter(c => c.count >= 2).sort((a, b) => b.count - a.count)[0];
    return best ? best.delim : ',';
}

// 解析CSV行，支持多种分隔符
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

// 解析CSV内容，自动检测分隔符
function parseCsvContent(content: string): { headers: string[], rows: string[][] } | null {
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length === 0) return null;

    const delimiter = detectDelimiter(lines[0]);
    const headers = parseCsvLine(lines[0], delimiter);
    const rows = lines.slice(1).map(line => parseCsvLine(line, delimiter));

    return { headers, rows };
}

// HTML转义
function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 检查CSV文件是否满足目录要求
// 正确结构：测试任务/测试任务名称_子任务名称/测试案例/*.csv
export function isQualifiedCsvFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !/\.csv$/i.test(uri.fsPath)) {
        return false;
    }
    const parts = uri.fsPath.split(path.sep);
    const len = parts.length;
    if (len < 4) return false;
    const dirNames = parts.map(p => path.basename(p));
    const caseDir = dirNames[len - 2];
    const taskDir = dirNames[len - 3];
    const rootDir = dirNames[len - 4];

    return (rootDir === '测试任务' || rootDir === 'testtask') &&
           (caseDir === '测试案例' || caseDir === 'testcase') &&
           /\.csv$/i.test(dirNames[len - 1]);
}

// CSV文档内容提供者
export class CsvDocumentContentProvider implements vscode.TextDocumentContentProvider {
    private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    private csvDataCache: Map<string, { headers: string[], rows: string[][] }> = new Map();

    get onDidChange(): vscode.Event<vscode.Uri> {
        return this.onDidChangeEmitter.event;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const nonce = getNonce();
        const filePath = uri.fsPath.replace(/^csv-preview:/, '');

        let html = '<div style="padding:40px;text-align:center;color:#888;">加载中...</div>';

        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n').filter(line => line.trim());

                if (lines.length > 0) {
                    const data = parseCsvContent(content);
                    if (data) {
                        this.csvDataCache.set(filePath, data);
                        html = this.buildCsvHtml(data.headers, data.rows, nonce);
                    } else {
                        html = '<div style="padding:40px;text-align:center;color:#e34d59;">CSV解析失败</div>';
                    }
                } else {
                    html = '<div style="padding:40px;text-align:center;color:#e34d59;">CSV文件为空</div>';
                }
            } else {
                html = '<div style="padding:40px;text-align:center;color:#e34d59;">文件不存在</div>';
            }
        } catch (e: any) {
            html = '<div style="padding:40px;text-align:center;color:#e34d59;">读取失败: ' + escapeHtml(e.message) + '</div>';
        }

        return this.getHtmlWrapper(html, nonce);
    }

    private getHtmlWrapper(content: string, nonce: string): string {
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
            'let selectedRows=new Set();if(!window.csvData)window.csvData={headers:[],rows:[]};' +
            'var csvData=window.csvData;' +
            'function selectAll(){selectedRows=new Set(csvData.rows.map((_,i)=>i));updateUI();}' +
            'function deselectAll(){selectedRows.clear();updateUI();}' +
            'function updateUI(){var visibleRows=document.querySelectorAll("tbody tr:not(.hidden)");var visibleIndices=[];visibleRows.forEach(r=>{var idx=parseInt(r.getAttribute("data-row"));if(!isNaN(idx))visibleIndices.push(idx);});visibleIndices.forEach(i=>{var cb=document.querySelector(".row-checkbox[onclick*=\'toggleRow("+i+")\']");if(cb)cb.checked=selectedRows.has(i);});document.querySelectorAll("tbody tr").forEach((r,i)=>{r.classList.toggle("selected",selectedRows.has(i));});var headerCb=document.getElementById("headerCheckbox");if(headerCb){var checkedCount=visibleIndices.filter(i=>selectedRows.has(i)).length;headerCb.checked=checkedCount>0&&checkedCount===visibleIndices.length;headerCb.indeterminate=checkedCount>0&&checkedCount<visibleIndices.length;}document.getElementById("selectedCount").textContent=selectedRows.size;}' +
            'function toggleRow(i){selectedRows.has(i)?selectedRows.delete(i):selectedRows.add(i);updateUI();}' +
            'function showToast(m,t){const toast=document.getElementById("toast");toast.textContent=m;toast.className="toast show "+(t||"");setTimeout(()=>toast.classList.remove("show"),3000);}' +
            'function toggleAll(cb){if(cb.checked){selectedRows=new Set(csvData.rows.map((_,i)=>i));}else{selectedRows.clear();}updateUI();}' +
            'function doSearch(keyword){const rows=document.querySelectorAll("tbody tr");let matchCount=0;keyword=keyword.toLowerCase();rows.forEach((row,i)=>{if(!keyword){row.classList.remove("hidden","search-match");matchCount++;}else{const text=row.textContent||"";if(text.toLowerCase().includes(keyword)){row.classList.remove("hidden");row.classList.add("search-match");matchCount++;}else{row.classList.add("hidden");row.classList.remove("search-match");}}});document.getElementById("searchCount").textContent=keyword?"匹配 "+matchCount+" 行":"";}' +
            'var ctxMenu=null;function showCtxMenu(e,rowIdx){e.preventDefault();hideCtxMenu();selectedRows.add(rowIdx);updateUI();ctxMenu=document.createElement("div");ctxMenu.className="context-menu";ctxMenu.innerHTML=\'<div class="context-menu-item" onclick="pushTestCase()">推送测试案例</div>\';ctxMenu.style.left=e.clientX+"px";ctxMenu.style.top=e.clientY+"px";document.body.appendChild(ctxMenu);document.addEventListener("click",hideCtxMenu);}function hideCtxMenu(){if(ctxMenu){ctxMenu.remove();ctxMenu=null;}document.removeEventListener("click",hideCtxMenu);}' +
            'async function pushTestCase(){if(selectedRows.size===0){showToast("请先勾选要推送的测试案例","error");return;}var data=Array.from(selectedRows).map(i=>{var obj={};csvData.headers.forEach((h,j)=>{obj[h]=csvData.rows[i][j]||"";});return obj;});try{const res=await fetch("http://localhost:8081/test-task/push-testcase",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const result=await res.json();if(result.returnCode==="SUC0000"){showToast("推送成功","success");}else{showToast(result.errorMsg||"推送失败","error");}}catch(e){showToast("推送失败: "+e.message,"error");}}' +
            '</script></body></html>';
    }

    private buildCsvHtml(headers: string[], rows: string[][], nonce: string): string {
        let html = '<table><thead><tr><th style="width:40px;text-align:center"><input type="checkbox" id="headerCheckbox" onclick="toggleAll(this)"></th>';
        headers.forEach(h => html += '<th>' + escapeHtml(h) + '</th>');
        html += '</tr></thead><tbody>';

        rows.forEach((row, i) => {
            html += '<tr data-row="'+i+'" oncontextmenu="showCtxMenu(event,'+i+')"><td style="text-align:center"><input type="checkbox" class="row-checkbox" onclick="toggleRow(' + i + ')"></td>';
            row.forEach(cell => html += '<td>' + escapeHtml(cell) + '</td>');
            html += '</tr>';
        });

        html += '</tbody></table>';
        // 转义 </script> 防止破坏 HTML 解析
        const jsonData = JSON.stringify({ headers, rows }).replace(/<\/script>/gi, '<\\/script>');
        html += '<script nonce="' + nonce + '">window.csvData=' + jsonData + ';Object.assign(csvData,window.csvData);</script>';
        return html;
    }
}
