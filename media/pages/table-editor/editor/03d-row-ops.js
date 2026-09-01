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
 * 行索引偏移的统一入口：委托到 00-highlight-util.js 的 HighlightModel.shiftRowIndex。
 * 保留本地包装函数是为了让 03d 内部调用点保持简洁（不必每处都写 HighlightModel.xxx(S, ...)）。
 *
 * @param {'insert'|'delete'|'deleteBatch'} op
 * @param {number|number[]} at insert: 插入位置; delete: 被删行; deleteBatch: 降序数组
 *
 * 覆盖集合详见 HighlightModel.shiftRowIndex 注释；本次 P5 已把原本散落在
 * insertRow/deleteRow/deleteSelectedRows/copyRowInline/copySelectedRows 的
 * _addedRowSet 手写偏移合并进 shiftRowIndex，此处不再重复。
 */
function _shiftRowIdxHighlights(op, at) {
    HighlightModel.shiftRowIndex(S, op, at);
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
    // 同步转移高亮集合（S.mods / _modsTime / _detailModCellKeys / _highlightedCells.cells / _highlightedCells.rowSet / _addedRowSet）
    // 说明：_addedRowSet 后移已合并到 HighlightModel.shiftRowIndex，无需再单独处理
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

/**
 * 收集待删除行的 testcase_id，并标记为"待删除"（置灰+划线），不立即物理删除。
 * 由扩展端调线上删除接口，回包成功后（applyDeleteRowsResult）才真正 splice + 落盘。
 * 返回收集到的 tsId 列表（供上层发消息用）。
 */
function _collectPendingDelete(rowsToDelete) {
    var headers = (S.data && S.data.headers) || [];
    var tsIdIdx = headers.indexOf('testcase_id');
    if (tsIdIdx < 0) return [];
    if (!S._pendingDeleteTsIds) S._pendingDeleteTsIds = new Set();
    var tsIds = [];
    rowsToDelete.forEach(function (row) {
        var tsId = row[tsIdIdx] != null ? String(row[tsIdIdx]) : '';
        // 只有 testcase_id 非空（线上可能存在）才调删除接口；纯本地行（无 tsId）直接物理删除。
        if (tsId) {
            S._pendingDeleteTsIds.add(tsId);
            tsIds.push(tsId);
        }
    });
    return tsIds;
}

/**
 * 删除前的「线上预检」：把待删除的 testcase_id 发给扩展端调删除确认接口，
 * 扩展端回传 confirmDeleteRowsResult 后由 _showDeleteConfirmDialog 渲染确认弹窗。
 *
 * 契约：
 *   发：{ type:'confirmDeleteRows', data:{ tsIds } }
 *   收：{ type:'confirmDeleteRowsResult', ok, items:[{sourceId,testcaseNo,testCaseName,hasExec,hasBug}], errorMessage? }
 *
 * 健壮性：预检是为了「增强提示」，绝不能阻断删除。
 *   - 无 vscode 通道 / 回包超时（3s）/ 接口失败（ok=false）→ 全部降级为
 *     「不展示关联表格」，直接回调 onProceed 走原有简单确认删除流程。
 *
 * @param tsIds      待删除案例的 testcase_id 列表
 * @param onProceed  预检结束（无论成败）后继续执行的删除动作
 */
var CONFIRM_TIMEOUT_MS = 3000;
function requestDeleteConfirm(tsIds, onProceed) {
    var ids = (Array.isArray(tsIds) ? tsIds : []).map(String).filter(Boolean);
    var done = false;
    var finish = function (result) {
        if (done) return;
        done = true;
        if (S._deleteConfirmTimer) { clearTimeout(S._deleteConfirmTimer); S._deleteConfirmTimer = null; }
        S._deleteConfirmCb = null;
        if (result && result.ok && Array.isArray(result.items) && result.items.length > 0) {
            // 存在「需要确认」的案例 → 渲染带关联表格的确认弹窗
            _showDeleteConfirmDialog(result.items, onProceed);
        } else {
            // 无需额外确认 / 预检失败 → 降级为原有简单确认
            _showPlainDeleteConfirm(onProceed);
        }
    };
    if (ids.length === 0 || typeof S.vscode === 'undefined' || !S.vscode) {
        _showPlainDeleteConfirm(onProceed);
        return;
    }
    S._deleteConfirmCb = finish;
    S._deleteConfirmTimer = setTimeout(function () {
        if (done) return;
        console.log('[requestDeleteConfirm] 预检超时，降级为简单确认');
        finish({ ok: false, items: [] });
    }, CONFIRM_TIMEOUT_MS);
    try {
        S.vscode.postMessage({ type: 'confirmDeleteRows', data: { tsIds: ids } });
    } catch (_) {
        finish({ ok: false, items: [] });
    }
}

/** 渲染「无关联信息」时的简单确认弹窗（预检失败 / 全部允许删除时的降级形态） */
function _showPlainDeleteConfirm(onProceed) {
    if (typeof xsConfirm === 'function') {
        xsConfirm({
            title: '删除案例',
            message: '删除案例会同步删除 TMS 平台上的案例，此操作不可恢复。是否确定删除？',
            type: 'warning',
            okText: '确定删除',
        }, onProceed);
    } else {
        onProceed();
    }
}

/**
 * 渲染「需确认删除案例」的关联表格确认弹窗。
 *
 * 布局（按需求）：
 *   第 1 段：原有提示（谨慎操作 + 同步删除 TMS 平台案例）+ 新要求
 *           （同步删除执行和缺陷关联关系 + 如需继续操作请忽略本提示说明）
 *   第 2 段：表格（编号 / 名称 / 执行 / 缺陷），true→Y，false→N
 *   第 3 段：删除不可恢复，是否确认删除（「不可恢复」统一放在结尾段，首段不重复）
 */
function _showDeleteConfirmDialog(items, onProceed) {
    var rowsHtml = '';
    for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var no = it.testcaseNo || it.sourceId || '';
        var name = it.testCaseName || '';
        var exec = it.hasExec ? 'Y' : 'N';
        var bug = it.hasBug ? 'Y' : 'N';
        rowsHtml += '<tr>'
            + '<td class="xs-dc-td xs-dc-no">' + escapeHtml(no) + '</td>'
            + '<td class="xs-dc-td xs-dc-name">' + escapeHtml(name) + '</td>'
            + '<td class="xs-dc-td xs-dc-flag" data-flag="' + exec + '">' + exec + '</td>'
            + '<td class="xs-dc-td xs-dc-flag" data-flag="' + bug + '">' + bug + '</td>'
            + '</tr>';
    }
    var html = ''
        + '<div class="xs-dc-lead">谨慎操作：删除案例会同步删除 TMS 平台上的案例，并同步删除其执行和缺陷关联关系。如需继续操作，请忽略本提示（Y：存在，N：不存在）：</div>'
        + '<div class="xs-dc-table-wrap"><table class="xs-dc-table">'
        +   '<thead><tr><th>编号</th><th>名称</th><th>执行</th><th>缺陷</th></tr></thead>'
        +   '<tbody>' + rowsHtml + '</tbody>'
        + '</table></div>'
        + '<div class="xs-dc-tail">删除不可恢复，是否确认删除</div>';

    if (typeof xsConfirm === 'function') {
        xsConfirm({
            title: '删除案例',
            html: html,
            width: '620px',
            type: 'warning',
            okText: '确定删除',
            cancelText: '取消',
        }, onProceed);
    } else {
        onProceed();
    }
}

