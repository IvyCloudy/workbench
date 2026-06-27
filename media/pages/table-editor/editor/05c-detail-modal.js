/* =============================================================================
 * 05c-detail-modal.js  —— 明细弹窗（v2 双栏）+ 数组列编辑器 + init() 启动
 * -----------------------------------------------------------------------------
 * 由原 05-modals.js 拆分而来，包含两个独立弹窗 + 应用启动入口：
 *
 * 1. 步骤明细弹窗（v2 双栏布局）
 *    - 入口：bindDetailModal / openDetailModal / closeDetailModal
 *    - 数据：getDetailTables / getDetailTableByField / getDetailTableByCol /
 *            getCurrentDetailTable / isDetailColumn / hasDetailRows / hasDetailRowsAtCol
 *    - v2 渲染：renderDetailV2 / renderDv2FieldCard / bindDv2Events /
 *               autoGrowTextarea / autoGrowAllTextareas
 *    - v2 写：dv2GetActiveRaw / dv2WriteScalar / dv2WriteArrayItem /
 *             dv2AddArrayItem / dv2DeleteArrayItem / dv2AddStep / dv2DuplicateStep / dv2DeleteStep /
 *             markActiveStepModified / saveDetailModal / updateDetailModInfo
 *
 * 2. 标量数组列编辑器（双击 string[] / number[] 类型 chip 单元格触发）
 *    - bindArrayCellEditor / openArrayCellEditor / closeArrayCellEditor /
 *      isArrayCellEditorOpen
 *
 * 3. 应用启动：文件末尾的 init() 是整个 webview 的启动点，前面所有脚本加载完毕
 *    后这里调用 init() 才能保证全部依赖函数已就绪。
 * ========================================================================== */

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
// 兼容空对象/空数组占位（{} / []）：右键插入新行时，明细列会被设置为占位字符串，
// 此时 rowGroups/rawRowGroups 都为空数组，但仍应展示为可点击链接（点击后弹窗里可新建步骤/字段）
function hasDetailRowsAtCol(ri, ci) {
    var dt = getDetailTableByCol(ci);
    if (!dt || !dt.rowGroups) return false;
    var g = dt.rowGroups[ri];
    if (Array.isArray(g) && g.length > 0) return true;
    // 主表单元格是 '[]' / '{}' 占位时也视为 detail：让用户能点开弹窗编辑
    var rows = (S.data && S.data.rows) || [];
    var row = rows[ri];
    if (!row) return false;
    var v = row[ci];
    if (v === '[]' || v === '{}') return true;
    return false;
}

function isDetailModalOpen() {
    var m = document.getElementById('detailModal');
    return !!(m && m.classList.contains('show'));
}

function bindDetailModal() {
    if (S._detailBound) return;
    S._detailBound = true;
    var close = document.getElementById('detailModalClose');
    var cancel = document.getElementById('detailCancelBtn');
    var save = document.getElementById('detailSaveBtn');
    if (close) close.addEventListener('click', closeDetailModal);
    if (cancel) cancel.addEventListener('click', closeDetailModal);
    if (save) save.addEventListener('click', saveDetailModal);
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

    // 快照备份（取消时还原）
    try {
        S._detailBackup = {
            rows: JSON.parse(JSON.stringify(dt.rowGroups[ri] || [])),
            raws: dt.rawRowGroups ? JSON.parse(JSON.stringify(dt.rawRowGroups[ri] || [])) : null
        };
    } catch (err) {
        S._detailBackup = null;
    }

    // 初始化 v2 状态（当前选中的 step 索引 + 修改集合）
    var rows = dt.rowGroups[ri] || [];
    S._dv2ActiveStep = rows.length > 0 ? 0 : -1;
    S._dv2StepMods = new Set();

    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    var title = document.getElementById('detailModalTitle');
    if (title) {
        var typeTag = rawType === 'object' ? '（嵌套对象）' : '';
        // 标题字段名：优先使用中文映射，再退回 fieldDisplay/field
        var _labels = (S && S.headerLabels) || {};
        var _fieldKey = dt.field || '';
        var _cn = _labels[String(_fieldKey)];
        var _baseTitle;
        if (_cn && typeof _cn === 'string') {
            _baseTitle = _cn + '（' + _fieldKey + '）';
        } else {
            _baseTitle = dt.fieldDisplay || _fieldKey || '明细';
        }
        title.textContent = _baseTitle + typeTag + ' - 第 ' + (ri + 1) + ' 行';
    }
    bindDetailModal();
    renderDetailV2();
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
        // 还原快照（取消时丢弃本次修改）
        if (S._detailBackup.rows) dt.rowGroups[ri] = S._detailBackup.rows;
        if (dt.rawRowGroups && S._detailBackup.raws) dt.rawRowGroups[ri] = S._detailBackup.raws;
    }
    var m = document.getElementById('detailModal');
    if (m) m.classList.remove('show');
    S._detailField = '';
    S._detailRowIdx = -1;
    if (S._detailMods) S._detailMods.clear();
    if (S._detailSel) S._detailSel.clear();
    S._detailBackup = null;
    // v2 状态重置
    S._dv2ActiveStep = -1;
    S._dv2StepMods = new Set();
}

