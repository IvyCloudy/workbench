/* =============================================================================
 * 02d-sel-utils.js  —— 选区辅助工具 / 信息统计 / 推送按钮状态
 * -----------------------------------------------------------------------------
 * 由原 02-render-bind.js 拆分而来，包含：
 *   - selectAllCells / getCellSelRect / isCellInSel
 *   - updateCellSelClasses / updateRowSelClasses
 *   - updateSelectionInfo / countMatchedRows
 *   - getPushTargetRows / updatePushBtn / updateFailedFilterBtn
 * 这些函数被 02a-render.js / 02b-bind.js / 02c-row-cell-sel.js 以及其他文件
 * 共同调用，是「选区状态 ↔ DOM/UI」之间的桥梁。
 * 跨文件依赖通过全局作用域共享。
 * ========================================================================== */

// 全选整表（左上角 # 角格点击 = Excel 风格全选）：
// 选中所有"当前可见"的数据行 × 所有列；过滤模式下（搜索/列筛选/仅看失败）
// 隐藏行不会被纳入选区，避免误删/误推送被过滤掉的成功行。
// 同时清空列选，避免互斥状态混乱；行选 S.sel 同步包含所有可见行的真实行号。
function selectAllCells() {
    var rows = (S.data && S.data.rows) || [];
    var cols = (S.data && S.data.headers) || [];
    if (rows.length === 0 || cols.length === 0) return;
    // 取当前可见的原始行号列表；若尚未渲染过（_viewRows 为空），退化为整表
    var view = (S._viewRows && S._viewRows.length) ? S._viewRows : null;
    var firstR, lastR;
    S.sel.clear();
    if (view) {
        firstR = view[0];
        lastR = view[view.length - 1];
        for (var i = 0; i < view.length; i++) S.sel.add(view[i]);
    } else {
        firstR = 0;
        lastR = rows.length - 1;
        for (var k = 0; k <= lastR; k++) S.sel.add(k);
    }
    // 注意：cellSel 的 anchor/focus 直接使用真实行号；由于视图行号在原始坐标下不一定连续
    // （仅看失败/列筛选可能跳号），矩形高亮在 updateCellSelClasses 中按 r1..r2 范围着色，
    // 但隐藏行的 td 根本不存在于 DOM，所以视觉上仍然只覆盖可见行。同时下游所有"按行操作"
    // （删除/推送/复制）都通过 S.sel 来取行集合，已避开隐藏行。
    S.cellSel = {
        anchor: { r: firstR, c: 0 },
        focus: { r: lastR, c: cols.length - 1 }
    };
    S.colSel.clear();
    S._rowSelAnchor = -1;
    S._colSelAnchor = -1;
    // active 单元格归位到首个可见行的第 0 列
    S.cell = { r: firstR, c: 0 };
    document.querySelectorAll('.xs-editable.active').forEach(function (n) { n.classList.remove('active'); });
    var first = document.querySelector('.xs-editable[data-row="' + firstR + '"][data-col="0"]');
    if (first) first.classList.add('active');
    updateColSelClasses();
    updateRowSelClasses();
    updateCellSelClasses();
    updateSelectionInfo();
    if (typeof updatePushBtn === 'function') updatePushBtn();
}

// 计算 cellSel 的归一化矩形 {r1,c1,r2,c2}（含端点）；无选区返回 null
function getCellSelRect() {
    var cs = S.cellSel;
    if (!cs || !cs.anchor || !cs.focus) return null;
    var r1 = Math.min(cs.anchor.r, cs.focus.r);
    var r2 = Math.max(cs.anchor.r, cs.focus.r);
    var c1 = Math.min(cs.anchor.c, cs.focus.c);
    var c2 = Math.max(cs.anchor.c, cs.focus.c);
    return { r1: r1, c1: c1, r2: r2, c2: c2 };
}

function isCellInSel(ri, ci) {
    var rc = getCellSelRect();
    if (!rc) return false;
    return ri >= rc.r1 && ri <= rc.r2 && ci >= rc.c1 && ci <= rc.c2;
}

// 返回当前矩形选区实际应作用的"可见行号"数组（升序，含端点）。
// 过滤模式下（搜索/列筛选/仅看失败）会自动剔除被隐藏的行号，这样
// 复制/清空/批量编辑等"按矩形遍历行"的操作就不会误碰已被过滤掉的行。
// 无矩形选区时返回 []。
function getSelRectRows() {
    var rc = getCellSelRect();
    if (!rc) return [];
    var allLen = (S.data && S.data.rows && S.data.rows.length) || 0;
    // 仅在 _viewRows 比全表小（即处于过滤模式）时启用过滤
    var viewSet = null;
    if (S._viewRows && S._viewRows.length && S._viewRows.length < allLen) {
        viewSet = new Set(S._viewRows);
    }
    var arr = [];
    for (var r = rc.r1; r <= rc.r2; r++) {
        if (viewSet && !viewSet.has(r)) continue;
        arr.push(r);
    }
    return arr;
}

