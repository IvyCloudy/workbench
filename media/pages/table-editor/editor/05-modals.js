/* =============================================================================
 * 05-modals.js  —— 弹窗集合 + 应用启动（必须最后加载）
 * -----------------------------------------------------------------------------
 * 集中所有弹窗逻辑，并在文件末尾调用 init() 启动整个应用：
 *   1. 推送结果弹窗（成功 / 部分成功 / 全部失败）：
 *      - showPushResultModal / closePushResultModal / bindPushResultModal
 *      - 失败行高亮联动主表（tsId 等列变红）、点击行号跳转、复制失败明细
 *      - jumpToRowByDisplayIndex：按显示行号滚动到目标行
 *   2. 通用 Prompt / Confirm 弹窗（替代受 sandbox 限制的原生 prompt/confirm）：
 *      - bindXsPrompt / isXsPromptOpen / closeXsPrompt / xsPrompt / xsConfirm
 *   3. 步骤明细弹窗（detailTable 子表编辑）：
 *      - getDetailTables / getDetailTableByField / getDetailTableByCol /
 *        getCurrentDetailTable / isDetailColumn / hasDetailRows /
 *        hasDetailRowsAtCol / isDetailModalOpen
 *      - bindDetailModal / openDetailModal / closeDetailModal /
 *        renderDetailTable / startDetailEdit / showDetailContextMenu
 *      - insertDetailRow / copyDetailRowAt / copyDetailRow /
 *        insertDetailRowAt / deleteDetailRow / saveDetailModal /
 *        updateDetailModInfo
 *
 * 文件最末尾的 init() 调用是整个 webview 的启动点，前面 4 个文件加载完毕后
 * 这里调用 init() 才能保证全部依赖函数已就绪。
 * ========================================================================== */