/* ============================================================================
 *  明细弹窗 v2：双栏布局（步骤列表 + 字段卡片）
 *  数据模型：
 *    - dt.rawRowGroups[ri]  ：原始 step 对象数组（保留字段顺序与未在表头里的扩展字段）
 *    - dt.headers           ：表头并集（仅用于"字段卡片"渲染顺序兜底）
 *    - dt.rowGroups[ri]     ：兼容旧版的字符串二维结构，仅用于主表展示同步
 *  编辑路径：
 *    - 标量字段（id/operation 等字符串）  ：直接读写 rawRowGroups[ri][di][field]
 *    - 数组字段（data/ui-expected 等）   ：每项独立 textarea，写回真实 array
 *    - "原样写回"由 yaml-parser.coerceValue 在保存时通过类型嗅探完成
 *  保存时 saveDetailModal 会从 rawRowGroups 反向重建 rowGroups 字符串结构，
 *  以兼容主表显示与历史 reconstructDetail 的回写路径。
 * ========================================================================= */

// 推断字段在当前 step 上的展示形态：'array' | 'object' | 'scalar'
function dv2DetectKind(rawObj, field) {
    if (!rawObj || typeof rawObj !== 'object') return 'scalar';
    var v = rawObj[field];
    if (Array.isArray(v)) return 'array';
    if (v && typeof v === 'object') return 'object';
    return 'scalar';
}

// 取一个 step 上所有要展示的字段顺序：原始对象 key 顺序优先 + 缺失的表头字段补在末尾
function dv2FieldOrder(rawObj, headers) {
    var arr = [];
    var seen = new Set();
    if (rawObj && typeof rawObj === 'object') {
        Object.keys(rawObj).forEach(function (k) { arr.push(k); seen.add(k); });
    }
    (headers || []).forEach(function (h) { if (!seen.has(h)) { arr.push(h); seen.add(h); } });
    return arr;
}

// 步骤列表显示文本：优先 operation，其次 name/id，否则"步骤 N"
function dv2StepLabel(rawObj, di) {
    if (rawObj && typeof rawObj === 'object') {
        if (rawObj.operation) return String(rawObj.operation);
        if (rawObj.name) return String(rawObj.name);
        if (rawObj.id) return String(rawObj.id);
    }
    return '步骤 ' + (di + 1);
}

function dv2StepSubLabel(rawObj) {
    if (rawObj && typeof rawObj === 'object' && rawObj.id && rawObj.operation) {
        return String(rawObj.id);
    }
    return '';
}

