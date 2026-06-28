/* =============================================================================
 * 05e-array-editor.js  —— 标量数组列编辑器 + 应用 init() 启动
 * -----------------------------------------------------------------------------
 * 由原 05c-detail-modal.js 拆分而来，包含两部分：
 *
 * 1. 标量数组列（string[] / number[]）编辑弹窗
 *    - 触发：双击 chip 单元格 → openArrayCellEditor(ri, ci)
 *    - 数据流：弹窗内编辑 S._arrEdit.items（数组），保存时直接写回
 *               S.data.rows[ri][ci] 并 saveFile + patchCell；取消则丢弃。
 *    - bindArrayCellEditor / openArrayCellEditor / closeArrayCellEditor /
 *      isArrayCellEditorOpen / renderArrayCellEditor
 *    - arrEditAddItem / arrEditDeleteItem / arrEditMoveItem
 *    - _arrEditNeedsSplit / _arrEditIsValidNumber
 *
 * 2. 应用启动入口
 *    - 文件末尾的 init() 是整个 webview 的启动点。它必须放在最后一个
 *      加载的脚本里，确保前置脚本中的所有函数都已就绪。
 * ========================================================================== */

// ============================================================================
// 标量数组列（string[] / number[]）的多项编辑弹窗
// 触发：双击 chip 单元格 → openArrayCellEditor(ri, ci)
// 数据流：弹窗内编辑的是 S._arrEdit.items（数组），点保存时直接写回 S.data.rows[ri][ci]，
//        然后 saveFile + patchCell；取消则丢弃。
// ============================================================================
function bindArrayCellEditor() {
    if (S._arrEditBound) return;
    S._arrEditBound = true;
    var modal = document.getElementById('arrEditModal');
    var close = document.getElementById('arrEditClose');
    var cancel = document.getElementById('arrEditCancelBtn');
    var save = document.getElementById('arrEditSaveBtn');
    var addBtn = document.getElementById('arrEditAddBtn');
    if (close) close.addEventListener('click', function () { closeArrayCellEditor(false); });
    if (cancel) cancel.addEventListener('click', function () { closeArrayCellEditor(false); });
    if (save) save.addEventListener('click', function () { closeArrayCellEditor(true); });
    if (addBtn) addBtn.addEventListener('click', function () { arrEditAddItem(); });
    if (modal) modal.addEventListener('click', function (e) {
        if (e.target === modal) closeArrayCellEditor(false);
    });
    // ESC 关闭、Ctrl/Cmd+Enter 保存（在 body 上监听，避免与全局键冲突）
    var body = document.getElementById('arrEditBody');
    if (body) {
        body.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                closeArrayCellEditor(false);
            } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                ev.preventDefault();
                ev.stopPropagation();
                closeArrayCellEditor(true);
            }
        });
    }
}

function isArrayCellEditorOpen() {
    var m = document.getElementById('arrEditModal');
    return !!(m && m.classList.contains('show'));
}

// 打开多项编辑弹窗
function openArrayCellEditor(ri, ci) {
    var headers = (S.data && S.data.headers) || [];
    var rows = (S.data && S.data.rows) || [];
    if (ri < 0 || ri >= rows.length) return;
    if (ci < 0 || ci >= headers.length) return;
    var kind = (typeof getArrayColKind === 'function') ? getArrayColKind(ci) : null;
    if (!kind) return;
    var cur = rows[ri][ci];
    var items = Array.isArray(cur) ? cur.slice() : [];
    // 统一在弹窗内以字符串形态承载（避免 number[] 在输入过程中被强制转 NaN），保存时再按 kind 转换
    items = items.map(function (v) { return v === null || v === undefined ? '' : String(v); });
    S._arrEdit = {
        ri: ri, ci: ci, kind: kind,
        items: items,
        field: headers[ci]
    };
    bindArrayCellEditor();
    var title = document.getElementById('arrEditTitle');
    if (title) {
        var typeLabel = kind === 'number[]' ? '数字列表' : '文本列表';
        title.textContent = (S._arrEdit.field || '列表') + ' · ' + typeLabel + ' · 第 ' + (ri + 1) + ' 行';
    }
    renderArrayCellEditor();
    var m = document.getElementById('arrEditModal');
    if (m) m.classList.add('show');
    // 自动聚焦最后一个输入（或 Add 按钮）
    setTimeout(function () {
        var inputs = document.querySelectorAll('#arrEditBody .xs-arr-row-input');
        if (inputs.length > 0) {
            var el = inputs[inputs.length - 1];
            el.focus();
            try { el.select(); } catch (_) {}
        } else {
            var addBtn = document.getElementById('arrEditAddBtn');
            if (addBtn) addBtn.focus();
        }
    }, 30);
}

