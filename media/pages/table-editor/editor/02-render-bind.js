/* =============================================================================
 * 02-render-bind.js  —— 渲染 + 事件绑定 + 行选择
 * -----------------------------------------------------------------------------
 * 负责把 S.data 渲染成 HTML，并将工具栏 / 全局键盘 / 表格 DOM 上的事件挂载到
 * 业务函数。包含：
 *   1. renderTable()：根据 S.data + S._colFilters + S._searchKw + S.colWidths
 *      等状态生成主表 HTML（含表头排序图标、漏斗筛选、列宽 col、复选框列、
 *      tsId 冻结列高亮、明细按钮、推送失败行/单元格高亮等）
 *   2. bindToolbar()：搜索框 / 推送按钮 / 查找按钮 / 重置筛选按钮等顶部工具栏事件
 *   3. bindDocument()：全局快捷键（Ctrl+Z/Y、Ctrl+F、Esc、Delete、上下左右）、
 *      点击空白关闭右键菜单 / 筛选弹窗等
 *   4. bindTable()：为渲染出的每一行/单元格挂载 click / dblclick / 拖拽 / 列宽
 *      拖动 / 行高拖动等事件
 *   5. 行选 / 全选：toggleSelectAll / toggleRowSelection / updateSelectionInfo
 *      / countMatchedRows / updatePushBtn
 * ========================================================================== */