function renderDetailV2() {
    var body = document.getElementById('detailModalBody');
    var dt = getCurrentDetailTable();
    if (!body || !dt) return;
    var ri = S._detailRowIdx;
    var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
    var rawRows = (dt.rawRowGroups && dt.rawRowGroups[ri]) || [];

    // 嵌套对象类型：当作只有一条 step 的特例。
    // 当行刚被插入、rawRowGroups 为空时，左侧不渲染"+ 添加步骤"按钮（嵌套对象固定 1 条），
    // 用户会卡死无法进入编辑。这里按字段骨架自动补一条空对象，并标记为已修改以便保存写回。
    if (rawType === 'object' && rawRows.length === 0) {
        if (!dt.rawRowGroups) dt.rawRowGroups = [];
        if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
        var seedObj = {};
        (dt.headers || []).forEach(function (h) {
            var kind = _inferDetailFieldKind(dt, h);
            if (kind === 'array') seedObj[h] = [];
            else if (kind === 'object') seedObj[h] = {};
            else seedObj[h] = '';
        });
        dt.rawRowGroups[ri].push(seedObj);
        rawRows = dt.rawRowGroups[ri];
        if (!S._dv2StepMods) S._dv2StepMods = new Set();
        S._dv2StepMods.add(0);
    }

    var stepCount = rawRows.length;
    if (S._dv2ActiveStep == null || S._dv2ActiveStep < 0 || S._dv2ActiveStep >= stepCount) {
        S._dv2ActiveStep = stepCount > 0 ? 0 : -1;
    }

    var html = '';
    // ===== 左栏：步骤列表 =====
    html += '<div class="xs-dv2-left">';
    html += '<div class="xs-dv2-left-hd">'
        +     '<span class="xs-dv2-left-hd-title">' + (rawType === 'object' ? '对象' : '步骤列表') + '</span>'
        +     '<span class="xs-dv2-left-hd-count">共 ' + stepCount + ' 项</span>'
        +   '</div>';
    html += '<div class="xs-dv2-steps" id="dv2Steps">';
    if (stepCount === 0) {
        html += '<div class="xs-dv2-empty" style="padding:24px 12px;font-size:12px">暂无步骤<br>点击下方"+ 添加步骤"</div>';
    } else {
        rawRows.forEach(function (row, di) {
            var label = dv2StepLabel(row, di);
            var sub = dv2StepSubLabel(row);
            var modCls = (S._dv2StepMods && S._dv2StepMods.has(di)) ? ' modified' : '';
            var actCls = (di === S._dv2ActiveStep) ? ' active' : '';
            html += '<div class="xs-dv2-step' + actCls + modCls + '" data-di="' + di + '">'
                +     '<span class="xs-dv2-step-num">' + (di + 1) + '</span>'
                +     '<span class="xs-dv2-step-text" title="' + escapeHtml(label) + '">' + escapeHtml(label)
                +       (sub ? ' <span class="xs-dv2-step-id">(' + escapeHtml(sub) + ')</span>' : '')
                +     '</span>';
            if (rawType !== 'object') {
                html += '<span class="xs-dv2-step-del" title="删除该步骤" data-di="' + di + '">×</span>';
            }
            html += '</div>';
        });
    }
    html += '</div>'; // /.xs-dv2-steps
    if (rawType !== 'object') {
        html += '<div class="xs-dv2-left-ft">'
            +     '<button class="xs-btn" id="dv2BtnAdd" title="在末尾添加新步骤">+ 添加步骤</button>'
            +     '<button class="xs-btn" id="dv2BtnDup" title="复制当前步骤">复制</button>'
            +   '</div>';
    }
    html += '</div>'; // /.xs-dv2-left

    // ===== 右栏：字段卡片 =====
    html += '<div class="xs-dv2-right" id="dv2Right">';
    var di = S._dv2ActiveStep;
    if (di < 0 || di >= rawRows.length) {
        html += '<div class="xs-dv2-empty">请选择左侧步骤进行编辑</div>';
    } else {
        var rawObj = rawRows[di] || {};
        var fields = dv2FieldOrder(rawObj, dt.headers);
        fields.forEach(function (field) {
            var kind = dv2DetectKind(rawObj, field);
            // object 子结构暂以 JSON 串展示（罕见场景，沿用旧行为）
            if (kind === 'object') {
                var jsonStr = '';
                try { jsonStr = JSON.stringify(rawObj[field], null, 2); } catch (_) { jsonStr = String(rawObj[field] || ''); }
                html += renderDv2FieldCard(field, 'object',
                    '<textarea class="xs-dv2-scalar" data-field="' + escapeHtml(field) + '" data-kind="object" rows="4">' + escapeHtml(jsonStr) + '</textarea>');
                return;
            }
            if (kind === 'array') {
                var arr = Array.isArray(rawObj[field]) ? rawObj[field] : [];
                var inner = '';
                if (arr.length === 0) {
                    inner += '<div class="xs-dv2-arr-empty">空数组，点击右上"+ 添加项"</div>';
                } else {
                    arr.forEach(function (item, ii) {
                        var text = (item == null) ? '' : (typeof item === 'object' ? JSON.stringify(item) : String(item));
                        inner += '<div class="xs-dv2-arr-item" data-field="' + escapeHtml(field) + '" data-ii="' + ii + '">'
                            +      '<span class="xs-dv2-arr-idx">' + (ii + 1) + '</span>'
                            +      '<textarea class="xs-dv2-arr-input" data-field="' + escapeHtml(field) + '" data-ii="' + ii + '" rows="1">' + escapeHtml(text) + '</textarea>'
                            +      '<span class="xs-dv2-arr-del" title="删除该项" data-field="' + escapeHtml(field) + '" data-ii="' + ii + '">×</span>'
                            +    '</div>';
                    });
                }
                html += renderDv2FieldCard(field, 'array', inner, true);
                return;
            }
            // scalar
            var v = rawObj[field];
            var text = (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
            html += renderDv2FieldCard(field, 'scalar',
                '<textarea class="xs-dv2-scalar" data-field="' + escapeHtml(field) + '" data-kind="scalar" rows="1">' + escapeHtml(text) + '</textarea>'
            );
        });
    }
    html += '</div>'; // /.xs-dv2-right

    body.innerHTML = html;
    bindDv2Events();
    autoGrowAllTextareas();
}

function renderDv2FieldCard(field, kind, innerHtml, withAddBtn) {
    var typeLabel = (kind === 'array') ? '数组' : (kind === 'object' ? '对象' : '文本');
    var typeCls = (kind === 'array') ? 'is-array' : '';
    var actions = '';
    if (withAddBtn) {
        actions = '<div class="xs-dv2-field-actions">'
            +       '<button class="xs-dv2-field-add" data-field="' + escapeHtml(field) + '">+ 添加项</button>'
            +     '</div>';
    }
    // 字段名：存在中文映射时第一行渲染中文（主），第二行渲染英文 key（辅，等宽小字）；
    //         无映射时仅渲染英文 key 单行，避免空白占位。
    var labels = (S && S.headerLabels) || {};
    var cnLabel = labels[String(field)];
    var hasCn = !!(cnLabel && typeof cnLabel === 'string');
    var titleAttr = hasCn ? (cnLabel + ' (' + field + ')') : field;
    var nameHtml;
    if (hasCn) {
        nameHtml = '<span class="xs-dv2-field-name has-cn" title="' + escapeHtml(titleAttr) + '">'
            +       '<span class="xs-dv2-field-name-cn">' + escapeHtml(cnLabel) + '</span>'
            +       '<span class="xs-dv2-field-name-key">' + escapeHtml(field) + '</span>'
            +     '</span>';
    } else {
        nameHtml = '<span class="xs-dv2-field-name" title="' + escapeHtml(titleAttr) + '">' + escapeHtml(field) + '</span>';
    }
    return '<div class="xs-dv2-field" data-field="' + escapeHtml(field) + '">'
        +    '<div class="xs-dv2-field-hd">'
        +      nameHtml
        +      '<span class="xs-dv2-field-type ' + typeCls + '">' + typeLabel + '</span>'
        +      actions
        +    '</div>'
        +    '<div class="xs-dv2-field-body">' + innerHtml + '</div>'
        +  '</div>';
}

function bindDv2Events() {
    var body = document.getElementById('detailModalBody');
    if (!body) return;
    // 步骤列表禁用右键菜单（阻止冒泡到主表的 contextmenu）
    var leftCol = body.querySelector('.xs-dv2-left');
    if (leftCol) {
        leftCol.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        });
    }
    // 左栏：切换步骤
    body.querySelectorAll('.xs-dv2-step').forEach(function (el) {
        el.addEventListener('click', function (ev) {
            // 点击删除按钮时不切换
            if (ev.target && ev.target.classList && ev.target.classList.contains('xs-dv2-step-del')) return;
            var di = parseInt(el.getAttribute('data-di'), 10);
            if (!isNaN(di)) { S._dv2ActiveStep = di; renderDetailV2(); }
        });
    });
    // 左栏：删除步骤
    body.querySelectorAll('.xs-dv2-step-del').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var di = parseInt(btn.getAttribute('data-di'), 10);
            if (!isNaN(di)) dv2DeleteStep(di);
        });
    });
    // 左栏：添加 / 复制
    var addBtn = document.getElementById('dv2BtnAdd');
    if (addBtn) addBtn.addEventListener('click', function () { dv2AddStep(); });
    var dupBtn = document.getElementById('dv2BtnDup');
    if (dupBtn) dupBtn.addEventListener('click', function () { dv2DuplicateStep(); });

    // 右栏：标量 / 对象编辑
    body.querySelectorAll('textarea.xs-dv2-scalar').forEach(function (ta) {
        ta.addEventListener('input', function () {
            autoGrowTextarea(ta);
        });
        ta.addEventListener('change', function () {
            dv2WriteScalar(ta.getAttribute('data-field'), ta.value, ta.getAttribute('data-kind'));
            ta.classList.add('modified');
            markActiveStepModified();
            updateDetailModInfo();
        });
        ta.addEventListener('blur', function () {
            dv2WriteScalar(ta.getAttribute('data-field'), ta.value, ta.getAttribute('data-kind'));
        });
    });
    // 右栏：数组项编辑
    body.querySelectorAll('textarea.xs-dv2-arr-input').forEach(function (ta) {
        ta.addEventListener('input', function () { autoGrowTextarea(ta); });
        ta.addEventListener('change', function () {
            var f = ta.getAttribute('data-field');
            var ii = parseInt(ta.getAttribute('data-ii'), 10);
            dv2WriteArrayItem(f, ii, ta.value);
            ta.classList.add('modified');
            markActiveStepModified();
            updateDetailModInfo();
        });
        ta.addEventListener('blur', function () {
            var f = ta.getAttribute('data-field');
            var ii = parseInt(ta.getAttribute('data-ii'), 10);
            dv2WriteArrayItem(f, ii, ta.value);
        });
    });
    // 右栏：删除数组项
    body.querySelectorAll('.xs-dv2-arr-del').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var f = btn.getAttribute('data-field');
            var ii = parseInt(btn.getAttribute('data-ii'), 10);
            if (!isNaN(ii)) dv2DeleteArrayItem(f, ii);
        });
    });
    // 右栏：添加数组项
    body.querySelectorAll('.xs-dv2-field-add').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var f = btn.getAttribute('data-field');
            dv2AddArrayItem(f);
        });
    });
}

