/* =============================================================================
 * 05d-detail-write.js  —— 明细弹窗（v2）写操作
 * -----------------------------------------------------------------------------
 * 由原 05c-detail-modal.js 拆分而来，集中所有"写"侧逻辑：
 *   读取活动 step：dv2GetActiveRaw
 *   修改标记：markActiveStepModified
 *   字段类型推断 / 取样：dv2GetOrigSample / dv2CoerceScalar / _inferDetailFieldKind
 *   字段写入：dv2WriteScalar / dv2WriteArrayItem /
 *             dv2AddArrayItem / dv2DeleteArrayItem
 *   step 操作：dv2AddStep / dv2DuplicateStep / dv2DeleteStep
 *   保存：saveDetailModal / updateDetailModInfo
 *
 * 渲染逻辑见 05c-detail-modal.js；启动 init() 在 05e-array-editor.js 末尾。
 * ========================================================================== */

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