/**
 * 扩展端删除接口回包后调用：
 *  - syncedTsIds：接口删除成功的行 → 真正 splice + 落盘（从表格消失）
 *  - failedTsIds：接口删除失败的行 → 保留在表格内，以置灰+划线 + 失败原因标记（不丢数据）
 *  - reasons：[[tsId, reason], ...] 失败原因映射，用于行内展示
 *
 * 删除结果完全在表格内行展示，不再使用独立弹窗。
 */
function applyDeleteRowsResult(syncedTsIds, failedTsIds, reasons) {
    var synced = Array.isArray(syncedTsIds) ? syncedTsIds.map(String) : [];
    var failed = Array.isArray(failedTsIds) ? failedTsIds.map(String) : [];
    var headers = (S.data && S.data.headers) || [];
    var tsIdIdx = headers.indexOf('testcase_id');
    console.log('[applyDeleteRowsResult] synced=', JSON.stringify(synced), 'failed=', JSON.stringify(failed), 'tsIdIdx=', tsIdIdx);

    if (synced.length > 0 && tsIdIdx >= 0) {
        // 从后往前删，避免索引错位
        var indices = [];
        for (var ri = 0; ri < S.data.rows.length; ri++) {
            var tid = S.data.rows[ri][tsIdIdx];
            if (tid != null && synced.indexOf(String(tid)) >= 0) indices.push(ri);
        }
        indices.sort(function (a, b) { return b - a; });
        indices.forEach(function (idx) {
            S.data.rows.splice(idx, 1);
            // 同步明细表
            var ddts = getDetailTables();
            ddts.forEach(function (dt) {
                if (!dt) return;
                if (dt.rowGroups) dt.rowGroups.splice(idx, 1);
                if (dt.rawRowGroups) dt.rawRowGroups.splice(idx, 1);
                if (dt.rawRowTypes) dt.rawRowTypes.splice(idx, 1);
            });
            _shiftRowIdxHighlights('delete', idx);
            // 行高/展开集合同步
            if (S.rowHeights && Object.keys(S.rowHeights).length > 0) {
                var nrh = {};
                for (var rk in S.rowHeights) {
                    if (!S.rowHeights.hasOwnProperty(rk)) continue;
                    var i = parseInt(rk, 10);
                    if (isNaN(i)) continue;
                    if (i === idx) continue;
                    nrh[i > idx ? i - 1 : i] = S.rowHeights[rk];
                }
                S.rowHeights = nrh;
            }
            if (S._rowExpanded && S._rowExpanded.size > 0) {
                var nre = new Set();
                S._rowExpanded.forEach(function (i) { if (i !== idx) nre.add(i > idx ? i - 1 : i); });
                S._rowExpanded = nre;
            }
        });
        // 选中集合清理
        var ns = new Set();
        S.sel.forEach(function (i) {
            var keep = i;
            indices.forEach(function (idx) { if (keep > idx) keep--; });
            if (indices.indexOf(i) < 0) ns.add(keep);
        });
        S.sel = ns;
        S.cellSel = null;
        saveFile();
    }

    // 清除"待删除中"临时标记（无论成功失败都不再处于"删除中"态）
    if (!S._pendingDeleteTsIds) S._pendingDeleteTsIds = new Set();
    synced.concat(failed).forEach(function (id) { S._pendingDeleteTsIds.delete(id); });
    if (S._pendingDeleteTsIds.size === 0) S._pendingDeleteTsIds = null;

    // 失败行：保留在表格内，记入 _failedDeleteTsIds（置灰+划线 + 失败原因标记），不丢数据
    if (!S._failedDeleteTsIds) S._failedDeleteTsIds = new Set();
    if (!S._failedDeleteReasons) S._failedDeleteReasons = {};
    failed.forEach(function (id) { S._failedDeleteTsIds.add(id); });
    if (Array.isArray(reasons)) {
        reasons.forEach(function (pair) {
            if (Array.isArray(pair) && pair.length >= 2) {
                S._failedDeleteReasons[String(pair[0])] = String(pair[1] || '');
            }
        });
    }

    renderTable();

    // 轻量汇总提示（非弹窗）：成功行数 / 失败行数
    if (typeof showToast === 'function') {
        if (synced.length > 0 && failed.length === 0) {
            showToast('已删除 ' + synced.length + ' 行（同步线上成功）', 'success');
        } else if (synced.length > 0 && failed.length > 0) {
            showToast('已删除 ' + synced.length + ' 行，' + failed.length + ' 行删除失败（已在表格内标记）', 'warning');
        } else if (synced.length === 0 && failed.length > 0) {
            showToast(failed.length + ' 行删除失败（已在表格内标记，可重试）', 'error');
        }
    }
}