function autoGrowTextarea(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    var h = ta.scrollHeight;
    // 限制最大高度，超出由 textarea 自身滚动
    var max = 240;
    ta.style.height = Math.min(h, max) + 'px';
    if (h > max) ta.style.overflowY = 'auto'; else ta.style.overflowY = 'hidden';
}
function autoGrowAllTextareas() {
    var body = document.getElementById('detailModalBody');
    if (!body) return;
    body.querySelectorAll('textarea').forEach(function (ta) { autoGrowTextarea(ta); });
}

// 当前活动 step 的 raw 对象引用（不存在时按需新建）
function dv2GetActiveRaw() {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return null;
    if (!dt.rawRowGroups) dt.rawRowGroups = [];
    if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
    var di = S._dv2ActiveStep;
    if (di == null || di < 0) return null;
    if (!dt.rawRowGroups[ri][di]) dt.rawRowGroups[ri][di] = {};
    return dt.rawRowGroups[ri][di];
}

function markActiveStepModified() {
    if (!S._dv2StepMods) S._dv2StepMods = new Set();
    if (S._dv2ActiveStep != null && S._dv2ActiveStep >= 0) S._dv2StepMods.add(S._dv2ActiveStep);
    // 同步更新左栏指示点（避免整体重渲染丢失输入焦点）
    var stepEl = document.querySelector('.xs-dv2-step[data-di="' + S._dv2ActiveStep + '"]');
    if (stepEl) stepEl.classList.add('modified');
}

