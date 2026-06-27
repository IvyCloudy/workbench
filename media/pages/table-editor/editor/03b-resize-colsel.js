/* =============================================================================
 * 03b-resize-colsel.js  —— 列宽 / 列选择 / 行高（尺寸 & 选区）
 * -----------------------------------------------------------------------------
 * 由原 03-cell-ops.js 拆分而来，集中处理"鼠标拖动改变尺寸"以及"按列选区"：
 *   0. 配置常量：PROTECTED_COLS（受保护列名清单，集中维护，见文件顶部）
 *   1. 列宽拖动：startColResize（拖动 .xs-resizer 实时改宽，mouseup 后持久化）
 *      autoFitColumn（双击 resizer 自适应：用离屏量尺测真实内容宽度）
 *   2. 列选择（Excel 风格）：
 *      - isFrozenCol（testcase_id 完全只读：禁止编辑/粘贴/清空/批量等任意写入）
 *      - isProtectedCol（业务必备列仅锁结构：禁止删除列/重命名列，不影响数据操作）
 *      - onColHeaderMouseDown（列头按住左键横扫成区间；Ctrl/Shift 修饰）
 *      - updateColSelClasses / applyColumnsBulk / clearSelectedCols / fillSelectedCols
 *   3. 行高拖动：startRowResize（拖动 .xs-row-resizer 实时改高）
 *      resetRowHeight（双击自适应：离屏量尺读 wrap 后真实高度，幂等）
 *
 * 单元格编辑、右键菜单、行/列数据操作见 03a-cell-edit.js（其中 deleteCol /
 * renameCol 内已基于 isFrozenCol + isProtectedCol 做兜底拦截）。
 * 跨文件依赖通过全局作用域共享（S、persistUiStateDebounced、isArrayCol、
 * formatCellValue、_computeRowOffsets 等）。
 * ========================================================================== */