// 在不重绘整表的前提下刷新单元格矩形选区高亮
function updateCellSelClasses() {
    var rc = getCellSelRect();
    var debug = !!(typeof S !== 'undefined' && S && S._debug);
    if (debug && typeof dbg === 'function') {
        if (rc) dbg('🟦 cellSelRect r1=' + rc.r1 + ' c1=' + rc.c1 + ' r2=' + rc.r2 + ' c2=' + rc.c2 + ' dragging=' + !!S._cellDragging);
        else dbg('🟦 cellSelRect=null dragging=' + !!S._cellDragging);
    }
    // 热路径：在高频 mousemove 拖选下只会重启诊断扫描，这里只需要同步 class。
    var visited = 0, marked = 0;
    var leakList = debug ? [] : null;
    document.querySelectorAll('.xs-table td.xs-td[data-col]').forEach(function (td) {
        if (debug) visited++;
        if (!rc) {
            if (debug && td.classList.contains('xs-cell-selected')) leakList.push(td.getAttribute('data-row') + ',' + td.getAttribute('data-col'));
            td.classList.remove('xs-cell-selected');
            return;
        }
        var r = parseInt(td.getAttribute('data-row'), 10);
        var c = parseInt(td.getAttribute('data-col'), 10);
        var inRect = !isNaN(r) && !isNaN(c) && r >= rc.r1 && r <= rc.r2 && c >= rc.c1 && c <= rc.c2;
        if (inRect) {
            td.classList.add('xs-cell-selected');
            if (debug) marked++;
        } else {
            if (debug && td.classList.contains('xs-cell-selected')) leakList.push(r + ',' + c);
            td.classList.remove('xs-cell-selected');
        }
    });
    if (!debug) return;
    // 诊断路径（debug=true 才走）：检查是否有不在选择器範围内但仍带类的节点
    var allWithClass = document.querySelectorAll('.xs-cell-selected');
    var orphan = [];
    allWithClass.forEach(function (el) {
        if (el.tagName !== 'TD' || !el.classList.contains('xs-td') || !el.hasAttribute('data-col')) {
            orphan.push(el.tagName + '.' + (el.className || '').replace(/\s+/g, '.'));
        }
    });
    if (typeof dbg === 'function') {
        var expected = rc ? ((rc.r2 - rc.r1 + 1) * (rc.c2 - rc.c1 + 1)) : 0;
        dbg('🧪 classSync visited=' + visited + ' marked=' + marked + ' expected=' + expected
            + ' leakBeforeFix=[' + leakList.slice(0, 8).join(';') + (leakList.length > 8 ? ';...' : '') + ']'
            + ' orphanWithClass=' + orphan.length + (orphan.length ? ('[' + orphan.slice(0, 5).join(';') + ']') : ''));
    }
}

// 在不重绘整表的前提下刷新行选高亮（替代原来基于 checkbox 的同步）
function updateRowSelClasses() {
    document.querySelectorAll('.xs-table tbody tr[data-row]').forEach(function (tr) {
        var r = parseInt(tr.getAttribute('data-row'), 10);
        if (!isNaN(r) && S.sel.has(r)) tr.classList.add('selected');
        else tr.classList.remove('selected');
    });
}