// 取该 step 上某字段在原始文件里的"参考类型样本"
//   - scalar 字段：返回原始标量值
//   - array 字段（取数组项类型时）：返回 arr[ii] ?? arr[0]
// 用于 dv2WriteScalar / dv2WriteArrayItem 做类型还原，避免数字/布尔被引号化
function dv2GetOrigSample(field, isArrayItem, ii) {
    if (!S._detailBackup || !S._detailBackup.raws) return undefined;
    var di = S._dv2ActiveStep;
    if (di == null || di < 0) return undefined;
    var origStep = S._detailBackup.raws[di];
    if (!origStep || typeof origStep !== 'object') return undefined;
    var origVal = origStep[field];
    if (!isArrayItem) return origVal;
    if (!Array.isArray(origVal)) return undefined;
    if (ii != null && ii >= 0 && ii < origVal.length) return origVal[ii];
    // 数组追加新项 / 越界：参考首个有意义的样本，推断该数组的元素类型
    for (var k = 0; k < origVal.length; k++) {
        if (origVal[k] !== null && origVal[k] !== undefined && origVal[k] !== '') return origVal[k];
    }
    return undefined;
}

// 按原始样本类型，把弹窗里的字符串值还原为原类型；未知类型保留字符串
function dv2CoerceScalar(value, sample) {
    if (typeof sample === 'number') {
        if (value === '' || value == null) return null;
        var s = String(value).trim();
        // 仅当看起来确实是数字时才转换，否则原样保留（用户可能改成了非数字）
        if (s !== '' && !isNaN(Number(s)) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
            return Number(s);
        }
        return value;
    }
    if (typeof sample === 'boolean') {
        if (value === true || value === false) return value;
        var t = String(value).trim().toLowerCase();
        if (t === 'true') return true;
        if (t === 'false') return false;
        return value;
    }
    if (sample === null) {
        if (value === '' || value == null) return null;
        return value;
    }
    // 字符串 / undefined / 其它：原样字符串
    return value;
}

