/* =============================================================================
 * 03h-detail-helpers.js  —— 明细列辅助函数
 * -----------------------------------------------------------------------------
 * 由原 03d-row-col-ops.js 拆分而来，集中明细列与"是否已推送"的判定工具：
 *   _inferDetailColKind     — 推断明细列的"列级主流类型"（array / object / scalar）
 *   _readDetailCellRaw      — 从 detailTables 读出 (ri, ci) 单元格的原始结构
 *   _writeDetailCellFromRaw — 将原始结构写回 detailTables 同时同步主表 chip 显示
 *   _filePushedBefore       — 当前文件是否已推送过（用于决定新增/删除高亮策略）
 *
 * 本文件不含写操作主流程，只提供供 03d / 03f / 03g 调用的工具函数。
 * ========================================================================== */

// ==================== 明细列辅助 ====================
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