// ==================== 推送结果弹窗 ====================
// 展示推送结果（成功 / 部分成功 / 全部失败）
// payload: { fileName, successCount, failures:[{rowIndex, tsId, reason}], total }
var __PR_MAX_INLINE = 200; // 列表最多渲染条数，超出折叠
function showPushResultModal(payload) {
    var modal = document.getElementById('pushResultModal');
    if (!modal) return;
    var p = payload || {};
    var fileName = p.fileName || '';
    var successCount = p.successCount || 0;
    var failures = Array.isArray(p.failures) ? p.failures : [];
    var total = (p.total != null) ? p.total : (successCount + failures.length);

    var allFailed = (failures.length > 0 && successCount === 0);
    var allSuccess = (failures.length === 0);
    var status = allSuccess ? 'success' : (allFailed ? 'error' : 'warning');

    var header = document.getElementById('pushResultHeader');
    var iconEl = document.getElementById('pushResultIcon');
    var titleEl = document.getElementById('pushResultTitle');
    var summaryEl = document.getElementById('pushResultSummary');
    var listEl = document.getElementById('pushResultList');
    var hintEl = document.getElementById('pushResultHint');
    var copyBtn = document.getElementById('pushResultCopyBtn');

    // 头部状态
    if (header) header.className = 'xs-modal-header xs-pr-header is-' + status;
    if (iconEl) iconEl.textContent = (status === 'success') ? '✓' : (status === 'error' ? '✕' : '!');
    if (titleEl) {
        var titleText = (status === 'success') ? '推送成功' : (status === 'error' ? '推送失败' : '推送部分成功');
        titleEl.textContent = titleText + (fileName ? ('：' + fileName) : '');
    }

    // 概要：成功 / 失败 / 总计
    if (summaryEl) {
        summaryEl.innerHTML =
            '<span class="xs-pr-summary-item">总计 <span class="xs-pr-num">' + total + '</span></span>' +
            '<span class="xs-pr-summary-item">成功 <span class="xs-pr-num is-success">' + successCount + '</span></span>' +
            '<span class="xs-pr-summary-item">失败 <span class="xs-pr-num is-failed">' + failures.length + '</span></span>';
    }

    // 失败明细列表
    if (listEl) {
        if (failures.length === 0) {
            listEl.innerHTML = '<div class="xs-pr-empty">全部 ' + total + ' 条推送成功 🎉</div>';
        } else {
            var renderCount = Math.min(failures.length, __PR_MAX_INLINE);
            var html = '';
            for (var i = 0; i < renderCount; i++) {
                var f = failures[i] || {};
                var hasRow = (f.rowIndex != null && f.rowIndex > 0);
                var rowText = hasRow ? ('第 ' + f.rowIndex + ' 行') : ('tsId ' + (f.tsId ? String(f.tsId).slice(0, 8) + '…' : '(无)'));
                var rowCls = 'xs-pr-row' + (hasRow ? ' is-link' : '');
                var rowAttr = hasRow ? (' data-row="' + f.rowIndex + '" title="点击定位到该行"') : '';
                html += '<div class="xs-pr-item">'
                    +    '<span class="xs-pr-seq">' + (i + 1) + '.</span>'
                    +    '<span class="' + rowCls + '"' + rowAttr + '>' + escapeHtml(rowText) + '</span>'
                    +    '<span class="xs-pr-reason">' + escapeHtml(String(f.reason || '')) + '</span>'
                    + '</div>';
            }
            if (failures.length > __PR_MAX_INLINE) {
                html += '<div class="xs-pr-truncated">…另有 ' + (failures.length - __PR_MAX_INLINE) + ' 条失败未展示，请点击「复制失败明细」获取完整列表。</div>';
            }
            listEl.innerHTML = html;

            // 绑定行号点击 -> 滚动并高亮主表对应行
            var links = listEl.querySelectorAll('.xs-pr-row.is-link');
            for (var k = 0; k < links.length; k++) {
                links[k].addEventListener('click', function (ev) {
                    var rn = parseInt(ev.currentTarget.getAttribute('data-row'), 10);
                    if (!isNaN(rn) && rn > 0) jumpToRowByDisplayIndex(rn);
                });
            }
        }
    }

    if (hintEl) hintEl.textContent = (failures.length > 0) ? '点击行号可定位到表格对应行；失败行已在表格中高亮标记' : '';
    if (copyBtn) copyBtn.style.display = (failures.length > 0) ? '' : 'none';

    // 按 tsId 标记失败行，重绘表格以高亮展示
    if (!S._pushFailedTsIds) S._pushFailedTsIds = new Set();
    S._pushFailedTsIds.clear();
    failures.forEach(function (f) {
        if (f && f.tsId !== undefined && f.tsId !== null && f.tsId !== '') {
            S._pushFailedTsIds.add(String(f.tsId));
        }
    });
    try { renderTable(); } catch (_) { /* ignore */ }

    // 缓存全量明细文本，便于复制
    S._pushResultDetailText = failures.map(function (f, i) {
        var rowPart = (f.rowIndex != null && f.rowIndex > 0) ? ('第 ' + f.rowIndex + ' 行') : ('tsId ' + (f.tsId || '(无)'));
        return (i + 1) + '. ' + rowPart + '：' + (f.reason || '');
    }).join('\n');

    bindPushResultModal();
    modal.classList.add('show');
}

function closePushResultModal() {
    var modal = document.getElementById('pushResultModal');
    if (modal) modal.classList.remove('show');
}

function bindPushResultModal() {
    if (S._pushResultBound) return;
    S._pushResultBound = true;
    var modal = document.getElementById('pushResultModal');
    var close = document.getElementById('pushResultClose');
    var ok = document.getElementById('pushResultOkBtn');
    var copy = document.getElementById('pushResultCopyBtn');
    if (close) close.addEventListener('click', closePushResultModal);
    if (ok) ok.addEventListener('click', closePushResultModal);
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closePushResultModal(); });
    if (copy) copy.addEventListener('click', function () {
        var text = S._pushResultDetailText || '';
        if (!text) { showToast('无失败明细可复制', 'error'); return; }
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { showToast('失败明细已复制', 'success'); },
                function () { fallbackCopy(text); });
        } else {
            fallbackCopy(text);
        }
    });
    // ESC 关闭
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
            var m = document.getElementById('pushResultModal');
            if (m && m.classList.contains('show')) {
                ev.preventDefault();
                closePushResultModal();
            }
        }
    });
}

function fallbackCopy(text) {
    try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('失败明细已复制', 'success');
    } catch (_) {
        showToast('复制失败', 'error');
    }
}

