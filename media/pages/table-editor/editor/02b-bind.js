/* =============================================================================
 * 02b-bind.js  —— 工具栏 / 全局快捷键 / 表格事件绑定
 * -----------------------------------------------------------------------------
 * 由原 02-render-bind.js 拆分而来，包含 bindToolbar / bindDocument / bindTable
 * 三大事件绑定，以及给委托处理函数复用的 _pseudoEvt 工具方法。渲染函数与选区
 * 处理分别见 02a-render.js / 02c-row-cell-sel.js / 02d-sel-utils.js。
 * 跨文件依赖通过全局作用域共享。
 * ========================================================================== */

// ==================== 事件绑定 ====================
function bindToolbar() {
    var pushBtn = document.getElementById('pushBtn');
    if (pushBtn) pushBtn.addEventListener('click', pushChanges);
    var failedFilterBtn = document.getElementById('failedFilterBtn');
    if (failedFilterBtn) {
        failedFilterBtn.addEventListener('click', function () {
            // 禁用态点击不响应
            if (failedFilterBtn.classList.contains('is-disabled')) return;
            var hasFailed = !!(S._pushFailedTsIds && S._pushFailedTsIds.size > 0);
            if (!hasFailed) return;
            S._failedOnly = !S._failedOnly;
            renderTable();
        });
    }
    var openBtn = document.querySelector('[data-action="openTextEditor"]');
    if (openBtn) openBtn.addEventListener('click', function () {
        S.vscode.postMessage({ type: 'openTextEditor' });
    });
    var findBtn = document.getElementById('findBtn');
    if (findBtn) findBtn.addEventListener('click', toggleFindPanel);
    var search = document.getElementById('searchInput');
    if (search) {
        search.addEventListener('input', onSearch);
        search.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                // Enter 立即搜索，取消防抖
                if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
                S._searchKw = search.value || '';
                updateSearchClear(S._searchKw);
                renderTable();
            } else if (e.key === 'Escape') {
                if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
                search.value = '';
                S._searchKw = '';
                updateSearchClear();
                renderTable();
            }
        });
    }
    var searchClear = document.getElementById('searchClear');
    if (searchClear) {
        searchClear.addEventListener('click', function () {
            var inp = document.getElementById('searchInput');
            if (inp) { inp.value = ''; inp.focus(); }
            if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
            S._searchKw = '';
            updateSearchClear();
            renderTable();
        });
    }
    var searchReset = document.getElementById('searchReset');
    if (searchReset) {
        searchReset.addEventListener('click', function () {
            // 编辑已实时落盘（每次写操作都会 saveFile），无需未保存确认。
            // 这里直接清空筛选/搜索，并请求扩展端从磁盘重读最新数据强制覆盖前端。
            var inp = document.getElementById('searchInput');
            if (inp) { inp.value = ''; }
            if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
            S._searchKw = '';
            updateSearchClear();
            // 清空所有列筛选
            S._colFilters = {};
            // 关闭"仅看推送失败"筛选；失败标记本身保留（除非用户明确清除/再次推送），但视图回到全部。
            S._failedOnly = false;
            // 关闭可能打开的列筛选弹窗（若存在该函数）
            try { if (typeof closeColFilter === 'function') closeColFilter(); } catch (e) {}
            // 清掉 mods（高亮）与撤销栈：刷新后磁盘 = 内存，旧撤销点不再有意义；
            // 同时避免随后扩展端 force 推送被前端 hasUserChanges 兜底拦截。
            if (S.mods && S.mods.size > 0) S.mods.clear();
            if (typeof clearHistory === 'function') clearHistory();
            renderTable();
            // 提示进行中：成功覆盖会在收到磁盘最新数据后再次提示
            if (typeof showToast === 'function') showToast('正在获取最新数据…', 'info');
            try {
                S.vscode.postMessage({ type: 'reload' });
            } catch (e) {
                if (typeof showToast === 'function') showToast('获取最新数据失败：' + (e && e.message || e), 'error');
            }
            if (inp) inp.focus();
        });
    }

    var findInput = document.getElementById('findInput');
    if (findInput) findInput.addEventListener('input', function (ev) {
        rebuildFindMatches((ev.target.value || ''));
        updateFindInfo();
        focusActiveMatch();
    });
    var prevBtn = document.getElementById('prevBtn');
    if (prevBtn) prevBtn.addEventListener('click', function () { stepFind(-1); });
    var nextBtn = document.getElementById('nextBtn');
    if (nextBtn) nextBtn.addEventListener('click', function () { stepFind(1); });
    var replaceBtn = document.getElementById('replaceBtn');
    if (replaceBtn) replaceBtn.addEventListener('click', replaceCurrent);
    var replaceAllBtn = document.getElementById('replaceAllBtn');
    if (replaceAllBtn) replaceAllBtn.addEventListener('click', replaceAll);
    // Aa 区分大小写开关：点击切换后即时重建命中列表
    var caseBtn = document.getElementById('findCaseBtn');
    if (caseBtn) {
        caseBtn.addEventListener('click', function () {
            S._findCaseSensitive = !S._findCaseSensitive;
            if (S._findCaseSensitive) caseBtn.classList.add('active');
            else caseBtn.classList.remove('active');
            var fi = document.getElementById('findInput');
            rebuildFindMatches(fi ? (fi.value || '') : (S._findKw || ''));
            updateFindInfo();
            focusActiveMatch();
        });
    }
}

