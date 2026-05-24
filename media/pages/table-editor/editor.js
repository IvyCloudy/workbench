// 表格编辑器主逻辑
// 运行时配置由 BaseEditorProvider 注入（dataType / msgType）
var __CFG = (typeof window !== 'undefined' && window.__EDITOR_CONFIG__) || { dataType: '', msgType: '' };

// ==================== 日志 ====================
// 仅打到 webview 自身控制台（开发者工具中查看）；不再通过 postMessage 转发给扩展端，
// 避免日志在两侧双倍打印导致截断。
var __LOG_TAG = '[TC-WEBVIEW][' + (__CFG.dataType || '?') + '#' + Math.random().toString(36).slice(2, 6) + ']';
function dbg() {
    var args = Array.prototype.slice.call(arguments);
    try { console.log.apply(console, [__LOG_TAG].concat(args)); } catch (_) {}
}

var S = {
    dataType: __CFG.dataType,
    msgType: __CFG.msgType,
    data: { headers: [], rows: [] },
    sel: new Set(),         // 选中的行号集合
    cell: null,             // 当前激活单元格 {r, c}
    clip: null,             // 单元格剪贴板
    rowClip: null,          // 行剪贴板
    mods: new Set(),        // 修改过的单元格 key="r,c"
    colWidths: {},          // 列宽
    vscode: null,
    editing: false,
    _ctxRow: -1,            // 右键当前行
    _ctxCol: -1,            // 右键当前列
    _docBound: false,
    // 明细弹窗状态
    _detailField: '',       // 当前打开明细的字段名
    _detailRowIdx: -1,      // 当前打开明细的主表行号
    _detailMods: new Set(), // 明细修改集合 key="di,ci"
    _detailEditing: false,
    _detailSel: new Set(),  // 明细选中的子行
    // 查找/替换
    _matches: [],           // [{r, c}]
    _matchIdx: -1,          // 当前命中的 match 索引
    _findKw: '',            // 当前关键字
    // 撤销/重做
    _history: [],           // 过去的快照栈
    _future: [],            // 已撤销可重做的栈
    _HISTORY_LIMIT: 100
};

// ==================== 撤销/重做 ====================
function snapshot() {
    try {
        return {
            data: JSON.parse(JSON.stringify(S.data || {})),
            mods: Array.from(S.mods)
        };
    } catch (err) {
        return null;
    }
}

function restoreSnapshot(snap) {
    if (!snap) return;
    S.data = snap.data || { headers: [], rows: [] };
    if (!S.data.headers) S.data.headers = [];
    if (!S.data.rows) S.data.rows = [];
    S.mods = new Set(snap.mods || []);
    S.sel.clear();
    renderTable();
    saveFile();
}

// 在每次将要发生数据修改之前调用，记录当前快照到 history
function pushHistory() {
    var snap = snapshot();
    if (!snap) return;
    S._history.push(snap);
    if (S._history.length > S._HISTORY_LIMIT) S._history.shift();
    // 任何新的修改都会清空 future（标准 undo/redo 语义）
    S._future.length = 0;
}

function clearHistory() {
    S._history.length = 0;
    S._future.length = 0;
}

function undo() {
    if (S.editing || S._detailEditing) return; // 编辑态下交给输入框默认行为
    if (isDetailModalOpen()) return;            // 明细弹窗中不处理
    if (S._history.length === 0) { showToast('没有可撤销的操作', 'error'); return; }
    var current = snapshot();
    var prev = S._history.pop();
    if (current) S._future.push(current);
    restoreSnapshot(prev);
    showToast('已撤销', 'success');
}

function redo() {
    if (S.editing || S._detailEditing) return;
    if (isDetailModalOpen()) return;
    if (S._future.length === 0) { showToast('没有可重做的操作', 'error'); return; }
    var current = snapshot();
    var next = S._future.pop();
    if (current) S._history.push(current);
    restoreSnapshot(next);
    showToast('已重做', 'success');
}

// ==================== 初始化 ====================
function init() {
    dbg('▶ init', __CFG.dataType);
    S.vscode = acquireVsCodeApi();
    S.vscode.postMessage({ type: 'init' });
    bindToolbar();
    bindDocument();
}

// 注意：这里不监听 window.focus 重新 postMessage('init')。
// 在 retainContextWhenHidden=true 模式下，webview 状态会被保留；
// 若每次 focus 都重新 init，扩展端会回包覆盖当前 S.data，从而丢失未保存的修改、撤销栈、滚动位置，
// 并在 yaml/json 多 tab 之间切换时表现为"页面互相覆盖"。

// 消息处理
window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m) return;
    if (m.type === S.msgType) {
        var hasUserChanges = (S.mods && S.mods.size > 0) || (S._history && S._history.length > 0);
        var alreadyRendered = !!(S.data && Array.isArray(S.data.headers) && S.data.headers.length > 0);
        // 兜底重发数据场景：当切换 tab 后扩展端主动 repush 时，
        // 如果用户已有未保存修改或撤销栈，则忽略这次推送，避免覆盖用户编辑成果。
        if (hasUserChanges && alreadyRendered) {
            dbg('⏭ skip repush (user changes)');
            renderTable();
            return;
        }
        S.data = decodePayload(m.data) || { headers: [], rows: [] };
        if (!S.data.headers) S.data.headers = [];
        if (!S.data.rows) S.data.rows = [];
        dbg('🎨 render rows=' + S.data.rows.length);
        S.sel.clear();
        S.mods.clear();
        clearHistory();
        renderTable();
    } else if (m.type === 'saved') {
        showToast('保存成功', 'success');
        S.mods.clear();
        renderTable();
    } else if (m.type === 'saveError') {
        showToast('保存失败: ' + (m.message || ''), 'error');
    } else if (m.type === 'pushSuccess') {
        showToast('推送成功', 'success');
    } else if (m.type === 'pushError') {
        showToast('推送失败: ' + (m.message || ''), 'error');
    }
});

