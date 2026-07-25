/* =============================================================================
 * 03d-row-ops.js  —— 行操作（增 / 删 / 复制 / 推送）
 * -----------------------------------------------------------------------------
 * 由原 03d-row-col-ops.js 拆分而来：
 *   insertRow / deleteRow / deleteSelectedRows
 *   copyRowInline / copySelectedRows
 *   pushFromContextMenu
 *
 * 列操作 → 03f-col-ops.js
 * 单元格剪贴板/清空/填充 → 03g-clipboard.js
 * 明细辅助 → 03h-detail-helpers.js
 * 所有写操作前都会调用 pushHistory() 以支持撤销，结束时 saveFile() + renderTable()。
 * ========================================================================== */

// ==================== 行操作 ====================

/**
 * 统一处理"行索引依赖的高亮集合"随行操作的移位。
 * @param {'insert'|'delete'|'deleteBatch'} op
 * @param {number|number[]} at insert: 插入位置; delete: 被删行; deleteBatch: 降序数组
 *
 * 涉及集合（key 中含行索引）：
 *   - S.mods           (Set, key='row,col')
 *   - S._modsTime      (Object, key='row,col')
 *   - S._detailModCellKeys (Set, key='row,col')
 *   - S._highlightedCells.cells   (Set, key='row:col')
 *   - S._highlightedCells.rowSet  (Set, key=row)
 *
 * 注：_addedRowSet / rowHeights / _rowExpanded / S.sel 由各调用方就地处理（历史逻辑内联，不动）。
 */
function _shiftRowIdxHighlights(op, at) {
    function _shiftKey(key, sep, shiftFn) {
        var p = key.indexOf(sep);
        if (p < 0) return null;
        var r = parseInt(key.substring(0, p), 10);
        if (isNaN(r)) return null;
        var nr = shiftFn(r);
        if (nr < 0) return null; // -1 表示丢弃（被删行本身）
        return nr + sep + key.substring(p + 1);
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
        // 原地清空后回填，避免调用方持有旧引用失效
        keys.forEach(function (k) { delete objRef[k]; });
        Object.keys(next).forEach(function (k) { objRef[k] = next[k]; });
    }
    function _reshapeRowSet(setRef, shiftFn) {
        if (!setRef || !setRef.size) return;
        var next = new Set();
        setRef.forEach(function (r) {
            var nr = shiftFn(r);
            if (nr >= 0) next.add(nr);
        });
        setRef.clear();
        next.forEach(function (r) { setRef.add(r); });
    }

    var shiftFn;
    if (op === 'insert') {
        var atI = at;
        shiftFn = function (r) { return r >= atI ? r + 1 : r; };
    } else if (op === 'delete') {
        var atD = at;
        shiftFn = function (r) { if (r === atD) return -1; return r > atD ? r - 1 : r; };
    } else if (op === 'deleteBatch') {
        // at 为降序数组（例如 [5,3,1]）
        var sortedDesc = at;
        var sortedAsc = sortedDesc.slice().sort(function (a, b) { return a - b; });
        shiftFn = function (r) {
            if (sortedAsc.indexOf(r) >= 0) return -1;
            var s = 0;
            for (var i = 0; i < sortedAsc.length; i++) { if (sortedAsc[i] < r) s++; }
            return r - s;
        };
    } else {
        return;
    }

    // key='row,col' 的集合
    _reshapeSet(S.mods, ',', shiftFn);
    _reshapeSet(S._detailModCellKeys, ',', shiftFn);
    _reshapeObj(S._modsTime, ',', shiftFn);
    // _highlightedCells 若不存在则直接跳过
    if (S._highlightedCells) {
        _reshapeSet(S._highlightedCells.cells, ':', shiftFn);
        _reshapeRowSet(S._highlightedCells.rowSet, shiftFn);
    }
}

