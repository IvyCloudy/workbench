/* =============================================================================
 * 03a-cell-edit.js  —— 单元格编辑 / 右键菜单 / 行列数据操作
 * -----------------------------------------------------------------------------
 * 由原 03-cell-ops.js 拆分而来，集中处理用户对表格内容的所有交互式编辑动作：
 *   1. 单元格编辑：selectCell / onCellDblClick / startEdit
 *      （进入编辑、提交修改、Esc 取消、testcase_id 等冻结列禁止编辑、批量写入选区）
 *   2. 右键菜单：showContextMenu / hideContextMenu
 *      （根据点击位置动态构造菜单项：插入 / 删除 / 复制 / 粘贴 / 清空 / 推送 等）
 *   3. 行/列数据操作：insertRow / deleteRow / deleteSelectedRows /
 *      insertCol / deleteCol / renameCol / copyCell / pasteCell / clearCell /
 *      copyRow / copyRowInline / pushFromContextMenu
 *
 * 列宽 / 列选 / 行高 等"尺寸/选区"相关函数见 03b-resize-colsel.js。
 * 所有写操作前都会调用 pushHistory() 以支持撤销，并在结束时 saveFile() + renderTable()。
 * 跨文件依赖通过全局作用域共享（如 isFrozenCol、updateColSelClasses 来自 03b）。
 * ========================================================================== */


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
    // testcase_id 列冻结：不允许双击进入编辑
    if (isFrozenCol(ci)) {
        e.preventDefault();
        showToast('testcase_id 列为系统列，不允许编辑', 'error');
        return;
    }
    // 明细列：双击也打开弹窗，不进入编辑
    if (hasDetailRowsAtCol(ri, ci)) {
        e.preventDefault();
        e.stopPropagation();
        var headers = (S.data && S.data.headers) || [];
        var field = headers[ci] !== undefined ? headers[ci] : '';
        openDetailModal(ri, field);
        return;
    }
    // 标量数组列：双击 → 多项编辑弹窗，不走 textarea 原地编辑
    if (typeof isArrayCol === 'function' && isArrayCol(ci) && typeof openArrayCellEditor === 'function') {
        e.preventDefault();
        e.stopPropagation();
        openArrayCellEditor(ri, ci);
        return;
    }
    startEdit(e);
}

// 基于列宽 + Canvas 精确计算文本 wrapped 行数
function _calcTextLines(text, td, ci) {
    if (!text) return 1;
    // 按 \n 先拆成段落，每个段落再根据列宽算 wrap 行数
    var paragraphs = text.split('\n');
    // 取列宽：优先自定义列宽，否则用 td 实际宽度（减去 textarea 左右 padding 6*2）
    var colW = (S.colWidths && S.colWidths[ci] && S.colWidths[ci] > 0) ? (S.colWidths[ci] - 12) : (td ? td.offsetWidth - 12 : 200);
    if (colW < 40) colW = 40;
    // 获取字体信息
    var font = td ? getComputedStyle(td).font : '13px sans-serif';
    var totalLines = 0;
    // 用离屏 Canvas 测量文本宽度
    var ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = font;
    for (var p = 0; p < paragraphs.length; p++) {
        var para = paragraphs[p];
        totalLines += _countWrapLines(para, colW, ctx);
    }
    return Math.max(1, Math.min(totalLines, 25));
}