function decodePayload(payload) {
    if (!payload) return {};
    if (!Array.isArray(payload) && typeof payload === 'object') return payload;
    try {
        var bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
        return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch (err) {
        console.error('[editor] 解析数据失败:', err);
        return {};
    }
}

// ==================== 渲染 ====================
function renderTable() {
    var c = document.getElementById('tableContainer');
    if (!c) return;
    var h = S.data.headers || [], r = S.data.rows || [];

    var html = '<table class="xs-table"><colgroup>';
    html += '<col style="width:50px">';
    h.forEach(function (_, i) {
        var w = S.colWidths[i] || 160;
        html += '<col style="width:' + w + 'px">';
    });
    html += '</colgroup><thead><tr>';
    html += '<th class="xs-th xs-th-cb"><input type="checkbox" id="selectAll"></th>';
    h.forEach(function (hdr, i) {
        html += '<th class="xs-th" data-col="' + i + '" draggable="true">'
            + '<span class="xs-th-text">' + escapeHtml(String(hdr)) + '</span>'
            + '<div class="xs-resizer" data-col="' + i + '"></div>'
            + '</th>';
    });
    html += '</tr></thead><tbody>';

    var skw = (S._searchKw || '').toLowerCase();
    r.forEach(function (row, ri) {
        // 顶部搜索过滤：未命中的行不渲染
        if (skw) {
            var hit = false;
            for (var k = 0; k < h.length; k++) {
                var cv = row[k];
                if (cv === null || cv === undefined) continue;
                if (String(cv).toLowerCase().indexOf(skw) >= 0) { hit = true; break; }
            }
            if (!hit) return;
        }
        var selCls = S.sel.has(ri) ? ' selected' : '';
        html += '<tr data-row="' + ri + '" draggable="true" class="' + selCls.trim() + '">'
            + '<td class="xs-td xs-td-cb"><input type="checkbox" data-row="' + ri + '"' + (S.sel.has(ri) ? ' checked' : '') + '></td>';
        h.forEach(function (_, ci) {
            var v = row[ci];
            var modCls = S.mods.has(ri + ',' + ci) ? ' modified' : '';
            var isDetail = hasDetailRowsAtCol(ri, ci);
            var rawText = formatCellValue(v);
            var inner = isDetail
                ? '<span class="xs-detail-link" data-detail-row="' + ri + '" data-detail-col="' + ci + '">' + escapeHtml(rawText) + '</span>'
                : escapeHtml(rawText);
            // 单元格 tooltip：完整原始值
            var titleAttr = rawText ? ' title="' + escapeHtml(rawText) + '"' : '';
            html += '<td class="xs-td xs-editable' + modCls + (isDetail ? ' xs-detail-cell' : '') + '" data-row="' + ri + '" data-col="' + ci + '"' + titleAttr + '>'
                + '<div class="xs-cell-wrap">' + inner + '</div></td>';
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    c.innerHTML = html;

    bindTable();
    updateSelectionInfo();
    updatePushBtn();
    updateModInfo();
    // 重绘后恢复查找高亮
    if (S._findKw) paintFindHighlight();
}

// ==================== 事件绑定 ====================
function bindToolbar() {
    var pushBtn = document.getElementById('pushBtn');
    if (pushBtn) pushBtn.addEventListener('click', pushChanges);
    var openBtn = document.querySelector('[data-action="openTextEditor"]');
    if (openBtn) openBtn.addEventListener('click', function () {
        S.vscode.postMessage({ type: 'openTextEditor' });
    });
    var findBtn = document.getElementById('findBtn');
    if (findBtn) findBtn.addEventListener('click', toggleFindPanel);
    var search = document.getElementById('searchInput');
    if (search) search.addEventListener('input', onSearch);

    var findInput = document.getElementById('findInput');
    if (findInput) findInput.addEventListener('input', function (ev) {
        rebuildFindMatches((ev.target.value || ''));
        updateFindInfo();
        focusActiveMatch();
    });
    var prevBtn = document.getElementById('prevBtn');
    if (prevBtn) prevBtn.addEventListener('click', function () { stepFind(-1); });
    var nextBtn = document.getElementById('nextBtn');
    if (nextBtn) nextBtn.addEventListener('click', function () { stepFind(1); });
    var replaceBtn = document.getElementById('replaceBtn');
    if (replaceBtn) replaceBtn.addEventListener('click', replaceCurrent);
    var replaceAllBtn = document.getElementById('replaceAllBtn');
    if (replaceAllBtn) replaceAllBtn.addEventListener('click', replaceAll);
}

function bindDocument() {
    if (S._docBound) return;
    S._docBound = true;
    // 全局点击关闭右键菜单
    document.addEventListener('click', function () { hideContextMenu(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            hideContextMenu();
            if (isDetailModalOpen()) closeDetailModal();
            if (isXsPromptOpen()) closeXsPrompt(false);
            // ESC 也关闭查找面板
            var fp = document.getElementById('findPanel');
            if (fp && fp.classList.contains('show')) closeFindPanel();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
        }
        // Ctrl/Cmd + F 快捷键打开查找替换
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            // 避免在 prompt 弹窗/明细弹窗中拦截
            if (isXsPromptOpen()) return;
            e.preventDefault();
            openFindPanel();
        }
        // 撤销 / 重做：Ctrl/Cmd+Z 撤销；Ctrl+Y 或 Ctrl/Cmd+Shift+Z 重做
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            var k = (e.key || '').toLowerCase();
            if (k === 'z' && !e.shiftKey) {
                if (isXsPromptOpen() || isDetailModalOpen()) return;
                if (S.editing || S._detailEditing) return;
                e.preventDefault();
                undo();
                return;
            }
            if (k === 'y' || (k === 'z' && e.shiftKey)) {
                if (isXsPromptOpen() || isDetailModalOpen()) return;
                if (S.editing || S._detailEditing) return;
                e.preventDefault();
                redo();
                return;
            }
        }
    });
    bindDetailModal();
    bindXsPrompt();
    bindCloseFindOnTableClick();
}

function bindTable() {
    var selAll = document.getElementById('selectAll');
    if (selAll) selAll.addEventListener('click', toggleSelectAll);
    document.querySelectorAll('input[type="checkbox"][data-row]').forEach(function (cb) {
        cb.addEventListener('click', toggleRowSelection);
    });
    document.querySelectorAll('.xs-editable').forEach(function (cell) {
        cell.addEventListener('dblclick', onCellDblClick);
        cell.addEventListener('click', selectCell);
    });
    // 明细链接：单击打开弹窗
    document.querySelectorAll('.xs-detail-link').forEach(function (a) {
        a.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var ri = parseInt(a.getAttribute('data-detail-row'), 10);
            var ci = parseInt(a.getAttribute('data-detail-col'), 10);
            var headers = (S.data && S.data.headers) || [];
            var field = (!isNaN(ci) && headers[ci] !== undefined) ? headers[ci] : '';
            openDetailModal(ri, field);
        });
    });
    // 右键菜单：表头/行号/单元格 都支持
    document.querySelectorAll('.xs-table th, .xs-table td').forEach(function (el) {
        el.addEventListener('contextmenu', showContextMenu);
    });
    // 列宽拖动
    document.querySelectorAll('.xs-resizer').forEach(function (rz) {
        rz.addEventListener('mousedown', startColResize);
    });
    // 列拖动排序（拖表头）
    document.querySelectorAll('th.xs-th[data-col]').forEach(function (th) {
        th.addEventListener('dragstart', onColDragStart);
        th.addEventListener('dragover', onColDragOver);
        th.addEventListener('drop', onColDrop);
    });
    // 行拖动排序（拖整行）
    document.querySelectorAll('tr[data-row]').forEach(function (tr) {
        tr.addEventListener('dragstart', onRowDragStart);
        tr.addEventListener('dragover', onRowDragOver);
        tr.addEventListener('drop', onRowDrop);
    });
}

// ==================== 行选/全选 ====================
function toggleSelectAll(e) {
    var checked = e.target.checked;
    S.sel.clear();
    if (checked) (S.data.rows || []).forEach(function (_, i) { S.sel.add(i); });
    document.querySelectorAll('input[type="checkbox"][data-row]').forEach(function (cb) {
        cb.checked = checked;
        var tr = cb.closest('tr');
        if (tr) tr.classList.toggle('selected', checked);
    });
    updateSelectionInfo();
    updatePushBtn();
}

function toggleRowSelection(e) {
    var ri = parseInt(e.target.getAttribute('data-row'), 10);
    if (e.target.checked) S.sel.add(ri); else S.sel.delete(ri);
    var tr = e.target.closest('tr');
    if (tr) tr.classList.toggle('selected', e.target.checked);
    updateSelectionInfo();
    updatePushBtn();
}

function updateSelectionInfo() {
    var info = document.getElementById('selInfo');
    if (info) info.textContent = '已选 ' + S.sel.size + ' 行，共 ' + (S.data.rows || []).length + ' 行';
}

function updatePushBtn() {
    var btn = document.getElementById('pushBtn');
    if (!btn) return;
    btn.disabled = S.sel.size === 0;
}

function updateModInfo() {
    var box = document.getElementById('modInfo');
    var cnt = document.getElementById('modCount');
    if (cnt) cnt.textContent = String(S.mods.size);
    if (box) box.style.display = S.mods.size > 0 ? '' : 'none';
}

// ==================== 单元格编辑 ====================
function selectCell(e) {
    var td = e.currentTarget;
    document.querySelectorAll('.xs-editable.active').forEach(function (n) { n.classList.remove('active'); });
    td.classList.add('active');
    S.cell = { r: parseInt(td.getAttribute('data-row'), 10), c: parseInt(td.getAttribute('data-col'), 10) };
}

function onCellDblClick(e) {
    var td = e.currentTarget;
    var ri = parseInt(td.getAttribute('data-row'), 10);
    var ci = parseInt(td.getAttribute('data-col'), 10);
    // 明细列：双击也打开弹窗，不进入编辑
    if (hasDetailRowsAtCol(ri, ci)) {
        e.preventDefault();
        e.stopPropagation();
        var headers = (S.data && S.data.headers) || [];
        var field = headers[ci] !== undefined ? headers[ci] : '';
        openDetailModal(ri, field);
        return;
    }
    startEdit(e);
}

function startEdit(e) {
    if (S.editing) return;
    var td = e.currentTarget;
    var ri = parseInt(td.getAttribute('data-row'), 10);
    var ci = parseInt(td.getAttribute('data-col'), 10);
    // 防御：行/列下标不合法时直接放弃编辑（如表格已被刷新/删除行列）
    if (isNaN(ri) || isNaN(ci) || !S.data || !Array.isArray(S.data.rows) || !S.data.rows[ri]) {
        return;
    }
    var oldVal = (S.data.rows[ri] && S.data.rows[ri][ci] !== undefined) ? S.data.rows[ri][ci] : '';
    var input = document.createElement('input');
    input.type = 'text';
    input.value = oldVal;
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();
    S.editing = true;

    function commit(save) {
        if (!S.editing) return;
        S.editing = false;
        // 二次防御：commit 时单元格可能因外部操作（删除行/列、重渲染）已失效
        var row = (S.data && Array.isArray(S.data.rows)) ? S.data.rows[ri] : undefined;
        if (!row || isNaN(ri) || isNaN(ci)) {
            return;
        }
        if (save) {
            var newVal = input.value;
            if (newVal !== oldVal) {
                pushHistory();
                row[ci] = newVal;
                S.mods.add(ri + ',' + ci);
                saveFile();
            }
        }
        var curVal = row[ci];
        td.innerHTML = '<div class="xs-cell-wrap">' + escapeHtml(formatCellValue(curVal)) + '</div>';
        if (S.mods.has(ri + ',' + ci)) td.classList.add('modified');
        // 同步刷新 tooltip
        var ftxt = formatCellValue(curVal);
        if (ftxt) td.setAttribute('title', ftxt); else td.removeAttribute('title');
        updateModInfo();
    }
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { commit(true); }
        else if (ev.key === 'Escape') { commit(false); }
    });
}