function insertRow(at, count) {
    // 批量插入：count 次连续在 at 位置插入（每次插入后新插入行都在 at，后续插入会把它们往下推）
    // 通过一次 pushHistory 支持整体撤销，避免用户按 N 次 Undo
    var n = parseInt(count, 10);
    if (!isFinite(n) || n < 1) n = 1;
    if (n > 1) {
        pushHistory();
        // 递归调用时 count 传 1，但为避免每次都 pushHistory，改为内联循环调用一个不带历史/保存的核心
        // 简化做法：直接循环调用 insertRow(at, 1)，其内部各自 pushHistory 会造成撤销栈膨胀（N 次撤销才能全撤）。
        // 折中：使用一个模块级标记跳过内部 pushHistory / saveFile / renderTable，最后统一执行。
        S._insertRowSkipSideEffects = true;
        try {
            for (var _k = 0; _k < n; _k++) insertRow(at, 1);
        } finally {
            S._insertRowSkipSideEffects = false;
        }
        saveFile();
        renderTable();
        return;
    }
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
    if (!S._insertRowSkipSideEffects) pushHistory();
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
    // 同步转移高亮集合（S.mods / _modsTime / _detailModCellKeys / _highlightedCells.cells / _highlightedCells.rowSet）
    _shiftRowIdxHighlights('insert', at);
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
    if (S._insertRowSkipSideEffects) return;
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
    // 同步转移高亮集合（S.mods / _modsTime / _detailModCellKeys / _highlightedCells.cells / _highlightedCells.rowSet）
    _shiftRowIdxHighlights('delete', ri);
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
    // 同步转移高亮集合（S.mods / _modsTime / _detailModCellKeys / _highlightedCells.cells / _highlightedCells.rowSet）
    _shiftRowIdxHighlights('deleteBatch', sorted);
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
    S.data.rows.splice(at, 0, newRow);
    // 同步转移高亮/修改集合（与 insertRow 一致）
    _shiftRowIdxHighlights('insert', at);
    // 同步新增行集合：插入位置后方的新增行索引+1
    if (S._addedRowSet && S._addedRowSet.size > 0) {
        var toShiftCI = [];
        S._addedRowSet.forEach(function (rr) { if (rr >= at) toShiftCI.push(rr); });
        toShiftCI.forEach(function (rr) { S._addedRowSet.delete(rr); S._addedRowSet.add(rr + 1); });
    }
    // 复制行也属于“新增行”（與 insertRow 同步待推送语义）
    if (typeof _filePushedBefore === 'function' && _filePushedBefore()) {
        if (!S._addedRowSet) S._addedRowSet = new Set();
        S._addedRowSet.add(at);
        S._addedRowTime = Date.now();
    }
    // 同步 rowHeights / _rowExpanded 下移
    if (S.rowHeights && Object.keys(S.rowHeights).length > 0) {
        var nrhCI = {};
        for (var rkCI in S.rowHeights) {
            if (!S.rowHeights.hasOwnProperty(rkCI)) continue;
            var riCI = parseInt(rkCI, 10);
            if (isNaN(riCI)) continue;
            nrhCI[riCI >= at ? riCI + 1 : riCI] = S.rowHeights[rkCI];
        }
        S.rowHeights = nrhCI;
    }
    if (S._rowExpanded && S._rowExpanded.size > 0) {
        var nreCI = new Set();
        S._rowExpanded.forEach(function (i) { nreCI.add(i >= at ? i + 1 : i); });
        S._rowExpanded = nreCI;
    }
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
        // 每个选中行的下方各插入一份副本；selRows 已按降序遍历，
        // 从后往前插入不会影响前面尚未处理的 rowIdx。
        var at = rowIdx + 1;
        var src = S.data.rows[rowIdx] || [];
        var newRow = src.map(function (v) { return Array.isArray(v) ? v.slice() : v; });
        // 复制行需要重新生成 testcase_id（避免与源行同 id），并清空已回写的 testCaseNo
        if (tsCol0 >= 0) newRow[tsCol0] = genUuidV4();
        if (tcCol0 >= 0) newRow[tcCol0] = '';
        S.data.rows.splice(at, 0, newRow);
        // 同步转移高亮/修改集合（逐行累加，与 insertRow 一致）
        _shiftRowIdxHighlights('insert', at);
        // 同步 _addedRowSet：插入位置后方的新增行索引+1，自身可选入集
        if (S._addedRowSet && S._addedRowSet.size > 0) {
            var toShiftCS = [];
            S._addedRowSet.forEach(function (rr) { if (rr >= at) toShiftCS.push(rr); });
            toShiftCS.forEach(function (rr) { S._addedRowSet.delete(rr); S._addedRowSet.add(rr + 1); });
        }
        if (typeof _filePushedBefore === 'function' && _filePushedBefore()) {
            if (!S._addedRowSet) S._addedRowSet = new Set();
            S._addedRowSet.add(at);
        }
        // 同步 rowHeights / _rowExpanded 下移
        if (S.rowHeights && Object.keys(S.rowHeights).length > 0) {
            var nrhCS = {};
            for (var rkCS in S.rowHeights) {
                if (!S.rowHeights.hasOwnProperty(rkCS)) continue;
                var riCS = parseInt(rkCS, 10);
                if (isNaN(riCS)) continue;
                nrhCS[riCS >= at ? riCS + 1 : riCS] = S.rowHeights[rkCS];
            }
            S.rowHeights = nrhCS;
        }
        if (S._rowExpanded && S._rowExpanded.size > 0) {
            var nreCS = new Set();
            S._rowExpanded.forEach(function (i) { nreCS.add(i >= at ? i + 1 : i); });
            S._rowExpanded = nreCS;
        }
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
    // 复制多行结束后统一刷新新增行时间戳
    if (S._addedRowSet && S._addedRowSet.size > 0 && typeof _filePushedBefore === 'function' && _filePushedBefore()) {
        S._addedRowTime = Date.now();
    }
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

