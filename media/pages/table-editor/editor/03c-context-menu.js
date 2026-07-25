/* =============================================================================
 * 03c-context-menu.js  —— 右键菜单
 * -----------------------------------------------------------------------------
 * 由原 03a-cell-edit.js 拆分而来，根据点击位置（行号格 / 列头 / 单元格 / 选区）
 * 动态构造菜单项：插入行/列、删除行/列、复制粘贴、清空、推送、标记等。
 *
 *   showContextMenu(e)  — 显示菜单
 *   hideContextMenu()   — 隐藏菜单
 *
 * 菜单中各项的实际执行函数定义在 03d-row-col-ops.js / 03e-mark.js / 04-push-find.js
 * 中，本文件仅负责构造与展示。
 * ========================================================================== */

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
    // 如果在未选中的表头上右键，默认选中该列（同 Excel）
    if (isHeader && S._ctxCol >= 0 && !S.colSel.has(S._ctxCol)) {
        S.colSel.clear();
        S.colSel.add(S._ctxCol);
        S._colSelAnchor = S._ctxCol;
        updateColSelClasses();
    }
    var items = [];
    if (isHeader) {
        items.push({ label: '在左侧插入列', action: function () { insertCol(S._ctxCol); } });
        items.push({ label: '在右侧插入列', action: function () { insertCol(S._ctxCol + 1); } });
        // 受保护列（如 testcase_id / testCaseNo / path / name 等业务必备列）：
        // 直接不渲染「删除该列 / 重命名列」两项，避免误操作破坏结构
        if (S._ctxCol >= 0 && !isProtectedCol(S._ctxCol)) {
            items.push({ divider: true });
            items.push({ label: '删除该列', action: function () { deleteCol(S._ctxCol); }, disabled: isFrozenCol(S._ctxCol) });
            items.push({ label: '重命名列', action: function () { renameCol(S._ctxCol); }, disabled: isFrozenCol(S._ctxCol) });
        }
        if (S.colSel.size > 0) {
            // 冻结列（testcase_id）与 detail 列（steps 等）不参与清空 / 批量填充：
            // 只统计可操作列数；全为不可操作列时灰显。
            var _opCntH = 0;
            S.colSel.forEach(function (ci) {
                if (isFrozenCol(ci)) return;
                if ((typeof isDetailColumn === 'function') && isDetailColumn(ci)) return;
                _opCntH++;
            });
            items.push({ divider: true });
            items.push({ label: '清空选中列 (' + _opCntH + ')', action: clearSelectedCols, disabled: _opCntH === 0 });
            items.push({ label: '批量填充选中列 (' + _opCntH + ')…', action: fillSelectedCols, disabled: _opCntH === 0 });
        }
    } else {
        // 右键单元格：若存在矩形选区且右键格不在选区内，则把选区收缩到该单元格（Excel 习惯）
        if (typeof getCellSelRect === 'function') {
            var _rc = getCellSelRect();
            var _inSel = _rc && S._ctxRow >= _rc.r1 && S._ctxRow <= _rc.r2 && S._ctxCol >= _rc.c1 && S._ctxCol <= _rc.c2;
            if (_rc && !_inSel) {
                S.cellSel = { anchor: { r: S._ctxRow, c: S._ctxCol }, focus: { r: S._ctxRow, c: S._ctxCol } };
                if (typeof updateCellSelClasses === 'function') updateCellSelClasses();
                if (typeof updateSelectionInfo === 'function') updateSelectionInfo();
            }
        }
        var _rc2 = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
        var _hasArea = _rc2 && (_rc2.r1 !== _rc2.r2 || _rc2.c1 !== _rc2.c2);
        // 过滤模式（搜索/列筛选/仅看失败）下行号在原始空间是跳号的，行数需用 _viewRows ∩ [r1,r2] 计算，
        // 否则会把被隐藏的行也算进去，与实际复制/清空的行数不一致。
        var _areaSize = '';
        if (_hasArea) {
            var _areaRows;
            var _vrCtx = S._viewRows;
            var _allLenCtx = ((S.data && S.data.rows) || []).length;
            if (_vrCtx && _vrCtx.length && _vrCtx.length < _allLenCtx) {
                var _cntCtx = 0;
                for (var _ix = 0; _ix < _vrCtx.length; _ix++) {
                    var _rix = _vrCtx[_ix];
                    if (_rix >= _rc2.r1 && _rix <= _rc2.r2) _cntCtx++;
                }
                _areaRows = _cntCtx;
            } else {
                _areaRows = _rc2.r2 - _rc2.r1 + 1;
            }
            _areaSize = _areaRows + '\u00d7' + (_rc2.c2 - _rc2.c1 + 1);
        }
        // 推送：选中行 > 0 时优先推送选中行（含单元格矩形选区涵盖的行），否则推送当前右键所在行
        var _selRowCnt = (typeof getPushTargetRows === 'function') ? getPushTargetRows().length : S.sel.size;
        var pushCount = _selRowCnt > 0 ? _selRowCnt : (S._ctxRow >= 0 ? 1 : 0);
        var pushLabel = pushCount > 0
            ? '推送测试案例 (' + pushCount + ')'
            : '推送测试案例';
        items.push({ label: pushLabel, action: pushFromContextMenu, disabled: pushCount === 0 });
        items.push({ divider: true });
        items.push({
            label: _hasArea ? ('复制选区 (' + _areaSize + ')') : '复制单元格',
            action: copyCell, disabled: S._ctxRow < 0 || S._ctxCol < 0
        });
        items.push({ label: '粘贴单元格', action: pasteCell, disabled: S.clip === null || S.clip === undefined || S._ctxRow < 0 });
        items.push({
            label: _hasArea ? ('清空选区 (' + _areaSize + ')') : '清空单元格',
            action: clearCell, disabled: S._ctxCol < 0
        });
        // 单元格矩形选区：批量填充功能（跳过冻结列，全为冻结列时灰显）
        if (_hasArea) {
            var _fillOpCnt = 0;
            for (var _fc = _rc2.c1; _fc <= _rc2.c2; _fc++) { if (!isFrozenCol(_fc)) _fillOpCnt++; }
            items.push({
                label: '批量填充选区 (' + _areaSize + ')…',
                action: fillSelectedCells,
                disabled: _fillOpCnt === 0
            });
        }
        items.push({ divider: true });
        items.push({ label: '在下方复制此行', action: copyRowInline, disabled: S._ctxRow < 0 });
        var _selRows = (typeof getPushTargetRows === 'function') ? getPushTargetRows() : [];
        if (_selRows.length > 1) {
            items.push({ label: '复制选中行 (' + _selRows.length + ')', action: copySelectedRows });
        }
        // 插入 N 行：菜单项内嵌数字输入框，默认 1
        items.push({
            insertNRows: 'above',
            label: '在上方插入',
            action: function (n) { insertRow(S._ctxRow, n); },
            disabled: S._ctxRow < 0
        });
        items.push({
            insertNRows: 'below',
            label: '在下方插入',
            action: function (n) { insertRow(S._ctxRow + 1, n); },
            disabled: S._ctxRow < 0
        });
        // 标记 / 取消标记
        var _markRects = collectMarkRects();
        if (_markRects.length > 0) {
            var _markedCount = countMarkedInRects(_markRects);
            items.push({ divider: true });
            items.push({ label: '标记 (' + _markRects.length + ')', action: markSelected });
            if (_markedCount > 0) {
                items.push({ label: '取消标记 (' + _markedCount + ')', action: unmarkSelected });
            }
        }
        items.push({ divider: true });
        items.push({ label: '插入列（左侧）', action: function () { insertCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
        items.push({ label: '插入列（右侧）', action: function () { insertCol(S._ctxCol + 1); }, disabled: S._ctxCol < 0 });
        // 受保护列：不渲染「重命名列 / 删除该列」，与表头右键菜单保持一致
        if (S._ctxCol >= 0 && !isProtectedCol(S._ctxCol)) {
            items.push({ label: '重命名列', action: function () { renameCol(S._ctxCol); }, disabled: isFrozenCol(S._ctxCol) });
            items.push({ label: '删除该列', action: function () { deleteCol(S._ctxCol); }, disabled: isFrozenCol(S._ctxCol) });
        }
        items.push({ divider: true });
        items.push({ label: '删除该行', action: function () { deleteRow(S._ctxRow); }, disabled: S._ctxRow < 0 });
        if (S.sel.size > 0) {
            items.push({ label: '删除选中行 (' + S.sel.size + ')', action: deleteSelectedRows });
        }
        if (S.colSel.size > 0) {
            // 冻结列（testcase_id）与 detail 列（steps 等）不参与清空 / 批量填充：
            // 只统计可操作列数；全为不可操作列时灰显。
            var _opCntC = 0;
            S.colSel.forEach(function (ci) {
                if (isFrozenCol(ci)) return;
                if ((typeof isDetailColumn === 'function') && isDetailColumn(ci)) return;
                _opCntC++;
            });
            items.push({ divider: true });
            items.push({ label: '清空选中列 (' + _opCntC + ')', action: clearSelectedCols, disabled: _opCntC === 0 });
            items.push({ label: '批量填充选中列 (' + _opCntC + ')…', action: fillSelectedCols, disabled: _opCntC === 0 });
        }
    }

    var menu = document.getElementById('ctxMenu');
    if (!menu) return;
    var html = '';
    items.forEach(function (it) {
        if (it.divider) { html += '<div class="xs-div"></div>'; return; }
        if (it.insertNRows) {
            // 带内嵌数字输入框的菜单项：label + input + "行"
            html += '<div class="xs-mi xs-mi-with-input' + (it.disabled ? ' disabled' : '') + '" data-key="' + escapeHtml(it.label) + '">' +
                '<span class="xs-mi-lbl">' + escapeHtml(it.label) + '</span>' +
                '<input class="xs-mi-num" type="number" min="1" max="999" value="1" />' +
                '<span class="xs-mi-suffix">行</span>' +
                '</div>';
            return;
        }
        html += '<div class="xs-mi' + (it.disabled ? ' disabled' : '') + '" data-key="' + escapeHtml(it.label) + '">' + escapeHtml(it.label) + '</div>';
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
        var item = items[realIdx];
        // 带 input 的菜单项：阻断 input 的点击 / 鼠标事件冒泡，避免触发菜单关闭；
        // 支持回车触发；点击行其余区域按当前输入值执行。
        if (item && item.insertNRows) {
            var input = mi.querySelector('.xs-mi-num');
            if (input) {
                ['mousedown', 'click', 'dblclick', 'contextmenu'].forEach(function (ev) {
                    input.addEventListener(ev, function (e2) { e2.stopPropagation(); });
                });
                input.addEventListener('keydown', function (e2) {
                    e2.stopPropagation();
                    if (e2.key === 'Enter') {
                        if (item.disabled) return;
                        var n = parseInt(input.value, 10);
                        if (!isFinite(n) || n < 1) n = 1;
                        hideContextMenu();
                        try { item.action(n); } catch (err) { console.error(err); }
                    } else if (e2.key === 'Escape') {
                        hideContextMenu();
                    }
                });
                // 打开菜单时选中输入框内容，方便直接输入替换
                input.addEventListener('focus', function () { try { input.select(); } catch (_) {} });
            }
        }
        mi.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (!item || item.disabled) return;
            if (item.insertNRows) {
                var inp = mi.querySelector('.xs-mi-num');
                var n = inp ? parseInt(inp.value, 10) : 1;
                if (!isFinite(n) || n < 1) n = 1;
                hideContextMenu();
                try { item.action(n); } catch (err) { console.error(err); }
                return;
            }
            hideContextMenu();
            try { item.action(); } catch (err) { console.error(err); }
        });
    });
}

function hideContextMenu() {
    var menu = document.getElementById('ctxMenu');
    if (menu) menu.style.display = 'none';
}