// ==================== 右键菜单 ====================
function showContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    var target = e.currentTarget;
    var rowAttr = target.getAttribute('data-row');
    var colAttr = target.getAttribute('data-col');
    S._ctxRow = rowAttr !== null && rowAttr !== undefined ? parseInt(rowAttr, 10) : -1;
    S._ctxCol = colAttr !== null && colAttr !== undefined ? parseInt(colAttr, 10) : -1;

    var isHeader = target.tagName === 'TH';
    var items = [];
    if (isHeader) {
        items.push({ label: '在左侧插入列', action: function () { insertCol(S._ctxCol); } });
        items.push({ label: '在右侧插入列', action: function () { insertCol(S._ctxCol + 1); } });
        items.push({ divider: true });
        items.push({ label: '删除该列', action: function () { deleteCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
        items.push({ label: '重命名列', action: function () { renameCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
    } else {
        // 推送：选中行 > 0 时优先推送选中行，否则推送当前右键所在行
        var pushCount = S.sel.size > 0 ? S.sel.size : (S._ctxRow >= 0 ? 1 : 0);
        var pushLabel = pushCount > 0
            ? '推送测试案例 (' + pushCount + ')'
            : '推送测试案例';
        items.push({ label: pushLabel, action: pushFromContextMenu, disabled: pushCount === 0 });
        items.push({ divider: true });
        items.push({ label: '复制单元格', action: copyCell, disabled: S._ctxRow < 0 || S._ctxCol < 0 });
        items.push({ label: '粘贴单元格', action: pasteCell, disabled: S.clip === null || S.clip === undefined || S._ctxRow < 0 });
        items.push({ label: '清空单元格', action: clearCell, disabled: S._ctxCol < 0 });
        items.push({ divider: true });
        items.push({ label: '在下方复制此行', action: copyRowInline, disabled: S._ctxRow < 0 });
        items.push({ label: '在上方插入行', action: function () { insertRow(S._ctxRow); }, disabled: S._ctxRow < 0 });
        items.push({ label: '在下方插入行', action: function () { insertRow(S._ctxRow + 1); }, disabled: S._ctxRow < 0 });
        items.push({ divider: true });
        items.push({ label: '插入列（左侧）', action: function () { insertCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
        items.push({ label: '插入列（右侧）', action: function () { insertCol(S._ctxCol + 1); }, disabled: S._ctxCol < 0 });
        items.push({ label: '重命名列', action: function () { renameCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
        items.push({ label: '删除该列', action: function () { deleteCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
        items.push({ divider: true });
        items.push({ label: '删除该行', action: function () { deleteRow(S._ctxRow); }, disabled: S._ctxRow < 0 });
        if (S.sel.size > 0) {
            items.push({ label: '删除选中行 (' + S.sel.size + ')', action: deleteSelectedRows });
        }
    }

    var menu = document.getElementById('ctxMenu');
    if (!menu) return;
    var html = '';
    items.forEach(function (it) {
        if (it.divider) html += '<div class="xs-div"></div>';
        else html += '<div class="xs-mi' + (it.disabled ? ' disabled' : '') + '" data-key="' + escapeHtml(it.label) + '">' + escapeHtml(it.label) + '</div>';
    });
    menu.innerHTML = html;
    menu.style.display = 'block';
    var x = e.clientX, y = e.clientY;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    // 防止超出视口
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

    // 绑定项点击
    menu.querySelectorAll('.xs-mi').forEach(function (mi, idx) {
        var realIdx = -1, walker = 0;
        // 找到对应 items 中的索引（跳过 divider）
        for (var i = 0; i < items.length; i++) {
            if (items[i].divider) continue;
            if (walker === idx) { realIdx = i; break; }
            walker++;
        }
        mi.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var item = items[realIdx];
            if (!item || item.disabled) return;
            hideContextMenu();
            try { item.action(); } catch (err) { console.error(err); }
        });
    });
}

function hideContextMenu() {
    var menu = document.getElementById('ctxMenu');
    if (menu) menu.style.display = 'none';
}

// ==================== 行/列 操作 ====================
function insertRow(at) {
    var width = (S.data.headers || []).length;
    var newRow = new Array(width).fill('');
    if (at < 0) at = 0;
    if (at > S.data.rows.length) at = S.data.rows.length;
    pushHistory();
    S.data.rows.splice(at, 0, newRow);
    // 更新选中集合（被插入位置之后的索引整体+1）
    var ns = new Set();
    S.sel.forEach(function (i) { ns.add(i >= at ? i + 1 : i); });
    S.sel = ns;
    saveFile();
    renderTable();
}

function deleteRow(ri) {
    if (ri < 0 || ri >= S.data.rows.length) return;
    pushHistory();
    S.data.rows.splice(ri, 1);
    var ns = new Set();
    S.sel.forEach(function (i) { if (i !== ri) ns.add(i > ri ? i - 1 : i); });
    S.sel = ns;
    saveFile();
    renderTable();
}

function deleteSelectedRows() {
    if (S.sel.size === 0) return;
    pushHistory();
    var sorted = Array.from(S.sel).sort(function (a, b) { return b - a; });
    sorted.forEach(function (i) { S.data.rows.splice(i, 1); });
    S.sel.clear();
    saveFile();
    renderTable();
}

function insertCol(at) {
    var len = S.data.headers.length;
    if (at < 0) at = 0;
    if (at > len) at = len;
    var idx = at;
    xsPrompt('请输入新列名', '列' + (len + 1), function (name) {
        if (name === null) return;
        pushHistory();
        S.data.headers.splice(idx, 0, name);
        S.data.rows.forEach(function (row) { row.splice(idx, 0, ''); });
        saveFile();
        renderTable();
    });
}

function deleteCol(ci) {
    if (ci < 0 || ci >= S.data.headers.length) return;
    xsConfirm('确定删除该列？', function () {
        pushHistory();
        S.data.headers.splice(ci, 1);
        S.data.rows.forEach(function (row) { row.splice(ci, 1); });
        saveFile();
        renderTable();
    });
}

function renameCol(ci) {
    if (ci < 0 || ci >= S.data.headers.length) return;
    xsPrompt('重命名列', S.data.headers[ci], function (name) {
        if (name === null) return;
        pushHistory();
        S.data.headers[ci] = name;
        saveFile();
        renderTable();
    });
}

function copyCell() {
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    S.clip = (S.data.rows[S._ctxRow] && S.data.rows[S._ctxRow][S._ctxCol]) || '';
    showToast('已复制', 'success');
}

function pasteCell() {
    if (S.clip === null || S.clip === undefined) return;
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    pushHistory();
    S.data.rows[S._ctxRow][S._ctxCol] = S.clip;
    S.mods.add(S._ctxRow + ',' + S._ctxCol);
    saveFile();
    renderTable();
}

function clearCell() {
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    pushHistory();
    S.data.rows[S._ctxRow][S._ctxCol] = '';
    S.mods.add(S._ctxRow + ',' + S._ctxCol);
    saveFile();
    renderTable();
}

function copyRow() {
    // 兼容保留：当前菜单已合并为一步式 copyRowInline，可通过 Ctrl+C 行级扩展使用
    if (S._ctxRow < 0 || S._ctxRow >= S.data.rows.length) return;
    var row = S.data.rows[S._ctxRow] || [];
    S.rowClip = row.slice();
    var dt = S.data.detailTable;
    if (dt && dt.rowGroups && dt.rowGroups[S._ctxRow]) {
        S.rowClipDetail = (dt.rowGroups[S._ctxRow] || []).map(function (dr) { return dr.slice(); });
        S.rowClipDetailRaw = (dt.rawRowGroups && dt.rawRowGroups[S._ctxRow])
            ? JSON.parse(JSON.stringify(dt.rawRowGroups[S._ctxRow])) : [];
    } else {
        S.rowClipDetail = null;
        S.rowClipDetailRaw = null;
    }
}

// 一步式复制：在当前行下方直接插入一份副本
function copyRowInline() {
    if (S._ctxRow < 0 || S._ctxRow >= S.data.rows.length) return;
    pushHistory();
    var src = S.data.rows[S._ctxRow] || [];
    var at = S._ctxRow + 1;
    var newRow = src.slice();
    S.data.rows.splice(at, 0, newRow);
    // 同步复制所有明细表的行
    var dts = getDetailTables();
    dts.forEach(function (dt) {
        if (!dt || !dt.rowGroups) return;
        var srcDetail = (dt.rowGroups[S._ctxRow] || []).map(function (dr) { return dr.slice(); });
        var srcRaw = (dt.rawRowGroups && dt.rawRowGroups[S._ctxRow])
            ? JSON.parse(JSON.stringify(dt.rawRowGroups[S._ctxRow])) : [];
        dt.rowGroups.splice(at, 0, srcDetail);
        if (dt.rawRowGroups) dt.rawRowGroups.splice(at, 0, srcRaw);
        if (dt.rawRowTypes) {
            var srcType = dt.rawRowTypes[S._ctxRow] || 'none';
            dt.rawRowTypes.splice(at, 0, srcType);
        }
    });
    // 同步选中集下移
    var ns = new Set();
    S.sel.forEach(function (i) { ns.add(i >= at ? i + 1 : i); });
    S.sel = ns;
    saveFile();
    renderTable();
    showToast('已在下方复制一行', 'success');
}

function pushFromContextMenu() {
    var headers = S.data.headers || [];
    // 优先推送选中行（支持多行）；如未选中，则推送右键所在行
    var indices = [];
    if (S.sel.size > 0) {
        indices = Array.from(S.sel).sort(function (a, b) { return a - b; });
    } else if (S._ctxRow >= 0) {
        indices = [S._ctxRow];
    } else {
        return;
    }
    var payload = indices.map(function (ri) {
        var record = {};
        var row = S.data.rows[ri] || [];
        headers.forEach(function (h, i) { record[h] = row[i] === undefined ? '' : row[i]; });
        return record;
    });
    S.vscode.postMessage({ type: 'pushTestCase', data: payload });
}

// ==================== 列宽拖动 ====================
function startColResize(e) {
    e.preventDefault();
    e.stopPropagation();
    var col = parseInt(e.currentTarget.getAttribute('data-col'), 10);
    var th = e.currentTarget.parentElement;
    var startX = e.clientX;
    var startW = th.offsetWidth;

    function onMove(ev) {
        var w = Math.max(40, startW + (ev.clientX - startX));
        S.colWidths[col] = w;
        var colEl = document.querySelector('.xs-table colgroup col:nth-child(' + (col + 2) + ')');
        if (colEl) colEl.style.width = w + 'px';
    }
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ==================== 列拖动排序 ====================
var _colDragFrom = -1;
function onColDragStart(e) {
    _colDragFrom = parseInt(e.currentTarget.getAttribute('data-col'), 10);
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'col'); } catch (_) {} }
}
function onColDragOver(e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }
function onColDrop(e) {
    e.preventDefault();
    var to = parseInt(e.currentTarget.getAttribute('data-col'), 10);
    if (_colDragFrom < 0 || _colDragFrom === to) return;
    pushHistory();
    var hdr = S.data.headers.splice(_colDragFrom, 1)[0];
    S.data.headers.splice(to, 0, hdr);
    S.data.rows.forEach(function (row) {
        var v = row.splice(_colDragFrom, 1)[0];
        row.splice(to, 0, v);
    });
    _colDragFrom = -1;
    saveFile();
    renderTable();
}

// ==================== 行拖动排序 ====================
var _rowDragFrom = -1;
function onRowDragStart(e) {
    _rowDragFrom = parseInt(e.currentTarget.getAttribute('data-row'), 10);
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'row'); } catch (_) {} }
}
function onRowDragOver(e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }
function onRowDrop(e) {
    e.preventDefault();
    var to = parseInt(e.currentTarget.getAttribute('data-row'), 10);
    if (_rowDragFrom < 0 || _rowDragFrom === to) return;
    pushHistory();
    var row = S.data.rows.splice(_rowDragFrom, 1)[0];
    S.data.rows.splice(to, 0, row);
    _rowDragFrom = -1;
    S.sel.clear();
    saveFile();
    renderTable();
}

// ==================== 推送 / 保存 ====================
function pushChanges() {
    if (S.sel.size === 0) { showToast('请先选择需要推送的行', 'error'); return; }
    var headers = S.data.headers || [];
    var picked = Array.from(S.sel).sort(function (a, b) { return a - b; });
    var payload = picked.map(function (ri) {
        var record = {};
        var row = S.data.rows[ri] || [];
        headers.forEach(function (h, i) { record[h] = row[i] === undefined ? '' : row[i]; });
        return record;
    });
    S.vscode.postMessage({ type: 'pushTestCase', data: payload });
}

function saveFile() {
    if (!S.vscode) return;
    S.vscode.postMessage({ type: 'save', data: S.data });
}

// ==================== 查找 / 搜索 ====================
function openFindPanel() {
    var p = document.getElementById('findPanel');
    if (!p) return;
    if (!p.classList.contains('show')) p.classList.add('show');
    var fi = document.getElementById('findInput');
    var top = document.getElementById('searchInput');
    if (fi && top && top.value && !fi.value) fi.value = top.value;
    if (fi) {
        fi.focus(); fi.select();
        rebuildFindMatches(fi.value || '');
        updateFindInfo();
        focusActiveMatch();
    }
}

function closeFindPanel() {
    var p = document.getElementById('findPanel');
    if (!p) return;
    if (p.classList.contains('show')) p.classList.remove('show');
    clearFindHighlight();
    S._matches = [];
    S._matchIdx = -1;
    S._findKw = '';
    updateFindInfo();
}

function toggleFindPanel() {
    var p = document.getElementById('findPanel');
    if (!p) return;
    if (p.classList.contains('show')) closeFindPanel();
    else openFindPanel();
}

// 点击表格区域（不包括查找面板本身）时关闭查找面板
function bindCloseFindOnTableClick() {
    if (S._findCloseBound) return;
    S._findCloseBound = true;
    var tbl = document.getElementById('tableContainer');
    if (!tbl) return;
    tbl.addEventListener('mousedown', function (e) {
        var p = document.getElementById('findPanel');
        if (!p || !p.classList.contains('show')) return;
        // 点击发生在面板内部不关闭
        if (p.contains(e.target)) return;
        closeFindPanel();
    });
}

// 顶部 searchInput：过滤未命中的行
function onSearch(e) {
    S._searchKw = (e.target.value || '');
    renderTable();
}

// 重新构建命中列表 + 渲染高亮
function rebuildFindMatches(kw) {
    S._findKw = kw || '';
    S._matches = [];
    S._matchIdx = -1;
    clearFindHighlight();
    if (!S._findKw) return;
    var lower = S._findKw.toLowerCase();
    var rows = (S.data && S.data.rows) || [];
    var headers = (S.data && S.data.headers) || [];
    rows.forEach(function (row, ri) {
        headers.forEach(function (_, ci) {
            var v = row[ci];
            if (v === null || v === undefined) return;
            if (String(v).toLowerCase().indexOf(lower) >= 0) {
                S._matches.push({ r: ri, c: ci });
            }
        });
    });
    if (S._matches.length > 0) S._matchIdx = 0;
    paintFindHighlight();
}

// 在所有命中单元格添加 highlight 类，并将文本 mark 替换
function paintFindHighlight() {
    if (!S._findKw) return;
    var matchesByCell = {};
    S._matches.forEach(function (m, idx) { matchesByCell[m.r + ',' + m.c] = idx; });
    var tds = document.querySelectorAll('td.xs-editable');
    tds.forEach(function (td) {
        var ri = td.getAttribute('data-row');
        var ci = td.getAttribute('data-col');
        if (ri === null || ci === null) return;
        var key = ri + ',' + ci;
        if (matchesByCell.hasOwnProperty(key)) {
            td.classList.add('highlight');
            var idx = matchesByCell[key];
            if (idx === S._matchIdx) td.classList.add('highlight-active');
            // 在 cell-wrap 文本内做 mark 高亮
            var wrap = td.querySelector('.xs-cell-wrap');
            if (wrap) markText(wrap, S._findKw, idx === S._matchIdx);
        }
    });
}

function markText(node, kw, isActive) {
    if (!kw) return;
    var text = node.textContent || '';
    if (!text) return;
    var lower = text.toLowerCase();
    var lkw = kw.toLowerCase();
    var html = '';
    var i = 0;
    while (i < text.length) {
        var hit = lower.indexOf(lkw, i);
        if (hit < 0) { html += escapeHtml(text.slice(i)); break; }
        html += escapeHtml(text.slice(i, hit));
        var cls = isActive ? 'xs-mk xs-mk-active' : 'xs-mk';
        html += '<mark class="' + cls + '">' + escapeHtml(text.slice(hit, hit + kw.length)) + '</mark>';
        i = hit + kw.length;
    }
    // 如果单元格内是 detail 链接，跳过 mark（保留链接结构）
    var detailSpan = node.querySelector('.xs-detail-link');
    if (detailSpan) return;
    node.innerHTML = html;
}

function clearFindHighlight() {
    document.querySelectorAll('td.xs-editable.highlight').forEach(function (td) {
        td.classList.remove('highlight', 'highlight-active');
        var wrap = td.querySelector('.xs-cell-wrap');
        if (wrap && !wrap.querySelector('.xs-detail-link')) {
            // 还原为纯文本
            wrap.innerHTML = escapeHtml(wrap.textContent || '');
        }
    });
}

function stepFind(dir) {
    if (S._matches.length === 0) {
        // 重新尝试构建一次（用户可能在面板中没触发 input）
        var fi = document.getElementById('findInput');
        rebuildFindMatches(fi ? (fi.value || '') : '');
    }
    if (S._matches.length === 0) { showToast('没有找到匹配项', 'error'); return; }
    S._matchIdx = (S._matchIdx + dir + S._matches.length) % S._matches.length;
    clearFindHighlight();
    paintFindHighlight();
    updateFindInfo();
    focusActiveMatch();
}

function focusActiveMatch() {
    if (S._matchIdx < 0 || S._matchIdx >= S._matches.length) return;
    var m = S._matches[S._matchIdx];
    var td = document.querySelector('td.xs-editable[data-row="' + m.r + '"][data-col="' + m.c + '"]');
    if (td && td.scrollIntoView) td.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function updateFindInfo() {
    var info = document.getElementById('findInfo');
    if (!info) return;
    if (!S._findKw) { info.textContent = ''; return; }
    if (S._matches.length === 0) info.textContent = '无匹配';
    else info.textContent = (S._matchIdx + 1) + ' / ' + S._matches.length;
}

function replaceCurrent() {
    if (S._matchIdx < 0 || S._matchIdx >= S._matches.length) {
        showToast('没有可替换项', 'error'); return;
    }
    var rep = document.getElementById('replaceInput');
    var newVal = rep ? rep.value : '';
    var m = S._matches[S._matchIdx];
    var oldCell = String(S.data.rows[m.r][m.c] === undefined ? '' : S.data.rows[m.r][m.c]);
    // 仅替换该单元格中第一处匹配（按用户预期：单步替换）
    var lower = oldCell.toLowerCase();
    var lkw = S._findKw.toLowerCase();
    var hit = lower.indexOf(lkw);
    if (hit < 0) { stepFind(1); return; }
    var newCell = oldCell.slice(0, hit) + newVal + oldCell.slice(hit + S._findKw.length);
    pushHistory();
    S.data.rows[m.r][m.c] = newCell;
    S.mods.add(m.r + ',' + m.c);
    saveFile();
    renderTable();
    // 重新搜索（单元格内可能还有其他命中）
    rebuildFindMatches(S._findKw);
    if (S._matches.length === 0) {
        // 所有匹配都已替换完，关闭面板
        showToast('已完成替换', 'success');
        closeFindPanel();
        return;
    }
    if (S._matchIdx >= S._matches.length) S._matchIdx = 0;
    clearFindHighlight();
    paintFindHighlight();
    updateFindInfo();
    focusActiveMatch();
}

function replaceAll() {
    if (!S._findKw) { showToast('请输入查找内容', 'error'); return; }
    var rep = document.getElementById('replaceInput');
    var newVal = rep ? rep.value : '';
    var lkw = S._findKw.toLowerCase();
    var count = 0;
    pushHistory();
    (S.data.rows || []).forEach(function (row, ri) {
        (S.data.headers || []).forEach(function (_, ci) {
            var v = row[ci];
            if (v === null || v === undefined) return;
            var s = String(v);
            if (s.toLowerCase().indexOf(lkw) < 0) return;
            // 全部替换（大小写不敏感）
            var out = '';
            var i = 0;
            var lo = s.toLowerCase();
            while (i < s.length) {
                var h = lo.indexOf(lkw, i);
                if (h < 0) { out += s.slice(i); break; }
                out += s.slice(i, h) + newVal;
                i = h + S._findKw.length;
                count++;
            }
            row[ci] = out;
            S.mods.add(ri + ',' + ci);
        });
    });
    if (count === 0) { showToast('没有找到匹配项', 'error'); return; }
    saveFile();
    renderTable();
    showToast('已替换 ' + count + ' 处', 'success');
    // 替换全部完成后关闭查找面板
    closeFindPanel();
}

// ==================== 工具函数 ====================
function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatCellValue(v) { return v === null || v === undefined ? '' : String(v); }
function showToast(msg, type) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'xs-toast ' + (type || '');
    t.style.display = 'block';
    setTimeout(function () { t.style.display = 'none'; }, 2000);
}

// ==================== 通用 Prompt / Confirm 弹窗 ====================
// 替代受 vscode webview sandbox 限制的 window.prompt / window.confirm
function bindXsPrompt() {
    if (S._xsPromptBound) return;
    S._xsPromptBound = true;
    var modal = document.getElementById('xsPromptModal');
    var ok = document.getElementById('xsPromptOk');
    var cancel = document.getElementById('xsPromptCancel');
    var close = document.getElementById('xsPromptClose');
    var input = document.getElementById('xsPromptInput');
    if (!modal || !ok || !cancel || !close) return;
    ok.addEventListener('click', function () { closeXsPrompt(true); });
    cancel.addEventListener('click', function () { closeXsPrompt(false); });
    close.addEventListener('click', function () { closeXsPrompt(false); });
    modal.addEventListener('click', function (e) { if (e.target === modal) closeXsPrompt(false); });
    if (input) input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); closeXsPrompt(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); closeXsPrompt(false); }
        ev.stopPropagation();
    });
}

function isXsPromptOpen() {
    var modal = document.getElementById('xsPromptModal');
    return !!(modal && modal.classList.contains('show'));
}

function closeXsPrompt(confirmed) {
    var modal = document.getElementById('xsPromptModal');
    if (!modal) return;
    modal.classList.remove('show');
    var input = document.getElementById('xsPromptInput');
    var cb = S._xsPromptCb;
    var mode = S._xsPromptMode;
    var val = input ? input.value : '';
    S._xsPromptCb = null;
    S._xsPromptMode = null;
    if (typeof cb === 'function') {
        if (mode === 'confirm') {
            if (confirmed) cb();
        } else {
            cb(confirmed ? val : null);
        }
    }
}

// xsPrompt(title, defaultValue, onOk(value|null))
function xsPrompt(title, defaultValue, onOk) {
    var modal = document.getElementById('xsPromptModal');
    var titleEl = document.getElementById('xsPromptTitle');
    var input = document.getElementById('xsPromptInput');
    var footer = modal ? modal.querySelector('.xs-modal-footer') : null;
    if (!modal || !input) { onOk(window.prompt(title, defaultValue)); return; }
    if (titleEl) titleEl.textContent = title || '请输入';
    input.style.display = '';
    input.value = defaultValue === undefined || defaultValue === null ? '' : String(defaultValue);
    if (footer) footer.style.display = '';
    S._xsPromptMode = 'prompt';
    S._xsPromptCb = onOk;
    modal.classList.add('show');
    setTimeout(function () { input.focus(); input.select(); }, 0);
}

// xsConfirm(title, onOk())
function xsConfirm(title, onOk) {
    var modal = document.getElementById('xsPromptModal');
    var titleEl = document.getElementById('xsPromptTitle');
    var input = document.getElementById('xsPromptInput');
    if (!modal) { if (window.confirm(title)) onOk(); return; }
    if (titleEl) titleEl.textContent = title || '确认';
    if (input) input.style.display = 'none';
    S._xsPromptMode = 'confirm';
    S._xsPromptCb = onOk;
    modal.classList.add('show');
    var ok = document.getElementById('xsPromptOk');
    if (ok) setTimeout(function () { ok.focus(); }, 0);
}

// ==================== 明细弹窗 ====================
// 返回所有明细表（同时兼容老的单字段 detailTable）
function getDetailTables() {
    if (!S.data) return [];
    if (Array.isArray(S.data.detailTables) && S.data.detailTables.length > 0) {
        return S.data.detailTables;
    }
    if (S.data.detailTable && S.data.detailTable.field) {
        return [S.data.detailTable];
    }
    return [];
}

function getDetailTableByField(field) {
    var ts = getDetailTables();
    for (var i = 0; i < ts.length; i++) {
        if (ts[i] && ts[i].field === field) return ts[i];
    }
    return null;
}

function getDetailTableByCol(ci) {
    var headers = (S.data && S.data.headers) || [];
    var name = headers[ci];
    if (name === undefined) return null;
    return getDetailTableByField(name);
}

function getCurrentDetailTable() {
    return getDetailTableByField(S._detailField);
}

function isDetailColumn(ci) {
    return !!getDetailTableByCol(ci);
}

function hasDetailRows(ri) {
    var ts = getDetailTables();
    for (var i = 0; i < ts.length; i++) {
        var dt = ts[i];
        if (!dt || !dt.rowGroups) continue;
        var g = dt.rowGroups[ri];
        if (Array.isArray(g) && g.length > 0) return true;
    }
    return false;
}

// 判断某列在某主行上是否有可点开的明细
function hasDetailRowsAtCol(ri, ci) {
    var dt = getDetailTableByCol(ci);
    if (!dt || !dt.rowGroups) return false;
    var g = dt.rowGroups[ri];
    return Array.isArray(g) && g.length > 0;
}

function isDetailModalOpen() {
    var m = document.getElementById('detailModal');
    return !!(m && m.classList.contains('show'));
}

function bindDetailModal() {
    var close = document.getElementById('detailModalClose');
    var copy = document.getElementById('detailCopyBtn');
    if (copy) copy.addEventListener('click', copyDetailRow);
    var cancel = document.getElementById('detailCancelBtn');
    var save = document.getElementById('detailSaveBtn');
    var add = document.getElementById('detailAddBtn');
    if (close) close.addEventListener('click', closeDetailModal);
    if (cancel) cancel.addEventListener('click', closeDetailModal);
    if (save) save.addEventListener('click', saveDetailModal);
    if (add) add.addEventListener('click', function () { insertDetailRow(false); });
    var overlay = document.getElementById('detailModal');
    if (overlay) overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeDetailModal();
    });
}

function openDetailModal(ri, field) {
    // 未传 field 时后兼容：取第一个在该行有明细的字段
    if (!field) {
        var ts = getDetailTables();
        for (var i = 0; i < ts.length; i++) {
            var t = ts[i];
            if (!t || !t.rowGroups) continue;
            var g = t.rowGroups[ri];
            if (Array.isArray(g) && g.length > 0) { field = t.field; break; }
        }
    }
    var dt = getDetailTableByField(field);
    if (!dt || !dt.rowGroups) return;
    S._detailField = field;
    S._detailRowIdx = ri;
    S._detailMods = new Set();
    S._detailSel = new Set();
    // 快照备份，取消时还原，避免修改后被意外保留
    try {
        S._detailBackup = {
            rows: JSON.parse(JSON.stringify(dt.rowGroups[ri] || [])),
            raws: dt.rawRowGroups ? JSON.parse(JSON.stringify(dt.rawRowGroups[ri] || [])) : null
        };
    } catch (err) {
        S._detailBackup = null;
    }
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    var title = document.getElementById('detailModalTitle');
    if (title) {
        var typeTag = rawType === 'object' ? '（嵌套对象）' : '';
        title.textContent = (dt.fieldDisplay || dt.field || '明细') + typeTag + ' - 第 ' + (ri + 1) + ' 行';
    }
    // 嵌套对象类型禁用"复制行/添加行"，对象只能有一行子表
    var isObj = rawType === 'object';
    var copyBtn = document.getElementById('detailCopyBtn');
    var addBtn = document.getElementById('detailAddBtn');
    if (copyBtn) copyBtn.style.display = isObj ? 'none' : '';
    if (addBtn) addBtn.style.display = isObj ? 'none' : '';
    renderDetailTable();
    var m = document.getElementById('detailModal');
    if (m) m.classList.add('show');
    updateDetailModInfo();
}

// discard 默认 true（取消/Esc/点遮罩均丢弃修改）；saveDetailModal 会传 false
function closeDetailModal(discard) {
    if (discard === undefined) discard = true;
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (discard && dt && ri >= 0 && S._detailBackup) {
        // 还原快照
        dt.rowGroups[ri] = S._detailBackup.rows;
        if (dt.rawRowGroups && S._detailBackup.raws) dt.rawRowGroups[ri] = S._detailBackup.raws;
    }
    var m = document.getElementById('detailModal');
    if (m) m.classList.remove('show');
    S._detailField = '';
    S._detailRowIdx = -1;
    S._detailMods.clear();
    S._detailSel.clear();
    S._detailBackup = null;
}

function renderDetailTable() {
    var body = document.getElementById('detailModalBody');
    var dt = getCurrentDetailTable();
    if (!body || !dt) return;
    var ri = S._detailRowIdx;
    var dh = dt.headers || [];
    var rows = (dt.rowGroups && dt.rowGroups[ri]) || [];

    var html = '<table class="xs-detail-table"><thead><tr>';
    html += '<th class="xs-detail-row-cb">#</th>';
    dh.forEach(function (h) { html += '<th>' + escapeHtml(String(h)) + '</th>'; });
    var isObj = (dt.rawRowTypes && dt.rawRowTypes[ri]) === 'object';
    if (!isObj) html += '<th class="xs-detail-row-op">操作</th>';
    html += '</tr></thead><tbody>';
    rows.forEach(function (row, di) {
        html += '<tr data-drow="' + di + '">';
        // 行号列（不再内嵌删除按钮）
        html += '<td class="xs-detail-row-cb">'
            + '<span class="xs-detail-rownum">' + (di + 1) + '</span>'
            + '</td>';
        dh.forEach(function (_, ci) {
            var v = row[ci];
            var modCls = S._detailMods.has(di + ',' + ci) ? ' modified' : '';
            html += '<td class="xs-editable' + modCls + '" data-drow="' + di + '" data-dcol="' + ci + '">'
                + escapeHtml(formatCellValue(v)) + '</td>';
        });
        // 末尾操作列：删除按钮（嵌套对象不提供，防止误删）
        if (!isObj) {
            html += '<td class="xs-detail-row-op">'
                + '<span class="xs-detail-rowdel" title="删除该行" data-drow="' + di + '">×</span>'
                + '</td>';
        }
        html += '</tr>';
    });
    html += '</tbody></table>';
    body.innerHTML = html;

    // 绑定事件
    body.querySelectorAll('.xs-detail-rowdel').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var di = parseInt(btn.getAttribute('data-drow'), 10);
            if (!isNaN(di)) deleteDetailRow(di);
        });
    });
    body.querySelectorAll('td.xs-editable').forEach(function (td) {
        td.addEventListener('dblclick', startDetailEdit);
        td.addEventListener('click', function () {
            body.querySelectorAll('td.xs-editable.active').forEach(function (n) { n.classList.remove('active'); });
            td.classList.add('active');
        });
        td.addEventListener('contextmenu', showDetailContextMenu);
        // tooltip：明细单元格完整原始值
        var fullText = td.textContent || '';
        if (fullText) td.setAttribute('title', fullText);
    });
}