function renderArrayCellEditor() {
    var body = document.getElementById('arrEditBody');
    if (!body || !S._arrEdit) return;
    var items = S._arrEdit.items || [];
    var kind = S._arrEdit.kind;
    var html = '';
    if (items.length === 0) {
        html += '<div class="xs-arr-empty">暂无项目，点击下方"+ 添加项"</div>';
    } else {
        for (var i = 0; i < items.length; i++) {
            var v = items[i] == null ? '' : String(items[i]);
            var invalidCls = '';
            if (kind === 'number[]' && v.trim() !== '' && !_arrEditIsValidNumber(v)) invalidCls = ' is-invalid';
            html += '<div class="xs-arr-row" data-ii="' + i + '">'
                +     '<span class="xs-arr-row-idx">' + (i + 1) + '</span>'
                +     '<textarea class="xs-arr-row-input' + invalidCls + '" rows="1" data-ii="' + i + '"'
                +       (kind === 'number[]' ? ' inputmode="decimal"' : '')
                +       '>' + escapeHtml(v) + '</textarea>'
                +     '<div class="xs-arr-row-actions">'
                +       '<button class="xs-arr-btn-mini" data-act="up" data-ii="' + i + '" title="上移"' + (i === 0 ? ' disabled' : '') + '>▲</button>'
                +       '<button class="xs-arr-btn-mini" data-act="down" data-ii="' + i + '" title="下移"' + (i === items.length - 1 ? ' disabled' : '') + '>▼</button>'
                +     '</div>'
                +     '<span class="xs-arr-row-del" data-act="del" data-ii="' + i + '" title="删除">×</span>'
                + '</div>';
        }
    }
    var tip = '提示：粘贴多行文本会按 换行 / 分号 自动拆分为多项；';
    tip += (kind === 'number[]') ? '该列要求每项为数字。' : '';
    html += '<div class="xs-arr-tip">' + tip + ' Ctrl/⌘ + Enter 保存，Esc 取消。</div>';
    body.innerHTML = html;
    // 自适应高度
    body.querySelectorAll('textarea.xs-arr-row-input').forEach(function (ta) {
        autoGrowTextarea(ta);
        ta.addEventListener('input', function () {
            var ii = parseInt(ta.getAttribute('data-ii'), 10);
            if (isNaN(ii)) return;
            // 多行粘贴自动拆分：仅当当前框为空且粘贴内容含换行/分号时触发
            var raw = ta.value;
            if (raw && (raw.indexOf('\n') >= 0 || raw.indexOf(';') >= 0) && _arrEditNeedsSplit(raw)) {
                var parts = raw.split(/\n+|;\s*/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
                if (parts.length >= 2) {
                    var first = parts.shift();
                    S._arrEdit.items[ii] = first;
                    // 把剩余项插入到当前项之后
                    Array.prototype.splice.apply(S._arrEdit.items, [ii + 1, 0].concat(parts));
                    renderArrayCellEditor();
                    // 聚焦到最后插入的项
                    setTimeout(function () {
                        var inputs = document.querySelectorAll('#arrEditBody .xs-arr-row-input');
                        var t = inputs[ii + parts.length];
                        if (t) t.focus();
                    }, 0);
                    return;
                }
            }
            S._arrEdit.items[ii] = raw;
            autoGrowTextarea(ta);
            // 数字列实时校验视觉反馈
            if (kind === 'number[]') {
                if (raw.trim() !== '' && !_arrEditIsValidNumber(raw)) ta.classList.add('is-invalid');
                else ta.classList.remove('is-invalid');
            }
        });
        // Enter 在末尾换行/添加新项，Shift+Enter 强制换行
        ta.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
                ev.preventDefault();
                var ii = parseInt(ta.getAttribute('data-ii'), 10);
                if (!isNaN(ii)) arrEditAddItem(ii + 1);
            }
        });
    });
    body.querySelectorAll('.xs-arr-row-del').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var ii = parseInt(btn.getAttribute('data-ii'), 10);
            if (!isNaN(ii)) arrEditDeleteItem(ii);
        });
    });
    body.querySelectorAll('.xs-arr-btn-mini').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var ii = parseInt(btn.getAttribute('data-ii'), 10);
            var act = btn.getAttribute('data-act');
            if (isNaN(ii)) return;
            if (act === 'up' && ii > 0) arrEditMoveItem(ii, ii - 1);
            else if (act === 'down' && ii < (S._arrEdit.items.length - 1)) arrEditMoveItem(ii, ii + 1);
        });
    });
}