// ==================== 配置常量 ====================
// 受保护列名清单：命中的列在右键菜单中不渲染「删除该列 / 重命名列」，
// 并在 deleteCol / renameCol 函数内部做兜底拦截。
// 维护说明：业务必备列请直接在此追加/移除列名（英文字段名，与 headers 中一致）。
// 与 isFrozenCol（testcase_id 完全只读）语义不同，本清单仅锁结构（列名/列存在性），
// 不影响单元格编辑、粘贴、批量清空、批量填充等数据操作。
var PROTECTED_COLS = [
    'testcase_id',
    'testCaseNo',
    'path',
    'name',
    'preconditions',
    'description',
    'priority',
    'test_type',
    'steps'
];


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
    function onUp(ev) {
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

// 受保护列：禁止结构性变更（删除列 / 重命名列），但不限制编辑、粘贴、批量等
// 与 isFrozenCol 语义不同：isFrozenCol 是"完全只读"，isProtectedCol 仅锁列名/列存在性
// 命中后右键菜单中的 "删除该列" / "重命名列" 直接不渲染（不显示）
// 列名清单 PROTECTED_COLS 见文件顶部「配置常量」区，便于集中维护
function isProtectedCol(ci) {
    if (typeof ci !== 'number' || ci < 0) return false;
    var headers = (S.data && S.data.headers) || [];
    var name = headers[ci];
    if (!name) return false;
    for (var i = 0; i < PROTECTED_COLS.length; i++) {
        if (PROTECTED_COLS[i] === name) return true;
    }
    return false;
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
        showToast('testcase_id 列不允许清空/填充，已跳过', 'error');
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
    if (skippedTsId) msg += '（testcase_id 已自动跳过）';
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
    // 注意：不在这里立刻 remove xs-tr-resized 类，避免"按下→不动→松开"时
    //   类被清掉但 tr.style.height 还保留，导致行高大却只显示单行省略号的不一致状态。
    //   类的清理推迟到 onMove 第一次触发时（确认是真拖动）。
    var movedOnce = false;
    var rowWraps = tr.querySelectorAll('.xs-cell-wrap');

    // td 的 padding+边框占用：padding:6px*2 + border:1px*2 = 14px
    var TD_CHROME = 14;
    var MIN_SINGLE = 32;

    // 探测 cell-wrap 的行高（用于把"行高"换算成"可显示行数"）。
    // 优先复用渲染端的 _xsLineHeight，保证与 --xs-clamp 计算一致；
    // 渲染端未加载时退回本地探测 + fontSize*1.4 兑底。
    function _probeLineHeight() {
        if (typeof _xsLineHeight === 'function') {
            try { var v = _xsLineHeight(); if (v > 0) return v; } catch (_e) {}
        }
        if (!rowWraps[0]) return 18;
        var cs = window.getComputedStyle(rowWraps[0]);
        var lh = parseFloat(cs.lineHeight);
        if (!isFinite(lh) || lh <= 0) {
            var fs = parseFloat(cs.fontSize) || 13;
            lh = fs * 1.4;
        }
        return lh;
    }

    // ----- 清除 cell-wrap 内联样式（恢复 CSS 控制）-----
    // 复用模块级 _clearRowWrapStyles，避免与 _collapseRowToSingle / _expandRowToFitContent 三处重复。
    function _clearWraps() {
        _clearRowWrapStyles(rowWraps);
    }
    // ----- 按行高写入 --xs-clamp（可显示行数），实现"超出可见区域显示 …" -----
    // 关键点：先临时给 tr 加 xs-tr-resized 类，让 CSS 的 -webkit-line-clamp 生效，
    //        再按 (wrapH / lineHeight) 算出 clamp 行数；不再设固定 height，避免与
    //        line-clamp 冲突导致渲染抖动。
    function _lockWraps(rowH) {
        if (rowH <= TD_CHROME) return;
        if (!tr.classList.contains('xs-tr-resized')) tr.classList.add('xs-tr-resized');
        var wrapH = rowH - TD_CHROME;
        var lh = _probeLineHeight();
        var lines = Math.max(1, Math.floor(wrapH / lh));
        for (var l = 0; l < rowWraps.length; l++) {
            // 清除可能残留的 height/whiteSpace/overflow，让 CSS 接管
            rowWraps[l].style.whiteSpace = '';
            rowWraps[l].style.overflow = '';
            rowWraps[l].style.height = '';
            rowWraps[l].style.setProperty('--xs-clamp', String(lines));
        }
    }

    function onMove(ev) {
        // 第一次真正移动时再做清理（清 xs-tr-resized 类 + 清 wrap 残留 + 清 tr 内联高度），
        // 避免"按下→不动→松开"时把状态破坏。
        if (!movedOnce) {
            movedOnce = true;
            tr.classList.remove('xs-tr-resized');
            _clearWraps();
        }
        var h = Math.max(24, startH + (ev.clientY - startY));
        tr.style.height = h + 'px';
        // 超过单行阈值：锁定 cell-wrap 高度 + 换行，跟随拖动实时更新
        if (h > MIN_SINGLE + 4) {
            _lockWraps(h);
        } else {
            _clearWraps();
        }
    }
    function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('xs-row-resizing');
        var dy = ev.clientY - startY;
        // 没真正拖动过（onMove 没触发或位移 < 3px）→ 视为误触/单纯点击
        // 注意：如果 onMove 已经进入过（movedOnce=true）但位移<3px，那么在 onMove 里
        // 清掉了 xs-tr-resized 类但可能写入了临时 height/--xs-clamp，需要恢复到
        // 开始拖动前的状态，避免状态错乱。
        if (!movedOnce || Math.abs(dy) < 3) {
            if (movedOnce) {
                _clearWraps();
                tr.style.height = '';
                // 恢复开始拖动前的状态位：若 S.rowHeights[ri] 原本有值，重新应用
                var prevRh = S.rowHeights[ri];
                if (prevRh && prevRh > 0) {
                    tr.style.height = prevRh + 'px';
                    tr.classList.add('xs-tr-resized');
                }
            }
            return;
        }
        // 行有拖动 → 行高变为"展示本行数据所有内容"（与双击展开一致）
        _clearWraps();
        tr.style.height = '';
        _expandRowToFitContent(tr, ri);
        // 强制重排：确保样式立即生效
        // eslint-disable-next-line no-unused-expressions
        tr.offsetHeight;
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ----- 测量真实默认行高 -----
// 默认行高受主题、字体、padding 影响（实测可能是 32~40）。
// 取同表中第一个未自定义高度（无 xs-tr-resized 类、无内联 height、且不是当前 tr 自己）的行
// 的 offsetHeight 作为基准；找不到就退回常量 32。
// 此函数在 resetRowHeight / _expandRowToFitContent 中用于"是否已展开"的阈值判断。
function _measureDefaultRowH(curTr) {
    try {
        var tbl = curTr && curTr.closest ? curTr.closest('table') : null;
        var scope = tbl || document;
        var rows = scope.querySelectorAll('tbody tr[data-row]');
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (r === curTr) continue;
            if (r.classList.contains('xs-tr-resized')) continue;
            if (r.style && r.style.height) continue;
            var h = r.offsetHeight || 0;
            if (h > 0) return h;
        }
    } catch (_e) { /* ignore */ }
    return 32;
}

// ----- 把行恢复为默认单行高度（清状态 + 清类 + 清内联样式）-----
// 共享给：
//   1) resetRowHeight 的「toggle 回单行」分支
//   2) _expandRowToFitContent 测得 finalH ≈ DEFAULT_H 的回归分支
// 单一职责：彻底清掉自定义行高的所有副作用，确保 CSS 接管。
// ----- 清除一行所有 .xs-cell-wrap 的内联样式（恢复 CSS 控制） -----
// 共享给：startRowResize 的 _clearWraps、_collapseRowToSingle、_expandRowToFitContent 起始清理
// 入参可以是 NodeList（已查询好）或 tr 元素（自动查询）；其它类型一律忽略。
function _clearRowWrapStyles(wrapsOrTr) {
    var wraps = null;
    if (!wrapsOrTr) return;
    if (wrapsOrTr.querySelectorAll) {
        // tr 元素
        wraps = wrapsOrTr.querySelectorAll('.xs-cell-wrap');
    } else if (typeof wrapsOrTr.length === 'number') {
        // NodeList / Array
        wraps = wrapsOrTr;
    } else {
        return;
    }
    for (var i = 0; i < wraps.length; i++) {
        var w = wraps[i];
        w.style.whiteSpace = '';
        w.style.overflow = '';
        w.style.height = '';
        w.style.removeProperty('--xs-clamp');
    }
}

function _collapseRowToSingle(tr, ri) {
    if (!tr) return;
    if (typeof ri === 'number' && !isNaN(ri)) {
        delete S.rowHeights[ri];
        if (S._rowExpanded) S._rowExpanded.delete(ri);
    }
    tr.style.height = '';
    tr.classList.remove('xs-tr-resized');
    _clearRowWrapStyles(tr);
    var tds = tr.querySelectorAll('td.xs-editable');
    for (var j = 0; j < tds.length; j++) {
        tds[j].style.whiteSpace = '';
        tds[j].style.overflow = '';
    }
}

// ----- 把指定行扩展到"能完整显示所有内容"的高度 -----
// 共享给：
//   1) 双击空行（resetRowHeight 第奇数次双击）
//   2) 鼠标拖动行高结束后（startRowResize 的 onUp）
// 测量思路：
//   - 用离屏量尺，宽度固定为该列内容区宽度（列宽 - padding），
//     white-space:pre-wrap + word-break:break-word，读 offsetHeight 得到展开后的真实高度。
function _expandRowToFitContent(tr, ri) {
    if (!tr || isNaN(ri)) return;
    // 清除拖动可能残留的 cell-wrap 内联样式（与 _collapseRowToSingle 走同一个工具函数）
    _clearRowWrapStyles(tr);

    var headers = (S.data && S.data.headers) || [];
    if (headers.length === 0) {
        _collapseRowToSingle(tr, ri);
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
    var CELL_PAD_V = 14;
    var CELL_PAD_H = 14;
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
            // 量尺 div 已设 white-space:pre-wrap，wrap.innerHTML 中保留的真实换行符 \n
            // 会自然产生换行，准确测出"完整显示所有内容"所需高度。
            ruler.innerHTML = wrap ? wrap.innerHTML : '';
            var h = ruler.offsetHeight;
            if (h > maxContentH) maxContentH = h;
        }
    } finally {
        document.body.removeChild(ruler);
    }

    var needH = Math.ceil(maxContentH) + CELL_PAD_V;
    var DEFAULT_H = _measureDefaultRowH(tr);
    var finalH = Math.max(DEFAULT_H, Math.min(600, needH));

    // 若结果接近默认行高（差异 ≤ 3px），视为单行内容，回归默认
    if (finalH - DEFAULT_H <= 3) {
        _collapseRowToSingle(tr, ri);
    } else {
        S.rowHeights[ri] = finalH;
        // 标记该行为"完全展开"——渲染层据此跳过 --xs-clamp 行数限制，
        // 避免行高足以容纳所有内容但单元格仍按 floor(rowH/lineH) 截断的现象。
        if (!S._rowExpanded) S._rowExpanded = new Set();
        S._rowExpanded.add(ri);
        tr.style.height = finalH + 'px';
        tr.classList.add('xs-tr-resized');
    }

    if (typeof _computeRowOffsets === 'function') {
        try { _computeRowOffsets(); } catch (e2) { /* ignore */ }
    }
    if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
}

