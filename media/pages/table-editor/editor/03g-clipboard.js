/* =============================================================================
 * 03g-clipboard.js  —— 单元格剪贴板 / 清空 / 批量填充
 * -----------------------------------------------------------------------------
 * 由原 03d-row-col-ops.js 拆分而来：
 *   copyCell           — 复制单元格或矩形选区到内部剪贴板
 *   pasteCell          — 从内部剪贴板粘贴（支持单值 / 二维矩形 / 跨格扩展）
 *   clearCell          — 清空单元格或选区（保留单元格类型）
 *   fillSelectedCells  — 弹窗输入值后批量填充选区
 * ========================================================================== */

// ==================== 剪贴板辅助：单元格值 → TSV 字符串 ====================
function _cellValueToTsv(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) {
        var _hasObjV = false;
        for (var _voi = 0; _voi < v.length; _voi++) { if (v[_voi] && typeof v[_voi] === 'object') { _hasObjV = true; break; } }
        if (_hasObjV) {
            return v.map(function (_xx) {
                if (_xx === null || _xx === undefined) return '';
                if (typeof _xx === 'object') { try { return JSON.stringify(_xx); } catch (_e) { return ''; } }
                return String(_xx);
            }).join('; ');
        }
        return (typeof formatCellValue === 'function') ? formatCellValue(v) : v.join('; ');
    }
    if (typeof v === 'object') {
        try { return JSON.stringify(v); } catch (_e) { return ''; }
    }
    return String(v);
}

function _writeSystemClipboard(tsv, successMsg, failMsg) {
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tsv).then(function () {
            if (typeof showToast === 'function') showToast(successMsg, 'success');
        }, function () {
            if (typeof showToast === 'function') showToast(failMsg || '复制到系统剪贴板失败', 'error');
        });
    } else {
        // 兜底：通过临时 textarea + execCommand
        var _ta = document.createElement('textarea');
        _ta.value = tsv;
        _ta.style.position = 'fixed';
        _ta.style.left = '-9999px';
        document.body.appendChild(_ta);
        _ta.select();
        var _ok = false;
        try { _ok = document.execCommand('copy'); } catch (_e2) { }
        document.body.removeChild(_ta);
        if (typeof showToast === 'function') {
            showToast(_ok ? successMsg : (failMsg || '复制到系统剪贴板失败'), _ok ? 'success' : 'error');
        }
    }
}

