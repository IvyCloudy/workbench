/* =============================================================================
 * 02c-row-cell-sel.js  —— 行选 / 单元格矩形选区（Excel 风格）
 * -----------------------------------------------------------------------------
 * 由原 02-render-bind.js 拆分而来，仅保留 onRowNumMouseDown（行号格点击/横扫）
 * 与 onCellMouseDown（单元格拖选 / Shift 区间扩展）。其辅助函数
 * selectAllCells / getCellSelRect / isCellInSel / updateCellSelClasses /
 * updateRowSelClasses 见 02d-sel-utils.js。
 * 跨文件依赖通过全局作用域共享。
 * ========================================================================== */

// ==================== 行选 / 单元格矩形选区（Excel 风格） ====================
// 单击行号格：与 Excel 对齐，单选当前行；Shift = 区间扩展；Ctrl/Cmd = 离散追加。
// 按住拖动：从锚点行到悬停行形成连续区间（与 Excel 一致的“横扫选行”）。
function onRowNumMouseDown(e) {
    if (!e.currentTarget) return;
    if (e.button !== 0) return;
    var td = e.currentTarget;
    var ri = parseInt(td.getAttribute('data-row'), 10);
    if (isNaN(ri)) return;
    // 阻止默认选中文本等行为
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();

    var startX = e.clientX;
    var startY = e.clientY;
    var moved = false;
    var ctrlOrMeta = !!(e.ctrlKey || e.metaKey);
    var shift = !!e.shiftKey;

    // 备份按下前的选区，便于 Ctrl 横扫时与历史选区合并
    var baseSel = new Set();
    S.sel.forEach(function (r) { baseSel.add(r); });

    // 起始锚点：Shift 沿用原锚点，否则以当前行为锚
    var anchor = (shift && S._rowSelAnchor >= 0) ? S._rowSelAnchor : ri;

    function applyRange(curRow) {
        var a = Math.min(anchor, curRow);
        var b = Math.max(anchor, curRow);
        var range = new Set();
        // 关键：选区只覆盖"当前可见行"。在搜索 / 列筛选 / 仅看推送失败等过滤模式下，
        // 直接按原始行号区间 [a,b] 填充会把被过滤掉的行也算进来，导致选中行数与肉眼可见不一致。
        // 这里改为先把 [a,b] 映射到 S._viewRows 中的位置区间，再回填可见行的真实行号。
        var view = (S._viewRows && S._viewRows.length) ? S._viewRows : null;
        if (view) {
            var posA = view.indexOf(a);
            var posB = view.indexOf(b);
            // 极端情况下锚点行可能已被过滤而不在 view 中（例如仅看失败模式下，前一次锚定的行刚刚成功）。
            // 此时退化为：取 [a,b] 内仍可见的所有行。
            if (posA < 0 || posB < 0) {
                for (var vi = 0; vi < view.length; vi++) {
                    var r = view[vi];
                    if (r >= a && r <= b) range.add(r);
                }
            } else {
                var p1 = Math.min(posA, posB);
                var p2 = Math.max(posA, posB);
                for (var k = p1; k <= p2; k++) range.add(view[k]);
            }
        } else {
            for (var i = a; i <= b; i++) range.add(i);
        }
        if (ctrlOrMeta) {
            S.sel = new Set(baseSel);
            range.forEach(function (r) { S.sel.add(r); });
        } else {
            S.sel = range;
        }
        S._rowSelAnchor = anchor;
        // 行选与单元格矩形选区互斥
        S.cellSel = null;
        S.colSel.clear();
        S._colSelAnchor = -1;
        updateColSelClasses();
        updateRowSelClasses();
        updateCellSelClasses();
        updateSelectionInfo();
        updatePushBtn();
    }

    function rowAtPoint(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el) return -1;
        var t = el.closest ? el.closest('td.xs-td-cb[data-row]') : null;
        if (!t) return -1;
        var v = parseInt(t.getAttribute('data-row'), 10);
        return isNaN(v) ? -1 : v;
    }

    function onMove(ev) {
        if (!moved) {
            var dx = Math.abs(ev.clientX - startX);
            var dy = Math.abs(ev.clientY - startY);
            if (dx < 3 && dy < 3) return;
            moved = true;
            applyRange(ri);
        }
        var hover = rowAtPoint(ev.clientX, ev.clientY);
        if (hover < 0) return;
        applyRange(hover);
    }

    function onUp() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        if (moved) return; // 横扫已在 mousemove 阶段提交
        // 未移动 → 按 click 规则处理
        if (shift && S._rowSelAnchor >= 0) {
            var a = Math.min(S._rowSelAnchor, ri);
            var b = Math.max(S._rowSelAnchor, ri);
            S.sel.clear();
            // 同 applyRange：Shift 范围选择只覆盖当前可见行，避免在过滤模式下把被过滤行误选
            var view2 = (S._viewRows && S._viewRows.length) ? S._viewRows : null;
            if (view2) {
                var posA2 = view2.indexOf(a);
                var posB2 = view2.indexOf(b);
                if (posA2 < 0 || posB2 < 0) {
                    for (var vi2 = 0; vi2 < view2.length; vi2++) {
                        var r2 = view2[vi2];
                        if (r2 >= a && r2 <= b) S.sel.add(r2);
                    }
                } else {
                    var p1b = Math.min(posA2, posB2);
                    var p2b = Math.max(posA2, posB2);
                    for (var kk = p1b; kk <= p2b; kk++) S.sel.add(view2[kk]);
                }
            } else {
                for (var i = a; i <= b; i++) S.sel.add(i);
            }
        } else if (ctrlOrMeta) {
            if (S.sel.has(ri)) S.sel.delete(ri); else S.sel.add(ri);
            S._rowSelAnchor = ri;
        } else {
            S.sel.clear();
            S.sel.add(ri);
            S._rowSelAnchor = ri;
        }
        S.cellSel = null;
        S.colSel.clear();
        S._colSelAnchor = -1;
        updateColSelClasses();
        updateRowSelClasses();
        updateCellSelClasses();
        updateSelectionInfo();
        updatePushBtn();
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
}