// 对单段文本按给定 pixel 宽度计算折行数
function _countWrapLines(text, maxWidth, ctx) {
    if (!text) return 1;
    if (!ctx) {
        // 无 Canvas 环境时降级：按 40 字符/行
        return Math.max(1, Math.ceil(text.length / 40));
    }
    var lines = 0;
    var start = 0;
    var len = text.length;
    while (start < len) {
        // 二分找当前行能容纳的最长字符数
        var lo = start + 1;
        var hi = len;
        var best = start;
        while (lo <= hi) {
            var mid = Math.floor((lo + hi) / 2);
            var w = ctx.measureText(text.substring(start, mid + 1)).width;
            if (w <= maxWidth) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        start = best + 1;
        lines++;
        // 安全上限
        if (lines > 500) break;
    }
    return Math.max(1, lines);
}

function startEdit(e) {
    if (S.editing) return;
    var td = e.currentTarget;
    var ri = parseInt(td.getAttribute('data-row'), 10);
    var ci = parseInt(td.getAttribute('data-col'), 10);
    // testcase_id 列冻结：不允许进入编辑
    if (isFrozenCol(ci)) {
        showToast('testcase_id 列为系统列，不允许编辑', 'error');
        return;
    }
    // 防御：行/列下标不合法时直接放弃编辑（如表格已被刷新/删除行列）
    if (isNaN(ri) || isNaN(ci) || !S.data || !Array.isArray(S.data.rows) || !S.data.rows[ri]) {
        return;
    }
    var oldVal = (S.data.rows[ri] && S.data.rows[ri][ci] !== undefined) ? S.data.rows[ri][ci] : '';
    // 用 textarea 取代 input，使行高被拖大时单元格内容也能换行编辑
    var input = document.createElement('textarea');
    input.className = 'xs-cell-input';
    // 文本中的字面量 \n 在 textarea 中转为实际换行，方便多行编辑
    var valStr = (oldVal == null ? '' : String(oldVal)).replace(/\\n/g, '\n');
    input.value = valStr;
    // 基于列宽精确计算所需行数（替代固定字符数估算）
    var lineCount = _calcTextLines(valStr, td, ci);
    input.rows = Math.max(1, Math.min(lineCount, 25));
    // 行高被拖大或内容本身多行时，启用多行编辑模式（Enter 换行，Ctrl/Cmd+Enter 提交）
    var tr = td.parentElement;
    var multiline = !!(tr && tr.classList && tr.classList.contains('xs-tr-resized')) || lineCount > 1;
    if (multiline) {
        input.classList.add('xs-cell-input-multi');
        input.style.height = 'auto';
        // 设置 min-height 保证编辑区不小于内容行数
        input.style.minHeight = (lineCount * 18 + 12) + 'px';
    }
    td.innerHTML = '';
    td.classList.add('xs-editing');
    td.appendChild(input);
    input.focus();
    input.select();
    S.editing = true;

    // 批量输入：进入编辑时若存在矩形选区且当前 active cell 处于选区内部，
    // 记下选区快照；commit 时若值有变化，把同一值写入整个选区（跳过冻结列）。
    var bulkRect = null;
    try {
        var _rcEdit = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
        if (_rcEdit && (_rcEdit.r1 !== _rcEdit.r2 || _rcEdit.c1 !== _rcEdit.c2)
            && ri >= _rcEdit.r1 && ri <= _rcEdit.r2 && ci >= _rcEdit.c1 && ci <= _rcEdit.c2) {
            bulkRect = _rcEdit;
        }
    } catch (_e) { }

    function commit(save) {
        if (!S.editing) return;
        S.editing = false;
        // 二次防御：commit 时单元格可能因外部操作（删除行/列、重渲染）已失效
        var row = (S.data && Array.isArray(S.data.rows)) ? S.data.rows[ri] : undefined;
        if (!row || isNaN(ri) || isNaN(ci)) {
            return;
        }
        if (save) {
            var newVal = input.value.replace(/\n/g, '\\n');
            if (newVal !== oldVal) {
                pushHistory();
                if (bulkRect) {
                    // 批量写入选区所有单元格
                    // 过滤模式下（仅看失败/列筛选）只对可见行写入，避免把值刷到被隐藏的成功行
                    var rows = S.data.rows;
                    var bulkRows = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
                    if (!bulkRows || bulkRows.length === 0) {
                        bulkRows = [];
                        for (var _bri = bulkRect.r1; _bri <= bulkRect.r2; _bri++) bulkRows.push(_bri);
                    }
                    var changed = 0, skippedTsId = false;
                    for (var _bi = 0; _bi < bulkRows.length; _bi++) {
                        var rr = bulkRows[_bi];
                        var rowR = rows[rr]; if (!rowR) continue;
                        for (var cc = bulkRect.c1; cc <= bulkRect.c2; cc++) {
                            if (isFrozenCol(cc)) { skippedTsId = true; continue; }
                            var isArrTarget = typeof isArrayCol === 'function' && isArrayCol(cc);
                            var nv;
                            if (isArrTarget) {
                                nv = (newVal === '') ? [] : newVal.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                            } else {
                                nv = newVal;
                            }
                            var ov = rowR[cc];
                            var oldStr = Array.isArray(ov) ? formatCellValue(ov) : (ov == null ? '' : String(ov));
                            var newStr = Array.isArray(nv) ? formatCellValue(nv) : String(nv);
                            if (oldStr !== newStr) {
                                rowR[cc] = nv;
                                S.mods.add(rr + ',' + cc);
                                changed++;
                            }
                        }
                    }
                    saveFile();
                    // 批量写入后整体重绘以保证所有单元格视图同步
                    td.classList.remove('xs-editing');
                    renderTable();
                    var msg = '已批量填充 ' + changed + ' 个单元格';
                    if (skippedTsId) msg += '（testcase_id 列已跳过）';
                    if (typeof showToast === 'function') showToast(msg, 'success');
                    return;
                }
                row[ci] = newVal;
                S.mods.add(ri + ',' + ci);
                saveFile();
            }
        }
        td.classList.remove('xs-editing');
        patchCell(ri, ci);
    }
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
            // Alt+Enter / Option+Enter：插入换行符（同 Excel 换行操作）
            if (ev.altKey) {
                ev.preventDefault();
                var start = input.selectionStart;
                var end = input.selectionEnd;
                input.value = input.value.slice(0, start) + '\n' + input.value.slice(end);
                input.selectionStart = input.selectionEnd = start + 1;
                return;
            }
            // 多行模式：Ctrl/Cmd+Enter 提交，Enter 换行（保持 textarea 默认行为）
            // 单行模式：Enter 提交（保持原有交互）
            if (multiline) {
                if (ev.ctrlKey || ev.metaKey) {
                    ev.preventDefault();
                    commit(true);
                }
                // 否则不拦截，允许换行
            } else {
                ev.preventDefault();
                commit(true);
            }
        } else if (ev.key === 'Escape') { commit(false); }
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
            // 冻结列（testcase_id）不参与清空 / 批量填充：只统计可操作列数；全为冻结列时灰显
            var _opCntH = 0;
            S.colSel.forEach(function (ci) { if (!isFrozenCol(ci)) _opCntH++; });
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
        items.push({ label: '在上方插入行', action: function () { insertRow(S._ctxRow); }, disabled: S._ctxRow < 0 });
        items.push({ label: '在下方插入行', action: function () { insertRow(S._ctxRow + 1); }, disabled: S._ctxRow < 0 });
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
            // 冻结列（testcase_id）不参与清空 / 批量填充：只统计可操作列数；全为冻结列时灰显
            var _opCntC = 0;
            S.colSel.forEach(function (ci) { if (!isFrozenCol(ci)) _opCntC++; });
            items.push({ divider: true });
            items.push({ label: '清空选中列 (' + _opCntC + ')', action: clearSelectedCols, disabled: _opCntC === 0 });
            items.push({ label: '批量填充选中列 (' + _opCntC + ')…', action: fillSelectedCols, disabled: _opCntC === 0 });
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
// 推断某个明细表的"列级主流类型"：扫描 rawRowTypes 找首个非 'none' 的类型；
// 全为 'none' 时按列在原始数据中的形态兜底（默认 'array'，与对象数组列最常见）
function _inferDetailColKind(dt) {
    if (!dt) return 'array';
    var types = dt.rawRowTypes || [];
    for (var i = 0; i < types.length; i++) {
        if (types[i] === 'array' || types[i] === 'object') return types[i];
    }
    return 'array';
}

// 从明细表读取某行某列的"真实原始数据"（对象 / 对象数组）。
// 主表 S.data.rows[ri][ci] 上仅保存显示文本（'[N 项]' / '{N 字段}'），真实结构在 rawRowGroups。
// - 列的 rawRowTypes[ri] === 'object'：返回单个对象（或 null）
// - 列的 rawRowTypes[ri] === 'array' ：返回对象数组（可能为空数组）
// - 非 detail 列或没有数据：返回 undefined
function _readDetailCellRaw(ri, ci) {
    var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
    if (!dt) return undefined;
    var raws = (dt.rawRowGroups && dt.rawRowGroups[ri]) || [];
    var kind = (dt.rawRowTypes && dt.rawRowTypes[ri])
        || _inferDetailColKind(dt);
    if (kind === 'object') {
        return (raws.length > 0 && raws[0] && typeof raws[0] === 'object') ? raws[0] : null;
    }
    // 默认按数组返回
    return raws.slice();
}

// 把"真实原始数据"（对象 / 对象数组）写入明细表，并同步主表显示文本。
// 用于：粘贴单元格、Ctrl+V 落到 detail 列时，保持与"明细弹窗保存"一致的写入路径。
// 调用方在调用前应已 pushHistory()。
function _writeDetailCellFromRaw(ri, ci, raw) {
    var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
    if (!dt) return false;
    var headers = dt.headers || [];
    // 规范化为 rawRows 数组（对象数组）+ 类型
    var rawRows = [];
    var kind;
    if (Array.isArray(raw)) {
        kind = 'array';
        for (var i = 0; i < raw.length; i++) {
            var item = raw[i];
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                rawRows.push(JSON.parse(JSON.stringify(item)));
            }
        }
    } else if (raw && typeof raw === 'object') {
        // 单对象：按列已有类型决定包装方式
        kind = (dt.rawRowTypes && dt.rawRowTypes[ri]) || _inferDetailColKind(dt);
        rawRows = [JSON.parse(JSON.stringify(raw))];
    } else {
        // null / undefined / 标量：清空
        kind = (dt.rawRowTypes && dt.rawRowTypes[ri]) || _inferDetailColKind(dt);
        rawRows = [];
    }

    // 1) 写 rawRowGroups
    if (!dt.rawRowGroups) dt.rawRowGroups = [];
    while (dt.rawRowGroups.length <= ri) dt.rawRowGroups.push([]);
    dt.rawRowGroups[ri] = rawRows;

    // 2) 同步 rowGroups（字符串二维结构，主表显示路径兼容）
    if (!dt.rowGroups) dt.rowGroups = [];
    while (dt.rowGroups.length <= ri) dt.rowGroups.push([]);
    dt.rowGroups[ri] = rawRows.map(function (rawObj) {
        return headers.map(function (h) {
            var v = rawObj ? rawObj[h] : undefined;
            if (v == null) return '';
            if (Array.isArray(v)) {
                if (v.length === 0) return '[]';
                if (typeof v[0] === 'object' && v[0] !== null) {
                    try { return JSON.stringify(v); } catch (_) { return '[' + v.length + ' 项]'; }
                }
                return v.map(function (x) { return String(x == null ? '' : x); }).join('; ');
            }
            if (typeof v === 'object') {
                try { return JSON.stringify(v); } catch (_) { return '{' + Object.keys(v).length + ' 字段}'; }
            }
            return String(v);
        });
    });

    // 3) 同步 rawRowTypes
    if (!dt.rawRowTypes) dt.rawRowTypes = [];
    while (dt.rawRowTypes.length <= ri) dt.rawRowTypes.push('none');
    dt.rawRowTypes[ri] = kind;

    // 4) 写主表显示文本（与 detail 弹窗保存逻辑保持一致）
    var displayText;
    if (rawRows.length === 0) {
        displayText = (kind === 'object') ? '{}' : '[]';
    } else if (kind === 'object') {
        var firstRow = rawRows[0] || {};
        var fieldCount = 0;
        Object.keys(firstRow).forEach(function (k) {
            var vv = firstRow[k];
            if (vv !== '' && vv !== null && vv !== undefined) fieldCount++;
        });
        if (fieldCount === 0) fieldCount = headers.length;
        displayText = '{' + fieldCount + ' 字段}';
    } else {
        displayText = '[' + rawRows.length + ' 项]';
    }
    if (S.data && Array.isArray(S.data.rows) && S.data.rows[ri]) {
        S.data.rows[ri][ci] = displayText;
    }
    if (S.mods) S.mods.add(ri + ',' + ci);
    if (S._detailModCellKeys) S._detailModCellKeys.add(ri + ',' + ci);
    return true;
}

