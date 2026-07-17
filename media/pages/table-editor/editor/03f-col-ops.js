/* =============================================================================
 * 03f-col-ops.js  —— 列操作（增 / 删 / 重命名）
 * -----------------------------------------------------------------------------
 * 由原 03d-row-col-ops.js 拆分而来：
 *   insertCol / deleteCol / renameCol
 *
 * 列宽拖动 / 列选择见 03b-resize-colsel.js（不在本文件）。
 * ========================================================================== */

// ==================== 列操作 ====================

/**
 * 统一处理"列索引依赖的高亮/修改集合"随列操作的移位。
 * @param {'insert'|'delete'} op
 * @param {number} at insert: 插入位置; delete: 被删列
 *
 * 涉及集合（key 中含列索引）：
 *   - S.mods           (Set, key='row,col')
 *   - S._modsTime      (Object, key='row,col')
 *   - S._detailModCellKeys (Set, key='row,col')
 *   - S._highlightedCells.cells   (Set, key='row:col')
 *   - S._highlightedCells.colIdx  (Number, -1 表示所有列)
 *
 * 注：列宽 / 列筛选 / 列选区 / detailTables 由调用方就地处理（历史逻辑内联，不动）。
 */
function _shiftColIdxHighlights(op, at) {
    function _shiftKey(key, sep, shiftFn) {
        var p = key.indexOf(sep);
        if (p < 0) return null;
        var c = parseInt(key.substring(p + 1), 10);
        if (isNaN(c)) return null;
        var nc = shiftFn(c);
        if (nc < 0) return null; // -1 表示丢弃
        return key.substring(0, p) + sep + nc;
    }
    function _reshapeSet(setRef, sep, shiftFn) {
        if (!setRef || !setRef.size) return;
        var next = new Set();
        setRef.forEach(function (k) {
            var nk = _shiftKey(k, sep, shiftFn);
            if (nk !== null) next.add(nk);
        });
        setRef.clear();
        next.forEach(function (k) { setRef.add(k); });
    }
    function _reshapeObj(objRef, sep, shiftFn) {
        if (!objRef) return;
        var keys = Object.keys(objRef);
        if (!keys.length) return;
        var next = {};
        keys.forEach(function (k) {
            var nk = _shiftKey(k, sep, shiftFn);
            if (nk !== null) next[nk] = objRef[k];
        });
        keys.forEach(function (k) { delete objRef[k]; });
        Object.keys(next).forEach(function (k) { objRef[k] = next[k]; });
    }

    var shiftFn;
    if (op === 'insert') {
        var atI = at;
        shiftFn = function (c) { return c >= atI ? c + 1 : c; };
    } else if (op === 'delete') {
        var atD = at;
        shiftFn = function (c) { if (c === atD) return -1; return c > atD ? c - 1 : c; };
    } else {
        return;
    }

    _reshapeSet(S.mods, ',', shiftFn);
    _reshapeSet(S._detailModCellKeys, ',', shiftFn);
    _reshapeObj(S._modsTime, ',', shiftFn);
    if (S._highlightedCells) {
        _reshapeSet(S._highlightedCells.cells, ':', shiftFn);
        // colIdx: -1 表示"整行任意列"，保持不变；具体列索引参与移位
        if (typeof S._highlightedCells.colIdx === 'number' && S._highlightedCells.colIdx >= 0) {
            var nc = shiftFn(S._highlightedCells.colIdx);
            if (nc < 0) {
                // 高亮列被删除，整个 highlightedCells 语义失效
                S._highlightedCells = null;
                S._highlightedTime = 0;
            } else {
                S._highlightedCells.colIdx = nc;
            }
        }
    }
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
        // 同步转移高亮/修改集合（S.mods / _modsTime / _detailModCellKeys / _highlightedCells.cells / _highlightedCells.colIdx）
        _shiftColIdxHighlights('insert', idx);
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
        // 先取列名，用于回收 detailTables 中对应的孤儿表（列删除后 header 已丢失）
        var _delColName = (S.data && S.data.headers && S.data.headers[ci]) || null;
        S.data.headers.splice(ci, 1);
        S.data.rows.forEach(function (row) { row.splice(ci, 1); });
        // 同步转移高亮/修改集合（S.mods / _modsTime / _detailModCellKeys / _highlightedCells.cells / _highlightedCells.colIdx）
        _shiftColIdxHighlights('delete', ci);
        // 同步回收明细表：若被删列对应一张明细表，则从 detailTables 中一并移除，
        // 否则它会成为无主 header 的孤儿表，yaml 序列化时仍会输出脉野数据。
        if (_delColName && S.data) {
            if (Array.isArray(S.data.detailTables) && S.data.detailTables.length > 0) {
                for (var _di = S.data.detailTables.length - 1; _di >= 0; _di--) {
                    var _t = S.data.detailTables[_di];
                    if (_t && _t.field === _delColName) {
                        S.data.detailTables.splice(_di, 1);
                    }
                }
            }
            // 兼容旧的单 detailTable 字段
            if (S.data.detailTable && S.data.detailTable.field === _delColName) {
                S.data.detailTable = null;
            }
        }
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
        // 重命名后的新名称如果与已有列重名，会破坏 headers.indexOf 唯一性；给出提示但仍允许（与原行为一致，仅冻结列收紧）
        if (name !== S.data.headers[ci] && S.data.headers.indexOf(name) !== -1) {
            if (typeof showToast === 'function') {
                showToast('已存在同名列「' + name + '」，可能影响字段定位，请确保业务上可接受', 'warning');
            }
        }
        pushHistory();
        // 同步明细表 field：若被重命名列对应一张明细表，则跟随改名，
        // 否则 getDetailTableByCol 后续将因 header≠field 而断开，导致明细弹窗/粘贴/渲染全部失效。
        var _oldName = S.data.headers[ci];
        if (_oldName && _oldName !== name && S.data) {
            if (Array.isArray(S.data.detailTables)) {
                for (var _ri = 0; _ri < S.data.detailTables.length; _ri++) {
                    var _tR = S.data.detailTables[_ri];
                    if (_tR && _tR.field === _oldName) _tR.field = name;
                }
            }
            if (S.data.detailTable && S.data.detailTable.field === _oldName) {
                S.data.detailTable.field = name;
            }
            // 若当前弹窗正在使用旧名定位，同步更新引用
            if (S._detailField === _oldName) S._detailField = name;
        }
        S.data.headers[ci] = name;
        saveFile();
        renderTable();
    });
}