function bindDocument() {
    if (S._docBound) return;
    S._docBound = true;
    // 全局点击关闭右键菜单 / 列筛选弹窗
    document.addEventListener('click', function (e) {
        hideContextMenu();
        var sf = document.getElementById('sortFilter');
        if (sf && sf.classList.contains('show')) {
            // 点击发生在弹窗内部不关闭
            if (!sf.contains(e.target)) closeColFilter();
        }
        // 点击表格之外（含表头）的区域，清空列选区 / 单元格矩形选区
        var _hasColSel = S.colSel && S.colSel.size > 0;
        var _hasCellSel = !!S.cellSel;
        if (_hasColSel || _hasCellSel) {
            var t = e.target;
            var insideTable = t && (t.closest && t.closest('.xs-table'));
            var insideMenu = t && (t.closest && t.closest('.xs-cm'));
            var insideSf = t && (t.closest && t.closest('.xs-sf'));
            var insideModal = t && (t.closest && t.closest('.xs-modal-overlay'));
            if (!insideTable && !insideMenu && !insideSf && !insideModal) {
                if (_hasColSel) {
                    S.colSel.clear();
                    S._colSelAnchor = -1;
                    updateColSelClasses();
                }
                if (_hasCellSel) {
                    S.cellSel = null;
                    if (typeof updateCellSelClasses === 'function') updateCellSelClasses();
                }
                if (typeof updateSelectionInfo === 'function') updateSelectionInfo();
            }
        }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            hideContextMenu();
            if (isDetailModalOpen()) closeDetailModal();
            if (isXsPromptOpen()) closeXsPrompt(false);
            // ESC 也关闭查找面板
            var fp = document.getElementById('findPanel');
            if (fp && fp.classList.contains('show')) closeFindPanel();
            // ESC 关闭列筛选弹窗
            var sfm = document.getElementById('sortFilter');
            if (sfm && sfm.classList.contains('show')) closeColFilter();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
        }
        // Ctrl/Cmd + C：将矩形选区写入系统剪贴板（TSV，可粘贴到 Excel/编辑器）
        // 同时 copyCell() 维护内部 S.clip，供表内右键粘贴使用
        if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && !e.shiftKey && !e.altKey) {
            // 编辑态/弹窗内/输入控件内不拦截，走浏览器默认复制
            if (S.editing || S._detailEditing || _isFocusInForm()) return;
            if (typeof _isAnyModalOpen === 'function' && _isAnyModalOpen()) return;
            var _rcCopy = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
            if (!_rcCopy) return;
            e.preventDefault();
            // 1) 维护内部剪贴板（同 copyCell：单格 → 标量；多格 → 二维数组）
            try {
                if (typeof copyCell === 'function') {
                    if (_rcCopy.r1 === _rcCopy.r2 && _rcCopy.c1 === _rcCopy.c2) {
                        S._ctxRow = _rcCopy.r1; S._ctxCol = _rcCopy.c1;
                    }
                    copyCell();
                }
            } catch (_eCopy) { }
            // 2) 写入系统剪贴板（TSV，行间 \n，列间 \t；数组用 ;\u00A0 拼接）
            //    过滤模式下（仅看失败/列筛选/搜索）只复制可见行，避免把被隐藏的成功行带入剪贴板
            try {
                var _rowsAll = (S.data && S.data.rows) || [];
                var _rowList = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
                if (!_rowList || _rowList.length === 0) {
                    _rowList = [];
                    for (var _rr = _rcCopy.r1; _rr <= _rcCopy.r2; _rr++) _rowList.push(_rr);
                }
                var _lines = [];
                for (var _ri = 0; _ri < _rowList.length; _ri++) {
                    var _r = _rowList[_ri];
                    var _line = [];
                    for (var _c = _rcCopy.c1; _c <= _rcCopy.c2; _c++) {
                        var _v = (_rowsAll[_r] && _rowsAll[_r][_c] !== undefined) ? _rowsAll[_r][_c] : '';
                        var _s;
                        if (Array.isArray(_v)) {
                            _s = (typeof formatCellValue === 'function') ? formatCellValue(_v) : _v.join('; ');
                        } else if (_v === null || _v === undefined) {
                            _s = '';
                        } else {
                            _s = String(_v);
                        }
                        // TSV：单元格内的 \t / \r / \n 统一替换为空格，避免列错位
                        _s = _s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
                        _line.push(_s);
                    }
                    _lines.push(_line.join('\t'));
                }
                var _tsv = _lines.join('\n');
                var _rowsCnt = _lines.length;
                var _colsCnt = (_rcCopy.c2 - _rcCopy.c1 + 1);
                if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(_tsv).then(function () {
                        if (typeof showToast === 'function') showToast('已复制 ' + _rowsCnt + ' 行 × ' + _colsCnt + ' 列', 'success');
                    }, function () {
                        if (typeof showToast === 'function') showToast('复制到系统剪贴板失败', 'error');
                    });
                } else {
                    // 兜底：通过临时 textarea + execCommand
                    var _ta = document.createElement('textarea');
                    _ta.value = _tsv;
                    _ta.style.position = 'fixed';
                    _ta.style.left = '-9999px';
                    document.body.appendChild(_ta);
                    _ta.select();
                    var _ok = false;
                    try { _ok = document.execCommand('copy'); } catch (_e2) { }
                    document.body.removeChild(_ta);
                    if (typeof showToast === 'function') {
                        showToast(_ok ? ('已复制 ' + _rowsCnt + ' 行 × ' + _colsCnt + ' 列') : '复制到系统剪贴板失败', _ok ? 'success' : 'error');
                    }
                }
            } catch (_eClip) { }
            return;
        }
        // Ctrl/Cmd + A：全选当前表格的单元格矩形（非编辑态、不在输入控件内）
        // 过滤模式下（搜索/列筛选/仅看失败）只全选可见行，避免把被隐藏的行也纳入选区
        if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !e.shiftKey && !e.altKey) {
            if (S.editing || S._detailEditing || _isFocusInForm()) return;
            if (typeof _isAnyModalOpen === 'function' && _isAnyModalOpen()) return;
            var _rowsAllA = (S.data && S.data.rows) || [];
            var _hdrsA = (S.data && S.data.headers) || [];
            if (_rowsAllA.length === 0 || _hdrsA.length === 0) return;
            e.preventDefault();
            // 取当前可见的原始行号列表；若尚未渲染过则退化为整表
            var _viewA = (S._viewRows && S._viewRows.length) ? S._viewRows : null;
            var _firstR, _lastR;
            S.sel = new Set();
            if (_viewA) {
                _firstR = _viewA[0];
                _lastR = _viewA[_viewA.length - 1];
                for (var _vi = 0; _vi < _viewA.length; _vi++) S.sel.add(_viewA[_vi]);
            } else {
                _firstR = 0;
                _lastR = _rowsAllA.length - 1;
                for (var _i = 0; _i < _rowsAllA.length; _i++) S.sel.add(_i);
            }
            S.cellSel = {
                anchor: { r: _firstR, c: 0 },
                focus: { r: _lastR, c: _hdrsA.length - 1 }
            };
            // 同步列选集合
            S.colSel = new Set();
            for (var _j = 0; _j < _hdrsA.length; _j++) S.colSel.add(_j);
            S._colSelAnchor = 0;
            if (typeof updateCellSelClasses === 'function') updateCellSelClasses();
            if (typeof updateRowSelClasses === 'function') updateRowSelClasses();
            if (typeof updateColSelClasses === 'function') updateColSelClasses();
            if (typeof updateSelectionInfo === 'function') updateSelectionInfo();
            if (typeof updatePushBtn === 'function') updatePushBtn();
            return;
        }
        // Ctrl/Cmd + V：从系统剪贴板读取 TSV 并粘贴到选区左上角
        if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && !e.shiftKey && !e.altKey) {
            if (S.editing || S._detailEditing || _isFocusInForm()) return;
            if (typeof _isAnyModalOpen === 'function' && _isAnyModalOpen()) return;
            var _rcPaste = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
            if (!_rcPaste) return;
            e.preventDefault();
            if (!(navigator && navigator.clipboard && navigator.clipboard.readText)) {
                if (typeof showToast === 'function') showToast('当前环境不支持读取系统剪贴板，请使用右键菜单粘贴', 'error');
                return;
            }
            navigator.clipboard.readText().then(function (text) {
                if (text === null || text === undefined) text = '';
                var rows = (S.data && S.data.rows) || [];
                var headers = (S.data && S.data.headers) || [];
                if (rows.length === 0 || headers.length === 0) return;
                // 解析 TSV：行用 \r?\n 切，列用 \t 切
                var grid;
                if (text === '') {
                    grid = [['']];
                } else {
                    // 去掉末尾多余的空行（很多剪贴板会带一个尾随换行）
                    var raw = text.replace(/\r\n?/g, '\n');
                    if (raw.length > 0 && raw.charAt(raw.length - 1) === '\n') raw = raw.slice(0, -1);
                    grid = raw.split('\n').map(function (line) { return line.split('\t'); });
                }
                if (!grid.length) return;
                // 单格内容 + 多格选区 → 把这 1 格填充到整个选区（Excel 行为）
                var singleCell = grid.length === 1 && grid[0].length === 1;
                var multiSel = (_rcPaste.r1 !== _rcPaste.r2 || _rcPaste.c1 !== _rcPaste.c2);
                pushHistory();
                var changed = 0, skippedTsId = false;
                if (singleCell && multiSel) {
                    var src0 = grid[0][0];
                    // 过滤模式（仅看失败/列筛选/搜索）下行号在原始空间跳号；
                    // 用 getSelRectRows() 拿到与 _viewRows 求交后的真实可见行列表，避免把值刷到被隐藏的行。
                    var _rowListV = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
                    if (!_rowListV || _rowListV.length === 0) {
                        _rowListV = [];
                        for (var _vrr = _rcPaste.r1; _vrr <= _rcPaste.r2; _vrr++) _rowListV.push(_vrr);
                    }
                    for (var _vi2 = 0; _vi2 < _rowListV.length; _vi2++) {
                        var rr = _rowListV[_vi2];
                        var rowR = rows[rr]; if (!rowR) continue;
                        for (var cc = _rcPaste.c1; cc <= _rcPaste.c2; cc++) {
                            if (isFrozenCol(cc)) { skippedTsId = true; continue; }
                            var isArrT = typeof isArrayCol === 'function' && isArrayCol(cc);
                            var nv;
                            if (isArrT) {
                                nv = (src0 === '' || src0 == null) ? [] : String(src0).split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                            } else {
                                nv = (src0 == null) ? '' : String(src0);
                            }
                            rowR[cc] = nv;
                            S.mods.add(rr + ',' + cc);
                            changed++;
                        }
                    }
                } else {
                    // 矩形铺贴：从选区左上角开始
                    // 过滤模式（仅看失败/列筛选/搜索）下，被隐藏的行不接收粘贴；
                    // 按 _viewRows 顺序找到 startR 后的连续可见行作为目标行序列（与 Excel AutoFilter 行为一致）。
                    var startR = _rcPaste.r1, startC = _rcPaste.c1;
                    var _allLenP = rows.length;
                    var _vrP = S._viewRows;
                    var _useFilterP = !!(_vrP && _vrP.length && _vrP.length < _allLenP);
                    var _targetRows = [];
                    if (_useFilterP) {
                        // 在 _viewRows 中找到 startR 的位置；若 startR 自身被隐藏（异常情况），从其后第一个可见行开始
                        var _startIdx = -1;
                        for (var _si = 0; _si < _vrP.length; _si++) {
                            if (_vrP[_si] >= startR) { _startIdx = _si; break; }
                        }
                        if (_startIdx >= 0) {
                            for (var _ti = 0; _ti < grid.length && (_startIdx + _ti) < _vrP.length; _ti++) {
                                _targetRows.push(_vrP[_startIdx + _ti]);
                            }
                        }
                    } else {
                        for (var _ti2 = 0; _ti2 < grid.length; _ti2++) {
                            var _r0 = startR + _ti2;
                            if (_r0 >= _allLenP) break;
                            _targetRows.push(_r0);
                        }
                    }
                    for (var i = 0; i < _targetRows.length; i++) {
                        var rIdx = _targetRows[i];
                        var rowi = rows[rIdx];
                        if (!rowi) continue;
                        for (var j = 0; j < grid[i].length; j++) {
                            var cIdx = startC + j;
                            if (cIdx >= headers.length) break;
                            if (isFrozenCol(cIdx)) { skippedTsId = true; continue; }
                            var isArrT2 = typeof isArrayCol === 'function' && isArrayCol(cIdx);
                            var src = grid[i][j];
                            var nv2;
                            if (isArrT2) {
                                nv2 = (src === '' || src == null) ? [] : String(src).split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                            } else {
                                nv2 = (src == null) ? '' : String(src);
                            }
                            rowi[cIdx] = nv2;
                            S.mods.add(rIdx + ',' + cIdx);
                            changed++;
                        }
                    }
                    // 把选区扩展为粘贴覆盖区域，方便用户看清范围；
                    // 过滤模式下 endR 取目标可见行序列的最后一行（中间隐藏行也包含在矩形可视范围内是可以接受的）。
                    var endR;
                    if (_targetRows.length > 0) {
                        endR = _targetRows[_targetRows.length - 1];
                    } else {
                        endR = startR;
                    }
                    var maxCols = 0;
                    for (var k = 0; k < grid.length; k++) if (grid[k].length > maxCols) maxCols = grid[k].length;
                    var endC = Math.min(headers.length - 1, startC + Math.max(1, maxCols) - 1);
                    S.cellSel = { anchor: { r: startR, c: startC }, focus: { r: endR, c: endC } };
                }
                saveFile();
                renderTable();
                var msg = '已粘贴 ' + changed + ' 个单元格';
                if (skippedTsId) msg += '（testcase_id 列已跳过）';
                if (typeof showToast === 'function') showToast(msg, 'success');
            }).catch(function (err) {
                if (typeof showToast === 'function') showToast('读取剪贴板失败：' + (err && err.message ? err.message : err), 'error');
            });
            return;
        }
        // Delete / Backspace：清空当前矩形选区（非编辑态）
        if ((e.key === 'Delete' || e.key === 'Backspace') && !S.editing && !S._detailEditing) {
            // 避免在 input/textarea/contenteditable 内拦截删除键
            if (!_isFocusInForm() && typeof getCellSelRect === 'function' && getCellSelRect()) {
                e.preventDefault();
                if (typeof clearCell === 'function') {
                    var _rc3 = getCellSelRect();
                    // 单格选区：走 ctxRow/ctxCol 分支；多格选区：走矩形分支
                    if (_rc3.r1 === _rc3.r2 && _rc3.c1 === _rc3.c2) {
                        S._ctxRow = _rc3.r1; S._ctxCol = _rc3.c1;
                    }
                    clearCell();
                }
            }
        }
        // Ctrl/Cmd + F 快捷键打开查找替换
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            // 避免在 prompt 弹窗/明细弹窗中拦截
            if (typeof _isAnyModalOpen === 'function' && _isAnyModalOpen()) return;
            e.preventDefault();
            openFindPanel();
        }
        // 撤销 / 重做：Ctrl/Cmd+Z 撤销；Ctrl+Y 或 Ctrl/Cmd+Shift+Z 重做
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            var k = (e.key || '').toLowerCase();
            if (k === 'z' && !e.shiftKey) {
                if (typeof _isAnyModalOpen === 'function' && _isAnyModalOpen()) return;
                if (S.editing || S._detailEditing) return;
                e.preventDefault();
                undo();
                return;
            }
            if (k === 'y' || (k === 'z' && e.shiftKey)) {
                if (typeof _isAnyModalOpen === 'function' && _isAnyModalOpen()) return;
                if (S.editing || S._detailEditing) return;
                e.preventDefault();
                redo();
                return;
            }
        }
    });
    bindDetailModal();
    bindXsPrompt();
    bindCloseFindOnTableClick();
}

