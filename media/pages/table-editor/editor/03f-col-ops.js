/* =============================================================================
 * 03f-col-ops.js  —— 列操作（增 / 删 / 重命名）
 * -----------------------------------------------------------------------------
 * 由原 03d-row-col-ops.js 拆分而来：
 *   insertCol / deleteCol / renameCol
 *
 * 列宽拖动 / 列选择见 03b-resize-colsel.js（不在本文件）。
 * ========================================================================== */

// ==================== 列操作 ====================
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
        // 重命名后的新名称如果与已有列重名，会破坏 headers.indexOf 唯一性，给出提示但仍允许（与原行为一致，仅冻结列收紧）
        pushHistory();
        S.data.headers[ci] = name;
        saveFile();
        renderTable();
    });
}

