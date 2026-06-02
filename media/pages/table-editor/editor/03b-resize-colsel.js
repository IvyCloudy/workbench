/* =============================================================================
 * 03b-resize-colsel.js  —— 列宽 / 列选择 / 行高（尺寸 & 选区）
 * -----------------------------------------------------------------------------
 * 由原 03-cell-ops.js 拆分而来，集中处理"鼠标拖动改变尺寸"以及"按列选区"：
 *   1. 列宽拖动：startColResize（拖动 .xs-resizer 实时改宽，mouseup 后持久化）
 *      autoFitColumn（双击 resizer 自适应：用离屏量尺测真实内容宽度）
 *   2. 列选择（Excel 风格）：isFrozenCol（tsId 为冻结列）/ onColHeaderMouseDown
 *      （列头按住左键横扫成区间；Ctrl/Shift 修饰）/ updateColSelClasses
 *      / applyColumnsBulk / clearSelectedCols / fillSelectedCols
 *   3. 行高拖动：startRowResize（拖动 .xs-row-resizer 实时改高）
 *      resetRowHeight（双击自适应：离屏量尺读 wrap 后真实高度，幂等）
 *
 * 单元格编辑、右键菜单、行/列数据操作见 03a-cell-edit.js。
 * 跨文件依赖通过全局作用域共享（S、persistUiStateDebounced、isArrayCol、
 * formatCellValue、_computeRowOffsets 等）。
 * ========================================================================== */


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
        if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// 双击列宽拖手柄：按当前可见行内容自适应列宽（与 Excel 一致，结果幂等，反复双击宽度不变）。
// 关键点：不能直接读 td/.xs-cell-wrap 的 scrollWidth —— 在列已够宽时 wrap 会被父级撑满，
// 读到的是"当前列宽"而非"真实内容宽度"，导致每次双击都比当前更宽。
// 正确做法：用一个离屏量尺（脱离表格布局、white-space:nowrap、宽度不限）把每个单元格的
// 文本/HTML 拷过去测真实渲染宽度，取最大值再加左右 padding。
function autoFitColumn(e) {
    if (!e || !e.currentTarget) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    var col = parseInt(e.currentTarget.getAttribute('data-col'), 10);
    if (isNaN(col)) return;
    var th = e.currentTarget.parentElement;

    // 创建离屏量尺：position:absolute + visibility:hidden + 不换行 + 无宽度限制
    var ruler = document.createElement('div');
    ruler.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;'
        + 'white-space:nowrap;display:inline-block;font:inherit;padding:0;border:0;'
        + 'box-sizing:content-box;pointer-events:none';
    // 让量尺继承表格单元格的字体/字号
    var sample = document.querySelector('.xs-table tbody td[data-col="' + col + '"] .xs-cell-wrap');
    var refEl = sample || th;
    if (refEl) {
        var cs = window.getComputedStyle(refEl);
        ruler.style.font = cs.font;
        ruler.style.fontSize = cs.fontSize;
        ruler.style.fontFamily = cs.fontFamily;
        ruler.style.fontWeight = cs.fontWeight;
        ruler.style.letterSpacing = cs.letterSpacing;
    }
    document.body.appendChild(ruler);

    // 单元格 padding(6+6=12) + 边框(1+1=2) = 14px
    var CELL_PAD = 14;
    // 表头额外为漏斗+resizer预留：padding-right 18 + padding-left 8 + 边框 2 = 28px
    var HEAD_PAD = 28;

    var dataMax = 0;
    var headMax = 0;
    try {
        // 1) 表头文字宽度
        if (th) {
            var span = th.querySelector('.xs-th-text');
            if (span) {
                ruler.textContent = span.textContent || '';
                headMax = ruler.offsetWidth;
            }
        }
        // 2) 当前可见 tbody 中该列所有 .xs-cell-wrap 的真实内容宽度
        var cells = document.querySelectorAll('.xs-table tbody td[data-col="' + col + '"] .xs-cell-wrap');
        for (var i = 0; i < cells.length; i++) {
            // 用 innerHTML 以兼容数组 chip 等结构；量尺 nowrap 不会换行
            ruler.innerHTML = cells[i].innerHTML;
            var w = ruler.offsetWidth;
            if (w > dataMax) dataMax = w;
        }
    } finally {
        document.body.removeChild(ruler);
    }

    // 数据需要的列宽 = 内容宽 + 单元格 padding；表头需要的列宽 = 文本宽 + 表头 padding（含漏斗位）
    var needData = Math.ceil(dataMax) + CELL_PAD;
    var needHead = Math.ceil(headMax) + HEAD_PAD;
    var finalW = Math.max(40, Math.min(600, Math.max(needData, needHead)));
    S.colWidths[col] = finalW;
    var colEl = document.querySelector('.xs-table colgroup col:nth-child(' + (col + 2) + ')');
    if (colEl) colEl.style.width = finalW + 'px';
    if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
}