// bindTable：使用「事件委托」一次性把所有交互事件挂到 #tableContainer 上，
// 之后任意次数的 renderTable / patchCell 都不再需要重新绑定，绑定开销与
// 表格规模（行数 × 列数）无关，单次重绘也不会因 addEventListener 海量调用而卡顿。
function bindTable() {
    var cont = document.getElementById('tableContainer');
    if (!cont) return;
    if (cont._xsTableDelegated) return; // 仅绑定一次
    cont._xsTableDelegated = true;

    // ---------- click ----------
    cont.addEventListener('click', function (e) {
        var t = e.target;
        if (!t) return;

        // 1) 列筛选漏斗（含内部 svg/path）
        var fb = t.closest && t.closest('.xs-th-filter');
        if (fb) {
            e.stopPropagation();
            e.preventDefault();
            var ci = parseInt(fb.getAttribute('data-filter-col'), 10);
            if (!isNaN(ci)) openColFilter(ci, fb);
            return;
        }
        // 2) 明细链接：必须先于 cell click 处理
        var dlink = t.closest && t.closest('.xs-detail-link');
        if (dlink) {
            e.stopPropagation();
            var dri = parseInt(dlink.getAttribute('data-detail-row'), 10);
            var dci = parseInt(dlink.getAttribute('data-detail-col'), 10);
            var headers = (S.data && S.data.headers) || [];
            var field = (!isNaN(dci) && headers[dci] !== undefined) ? headers[dci] : '';
            openDetailModal(dri, field);
            return;
        }
        // 注：单元格选中、行选中都在 mousedown 阶段处理（跟 Excel 一致），
        // 不再在 click 中处理单元格，避免重复设置选区。
    });

    // ---------- dblclick ----------
    cont.addEventListener('dblclick', function (e) {
        var t = e.target;
        if (!t) return;
        // 双击列宽拖手柄 → 自适应列宽（按当前可见行内容计算）
        var crz = t.closest && t.closest('.xs-resizer');
        if (crz) {
            if (typeof autoFitColumn === 'function') autoFitColumn(_pseudoEvt(e, crz));
            return;
        }
        // 双击行高拖手柄 → 重置行高
        var rh = t.closest && t.closest('.xs-row-resizer');
        if (rh) {
            var tr = rh.closest('tr');
            if (tr) resetRowHeight(_pseudoEvt(e, rh));
            return;
        }
        // 双击行号格（非拖手柄区域）→ 重置行高
        var cbTd = t.closest && t.closest('td.xs-td-cb');
        if (cbTd) { resetRowHeight(_pseudoEvt(e, cbTd)); return; }
        // 单元格双击 → 编辑
        var cellEl = t.closest && t.closest('.xs-editable');
        if (cellEl) { onCellDblClick(_pseudoEvt(e, cellEl)); return; }
    });

    // ---------- contextmenu ----------
    cont.addEventListener('contextmenu', function (e) {
        var t = e.target;
        if (!t) return;
        var tdth = t.closest && t.closest('.xs-table th, .xs-table td');
        if (tdth) showContextMenu(_pseudoEvt(e, tdth));
    });

    // ---------- mousedown ----------
    cont.addEventListener('mousedown', function (e) {
        var t = e.target;
        if (!t) return;
        // 列宽拖动 resizer
        var rz = t.closest && t.closest('.xs-resizer');
        if (rz) { startColResize(_pseudoEvt(e, rz)); return; }
        // 漏斗按钮：阻止冒泡，避免触发列头 mousedown
        var fb2 = t.closest && t.closest('.xs-th-filter');
        if (fb2) { e.stopPropagation(); return; }
        // 左上角 # 角格：点击 = 全选整表（与 Excel 一致）
        var corner = t.closest && t.closest('th.xs-th-rownum');
        if (corner && e.button === 0) {
            e.preventDefault();
            selectAllCells();
            return;
        }
        // 列头 mousedown（列连选）
        var th = t.closest && t.closest('th.xs-th');
        if (th && th.hasAttribute('data-col')) {
            onColHeaderMouseDown(_pseudoEvt(e, th));
            return;
        }
        // 行高拖手柄优先：贴近 td 底部的 4px 拖手柄才启动行高拖动
        var rrz = t.closest && t.closest('.xs-row-resizer');
        if (rrz) { startRowResize(_pseudoEvt(e, rrz)); return; }
        // 行号格 mousedown：选行 + 横扫多选
        var cbTd2 = t.closest && t.closest('td.xs-td-cb');
        if (cbTd2) {
            onRowNumMouseDown(_pseudoEvt(e, cbTd2));
            return;
        }
        // 单元格 mousedown：矩形选区拖选
        var cellEl2 = t.closest && t.closest('.xs-editable');
        if (cellEl2) {
            // 主键才启动拖选；右键交给 contextmenu 处理
            if (e.button === 0) onCellMouseDown(_pseudoEvt(e, cellEl2));
            return;
        }
    });
}

// 构造一个"伪事件"对象：保留真实事件的所有方法/属性，但把 currentTarget 改成
// 委托命中的实际元素，便于复用既有的处理函数（它们多用 e.currentTarget）。
function _pseudoEvt(e, currentTarget) {
    return {
        target: e.target,
        currentTarget: currentTarget,
        clientX: e.clientX,
        clientY: e.clientY,
        pageX: e.pageX,
        pageY: e.pageY,
        button: e.button,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        key: e.key,
        dataTransfer: e.dataTransfer,
        preventDefault: function () { e.preventDefault(); },
        stopPropagation: function () { e.stopPropagation(); }
    };
}
