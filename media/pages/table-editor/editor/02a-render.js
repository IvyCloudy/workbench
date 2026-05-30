/* =============================================================================
 * 02a-render.js  —— 渲染（虚拟滚动）+ 单元格原地 patch
 * -----------------------------------------------------------------------------
 * 由原 02-render-bind.js 拆分而来，仅保留 renderTable 主入口、骨架/单行/
 * 全量/虚拟渲染各路径，以及单格 patchCell。事件绑定与行/单元格选区分别
 * 见 02b-bind.js / 02c-row-cell-sel.js / 02d-sel-utils.js。
 * 跨文件依赖通过全局作用域共享（S、formatCellValue、escapeHtml、dbg 等）。
 * ========================================================================== */

// ==================== 渲染（虚拟滚动） ====================
// 阈值：行数 >= 此值时启用虚拟滚动（仅渲染视口附近行）
var XS_VIRTUAL_THRESHOLD = 500;
// 估算行高（无自定义行高时使用），与 .xs-td 默认行高保持一致
var XS_ROW_EST_HEIGHT = 26;
// 上下缓冲行数（视口外预渲染数量），减少滚动时的"白屏"感
var XS_VIRTUAL_BUFFER = 10;

// 主入口：根据当前数据规模选择渲染策略
function renderTable() {
    var c = document.getElementById('tableContainer');
    if (!c) { dbg('❌ renderTable: tableContainer not found'); return; }
    // 1) 计算 view 行索引列表（应用搜索 + 列筛选）
    S._viewRows = _computeViewRows();
    // 1.1) 兜底：原数据非空但因"列筛选"过滤为 0 行（多见于编辑/清空/填充/删除/撤销
    //      后单元格新值不在旧筛选集合中），此时自动失效列筛选并重算，避免界面空白
    //      （搜索导致 0 命中时不处理，那是用户的预期行为，搜索框自身可见）
    var _rowsLen = (S.data && S.data.rows && S.data.rows.length) || 0;
    var _hasColFilters = S._colFilters && Object.keys(S._colFilters).length > 0;
    var _hasSearch = !!(S._searchKw && String(S._searchKw).trim());
    if (_rowsLen > 0 && S._viewRows.length === 0 && _hasColFilters) {
        dbg('🛟 renderTable bailout: rows=' + _rowsLen + ' viewRows=0 colFilters=' + Object.keys(S._colFilters).length + ' -> clear colFilters');
        S._colFilters = {};
        S._viewRows = _computeViewRows();
        if (typeof showToast === 'function') {
            showToast('数据修改后列筛选不再匹配任何行，已自动清除列筛选', 'warning');
        }
    }
    // 2) 整体外壳（表头 + colgroup + tbody 占位）只构建一次性骨架
    c.innerHTML = _buildSkeletonHtml();
    // 重要：tbody 已被重建（旧 tr 全部丢弃），必须清空上一次渲染留下的可视区间缓存，
    // 否则 _renderVirtualBody 的 "same range" 短路会跳过填充，导致 tbody 始终为空、页面显示为空。
    S._vRange = null;
    // 3) 决定走哪条路径
    var useVirtual = S._viewRows.length >= XS_VIRTUAL_THRESHOLD;
    S._virtualOn = useVirtual;
    if (useVirtual) {
        _computeRowOffsets();        // 计算所有 view 行的偏移表
        _bindVirtualScroll();        // 绑定/复用 scroll 监听
        _renderVirtualBody();        // 首次渲染视口
    } else {
        _renderAllBody();             // 全量渲染
    }
    bindTable();
    updateSelectionInfo();
    updatePushBtn();
    if (typeof updateFailedFilterBtn === 'function') updateFailedFilterBtn();
    updateSearchClear();
    if (typeof updateColSelClasses === 'function') updateColSelClasses();
    if (typeof updateCellSelClasses === 'function') updateCellSelClasses();
    if (S._findKw) paintFindHighlight();
    // 滚动位置恢复（持久化或外部 setScrollTop）
    if (S._pendingScrollTop && S._pendingScrollTop > 0) {
        var _top = S._pendingScrollTop;
        S._pendingScrollTop = 0;
        requestAnimationFrame(function () {
            c.scrollTop = _top;
            // 虚拟模式下还要再触发一次按位置渲染
            if (S._virtualOn) _renderVirtualBody();
        });
    }
    persistUiStateDebounced();
}