// 关闭推送结果弹窗后，按"显示行号"（用户视觉上从 1 开始的物理行号）滚动并高亮主表
function jumpToRowByDisplayIndex(rowIndex) {
    closePushResultModal();
    var r = rowIndex - 1; // 转成 0-based 索引
    if (r < 0 || r >= (S.data && S.data.rows ? S.data.rows.length : 0)) {
        showToast('该行已不在当前表格中（可能已被筛选或删除）', 'error');
        return;
    }
    // 选中该行并滚动到可见
    S.sel = new Set([r]);
    renderTable();
    setTimeout(function () {
        var tr = document.querySelector('tr[data-row="' + r + '"]');
        if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
}

// ==================== 通用 Prompt / Confirm 弹窗 ====================
// 替代受 vscode webview sandbox 限制的 window.prompt / window.confirm
function bindXsPrompt() {
    if (S._xsPromptBound) return;
    S._xsPromptBound = true;
    var modal = document.getElementById('xsPromptModal');
    var ok = document.getElementById('xsPromptOk');
    var cancel = document.getElementById('xsPromptCancel');
    var close = document.getElementById('xsPromptClose');
    var input = document.getElementById('xsPromptInput');
    if (!modal || !ok || !cancel || !close) return;
    ok.addEventListener('click', function () { closeXsPrompt(true); });
    cancel.addEventListener('click', function () { closeXsPrompt(false); });
    close.addEventListener('click', function () { closeXsPrompt(false); });
    modal.addEventListener('click', function (e) { if (e.target === modal) closeXsPrompt(false); });
    if (input) input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); closeXsPrompt(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); closeXsPrompt(false); }
        ev.stopPropagation();
    });
}

function isXsPromptOpen() {
    var modal = document.getElementById('xsPromptModal');
    return !!(modal && modal.classList.contains('show'));
}

function closeXsPrompt(confirmed) {
    var modal = document.getElementById('xsPromptModal');
    if (!modal) return;
    modal.classList.remove('show');
    var input = document.getElementById('xsPromptInput');
    var cb = S._xsPromptCb;
    var mode = S._xsPromptMode;
    var val = input ? input.value : '';
    S._xsPromptCb = null;
    S._xsPromptMode = null;
    if (typeof cb === 'function') {
        if (mode === 'confirm') {
            if (confirmed) cb();
        } else {
            cb(confirmed ? val : null);
        }
    }
}

// xsPrompt(title, defaultValue, onOk(value|null))
function xsPrompt(title, defaultValue, onOk) {
    var modal = document.getElementById('xsPromptModal');
    var titleEl = document.getElementById('xsPromptTitle');
    var input = document.getElementById('xsPromptInput');
    var footer = modal ? modal.querySelector('.xs-modal-footer') : null;
    if (!modal || !input) { onOk(window.prompt(title, defaultValue)); return; }
    if (titleEl) titleEl.textContent = title || '请输入';
    input.style.display = '';
    input.value = defaultValue === undefined || defaultValue === null ? '' : String(defaultValue);
    if (footer) footer.style.display = '';
    S._xsPromptMode = 'prompt';
    S._xsPromptCb = onOk;
    modal.classList.add('show');
    setTimeout(function () { input.focus(); input.select(); }, 0);
}

// xsConfirm(title, onOk())
function xsConfirm(title, onOk) {
    var modal = document.getElementById('xsPromptModal');
    var titleEl = document.getElementById('xsPromptTitle');
    var input = document.getElementById('xsPromptInput');
    if (!modal) { if (window.confirm(title)) onOk(); return; }
    if (titleEl) titleEl.textContent = title || '确认';
    if (input) input.style.display = 'none';
    S._xsPromptMode = 'confirm';
    S._xsPromptCb = onOk;
    modal.classList.add('show');
    var ok = document.getElementById('xsPromptOk');
    if (ok) setTimeout(function () { ok.focus(); }, 0);
}

// ==================== 明细弹窗 ====================
// 返回所有明细表（同时兼容老的单字段 detailTable）
function getDetailTables() {
    if (!S.data) return [];
    if (Array.isArray(S.data.detailTables) && S.data.detailTables.length > 0) {
        return S.data.detailTables;
    }
    if (S.data.detailTable && S.data.detailTable.field) {
        return [S.data.detailTable];
    }
    return [];
}

function getDetailTableByField(field) {
    var ts = getDetailTables();
    for (var i = 0; i < ts.length; i++) {
        if (ts[i] && ts[i].field === field) return ts[i];
    }
    return null;
}