// ==================== 列选择（Excel 风格）====================
// 列冻结：testcase_id 列为系统列，禁止任何编辑/覆写
function isFrozenCol(ci) {
    if (typeof ci !== 'number' || ci < 0) return false;
    var headers = (S.data && S.data.headers) || [];
    return headers[ci] === 'testcase_id';
}

// 列头按下 -> 进入「横扫选列」模式；mousemove 阶段实时把锚点列与悬停列形成区间；
// mouseup 时若没有产生横扫位移则按 click 规则处理（含 Ctrl/Shift 修饰键）。
function onColHeaderMouseDown(e) {
    if (!e.target) return;
    // 跳过列宽拖手柄、筛选漏斗，避免与它们冲突
    if (e.target.classList && (e.target.classList.contains('xs-resizer') || e.target.classList.contains('xs-th-filter'))) return;
    if (e.button !== 0) return;
    var ci = parseInt(e.currentTarget.getAttribute('data-col'), 10);
    if (isNaN(ci)) return;
    e.preventDefault(); // 阻止文字选中等默认行为

    var startX = e.clientX;
    var startY = e.clientY;
    var moved = false;
    var ctrlOrMeta = !!(e.ctrlKey || e.metaKey);
    var shift = !!e.shiftKey;

    // 备份按下前的选区，便于 Ctrl 横扫时与历史选区合并
    var baseSel = new Set();
    S.colSel.forEach(function (c) { baseSel.add(c); });

    // 起始锚点：Shift 沿用原锚点，否则以当前列为锚
    var anchor;
    if (shift && S._colSelAnchor >= 0) {
        anchor = S._colSelAnchor;
    } else {
        anchor = ci;
    }

    function applyRange(curCol) {
        var a = Math.min(anchor, curCol);
        var b = Math.max(anchor, curCol);
        var range = new Set();
        for (var i = a; i <= b; i++) range.add(i);
        if (ctrlOrMeta) {
            // Ctrl/⌘ 横扫：与原选区合并
            S.colSel = new Set(baseSel);
            range.forEach(function (c) { S.colSel.add(c); });
        } else {
            S.colSel = range;
        }
        S._colSelAnchor = anchor;
        updateColSelClasses();
    }

    // 找到鼠标当前所处的列头（仅响应同一表格内的 th[data-col]）
    function colAtPoint(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el) return -1;
        var th = el.closest ? el.closest('th.xs-th[data-col]') : null;
        if (!th) return -1;
        var v = parseInt(th.getAttribute('data-col'), 10);
        return isNaN(v) ? -1 : v;
    }

    function onMove(ev) {
        if (!moved) {
            var dx = Math.abs(ev.clientX - startX);
            var dy = Math.abs(ev.clientY - startY);
            if (dx < 3 && dy < 3) return;
            moved = true;
            // 一旦判定为横扫，立即给出区间反馈（哪怕鼠标尚未跨列）
            applyRange(ci);
        }
        var hover = colAtPoint(ev.clientX, ev.clientY);
        if (hover < 0) return;
        applyRange(hover);
    }

    function onUp(ev) {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        if (moved) return; // 横扫已经在 mousemove 阶段提交
        // 未移动 -> 按 click 规则处理
        if (shift && S._colSelAnchor >= 0) {
            var a = Math.min(S._colSelAnchor, ci);
            var b = Math.max(S._colSelAnchor, ci);
            S.colSel.clear();
            for (var i = a; i <= b; i++) S.colSel.add(i);
        } else if (ctrlOrMeta) {
            if (S.colSel.has(ci)) S.colSel.delete(ci); else S.colSel.add(ci);
            S._colSelAnchor = ci;
        } else {
            // 与 Excel 一致：单列再次点击保持选中而非取消
            S.colSel.clear();
            S.colSel.add(ci);
            S._colSelAnchor = ci;
        }
        updateColSelClasses();
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
}