function deleteRow(ri) {
    if (ri < 0 || ri >= S.data.rows.length) return;
    pushHistory();
    var headers = (S.data && S.data.headers) || [];
    var tsIdIdx = headers.indexOf('testcase_id');
    var rowToDelete = S.data.rows[ri];
    var tsId = (tsIdIdx >= 0 && rowToDelete[tsIdIdx] != null) ? String(rowToDelete[tsIdIdx]) : '';

    // 纯本地行（无 testcase_id）：直接物理删除，不调接口（线上无记录）
    if (!tsId) {
        S.data.rows.splice(ri, 1);
        var ddts = getDetailTables();
        ddts.forEach(function (dt) {
            if (!dt) return;
            if (dt.rowGroups) dt.rowGroups.splice(ri, 1);
            if (dt.rawRowGroups) dt.rawRowGroups.splice(ri, 1);
            if (dt.rawRowTypes) dt.rawRowTypes.splice(ri, 1);
        });
        _shiftRowIdxHighlights('delete', ri);
        var ns0 = new Set();
        S.sel.forEach(function (i) { if (i !== ri) ns0.add(i > ri ? i - 1 : i); });
        S.sel = ns0;
        if (S.rowHeights && Object.keys(S.rowHeights).length > 0) {
            var nrh0 = {};
            for (var rk0 in S.rowHeights) {
                if (!S.rowHeights.hasOwnProperty(rk0)) continue;
                var i0 = parseInt(rk0, 10);
                if (isNaN(i0)) continue;
                if (i0 === ri) continue;
                nrh0[i0 > ri ? i0 - 1 : i0] = S.rowHeights[rk0];
            }
            S.rowHeights = nrh0;
        }
        if (S._rowExpanded && S._rowExpanded.size > 0) {
            var nre0 = new Set();
            S._rowExpanded.forEach(function (i) { if (i !== ri) nre0.add(i > ri ? i - 1 : i); });
            S._rowExpanded = nre0;
        }
        S.cellSel = null;
        saveFile();
        renderTable();
        return;
    }

    // 已推送行：先标记为待删除（置灰+划线），发消息让扩展端调接口，等回包再真删
    _collectPendingDelete([rowToDelete]);
    renderTable();
    if (typeof S.vscode !== 'undefined' && S.vscode) {
        // 谨慎操作：删除会同步删除 TMS 平台上的案例，先弹窗确认
        var _doDelete = function () {
            // 携带当前表格中所有非空 tsId 的有序快照，供扩展端算「删除后视图行号」
            // 避免扩展端重新读盘（磁盘可能滞后于内存）
            var _tsIdOrder = _snapshotTsIdOrder();
            console.log('[deleteRow] 发送 deleteRows 消息 tsIds=', JSON.stringify([tsId]));
            S.vscode.postMessage({ type: 'deleteRows', data: { tsIds: [tsId], tsIdOrder: _tsIdOrder } });
        };
        // 删除前先做线上预检：有「执行/缺陷」关联的案例会以表格形式二次确认；
        // 预检失败或无需确认时自动降级为简单确认，不阻断删除。
        requestDeleteConfirm([tsId], _doDelete);
    } else {
        console.log('[deleteRow] 未发送 deleteRows 消息（无 vscode 对象）tsId=', tsId);
    }
}