function getDetailTableByCol(ci) {
    var headers = (S.data && S.data.headers) || [];
    var name = headers[ci];
    if (name === undefined) return null;
    return getDetailTableByField(name);
}

function getCurrentDetailTable() {
    return getDetailTableByField(S._detailField);
}

function isDetailColumn(ci) {
    return !!getDetailTableByCol(ci);
}

function hasDetailRows(ri) {
    var ts = getDetailTables();
    for (var i = 0; i < ts.length; i++) {
        var dt = ts[i];
        if (!dt || !dt.rowGroups) continue;
        var g = dt.rowGroups[ri];
        if (Array.isArray(g) && g.length > 0) return true;
    }
    return false;
}

// 判断某列在某主行上是否有可点开的明细
function hasDetailRowsAtCol(ri, ci) {
    var dt = getDetailTableByCol(ci);
    if (!dt || !dt.rowGroups) return false;
    var g = dt.rowGroups[ri];
    return Array.isArray(g) && g.length > 0;
}

function isDetailModalOpen() {
    var m = document.getElementById('detailModal');
    return !!(m && m.classList.contains('show'));
}

function bindDetailModal() {
    var close = document.getElementById('detailModalClose');
    var copy = document.getElementById('detailCopyBtn');
    if (copy) copy.addEventListener('click', copyDetailRow);
    var cancel = document.getElementById('detailCancelBtn');
    var save = document.getElementById('detailSaveBtn');
    var add = document.getElementById('detailAddBtn');
    if (close) close.addEventListener('click', closeDetailModal);
    if (cancel) cancel.addEventListener('click', closeDetailModal);
    if (save) save.addEventListener('click', saveDetailModal);
    if (add) add.addEventListener('click', function () { insertDetailRow(false); });
    var overlay = document.getElementById('detailModal');
    if (overlay) overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeDetailModal();
    });
}

function openDetailModal(ri, field) {
    // 未传 field 时后兼容：取第一个在该行有明细的字段
    if (!field) {
        var ts = getDetailTables();
        for (var i = 0; i < ts.length; i++) {
            var t = ts[i];
            if (!t || !t.rowGroups) continue;
            var g = t.rowGroups[ri];
            if (Array.isArray(g) && g.length > 0) { field = t.field; break; }
        }
    }
    var dt = getDetailTableByField(field);
    if (!dt || !dt.rowGroups) return;
    S._detailField = field;
    S._detailRowIdx = ri;
    S._detailMods = new Set();
    S._detailSel = new Set();
    // 快照备份，取消时还原，避免修改后被意外保留
    try {
        S._detailBackup = {
            rows: JSON.parse(JSON.stringify(dt.rowGroups[ri] || [])),
            raws: dt.rawRowGroups ? JSON.parse(JSON.stringify(dt.rawRowGroups[ri] || [])) : null
        };
    } catch (err) {
        S._detailBackup = null;
    }
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    var title = document.getElementById('detailModalTitle');
    if (title) {
        var typeTag = rawType === 'object' ? '（嵌套对象）' : '';
        title.textContent = (dt.fieldDisplay || dt.field || '明细') + typeTag + ' - 第 ' + (ri + 1) + ' 行';
    }
    // 嵌套对象类型禁用"复制行/添加行"，对象只能有一行子表
    var isObj = rawType === 'object';
    var copyBtn = document.getElementById('detailCopyBtn');
    var addBtn = document.getElementById('detailAddBtn');
    if (copyBtn) copyBtn.style.display = isObj ? 'none' : '';
    if (addBtn) addBtn.style.display = isObj ? 'none' : '';
    renderDetailTable();
    var m = document.getElementById('detailModal');
    if (m) m.classList.add('show');
    updateDetailModInfo();
}

// discard 默认 true（取消/Esc/点遮罩均丢弃修改）；saveDetailModal 会传 false
function closeDetailModal(discard) {
    if (discard === undefined) discard = true;
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (discard && dt && ri >= 0 && S._detailBackup) {
        // 还原快照
        dt.rowGroups[ri] = S._detailBackup.rows;
        if (dt.rawRowGroups && S._detailBackup.raws) dt.rawRowGroups[ri] = S._detailBackup.raws;
    }
    var m = document.getElementById('detailModal');
    if (m) m.classList.remove('show');
    S._detailField = '';
    S._detailRowIdx = -1;
    S._detailMods.clear();
    S._detailSel.clear();
    S._detailBackup = null;
}

