/* =============================================================================
 * 03-cell-ops.js  —— 单元格 / 行 / 列 操作（含右键菜单与拖动）
 * -----------------------------------------------------------------------------
 * 集中处理用户对表格内容的所有交互式编辑动作，主要分四组：
 *   1. 单元格编辑：selectCell / onCellDblClick / startEdit
 *      （进入编辑、提交修改、Esc 取消、tsId 等冻结列禁止编辑）
 *   2. 右键菜单：showContextMenu / hideContextMenu
 *      （根据点击位置动态构造菜单项：插入 / 删除 / 复制 / 粘贴 / 清空 / 推送 等）
 *   3. 行/列操作：insertRow / deleteRow / deleteSelectedRows / insertCol /
 *      deleteCol / renameCol / copyCell / pasteCell / clearCell /
 *      copyRow / copyRowInline / pushFromContextMenu
 *   4. 列宽拖动 / 列选择（Excel 风格）：startColResize、isFrozenCol、
 *      onColHeaderMouseDown（按住左键沿表头横扫形成连续列选区，配合 Ctrl/Shift
 *      支持离散与区间选择）、updateColSelClasses、applyColumnsBulk、
 *      clearSelectedCols、fillSelectedCols
 *   5. 行高 / 行拖动：startRowResize / resetRowHeight、onRowDragStart/Over/Drop
 *
 * 所有写操作前都会调用 pushHistory() 以支持撤销，并在结束时 saveFile() + renderTable()。
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
    // tsId 列冻结：不允许双击进入编辑
    if (isFrozenCol(ci)) {
        e.preventDefault();
        showToast('tsId 列为系统列，不允许编辑', 'error');
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
    startEdit(e);
}

function startEdit(e) {
    if (S.editing) return;
    var td = e.currentTarget;
    var ri = parseInt(td.getAttribute('data-row'), 10);
    var ci = parseInt(td.getAttribute('data-col'), 10);
    // tsId 列冻结：不允许进入编辑
    if (isFrozenCol(ci)) {
        showToast('tsId 列为系统列，不允许编辑', 'error');
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
        items.push({ label: '删除该列', action: function () { deleteCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
        items.push({ label: '重命名列', action: function () { renameCol(S._ctxCol); }, disabled: S._ctxCol < 0 });
        if (S.colSel.size > 0) {
            items.push({ divider: true });
            items.push({ label: '清空选中列 (' + S.colSel.size + ')', action: clearSelectedCols });
            items.push({ label: '批量填充选中列 (' + S.colSel.size + ')…', action: fillSelectedCols });
        }
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
        if (S.colSel.size > 0) {
            items.push({ divider: true });
            items.push({ label: '清空选中列 (' + S.colSel.size + ')', action: clearSelectedCols });
            items.push({ label: '批量填充选中列 (' + S.colSel.size + ')…', action: fillSelectedCols });
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
    // 新行自动生成 tsId；testCaseNo 保留为空（由推送响应回写）
    var tsCol = headers.indexOf('tsId');
    if (tsCol >= 0) newRow[tsCol] = genUuidV4();
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
    if (isFrozenCol(S._ctxCol)) { showToast('tsId 列不允许粘贴', 'error'); return; }
    pushHistory();
    S.data.rows[S._ctxRow][S._ctxCol] = S.clip;
    S.mods.add(S._ctxRow + ',' + S._ctxCol);
    saveFile();
    renderTable();
}

function clearCell() {
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    if (isFrozenCol(S._ctxCol)) { showToast('tsId 列不允许清空', 'error'); return; }
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
    // 复制行需要重新生成 tsId（避免两行同 id），并清空已回写的 testCaseNo
    var headers0 = S.data.headers || [];
    var tsCol0 = headers0.indexOf('tsId');
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
    var tsCol = headers.indexOf('tsId');
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
    S.vscode.postMessage({ type: 'pushTestCase', data: payload, rowIndexMap: rowIndexMap });
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

// ==================== 列选择（Excel 风格）====================
// 列冻结：tsId 列为系统列，禁止任何编辑/覆写
function isFrozenCol(ci) {
    if (typeof ci !== 'number' || ci < 0) return false;
    var headers = (S.data && S.data.headers) || [];
    return headers[ci] === 'tsId';
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
    var newVal = (fillVal === undefined) ? '' : String(fillVal);
    var changed = 0;
    rows.forEach(function (row, ri) {
        targets.forEach(function (ci) {
            var oldV = row[ci];
            var oldStr = (oldV === null || oldV === undefined) ? '' : String(oldV);
            if (oldStr !== newVal) {
                row[ci] = newVal;
                S.mods.add(ri + ',' + ci);
                changed++;
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
    var tr = e.currentTarget.parentElement;
    if (!tr) return;
    var ri = parseInt(tr.getAttribute('data-row'), 10);
    if (isNaN(ri)) return;

    e.preventDefault();
    e.stopPropagation();

    var startY = e.clientY;
    var startH = tr.offsetHeight;
    // 临时禁用 HTML5 拖拽（行排序），避免与行高拖动冲突
    var prevDraggable = tr.getAttribute('draggable');
    tr.setAttribute('draggable', 'false');
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
        // 恢复 draggable，下一次 tick 再恢复，避免 mouseup 立刻触发 dragstart
        setTimeout(function () {
            if (prevDraggable === null) tr.removeAttribute('draggable');
            else tr.setAttribute('draggable', prevDraggable);
        }, 0);
        var finalH = tr.offsetHeight;
        S.rowHeights[ri] = finalH;
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function resetRowHeight(e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    var tr = e.currentTarget.parentElement;
    if (!tr) return;
    var ri = parseInt(tr.getAttribute('data-row'), 10);
    if (isNaN(ri)) return;
    e.preventDefault();
    e.stopPropagation();
    delete S.rowHeights[ri];
    tr.style.height = '';
    tr.classList.remove('xs-tr-resized');
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