// ==================== 单元格剪贴板 ====================
function copyCell() {
    // 矩形选区 > 1 格：将选区复制为二维数组（后续可多格粘贴）
    // 过滤模式下（仅看失败/列筛选）只复制实际可见行，避免把被隐藏的成功行内容带入剪贴板
    var rc = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
    if (rc && (rc.r1 !== rc.r2 || rc.c1 !== rc.c2)) {
        var rows = (S.data && S.data.rows) || [];
        var rowList = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
        if (!rowList || rowList.length === 0) {
            rowList = [];
            for (var rr = rc.r1; rr <= rc.r2; rr++) rowList.push(rr);
        }
        var grid = [];
        var _lines = [];
        for (var i = 0; i < rowList.length; i++) {
            var r = rowList[i];
            var line = [];
            var _tsvLine = [];
            for (var c = rc.c1; c <= rc.c2; c++) {
                var v;
                // detail 列：从明细表读取真实的对象 / 对象数组，而非主表的显示文本（如 '[3 项]'）
                var _rawDt = (typeof _readDetailCellRaw === 'function') ? _readDetailCellRaw(r, c) : undefined;
                if (_rawDt !== undefined) {
                    v = _rawDt;
                } else {
                    v = (rows[r] && rows[r][c] !== undefined) ? rows[r][c] : '';
                }
                // 对象/对象数组需要深拷贝，避免后续粘贴/编辑共享引用污染源数据
                var _copied = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(v) : (Array.isArray(v) ? v.slice() : v);
                line.push(_copied);
                // TSV：单元格内 \t / \r / \n 替换为空格，避免列错位
                _tsvLine.push(_cellValueToTsv(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '));
            }
            grid.push(line);
            _lines.push(_tsvLine.join('\t'));
        }
        S.clip = grid;
        // 同步写入系统剪贴板（TSV），使 Ctrl+V 也可用；toast 由 _writeSystemClipboard 统一触发
        _writeSystemClipboard(_lines.join('\n'),
            '已复制 ' + rowList.length + ' 行 × ' + (rc.c2 - rc.c1 + 1) + ' 列');
        return;
    }
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    // detail 列：优先从明细表读取真实的对象 / 对象数组
    var _rawDtSingle = (typeof _readDetailCellRaw === 'function') ? _readDetailCellRaw(S._ctxRow, S._ctxCol) : undefined;
    var v0;
    if (_rawDtSingle !== undefined) {
        v0 = _rawDtSingle;
    } else {
        v0 = (S.data.rows[S._ctxRow] && S.data.rows[S._ctxRow][S._ctxCol]);
        if (v0 === undefined) v0 = '';
    }
    // 单元格深拷贝（含对象 / 对象数组），避免后续粘贴或编辑导致引用共享污染源数据
    S.clip = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(v0) : (Array.isArray(v0) ? v0.slice() : v0);
    // 同步写入系统剪贴板（单格值），使 Ctrl+V 也可用；toast 由 _writeSystemClipboard 统一触发
    var _tsvSingle = _cellValueToTsv(v0).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
    _writeSystemClipboard(_tsvSingle, '已复制');
}

function pasteCell() {
    if (S.clip === null || S.clip === undefined) return;
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    // 二维数组（来自矩形复制）：从右键 (ctxRow, ctxCol) 作为左上角铺贴
    if (Array.isArray(S.clip) && S.clip.length > 0 && Array.isArray(S.clip[0])) {
        var grid = S.clip;
        var rows = (S.data && S.data.rows) || [];
        var headers = (S.data && S.data.headers) || [];
        pushHistory();
        var changed = 0, skippedTsId = false, skippedDetailPaste = false;
        // 过滤模式（仅看失败/列筛选/搜索）下，被隐藏的行不接收粘贴；
        // 按 _viewRows 顺序找到 ctxRow 后的连续可见行作为目标行序列（与 Excel AutoFilter 行为一致）。
        var _allLenPC = rows.length;
        var _vrPC = S._viewRows;
        var _useFilterPC = !!(_vrPC && _vrPC.length && _vrPC.length < _allLenPC);
        var _targetRowsPC = [];
        if (_useFilterPC) {
            var _startIdxPC = -1;
            for (var _siPC = 0; _siPC < _vrPC.length; _siPC++) {
                if (_vrPC[_siPC] >= S._ctxRow) { _startIdxPC = _siPC; break; }
            }
            if (_startIdxPC >= 0) {
                for (var _tiPC = 0; _tiPC < grid.length && (_startIdxPC + _tiPC) < _vrPC.length; _tiPC++) {
                    _targetRowsPC.push(_vrPC[_startIdxPC + _tiPC]);
                }
            }
        } else {
            for (var _tiPC2 = 0; _tiPC2 < grid.length; _tiPC2++) {
                var _r0PC = S._ctxRow + _tiPC2;
                if (_r0PC >= _allLenPC) break;
                _targetRowsPC.push(_r0PC);
            }
        }
        for (var i = 0; i < _targetRowsPC.length; i++) {
            var rIdx = _targetRowsPC[i];
            var row = rows[rIdx];
            if (!row) continue;
            for (var j = 0; j < grid[i].length; j++) {
                var cIdx = S._ctxCol + j;
                if (cIdx >= headers.length) break;
                if (isFrozenCol(cIdx)) { skippedTsId = true; continue; }
                var src = grid[i][j];
                var isArrTarget = typeof isArrayCol === 'function' && isArrayCol(cIdx);
                // detail 列：若源是对象 / 对象数组，走写入 detail 表的路径，同步 rawRowGroups / rowGroups / rawRowTypes
                var _isDetailTarget = (typeof isDetailColumn === 'function') && isDetailColumn(cIdx);
                if (_isDetailTarget) {
                    var _hasObjSrc = false;
                    if (src && (Array.isArray(src) || typeof src === 'object')) {
                        if (Array.isArray(src)) {
                            for (var _xoi = 0; _xoi < src.length; _xoi++) { if (src[_xoi] && typeof src[_xoi] === 'object') { _hasObjSrc = true; break; } }
                        } else { _hasObjSrc = true; }
                    }
                    if (_hasObjSrc) {
                        if (typeof _writeDetailCellFromRaw === 'function' && _writeDetailCellFromRaw(rIdx, cIdx, src)) {
                            changed++;
                            continue;
                        }
                    }
                    // 明细列剪贴板非对象/对象数组（例如从 Excel 复制的纯文本）：
                    // 若直接写字符串会与 rawRowGroups 不一致（yaml-parser 优先 raw → 视觉粘贴成功但数据未变）。
                    // 保守做法：跳过该单元格。
                    skippedDetailPaste = true;
                    continue;
                }
                var nv;
                if (isArrTarget && !Array.isArray(src)) {
                    var s = (src === null || src === undefined) ? '' : (typeof src === 'object' ? (function () { try { return JSON.stringify(src); } catch (_e) { return ''; } })() : String(src));
                    nv = s === '' ? [] : s.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                } else if (!isArrTarget && Array.isArray(src)) {
                    // 对象数组：保留对象结构（深拷贝）；标量数组：扁平化为字符串
                    var hasObjS = false;
                    for (var _soi = 0; _soi < src.length; _soi++) { if (src[_soi] && typeof src[_soi] === 'object') { hasObjS = true; break; } }
                    nv = hasObjS
                        ? ((typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(src) : src)
                        : formatCellValue(src);
                } else if (isArrTarget && Array.isArray(src)) {
                    nv = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(src) : src.slice();
                } else if (src && typeof src === 'object') {
                    // 普通对象：深拷贝
                    nv = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(src) : src;
                } else {
                    nv = src;
                }
                row[cIdx] = nv;
                S.mods.add(rIdx + ',' + cIdx);
                changed++;
            }
        }
        saveFile();
        renderTable();
        var msg = '已粘贴 ' + changed + ' 个单元格';
        var pasteSuffix = [];
        if (skippedTsId) pasteSuffix.push('testcase_id 列已跳过');
        if (skippedDetailPaste) pasteSuffix.push('明细列已跳过，请通过弹窗编辑');
        if (pasteSuffix.length > 0) msg += '（' + pasteSuffix.join('；') + '）';
        showToast(msg, 'success');
        return;
    }
    // 单值粘贴：原逻辑
    if (isFrozenCol(S._ctxCol)) { showToast('testcase_id 列不允许粘贴', 'error'); return; }
    pushHistory();
    var target = S.clip;
    var isArr = typeof isArrayCol === 'function' && isArrayCol(S._ctxCol);
    // detail 列：若 target 是对象 / 对象数组，走写入 detail 表的路径
    var _isDetailTargetSingle = (typeof isDetailColumn === 'function') && isDetailColumn(S._ctxCol);
    if (_isDetailTargetSingle && target && (Array.isArray(target) || typeof target === 'object')) {
        var _hasObjT0 = false;
        if (Array.isArray(target)) {
            for (var _xoi0 = 0; _xoi0 < target.length; _xoi0++) { if (target[_xoi0] && typeof target[_xoi0] === 'object') { _hasObjT0 = true; break; } }
        } else { _hasObjT0 = true; }
        if (_hasObjT0 && typeof _writeDetailCellFromRaw === 'function' && _writeDetailCellFromRaw(S._ctxRow, S._ctxCol, target)) {
            saveFile();
            renderTable();
            showToast('已粘贴', 'success');
            return;
        }
    }
    // 明细列剪贴板非对象/对象数组（如从 Excel 复制的纯文本）：
    // 直接写字符串会与 rawRowGroups 不一致（yaml-parser 优先 raw → 视觉粘贴成功但数据未变）。
    // 拒绝该操作并给出提示，引导用户通过弹窗编辑。
    if (_isDetailTargetSingle) {
        showToast('明细列不支持粘贴文本，请通过弹窗编辑', 'error');
        return;
    }
    if (isArr && !Array.isArray(target)) {
        var s2 = (target === null || target === undefined) ? '' : (typeof target === 'object' ? (function () { try { return JSON.stringify(target); } catch (_e) { return ''; } })() : String(target));
        target = s2 === '' ? [] : s2.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
    } else if (!isArr && Array.isArray(target)) {
        // 对象数组保留原结构（深拷贝），仅当目标列不是数组列时若是标量数组才扁平化为字符串
        var hasObjT = false;
        for (var _toi = 0; _toi < target.length; _toi++) { if (target[_toi] && typeof target[_toi] === 'object') { hasObjT = true; break; } }
        if (hasObjT) {
            target = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(target) : target;
        } else {
            target = formatCellValue(target);
        }
    } else if (isArr && Array.isArray(target)) {
        // 标量数组列：按需深拷贝；若是对象数组放进标量数组列，则序列化每个元素
        target = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(target) : target.slice();
    } else if (target && typeof target === 'object') {
        // 普通对象：直接深拷贝赋值
        target = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(target) : target;
    }
    S.data.rows[S._ctxRow][S._ctxCol] = target;
    S.mods.add(S._ctxRow + ',' + S._ctxCol);
    saveFile();
    patchCell(S._ctxRow, S._ctxCol);
}

function clearCell() {
    // 矩形选区 > 1 格：批量清空（跳过冻结列）
    // 过滤模式下（仅看失败/列筛选）只清空实际可见行，避免误清被隐藏的成功行
    var rc = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
    if (rc && (rc.r1 !== rc.r2 || rc.c1 !== rc.c2)) {
        var rows = (S.data && S.data.rows) || [];
        var rowList = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
        if (!rowList || rowList.length === 0) {
            rowList = [];
            for (var rr = rc.r1; rr <= rc.r2; rr++) rowList.push(rr);
        }
        var changed = 0, skippedTsId = false;
        pushHistory();
        for (var i = 0; i < rowList.length; i++) {
            var r = rowList[i];
            for (var c = rc.c1; c <= rc.c2; c++) {
                if (isFrozenCol(c)) { skippedTsId = true; continue; }
                var row = rows[r]; if (!row) continue;
                // detail 列（steps 等）：同步清空 rawRowGroups，避免 yaml-parser 回写旧数据
                var _isDetailB = (typeof isDetailColumn === 'function') && isDetailColumn(c);
                if (_isDetailB && typeof _writeDetailCellFromRaw === 'function') {
                    var _rawsB = (typeof _readDetailCellRaw === 'function') ? _readDetailCellRaw(r, c) : null;
                    var _hadContentB = Array.isArray(_rawsB) ? _rawsB.length > 0
                        : (_rawsB && typeof _rawsB === 'object' && Object.keys(_rawsB).length > 0);
                    if (_hadContentB) {
                        _writeDetailCellFromRaw(r, c, null);
                        changed++;
                    }
                    continue;
                }
                var isArr = typeof isArrayCol === 'function' && isArrayCol(c);
                var nv = isArr ? [] : '';
                var ov = row[c];
                var oldStr = (ov === null || ov === undefined) ? '' : (Array.isArray(ov) ? formatCellValue(ov) : String(ov));
                var newStr = isArr ? '' : '';
                if (oldStr !== newStr) {
                    row[c] = nv;
                    S.mods.add(r + ',' + c);
                    changed++;
                }
            }
        }
        saveFile();
        renderTable();
        var msg = '已清空 ' + changed + ' 个单元格';
        if (skippedTsId) msg += '（testcase_id 列已跳过）';
        showToast(msg, 'success');
        return;
    }
    if (S._ctxRow < 0 || S._ctxCol < 0) return;
    if (isFrozenCol(S._ctxCol)) { showToast('testcase_id 列不允许清空', 'error'); return; }
    pushHistory();
    // detail 列（steps 等）清空：必须同步清空 rawRowGroups，
    // 否则 yaml-parser 优先信任 rawRowGroups → YAML 中旧数据不会被删除，
    // 导致"视觉清空但数据未清"的一致性 bug（展开态下尤为明显）。
    var _isDetailC = (typeof isDetailColumn === 'function') && isDetailColumn(S._ctxCol);
    if (_isDetailC && typeof _writeDetailCellFromRaw === 'function') {
        _writeDetailCellFromRaw(S._ctxRow, S._ctxCol, null);
        saveFile();
        renderTable();
        return;
    }
    // 标量数组列清空 → 空数组，保持列类型不变
    if (typeof isArrayCol === 'function' && isArrayCol(S._ctxCol)) {
        S.data.rows[S._ctxRow][S._ctxCol] = [];
    } else {
        S.data.rows[S._ctxRow][S._ctxCol] = '';
    }
    S.mods.add(S._ctxRow + ',' + S._ctxCol);
    saveFile();
    patchCell(S._ctxRow, S._ctxCol);
}

// 批量填充单元格矩形选区：弹出输入框，输入值后填充整个选区（跳过冻结列）
function fillSelectedCells() {
    var rc = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
    if (!rc || (rc.r1 === rc.r2 && rc.c1 === rc.c2)) {
        showToast('请先拖选一个单元格区域', 'error');
        return;
    }
    xsPrompt('填充选中区域的值（作用于 ' + (rc.r2 - rc.r1 + 1) + '\u00d7' + (rc.c2 - rc.c1 + 1) + ' 格）', '', function (val) {
        if (val === null) return; // 取消
        var rows = (S.data && S.data.rows) || [];
        var rowList = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
        if (!rowList || rowList.length === 0) {
            rowList = [];
            for (var rr = rc.r1; rr <= rc.r2; rr++) rowList.push(rr);
        }
        var changed = 0, skippedTsId = false, skippedDetail = false;
        pushHistory();
        for (var i = 0; i < rowList.length; i++) {
            var r = rowList[i];
            for (var c = rc.c1; c <= rc.c2; c++) {
                if (isFrozenCol(c)) { skippedTsId = true; continue; }
                var row = rows[r]; if (!row) continue;
                // detail 列（steps 等）：填充字符串到嵌套结构无合理语义，直接跳过
                // 用户如果确实想批量清空，请用 Delete/Backspace（clearCell 已支持 detail 列同步清空）
                if ((typeof isDetailColumn === 'function') && isDetailColumn(c)) {
                    skippedDetail = true;
                    continue;
                }
                var isArr = typeof isArrayCol === 'function' && isArrayCol(c);
                var nv;
                if (isArr) {
                    nv = (val === '') ? [] : val.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                } else {
                    nv = val;
                }
                var ov = row[c];
                var oldStr = Array.isArray(ov) ? formatCellValue(ov) : (ov == null ? '' : String(ov));
                var newStr = Array.isArray(nv) ? formatCellValue(nv) : String(nv);
                if (oldStr !== newStr) {
                    row[c] = nv;
                    S.mods.add(r + ',' + c);
                    changed++;
                }
            }
        }
        saveFile();
        renderTable();
        var msg = '已批量填充 ' + changed + ' 个单元格';
        var suffix = [];
        if (skippedTsId) suffix.push('testcase_id 列已跳过');
        if (skippedDetail) suffix.push('明细列已跳过，请通过弹窗编辑');
        if (suffix.length > 0) msg += '（' + suffix.join('；') + '）';
        showToast(msg, 'success');
    });
}