function dv2WriteScalar(field, value, kind) {
    var raw = dv2GetActiveRaw();
    if (!raw || !field) return;
    if (kind === 'object') {
        // 嵌套对象：尝试 JSON 解析；失败则原样保留字符串
        if (value === '' || value == null) { raw[field] = null; return; }
        try { raw[field] = JSON.parse(value); }
        catch (_) { raw[field] = value; }
        return;
    }
    // 按原始样本类型还原（数字/布尔/null），避免数字字段被引号化
    var sample = dv2GetOrigSample(field, false);
    raw[field] = dv2CoerceScalar(value, sample);
}

function dv2WriteArrayItem(field, ii, value) {
    var raw = dv2GetActiveRaw();
    if (!raw || !field || isNaN(ii)) return;
    if (!Array.isArray(raw[field])) raw[field] = [];
    var sample = dv2GetOrigSample(field, true, ii);
    raw[field][ii] = dv2CoerceScalar(value, sample);
}

function dv2AddArrayItem(field) {
    var raw = dv2GetActiveRaw();
    if (!raw || !field) return;
    if (!Array.isArray(raw[field])) raw[field] = [];
    raw[field].push('');
    markActiveStepModified();
    renderDetailV2();
    // 聚焦到新加的项
    setTimeout(function () {
        var sel = '.xs-dv2-arr-input[data-field="' + field + '"][data-ii="' + (raw[field].length - 1) + '"]';
        var el = document.querySelector(sel);
        if (el) el.focus();
    }, 30);
}

function dv2DeleteArrayItem(field, ii) {
    var raw = dv2GetActiveRaw();
    if (!raw || !field || isNaN(ii)) return;
    if (!Array.isArray(raw[field])) return;
    raw[field].splice(ii, 1);
    markActiveStepModified();
    renderDetailV2();
}