function startDetailEdit(e) {
    if (S._detailEditing) return;
    var td = e.currentTarget;
    var di = parseInt(td.getAttribute('data-drow'), 10);
    var ci = parseInt(td.getAttribute('data-dcol'), 10);
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    if (isNaN(di) || isNaN(ci)) return;
    var rowsArr = (dt.rowGroups && dt.rowGroups[ri]) || null;
    if (!rowsArr || !rowsArr[di]) return;
    var oldVal = (rowsArr[di][ci] !== undefined) ? rowsArr[di][ci] : '';
    var input = document.createElement('input');
    input.type = 'text';
    input.value = oldVal;
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();
    S._detailEditing = true;

    function commit(save) {
        if (!S._detailEditing) return;
        S._detailEditing = false;
        // 二次防御：明细行可能因外部操作（删除/重渲染）已失效
        var curRows = (dt && dt.rowGroups) ? dt.rowGroups[ri] : null;
        var curRow = curRows ? curRows[di] : null;
        if (!curRow || isNaN(di) || isNaN(ci)) return;
        if (save) {
            var newVal = input.value;
            if (newVal !== oldVal) {
                curRow[ci] = newVal;
                S._detailMods.add(di + ',' + ci);
            }
        }
        var curVal = curRow[ci];
        td.textContent = formatCellValue(curVal);
        if (S._detailMods.has(di + ',' + ci)) td.classList.add('modified');
        // 同步刷新 tooltip
        var ft = td.textContent || '';
        if (ft) td.setAttribute('title', ft); else td.removeAttribute('title');
        updateDetailModInfo();
    }
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { commit(true); }
        else if (ev.key === 'Escape') { commit(false); }
    });
}

function showDetailContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    var td = e.currentTarget;
    var di = parseInt(td.getAttribute('data-drow'), 10);
    var menu = document.getElementById('ctxMenu');
    if (!menu) return;
    var items = [
        { label: '复制该行', action: function () { copyDetailRowAt(di); } },
        { divider: true },
        { label: '删除该行', action: function () { deleteDetailRow(di); } }
    ];
    var html = '';
    items.forEach(function (it) {
        if (it.divider) html += '<div class="xs-div"></div>';
        else html += '<div class="xs-mi" data-key="' + escapeHtml(it.label) + '">' + escapeHtml(it.label) + '</div>';
    });
    menu.innerHTML = html;
    menu.style.display = 'block';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

    menu.querySelectorAll('.xs-mi').forEach(function (mi, idx) {
        var realIdx = -1, walker = 0;
        for (var i = 0; i < items.length; i++) {
            if (items[i].divider) continue;
            if (walker === idx) { realIdx = i; break; }
            walker++;
        }
        mi.addEventListener('click', function (ev) {
            ev.stopPropagation();
            hideContextMenu();
            try { items[realIdx].action(); } catch (err) { console.error(err); }
        });
    });
}

function insertDetailRow(beforeFirst) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    if (rawType === 'object') { showToast('嵌套对象不支持多行', 'error'); return; }
    if (!dt.rowGroups[ri]) dt.rowGroups[ri] = [];
    var at = beforeFirst ? 0 : dt.rowGroups[ri].length;
    insertDetailRowAt(at);
}