function deleteSelectedRows() {
    if (S.sel.size === 0) return;
    pushHistory();
    var sorted = Array.from(S.sel).sort(function (a, b) { return b - a; });
    var headers = (S.data && S.data.headers) || [];
    var tsIdIdx = headers.indexOf('testcase_id');

    // 拆成两组：纯本地行（无 tsId，直接物理删除）+ 已推送行（先标记待删，等接口回包）
    var localRows = [];   // 待物理删除的行索引（降序）
    var pendingRows = []; // 待接口删除的行对象
    sorted.forEach(function (i) {
        var row = S.data.rows[i];
        var tsId = (tsIdIdx >= 0 && row[tsIdIdx] != null) ? String(row[tsIdIdx]) : '';
        if (tsId) pendingRows.push(row);
        else localRows.push(i);
    });

    // 谨慎操作：只要本次删除涉及"已推送案例"（删除会同步删除 TMS 平台上的案例），
    // 就先弹窗确认；纯本地未推送行不涉及 TMS，无需确认。
    var _needConfirm = pendingRows.length > 0;
    var _doDeleteSelected = function () {
        // 1) 纯本地行直接物理删除
        localRows.forEach(function (i) {
            S.data.rows.splice(i, 1);
            var ddts = getDetailTables();
            ddts.forEach(function (dt) {
                if (!dt) return;
                if (dt.rowGroups) dt.rowGroups.splice(i, 1);
                if (dt.rawRowGroups) dt.rawRowGroups.splice(i, 1);
                if (dt.rawRowTypes) dt.rawRowTypes.splice(i, 1);
            });
            _shiftRowIdxHighlights('delete', i);
            if (S.rowHeights && Object.keys(S.rowHeights).length > 0) {
                var nrh = {};
                for (var rk in S.rowHeights) {
                    if (!S.rowHeights.hasOwnProperty(rk)) continue;
                    var ri2 = parseInt(rk, 10);
                    if (isNaN(ri2)) continue;
                    if (ri2 === i) continue;
                    nrh[ri2 > i ? ri2 - 1 : ri2] = S.rowHeights[rk];
                }
                S.rowHeights = nrh;
            }
            if (S._rowExpanded && S._rowExpanded.size > 0) {
                var nre = new Set();
                S._rowExpanded.forEach(function (x) { if (x !== i) nre.add(x > i ? x - 1 : x); });
                S._rowExpanded = nre;
            }
        });

        // 2) 已推送行：标记待删（置灰+划线），收集 tsId 待发消息
        var pendingTsIds = [];
        if (pendingRows.length > 0) {
            pendingTsIds = _collectPendingDelete(pendingRows);
        }

        S.sel.clear();
        S.cellSel = null;
        // 本地行已删，需落盘；待删行仅标记未删，也需 renderTable 展示置灰
        saveFile();
        renderTable();

        // 3) 发消息让扩展端调删除接口；回包后由 applyDeleteRowsResult 真正删成功的行
        if (pendingTsIds.length > 0 && typeof S.vscode !== 'undefined' && S.vscode) {
            // 携带当前表格中所有非空 tsId 的有序快照，供扩展端算「删除后视图行号」
            var _tsIdOrder2 = _snapshotTsIdOrder();
            console.log('[deleteSelectedRows] 发送 deleteRows 消息 tsIds=', JSON.stringify(pendingTsIds));
            S.vscode.postMessage({ type: 'deleteRows', data: { tsIds: pendingTsIds, tsIdOrder: _tsIdOrder2 } });
        } else {
            console.log('[deleteSelectedRows] 未发送 deleteRows 消息 pendingTsIds=', JSON.stringify(pendingTsIds));
        }
    };

    if (_needConfirm) {
        // 预检只针对「已推送行」（本地未推送行不涉线上，无需预检）
        var _pendingTsIds = pendingRows.map(function (r) {
            return (tsIdIdx >= 0 && r[tsIdIdx] != null) ? String(r[tsIdIdx]) : '';
        }).filter(Boolean);
        requestDeleteConfirm(_pendingTsIds, _doDeleteSelected);
    } else {
        // 仅本地行，无 TMS 同步风险，直接执行
        _doDeleteSelected();
    }
}