// 推断明细表中"某字段在跨行/跨步骤的主流类型"：扫描所有行/所有 step 的真实值，
// 任一处出现 array → 返回 'array'；否则任一处出现 object → 返回 'object'；
// 其余情况（包括字段从未出现过）→ 返回 'scalar'。
// 用于：新 step 按该类型给默认值（数组→[]、对象→{}、标量→''），与其他行/步骤保持类型一致。
function _inferDetailFieldKind(dt, field) {
    if (!dt || !field) return 'scalar';
    var raws = dt.rawRowGroups || [];
    var sawObject = false;
    for (var ri = 0; ri < raws.length; ri++) {
        var grp = raws[ri];
        if (!Array.isArray(grp)) continue;
        for (var di = 0; di < grp.length; di++) {
            var step = grp[di];
            if (!step || typeof step !== 'object') continue;
            if (!Object.prototype.hasOwnProperty.call(step, field)) continue;
            var v = step[field];
            if (Array.isArray(v)) return 'array';
            if (v && typeof v === 'object') sawObject = true;
        }
    }
    return sawObject ? 'object' : 'scalar';
}

function dv2AddStep() {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    if ((dt.rawRowTypes && dt.rawRowTypes[ri]) === 'object') { showToast('嵌套对象不支持多步骤', 'error'); return; }
    if (!dt.rawRowGroups) dt.rawRowGroups = [];
    if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
    // 以 schema headers 作为新 step 的字段骨架；
    // 字段默认值按"全表跨行/跨步骤推断"的列级类型给：array→[]、object→{}、其余→''。
    // 这样新加 step 的 data 等数组字段就不会被初始化为空字符串，
    // 保存为 yaml 时与其他行的类型保持一致（避免类型漂移）。
    var newStep = {};
    (dt.headers || []).forEach(function (h) {
        var kind = _inferDetailFieldKind(dt, h);
        if (kind === 'array') newStep[h] = [];
        else if (kind === 'object') newStep[h] = {};
        else newStep[h] = '';
    });
    dt.rawRowGroups[ri].push(newStep);
    S._dv2ActiveStep = dt.rawRowGroups[ri].length - 1;
    if (!S._dv2StepMods) S._dv2StepMods = new Set();
    S._dv2StepMods.add(S._dv2ActiveStep);
    renderDetailV2();
    updateDetailModInfo();
}

function dv2DuplicateStep() {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    if ((dt.rawRowTypes && dt.rawRowTypes[ri]) === 'object') { showToast('嵌套对象不支持多步骤', 'error'); return; }
    var rows = (dt.rawRowGroups && dt.rawRowGroups[ri]) || [];
    var src = (S._dv2ActiveStep != null && S._dv2ActiveStep >= 0) ? rows[S._dv2ActiveStep] : null;
    if (!src) { showToast('请先选择要复制的步骤', 'error'); return; }
    var clone;
    try { clone = JSON.parse(JSON.stringify(src)); } catch (_) { clone = {}; }
    rows.splice(S._dv2ActiveStep + 1, 0, clone);
    // 修改集合：所有 > 当前 的索引整体后移，并把新行标记为已修改
    if (!S._dv2StepMods) S._dv2StepMods = new Set();
    var ns = new Set();
    S._dv2StepMods.forEach(function (k) { ns.add(k > S._dv2ActiveStep ? k + 1 : k); });
    ns.add(S._dv2ActiveStep + 1);
    S._dv2StepMods = ns;
    S._dv2ActiveStep = S._dv2ActiveStep + 1;
    renderDetailV2();
    updateDetailModInfo();
}