/**
 * 复制单行到其下方（用于明细右键菜单"复制该行"）。
 */
function copyDetailRowAt(di) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0 || !dt.rowGroups[ri]) return;
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    if (rawType === 'object') { showToast('嵌套对象不支持多行', 'error'); return; }
    var rows = dt.rowGroups[ri];
    if (di < 0 || di >= rows.length) return;
    var headers = dt.headers || [];
    var srcRow = rows[di] || [];
    var newRow = headers.map(function (_, ci) { return srcRow[ci] !== undefined ? srcRow[ci] : ''; });
    rows.splice(di + 1, 0, newRow);
    if (dt.rawRowGroups) {
        if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
        var srcRaw = dt.rawRowGroups[ri][di];
        try {
            dt.rawRowGroups[ri].splice(di + 1, 0, srcRaw ? JSON.parse(JSON.stringify(srcRaw)) : {});
        } catch (e) {
            dt.rawRowGroups[ri].splice(di + 1, 0, {});
        }
    }
    // 已有修改集合的索引整体后移
    var ns = new Set();
    S._detailMods.forEach(function (k) {
        var p = k.split(','); var d = parseInt(p[0], 10); var c = parseInt(p[1], 10);
        ns.add((d > di ? d + 1 : d) + ',' + c);
    });
    // 新行整行标记为已修改
    for (var ci2 = 0; ci2 < headers.length; ci2++) ns.add((di + 1) + ',' + ci2);
    S._detailMods = ns;
    renderDetailTable();
    updateDetailModInfo();
}

