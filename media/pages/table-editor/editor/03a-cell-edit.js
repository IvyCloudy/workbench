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
    input.rows = 1;
    input.value = oldVal == null ? '' : String(oldVal);
    // 所在行被人为拉高时，启用多行编辑（Enter 换行，Ctrl/Cmd+Enter 提交）
    var tr = td.parentElement;
    var multiline = !!(tr && tr.classList && tr.classList.contains('xs-tr-resized'));
    if (multiline) input.classList.add('xs-cell-input-multi');
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
            var newVal = input.value;
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
                    if (skippedTsId) msg += '（tsId 列已跳过）';
                    if (typeof showToast === 'function') showToast(msg, 'success');
                    return;
                }
                row[ci] = newVal;
                S.mods.add(ri + ',' + ci);
                saveFile();
            }
        }
        var curVal = row[ci];
        td.classList.remove('xs-editing');
        td.innerHTML = '<div class="xs-cell-wrap">' + escapeHtml(formatCellValue(curVal)) + '</div>';
        if (S.mods.has(ri + ',' + ci)) td.classList.add('modified');
        // 同步刷新 tooltip
        var ftxt = formatCellValue(curVal);
        if (ftxt) td.setAttribute('title', ftxt); else td.removeAttribute('title');
    }
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
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
        items.push({ divider: true });
        items.push({ label: '删除该列', action: function () { deleteCol(S._ctxCol); }, disabled: S._ctxCol < 0 || isFrozenCol(S._ctxCol) });
        items.push({ label: '重命名列', action: function () { renameCol(S._ctxCol); }, disabled: S._ctxCol < 0 || isFrozenCol(S._ctxCol) });
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
        items.push({ divider: true });
        items.push({ label: '在下方复制此行', action: copyRowInline, disabled: S._ctxRow < 0 });
        items.push({ label: '在上方插入行', action: function () { insertRow(S._ctxRow); }, disabled: S._ctxRow < 0 });
        items.push({ label: '在下方插入行', action: function () { insertRow(S._ctxRow + 1); }, disabled: S._ctxRow < 0 });
        items.push({ divider: true });
        items.push({ label: '插入列（左侧）', action: function () { insertCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
        items.push({ label: '插入列（右侧）', action: function () { insertCol(S._ctxCol + 1); }, disabled: S._ctxCol < 0 });
        items.push({ label: '重命名列', action: function () { renameCol(S._ctxCol); }, disabled: S._ctxCol < 0 || isFrozenCol(S._ctxCol) });
        items.push({ label: '删除该列', action: function () { deleteCol(S._ctxCol); }, disabled: S._ctxCol < 0 || isFrozenCol(S._ctxCol) });
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
function insertRow(at) {
    var headers = S.data.headers || [];
    var width = headers.length;
    var newRow = new Array(width).fill('');
    // 标量数组列的默认值为空数组，避免不同列同一行内类型冲突
    headers.forEach(function (_, ci) {
        if (typeof isArrayCol === 'function' && isArrayCol(ci)) newRow[ci] = [];
    });
    // 新行自动生成 testcase_id；testCaseNo 保留为空（由推送响应回写）
    var tsCol = headers.indexOf('testcase_id');
    if (tsCol >= 0) newRow[tsCol] = genUuidV4();
    if (at < 0) at = 0;
    if (at > S.data.rows.length) at = S.data.rows.length;
    pushHistory();
    S.data.rows.splice(at, 0, newRow);
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
    // 行结构变化 → 清除单元格矩形选区，避免索引错位
    S.cellSel = null;
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
    S.cellSel = null;
    saveFile();
    renderTable();
}

function deleteSelectedRows() {
    if (S.sel.size === 0) return;
    pushHistory();
    var sorted = Array.from(S.sel).sort(function (a, b) { return b - a; });
    sorted.forEach(function (i) { S.data.rows.splice(i, 1); });
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
                var v = (rows[r] && rows[r][c] !== undefined) ? rows[r][c] : '';
                line.push(Array.isArray(v) ? v.slice() : v);
            }
            grid.push(line);
        }
        S.clip = grid;
        showToast('已复制 ' + rowList.length + ' × ' + (rc.c2 - rc.c1 + 1) + ' 区域', 'success');
        return;
    }
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    var v0 = (S.data.rows[S._ctxRow] && S.data.rows[S._ctxRow][S._ctxCol]);
    if (v0 === undefined) v0 = '';
    // 数组单元格拷贝一份副本，避免后续粘贴后引用共享
    S.clip = Array.isArray(v0) ? v0.slice() : v0;
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
                var nv;
                if (isArrTarget && !Array.isArray(src)) {
                    var s = (src === null || src === undefined) ? '' : String(src);
                    nv = s === '' ? [] : s.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                } else if (!isArrTarget && Array.isArray(src)) {
                    nv = formatCellValue(src);
                } else if (isArrTarget && Array.isArray(src)) {
                    nv = src.slice();
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
    if (isArr && !Array.isArray(target)) {
        var s2 = (target === null || target === undefined) ? '' : String(target);
        target = s2 === '' ? [] : s2.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
    } else if (!isArr && Array.isArray(target)) {
        target = formatCellValue(target);
    } else if (isArr && Array.isArray(target)) {
        target = target.slice(); // 避免引用共享
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

function pushFromContextMenu() {
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
        return record;
    });
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
    S.vscode.postMessage({ type: 'pushTestCase', data: payload, rowIndexMap: rowIndexMap });
}