// 判断当前文件是否已经被推送过：只要任意一行 testCaseNo 列非空，即视为已推送过。
// 关闭文件再打开时，扩展端 diffPushSnapshot 也是基于推送快照来判定新增/删除高亮的，
// 这里保持同一标准：从未推送的文件，新增行不上绿色高亮、被删除行不显示 ghost，
// 与重开后无高亮/无 ghost 的行为保持一致。
function _filePushedBefore() {
    var headers = (S.data && S.data.headers) || [];
    var tcIdx = headers.indexOf('testCaseNo');
    if (tcIdx < 0) return false;
    var rows = (S.data && S.data.rows) || [];
    for (var i = 0; i < rows.length; i++) {
        var v = rows[i] && rows[i][tcIdx];
        if (v != null && String(v) !== '') return true;
    }
    return false;
}

function insertRow(at) {
    var headers = S.data.headers || [];
    var width = headers.length;
    var newRow = new Array(width).fill('');
    // 标量数组列的默认值为空数组；明细列（对象/对象数组）的默认值为 '[]' 或 '{}'，
    // 让新行该列立刻显示为可点击编辑链接（与下方 rawRowTypes 同步标注，避免刷新后被错位回退到相邻行的原始数据）
    var idts = getDetailTables();
    var detailKindByCol = {};
    headers.forEach(function (_, ci) {
        if (typeof isArrayCol === 'function' && isArrayCol(ci)) {
            newRow[ci] = [];
            return;
        }
        var dtCol = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
        if (dtCol) {
            var kind = _inferDetailColKind(dtCol);
            detailKindByCol[ci] = kind;
            newRow[ci] = (kind === 'object') ? '{}' : '[]';
        }
    });
    // 新行自动生成 testcase_id；testCaseNo 保留为空（由推送响应回写）
    var tsCol = headers.indexOf('testcase_id');
    if (tsCol >= 0) newRow[tsCol] = genUuidV4();
    if (at < 0) at = 0;
    if (at > S.data.rows.length) at = S.data.rows.length;
    pushHistory();
    S.data.rows.splice(at, 0, newRow);
    // 同步所有明细表：在插入位置插入空条目，确保 rowGroups/rawRowGroups/rawRowTypes
    // 与主表 rows 长度一致，避免后续 buildRowDetailSignature 按行索引误读其他行的明细数据
    // 关键：rawRowTypes 写入推断出的列级类型（'array'/'object'）而非 'none'，
    //   - 让保存路径识别为"空对象/空数组"而不是回退到 originalData[rowIdx]（避免相邻行数据被错复制）
    //   - 让弹窗按对应类型展示（嵌套对象 / 步骤列表）
    idts.forEach(function (dt) {
        if (!dt) return;
        if (dt.rowGroups) dt.rowGroups.splice(at, 0, []);
        if (dt.rawRowGroups) dt.rawRowGroups.splice(at, 0, []);
        if (dt.rawRowTypes) {
            // 找到该明细表对应的主表列下标，复用上面已推断的 kind
            var headersArr = S.data.headers || [];
            var colIdx = headersArr.indexOf(dt.field);
            var kind = (colIdx >= 0 && detailKindByCol[colIdx])
                ? detailKindByCol[colIdx] : _inferDetailColKind(dt);
            dt.rawRowTypes.splice(at, 0, kind);
        }
    });
    if (!S._addedRowSet) S._addedRowSet = new Set();
    // 插入位置之后已有的新增行索引整体+1
    if (S._addedRowSet.size > 0) {
        var toShift = [];
        S._addedRowSet.forEach(function (ri) { if (ri >= at) toShift.push(ri); });
        toShift.forEach(function (ri) { S._addedRowSet.delete(ri); S._addedRowSet.add(ri + 1); });
    }
    // 仅当文件已被推送过时才标绿（与关闭重开后扩展端 diff 行为一致）：
    // 未推送的文件没有快照基线，重开后所有行都会被视为初始数据 → 不应有“新增”概念。
    if (_filePushedBefore()) {
        S._addedRowSet.add(at);
    }
    // 更新选中集合（被插入位置之后的索引整体+1）
    var ns = new Set();
    S.sel.forEach(function (i) { ns.add(i >= at ? i + 1 : i); });
    S.sel = ns;
    // 同步调整行高索引：插入位置及之后的行都 +1（避免原本第N行的自定义高度被“错位”给新插入的行）
    if (S.rowHeights && Object.keys(S.rowHeights).length > 0) {
        var nrh = {};
        for (var rk in S.rowHeights) {
            if (!S.rowHeights.hasOwnProperty(rk)) continue;
            var ri = parseInt(rk, 10);
            if (isNaN(ri)) continue;
            nrh[ri >= at ? ri + 1 : ri] = S.rowHeights[rk];
        }
        S.rowHeights = nrh;
    }
    // 同步调整"完全展开"行集合：与 rowHeights 保持一致，避免插入后出现
    // "行高完整但内容仍被 clamp 截断"的错位现象。
    if (S._rowExpanded && S._rowExpanded.size > 0) {
        var nre = new Set();
        S._rowExpanded.forEach(function (i) { nre.add(i >= at ? i + 1 : i); });
        S._rowExpanded = nre;
    }
    // 行结构变化 → 清除单元格矩形选区，避免索引错位
    S.cellSel = null;
    saveFile();
    renderTable();
}

function deleteRow(ri) {
    if (ri < 0 || ri >= S.data.rows.length) return;
    pushHistory();
    // 立即记录删除行信息，实现实时 ghost 行展示（不等扩展端异步回包）
    // 判定条件：仅当该行 testCaseNo 列非空（即已成功推送过）才记录 ghost；
    // 未推送过的行删除后直接物理删除，与扩展端 diff 行为一致（避免重开后 ghost 消失的不一致体验）。
    var headers = (S.data && S.data.headers) || [];
    var tsIdIdx = headers.indexOf('testcase_id');
    var tcIdx = headers.indexOf('testCaseNo');
    var rowToDelete = S.data.rows[ri];
    if (tsIdIdx >= 0 && tcIdx >= 0) {
        var tsId = rowToDelete[tsIdIdx] != null ? String(rowToDelete[tsIdIdx]) : '';
        var tcNo = rowToDelete[tcIdx] != null ? String(rowToDelete[tcIdx]) : '';
        if (tsId && tcNo) {
            var delCells = [];
            for (var hi = 0; hi < headers.length; hi++) {
                var v = hi < rowToDelete.length ? rowToDelete[hi] : undefined;
                delCells.push(v == null ? '' : String(v));
            }
            S._deletedInfos = (S._deletedInfos || []).concat([{ tsId: tsId, cells: delCells }]);
        }
    }
    S.data.rows.splice(ri, 1);
    // 同步所有明细表：删除被删行对应的条目，确保 rowGroups/rawRowGroups/rawRowTypes
    // 与主表 rows 长度一致，避免后续 buildRowDetailSignature 按行索引误读其他行的明细数据
    var ddts = getDetailTables();
    ddts.forEach(function (dt) {
        if (!dt) return;
        if (dt.rowGroups) dt.rowGroups.splice(ri, 1);
        if (dt.rawRowGroups) dt.rawRowGroups.splice(ri, 1);
        if (dt.rawRowTypes) dt.rawRowTypes.splice(ri, 1);
    });
    // 同步新增行集合：被删行移除，后续行 -1
    if (S._addedRowSet && S._addedRowSet.size > 0) {
        S._addedRowSet.delete(ri);
        var toShiftBack = [];
        S._addedRowSet.forEach(function (i) { if (i > ri) toShiftBack.push(i); });
        toShiftBack.forEach(function (i) { S._addedRowSet.delete(i); S._addedRowSet.add(i - 1); });
    }
    var ns = new Set();
    S.sel.forEach(function (i) { if (i !== ri) ns.add(i > ri ? i - 1 : i); });
    S.sel = ns;
    // 同步行高索引：被删行丢弃，后续行 -1
    if (S.rowHeights && Object.keys(S.rowHeights).length > 0) {
        var nrh = {};
        for (var rk in S.rowHeights) {
            if (!S.rowHeights.hasOwnProperty(rk)) continue;
            var i = parseInt(rk, 10);
            if (isNaN(i)) continue;
            if (i === ri) continue;
            nrh[i > ri ? i - 1 : i] = S.rowHeights[rk];
        }
        S.rowHeights = nrh;
    }
    // 同步“完全展开”行集合：与 rowHeights 保持一致
    if (S._rowExpanded && S._rowExpanded.size > 0) {
        var nre = new Set();
        S._rowExpanded.forEach(function (i) {
            if (i === ri) return;
            nre.add(i > ri ? i - 1 : i);
        });
        S._rowExpanded = nre;
    }
    S.cellSel = null;
    saveFile();
    renderTable();
}