// 在不重绘整表的前提下刷新列选中样式
function updateColSelClasses() {
    document.querySelectorAll('.xs-table th.xs-th[data-col]').forEach(function (th) {
        var ci = parseInt(th.getAttribute('data-col'), 10);
        if (S.colSel.has(ci)) th.classList.add('xs-col-selected'); else th.classList.remove('xs-col-selected');
    });
    document.querySelectorAll('.xs-table td.xs-td[data-col]').forEach(function (td) {
        var ci = parseInt(td.getAttribute('data-col'), 10);
        if (S.colSel.has(ci)) td.classList.add('xs-col-selected'); else td.classList.remove('xs-col-selected');
    });
}

// 清空/填充选中列。fillVal: undefined 表示清空；其他表示填充为该值
function applyColumnsBulk(fillVal) {
    if (!S.colSel || S.colSel.size === 0) return;
    var headers = (S.data && S.data.headers) || [];
    var rows = (S.data && S.data.rows) || [];
    if (rows.length === 0) { showToast('当前表格为空', 'error'); return; }
    // tsId 列保护（冻结）
    var targets = [];
    var skippedTsId = false;
    S.colSel.forEach(function (ci) {
        if (isFrozenCol(ci)) { skippedTsId = true; return; }
        targets.push(ci);
    });
    if (targets.length === 0) {
        showToast('tsId 列不允许清空/填充，已跳过', 'error');
        return;
    }
    pushHistory();
    var newScalar = (fillVal === undefined) ? '' : String(fillVal);
    // 受影响列的列筛选已失去意义，统一移除这些列的筛选条件。
    if (S._colFilters) {
        targets.forEach(function (ci) {
            if (S._colFilters[ci]) delete S._colFilters[ci];
        });
    }
    var changed = 0;
    // 过滤模式（仅看失败/搜索/其他列的列筛选）下，_viewRows 仅含可见行；
    // 对选中列做批量清空/填充时只覆盖可见行，避免误改被隐藏的成功行。
    // 注意：被操作列本身的列筛选已在上面 delete 过，无需再排除。
    var _allRowsLen = rows.length;
    var _viewSetCols = null;
    if (S._viewRows && S._viewRows.length && S._viewRows.length < _allRowsLen) {
        _viewSetCols = new Set(S._viewRows);
    }
    rows.forEach(function (row, ri) {
        if (_viewSetCols && !_viewSetCols.has(ri)) return;
        targets.forEach(function (ci) {
            // 标量数组列的填充：清空→[]；填充为 x → 以 '; ' 拆分成数组。
            var isArrTarget = typeof isArrayCol === 'function' && isArrayCol(ci);
            var oldV = row[ci];
            if (isArrTarget) {
                var newArr;
                if (fillVal === undefined) newArr = [];
                else {
                    newArr = newScalar.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                }
                var oldStr = Array.isArray(oldV) ? formatCellValue(oldV) : (oldV == null ? '' : String(oldV));
                var newStr = formatCellValue(newArr);
                if (oldStr !== newStr) {
                    row[ci] = newArr;
                    S.mods.add(ri + ',' + ci);
                    changed++;
                }
            } else {
                var oldStr2 = (oldV === null || oldV === undefined) ? '' : (Array.isArray(oldV) ? formatCellValue(oldV) : String(oldV));
                if (oldStr2 !== newScalar) {
                    row[ci] = newScalar;
                    S.mods.add(ri + ',' + ci);
                    changed++;
                }
            }
        });
    });
    saveFile();
    renderTable();
    var verb = (fillVal === undefined) ? '清空' : '填充';
    var msg = '已' + verb + ' ' + targets.length + ' 列、' + changed + ' 个单元格';
    if (skippedTsId) msg += '（tsId 已自动跳过）';
    showToast(msg, 'success');
}

function clearSelectedCols() { applyColumnsBulk(undefined); }
function fillSelectedCols() {
    xsPrompt('填充选中列的值（作用于全部行）', '', function (val) {
        if (val === null) return; // 取消
        applyColumnsBulk(val);
    });
}