// 单元格 mousedown：开始矩形拖选（Excel 风格）
// - 普通点击：把锚点和焦点都设为当前格（单格选区）
// - Shift 点击：保留 anchor，把 focus 移到当前格（区间扩展）
// - 按住拖动：实时更新 focus 形成矩形
function onCellMouseDown(e) {
    if (!e.currentTarget) return;
    if (e.button !== 0) return;
    var td = e.currentTarget;
    var ri = parseInt(td.getAttribute('data-row'), 10);
    var ci = parseInt(td.getAttribute('data-col'), 10);
    if (isNaN(ri) || isNaN(ci)) return;
    // 编辑态下不接管选区，保持 textarea 自身鼠标行为
    if (S.editing) return;

    // 关键修复：若上一次拖动的监听器因 mouseup 未触发（例如鼠标在 webview 外松开、
    // VSCode 主进程吞掉事件、window blur 等情况）而残留，会形成「僵尸 onMove」
    // 与本次 mousedown 创建的新 onMove 同时改 S.cellSel.focus，导致列扩散等异常。
    // 在进入本次拖动前，强制清理上一次的 handler。
    if (S._cellDragOnMove) {
        if (typeof dbg === 'function') dbg('⚠️ 检测到上次拖动 handler 残留（onUp 未触发），强制清理');
        document.removeEventListener('mousemove', S._cellDragOnMove, true);
        S._cellDragOnMove = null;
    }
    if (S._cellDragOnUp) {
        document.removeEventListener('mouseup', S._cellDragOnUp, true);
        S._cellDragOnUp = null;
    }
    S._cellDragging = false;

    var shift = !!e.shiftKey;
    var startX = e.clientX;
    var startY = e.clientY;
    var moved = false;

    // 诊断：把所有 modifier 状态、e.button、点击前的 cellSel 都打出来，
    // 排查"普通点击却变成多选"的根因（怀疑 shiftKey 误判 / 别的代码扩了 cellSel）
    if (typeof dbg === 'function') {
        var prevSel = S.cellSel
            ? ('a(r' + S.cellSel.anchor.r + ',c' + S.cellSel.anchor.c + ')→f(r' + S.cellSel.focus.r + ',c' + S.cellSel.focus.c + ')')
            : 'null';
        // 同时打印行选 / 列选 / active 单元格，排查"视觉上多列高亮"是否来自其他选区残留
        var rowSelArr = (S.sel && typeof S.sel.values === 'function') ? Array.from(S.sel) : [];
        var colSelArr = (S.colSel && typeof S.colSel.values === 'function') ? Array.from(S.colSel) : [];
        dbg('🔍 mousedown modifiers shift=' + shift + ' ctrl=' + e.ctrlKey + ' meta=' + e.metaKey + ' alt=' + e.altKey
            + ' button=' + e.button + ' click=(r' + ri + ',c' + ci + ') prevCellSel=' + prevSel
            + ' rowSel=[' + rowSelArr.join(',') + '] colSel=[' + colSelArr.join(',') + ']'
            + ' active=' + (S.cell ? ('(r' + S.cell.r + ',c' + S.cell.c + ')') : 'null'));
    }

    // 设定 active 单元格高亮（沿用既有 .xs-editable.active 样式）
    document.querySelectorAll('.xs-editable.active').forEach(function (n) { n.classList.remove('active'); });
    td.classList.add('active');
    S.cell = { r: ri, c: ci };

    if (shift && S.cellSel && S.cellSel.anchor) {
        if (typeof dbg === 'function') dbg('🟧 mousedown走SHIFT分支 → 区间扩展 anchor=(r' + S.cellSel.anchor.r + ',c' + S.cellSel.anchor.c + ') newFocus=(r' + ri + ',c' + ci + ')');
        S.cellSel = { anchor: S.cellSel.anchor, focus: { r: ri, c: ci } };
    } else {
        if (typeof dbg === 'function') dbg('🟩 mousedown走普通分支 → 单格 (r' + ri + ',c' + ci + ')');
        S.cellSel = { anchor: { r: ri, c: ci }, focus: { r: ri, c: ci } };
    }
    // 单元格选区与行/列选互斥（更符合 Excel：点单元格会清掉行选/列选）
    if (!shift) {
        S.sel.clear();
        S.colSel.clear();
        S._colSelAnchor = -1;
        S._rowSelAnchor = -1;
    }
    updateColSelClasses();
    updateRowSelClasses();
    updateCellSelClasses();
    updateSelectionInfo();
    updatePushBtn();

    function cellAtPoint(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el) return null;
        var t = el.closest ? el.closest('td.xs-editable') : null;
        if (!t) return null;
        var r2 = parseInt(t.getAttribute('data-row'), 10);
        var c2 = parseInt(t.getAttribute('data-col'), 10);
        if (isNaN(r2) || isNaN(c2)) return null;
        return { r: r2, c: c2 };
    }

    // 拖选锁列策略（双重防护，同时满足以下任一条件就锁列）：
    // (1) 累计 dy 显著大于 dx（ady > adx * 1.5）—— 用户主动方向是纵向拖动；
    // (2) 鼠标 X 还在「起始列宽度范围内」—— 鼠标横向漂移幅度未越过半个列宽；
    // 两者皆不满足才进入自由矩形模式（按 hit.c 跟随）。
    // 这样可以同时挡掉「鼠标轻微漂移」与「斜向下拖但用户意图是纵向」两种误带相邻列的情况。
    var anchorRect = td.getBoundingClientRect();
    var anchorCenterX = anchorRect.left + anchorRect.width / 2;
    var anchorHalfW = Math.max(20, anchorRect.width / 2);
    // 关键：拖选期间禁用浏览器原生文本反白，避免拖动路径上的文字被原生 selection
    // 高亮，造成"多列被选中"的视觉错觉，并防止 Ctrl+C 误复制原生 selection 内容。
    try {
        var _sel = window.getSelection && window.getSelection();
        if (_sel && _sel.removeAllRanges) _sel.removeAllRanges();
    } catch (_e) { }
    var _prevUserSelect = document.body.style.userSelect;
    var _prevWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    if (typeof dbg === 'function') {
        dbg('🖱️ cellMouseDown start ri=' + ri + ' ci=' + ci
            + ' anchorRect=[L' + anchorRect.left.toFixed(1) + ',W' + anchorRect.width.toFixed(1) + ']'
            + ' anchorCenterX=' + anchorCenterX.toFixed(1)
            + ' anchorHalfW=' + anchorHalfW.toFixed(1)
            + ' startX=' + startX + ' startY=' + startY);
    }
    var _moveLogN = 0;
    var _lastLoggedNextC = ci;
    var _lastLoggedHitR = ri;
    // 关键：给本次拖动分配唯一 ID。若 onMove 调用时 S._cellDragId 已被新一次
    // mousedown 覆盖（或被 onUp 清空），说明本闭包是僵尸 handler，立刻自注销并退出，
    // 避免它继续修改 S.cellSel.focus 与新的 onMove 互相覆盖（这是"列乱跳"的根因）。
    var myDragId = (S._cellDragSeq = (S._cellDragSeq || 0) + 1);
    S._cellDragId = myDragId;
    if (typeof dbg === 'function') dbg('🆔 dragId=' + myDragId + ' assigned');
    // rAF 节流：mousemove 高频触发，最多一个 rAF 周期处理一次，累计的中间 ev 全部丢弃。
    var _moveRaf = 0;
    var _pendingEv = null;
    function _processMove(ev) {
        // 僵尸闭包守卫
        if (S._cellDragId !== myDragId) {
            if (typeof dbg === 'function') dbg('💀 zombie onMove dragId=' + myDragId + ' current=' + S._cellDragId + ' → 自注销');
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            return;
        }
        var adx = Math.abs(ev.clientX - startX);
        var ady = Math.abs(ev.clientY - startY);
        if (!moved) {
            if (adx < 4 && ady < 4) return;
            moved = true;
            S._cellDragging = true;
        }
        var hit = cellAtPoint(ev.clientX, ev.clientY);
        if (!hit) {
            if (typeof dbg === 'function' && _moveLogN < 200) {
                dbg('🖱️ move#' + (_moveLogN++) + ' [drag' + myDragId + '] hit=null clientX=' + ev.clientX + ' clientY=' + ev.clientY);
            }
            return;
        }
        // 条件 1：累计纵向位移 >= 1.5 倍横向位移，认为用户主导方向是纵向 → 锁列
        var verticalDominant = ady >= adx * 1.5;
        // 条件 2：鼠标 X 仍处于起始列范围内（半列宽滞回）→ 锁列
        var dxFromCenter = Math.abs(ev.clientX - anchorCenterX);
        var withinStartCol = dxFromCenter < anchorHalfW;
        var lockCol = verticalDominant || withinStartCol;
        var nextC = lockCol ? ci : hit.c;
        var focus = { r: hit.r, c: nextC };
        if (!S.cellSel) S.cellSel = { anchor: { r: ri, c: ci }, focus: focus };
        else S.cellSel.focus = focus;
        // 只在 nextC 或 hit.r 发生变化时打日志，避免静止帧刷屏，但保证全程关键事件都能捕获
        var nextCChanged = (nextC !== _lastLoggedNextC);
        var hitRChanged = (hit.r !== _lastLoggedHitR);
        if (typeof dbg === 'function' && _moveLogN < 200 && (nextCChanged || hitRChanged)) {
            dbg('🖱️ move#' + (_moveLogN++) + ' [drag' + myDragId + ']'
                + ' clientX=' + ev.clientX + ' clientY=' + ev.clientY
                + ' adx=' + adx.toFixed(1) + ' ady=' + ady.toFixed(1)
                + ' dxCenter=' + dxFromCenter.toFixed(1) + '/' + anchorHalfW.toFixed(1)
                + ' hit=(r' + hit.r + ',c' + hit.c + ')'
                + ' vDom=' + verticalDominant + ' inCol=' + withinStartCol
                + ' lock=' + lockCol + ' nextC=' + nextC
                + ' setFocus=(r' + focus.r + ',c' + focus.c + ')'
                + (nextCChanged ? ' [C-CHANGED ' + _lastLoggedNextC + '→' + nextC + ']' : '')
                + (hitRChanged ? ' [R-CHANGED ' + _lastLoggedHitR + '→' + hit.r + ']' : ''));
            _lastLoggedNextC = nextC;
            _lastLoggedHitR = hit.r;
        }
        updateCellSelClasses();
        updateSelectionInfo();
    }
    function onMove(ev) {
        // 僵尸闭包守卫（与 _processMove 中一致，提前判断避免冲突）
        if (S._cellDragId !== myDragId) {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            return;
        }
        // rAF 节流：记下最新 ev，有 RAF 在跱则不重复调度。
        // 由于 MouseEvent 子段在同步使用（我们需要 clientX/clientY），这里浅拷必要字段即可。
        _pendingEv = {
            clientX: ev.clientX,
            clientY: ev.clientY
        };
        if (_moveRaf) return;
        _moveRaf = requestAnimationFrame(function () {
            _moveRaf = 0;
            var pe = _pendingEv;
            _pendingEv = null;
            if (!pe) return;
            // 调度后再检一次 dragId，防止 onUp 已清零
            if (S._cellDragId !== myDragId) return;
            _processMove(pe);
        });
    }

    function onUp() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        S._cellDragOnMove = null;
        S._cellDragOnUp = null;
        S._cellDragging = false;
        // 取消可能残留的 rAF 帧，避免在松手后再多刷一次选区
        if (_moveRaf) { try { cancelAnimationFrame(_moveRaf); } catch (_) {} _moveRaf = 0; _pendingEv = null; }
        // 恢复原生 user-select
        document.body.style.userSelect = _prevUserSelect || '';
        document.body.style.webkitUserSelect = _prevWebkitUserSelect || '';
        // 仅在自己仍是当前 dragId 时清空，避免影响后续新拖动
        if (S._cellDragId === myDragId) S._cellDragId = 0;
        if (typeof dbg === 'function') {
            var finSel = S.cellSel
                ? ('a(r' + S.cellSel.anchor.r + ',c' + S.cellSel.anchor.c + ')→f(r' + S.cellSel.focus.r + ',c' + S.cellSel.focus.c + ')')
                : 'null';
            // 统计 DOM 上真实带 xs-cell-selected 类的单元格数，与 cellSel 推算的矩形大小对比
            var domSelected = document.querySelectorAll('.xs-table td.xs-cell-selected').length;
            dbg('🖱️ onUp [drag' + myDragId + '] finalCellSel=' + finSel + ' domSelectedCount=' + domSelected);
        }
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    // 保存当前 handler 引用，下次 mousedown 时若 onUp 未触发，可强制清理
    S._cellDragOnMove = onMove;
    S._cellDragOnUp = onUp;
}