// 计算可见行索引列表（按 S.data.rows 原顺序，过滤搜索 / 列筛选未命中的）
function _computeViewRows() {
    var rows = (S.data && S.data.rows) || [];
    var headers = (S.data && S.data.headers) || [];
    var skw = (S._searchKw || '').toLowerCase();
    var hasColFilters = S._colFilters && Object.keys(S._colFilters).length > 0;
    // 仅看推送失败：当 _failedOnly=true 且 _pushFailedTsIds 非空时启用
    var failedOnly = !!(S._failedOnly && S._pushFailedTsIds && S._pushFailedTsIds.size > 0);
    var failedTsCol = failedOnly ? headers.indexOf('tsId') : -1;
    if (failedOnly && failedTsCol < 0) {
        // 没有 tsId 列就无法定位失败行，自动失效该筛选
        failedOnly = false;
    }
    if (!skw && !hasColFilters && !failedOnly) {
        // 直接整段：避免大数组 push 开销
        var arr = new Array(rows.length);
        for (var i = 0; i < rows.length; i++) arr[i] = i;
        return arr;
    }
    var out = [];
    for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri];
        if (skw) {
            var hit = false;
            for (var k = 0; k < headers.length; k++) {
                var cv = row[k];
                if (cv === null || cv === undefined) continue;
                // 数组单元格走 formatCellValue（'; ' 拼接），避免默认 toString 产生 'a,b' 影响搜索体验
                var cvStr = Array.isArray(cv) ? formatCellValue(cv) : String(cv);
                if (cvStr.toLowerCase().indexOf(skw) >= 0) { hit = true; break; }
            }
            if (!hit) continue;
        }
        if (hasColFilters) {
            var passed = true;
            for (var fc in S._colFilters) {
                if (!S._colFilters.hasOwnProperty(fc)) continue;
                var allow = S._colFilters[fc];
                var fcIdx = parseInt(fc, 10);
                var cellVal = row[fcIdx];
                var cellKey;
                if (cellVal === null || cellVal === undefined || cellVal === '') cellKey = '__BLANK__';
                else if (Array.isArray(cellVal)) cellKey = (cellVal.length === 0 ? '__BLANK__' : formatCellValue(cellVal));
                else cellKey = String(cellVal);
                if (!allow.has(cellKey)) { passed = false; break; }
            }
            if (!passed) continue;
        }
        if (failedOnly) {
            var _tsv = row[failedTsCol];
            if (_tsv === undefined || _tsv === null || _tsv === '') continue;
            if (!S._pushFailedTsIds.has(String(_tsv))) continue;
        }
        out.push(ri);
    }
    return out;
}

// 构建表格骨架（colgroup + thead + 空 tbody），不含具体 tr
function _buildSkeletonHtml() {
    var headers = (S.data && S.data.headers) || [];
    var html = '<table class="xs-table"><colgroup>';
    html += '<col style="width:50px">';
    for (var i = 0; i < headers.length; i++) {
        var w = S.colWidths[i] || 160;
        html += '<col style="width:' + w + 'px">';
    }
    html += '</colgroup><thead><tr>';
html += '<th class="xs-th xs-th-cb xs-th-rownum" title="点击全选整表">#</th>';
    for (var j = 0; j < headers.length; j++) {
        var hdr = headers[j];
        var hasFilter = !!(S._colFilters && S._colFilters[j]);
        var filterCls = hasFilter ? ' active' : '';
        var filterTitle = hasFilter ? '已应用筛选 (点击修改)' : '筛选';
        var colSelCls = S.colSel.has(j) ? ' xs-col-selected' : '';
        var frozenCls = (String(hdr) === 'tsId') ? ' xs-th-frozen' : '';
        html += '<th class="xs-th' + colSelCls + frozenCls + '" data-col="' + j + '">'
            + '<span class="xs-th-text">' + escapeHtml(String(hdr)) + '</span>'
            + '<span class="xs-th-filter' + filterCls + '" data-filter-col="' + j + '" title="' + filterTitle + '">'
            +   '<svg class="xs-funnel-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">'
            +     '<path fill="currentColor" d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 .8 1.6L10 8.5V13a1 1 0 0 1-1.45.9l-2-1A1 1 0 0 1 6 12V8.5L2.2 3.6A1 1 0 0 1 2 3z"/>'
            +   '</svg>'
            + '</span>'
            + '<div class="xs-resizer" data-col="' + j + '" title="拖动调整列宽；双击自适应"></div>'
            + '</th>';
    }
    html += '</tr></thead><tbody id="xsTbody"></tbody></table>';
    return html;
}