function dv2DeleteStep(di) {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) return;
    var rows = (dt.rawRowGroups && dt.rawRowGroups[ri]) || [];
    if (di < 0 || di >= rows.length) return;
    xsConfirm('确定删除该步骤？', function () {
        rows.splice(di, 1);
        // 修改集合索引整体前移
        if (!S._dv2StepMods) S._dv2StepMods = new Set();
        var ns = new Set();
        S._dv2StepMods.forEach(function (k) {
            if (k === di) return;
            ns.add(k > di ? k - 1 : k);
        });
        ns.add(-1); // 标记发生过结构性变更
        S._dv2StepMods = ns;
        if (S._dv2ActiveStep === di) {
            S._dv2ActiveStep = Math.min(di, rows.length - 1);
        } else if (S._dv2ActiveStep > di) {
            S._dv2ActiveStep = S._dv2ActiveStep - 1;
        }
        renderDetailV2();
        updateDetailModInfo();
    });
}

function saveDetailModal() {
    var dt = getCurrentDetailTable();
    var ri = S._detailRowIdx;
    if (!dt || ri < 0) { closeDetailModal(false); return; }

    // 0) 检测是否有实际内容变更，避免"未修改但被标记为已修改"的假阳性
    var rawRows = (dt.rawRowGroups && dt.rawRowGroups[ri]) || [];
    var backupRaws = (S._detailBackup && S._detailBackup.raws) || null;
    if (backupRaws) {
        // 快检：_dv2StepMods 通过 textarea change 事件记录用户编辑过哪些步骤；
        //       若 size===0 说明弹窗内完全未操作 → 无变更
        if (S._dv2StepMods && S._dv2StepMods.size === 0) {
            closeDetailModal(false);
            return;
        }
        // 深度比对：即使 change 事件触发过（用户输入后又删回原值），
        //           JSON 序列化比对能准确判断 rawRows 是否真的变了
        try {
            if (JSON.stringify(rawRows) === JSON.stringify(backupRaws)) {
                closeDetailModal(false);
                return;
            }
        } catch (_) { /* 序列化异常时保守处理，继续执行保存 */ }
    }
    pushHistory();

    // 1) 从 rawRowGroups 反向同步 rowGroups（字符串二维结构，兼容主表显示路径）
    rawRows = (dt.rawRowGroups && dt.rawRowGroups[ri]) || [];
    var headers = dt.headers || [];
    var newRowGroup = rawRows.map(function (raw) {
        return headers.map(function (h) {
            var v = raw ? raw[h] : undefined;
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
    if (!dt.rowGroups) dt.rowGroups = [];
    dt.rowGroups[ri] = newRowGroup;

    // 2) 同步主表显示：当前明细字段对应列展示项数/字段数
    var mainHeaders = (S.data && S.data.headers) || [];
    var colIdx = mainHeaders.indexOf(dt.field);
    var displayText = '';
    if (colIdx >= 0) {
        var rawType = (dt.rawRowTypes && dt.rawRowTypes[ri]) || 'array';
        if (rawRows.length === 0) {
            displayText = rawType === 'object' ? '{}' : '[]';
        } else if (rawType === 'object') {
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
        // 关键：把新 displayText 写回主表 S.data.rows，
        // 否则 renderTable() 仍会用旧值渲染，导致用户在弹窗中"添加项/删除项"后
        // 主表对应单元格的项数不刷新（例如保持旧的 "[2 项]"，新增后未变成 "[3 项]"）。
        if (S.data && Array.isArray(S.data.rows)
            && S.data.rows[ri] && colIdx < S.data.rows[ri].length) {
            S.data.rows[ri][colIdx] = displayText;
        }
        S.mods.add(ri + ',' + colIdx);
        S._detailModCellKeys.add(ri + ',' + colIdx);
    }

    // 3) 落盘：diffPushSnapshot 已通过 detailTables.rawRowGroups 签名比对明细变更，
    //    不再需要临时替换单元格值为 JSON。直接发送 displayText（如 "[2 项]"），
    //    避免 JSON 串回流污染前端 S.data 的语义一致性。
    saveFile();
    renderTable();
    closeDetailModal(false);
    showToast('明细已保存', 'success');
}

function updateDetailModInfo() {
    var info = document.getElementById('detailModInfo');
    if (!info) return;
    var changed = (S._dv2StepMods && S._dv2StepMods.size > 0) || (S._detailMods && S._detailMods.size > 0);
    info.style.display = changed ? '' : 'none';
}

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