// ==================== 行高拖动 ====================
function startRowResize(e) {
    // 点到 checkbox 上时不启动行高拖动，保留选择行的功能
    if (e.target && e.target.tagName === 'INPUT') return;
    // 仅响应主键
    if (e.button !== 0) return;
    // 兼容两种 currentTarget：旧版为 td.xs-td-cb，新版为 div.xs-row-resizer。
    var ct = e.currentTarget;
    var tr = (ct && ct.closest) ? ct.closest('tr') : (ct && ct.parentElement);
    if (!tr) return;
    var ri = parseInt(tr.getAttribute('data-row'), 10);
    if (isNaN(ri)) return;

    e.preventDefault();
    e.stopPropagation();

    var startY = e.clientY;
    var startH = tr.offsetHeight;
    document.body.classList.add('xs-row-resizing');

    function onMove(ev) {
        var h = Math.max(24, startH + (ev.clientY - startY));
        tr.style.height = h + 'px';
        if (h > startH || h !== 32) tr.classList.add('xs-tr-resized');
    }
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('xs-row-resizing');
        var finalH = tr.offsetHeight;
        S.rowHeights[ri] = finalH;
        if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// 双击行高拖手柄：按当前列宽下的内容自适应行高（与 Excel 一致，幂等）。
// 思路与 autoFitColumn 类似：
//   - 不能直接读 td.scrollHeight —— 在未启用 xs-tr-resized 时单元格是 nowrap+ellipsis，
//     一行内容只有 ~20px 高，根本读不到"展开后"的真实高度。
//   - 用离屏量尺：宽度固定为该列内容区宽度（列宽 - padding），
//     white-space:pre-wrap + word-break:break-word，把内容塞进去后读 offsetHeight，
//     即为该单元格"展开多行"后的真实渲染高度。
//   - 取所有列的最大高度 + 单元格 padding，作为该行高度。
//   - 若结果约等于默认单行高度，则视为单行内容，清空自定义高度回到默认（与 Excel 一致）。
function resetRowHeight(e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    var ct = e.currentTarget;
    var tr = (ct && ct.closest) ? ct.closest('tr') : (ct && ct.parentElement);
    if (!tr) return;
    var ri = parseInt(tr.getAttribute('data-row'), 10);
    if (isNaN(ri)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();

    var headers = (S.data && S.data.headers) || [];
    if (headers.length === 0) {
        delete S.rowHeights[ri];
        tr.style.height = '';
        tr.classList.remove('xs-tr-resized');
        return;
    }

    // 创建离屏量尺：固定宽度、可换行
    var ruler = document.createElement('div');
    ruler.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;'
        + 'white-space:pre-wrap;word-break:break-word;display:block;'
        + 'padding:0;border:0;box-sizing:content-box;pointer-events:none';
    // 继承单元格字体样式
    var sample = tr.querySelector('.xs-cell-wrap');
    if (sample) {
        var cs = window.getComputedStyle(sample);
        ruler.style.font = cs.font;
        ruler.style.fontSize = cs.fontSize;
        ruler.style.fontFamily = cs.fontFamily;
        ruler.style.fontWeight = cs.fontWeight;
        ruler.style.lineHeight = cs.lineHeight;
        ruler.style.letterSpacing = cs.letterSpacing;
    }
    document.body.appendChild(ruler);

    // 单元格 padding(6+6=12) + 边框(1+1=2) = 14px；内容可用宽 = 列宽 - 14
    var CELL_PAD_V = 14; // 上下 padding+border
    var CELL_PAD_H = 14; // 左右 padding+border
    var maxContentH = 0;
    try {
        var tds = tr.querySelectorAll('td.xs-editable');
        for (var i = 0; i < tds.length; i++) {
            var td = tds[i];
            var ci = parseInt(td.getAttribute('data-col'), 10);
            if (isNaN(ci)) continue;
            var colW = (S.colWidths && S.colWidths[ci]) || td.offsetWidth || 100;
            var contentW = Math.max(20, colW - CELL_PAD_H);
            ruler.style.width = contentW + 'px';
            var wrap = td.querySelector('.xs-cell-wrap');
            ruler.innerHTML = wrap ? wrap.innerHTML : '';
            var h = ruler.offsetHeight;
            if (h > maxContentH) maxContentH = h;
        }
    } finally {
        document.body.removeChild(ruler);
    }

    // 行总高 = 最大内容高 + 单元格上下 padding+border
    var needH = Math.ceil(maxContentH) + CELL_PAD_V;
    // 上下界：最小默认行高 26，最大 600
    var DEFAULT_H = 26;
    var finalH = Math.max(DEFAULT_H, Math.min(600, needH));

    // 若结果约等于默认行高（差异 ≤ 2px），视为单行内容，回归默认（不写自定义高度）
    if (finalH - DEFAULT_H <= 2) {
        delete S.rowHeights[ri];
        tr.style.height = '';
        tr.classList.remove('xs-tr-resized');
    } else {
        S.rowHeights[ri] = finalH;
        tr.style.height = finalH + 'px';
        tr.classList.add('xs-tr-resized');
    }

    // 行高变了，虚拟滚动的偏移表需要重算
    if (typeof _computeRowOffsets === 'function') {
        try { _computeRowOffsets(); } catch (e2) { /* ignore */ }
    }
    // 持久化（与列宽一致使用 debounced 保存）
    if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
}
