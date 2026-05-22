// 共享的表格编辑器 HTML 模板
// 供 YAML、JSON 等编辑器使用

export interface EditorConfig {
    nonce: string;
    dataType: 'yaml' | 'json' | 'csv';  // 消息类型
    onSave: string;  // 保存回调函数名
    onOpenTextEditor: string;  // 打开文本编辑器函数名
}

// 生成表格编辑器 HTML
export function buildTableEditorHtml(config: EditorConfig): string {
    const { nonce, dataType, onSave, onOpenTextEditor } = config;
    const msgType = `${dataType}Data`;
    
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
/* 明细弹窗 */
.xs-modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:2000;align-items:center;justify-content:center}
.xs-modal-overlay.show{display:flex}
.xs-modal-dialog{background:var(--bg);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.2);width:88vw;max-width:1200px;max-height:82vh;display:flex;flex-direction:column;overflow:hidden}
.xs-modal-header{display:flex;align-items:center;padding:10px 16px;background:#f5f5f5;border-bottom:1px solid var(--bd);flex-shrink:0}
.xs-modal-title{font-size:14px;font-weight:600;flex:1}
.xs-modal-close{cursor:pointer;font-size:16px;color:#666;padding:4px 10px;border-radius:3px;line-height:1;border:none;background:transparent}
.xs-modal-close:hover{background:#e0e0e0;color:#333}
.xs-modal-body{flex:1;overflow:auto;padding:8px 0;min-height:120px}
.xs-modal-footer{display:flex;align-items:center;justify-content:flex-end;padding:8px 16px;border-top:1px solid var(--bd);gap:8px;flex-shrink:0}
.xs-detail-table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:12px}
.xs-detail-table th{background:#f0f4ff;border:1px solid #d0d7e2;padding:6px 10px;position:sticky;top:0;z-index:2;font-weight:500;text-align:left;white-space:nowrap}
.xs-detail-table td{border:1px solid #d0d7e2;padding:5px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xs-detail-table td.xs-editable{cursor:cell}
.xs-detail-table td.xs-editable.active{outline:2px solid var(--p);outline-offset:-2px}
.xs-detail-table td.xs-editable.modified{background:#fffbe6}
.xs-detail-table tbody tr:hover{background:#f0f4ff}
.xs-detail-table td input{width:100%;border:none;outline:none;padding:0;margin:0;font:inherit;background:transparent}
.xs-detail-link{color:var(--p);cursor:pointer;text-decoration:underline;font-weight:500}
.xs-detail-link:hover{color:#005a9e}
.xs-detail-row-cb{width:28px;text-align:center}
.xs-detail-row-cb input{width:14px;height:14px;cursor:pointer}
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
    <div class="xs-modal-overlay" id="detailModal">
        <div class="xs-modal-dialog">
            <div class="xs-modal-header">
                <span class="xs-modal-title" id="detailModalTitle">步骤明细</span>
                <button class="xs-modal-close" id="detailModalClose" title="关闭">✕</button>
            </div>
            <div class="xs-modal-body" id="detailModalBody"></div>
            <div class="xs-modal-footer">
                <span id="detailModInfo" style="display:none;font-size:11px;color:var(--d);flex:1">明细已修改</span>
                <button class="xs-btn" id="detailInsertBtn" title="在当前行前插入行">插入行</button>
                <button class="xs-btn" id="detailAddBtn" title="在末尾添加新行">添加行</button>
                <button class="xs-btn" id="detailCancelBtn">取消</button>
                <button class="xs-btn xs-btn-p" id="detailSaveBtn">保存</button>
            </div>
        </div>
    </div>
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
var S={data:{},sel:new Set(),cell:null,clip:null,mods:new Set(),hist:[],hIdx:-1,sCol:null,sOrder:'asc',colWidths:{},vscode:null,editing:false,detailTable:null,detailRow:0,detailMods:new Set(),detailCell:null,detailEditing:false,_bound:false,_docBound:false,_detailSnap:null};
function init(){S.vscode=acquireVsCodeApi();S.vscode.postMessage({type:'init'});}
window.addEventListener('focus',function(){if(S.vscode)S.vscode.postMessage({type:'init'});});
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
window.addEventListener('message',function(e){var msg=e.data;
if(msg.type==='${msgType}'){try{var decoder=new TextDecoder('utf-8');var uint8Array=new Uint8Array(msg.data);var decoded=decoder.decode(uint8Array);S.data=JSON.parse(decoded);S.detailTable=S.data.detailTable||null;S.detailRow=0;S.detailMods=new Set();S.detailCell=null;}catch(ex){S.data={headers:[],rows:[]};S.detailTable=null;}S.sel.clear();S.cell=null;S.clip=null;S.mods.clear();S.hist=[];S.hIdx=-1;cancelEdit();S.editing=false;S.detailEditing=false;saveHist();S._bound=false;updUI();reRender();closeDetailModal();var loading=document.getElementById('loading');if(loading)loading.style.display='none';}
if(msg.type==='saved'){S.mods.clear();document.querySelectorAll('.xs-editable.modified').forEach(function(td){td.classList.remove('modified');});updUI();}
if(msg.type==='saveError'){toast('保存失败: '+msg.message,'error');}
if(msg.type==='pushSuccess'){toast('推送成功','success');}
if(msg.type==='pushError'){toast('推送失败: '+msg.message,'error');}
});
function saveHist(){var snap=JSON.stringify(S.data);if(S.hIdx<S.hist.length-1)S.hist=S.hist.slice(0,S.hIdx+1);S.hist.push(snap);S.hIdx=S.hist.length-1;if(S.hist.length>50){S.hist.shift();S.hIdx--;}}
function undo(){if(S.hIdx>0){S.hIdx--;S.data=JSON.parse(S.hist[S.hIdx]);reRender();updUI();toast('撤销成功','success');}else{toast('无法撤销','error');}}
function redo(){if(S.hIdx<S.hist.length-1){S.hIdx++;S.data=JSON.parse(S.hist[S.hIdx]);reRender();updUI();toast('重做成功','success');}else{toast('无法重做','error');}}
function bindEv(){if(S._bound)return;S._bound=true;var hcb=document.getElementById('headerCheckbox');if(hcb)hcb.addEventListener('change',function(){this.checked?selAll():deselAll();});var tbl=document.querySelector('.xs-table');if(tbl)tbl.addEventListener('contextmenu',function(e){e.preventDefault();document.getElementById('ctxMenu').style.display='none';document.getElementById('sortFilter').style.display='none';var td=e.target.closest('td');if(td&&td.classList.contains('xs-editable')){S.cell=td;updCellSel();}showCtx(e.clientX,e.clientY);});if(!S._docBound){S._docBound=true;document.addEventListener('mousedown',function(e){var isMenuClick=e.target.closest('.xs-cm')||e.target.closest('.xs-sf')||e.target.closest('.xs-find');if(!isMenuClick){document.getElementById('ctxMenu').style.display='none';document.getElementById('sortFilter').style.display='none';document.getElementById('findPanel').classList.remove('show');}});document.addEventListener('click',function(e){var mb=e.target.closest('#detailModalClose');if(mb){closeDetailModal();return;}var cb2=e.target.closest('#detailCancelBtn');if(cb2){closeDetailModal();return;}var sb=e.target.closest('#detailSaveBtn');if(sb){saveDetailChanges();return;}var ada=e.target.closest('#detailAddBtn');if(ada){addDetailRow();return;}var ins=e.target.closest('#detailInsertBtn');if(ins){insertDetailRow();return;}var iconBtn=e.target.closest('.xs-icon-btn');if(iconBtn){var action=iconBtn.dataset.action;if(action==='openTextEditor')${onOpenTextEditor}();return;}var cb=e.target.closest('.row-cb');if(cb){var tr=cb.closest('tr');var idx=parseInt(tr.dataset.row);if(cb.checked)S.sel.add(idx);else S.sel.delete(idx);updSel();e.stopPropagation();return;}var td=e.target.closest('.xs-editable');if(td){if(td.classList.contains('xs-detail-link')){var ri=parseInt(td.dataset.row);showDetailModal(ri);return;}setCell(td);return;}var dtd=e.target.closest('.xs-detail-editable');if(dtd){setDetailCell(dtd);return;}var overlay=e.target.closest('#detailModal');if(overlay&&e.target===overlay){closeDetailModal();return;}if(!e.target.closest('.xs-cm')&&!e.target.closest('.xs-sf')&&!e.target.closest('.xs-find')){document.getElementById('ctxMenu').style.display='none';document.getElementById('sortFilter').style.display='none';document.getElementById('findPanel').classList.remove('show');}});document.addEventListener('dblclick',function(e){var td=e.target.closest('.xs-editable');if(td){startEdit(td);return;}var dtd=e.target.closest('.xs-detail-editable');if(dtd){startDetailEdit(dtd);}});document.addEventListener('click',function(e){var btn=e.target.closest('.xs-th-filter');if(btn){e.stopPropagation();var th=btn.closest('th');var col=parseInt(th.dataset.col);showSortF(col,th);return;}});document.addEventListener('mousedown',function(e){var res=e.target.closest('.xs-resizer');if(res){e.preventDefault();e.stopPropagation();var th=res.parentElement;var startX=e.clientX;var startW=th.offsetWidth;document.body.style.cursor='col-resize';function onMove(ev){var w=Math.max(40,startW+(ev.clientX-startX));th.style.width=w+'px';S.colWidths[parseInt(th.dataset.col)]=w;}function onUp(){document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);document.body.style.cursor='';}document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);return;}var tdCb=e.target.closest('.xs-td-cb');if(tdCb&&!e.target.closest('input')){e.preventDefault();e.stopPropagation();var tr=tdCb.closest('tr');var startY=e.clientY;var startH=tr.getBoundingClientRect().height;var rowIdx=parseInt(tr.dataset.row);var tdSample=tr.querySelector('.xs-td:not(.xs-td-cb)');var lineH=tdSample?tdSample.offsetHeight:28;document.body.style.cursor='row-resize';function updateWrap(h){var lines=Math.max(1,Math.round(h/lineH));var wraps=tr.querySelectorAll('.xs-cell-wrap');wraps.forEach(function(w){w.style.whiteSpace=lines>1?'normal':'nowrap';w.style.overflow='hidden';w.style.textOverflow='ellipsis';w.style.wordBreak='break-word';w.style.display=lines>1?'-webkit-box':'';w.style.webkitBoxOrient='vertical';w.style.webkitLineClamp=lines>1?lines:'';});}function onMove(ev){var h=Math.max(lineH,startH+(ev.clientY-startY));tr.style.height=h+'px';S.rowHeights=S.rowHeights||{};S.rowHeights[rowIdx]=h;updateWrap(h);}function onUp(){document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);document.body.style.cursor='';}document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);return;}});document.getElementById('pushBtn').addEventListener('click',pushTC);document.getElementById('findBtn').addEventListener('click',toggleFind);document.getElementById('searchInput').addEventListener('input',function(){doSearch(this.value);});document.getElementById('findInput').addEventListener('input',function(){doFind();});document.getElementById('prevBtn').addEventListener('click',doPrev);document.getElementById('nextBtn').addEventListener('click',doNext);document.getElementById('replaceBtn').addEventListener('click',doReplace);document.getElementById('replaceAllBtn').addEventListener('click',doReplaceAll);}}
document.addEventListener('keydown',function(e){if(document.activeElement.tagName==='INPUT')return;var c=e.ctrlKey||e.metaKey;if(c&&e.key==='c'){e.preventDefault();copySel();}if(c&&e.key==='x'){e.preventDefault();cutSel();}if(c&&e.key==='v'){e.preventDefault();pasteClip();}if(c&&e.key==='a'){e.preventDefault();selAll();}if(c&&e.key==='z'){e.preventDefault();undo();}if(c&&e.key==='y'){e.preventDefault();redo();}if(c&&e.key==='f'){e.preventDefault();toggleFind();}if((e.key==='Delete'||e.key==='Backspace')&&S.cell){e.preventDefault();clearCell();}if(e.key==='Enter'&&S.cell){e.preventDefault();startEdit(S.cell);}if(e.key==='Escape'){cancelEdit();if(S.detailEditing){closeDetailModal();}}});
function updUI(){var si=document.getElementById('selInfo');if(si)si.textContent='已选 '+S.sel.size+' 行，共 '+S.data.rows.length+' 行';var mi=document.getElementById('modInfo');var mc=document.getElementById('modCount');if(mi)mi.style.display=S.mods.size>0?'inline':'none';if(mc)mc.textContent=S.mods.size;updSel();updSearch();}
function updSel(){document.querySelectorAll('tbody tr').forEach(function(tr){var idx=parseInt(tr.dataset.row);var cb=tr.querySelector('.row-cb');if(cb)cb.checked=S.sel.has(idx);tr.classList.toggle('selected',S.sel.has(idx));});var si=document.getElementById('selInfo');if(si)si.textContent='已选 '+S.sel.size+' 行，共 '+S.data.rows.length+' 行';var hcb=document.getElementById('headerCheckbox');if(hcb){var vr=document.querySelectorAll('tbody tr:not(.hidden)');var vi=Array.from(vr).map(function(r){return parseInt(r.dataset.row);});var sv=vi.filter(function(i){return S.sel.has(i);}).length;hcb.checked=sv>0&&sv===vi.length;hcb.indeterminate=sv>0&&sv<vi.length;}var pb=document.getElementById('pushBtn');if(pb)pb.disabled=S.sel.size===0;}
function updCellSel(){document.querySelectorAll('.xs-editable').forEach(function(td){td.classList.remove('active');});if(S.cell)S.cell.classList.add('active');}
function updSearch(){var kw=(document.getElementById('searchInput').value||'').toLowerCase();document.querySelectorAll('tbody tr').forEach(function(tr){var matchKw=!kw||(tr.textContent||'').toLowerCase().includes(kw);tr.classList.toggle('hidden',!matchKw);});updSel();}
function selAll(){document.querySelectorAll('tbody tr:not(.hidden)').forEach(function(tr){S.sel.add(parseInt(tr.dataset.row));});updSel();}
function deselAll(){S.sel.clear();updSel();}
function setCell(td){document.querySelectorAll('.xs-editable').forEach(function(t){t.classList.remove('active');});S.cell=td;if(td){td.classList.add('active');var idx=parseInt(td.dataset.row);if(!S.sel.has(idx)){S.sel.clear();S.sel.add(idx);}updSel();}}
function startEdit(td){if(td.querySelector('input'))return;setCell(td);S.editing=true;var ri=parseInt(td.dataset.row);var ci=parseInt(td.dataset.col);var orig=S.data.rows[ri]&&S.data.rows[ri][ci]||'';td.innerHTML='<input type="text" value="'+escHtml(orig)+'">';var inp=td.querySelector('input');inp.focus();inp.select();inp.addEventListener('blur',function(){S.editing=false;finEdit(td,ri,ci,orig);});inp.addEventListener('keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();S.editing=false;finEdit(td,ri,ci,orig);var nt=document.querySelector('.xs-editable[data-row="'+(ri+1)+'"][data-col="'+ci+'"]');if(nt){setCell(nt);startEdit(nt);}}if(ev.key==='Escape'){td.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text">'+escHtml(orig)+'</span></div>';S.editing=false;setCell(td);}});}
function finEdit(td,ri,ci,orig){try{var inp=td&&td.querySelector&&td.querySelector('input');if(!inp)return;var val=inp.value;var parent=td.parentNode;if(!parent)return;td.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text">'+escHtml(val)+'</span></div>';if(val!==orig){if(!S.data.rows[ri])S.data.rows[ri]=[];S.data.rows[ri][ci]=val;var k=ri+'-'+ci;if(!S.mods.has(k)){S.mods.add(k);}td.classList.add('modified');saveHist();updUI();${onSave}();}var newTd=document.querySelector('.xs-editable[data-row="'+ri+'"][data-col="'+ci+'"]');if(newTd)setCell(newTd);}catch(e){}}
function cancelEdit(){document.querySelectorAll('.xs-editable input').forEach(function(inp){inp.blur();});}
function clearCell(){if(!S.cell)return;var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);S.data.rows[ri][ci]='';S.cell.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text"></span></div>';var k=ri+'-'+ci;S.mods.add(k);S.cell.classList.add('modified');saveHist();updUI();${onSave}();}
function copySel(){if(S.cell){var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);S.clip={type:'cell',data:S.data.rows[ri]&&S.data.rows[ri][ci]||''};navigator.clipboard.writeText(S.clip.data);toast('已复制单元格','success');}else if(S.sel.size>0){var rows=Array.from(S.sel).sort(function(a,b){return a-b;});var text=rows.map(function(i){return(S.data.rows[i]||[]).join('\\t');}).join('\\n');S.clip={type:'rows',data:rows.map(function(i){return[...(S.data.rows[i]||[])];})};navigator.clipboard.writeText(text);toast('已复制 '+rows.length+' 行','success');}}
function cutSel(){copySel();if(S.cell){var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);S.data.rows[ri][ci]='';S.cell.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text"></span></div>';saveHist();updUI();${onSave}();}toast('已剪切','success');}
function pasteClip(){if(!S.clip)return;if(S.clip.type==='cell'&&S.cell){var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);if(!S.data.rows[ri])S.data.rows[ri]=[];S.data.rows[ri][ci]=S.clip.data;S.cell.innerHTML='<div class="xs-cell-wrap"><span class="xs-cell-text">'+escHtml(S.clip.data)+'</span></div>';saveHist();updUI();${onSave}();toast('已粘贴','success');}else if(S.clip.type==='rows'){var sr=S.sel.size>0?Math.min(...S.sel):0;S.clip.data.forEach(function(row,i){if(S.data.rows[sr+i]){row.forEach(function(val,j){S.data.rows[sr+i][j]=val;});}});reRender();saveHist();updUI();${onSave}();toast('已粘贴 '+S.clip.data.length+' 行','success');}}
function insertRow(){var idx=S.cell?parseInt(S.cell.dataset.row)+1:S.data.rows.length;var nr=new Array(S.data.headers.length).fill('');S.data.rows.splice(idx,0,nr);if(S.detailTable&&S.detailTable.rowGroups){S.detailTable.rowGroups.splice(idx,0,[]);if(S.detailTable.rawRowGroups)S.detailTable.rawRowGroups.splice(idx,0,[]);}saveHist();reRender();updUI();${onSave}();toast('已插入行','success');}
function duplicateRow(){var idx=S.cell?parseInt(S.cell.dataset.row):(S.sel.size>0?Math.min(...S.sel):S.data.rows.length-1);if(S.data.rows.length===0){toast('无数据可复制','error');return;}var src=S.data.rows[idx];if(!src){toast('源行不存在','error');return;}var copy=[...src];S.data.rows.splice(idx+1,0,copy);if(S.detailTable&&S.detailTable.rowGroups){var gr=S.detailTable.rowGroups[idx]||[];var deepGr=gr.map(function(r){return[...r];});S.detailTable.rowGroups.splice(idx+1,0,deepGr);if(S.detailTable.rawRowGroups){var rawGr=(S.detailTable.rawRowGroups[idx]||[]);var deepRawGr=rawGr.map(function(r){return typeof r==='object'?JSON.parse(JSON.stringify(r)):r;});S.detailTable.rawRowGroups.splice(idx+1,0,deepRawGr);}}S.sel.clear();S.sel.add(idx+1);saveHist();reRender();updUI();${onSave}();toast('已复制行','success');}
function insertCol(){var idx=S.cell?parseInt(S.cell.dataset.col)+1:S.data.headers.length;S.data.headers.splice(idx,0,'新列');S.data.rows.forEach(function(r){r.splice(idx,0,'');});saveHist();reRender();updUI();${onSave}();toast('已插入列','success');}
function deleteRows(){if(S.sel.size===0)return;var rows=Array.from(S.sel).sort(function(a,b){return b-a;});rows.forEach(function(i){S.data.rows.splice(i,1);if(S.detailTable&&S.detailTable.rowGroups){S.detailTable.rowGroups.splice(i,1);if(S.detailTable.rawRowGroups)S.detailTable.rawRowGroups.splice(i,1);}});S.sel.clear();saveHist();reRender();updUI();${onSave}();toast('已删除 '+rows.length+' 行','success');}
function deleteCol(){if(!S.cell)return;var colIdx=parseInt(S.cell.dataset.col);if(S.data.headers.length<=1){toast('至少保留一列','error');return;}S.data.headers.splice(colIdx,1);S.data.rows.forEach(function(r){r.splice(colIdx,1);});S.sel.clear();S.cell=null;saveHist();reRender();updUI();${onSave}();toast('已删除列','success');}
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
function doReplace(){var oldVal=(document.getElementById('findInput').value||'');var newVal=(document.getElementById('replaceInput').value||'');if(!oldVal||!S.cell)return;var ri=parseInt(S.cell.dataset.row);var ci=parseInt(S.cell.dataset.col);var cell=S.data.rows[ri]&&S.data.rows[ri][ci]||'';var regex=new RegExp(esc(oldVal),'gi');if(regex.test(cell)){regex.lastIndex=0;S.data.rows[ri][ci]=cell.replace(regex,newVal);S.cell.querySelector('.xs-cell-text').textContent=S.data.rows[ri][ci];var k=ri+'-'+ci;S.mods.add(k);S.cell.classList.add('modified');saveHist();updUI();doFind();${onSave}();toast('已替换','success');clearHighlights();document.getElementById('findPanel').classList.remove('show');}}
function doReplaceAll(){var oldVal=(document.getElementById('findInput').value||'');var newVal=(document.getElementById('replaceInput').value||'');if(!oldVal)return;var regex=new RegExp(esc(oldVal),'gi');var count=0;S.data.rows.forEach(function(row,ri){row.forEach(function(cell,ci){if(cell&&regex.test(cell)){regex.lastIndex=0;S.data.rows[ri][ci]=cell.replace(regex,newVal);var k=ri+'-'+ci;S.mods.add(k);count++;}});});if(count>0){saveHist();reRender();updUI();${onSave}();toast('已替换 '+count+' 处','success');}clearHighlights();document.getElementById('findPanel').classList.remove('show');}
function ${onOpenTextEditor}(){var lines=[];if(S.data.headers)lines.push(S.data.headers.map(escCsv).join(','));S.data.rows.forEach(function(row){lines.push(row.map(escCsv).join(','));});var csvText=lines.join('\\n');S.vscode.postMessage({type:'openTextEditor',data:csvText});}
function ${onSave}(){var saveObj={headers:S.data.headers,rows:S.data.rows};if(S.detailTable&&S.detailTable.rowGroups){saveObj.detailTable={field:S.detailTable.field,headers:S.detailTable.headers,rowGroups:S.detailTable.rowGroups};}S.vscode.postMessage({type:'save',data:saveObj});}
function escCsv(v){v=String(v||'');if(v.includes(',')||v.includes('"')||v.includes('\\n')||v.includes('\\r')){return'"'+v.replace(/"/g,'""')+'"';}return v;}
function pushTC(){if(S.sel.size===0){toast('请先选择测试案例','error');return;}var dt=S.detailTable;var data=Array.from(S.sel).map(function(i){var obj={};S.data.headers.forEach(function(h,j){if(dt&&h===dt.field&&dt.rowGroups){var gr=dt.rowGroups[i]||[];var rawGr=(dt.rawRowGroups&&dt.rawRowGroups[i])||[];var items=[];for(var di=0;di<gr.length;di++){var item={};var raw=rawGr[di];dt.headers.forEach(function(dh,dci){var v=gr[di]?gr[di][dci]:'';if(raw&&typeof raw==='object'){if(typeof raw[dh]==='number'){v=Number(v)||0;}else if(typeof raw[dh]==='boolean'){v=v==='true';}else if(Array.isArray(raw[dh])){v=v?v.split('; ').filter(Boolean):[];}else{v=v||'';}}item[dh]=v;});items.push(item);}obj[h]=items;}else{obj[h]=S.data.rows[i]&&S.data.rows[i][j]||'';}});return obj;});S.vscode.postMessage({type:'pushTestCase',data:data});toast('推送中...','');}
function reRender(){var container=document.getElementById('tableContainer');if(!container)return;if(S.editing){cancelEdit();S.editing=false;}var h=S.data.headers||[];var r=S.data.rows||[];var html='<table class="xs-table"><thead><tr><th class="xs-th xs-th-cb"><input type="checkbox" id="headerCheckbox"></th>';h.forEach(function(ht,i){var sa=S.sCol===i?'data-sort="'+S.sOrder+'"':'';var sw=S.colWidths&&S.colWidths[i]?S.colWidths[i]:(ht.length*9+30);var wStyle=' style="width:'+sw+'px"';var htEsc=escHtml(ht);html=html+'<th class="xs-th" data-col="'+i+'" '+sa+wStyle+'><span class="xs-th-text" title="'+htEsc+'">'+htEsc+'</span><span class="xs-th-filter">▼</span><div class="xs-resizer" data-col="'+i+'"></div></th>';});html=html+'</tr></thead><tbody>';r.forEach(function(row,ri){var savedH=S.rowHeights&&S.rowHeights[ri];var rowStyle=savedH?' style="height:'+savedH+'px"':'';var lines=1;var wrapStyle='';if(savedH){var tmpDiv=document.createElement('div');tmpDiv.className='xs-td';tmpDiv.style.visibility='hidden';tmpDiv.style.position='absolute';tmpDiv.style.width='100px';tmpDiv.textContent='test';document.body.appendChild(tmpDiv);var lineH=tmpDiv.offsetHeight;document.body.removeChild(tmpDiv);lines=Math.max(1,Math.round(savedH/lineH));wrapStyle=' style="white-space:normal;overflow:hidden;text-overflow:ellipsis;word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:'+lines+'"';}html=html+'<tr data-row="'+ri+'"'+rowStyle+'><td class="xs-td xs-td-cb"><input type="checkbox" class="row-cb"></td>';row.forEach(function(cell,ci){var k=ri+'-'+ci;var mod=S.mods.has(k)?' modified':'';var cellEsc=escHtml(cell);var isDetail=/^\\[\\d+ 项\\]$/.test(cell);var detailClass=isDetail?' xs-detail-link':'';html=html+'<td class="xs-td xs-editable'+mod+detailClass+'" data-row="'+ri+'" data-col="'+ci+'" title="'+cellEsc+'"><div class="xs-cell-wrap"'+wrapStyle+'><span class="xs-cell-text">'+cellEsc+'</span></div></td>';});html=html+'</tr>';});html=html+'</tbody></table>';container.innerHTML=html;S._bound=false;bindEv();}
function showDetailModal(rowIdx){if(!S.detailTable){toast('当前文件无明细数据','error');return;}S.detailRow=rowIdx;S.detailMods=new Set();S.detailCell=null;S.detailEditing=false;var dt=S.detailTable;// 创建快照：深拷贝当前行组的 rowGroups
var gr=dt.rowGroups&&dt.rowGroups[rowIdx];var snapGroups=gr?gr.map(function(r){return[...r];}):[];// 记录主表单元格原始显示文本(用于取消时还原)
var snapCellText='';var fi=-1;S.data.headers.forEach(function(h,i){if(h===dt.field)fi=i;});if(fi!==-1&&S.data.rows[rowIdx])snapCellText=S.data.rows[rowIdx][fi]||'';S._detailSnap={groups:snapGroups,cellText:snapCellText,cellIdx:fi};renderDetailModal();var modal=document.getElementById('detailModal');if(modal)modal.classList.add('show');document.querySelectorAll('tbody tr').forEach(function(tr){tr.classList.remove('xs-detail-active');});var tr=document.querySelector('.xs-table tbody tr[data-row="'+rowIdx+'"]');if(tr)tr.classList.add('xs-detail-active');}
function closeDetailModal(){var snap=S._detailSnap;// 取消时还原快照
if(snap!==null&&S.detailTable&&S.detailTable.rowGroups&&S.detailRow>=0){S.detailTable.rowGroups[S.detailRow]=snap.groups;// 还原主表单元格文本和清除 mods 标记
if(snap.cellIdx!==-1&&S.data.rows[S.detailRow]){S.data.rows[S.detailRow][snap.cellIdx]=snap.cellText;S.mods.delete(S.detailRow+'-'+snap.cellIdx);var cell=document.querySelector('.xs-editable[data-row="'+S.detailRow+'"][data-col="'+snap.cellIdx+'"]');if(cell){var span=cell.querySelector('.xs-cell-text');if(span)span.textContent=snap.cellText;cell.setAttribute('title',snap.cellText);cell.classList.remove('modified');}}S._detailSnap=null;}var modal=document.getElementById('detailModal');if(modal)modal.classList.remove('show');S.detailRow=-1;S.detailMods=new Set();S.detailCell=null;document.querySelectorAll('.xs-detail-active').forEach(function(tr){tr.classList.remove('xs-detail-active');});}
function saveDetailChanges(){S._detailSnap=null;try{if(S.detailMods.size>0){${onSave}();}}catch(e){}closeDetailModal();}
function renderDetailModal(){var dt=S.detailTable;var body=document.getElementById('detailModalBody');if(!body||!dt||!dt.rowGroups||S.detailRow<0||S.detailRow>=dt.rowGroups.length){return;}var dr=S.detailRow;var mainRow=S.data.rows[dr];var nameCell=mainRow?(mainRow[0]||mainRow[1]||'行 '+(dr+1)):('行 '+(dr+1));var titleEl=document.getElementById('detailModalTitle');if(titleEl)titleEl.textContent=dt.fieldDisplay+' - 第'+(dr+1)+'行 ('+escHtml(nameCell)+')';var detailRows=dt.rowGroups[dr]||[];var dhtml='<table class="xs-detail-table"><thead><tr>';dhtml+='<th style="width:30px">#</th>';dt.headers.forEach(function(dh){dhtml+='<th>'+escHtml(dh)+'</th>';});dhtml+='<th style="width:36px"></th></tr></thead><tbody>';if(detailRows.length===0){dhtml+='<tr><td colspan="'+(dt.headers.length+2)+'" style="text-align:center;color:#999;padding:30px">暂无步骤数据</td></tr>';}else{detailRows.forEach(function(drow,di){dhtml+='<tr>';dhtml+='<td style="text-align:center;color:#999;font-size:11px">'+(di+1)+'</td>';drow.forEach(function(dcell,ci){var k=dr+'-'+di+'-'+ci;var mod=S.detailMods.has(k)?' modified':'';dhtml+='<td class="xs-detail-editable'+mod+'" data-drow="'+dr+'" data-dsub="'+di+'" data-dcol="'+ci+'" title="'+escHtml(dcell)+'">'+escHtml(dcell)+'</td>';});dhtml+='<td class="xs-detail-row-cb"><span data-delrow="'+di+'" style="cursor:pointer;color:#e34d59;font-size:12px" title="删除此行">✕</span></td>';dhtml+='</tr>';});}dhtml+='</tbody></table>';body.innerHTML=dhtml;// 绑定删除行事件
body.querySelectorAll('[data-delrow]').forEach(function(el){el.addEventListener('click',function(e){e.stopPropagation();var dsub=parseInt(el.dataset.delrow);deleteDetailRow(dsub);});});updDetailModInfo();}
function setDetailCell(td){S.detailCell=td;document.querySelectorAll('.xs-detail-editable.active').forEach(function(t){t.classList.remove('active');});td.classList.add('active');}
function startDetailEdit(td){if(!td||td.querySelector('input'))return;setDetailCell(td);S.detailEditing=true;var dr=parseInt(td.dataset.drow);var ds=parseInt(td.dataset.dsub);var dc=parseInt(td.dataset.dcol);var orig=(S.detailTable.rowGroups[dr]&&S.detailTable.rowGroups[dr][ds]&&S.detailTable.rowGroups[dr][ds][dc])||'';td.innerHTML='<input type="text" value="'+escHtml(orig)+'">';var inp=td.querySelector('input');inp.focus();inp.select();inp.addEventListener('blur',function(){S.detailEditing=false;finDetailEdit(td,dr,ds,dc,orig);});inp.addEventListener('keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();S.detailEditing=false;finDetailEdit(td,dr,ds,dc,orig);var nt=document.querySelector('.xs-detail-editable[data-drow="'+dr+'"][data-dsub="'+(ds+1)+'"][data-dcol="'+dc+'"]');if(nt){setDetailCell(nt);startDetailEdit(nt);}}if(ev.key==='Escape'){td.textContent=orig;S.detailEditing=false;}});}
function finDetailEdit(td,dr,ds,dc,orig){var inp=td.querySelector('input');if(!inp)return;var val=inp.value;td.textContent=val;if(val!==orig){if(!S.detailTable.rowGroups[dr])S.detailTable.rowGroups[dr]=[];if(!S.detailTable.rowGroups[dr][ds])S.detailTable.rowGroups[dr][ds]=[];S.detailTable.rowGroups[dr][ds][dc]=val;var k=dr+'-'+ds+'-'+dc;S.detailMods.add(k);}if(val!==orig)td.classList.add('modified');else td.classList.remove('modified');updDetailModInfo();}
function deleteDetailRow(dsub){var dr=S.detailRow;if(!S.detailTable||!S.detailTable.rowGroups[dr])return;S.detailTable.rowGroups[dr].splice(dsub,1);for(var ci=0;S.detailTable.headers&&ci<S.detailTable.headers.length;ci++){S.detailMods.add(dr+'-'+dsub+'-'+ci);}syncDetailCount();renderDetailModal();updDetailModInfo();}
function addDetailRow(){var dr=S.detailRow;if(!S.detailTable){return;}if(!S.detailTable.rowGroups[dr])S.detailTable.rowGroups[dr]=[];var newRow=new Array(S.detailTable.headers.length).fill('');S.detailTable.rowGroups[dr].push(newRow);syncDetailCount();renderDetailModal();S.detailMods.add(dr+'-'+(S.detailTable.rowGroups[dr].length-1)+'-0');updDetailModInfo();toast('已添加行','success');}
function insertDetailRow(){var dr=S.detailRow;if(!S.detailTable){return;}if(!S.detailTable.rowGroups[dr])S.detailTable.rowGroups[dr]=[];var dsub=S.detailCell?parseInt(S.detailCell.dataset.dsub)+1:S.detailTable.rowGroups[dr].length;var newRow=new Array(S.detailTable.headers.length).fill('');S.detailTable.rowGroups[dr].splice(dsub,0,newRow);syncDetailCount();renderDetailModal();S.detailMods.add(dr+'-'+dsub+'-0');updDetailModInfo();toast('已插入行','success');}
function syncDetailCount(){var dr=S.detailRow;var dt=S.detailTable;if(!dt||!dt.field||!S.data.rows[dr])return;var fi=-1;S.data.headers.forEach(function(h,i){if(h===dt.field)fi=i;});if(fi===-1)return;var cnt=(dt.rowGroups[dr]||[]).length;var txt='['+cnt+' 项]';S.data.rows[dr][fi]=txt;S.mods.add(dr+'-'+fi);var cell=document.querySelector('.xs-editable[data-row="'+dr+'"][data-col="'+fi+'"]');if(cell){var span=cell.querySelector('.xs-cell-text');if(span)span.textContent=txt;cell.setAttribute('title',txt);cell.classList.add('modified');}}
function updDetailModInfo(){var mi=document.getElementById('detailModInfo');if(mi)mi.style.display=S.detailMods.size>0?'inline':'none';}
function toast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='xs-toast '+(type||'');t.style.display='block';setTimeout(function(){t.style.display='none';},2000);}
</script>
</body>
</html>`;
}

// 错误页面 HTML
export function buildErrorHtml(message: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}
.msg{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.msg h3{color:#e34d59;margin:0 0 12px}.msg p{color:#666;font-size:14px;margin:0}
</style></head><body><div class="msg"><h3>不支持的文件位置</h3><p>${message}</p></div></body></html>`;
}