// 渲染一个标量数组单元格的 chip HTML。
// 默认在可视宽度内不换行（超出被截断）；行高被拉大后 CSS 会换行全部显示。
function _buildArrayChipsHtml(arr) {
    var list = Array.isArray(arr) ? arr : [];
    if (list.length === 0) return ''; // 空数组单元格不渲染任何内容（需求 A：留空）
    var html = '<div class="xs-cell-chips">';
    for (var i = 0; i < list.length; i++) {
        var raw = list[i];
        var text = (raw === null || raw === undefined) ? '' : String(raw);
        var clsExtra = text === '' ? ' is-empty' : '';
        var titleAttr = text ? ' title="' + escapeHtml(text) + '"' : '';
        html += '<span class="xs-chip' + clsExtra + '"' + titleAttr + '>' + escapeHtml(text || '空') + '</span>';
    }
    html += '</div>';
    return html;
}

// 构造单行 tr 的 HTML（被全量与虚拟两条路径共用）
function _buildRowHtml(ri, tsIdColIdx) {
    var headers = (S.data && S.data.headers) || [];
    var row = S.data.rows[ri] || [];
    var selCls = S.sel.has(ri) ? ' selected' : '';
    var rh = S.rowHeights[ri];
    var resizedCls = (rh && rh > 0) ? ' xs-tr-resized' : '';
    var rowStyle = (rh && rh > 0) ? ' style="height:' + rh + 'px"' : '';
    var failCls = '';
    var failReason = '';
    if (S._pushFailedTsIds && S._pushFailedTsIds.size > 0 && tsIdColIdx >= 0) {
        var rowTsId = row[tsIdColIdx];
        if (rowTsId !== undefined && rowTsId !== null && rowTsId !== '' && S._pushFailedTsIds.has(String(rowTsId))) {
            failCls = ' xs-tr-push-failed';
            if (S._pushFailedReasons) {
                var _r = S._pushFailedReasons.get(String(rowTsId));
                if (_r) failReason = String(_r);
            }
        }
    }
    // 行号格 title：失败行显示「原始行号: N | 推送失败：<原因>」，便于鼠标悬停查看失败原因。
    var rowNumTitle = '原始行号: ' + (ri + 1);
    if (failReason) rowNumTitle += ' | 推送失败：' + failReason;
    // 渲染为普通行；不再提供整行 HTML5 拖动排序能力（与矩形拖选、行横扫存在交互冲突）。
    var html = '<tr data-row="' + ri + '" class="' + (selCls + resizedCls + failCls).trim() + '"' + rowStyle + '>'
        + '<td class="xs-td xs-td-cb xs-td-rownum" data-row="' + ri + '" title="' + escapeHtml(rowNumTitle) + '">'
        +   '<span class="xs-rownum">' + (ri + 1) + '</span>'
        +   '<div class="xs-row-resizer" data-row="' + ri + '" title="拖动调整行高；双击自适应内容"></div>'
        + '</td>';
    for (var ci = 0; ci < headers.length; ci++) {
        var v = row[ci];
        var modCls = S.mods.has(ri + ',' + ci) ? ' modified' : '';
        var colSelCls2 = S.colSel.has(ci) ? ' xs-col-selected' : '';
        var frozenCls2 = (String(headers[ci]) === 'tsId') ? ' xs-td-frozen' : '';
        var isDetail = hasDetailRowsAtCol(ri, ci);
        var isArrCol = (typeof isArrayCol === 'function') && isArrayCol(ci);
        var rawText = formatCellValue(v);
        var inner;
        var titleAttr;
        var arrCellCls = '';
        if (isDetail) {
            inner = '<span class="xs-detail-link" data-detail-row="' + ri + '" data-detail-col="' + ci + '">' + escapeHtml(rawText) + '</span>';
            titleAttr = rawText ? ' title="' + escapeHtml(rawText) + '"' : '';
        } else if (isArrCol) {
            var arr = Array.isArray(v) ? v : [];
            inner = _buildArrayChipsHtml(arr);
            titleAttr = arr.length > 0 ? ' title="' + escapeHtml(rawText) + '"' : '';
            arrCellCls = ' xs-arr-cell';
        } else {
            inner = escapeHtml(rawText);
            titleAttr = rawText ? ' title="' + escapeHtml(rawText) + '"' : '';
        }
        html += '<td class="xs-td xs-editable' + modCls + colSelCls2 + frozenCls2 + (isDetail ? ' xs-detail-cell' : '') + arrCellCls + '" data-row="' + ri + '" data-col="' + ci + '"' + titleAttr + '>'
            + '<div class="xs-cell-wrap">' + inner + '</div></td>';
    }
    html += '</tr>';
    return html;
}