// 判断粘贴内容是否值得整体拆分：用户在已有项基础上手敲 ; 不应被拆
// 简化策略：只有当文本 split 后≥2 项，且当前 items 长度 < split 后总数，才认为是粘贴
function _arrEditNeedsSplit(text) {
    var parts = text.split(/\n+|;\s*/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
    return parts.length >= 2;
}

function _arrEditIsValidNumber(s) {
    var t = String(s).trim();
    if (t === '') return false;
    return !Number.isNaN(Number(t)) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t);
}

function arrEditAddItem(at) {
    if (!S._arrEdit) return;
    var idx = (typeof at === 'number') ? at : S._arrEdit.items.length;
    if (idx < 0) idx = 0;
    if (idx > S._arrEdit.items.length) idx = S._arrEdit.items.length;
    S._arrEdit.items.splice(idx, 0, '');
    renderArrayCellEditor();
    setTimeout(function () {
        var inputs = document.querySelectorAll('#arrEditBody .xs-arr-row-input');
        var el = inputs[idx];
        if (el) el.focus();
    }, 0);
}

function arrEditDeleteItem(ii) {
    if (!S._arrEdit) return;
    if (ii < 0 || ii >= S._arrEdit.items.length) return;
    S._arrEdit.items.splice(ii, 1);
    renderArrayCellEditor();
}

function arrEditMoveItem(from, to) {
    if (!S._arrEdit) return;
    var items = S._arrEdit.items;
    if (from < 0 || from >= items.length || to < 0 || to >= items.length) return;
    var v = items.splice(from, 1)[0];
    items.splice(to, 0, v);
    renderArrayCellEditor();
    setTimeout(function () {
        var inputs = document.querySelectorAll('#arrEditBody .xs-arr-row-input');
        var el = inputs[to];
        if (el) el.focus();
    }, 0);
}

function closeArrayCellEditor(commit) {
    var modal = document.getElementById('arrEditModal');
    if (!S._arrEdit) {
        if (modal) modal.classList.remove('show');
        return;
    }
    if (commit) {
        var ri = S._arrEdit.ri;
        var ci = S._arrEdit.ci;
        var kind = S._arrEdit.kind;
        // 过滤：去掉首尾空白都为空的项？保留用户原意更安全——只丢全空白项？
        // 用户可能确实需要保留空字符串 → 保留所有项；但 number[] 列里非法/空值会被丢弃
        var raw = (S._arrEdit.items || []).map(function (s) { return s == null ? '' : String(s); });
        var out;
        if (kind === 'number[]') {
            // 非法项给提示并阻止保存
            for (var k = 0; k < raw.length; k++) {
                if (raw[k].trim() === '') continue; // 允许空字符串占位？数字列不允许：直接当成空 → 报错
                if (!_arrEditIsValidNumber(raw[k])) {
                    showToast('第 ' + (k + 1) + ' 项不是合法数字，请修正后再保存', 'error');
                    return;
                }
            }
            out = raw.filter(function (x) { return x.trim() !== ''; }).map(function (x) { return Number(x.trim()); });
        } else {
            // string[] 列：保留用户输入内容；去除两侧空白？这里保守不修剪，避免破坏原意
            out = raw;
        }
        // 只有内容确实变更才落盘
        var prev = S.data.rows[ri][ci];
        var prevStr = Array.isArray(prev) ? formatCellValue(prev) : (prev == null ? '' : String(prev));
        var newStr = formatCellValue(out);
        if (prevStr !== newStr) {
            pushHistory();
            S.data.rows[ri][ci] = out;
            S.mods.add(ri + ',' + ci);
            saveFile();
            patchCell(ri, ci);
            showToast('已保存', 'success');
        }
    }
    if (modal) modal.classList.remove('show');
    S._arrEdit = null;
}

// ESC 在多项编辑弹窗打开时优先关闭它
(function _wrapEscForArrEdit() {
    // 复用全局 keydown：在 bindDocument 已存在的监听里追加判断；这里用 capture 阶段保证优先
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (isArrayCellEditorOpen()) {
            e.preventDefault();
            e.stopPropagation();
            closeArrayCellEditor(false);
        }
    }, true);
})();

// 初始化
init();