function renderDetailTable() {
    var body = document.getElementById('detailModalBody');
    var dt = getCurrentDetailTable();
    if (!body || !dt) return;
    var ri = S._detailRowIdx;
    var dh = dt.headers || [];
    var rows = (dt.rowGroups && dt.rowGroups[ri]) || [];

    var html = '<table class="xs-detail-table"><thead><tr>';
    html += '<th class="xs-detail-row-cb">#</th>';
    dh.forEach(function (h) { html += '<th>' + escapeHtml(String(h)) + '</th>'; });
    var isObj = (dt.rawRowTypes && dt.rawRowTypes[ri]) === 'object';
    if (!isObj) html += '<th class="xs-detail-row-op">操作</th>';
    html += '</tr></thead><tbody>';
    rows.forEach(function (row, di) {
        html += '<tr data-drow="' + di + '">';
        // 行号列（不再内嵌删除按钮）
        html += '<td class="xs-detail-row-cb">'
            + '<span class="xs-detail-rownum">' + (di + 1) + '</span>'
            + '</td>';
        dh.forEach(function (_, ci) {
            var v = row[ci];
            var modCls = S._detailMods.has(di + ',' + ci) ? ' modified' : '';
            html += '<td class="xs-editable' + modCls + '" data-drow="' + di + '" data-dcol="' + ci + '">'
                + escapeHtml(formatCellValue(v)) + '</td>';
        });
        // 末尾操作列：删除按钮（嵌套对象不提供，防止误删）
        if (!isObj) {
            html += '<td class="xs-detail-row-op">'
                + '<span class="xs-detail-rowdel" title="删除该行" data-drow="' + di + '">×</span>'
                + '</td>';
        }
        html += '</tr>';
    });
    html += '</tbody></table>';
    body.innerHTML = html;

    // 绑定事件
    body.querySelectorAll('.xs-detail-rowdel').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var di = parseInt(btn.getAttribute('data-drow'), 10);
            if (!isNaN(di)) deleteDetailRow(di);
        });
    });
    body.querySelectorAll('td.xs-editable').forEach(function (td) {
        td.addEventListener('dblclick', startDetailEdit);
        td.addEventListener('click', function () {
            body.querySelectorAll('td.xs-editable.active').forEach(function (n) { n.classList.remove('active'); });
            td.classList.add('active');
        });
        td.addEventListener('contextmenu', showDetailContextMenu);
        // tooltip：明细单元格完整原始值
        var fullText = td.textContent || '';
        if (fullText) td.setAttribute('title', fullText);
    });
}

function startDetailEdit(e) {
    if (S._detailEditing) return;
    var td = e.currentTarget;
    var di = parseInt(td.getAttribute('data-drow'), 10);
    var ci = parseInt(td.getAttribute('data-dcol'), 10);
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    if (isNaN(di) || isNaN(ci)) return;
    var rowsArr = (dt.rowGroups && dt.rowGroups[ri]) || null;
    if (!rowsArr || !rowsArr[di]) return;
    var oldVal = (rowsArr[di][ci] !== undefined) ? rowsArr[di][ci] : '';
    var input = document.createElement('input');
    input.type = 'text';
    input.value = oldVal;
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();
    S._detailEditing = true;

    function commit(save) {
        if (!S._detailEditing) return;
        S._detailEditing = false;
        // 二次防御：明细行可能因外部操作（删除/重渲染）已失效
        var curRows = (dt && dt.rowGroups) ? dt.rowGroups[ri] : null;
        var curRow = curRows ? curRows[di] : null;
        if (!curRow || isNaN(di) || isNaN(ci)) return;
        if (save) {
            var newVal = input.value;
            if (newVal !== oldVal) {
                curRow[ci] = newVal;
                S._detailMods.add(di + ',' + ci);
            }
        }
        var curVal = curRow[ci];
        td.textContent = formatCellValue(curVal);
        if (S._detailMods.has(di + ',' + ci)) td.classList.add('modified');
        // 同步刷新 tooltip
        var ft = td.textContent || '';
        if (ft) td.setAttribute('title', ft); else td.removeAttribute('title');
        updateDetailModInfo();
    }
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { commit(true); }
        else if (ev.key === 'Escape') { commit(false); }
    });
}

function showDetailContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    var td = e.currentTarget;
    var di = parseInt(td.getAttribute('data-drow'), 10);
    var menu = document.getElementById('ctxMenu');
    if (!menu) return;
    var items = [
        { label: '复制该行', action: function () { copyDetailRowAt(di); } },
        { divider: true },
        { label: '删除该行', action: function () { deleteDetailRow(di); } }
    ];
    var html = '';
    items.forEach(function (it) {
        if (it.divider) html += '<div class="xs-div"></div>';
        else html += '<div class="xs-mi" data-key="' + escapeHtml(it.label) + '">' + escapeHtml(it.label) + '</div>';
    });
    menu.innerHTML = html;
    menu.style.display = 'block';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

    menu.querySelectorAll('.xs-mi').forEach(function (mi, idx) {
        var realIdx = -1, walker = 0;
        for (var i = 0; i < items.length; i++) {
            if (items[i].divider) continue;
            if (walker === idx) { realIdx = i; break; }
            walker++;
        }
        mi.addEventListener('click', function (ev) {
            ev.stopPropagation();
            hideContextMenu();
            try { items[realIdx].action(); } catch (err) { console.error(err); }
        });
    });
}

function insertDetailRow(beforeFirst) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    if (rawType === 'object') { showToast('嵌套对象不支持多行', 'error'); return; }
    if (!dt.rowGroups[ri]) dt.rowGroups[ri] = [];
    var at = beforeFirst ? 0 : dt.rowGroups[ri].length;
    insertDetailRowAt(at);
}

/**
 * 复制单行到其下方（用于明细右键菜单"复制该行"）。
 */
function copyDetailRowAt(di) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0 || !dt.rowGroups[ri]) return;
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    if (rawType === 'object') { showToast('嵌套对象不支持多行', 'error'); return; }
    var rows = dt.rowGroups[ri];
    if (di < 0 || di >= rows.length) return;
    var headers = dt.headers || [];
    var srcRow = rows[di] || [];
    var newRow = headers.map(function (_, ci) { return srcRow[ci] !== undefined ? srcRow[ci] : ''; });
    rows.splice(di + 1, 0, newRow);
    if (dt.rawRowGroups) {
        if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
        var srcRaw = dt.rawRowGroups[ri][di];
        try {
            dt.rawRowGroups[ri].splice(di + 1, 0, srcRaw ? JSON.parse(JSON.stringify(srcRaw)) : {});
        } catch (e) {
            dt.rawRowGroups[ri].splice(di + 1, 0, {});
        }
    }
    // 已有修改集合的索引整体后移
    var ns = new Set();
    S._detailMods.forEach(function (k) {
        var p = k.split(','); var d = parseInt(p[0], 10); var c = parseInt(p[1], 10);
        ns.add((d > di ? d + 1 : d) + ',' + c);
    });
    // 新行整行标记为已修改
    for (var ci2 = 0; ci2 < headers.length; ci2++) ns.add((di + 1) + ',' + ci2);
    S._detailMods = ns;
    renderDetailTable();
    updateDetailModInfo();
}

/**
 * 复制明细行：优先复制选中的行（可多选，一起在末尾下方复制）；
 * 未选中时复制当前高亮单元格所在行；均无时复制末尾行。
 */