function deleteSelectedRows() {
    if (S.sel.size === 0) return;
    pushHistory();
    var sorted = Array.from(S.sel).sort(function (a, b) { return b - a; });
    // 立即记录所有被删除行的信息，实现实时 ghost 行展示
    // 判定条件：仅当该行 testCaseNo 列非空（即已成功推送过）才记录 ghost；
    // 未推送过的行删除后直接物理删除，与扩展端 diff 行为一致（避免重开后 ghost 消失的不一致体验）。
    var headers = (S.data && S.data.headers) || [];
    var tsIdIdx = headers.indexOf('testcase_id');
    var tcIdx = headers.indexOf('testCaseNo');
    if (tsIdIdx >= 0 && tcIdx >= 0) {
        for (var di = 0; di < sorted.length; di++) {
            var rowToDelete = S.data.rows[sorted[di]];
            var tsId = rowToDelete[tsIdIdx] != null ? String(rowToDelete[tsIdIdx]) : '';
            var tcNo = rowToDelete[tcIdx] != null ? String(rowToDelete[tcIdx]) : '';
            if (tsId && tcNo) {
                var delCells = [];
                for (var hi = 0; hi < headers.length; hi++) {
                    var v = hi < rowToDelete.length ? rowToDelete[hi] : undefined;
                    delCells.push(v == null ? '' : String(v));
                }
                S._deletedInfos = (S._deletedInfos || []).concat([{ tsId: tsId, cells: delCells }]);
            }
        }
    }
    sorted.forEach(function (i) { S.data.rows.splice(i, 1); });
    // 同步所有明细表：删除被删行对应的条目（sorted 已按降序排列，逐个 splice 安全）
    var sdts = getDetailTables();
    sdts.forEach(function (dt) {
        if (!dt) return;
        sorted.forEach(function (i) {
            if (dt.rowGroups) dt.rowGroups.splice(i, 1);
            if (dt.rawRowGroups) dt.rawRowGroups.splice(i, 1);
            if (dt.rawRowTypes) dt.rawRowTypes.splice(i, 1);
        });
    });
    // 同步新增行集合：被删行移除，后续行按删除数量整体左移
    if (S._addedRowSet && S._addedRowSet.size > 0) {
        var newAdded = new Set();
        S._addedRowSet.forEach(function (ri) {
            if (sorted.indexOf(ri) >= 0) return; // 被删行，移除
            var shift = 0;
            for (var si = 0; si < sorted.length; si++) { if (sorted[si] < ri) shift++; }
            newAdded.add(ri - shift);
        });
        S._addedRowSet = newAdded;
    }
    // 同步行高索引：依次处理所有被删行（已按降序，逐个 -1 调整后续索引）
    if (S.rowHeights && Object.keys(S.rowHeights).length > 0) {
        var rhArr = Object.keys(S.rowHeights).map(function (k) { return { i: parseInt(k, 10), v: S.rowHeights[k] }; });
        sorted.forEach(function (delI) {
            rhArr = rhArr.filter(function (it) { return it.i !== delI; }).map(function (it) {
                return { i: it.i > delI ? it.i - 1 : it.i, v: it.v };
            });
        });
        var nrh2 = {};
        rhArr.forEach(function (it) { if (!isNaN(it.i)) nrh2[it.i] = it.v; });
        S.rowHeights = nrh2;
    }
    // 同步“完全展开”行集合：与 rowHeights 保持一致
    if (S._rowExpanded && S._rowExpanded.size > 0) {
        var reArr = Array.from(S._rowExpanded);
        sorted.forEach(function (delI) {
            reArr = reArr.filter(function (i) { return i !== delI; }).map(function (i) {
                return i > delI ? i - 1 : i;
            });
        });
        S._rowExpanded = new Set(reArr);
    }
    S.sel.clear();
    S.cellSel = null;
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
        // 同步调整筛选列索引：插入位置及之后的列都 +1
        var nf = {};
        for (var k in S._colFilters) {
            if (!S._colFilters.hasOwnProperty(k)) continue;
            var ki = parseInt(k, 10);
            nf[(ki >= idx ? ki + 1 : ki)] = S._colFilters[k];
        }
        S._colFilters = nf;
        // 同步调整列选区索引：插入位置及之后的列都 +1
        var nsel = new Set();
        S.colSel.forEach(function (ki) { nsel.add(ki >= idx ? ki + 1 : ki); });
        S.colSel = nsel;
        if (S._colSelAnchor >= idx) S._colSelAnchor += 1;
        // 同步列宽索引：插入位置及之后的列都 +1，避免原本第N列的自定义宽度被错位给新列
        if (S.colWidths && Object.keys(S.colWidths).length > 0) {
            var ncw = {};
            for (var ck in S.colWidths) {
                if (!S.colWidths.hasOwnProperty(ck)) continue;
                var ci = parseInt(ck, 10);
                if (isNaN(ci)) continue;
                ncw[ci >= idx ? ci + 1 : ci] = S.colWidths[ck];
            }
            S.colWidths = ncw;
        }
        S.cellSel = null;
        saveFile();
        renderTable();
    });
}

function deleteCol(ci) {
    if (ci < 0 || ci >= S.data.headers.length) return;
    // 冻结列（testcase_id）禁止删除：testcase_id 是行的稳定标识，删除会破坏推送语义与失败标记联动
    if (isFrozenCol(ci)) {
        showToast('testcase_id 列为冻结列，不允许删除', 'error');
        return;
    }
    // 受保护列（业务必备列）禁止删除：兜底防御，正常右键菜单已不渲染此项
    if (isProtectedCol(ci)) {
        var _hName = (S.data && S.data.headers && S.data.headers[ci]) || '';
        showToast('「' + _hName + '」为受保护列，不允许删除', 'error');
        return;
    }
    xsConfirm('确定删除该列？', function () {
        pushHistory();
        S.data.headers.splice(ci, 1);
        S.data.rows.forEach(function (row) { row.splice(ci, 1); });
        // 同步调整筛选列索引：被删列丢弃，后续列 -1
        var nf = {};
        for (var k in S._colFilters) {
            if (!S._colFilters.hasOwnProperty(k)) continue;
            var ki = parseInt(k, 10);
            if (ki === ci) continue;
            nf[(ki > ci ? ki - 1 : ki)] = S._colFilters[k];
        }
        S._colFilters = nf;
        // 同步调整列选区索引：被删列丢弃，后续列 -1
        var nsel = new Set();
        S.colSel.forEach(function (ki) { if (ki !== ci) nsel.add(ki > ci ? ki - 1 : ki); });
        S.colSel = nsel;
        if (S._colSelAnchor === ci) S._colSelAnchor = -1;
        else if (S._colSelAnchor > ci) S._colSelAnchor -= 1;
        // 同步列宽索引：被删列丢弃，后续列 -1
        if (S.colWidths && Object.keys(S.colWidths).length > 0) {
            var ncw = {};
            for (var ck in S.colWidths) {
                if (!S.colWidths.hasOwnProperty(ck)) continue;
                var cci = parseInt(ck, 10);
                if (isNaN(cci)) continue;
                if (cci === ci) continue;
                ncw[cci > ci ? cci - 1 : cci] = S.colWidths[ck];
            }
            S.colWidths = ncw;
        }
        S.cellSel = null;
        saveFile();
        renderTable();
    });
}

