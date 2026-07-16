/* =============================================================================
 * 05c-detail-modal.js  —— 明细弹窗（v2 双栏）主体 + 渲染
 * -----------------------------------------------------------------------------
 * 由原 05c-detail-modal.js（1076 行）拆分而来，保留弹窗"读"侧逻辑：
 *   入口：bindDetailModal / openDetailModal / closeDetailModal / isDetailModalOpen
 *   数据：getDetailTables / getDetailTableByField / getDetailTableByCol /
 *         getCurrentDetailTable / isDetailColumn / hasDetailRows / hasDetailRowsAtCol
 *   v2 渲染：dv2DetectKind / dv2FieldOrder / dv2StepLabel / dv2StepSubLabel /
 *            renderDetailV2 / renderDv2FieldCard / bindDv2Events /
 *            autoGrowTextarea / autoGrowAllTextareas
 *
 * 写操作（保存 / 增删 step / 字段写入）→ 05d-detail-write.js
 * 数组列编辑器 + 应用 init() → 05e-array-editor.js（最后加载）
 * ========================================================================== */

// 步骤必备字段及其类型：新增/复制步骤时自动预填充，字段列表始终包含
var REQUIRED_STEP_FIELDS = ['operation', 'data', 'ui_expected', 'api_expected', 'db_expected'];
var REQUIRED_STEP_KINDS = { operation: 'scalar', data: 'array', ui_expected: 'array', api_expected: 'array', db_expected: 'array' };
// 保存 YAML 时，值为空（'' / []）则删除，不写回文件
var STRIP_IF_EMPTY_FIELDS = ['data', 'ui_expected', 'api_expected', 'db_expected'];

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
    requestAnimationFrame(autoGrowAllTextareas);
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
    // 必备字段类型兜底：即使被清空删除后字段不存在，仍按注册类型渲染
    if (v === undefined && REQUIRED_STEP_KINDS[field] === 'array') return 'array';
    return 'scalar';
}