/**
 * 复制明细行：优先复制选中的行（可多选，一起在末尾下方复制）；
 * 未选中时复制当前高亮单元格所在行；均无时复制末尾行。
 */
function copyDetailRow() {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    if (rawType === 'object') { showToast('嵌套对象不支持多行', 'error'); return; }
    var detailRows = dt.rowGroups[ri] || [];
    if (detailRows.length === 0) { showToast('没有可复制的行', 'error'); return; }

    // 收集要复制的源行索引
    var srcIdxList = [];
    if (S._detailSel && S._detailSel.size > 0) {
        S._detailSel.forEach(function (i) { srcIdxList.push(parseInt(i, 10)); });
        srcIdxList.sort(function (a, b) { return a - b; });
    } else {
        var active = document.querySelector('#detailModalBody td.xs-editable.active');
        if (active) {
            var di = parseInt(active.getAttribute('data-drow'), 10);
            if (!isNaN(di)) srcIdxList = [di];
        }
        if (srcIdxList.length === 0) srcIdxList = [detailRows.length - 1];
    }

    var headers = dt.headers || [];
    var insertAt = detailRows.length;
    srcIdxList.forEach(function (sIdx, k) {
        if (sIdx < 0 || sIdx >= detailRows.length) return;
        var srcRow = detailRows[sIdx] || [];
        var newRow = headers.map(function (_, ci) { return srcRow[ci] !== undefined ? srcRow[ci] : ''; });
        detailRows.splice(insertAt + k, 0, newRow);
        if (dt.rawRowGroups) {
            if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
            var srcRaw = dt.rawRowGroups[ri][sIdx];
            try {
                dt.rawRowGroups[ri].splice(insertAt + k, 0, srcRaw ? JSON.parse(JSON.stringify(srcRaw)) : {});
            } catch (e) {
                dt.rawRowGroups[ri].splice(insertAt + k, 0, {});
            }
        }
        // 复制出的新行标记为已修改
        for (var ci = 0; ci < headers.length; ci++) {
            S._detailMods.add((insertAt + k) + ',' + ci);
        }
    });
    S._detailSel.clear();
    renderDetailTable();
    updateDetailModInfo();
    showToast('已复制 ' + srcIdxList.length + ' 行', 'success');
}