function renameCol(ci) {
    if (ci < 0 || ci >= S.data.headers.length) return;
    // 冻结列（testcase_id）禁止重命名：很多依赖 headers.indexOf('testcase_id') 的逻辑（推送、失败映射、行高/列宽索引等）会失效
    if (isFrozenCol(ci)) {
        showToast('testcase_id 列为冻结列，不允许重命名', 'error');
        return;
    }
    // 受保护列（业务必备列）禁止重命名：兜底防御，正常右键菜单已不渲染此项
    if (isProtectedCol(ci)) {
        var _hName2 = (S.data && S.data.headers && S.data.headers[ci]) || '';
        showToast('「' + _hName2 + '」为受保护列，不允许重命名', 'error');
        return;
    }
    xsPrompt('重命名列', S.data.headers[ci], function (name) {
        if (name === null) return;
        // 重命名后的新名称如果与已有列重名，会破坏 headers.indexOf 唯一性，给出提示但仍允许（与原行为一致，仅冻结列收紧）
        pushHistory();
        S.data.headers[ci] = name;
        saveFile();
        renderTable();
    });
}

function copyCell() {
    // 矩形选区 > 1 格：将选区复制为二维数组（后续可多格粘贴）
    // 过滤模式下（仅看失败/列筛选）只复制实际可见行，避免把被隐藏的成功行内容带入剪贴板
    var rc = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
    if (rc && (rc.r1 !== rc.r2 || rc.c1 !== rc.c2)) {
        var rows = (S.data && S.data.rows) || [];
        var rowList = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
        if (!rowList || rowList.length === 0) {
            rowList = [];
            for (var rr = rc.r1; rr <= rc.r2; rr++) rowList.push(rr);
        }
        var grid = [];
        for (var i = 0; i < rowList.length; i++) {
            var r = rowList[i];
            var line = [];
            for (var c = rc.c1; c <= rc.c2; c++) {
                var v;
                // detail 列：从明细表读取真实的对象 / 对象数组，而非主表的显示文本（如 '[3 项]'）
                var _rawDt = (typeof _readDetailCellRaw === 'function') ? _readDetailCellRaw(r, c) : undefined;
                if (_rawDt !== undefined) {
                    v = _rawDt;
                } else {
                    v = (rows[r] && rows[r][c] !== undefined) ? rows[r][c] : '';
                }
                // 对象/对象数组需要深拷贝，避免后续粘贴/编辑共享引用污染源数据
                line.push((typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(v) : (Array.isArray(v) ? v.slice() : v));
            }
            grid.push(line);
        }
        S.clip = grid;
        showToast('已复制 ' + rowList.length + ' × ' + (rc.c2 - rc.c1 + 1) + ' 区域', 'success');
        return;
    }
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    // detail 列：优先从明细表读取真实的对象 / 对象数组
    var _rawDtSingle = (typeof _readDetailCellRaw === 'function') ? _readDetailCellRaw(S._ctxRow, S._ctxCol) : undefined;
    var v0;
    if (_rawDtSingle !== undefined) {
        v0 = _rawDtSingle;
    } else {
        v0 = (S.data.rows[S._ctxRow] && S.data.rows[S._ctxRow][S._ctxCol]);
        if (v0 === undefined) v0 = '';
    }
    // 单元格深拷贝（含对象 / 对象数组），避免后续粘贴或编辑导致引用共享污染源数据
    S.clip = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(v0) : (Array.isArray(v0) ? v0.slice() : v0);
    showToast('已复制', 'success');
}

function pasteCell() {
    if (S.clip === null || S.clip === undefined) return;
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    // 二维数组（来自矩形复制）：从右键 (ctxRow, ctxCol) 作为左上角铺贴
    if (Array.isArray(S.clip) && S.clip.length > 0 && Array.isArray(S.clip[0])) {
        var grid = S.clip;
        var rows = (S.data && S.data.rows) || [];
        var headers = (S.data && S.data.headers) || [];
        pushHistory();
        var changed = 0, skippedTsId = false;
        // 过滤模式（仅看失败/列筛选/搜索）下，被隐藏的行不接收粘贴；
        // 按 _viewRows 顺序找到 ctxRow 后的连续可见行作为目标行序列（与 Excel AutoFilter 行为一致）。
        var _allLenPC = rows.length;
        var _vrPC = S._viewRows;
        var _useFilterPC = !!(_vrPC && _vrPC.length && _vrPC.length < _allLenPC);
        var _targetRowsPC = [];
        if (_useFilterPC) {
            var _startIdxPC = -1;
            for (var _siPC = 0; _siPC < _vrPC.length; _siPC++) {
                if (_vrPC[_siPC] >= S._ctxRow) { _startIdxPC = _siPC; break; }
            }
            if (_startIdxPC >= 0) {
                for (var _tiPC = 0; _tiPC < grid.length && (_startIdxPC + _tiPC) < _vrPC.length; _tiPC++) {
                    _targetRowsPC.push(_vrPC[_startIdxPC + _tiPC]);
                }
            }
        } else {
            for (var _tiPC2 = 0; _tiPC2 < grid.length; _tiPC2++) {
                var _r0PC = S._ctxRow + _tiPC2;
                if (_r0PC >= _allLenPC) break;
                _targetRowsPC.push(_r0PC);
            }
        }
        for (var i = 0; i < _targetRowsPC.length; i++) {
            var rIdx = _targetRowsPC[i];
            var row = rows[rIdx];
            if (!row) continue;
            for (var j = 0; j < grid[i].length; j++) {
                var cIdx = S._ctxCol + j;
                if (cIdx >= headers.length) break;
                if (isFrozenCol(cIdx)) { skippedTsId = true; continue; }
                var src = grid[i][j];
                var isArrTarget = typeof isArrayCol === 'function' && isArrayCol(cIdx);
                // detail 列：若源是对象 / 对象数组，走写入 detail 表的路径，同步 rawRowGroups / rowGroups / rawRowTypes
                var _isDetailTarget = (typeof isDetailColumn === 'function') && isDetailColumn(cIdx);
                if (_isDetailTarget && src && (Array.isArray(src) || (typeof src === 'object'))) {
                    var _hasObjSrc = false;
                    if (Array.isArray(src)) {
                        for (var _xoi = 0; _xoi < src.length; _xoi++) { if (src[_xoi] && typeof src[_xoi] === 'object') { _hasObjSrc = true; break; } }
                    } else { _hasObjSrc = true; }
                    if (_hasObjSrc) {
                        if (typeof _writeDetailCellFromRaw === 'function' && _writeDetailCellFromRaw(rIdx, cIdx, src)) {
                            changed++;
                            continue;
                        }
                    }
                }
                var nv;
                if (isArrTarget && !Array.isArray(src)) {
                    var s = (src === null || src === undefined) ? '' : (typeof src === 'object' ? (function () { try { return JSON.stringify(src); } catch (_e) { return ''; } })() : String(src));
                    nv = s === '' ? [] : s.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                } else if (!isArrTarget && Array.isArray(src)) {
                    // 对象数组：保留对象结构（深拷贝）；标量数组：扁平化为字符串
                    var hasObjS = false;
                    for (var _soi = 0; _soi < src.length; _soi++) { if (src[_soi] && typeof src[_soi] === 'object') { hasObjS = true; break; } }
                    nv = hasObjS
                        ? ((typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(src) : src)
                        : formatCellValue(src);
                } else if (isArrTarget && Array.isArray(src)) {
                    nv = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(src) : src.slice();
                } else if (src && typeof src === 'object') {
                    // 普通对象：深拷贝
                    nv = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(src) : src;
                } else {
                    nv = src;
                }
                row[cIdx] = nv;
                S.mods.add(rIdx + ',' + cIdx);
                changed++;
            }
        }
        saveFile();
        renderTable();
        var msg = '已粘贴 ' + changed + ' 个单元格';
        if (skippedTsId) msg += '（testcase_id 列已跳过）';
        showToast(msg, 'success');
        return;
    }
    // 单值粘贴：原逻辑
    if (isFrozenCol(S._ctxCol)) { showToast('testcase_id 列不允许粘贴', 'error'); return; }
    pushHistory();
    var target = S.clip;
    var isArr = typeof isArrayCol === 'function' && isArrayCol(S._ctxCol);
    // detail 列：若 target 是对象 / 对象数组，走写入 detail 表的路径
    var _isDetailTargetSingle = (typeof isDetailColumn === 'function') && isDetailColumn(S._ctxCol);
    if (_isDetailTargetSingle && target && (Array.isArray(target) || typeof target === 'object')) {
        var _hasObjT0 = false;
        if (Array.isArray(target)) {
            for (var _xoi0 = 0; _xoi0 < target.length; _xoi0++) { if (target[_xoi0] && typeof target[_xoi0] === 'object') { _hasObjT0 = true; break; } }
        } else { _hasObjT0 = true; }
        if (_hasObjT0 && typeof _writeDetailCellFromRaw === 'function' && _writeDetailCellFromRaw(S._ctxRow, S._ctxCol, target)) {
            saveFile();
            renderTable();
            showToast('已粘贴', 'success');
            return;
        }
    }
    if (isArr && !Array.isArray(target)) {
        var s2 = (target === null || target === undefined) ? '' : (typeof target === 'object' ? (function () { try { return JSON.stringify(target); } catch (_e) { return ''; } })() : String(target));
        target = s2 === '' ? [] : s2.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
    } else if (!isArr && Array.isArray(target)) {
        // 对象数组保留原结构（深拷贝），仅当目标列不是数组列时若是标量数组才扁平化为字符串
        var hasObjT = false;
        for (var _toi = 0; _toi < target.length; _toi++) { if (target[_toi] && typeof target[_toi] === 'object') { hasObjT = true; break; } }
        if (hasObjT) {
            target = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(target) : target;
        } else {
            target = formatCellValue(target);
        }
    } else if (isArr && Array.isArray(target)) {
        // 标量数组列：按需深拷贝；若是对象数组放进标量数组列，则序列化每个元素
        target = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(target) : target.slice();
    } else if (target && typeof target === 'object') {
        // 普通对象：直接深拷贝赋值
        target = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(target) : target;
    }
    S.data.rows[S._ctxRow][S._ctxCol] = target;
    S.mods.add(S._ctxRow + ',' + S._ctxCol);
    saveFile();
    patchCell(S._ctxRow, S._ctxCol);
}

function clearCell() {
    // 矩形选区 > 1 格：批量清空（跳过冻结列）
    // 过滤模式下（仅看失败/列筛选）只清空实际可见行，避免误清被隐藏的成功行
    var rc = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
    if (rc && (rc.r1 !== rc.r2 || rc.c1 !== rc.c2)) {
        var rows = (S.data && S.data.rows) || [];
        var rowList = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
        if (!rowList || rowList.length === 0) {
            rowList = [];
            for (var rr = rc.r1; rr <= rc.r2; rr++) rowList.push(rr);
        }
        var changed = 0, skippedTsId = false;
        pushHistory();
        for (var i = 0; i < rowList.length; i++) {
            var r = rowList[i];
            for (var c = rc.c1; c <= rc.c2; c++) {
                if (isFrozenCol(c)) { skippedTsId = true; continue; }
                var row = rows[r]; if (!row) continue;
                var isArr = typeof isArrayCol === 'function' && isArrayCol(c);
                var nv = isArr ? [] : '';
                var ov = row[c];
                var oldStr = (ov === null || ov === undefined) ? '' : (Array.isArray(ov) ? formatCellValue(ov) : String(ov));
                var newStr = isArr ? '' : '';
                if (oldStr !== newStr) {
                    row[c] = nv;
                    S.mods.add(r + ',' + c);
                    changed++;
                }
            }
        }
        saveFile();
        renderTable();
        var msg = '已清空 ' + changed + ' 个单元格';
        if (skippedTsId) msg += '（testcase_id 列已跳过）';
        showToast(msg, 'success');
        return;
    }
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    if (isFrozenCol(S._ctxCol)) { showToast('testcase_id 列不允许清空', 'error'); return; }
    pushHistory();
    // 标量数组列清空 → 空数组，保持列类型不变
    if (typeof isArrayCol === 'function' && isArrayCol(S._ctxCol)) {
        S.data.rows[S._ctxRow][S._ctxCol] = [];
    } else {
        S.data.rows[S._ctxRow][S._ctxCol] = '';
    }
    S.mods.add(S._ctxRow + ',' + S._ctxCol);
    saveFile();
    patchCell(S._ctxRow, S._ctxCol);
}

// 批量填充单元格矩形选区：弹出输入框，输入值后填充整个选区（跳过冻结列）
function fillSelectedCells() {
    var rc = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
    if (!rc || (rc.r1 === rc.r2 && rc.c1 === rc.c2)) {
        showToast('请先拖选一个单元格区域', 'error');
        return;
    }
    xsPrompt('填充选中区域的值（作用于 ' + (rc.r2 - rc.r1 + 1) + '\u00d7' + (rc.c2 - rc.c1 + 1) + ' 格）', '', function (val) {
        if (val === null) return; // 取消
        var rows = (S.data && S.data.rows) || [];
        var rowList = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
        if (!rowList || rowList.length === 0) {
            rowList = [];
            for (var rr = rc.r1; rr <= rc.r2; rr++) rowList.push(rr);
        }
        var changed = 0, skippedTsId = false;
        pushHistory();
        for (var i = 0; i < rowList.length; i++) {
            var r = rowList[i];
            for (var c = rc.c1; c <= rc.c2; c++) {
                if (isFrozenCol(c)) { skippedTsId = true; continue; }
                var row = rows[r]; if (!row) continue;
                var isArr = typeof isArrayCol === 'function' && isArrayCol(c);
                var nv;
                if (isArr) {
                    nv = (val === '') ? [] : val.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                } else {
                    nv = val;
                }
                var ov = row[c];
                var oldStr = Array.isArray(ov) ? formatCellValue(ov) : (ov == null ? '' : String(ov));
                var newStr = Array.isArray(nv) ? formatCellValue(nv) : String(nv);
                if (oldStr !== newStr) {
                    row[c] = nv;
                    S.mods.add(r + ',' + c);
                    changed++;
                }
            }
        }
        saveFile();
        renderTable();
        var msg = '已批量填充 ' + changed + ' 个单元格';
        if (skippedTsId) msg += '（testcase_id 列已跳过）';
        showToast(msg, 'success');
    });
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
    // 深拷贝：避免数组单元格被多行引用共享
    var newRow = src.map(function (v) { return Array.isArray(v) ? v.slice() : v; });
    // 复制行需要重新生成 testcase_id（避免两行同 id），并清空已回写的 testCaseNo
    var headers0 = S.data.headers || [];
    var tsCol0 = headers0.indexOf('testcase_id');
    var tcCol0 = headers0.indexOf('testCaseNo');
    if (tsCol0 >= 0) newRow[tsCol0] = genUuidV4();
    if (tcCol0 >= 0) newRow[tcCol0] = '';
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
    S.cellSel = null;
    saveFile();
    renderTable();
    showToast('已在下方复制一行', 'success');
}

// 复制多行：在每行下方依次插入副本（从后往前插入以保持索引正确）
function copySelectedRows() {
    var selRows = (typeof getPushTargetRows === 'function') ? getPushTargetRows() : [];
    if (selRows.length <= 1) return;
    pushHistory();
    // 降序排列，从后往前插入，避免索引偏移
    selRows.sort(function (a, b) { return b - a; });
    var headers0 = S.data.headers || [];
    var tsCol0 = headers0.indexOf('testcase_id');
    var tcCol0 = headers0.indexOf('testCaseNo');
    var dts = getDetailTables();
    selRows.forEach(function (rowIdx) {
        var src = S.data.rows[rowIdx] || [];
        var newRow = src.map(function (v) { return Array.isArray(v) ? v.slice() : v; });
        if (tsCol0 >= 0) newRow[tsCol0] = genUuidV4();
        if (tcCol0 >= 0) newRow[tcCol0] = '';
        var at = rowIdx + 1;
        S.data.rows.splice(at, 0, newRow);
        // 同步复制明细表
        dts.forEach(function (dt) {
            if (!dt || !dt.rowGroups) return;
            var srcDetail = (dt.rowGroups[rowIdx] || []).map(function (dr) { return dr.slice(); });
            var srcRaw = (dt.rawRowGroups && dt.rawRowGroups[rowIdx])
                ? JSON.parse(JSON.stringify(dt.rawRowGroups[rowIdx])) : [];
            dt.rowGroups.splice(at, 0, srcDetail);
            if (dt.rawRowGroups) dt.rawRowGroups.splice(at, 0, srcRaw);
            if (dt.rawRowTypes) {
                var srcType = dt.rawRowTypes[rowIdx] || 'none';
                dt.rawRowTypes.splice(at, 0, srcType);
            }
        });
    });
    // 重建选中集：原索引 r → r + (选中行中 < r 的个数)
    if (S.sel && S.sel.size > 0) {
        var newSel = new Set();
        var asc = selRows.slice().sort(function (a, b) { return a - b; });
        S.sel.forEach(function (r) {
            var shift = 0;
            for (var j = 0; j < asc.length; j++) { if (asc[j] < r) shift++; }
            newSel.add(r + shift);
        });
        S.sel = newSel;
    }
    S.cellSel = null;
    saveFile();
    renderTable();
    showToast('已复制 ' + selRows.length + ' 行', 'success');
}

function pushFromContextMenu() {
    // 防重复点击（与 pushChanges 行为一致）
    if (S._pushing) {
        if (typeof showToast === 'function') showToast('推送中，请稍候…', 'info');
        return;
    }
    var headers = S.data.headers || [];
    // 优先推送选中行（行选 + 单元格矩形选区均算）；如未选中，则推送右键所在行
    var indices = (typeof getPushTargetRows === 'function') ? getPushTargetRows() : [];
    if (indices.length === 0) {
        if (S._ctxRow >= 0) {
            indices = [S._ctxRow];
        } else {
            return;
        }
    }
    var tsCol = headers.indexOf('testcase_id');
    var rowIndexMap = {};
    // 按 payload 数组下标 -> 表格 1-based 行号 的映射（兜底用）：
    // 当行的 testcase_id 为空时，仍可通过 body[i] 顺序对齐定位失败行号。
    var pushIndexToRow = [];
    var payload = indices.map(function (ri) {
        var record = {};
        var row = S.data.rows[ri] || [];
        headers.forEach(function (h, i) { record[h] = row[i] === undefined ? '' : row[i]; });
        if (tsCol >= 0) {
            var tid = row[tsCol];
            if (tid !== undefined && tid !== null && tid !== '') {
                rowIndexMap[String(tid)] = ri + 1;
            }
        }
        pushIndexToRow.push(ri + 1);
        return record;
    });
    // 缓存本批参与推送的行索引，供 pushResult 回来后清除对应的 S.mods 修改高亮。
    S._lastPushBatchRowIndices = indices.slice();
    // 缓存本批参与推送的 tsId（与 pushChanges 行为一致），供 pushResult 回来后做差集清理：
    // 本批中本次成功的 tsId 会从失败集合中移除，从而在"仅看推送失败"模式下被正确隐藏。
    S._lastPushBatchTsIds = new Set();
    if (tsCol >= 0) {
        indices.forEach(function (ri) {
            var t = (S.data.rows[ri] || [])[tsCol];
            if (t !== undefined && t !== null && t !== '') {
                S._lastPushBatchTsIds.add(String(t));
            }
        });
    }
    // 置忙（与 pushChanges 行为一致）
    S._pushing = true;
    if (typeof updatePushBtn === 'function') updatePushBtn();
    if (S._pushTimeoutTimer) { try { clearTimeout(S._pushTimeoutTimer); } catch (_) {} }
    S._pushTimeoutTimer = setTimeout(function () {
        S._pushTimeoutTimer = null;
        if (S._pushing) {
            S._pushing = false;
            if (typeof updatePushBtn === 'function') updatePushBtn();
            if (typeof showToast === 'function') showToast('推送超时未响应，已解除按钮锁定', 'error');
        }
    }, 30000);
    S.vscode.postMessage({ type: 'pushTestCase', data: payload, rowIndexMap: rowIndexMap, pushIndexToRow: pushIndexToRow });
}

// ==================== 用户标记 / 取消标记 ====================

// 收集当前选区对应的 MarkRect 列表
function collectMarkRects() {
    var rects = [];
    // 优先行选（整行标记，c1=-1）
    if (S.sel && S.sel.size > 0) {
        S.sel.forEach(function (r) {
            rects.push({ r1: r, c1: -1, r2: r, c2: -1 });
        });
    } else if (typeof getCellSelRect === 'function') {
        // 单元格矩形选区：保持原选区范围，不转换为整行
        var rc = getCellSelRect();
        if (rc) {
            rects.push({ r1: rc.r1, c1: rc.c1, r2: rc.r2, c2: rc.c2 });
        } else if (S._ctxRow >= 0 && S._ctxCol >= 0) {
            // 右键点单个单元格
            rects.push({ r1: S._ctxRow, c1: S._ctxCol, r2: S._ctxRow, c2: S._ctxCol });
        }
    } else if (S._ctxRow >= 0 && S._ctxCol >= 0) {
        rects.push({ r1: S._ctxRow, c1: S._ctxCol, r2: S._ctxRow, c2: S._ctxCol });
    }
    return rects;
}

// 统计当前选区内已被标记的单元格数量（通过 isUserMarked 逐格查询）
function countMarkedInRects(rects) {
    if (typeof isUserMarked !== 'function') return 0;
    var count = 0;
    rects.forEach(function (rc) {
        var c1 = rc.c1 === -1 ? 0 : rc.c1;
        var c2 = rc.c1 === -1 ? (S.data.headers ? S.data.headers.length - 1 : 0) : rc.c2;
        for (var r = rc.r1; r <= rc.r2; r++) {
            for (var c = c1; c <= c2; c++) {
                if (isUserMarked(r, c)) count++;
            }
        }
    });
    return count;
}

// 标记选中区域（弹出颜色选择器）
var _markPendingRects = null;
function markSelected() {
    var rects = collectMarkRects();
    if (rects.length === 0) return;
    _markPendingRects = rects;
    showMarkColorPicker();
}

// 取消标记选中区域（cell-by-cell 减法，支持选区与已存储矩形不完全重合的场景）
function unmarkSelected() {
    var rects = collectMarkRects();
    if (rects.length === 0) return;
    if (!S.vscode) return;

    var headersLen = (S.data.headers && S.data.headers.length) || 0;
    var existing = (S._userMarks && S._userMarks.rects) || [];

    if (existing.length === 0) {
        showToast('当前无标记', 'info');
        return;
    }

    // 展开选区矩形为 cell key 集合
    var selSet = {};
    rects.forEach(function (rc) {
        var c1 = rc.c1 === -1 ? 0 : rc.c1;
        var c2 = rc.c1 === -1 ? headersLen - 1 : rc.c2;
        for (var r = rc.r1; r <= rc.r2; r++) {
            for (var c = c1; c <= c2 && c < headersLen; c++) {
                selSet[r + ':' + c] = true;
            }
        }
    });

    // 逐个已存储矩形：保留未落在选区内的单元格
    var newRects = [];
    var removedCount = 0;
    existing.forEach(function (er) {
        var bg = er.bgColor || null;
        var fg = er.fontColor || null;
        var erC1 = er.c1 === -1 ? 0 : er.c1;
        var erC2 = er.c1 === -1 ? headersLen - 1 : er.c2;

        // 收集不被选区覆盖的单元格
        var cells = [];
        for (var r = er.r1; r <= er.r2; r++) {
            for (var c = erC1; c <= erC2 && c < headersLen; c++) {
                if (selSet[r + ':' + c]) {
                    removedCount++;
                } else {
                    cells.push([r, c]);
                }
            }
        }

        // 按行聚合成"水平连续段"矩形
        cells.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        for (var i = 0; i < cells.length;) {
            var r0 = cells[i][0], c0 = cells[i][1];
            var cEnd = c0;
            var j = i + 1;
            while (j < cells.length && cells[j][0] === r0 && cells[j][1] === cEnd + 1) {
                cEnd = cells[j][1];
                j++;
            }
            newRects.push({ r1: r0, c1: c0, r2: r0, c2: cEnd, bgColor: bg, fontColor: fg, timestamp: er.timestamp });
            i = j;
        }
    });

    if (removedCount === 0) {
        showToast('选区内无标记', 'info');
        return;
    }

    // 更新本地状态 + 重绘
    S._userMarks.rects = newRects;
    S._userMarks.cellMap = null;
    S._userMarks.rowMap = null;
    S._userMarks.rowSet = null;
    S._userMarks.cellTime = null;
    S._userMarks.rowTime = null;

    // 将完整结果发回扩展端持久化
    S.vscode.postMessage({ type: 'setMarkRects', rects: newRects });
    showToast('已取消标记 ' + removedCount + ' 个单元格', 'success');
    renderTable();
}

// 应用标记（带颜色）
function applyMarkWithColors(bgColor, fontColor) {
    if (!_markPendingRects || _markPendingRects.length === 0) return;
    if (!S.vscode) return;
    S.vscode.postMessage({ type: 'mark', rects: _markPendingRects, bgColor: bgColor, fontColor: fontColor });
    _markPendingRects = null;
    showToast('已标记', 'success');
}

// ==================== 颜色选择器 ====================
var _markPaletteBgColors = [
    ['#ffffff','#e3f2fd','#fff3e0','#e8f5e9','#fce4ec','#f3e5f5','#e0f7fa','#fffde7','#efebe9','#eceff1'],
    ['#bbdefb','#ffe0b2','#c8e6c9','#f8bbd0','#e1bee7','#80deea','#fff9c4','#d7ccc8','#cfd8dc','#b0bec5'],
    ['#90caf9','#ffcc80','#a5d6a7','#f48fb1','#ce93d8','#4dd0e1','#fff176','#bcaaa4','#90a4ae','#78909c'],
    ['#64b5f6','#ffb74d','#81c784','#f06292','#ba68c8','#00bcd4','#ffee58','#a1887f','#78909c','#546e7a'],
    ['#42a5f5','#ffa726','#66bb6a','#ec407a','#ab47bc','#00acc1','#fdd835','#8d6e63','#607d8b','#455a64'],
    ['#ffcdd2','#f44336','#e91e63','#9c27b0','#673ab7','#3f51b5','#2196f3','#00bcd4','#4caf50','#ff9800']
];

var _markPaletteFontColors = [
    ['#000000','#d32f2f','#c62828','#6a1b9a','#283593','#1565c0','#00695c','#2e7d32','#e65100','#4e342e'],
    ['#424242','#f44336','#e91e63','#9c27b0','#3f51b5','#2196f3','#0097a7','#4caf50','#ff9800','#795548'],
    ['#757575','#ffffff','#fff3e0','#e8f5e9','#e3f2fd','#f3e5f5','#fce4ec','#e0f2f1','#fffde7','#efebe9']
];

var _markCurBg = '#e3f2fd';
var _markCurFont = '';

function showMarkColorPicker() {
    hideMarkColorPicker();
    var panel = document.createElement('div');
    panel.id = 'markColorPicker';
    panel.className = 'xs-mark-picker';
    // 背景色区
    var bgHtml = '<div class="xs-mp-title">背景色</div><div class="xs-mp-row">';
    _markPaletteBgColors.forEach(function (row) {
        row.forEach(function (c) {
            var sel = (c === _markCurBg ? ' xs-mp-sel' : '');
            bgHtml += '<span class="xs-mp-swatch' + sel + '" style="background:' + c + '" data-bg="' + c + '" title="' + c + '"></span>';
        });
        bgHtml += '</div><div class="xs-mp-row">';
    });
    bgHtml += '</div>';
    // 分隔
    bgHtml += '<div class="xs-div"></div>';
    // 字体色区
    var fgHtml = '<div class="xs-mp-title">字体色</div><div class="xs-mp-row">';
    _markPaletteFontColors.forEach(function (row) {
        row.forEach(function (c) {
            var sel = (c === _markCurFont ? ' xs-mp-sel' : '');
            var borderCol = (c === '#ffffff' ? 'border:1px solid #ccc;' : '');
            fgHtml += '<span class="xs-mp-swatch' + sel + '" style="background:' + c + ';' + borderCol + '" data-fg="' + c + '" title="' + c + '"></span>';
        });
        fgHtml += '</div><div class="xs-mp-row">';
    });
    fgHtml += '</div>';
    // 预览 & 操作按钮
    var previewHtml = '<div class="xs-mp-footer"><span class="xs-mp-preview" id="mpPreview" style="background:' + (_markCurBg || '#fff') + ';color:' + (_markCurFont || '#000') + '">Aa</span>';
    previewHtml += '<button id="mpApply" class="xs-mp-btn">标记</button>';
    previewHtml += '<button id="mpCancel" class="xs-mp-btn xs-mp-btn-cancel">取消</button></div>';
    panel.innerHTML = bgHtml + fgHtml + previewHtml;
    document.body.appendChild(panel);
    // 居中定位
    var w = panel.offsetWidth, h = panel.offsetHeight;
    panel.style.left = Math.max(8, (window.innerWidth - w) / 2) + 'px';
    panel.style.top = Math.max(48, (window.innerHeight - h) / 2) + 'px';
    // 事件绑定
    panel.addEventListener('click', function (e) {
        var t = e.target;
        if (t.classList.contains('xs-mp-swatch')) {
            var bg = t.getAttribute('data-bg');
            var fg = t.getAttribute('data-fg');
            if (bg !== null) _markCurBg = (_markCurBg === bg ? '' : bg);
            if (fg !== null) _markCurFont = (_markCurFont === fg ? '' : fg);
            // 更新所有 swatch 选中态
            panel.querySelectorAll('.xs-mp-swatch[data-bg]').forEach(function (s) {
                s.classList.toggle('xs-mp-sel', s.getAttribute('data-bg') === _markCurBg);
            });
            panel.querySelectorAll('.xs-mp-swatch[data-fg]').forEach(function (s) {
                s.classList.toggle('xs-mp-sel', s.getAttribute('data-fg') === _markCurFont);
            });
            var pv = document.getElementById('mpPreview');
            if (pv) { pv.style.background = (_markCurBg || '#fff'); pv.style.color = (_markCurFont || '#000'); }
        }
        if (t.id === 'mpApply') {
            hideMarkColorPicker();
            applyMarkWithColors(_markCurBg || null, _markCurFont || null);
        }
        if (t.id === 'mpCancel') { hideMarkColorPicker(); _markPendingRects = null; }
    });
    // 点击外部关闭
    setTimeout(function () {
        document.addEventListener('click', _onDocClickHidePicker);
    }, 10);
}

function hideMarkColorPicker() {
    var panel = document.getElementById('markColorPicker');
    if (panel) panel.remove();
    document.removeEventListener('click', _onDocClickHidePicker);
}

function _onDocClickHidePicker(e) {
    var panel = document.getElementById('markColorPicker');
    if (panel && !panel.contains(e.target)) { hideMarkColorPicker(); _markPendingRects = null; }
}