function updateSelectionInfo() {
    var info = document.getElementById('selInfo');
    if (!info) return;
    var total = (S.data.rows || []).length;
    // 1) 单元格矩形选区 > 1 格：优先展示矩形规格
    var rc = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
    if (rc && (rc.r1 !== rc.r2 || rc.c1 !== rc.c2)) {
        // 行数：过滤模式下（搜索/列筛选/仅看失败）矩形坐标在原始行号空间是跳号的，
        // 需用 _viewRows 与 [r1, r2] 求交，才能得到真实可见行数；否则 r2-r1+1 会偏大。
        var rows;
        var _vr = S._viewRows;
        if (_vr && _vr.length && _vr.length !== ((S.data && S.data.rows) || []).length) {
            var cnt = 0;
            for (var _i = 0; _i < _vr.length; _i++) {
                var _ri = _vr[_i];
                if (_ri >= rc.r1 && _ri <= rc.r2) cnt++;
            }
            rows = cnt;
        } else {
            rows = rc.r2 - rc.r1 + 1;
        }
        var cols = rc.c2 - rc.c1 + 1;
        info.textContent = '已选 ' + rows + ' 行 × ' + cols + ' 列（' + (rows * cols) + ' 单元格）/ 共 ' + total + ' 行';
        return;
    }
    // 2) 列选 > 0 且未选行：展示选中列数
    if ((!S.sel || S.sel.size === 0) && S.colSel && S.colSel.size > 0) {
        info.textContent = '已选 ' + S.colSel.size + ' 列 / 共 ' + total + ' 行';
        return;
    }
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
                if (cv === null || cv === undefined) continue;
                var cvStr = Array.isArray(cv) ? formatCellValue(cv) : String(cv);
                if (cvStr.toLowerCase().indexOf(skw) >= 0) { hit = true; break; }
            }
            if (!hit) return;
        }
        if (hasColFilters) {
            for (var fc in S._colFilters) {
                if (!S._colFilters.hasOwnProperty(fc)) continue;
                var allow = S._colFilters[fc];
                var fcIdx = parseInt(fc, 10);
                var cellVal = row[fcIdx];
                var cellKey;
                if (cellVal === null || cellVal === undefined || cellVal === '') cellKey = '__BLANK__';
                else if (Array.isArray(cellVal)) cellKey = (cellVal.length === 0 ? '__BLANK__' : formatCellValue(cellVal));
                else cellKey = String(cellVal);
                if (!allow.has(cellKey)) return;
            }
        }
        count++;
    });
    return count;
}

// 计算"当前可推送的行集合"：优先行选 S.sel；若没有行选但存在单元格矩形选区，
// 则把矩形覆盖的所有行视为待推送行（与 Excel 直觉一致：选中若干行的单元格 = 选中这些行）。
// 过滤模式下（搜索/列筛选/仅看失败）始终把结果与 _viewRows 求交，避免推送被隐藏的行。
function getPushTargetRows() {
    // 当前可见行集合（用于过滤模式下的兜底）
    var viewSet = null;
    if (S._viewRows && S._viewRows.length) {
        var allLen = (S.data && S.data.rows && S.data.rows.length) || 0;
        // 仅当 _viewRows 实际比全表小时才启用（避免无筛选时多余 O(n)）
        if (S._viewRows.length < allLen) {
            viewSet = new Set(S._viewRows);
        }
    }
    if (S.sel && S.sel.size > 0) {
        var arr = Array.from(S.sel);
        if (viewSet) arr = arr.filter(function (r) { return viewSet.has(r); });
        return arr.sort(function (a, b) { return a - b; });
    }
    if (typeof getCellSelRect === 'function') {
        var rect = getCellSelRect();
        if (rect) {
            var rows = [];
            for (var r = rect.r1; r <= rect.r2; r++) {
                if (viewSet && !viewSet.has(r)) continue;
                rows.push(r);
            }
            return rows;
        }
    }
    return [];
}

function updatePushBtn() {
    var btn = document.getElementById('pushBtn');
    if (!btn) return;
    var hasTarget = getPushTargetRows().length > 0;
    var pushing = !!(S && S._pushing);
    btn.disabled = !hasTarget || pushing;
    if (pushing) {
        btn.classList.add('is-loading');
        btn.setAttribute('title', '推送中…');
    } else {
        btn.classList.remove('is-loading');
        btn.removeAttribute('title');
    }
}

// 同步"仅看推送失败"按钮的禁用 / 激活状态与计数 tooltip
function updateFailedFilterBtn() {
    var btn = document.getElementById('failedFilterBtn');
    if (!btn) return;
    var n = (S._pushFailedTsIds && S._pushFailedTsIds.size) || 0;
    if (n === 0) {
        // 没有失败行：按钮禁用并退出激活态
        btn.classList.add('is-disabled');
        btn.classList.remove('active');
        btn.setAttribute('data-tip', '暂无推送失败行');
        btn.setAttribute('title', '暂无推送失败行');
        // 失败行被清空（例如重推后全部成功），自动关闭"仅看失败"，避免空表
        if (S._failedOnly) S._failedOnly = false;
        return;
    }
    btn.classList.remove('is-disabled');
    var tip = S._failedOnly ? ('已仅看推送失败 (' + n + ')，点击退出') : ('仅看推送失败 (' + n + ')');
    btn.setAttribute('data-tip', tip);
    btn.setAttribute('title', tip);
    if (S._failedOnly) btn.classList.add('active'); else btn.classList.remove('active');
}