function copyDetailRow() {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    if (rawType === 'object') { showToast('嵌套对象不支持多行', 'error'); return; }
    var detailRows = dt.rowGroups[ri] || [];
    if (detailRows.length === 0) { showToast('没有可复制的行', 'error'); return; }

    // 收集要复制的源行索引
    var srcIdxList = [];
    if (S._detailSel && S._detailSel.size > 0) {
        S._detailSel.forEach(function (i) { srcIdxList.push(parseInt(i, 10)); });
        srcIdxList.sort(function (a, b) { return a - b; });
    } else {
        var active = document.querySelector('#detailModalBody td.xs-editable.active');
        if (active) {
            var di = parseInt(active.getAttribute('data-drow'), 10);
            if (!isNaN(di)) srcIdxList = [di];
        }
        if (srcIdxList.length === 0) srcIdxList = [detailRows.length - 1];
    }

    var headers = dt.headers || [];
    var insertAt = detailRows.length;
    srcIdxList.forEach(function (sIdx, k) {
        if (sIdx < 0 || sIdx >= detailRows.length) return;
        var srcRow = detailRows[sIdx] || [];
        var newRow = headers.map(function (_, ci) { return srcRow[ci] !== undefined ? srcRow[ci] : ''; });
        detailRows.splice(insertAt + k, 0, newRow);
        if (dt.rawRowGroups) {
            if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
            var srcRaw = dt.rawRowGroups[ri][sIdx];
            try {
                dt.rawRowGroups[ri].splice(insertAt + k, 0, srcRaw ? JSON.parse(JSON.stringify(srcRaw)) : {});
            } catch (e) {
                dt.rawRowGroups[ri].splice(insertAt + k, 0, {});
            }
        }
        // 复制出的新行标记为已修改
        for (var ci = 0; ci < headers.length; ci++) {
            S._detailMods.add((insertAt + k) + ',' + ci);
        }
    });
    S._detailSel.clear();
    renderDetailTable();
    updateDetailModInfo();
    showToast('已复制 ' + srcIdxList.length + ' 行', 'success');
}

function insertDetailRowAt(at) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    if (!dt.rowGroups[ri]) dt.rowGroups[ri] = [];
    if (at < 0) at = 0;
    if (at > dt.rowGroups[ri].length) at = dt.rowGroups[ri].length;
    var newRow = (dt.headers || []).map(function () { return ''; });
    dt.rowGroups[ri].splice(at, 0, newRow);
    if (dt.rawRowGroups) {
        if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
        dt.rawRowGroups[ri].splice(at, 0, {});
    }
    // 修改集合的索引整体后移
    var ns = new Set();
    S._detailMods.forEach(function (k) {
        var p = k.split(','); var d = parseInt(p[0], 10); var c = parseInt(p[1], 10);
        ns.add((d >= at ? d + 1 : d) + ',' + c);
    });
    S._detailMods = ns;
    renderDetailTable();
    updateDetailModInfo();
}

function deleteDetailRow(di) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0 || !dt.rowGroups[ri]) return;
    if (di < 0 || di >= dt.rowGroups[ri].length) return;
    xsConfirm('确定删除该明细行？', function () {
        dt.rowGroups[ri].splice(di, 1);
        if (dt.rawRowGroups && dt.rawRowGroups[ri]) dt.rawRowGroups[ri].splice(di, 1);
        var ns = new Set();
        S._detailMods.forEach(function (k) {
            var p = k.split(','); var d = parseInt(p[0], 10); var c = parseInt(p[1], 10);
            if (d === di) return;
            ns.add((d > di ? d - 1 : d) + ',' + c);
        });
        S._detailMods = ns;
        renderDetailTable();
        updateDetailModInfo();
    });
}

function saveDetailModal() {
    // 同步主表显示（当前明细字段对应列显示项数/字段数）
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    pushHistory();
    if (dt && ri >= 0) {
        var headers = S.data.headers || [];
        var colIdx = headers.indexOf(dt.field);
        if (colIdx >= 0) {
            var rows = (dt.rowGroups && dt.rowGroups[ri]) || [];
            var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
            var displayText;
            if (rows.length === 0) {
                displayText = rawType === 'object' ? '{}' : '[]';
            } else if (rawType === 'object') {
                // 嵌套对象：以子表第一行的列数作为字段数
                var firstRow = rows[0] || [];
                // 实际有值的字段数（避免空字段被计入）
                var fieldCount = 0;
                firstRow.forEach(function (v) { if (v !== '' && v !== null && v !== undefined) fieldCount++; });
                if (fieldCount === 0) fieldCount = (dt.headers || []).length;
                displayText = '{' + fieldCount + ' 字段}';
            } else {
                displayText = '[' + rows.length + ' 项]';
            }
            S.data.rows[ri][colIdx] = displayText;
            S.mods.add(ri + ',' + colIdx);
        }
    }
    saveFile();
    renderTable();
    closeDetailModal(false);
    showToast('明细已保存', 'success');
}

function updateDetailModInfo() {
    var info = document.getElementById('detailModInfo');
    if (info) info.style.display = S._detailMods.size > 0 ? '' : 'none';
}

// 初始化
init();