// ==================== 渲染 ====================
function renderTable() {
    // 渲染当前表格前，预计算 tsId 列位，以供推送失败高亮判断使用
    var _tsIdColIdx = -1;
    if (S.data && Array.isArray(S.data.headers)) {
        _tsIdColIdx = S.data.headers.indexOf('tsId');
    }
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
        var hasFilter = !!(S._colFilters && S._colFilters[i]);
        var filterCls = hasFilter ? ' active' : '';
        var filterTitle = hasFilter ? '已应用筛选 (点击修改)' : '筛选';
        var colSelCls = S.colSel.has(i) ? ' xs-col-selected' : '';
        var frozenCls = (String(hdr) === 'tsId') ? ' xs-th-frozen' : '';
        html += '<th class="xs-th' + colSelCls + frozenCls + '" data-col="' + i + '">'
            + '<span class="xs-th-text">' + escapeHtml(String(hdr)) + '</span>'
            + '<span class="xs-th-filter' + filterCls + '" data-filter-col="' + i + '" title="' + filterTitle + '">'
            +   '<svg class="xs-funnel-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">'
            +     '<path fill="currentColor" d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 .8 1.6L10 8.5V13a1 1 0 0 1-1.45.9l-2-1A1 1 0 0 1 6 12V8.5L2.2 3.6A1 1 0 0 1 2 3z"/>'
            +   '</svg>'
            + '</span>'
            + '<div class="xs-resizer" data-col="' + i + '"></div>'
            + '</th>';
    });
    html += '</tr></thead><tbody>';

    var skw = (S._searchKw || '').toLowerCase();
    var hasColFilters = S._colFilters && Object.keys(S._colFilters).length > 0;
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
        // 列筛选：每个被筛选列必须命中其勾选值集合
        if (hasColFilters) {
            var passed = true;
            for (var fc in S._colFilters) {
                if (!S._colFilters.hasOwnProperty(fc)) continue;
                var allow = S._colFilters[fc];
                var fcIdx = parseInt(fc, 10);
                var cellVal = row[fcIdx];
                var cellKey = (cellVal === null || cellVal === undefined || cellVal === '') ? '__BLANK__' : String(cellVal);
                if (!allow.has(cellKey)) { passed = false; break; }
            }
            if (!passed) return;
        }
        var selCls = S.sel.has(ri) ? ' selected' : '';
        var rh = S.rowHeights[ri];
        var resizedCls = (rh && rh > 0) ? ' xs-tr-resized' : '';
        var rowStyle = (rh && rh > 0) ? ' style="height:' + rh + 'px"' : '';
        // 最近一次推送失败的行高亮：按 tsId 标记，增/删/排序后仍有效
        var failCls = '';
        if (S._pushFailedTsIds && S._pushFailedTsIds.size > 0 && _tsIdColIdx >= 0) {
            var rowTsId = row[_tsIdColIdx];
            if (rowTsId !== undefined && rowTsId !== null && rowTsId !== '' && S._pushFailedTsIds.has(String(rowTsId))) {
                failCls = ' xs-tr-push-failed';
            }
        }
        html += '<tr data-row="' + ri + '" draggable="true" class="' + (selCls + resizedCls + failCls).trim() + '"' + rowStyle + '>'
            + '<td class="xs-td xs-td-cb"><input type="checkbox" data-row="' + ri + '"' + (S.sel.has(ri) ? ' checked' : '') + '></td>';
        h.forEach(function (_, ci) {
            var v = row[ci];
            var modCls = S.mods.has(ri + ',' + ci) ? ' modified' : '';
            var colSelCls2 = S.colSel.has(ci) ? ' xs-col-selected' : '';
            var frozenCls2 = (String(h[ci]) === 'tsId') ? ' xs-td-frozen' : '';
            var isDetail = hasDetailRowsAtCol(ri, ci);
            var rawText = formatCellValue(v);
            var inner = isDetail
                ? '<span class="xs-detail-link" data-detail-row="' + ri + '" data-detail-col="' + ci + '">' + escapeHtml(rawText) + '</span>'
                : escapeHtml(rawText);
            // 单元格 tooltip：完整原始值
            var titleAttr = rawText ? ' title="' + escapeHtml(rawText) + '"' : '';
            html += '<td class="xs-td xs-editable' + modCls + colSelCls2 + frozenCls2 + (isDetail ? ' xs-detail-cell' : '') + '" data-row="' + ri + '" data-col="' + ci + '"' + titleAttr + '>'
                + '<div class="xs-cell-wrap">' + inner + '</div></td>';
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    c.innerHTML = html;

    bindTable();
    updateSelectionInfo();
    updatePushBtn();
    updateSearchClear();
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
    if (search) {
        search.addEventListener('input', onSearch);
        search.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                // Enter 立即搜索，取消防抖
                if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
                S._searchKw = search.value || '';
                updateSearchClear(S._searchKw);
                renderTable();
            } else if (e.key === 'Escape') {
                if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
                search.value = '';
                S._searchKw = '';
                updateSearchClear();
                renderTable();
            }
        });
    }
    var searchClear = document.getElementById('searchClear');
    if (searchClear) {
        searchClear.addEventListener('click', function () {
            var inp = document.getElementById('searchInput');
            if (inp) { inp.value = ''; inp.focus(); }
            if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
            S._searchKw = '';
            updateSearchClear();
            renderTable();
        });
    }
    var searchReset = document.getElementById('searchReset');
    if (searchReset) {
        searchReset.addEventListener('click', function () {
            // 清空搜索词
            var inp = document.getElementById('searchInput');
            if (inp) { inp.value = ''; }
            if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
            S._searchKw = '';
            updateSearchClear();
            // 清空所有列筛选
            S._colFilters = {};
            // 关闭可能打开的列筛选弹窗（若存在该函数）
            try { if (typeof closeColFilter === 'function') closeColFilter(); } catch (e) {}
            renderTable();
            if (inp) inp.focus();
        });
    }

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
    // 全局点击关闭右键菜单 / 列筛选弹窗
    document.addEventListener('click', function (e) {
        hideContextMenu();
        var sf = document.getElementById('sortFilter');
        if (sf && sf.classList.contains('show')) {
            // 点击发生在弹窗内部不关闭
            if (!sf.contains(e.target)) closeColFilter();
        }
        // 点击表格之外（含表头）的区域，清空列选区
        if (S.colSel && S.colSel.size > 0) {
            var t = e.target;
            var insideTable = t && (t.closest && t.closest('.xs-table'));
            var insideMenu = t && (t.closest && t.closest('.xs-cm'));
            var insideSf = t && (t.closest && t.closest('.xs-sf'));
            var insideModal = t && (t.closest && t.closest('.xs-modal-overlay'));
            if (!insideTable && !insideMenu && !insideSf && !insideModal) {
                S.colSel.clear();
                S._colSelAnchor = -1;
                updateColSelClasses();
            }
        }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            hideContextMenu();
            if (isDetailModalOpen()) closeDetailModal();
            if (isXsPromptOpen()) closeXsPrompt(false);
            // ESC 也关闭查找面板
            var fp = document.getElementById('findPanel');
            if (fp && fp.classList.contains('show')) closeFindPanel();
            // ESC 关闭列筛选弹窗
            var sfm = document.getElementById('sortFilter');
            if (sfm && sfm.classList.contains('show')) closeColFilter();
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
    // 列头交互：按住左键在列头横扫，形成 Excel 风格的连续列选区；未移动则等同于 click
    document.querySelectorAll('th.xs-th[data-col]').forEach(function (th) {
        th.addEventListener('mousedown', onColHeaderMouseDown);
    });
    // 列筛选漏斗按钮：点击打开筛选弹窗（阻止冒泡，避免触发列拖拽/列宽事件）
    document.querySelectorAll('.xs-th-filter').forEach(function (fb) {
        fb.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
        fb.addEventListener('click', function (ev) {
            ev.stopPropagation();
            ev.preventDefault();
            var ci = parseInt(fb.getAttribute('data-filter-col'), 10);
            if (!isNaN(ci)) openColFilter(ci, fb);
        });
    });
    // 行拖动排序（拖整行）
    document.querySelectorAll('tr[data-row]').forEach(function (tr) {
        tr.addEventListener('dragstart', onRowDragStart);
        tr.addEventListener('dragover', onRowDragOver);
        tr.addEventListener('drop', onRowDrop);
    });
    // 行高拖动：在行号/复选框列（.xs-td-cb）上 mousedown 即可调整行高
    document.querySelectorAll('td.xs-td-cb').forEach(function (td) {
        td.addEventListener('mousedown', startRowResize);
        td.addEventListener('dblclick', resetRowHeight);
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
    if (!info) return;
    var total = (S.data.rows || []).length;
    var hasColFilters = S._colFilters && Object.keys(S._colFilters).length > 0;
    if (S._searchKw || hasColFilters) {
        var matched = countMatchedRows();
        info.textContent = '已选 ' + S.sel.size + ' 行，筛选 ' + matched + ' / ' + total + ' 行';
    } else {
        info.textContent = '已选 ' + S.sel.size + ' 行，共 ' + total + ' 行';
    }
}

function countMatchedRows() {
    var skw = (S._searchKw || '').toLowerCase();
    var h = S.data.headers || [];
    var hasColFilters = S._colFilters && Object.keys(S._colFilters).length > 0;
    if (!skw && !hasColFilters) return (S.data.rows || []).length;
    var count = 0;
    (S.data.rows || []).forEach(function (row) {
        if (skw) {
            var hit = false;
            for (var k = 0; k < h.length; k++) {
                var cv = row[k];
                if (cv !== null && cv !== undefined && String(cv).toLowerCase().indexOf(skw) >= 0) { hit = true; break; }
            }
            if (!hit) return;
        }
        if (hasColFilters) {
            for (var fc in S._colFilters) {
                if (!S._colFilters.hasOwnProperty(fc)) continue;
                var allow = S._colFilters[fc];
                var fcIdx = parseInt(fc, 10);
                var cellVal = row[fcIdx];
                var cellKey = (cellVal === null || cellVal === undefined || cellVal === '') ? '__BLANK__' : String(cellVal);
                if (!allow.has(cellKey)) return;
            }
        }
        count++;
    });
    return count;
}

function updatePushBtn() {
    var btn = document.getElementById('pushBtn');
    if (!btn) return;
    btn.disabled = S.sel.size === 0;
}