// 全量渲染（小表格）：把所有 view 行一次写入 tbody
function _renderAllBody() {
    var tbody = document.getElementById('xsTbody');
    if (!tbody) return;
    var headers = (S.data && S.data.headers) || [];
    var tsIdColIdx = headers.indexOf('tsId');
    var view = S._viewRows || [];
    var parts = new Array(view.length);
    for (var i = 0; i < view.length; i++) parts[i] = _buildRowHtml(view[i], tsIdColIdx);
    tbody.innerHTML = parts.join('');
}

// 计算每个 view 行的累积偏移表 _rowOffsets[i] = 第 i 行的 top 像素
// 长度 = view.length + 1，最后一项即总高度。
function _computeRowOffsets() {
    var view = S._viewRows || [];
    var offs = new Array(view.length + 1);
    var acc = 0;
    for (var i = 0; i < view.length; i++) {
        offs[i] = acc;
        var ri = view[i];
        var rh = S.rowHeights[ri];
        acc += (rh && rh > 0) ? rh : XS_ROW_EST_HEIGHT;
    }
    offs[view.length] = acc;
    S._rowOffsets = offs;
}

// 二分查找：scrollTop 处于哪个 view 行内
function _findRowIdxByOffset(top) {
    var offs = S._rowOffsets || [0];
    var lo = 0, hi = offs.length - 2;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (offs[mid] <= top && top < offs[mid + 1]) return mid;
        if (offs[mid] > top) hi = mid - 1; else lo = mid + 1;
    }
    return Math.max(0, Math.min(offs.length - 2, lo));
}

// 根据当前 scrollTop / 容器高度 / buffer 计算需渲染的 view 行区间 [from, to)
function _calcVisibleRange() {
    var c = document.getElementById('tableContainer');
    var view = S._viewRows || [];
    if (!c || view.length === 0) return [0, 0];
    var top = c.scrollTop;
    var bottom = top + c.clientHeight;
    var first = _findRowIdxByOffset(top);
    // 找 last：从 first 起累加直到超出 bottom
    var last = first;
    var offs = S._rowOffsets;
    while (last < view.length && offs[last] < bottom) last++;
    var from = Math.max(0, first - XS_VIRTUAL_BUFFER);
    var to = Math.min(view.length, last + XS_VIRTUAL_BUFFER);
    return [from, to];
}

// 虚拟渲染：tbody 内为 [topSpacer, ...真实 trs..., bottomSpacer]
function _renderVirtualBody() {
    var tbody = document.getElementById('xsTbody');
    if (!tbody) { dbg('❌ _renderVirtualBody: xsTbody not found'); return; }
    var view = S._viewRows || [];
    var offs = S._rowOffsets || [0];
    var headers = (S.data && S.data.headers) || [];
    var totalCols = 1 + headers.length; // 复选框列 + 数据列
    if (view.length === 0) {
        tbody.innerHTML = '';
        S._vRange = [0, 0];
        return;
    }
    var range = _calcVisibleRange();
    var from = range[0], to = range[1];
    // 命中相同区间则跳过（滚动微动不重渲）
    if (S._vRange && S._vRange[0] === from && S._vRange[1] === to) return;
    S._vRange = [from, to];

    var topH = offs[from] || 0;
    var bottomH = (offs[view.length] || 0) - (offs[to] || 0);
    var tsIdColIdx = headers.indexOf('tsId');
    var parts = [];
    // 顶部 spacer（用一行 td colspan 撑高）
    parts.push('<tr class="xs-vspacer" aria-hidden="true" style="height:' + topH + 'px"><td colspan="' + totalCols + '" style="padding:0;border:0"></td></tr>');
    for (var i = from; i < to; i++) parts.push(_buildRowHtml(view[i], tsIdColIdx));
    parts.push('<tr class="xs-vspacer" aria-hidden="true" style="height:' + bottomH + 'px"><td colspan="' + totalCols + '" style="padding:0;border:0"></td></tr>');
    tbody.innerHTML = parts.join('');
    // 重渲后恢复查找高亮（仅对当前可见行有效）
    if (S._findKw) paintFindHighlight();
    if (typeof updateColSelClasses === 'function') updateColSelClasses();
    if (typeof updateCellSelClasses === 'function') updateCellSelClasses();
}