// 双击行高拖手柄：切换行高（与 Excel 一致）。
//   - 第奇数次双击（当前为单行）：自适应展开为"完整显示所有内容"
//   - 第偶数次双击（当前已展开）：恢复默认单行高度
function resetRowHeight(e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    var ct = e.currentTarget;
    var tr = (ct && ct.closest) ? ct.closest('tr') : (ct && ct.parentElement);
    if (!tr) return;
    var ri = parseInt(tr.getAttribute('data-row'), 10);
    if (isNaN(ri)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();

    // 判断当前是否已展开：以 hasCustomH 与 hasResizedCls 为权威状态位。
    //   1) S.rowHeights[ri] 有值 → 已展开
    //   2) tr 带 xs-tr-resized 类 → 已展开
    // 注意：之前曾用 curH > DEFAULT_H + 3 做兜底，但默认行高随主题、字体、padding
    //   及上下行高变化会落在 32~40 之间，常导致最后一行/边界行被误判为已展开，
    //   从而第一次双击直接走"回单行"分支，无法触发展开测量。
    //   两个状态位天然由本模块统一维护，不依赖它们之外的兜底反而更稳。
    var hasCustomH = !!(S.rowHeights[ri] && S.rowHeights[ri] > 0);
    var hasResizedCls = tr.classList.contains('xs-tr-resized');
    var isExpanded = hasCustomH || hasResizedCls;

    // 若当前已是展开状态 → 恢复默认单行高度（toggle 回单行）
    if (isExpanded) {
        _collapseRowToSingle(tr, ri);
        if (typeof _computeRowOffsets === 'function') {
            try { _computeRowOffsets(); } catch (e4) { /* ignore */ }
        }
        if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
        return;
    }

    // 当前为单行 → 展开为"完整显示所有内容"
    _expandRowToFitContent(tr, ri);
}