function insertDetailRowAt(at) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    if (!dt.rowGroups[ri]) dt.rowGroups[ri] = [];
    if (at < 0) at = 0;
    if (at > dt.rowGroups[ri].length) at = dt.rowGroups[ri].length;
    var newRow = (dt.headers || []).map(function () { return ''; });
    dt.rowGroups[ri].splice(at, 0, newRow);
    if (dt.rawRowGroups) {
        if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
        dt.rawRowGroups[ri].splice(at, 0, {});
    }
    // 修改集合的索引整体后移
    var ns = new Set();
    S._detailMods.forEach(function (k) {
        var p = k.split(','); var d = parseInt(p[0], 10); var c = parseInt(p[1], 10);
        ns.add((d >= at ? d + 1 : d) + ',' + c);
    });
    S._detailMods = ns;
    renderDetailTable();
    updateDetailModInfo();
}

function deleteDetailRow(di) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0 || !dt.rowGroups[ri]) return;
    if (di < 0 || di >= dt.rowGroups[ri].length) return;
    xsConfirm('确定删除该明细行？', function () {
        dt.rowGroups[ri].splice(di, 1);
        if (dt.rawRowGroups && dt.rawRowGroups[ri]) dt.rawRowGroups[ri].splice(di, 1);
        var ns = new Set();
        S._detailMods.forEach(function (k) {
            var p = k.split(','); var d = parseInt(p[0], 10); var c = parseInt(p[1], 10);
            if (d === di) return;
            ns.add((d > di ? d - 1 : d) + ',' + c);
        });
        S._detailMods = ns;
        renderDetailTable();
        updateDetailModInfo();
    });
}

function saveDetailModal() {
    // 同步主表显示（当前明细字段对应列显示项数/字段数）
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    pushHistory();
    if (dt && ri >= 0) {
        var headers = S.data.headers || [];
        var colIdx = headers.indexOf(dt.field);
        if (colIdx >= 0) {
            var rows = (dt.rowGroups && dt.rowGroups[ri]) || [];
            var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
            var displayText;
            if (rows.length === 0) {
                displayText = rawType === 'object' ? '{}' : '[]';
            } else if (rawType === 'object') {
                // 嵌套对象：以子表第一行的列数作为字段数
                var firstRow = rows[0] || [];
                // 实际有值的字段数（避免空字段被计入）
                var fieldCount = 0;
                firstRow.forEach(function (v) { if (v !== '' && v !== null && v !== undefined) fieldCount++; });
                if (fieldCount === 0) fieldCount = (dt.headers || []).length;
                displayText = '{' + fieldCount + ' 字段}';
            } else {
                displayText = '[' + rows.length + ' 项]';
            }
            S.data.rows[ri][colIdx] = displayText;
            S.mods.add(ri + ',' + colIdx);
        }
    }
    saveFile();
    renderTable();
    closeDetailModal(false);
    showToast('明细已保存', 'success');
}

function updateDetailModInfo() {
    var info = document.getElementById('detailModInfo');
    if (info) info.style.display = S._detailMods.size > 0 ? '' : 'none';
}

// 初始化
document.addEventListener('DOMContentLoaded', init);