// 绑定容器 scroll → 节流（rAF）→ 虚拟重渲
// 注：滚动位置持久化由 01-core.js 的 bindContainerScroll() 单独绑定，避免重复注册。
function _bindVirtualScroll() {
    var c = document.getElementById('tableContainer');
    if (!c || c._xsVScrollBound) return;
    c._xsVScrollBound = true;
    c.addEventListener('scroll', function () {
        if (!S._virtualOn) return;
        if (S._vScrollRaf) return;
        S._vScrollRaf = requestAnimationFrame(function () {
            S._vScrollRaf = 0;
            _renderVirtualBody();
        });
    }, { passive: true });

    // 兜底：webview 失焦或鼠标离开整个视口时，主动清理可能残留的拖动 handler
    // 防止 mouseup 在 VSCode 主进程被吞导致的「僵尸 onMove」长时间存活
    if (!window._xsCellDragGuardBound) {
        window._xsCellDragGuardBound = true;
        var cleanup = function (reason) {
            if (S._cellDragOnMove || S._cellDragOnUp) {
                if (typeof dbg === 'function') dbg('🧹 cleanup cell-drag handler by ' + reason);
                if (S._cellDragOnMove) document.removeEventListener('mousemove', S._cellDragOnMove, true);
                if (S._cellDragOnUp) document.removeEventListener('mouseup', S._cellDragOnUp, true);
                S._cellDragOnMove = null;
                S._cellDragOnUp = null;
                S._cellDragging = false;
            }
        };
        window.addEventListener('blur', function () { cleanup('window-blur'); });
        document.addEventListener('mouseleave', function () { cleanup('document-mouseleave'); });
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) cleanup('visibility-hidden');
        });
    }
}

// 给定 view 内行索引（不是原始 ri），让它进入视口（用于 focusActiveMatch 等场景）
function ensureRowVisibleByViewIdx(viewIdx) {
    var c = document.getElementById('tableContainer');
    if (!c || !S._virtualOn) return;
    var offs = S._rowOffsets || [0];
    if (viewIdx < 0 || viewIdx >= offs.length - 1) return;
    var top = offs[viewIdx];
    var rowH = offs[viewIdx + 1] - top;
    if (top < c.scrollTop) {
        c.scrollTop = Math.max(0, top - 20);
    } else if (top + rowH > c.scrollTop + c.clientHeight) {
        c.scrollTop = top + rowH - c.clientHeight + 20;
    }
    _renderVirtualBody();
}

// 给定原始行号 ri，先定位到 viewRows 索引再调用上面的滚动
function ensureRowVisible(ri) {
    var view = S._viewRows || [];
    var idx = view.indexOf(ri);
    if (idx < 0) return;
    ensureRowVisibleByViewIdx(idx);
}

// ==================== 单元格原地 patch ====================
// 仅刷新某个 (r,c) 对应的 <td>，避免 renderTable 全表重绘。
// 用于单格写操作：pasteCell / clearCell / replaceCurrent / 编辑提交 等场景。
function patchCell(ri, ci) {
    if (typeof ri !== 'number' || typeof ci !== 'number' || ri < 0 || ci < 0) return;
    var td = document.querySelector('td.xs-editable[data-row="' + ri + '"][data-col="' + ci + '"]');
    if (!td) return; // 行可能因筛选未渲染
    var headers = (S.data && S.data.headers) || [];
    var row = (S.data && S.data.rows && S.data.rows[ri]) || [];
    var v = row[ci];
    var rawText = formatCellValue(v);
    var isDetail = (typeof hasDetailRowsAtCol === 'function') && hasDetailRowsAtCol(ri, ci);
    var isArrCol = (typeof isArrayCol === 'function') && isArrayCol(ci);
    var inner;
    if (isDetail) {
        inner = '<span class="xs-detail-link" data-detail-row="' + ri + '" data-detail-col="' + ci + '">' + escapeHtml(rawText) + '</span>';
    } else if (isArrCol) {
        var arr = Array.isArray(v) ? v : [];
        inner = _buildArrayChipsHtml(arr);
    } else {
        inner = escapeHtml(rawText);
    }
    td.innerHTML = '<div class="xs-cell-wrap">' + inner + '</div>';
    // class 同步
    if (S.mods.has(ri + ',' + ci)) td.classList.add('modified'); else td.classList.remove('modified');
    if (isDetail) td.classList.add('xs-detail-cell'); else td.classList.remove('xs-detail-cell');
    if (isArrCol) td.classList.add('xs-arr-cell'); else td.classList.remove('xs-arr-cell');
    var frozen = (String(headers[ci]) === 'tsId');
    if (frozen) td.classList.add('xs-td-frozen'); else td.classList.remove('xs-td-frozen');
    // tooltip 同步
    if (rawText) td.setAttribute('title', rawText); else td.removeAttribute('title');
    // 注：detail-link click 已在 #tableContainer 上委托，无需在此重新绑定
}