function dv2FieldOrder(rawObj, headers) {
    var arr = [];
    var seen = new Set();
    if (rawObj && typeof rawObj === 'object') {
        Object.keys(rawObj).forEach(function (k) { arr.push(k); seen.add(k); });
    }
    (headers || []).forEach(function (h) { if (!seen.has(h)) { arr.push(h); seen.add(h); } });
    REQUIRED_STEP_FIELDS.forEach(function (h) { if (!seen.has(h)) { arr.push(h); seen.add(h); } });
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
        REQUIRED_STEP_FIELDS.forEach(function (k) {
            if (!(k in seedObj)) {
                seedObj[k] = REQUIRED_STEP_KINDS[k] === 'array' ? [] : '';
            }
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
                html += '<span class="xs-dv2-step-move">'
                    +     '<span class="xs-dv2-step-up' + (di === 0 ? ' disabled' : '') + '" title="上移" data-di="' + di + '">&#9650;</span>'
                    +     '<span class="xs-dv2-step-dn' + (di === stepCount - 1 ? ' disabled' : '') + '" title="下移" data-di="' + di + '">&#9660;</span>'
                    +   '</span>';
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
            // 嵌套对象：以 JSON 文本域展示，支持格式化 + 语法高亮
            if (kind === 'object') {
                var jsonStr = '';
                try { jsonStr = JSON.stringify(rawObj[field], null, 2); } catch (_) { jsonStr = String(rawObj[field] || ''); }
                html += renderDv2FieldCard(field, 'object',
                    '<div class="xs-dv2-obj-wrap">'
                    +   '<textarea class="xs-dv2-scalar" data-field="' + escapeHtml(field) + '" data-kind="object" rows="4">' + escapeHtml(jsonStr) + '</textarea>'
                    +   '<pre class="xs-dv2-obj-hl" data-field="' + escapeHtml(field) + '" style="display:none"><code></code></pre>'
                    + '</div>');
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
                            var expandBtn = '<button class="xs-dv2-arr-expand-btn" data-field="' + escapeHtml(field) + '" data-ii="' + ii + '" title="展开查看全部">&#x25BC;</button>';
                            inner += '<div class="xs-dv2-arr-item" data-field="' + escapeHtml(field) + '" data-ii="' + ii + '">'
                                +      '<span class="xs-dv2-arr-idx">' + (ii + 1) + '</span>'
                                +      '<textarea class="xs-dv2-arr-input" data-field="' + escapeHtml(field) + '" data-ii="' + ii + '" rows="1">' + escapeHtml(text) + '</textarea>'
                                +      expandBtn
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
                '<textarea class="xs-dv2-scalar" data-field="' + escapeHtml(field) + '" data-kind="scalar" rows="1">' + escapeHtml(text) + '</textarea>',
                false
            );
        });
    }
    html += '</div>'; // /.xs-dv2-right

    body.innerHTML = html;
    bindDv2Events();
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
    var expandBtn = (kind === 'scalar' || kind === 'object')
        ? '<button class="xs-dv2-expand-btn" data-field="' + escapeHtml(field) + '" title="展开查看全部">&#x25BC;</button>'
        : '';
    var formatBtn = (kind === 'object')
        ? '<button class="xs-dv2-format-btn" data-field="' + escapeHtml(field) + '" title="格式化 JSON">{ }</button>'
        : '';
    var hlBtn = (kind === 'object')
        ? '<button class="xs-dv2-hl-btn" data-field="' + escapeHtml(field) + '" title="语法高亮">&#x2728;</button>'
        : '';
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
        +      formatBtn
        +      hlBtn
        +      expandBtn
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
            // 点击删除/移动按钮时不切换
            if (ev.target && ev.target.classList) {
                if (ev.target.classList.contains('xs-dv2-step-del') ||
                    ev.target.classList.contains('xs-dv2-step-up') ||
                    ev.target.classList.contains('xs-dv2-step-dn')) return;
            }
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
    // 左栏：上移 / 下移步骤
    body.querySelectorAll('.xs-dv2-step-up:not(.disabled)').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var di = parseInt(btn.getAttribute('data-di'), 10);
            if (!isNaN(di) && di > 0) dv2MoveStep(di, 'up');
        });
    });
    body.querySelectorAll('.xs-dv2-step-dn:not(.disabled)').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var di = parseInt(btn.getAttribute('data-di'), 10);
            if (!isNaN(di)) dv2MoveStep(di, 'down');
        });
    });
    // 左栏：添加 / 复制
    var addBtn = document.getElementById('dv2BtnAdd');
    if (addBtn) addBtn.addEventListener('click', function () { dv2AddStep(); });
    var dupBtn = document.getElementById('dv2BtnDup');
    if (dupBtn) dupBtn.addEventListener('click', function () { dv2DuplicateStep(); });

    // 展开/收起按钮
    body.querySelectorAll('.xs-dv2-expand-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var wrapper = btn.closest('.xs-dv2-field');
            if (!wrapper) return;
            var ta = wrapper.querySelector('textarea.xs-dv2-scalar');
            if (wrapper.classList.toggle('expanded')) {
                // 展开
                btn.innerHTML = '&#x25B2;';
                btn.title = '收起';
                if (ta) {
                    ta.classList.add('expanded');
                    autoGrowTextarea(ta);
                }
            } else {
                // 收起
                btn.innerHTML = '&#x25BC;';
                btn.title = '展开查看全部';
                if (ta) {
                    ta.classList.remove('expanded');
                    ta.style.height = '';
                    ta.style.overflowY = '';
                }
            }
        });
    });

    // 对象字段：格式化 JSON
    body.querySelectorAll('.xs-dv2-format-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var field = btn.getAttribute('data-field');
            dv2FormatJson(field);
        });
    });

    // 对象字段：高亮/编辑切换
    body.querySelectorAll('.xs-dv2-hl-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var field = btn.getAttribute('data-field');
            dv2ToggleHighlight(field);
        });
    });

    // 右栏：标量 / 对象编辑
    body.querySelectorAll('textarea.xs-dv2-scalar').forEach(function (ta) {
        ta.addEventListener('input', function () {
            // 仅展开状态下自动增长
            if (ta.classList.contains('expanded')) {
                autoGrowTextarea(ta);
            }
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
        // wheel 事件：文本域内滚动到边界时阻止外传，防止带动右侧面板整页滚动
        bindTextareaWheel(ta);
    });
    // 数组项：展开/收起按钮
    body.querySelectorAll('.xs-dv2-arr-expand-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var item = btn.closest('.xs-dv2-arr-item');
            if (!item) return;
            var ta = item.querySelector('textarea.xs-dv2-arr-input');
            if (item.classList.toggle('expanded')) {
                btn.innerHTML = '&#x25B2;';
                btn.title = '收起';
                if (ta) {
                    ta.classList.add('expanded');
                    autoGrowTextarea(ta);
                }
            } else {
                btn.innerHTML = '&#x25BC;';
                btn.title = '展开查看全部';
                if (ta) {
                    ta.classList.remove('expanded');
                    ta.style.height = '';
                    ta.style.overflowY = '';
                }
            }
        });
    });

    // 右栏：数组项编辑
    body.querySelectorAll('textarea.xs-dv2-arr-input').forEach(function (ta) {
        ta.addEventListener('input', function () {
            if (ta.classList.contains('expanded')) {
                autoGrowTextarea(ta);
            }
        });
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
        bindTextareaWheel(ta);
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
    var style = getComputedStyle(ta);
    var borderH = parseInt(style.borderTopWidth, 10) + parseInt(style.borderBottomWidth, 10);
    ta.style.height = (ta.scrollHeight + borderH) + 'px';
    ta.style.overflowY = 'hidden';
}
function autoGrowAllTextareas() {
    var body = document.getElementById('detailModalBody');
    if (!body) return;
    var expanded = body.querySelectorAll('textarea.expanded');
    if (expanded.length > 0) {
        expanded.forEach(function (ta) { autoGrowTextarea(ta); });
    }
}

// JSON 语法高亮：将 JSON 字符串转为带颜色标记的 HTML
function highlightJson(str) {
    var html = escapeHtml(str);
    // key 着色（蓝色）："...":
    html = html.replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="hl-key">$1</span>$2');
    // 字符串值着色（绿色）
    html = html.replace(/:(\s*)&quot;([^&]*?)&quot;/g, ':$1<span class="hl-string">&quot;$2&quot;</span>');
    // 数字着色（橙色）
    html = html.replace(/:(\s*)(\d+\.?\d*)/g, ':$1<span class="hl-number">$2</span>');
    // boolean/null 着色（紫色）
    html = html.replace(/:(\s*)(true|false|null)/g, ':$1<span class="hl-bool">$2</span>');
    return html;
}

// 对象字段：格式化 JSON
function dv2FormatJson(field) {
    var fieldEl = document.querySelector('.xs-dv2-field[data-field="' + field + '"]');
    var wrap = fieldEl ? fieldEl.querySelector('.xs-dv2-obj-wrap') : null;
    var ta = wrap ? wrap.querySelector('textarea') : null;
    if (!ta) return;
    try {
        var obj = JSON.parse(ta.value);
        ta.value = JSON.stringify(obj, null, 2);
        ta.dispatchEvent(new Event('change'));
        // 如果高亮预览可见，同步刷新
        var pre = wrap ? wrap.querySelector('.xs-dv2-obj-hl') : null;
        if (pre && pre.style.display !== 'none') {
            pre.querySelector('code').innerHTML = highlightJson(ta.value);
        }
    } catch (_) { /* JSON 格式不合法，忽略 */ }
}

// 对象字段：切换高亮/编辑模式
function dv2ToggleHighlight(field) {
    var fieldEl = document.querySelector('.xs-dv2-field[data-field="' + field + '"]');
    var wrap = fieldEl ? fieldEl.querySelector('.xs-dv2-obj-wrap') : null;
    var ta = wrap ? wrap.querySelector('textarea') : null;
    var pre = wrap ? wrap.querySelector('.xs-dv2-obj-hl') : null;
    var hlBtn = fieldEl ? fieldEl.querySelector('.xs-dv2-hl-btn') : null;
    if (!ta || !pre) return;
    var isHighlight = pre.style.display !== 'none';
    if (isHighlight) {
        // 切换回编辑模式
        pre.style.display = 'none';
        ta.style.display = '';
        if (hlBtn) { hlBtn.innerHTML = '&#x2728;'; hlBtn.title = '语法高亮'; }
    } else {
        // 切换到高亮模式
        ta.style.display = 'none';
        pre.style.display = '';
        pre.querySelector('code').innerHTML = highlightJson(ta.value);
        if (hlBtn) { hlBtn.innerHTML = '&#x270e;'; hlBtn.title = '编辑'; }
    }
}

// 文本域 wheel 事件陷阱：聚焦文本域滚动时，阻止滚动到边界后外传给右侧面板
function bindTextareaWheel(ta) {
    if (!ta || ta._wheelBound) return;
    ta._wheelBound = true;
    ta.addEventListener('wheel', function (e) {
        var style = getComputedStyle(ta);
        var overflowY = style.overflowY;
        // 只有当文本域有滚动条且内容溢出时才拦截
        if (overflowY !== 'auto' && overflowY !== 'scroll') return;
        if (ta.scrollHeight <= ta.clientHeight + 2) return;
        var atTop = ta.scrollTop <= 0;
        var atBottom = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 2;
        var scrollingDown = e.deltaY > 0;
        var scrollingUp = e.deltaY < 0;
        // 到达滚动边界时阻止事件外传
        if ((atTop && scrollingUp) || (atBottom && scrollingDown)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, { passive: false });
}