/**
 * 快照当前表格中所有非空 testcase_id 的有序列表（1-based 视图顺序）。
 * 发送 deleteRows 消息时携带，让扩展端可以直接按此顺序算「删除后视图行号」，
 * 避免扩展端从磁盘读旧内容导致行号错位。
 */
function _snapshotTsIdOrder() {
    var headers = (S.data && S.data.headers) || [];
    var idx = headers.indexOf('testcase_id');
    if (idx < 0) return [];
    var out = [];
    var rows = (S.data && S.data.rows) || [];
    for (var i = 0; i < rows.length; i++) {
        var raw = rows[i] && rows[i][idx];
        var id = raw == null ? '' : String(raw).trim();
        if (id) out.push(id);
    }
    return out;
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
    // 同步转移高亮/修改集合（与 insertRow 一致，_addedRowSet 已合并到 shiftRowIndex 内）
    _shiftRowIdxHighlights('insert', at);
    // 复制行也属于"新增行"（與 insertRow 同步待推送语义）
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
        // 同步转移高亮/修改集合（逐行累加，与 insertRow 一致，_addedRowSet 已合并到 shiftRowIndex 内）
        _shiftRowIdxHighlights('insert', at);
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
    }, 60000);
    S.vscode.postMessage({ type: 'pushTestCase', data: payload, rowIndexMap: rowIndexMap, pushIndexToRow: pushIndexToRow });
}

