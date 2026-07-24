/* =============================================================================
 * 02b-bind.js  —— 工具栏 / 全局快捷键 / 表格事件绑定
 * -----------------------------------------------------------------------------
 * 由原 02-render-bind.js 拆分而来，包含 bindToolbar / bindDocument / bindTable
 * 三大事件绑定，以及给委托处理函数复用的 _pseudoEvt 工具方法。渲染函数与选区
 * 处理分别见 02a-render.js / 02c-row-cell-sel.js / 02d-sel-utils.js。
 * 跨文件依赖通过全局作用域共享。
 * ========================================================================== */

// ==================== 事件绑定 ====================

// 「展开步骤」按钮显隐控制：仅 YAML 文件且含 steps 字段时显示，CSV/JSON 或无 steps 列的 YAML 隐藏。
// 供 bindToolbar 初始化与 webview 切换文件（CustomEditor 复用）、数据到达刷新时统一调用。
function updateExpandStepsBtnVisibility() {
    var btn = document.getElementById('expandStepsBtn');
    if (btn) btn.style.display = (isYamlFile() && hasStepsColumn()) ? '' : 'none';
}

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
            if (S._failedOnly) { S._modifiedOnly = false; S._addedOnly = false; S._deletedOnly = false; S._markedOnly = false; }
            renderTable();
            if (S._failedOnly && S._viewRows && S._viewRows.length > 0) {
                S.sel = new Set(S._viewRows);
                updateRowSelClasses();
                updateSelectionInfo();
                updatePushBtn();
            }
        });
    }
    var modifiedFilterBtn = document.getElementById('modifiedFilterBtn');
    if (modifiedFilterBtn) {
        modifiedFilterBtn.addEventListener('click', function () {
            if (modifiedFilterBtn.classList.contains('is-disabled')) return;
            var hasModified = (typeof _getModifiedRowSet === 'function') ? _getModifiedRowSet().size > 0 : false;
            if (!hasModified) return;
            S._modifiedOnly = !S._modifiedOnly;
            // 互斥：切换仅看修改行时关闭其他筛选
            if (S._modifiedOnly) { S._failedOnly = false; S._addedOnly = false; S._deletedOnly = false; S._markedOnly = false; }
            // 不要清空 _highlightedCells：_getModifiedRowSet() 依赖它判定修改行，
            // 清空会导致 modifiedOnly 过滤条件失效，且失去单元格级差异高亮
            renderTable();
            if (S._modifiedOnly && S._viewRows && S._viewRows.length > 0) {
                S.sel = new Set(S._viewRows);
                updateRowSelClasses();
                updateSelectionInfo();
                updatePushBtn();
            }
        });
    }
    var addedFilterBtn = document.getElementById('addedFilterBtn');
    if (addedFilterBtn) {
        addedFilterBtn.addEventListener('click', function () {
            if (addedFilterBtn.classList.contains('is-disabled')) return;
            var hasAdded = !!(S._addedRowSet && S._addedRowSet.size > 0);
            if (!hasAdded) return;
            S._addedOnly = !S._addedOnly;
            if (S._addedOnly) { S._failedOnly = false; S._modifiedOnly = false; S._deletedOnly = false; S._markedOnly = false; }
            renderTable();
            if (S._addedOnly && S._viewRows && S._viewRows.length > 0) {
                S.sel = new Set(S._viewRows);
                updateRowSelClasses();
                updateSelectionInfo();
                updatePushBtn();
            }
        });
    }
    var deletedFilterBtn = document.getElementById('deletedFilterBtn');
    if (deletedFilterBtn) {
        deletedFilterBtn.addEventListener('click', function () {
            if (deletedFilterBtn.classList.contains('is-disabled')) return;
            var hasDeleted = !!(S._deletedInfos && S._deletedInfos.length > 0);
            if (!hasDeleted) return;
            S._deletedOnly = !S._deletedOnly;
            if (S._deletedOnly) { S._failedOnly = false; S._modifiedOnly = false; S._addedOnly = false; S._markedOnly = false; }
            renderTable();
        });
    }
    var markedFilterBtn = document.getElementById('markedFilterBtn');
    if (markedFilterBtn) {
        markedFilterBtn.addEventListener('click', function () {
            if (markedFilterBtn.classList.contains('is-disabled')) return;
            var hasMarked = (typeof _countMarkedRows === 'function') ? _countMarkedRows() > 0 : false;
            if (!hasMarked) return;
            S._markedOnly = !S._markedOnly;
            if (S._markedOnly) { S._failedOnly = false; S._modifiedOnly = false; S._addedOnly = false; S._deletedOnly = false; }
            renderTable();
            if (S._markedOnly && S._viewRows && S._viewRows.length > 0) {
                S.sel = new Set(S._viewRows);
                updateRowSelClasses();
                updateSelectionInfo();
                updatePushBtn();
            }
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
        // 复用公共粘贴兜底（webview 沙箱下原生 Ctrl/Cmd+V 偶发失效）
        if (typeof attachPasteFallback === 'function') attachPasteFallback(search);
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
            // 关闭所有筛选
            S._failedOnly = false;
            S._modifiedOnly = false;
            S._addedOnly = false;
            S._deletedOnly = false;
            S._markedOnly = false;
            // _deletedInfos 由后端 diff 重新下发，此处不提前清空以免渲染闪烁
            // 关闭可能打开的列筛选弹窗（若存在该函数）
            try { if (typeof closeColFilter === 'function') closeColFilter(); } catch (e) {}
            // 清掉 mods（高亮）与撤销栈：刷新后磁盘 = 内存，旧撤销点不再有意义；
            // 同时避免随后扩展端 force 推送被前端 hasUserChanges 兜底拦截。
            if (S.mods && S.mods.size > 0) S.mods.clear();
            if (S._detailModCellKeys && S._detailModCellKeys.size > 0) S._detailModCellKeys.clear();
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
    // 展开/收起步骤按钮：切换展开模式（内联子表格编辑）与非展开模式（点击弹窗编辑）
    // 「展开步骤」仅对 YAML 文件生效：CSV/JSON 的步骤列只是合并文本、无嵌套结构，点击无意义。
    var expandStepsBtn = document.getElementById('expandStepsBtn');
    if (expandStepsBtn) {
        // 非 YAML 文件直接隐藏按钮（显隐由 updateExpandStepsBtnVisibility 统一控制）
        updateExpandStepsBtnVisibility();
        expandStepsBtn.addEventListener('click', function () {
            if (!isYamlFile() || !hasStepsColumn()) return; // 双保险：非 YAML 或无 steps 列时不展开
            var headers = (S.data && S.data.headers) || [];
            var stepsCol = headers.indexOf('steps');
            if (stepsCol < 0) {
                if (typeof showToast === 'function') showToast('未找到 steps 列', 'error');
                return;
            }
            var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(stepsCol) : null;
            if (!dt || !dt.rawRowGroups) {
                if (typeof showToast === 'function') showToast('未找到 steps 明细数据', 'error');
                return;
            }
            var rows = (S.data && S.data.rows) || [];
            if (S._stepsExpanded) {
                // ── 收起：恢复为非展开模式 ──
                var collapsedCount = 0;
                for (var ri2 = 0; ri2 < rows.length; ri2++) {
                    var raws2 = dt.rawRowGroups[ri2];
                    if (!Array.isArray(raws2) || raws2.length === 0) continue;
                    // 样例数据行冻结：跳过步骤列收起写入
                    if (isFrozenRow(ri2)) continue;
                    var count = raws2.length;
                    var collapsed = count > 0 ? '[' + count + ' 项]' : '[]';
                    if (S.data.rows[ri2][stepsCol] !== collapsed) {
                        S.data.rows[ri2][stepsCol] = collapsed;
                        collapsedCount++;
                    }
                }
                S._stepsExpanded = false;
                expandStepsBtn.textContent = '展开步骤';
                // 立即持久化：避免用户点击后立刻关闭 Tab 导致 debounce（600ms）窗口未完成、
                // 展开态记忆丢失。renderTable 之前调用即可，setState 是同步 API。
                if (typeof persistUiStateNow === 'function') persistUiStateNow();
                if (collapsedCount > 0) { renderTable(); }
                if (collapsedCount > 0 && typeof showToast === 'function') {
                    showToast('已收起 ' + collapsedCount + ' 行步骤', 'info');
                }
            } else {
                // ── 展开：每步骤内联描述+预期结果，层次自然清晰 ──
                var expandedCount = 0;
                for (var ri = 0; ri < rows.length; ri++) {
                    var raws = dt.rawRowGroups[ri];
                    if (!Array.isArray(raws) || raws.length === 0) continue;
                    // 样例数据行冻结：跳过步骤列展开写入
                    if (isFrozenRow(ri)) continue;
                    var combined = _buildStepCombined(raws);
                    if (combined) {
                        S.data.rows[ri][stepsCol] = combined;
                        expandedCount++;
                    }
                }
                S._stepsExpanded = true;
                expandStepsBtn.textContent = '收起步骤';
                // 立即持久化：同收起分支，防止 debounce 窗口内关 Tab 丢失展开态。
                if (typeof persistUiStateNow === 'function') persistUiStateNow();
                if (expandedCount > 0) { renderTable(); }
                // 展开后：主 steps 列宽 = 5 子列之和（默认 404，若用户之前拖过则为持久化值）。
                // 注意：DOM 列宽由 _buildSkeletonHtml 的 colgroup 直接设置，无需再操作 <col> 元素，避免时序问题。
                setTimeout(function () {
                    var totalW = (typeof _getStepsTotalW === 'function') ? _getStepsTotalW() : 404;
                    var currentW = S.colWidths && S.colWidths[stepsCol] ? S.colWidths[stepsCol] : 160;
                    if (currentW !== totalW) {
                        S.colWidths[stepsCol] = totalW;
                        if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
                    }
                }, 100);
                if (typeof showToast === 'function') showToast('已展开 ' + expandedCount + ' 行步骤', 'info');
            }
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
            // 维护内部剪贴板 + 系统剪贴板（copyCell 已统一处理两者的写入）
            try {
                if (typeof copyCell === 'function') {
                    if (_rcCopy.r1 === _rcCopy.r2 && _rcCopy.c1 === _rcCopy.c2) {
                        S._ctxRow = _rcCopy.r1; S._ctxCol = _rcCopy.c1;
                    }
                    copyCell();
                }
            } catch (_eCopy) { }
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
                var changed = 0, skippedTsId = false, skippedDetailSysPaste1 = false, skippedDetailSysPaste2 = false;
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
                        // 样例数据行冻结：粘贴跳过该行
                        if (isFrozenRow(rr)) continue;
                        for (var cc = _rcPaste.c1; cc <= _rcPaste.c2; cc++) {
                            if (isFrozenCol(cc)) { skippedTsId = true; continue; }
                            var isArrT = typeof isArrayCol === 'function' && isArrayCol(cc);
                            // 尝试将 src0 解析为对象 / 对象数组（支持表内 Ctrl+C / 外部粘贴 JSON）
                            var _parsed0;
                            var _strSrc0 = (src0 == null) ? '' : String(src0);
                            if (_strSrc0 && (_strSrc0.charAt(0) === '{' || _strSrc0.charAt(0) === '[')) {
                                try { _parsed0 = JSON.parse(_strSrc0); } catch (_ep0) { _parsed0 = undefined; }
                            }
                            // detail 列：若解析出对象 / 对象数组，写入 detail 表
                            var _isDetailT = (typeof isDetailColumn === 'function') && isDetailColumn(cc);
                            if (_isDetailT && _parsed0 && (Array.isArray(_parsed0) || typeof _parsed0 === 'object')) {
                                var _hasObjP = false;
                                if (Array.isArray(_parsed0)) {
                                    for (var _xpi = 0; _xpi < _parsed0.length; _xpi++) { if (_parsed0[_xpi] && typeof _parsed0[_xpi] === 'object') { _hasObjP = true; break; } }
                                } else { _hasObjP = true; }
                                if (_hasObjP && typeof _writeDetailCellFromRaw === 'function' && _writeDetailCellFromRaw(rr, cc, _parsed0)) {
                                    changed++;
                                    continue;
                                }
                            }
                            // 明细列 + 非对象/对象数组剪贴板（如 Excel 纯 TSV）：
                            // 写字符串会与 rawRowGroups 不一致（yaml-parser 优先 raw），跳过。
                            if (_isDetailT) {
                                skippedDetailSysPaste1 = true;
                                continue;
                            }
                            var nv;
                            if (isArrT) {
                                if (Array.isArray(_parsed0)) {
                                    nv = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(_parsed0) : _parsed0;
                                } else {
                                    nv = (src0 === '' || src0 == null) ? [] : _strSrc0.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                                }
                            } else if (_parsed0 && typeof _parsed0 === 'object') {
                                nv = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(_parsed0) : _parsed0;
                            } else {
                                nv = (src0 == null) ? '' : _strSrc0;
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
                        // 样例数据行冻结：粘贴跳过该行
                        if (isFrozenRow(rIdx)) continue;
                        for (var j = 0; j < grid[i].length; j++) {
                            var cIdx = startC + j;
                            if (cIdx >= headers.length) break;
                            if (isFrozenCol(cIdx)) { skippedTsId = true; continue; }
                            var isArrT2 = typeof isArrayCol === 'function' && isArrayCol(cIdx);
                            var src = grid[i][j];
                            // 尝试将 src 解析为对象 / 对象数组
                            var _parsed;
                            var _strSrc = (src == null) ? '' : String(src);
                            if (_strSrc && (_strSrc.charAt(0) === '{' || _strSrc.charAt(0) === '[')) {
                                try { _parsed = JSON.parse(_strSrc); } catch (_ep) { _parsed = undefined; }
                            }
                            // detail 列：写入 detail 表
                            var _isDetailT2 = (typeof isDetailColumn === 'function') && isDetailColumn(cIdx);
                            if (_isDetailT2 && _parsed && (Array.isArray(_parsed) || typeof _parsed === 'object')) {
                                var _hasObjP2 = false;
                                if (Array.isArray(_parsed)) {
                                    for (var _xpi2 = 0; _xpi2 < _parsed.length; _xpi2++) { if (_parsed[_xpi2] && typeof _parsed[_xpi2] === 'object') { _hasObjP2 = true; break; } }
                                } else { _hasObjP2 = true; }
                                if (_hasObjP2 && typeof _writeDetailCellFromRaw === 'function' && _writeDetailCellFromRaw(rIdx, cIdx, _parsed)) {
                                    changed++;
                                    continue;
                                }
                            }
                            // 同上：明细列 + 非对象/对象数组剪贴板跳过
                            if (_isDetailT2) {
                                skippedDetailSysPaste2 = true;
                                continue;
                            }
                            var nv2;
                            if (isArrT2) {
                                if (Array.isArray(_parsed)) {
                                    nv2 = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(_parsed) : _parsed;
                                } else {
                                    nv2 = (src === '' || src == null) ? [] : _strSrc.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                                }
                            } else if (_parsed && typeof _parsed === 'object') {
                                nv2 = (typeof _deepCloneCellValue === 'function') ? _deepCloneCellValue(_parsed) : _parsed;
                            } else {
                                nv2 = (src == null) ? '' : _strSrc;
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
                var sysPasteSuffix = [];
                if (skippedTsId) sysPasteSuffix.push('testcase_id 列已跳过');
                if (skippedDetailSysPaste1 || skippedDetailSysPaste2) sysPasteSuffix.push('明细列已跳过，请通过弹窗编辑');
                if (sysPasteSuffix.length > 0) msg += '（' + sysPasteSuffix.join('；') + '）';
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
        // ⚠ macOS 推荐使用 Cmd+Shift+Z 进行重做（部分中文输入法/系统快捷键会拦截 Cmd+Y）。
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            var k = (e.key || '').toLowerCase();
            if (k === 'z' && !e.shiftKey) {
                if (typeof _isAnyModalOpen === 'function' && _isAnyModalOpen()) return;
                if (S.editing || S._detailEditing) return;
                // 焦点在原生 input/textarea/contenteditable 中：交给浏览器默认 undo，
                // 避免与 webview 表格级 undo 双触发。
                if (typeof _isFocusInForm === 'function' && _isFocusInForm()) return;
                e.preventDefault();
                undo();
                return;
            }
            if (k === 'y' || (k === 'z' && e.shiftKey)) {
                if (typeof _isAnyModalOpen === 'function' && _isAnyModalOpen()) return;
                if (S.editing || S._detailEditing) return;
                if (typeof _isFocusInForm === 'function' && _isFocusInForm()) return;
                e.preventDefault();
                redo();
                return;
            }
        }
    });
    // 子表格编辑：focusout 捕获子表格单元格编辑完成（blur 不冒泡，用 focusout 代替）
    document.addEventListener('focusout', function (e) {
        var td = e.target;
        if (!td || !td.closest || !td.closest('.xse-table')) return;
        if (td.getAttribute('contenteditable') !== 'true') return;
        setTimeout(function () { _handleSubTableCellEdit(td); }, 0);
    });
    bindDetailModal();
    bindXsPrompt();
    bindCloseFindOnTableClick();
    bindFindPanelResize();
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

        // 0) 就近收起/展开步骤按钮（位于 steps 主表头内）：
        //    - .xs-th-group-collapse: 展开态下的收起按钮（顶部条右上角）
        //    - .xs-th-inline-expand:  未展开态下的展开按钮（xs-th-inner 内 flex 项）
        //    两者都触发工具栏 #expandStepsBtn 的 click，复用同一套展开/收起逻辑
        var cbtn = t.closest && (t.closest('.xs-th-group-collapse') || t.closest('.xs-th-inline-expand'));
        if (cbtn) {
            // 「展开步骤」仅 YAML 且含 steps 列时生效：此处双保险拦截
            if (!isYamlFile() || !hasStepsColumn()) return;
            e.stopPropagation();
            e.preventDefault();
            var toolBtn = document.getElementById('expandStepsBtn');
            if (toolBtn) toolBtn.click();
            return;
        }
        // 0.5) 子列宽拖手柄：只在 mousedown 生效，click 阻止冒泡即可，防止误触发筛选/列选
        var subRz0 = t.closest && t.closest('.xs-sub-resizer');
        if (subRz0) { e.stopPropagation(); e.preventDefault(); return; }

        // 0.8) steps 子列筛选漏斗（.xs-sub-filter，含内部 svg/path）：
        //      必须放在 .xs-th-filter 之前判断——两者都在 steps 主 th 内，
        //      但 .xs-sub-filter 是子表头漏斗（data-sub-filter-idx），走独立 openStepsSubFilter
        var sfb = t.closest && t.closest('.xs-sub-filter');
        if (sfb) {
            e.stopPropagation();
            e.preventDefault();
            var subFI = parseInt(sfb.getAttribute('data-sub-filter-idx'), 10);
            if (!isNaN(subFI) && typeof openStepsSubFilter === 'function') openStepsSubFilter(subFI, sfb);
            return;
        }

        // 1) 列筛选漏斗（含内部 svg/path）
        var fb = t.closest && t.closest('.xs-th-filter');
        if (fb) {
            e.stopPropagation();
            e.preventDefault();
            var ci = parseInt(fb.getAttribute('data-filter-col'), 10);
            if (!isNaN(ci)) openColFilter(ci, fb);
            return;
        }
        // 2a) 子表格操作按钮（复制/添加/删除步骤）：必须在展开块处理之前
        var xseBtnCopy = t.closest && t.closest('.xse-btn-copy');
        if (xseBtnCopy) {
            e.stopPropagation();
            e.preventDefault();
            var copyStep = parseInt(xseBtnCopy.getAttribute('data-xse-copy'), 10);
            var xseContainer = xseBtnCopy.closest('.xs-step-expanded');
            if (xseContainer && !isNaN(copyStep)) {
                var dri0 = parseInt(xseContainer.getAttribute('data-detail-row'), 10);
                var dci0 = parseInt(xseContainer.getAttribute('data-detail-col'), 10);
                _copySubStep(dri0, dci0, copyStep);
            }
            return;
        }
        var xseBtnDel = t.closest && t.closest('.xse-btn-del');
        if (xseBtnDel) {
            e.stopPropagation();
            e.preventDefault();
            var delStep = parseInt(xseBtnDel.getAttribute('data-xse-del'), 10);
            var xseContainer = xseBtnDel.closest('.xs-step-expanded');
            if (xseContainer && !isNaN(delStep)) {
                var dri2 = parseInt(xseContainer.getAttribute('data-detail-row'), 10);
                var dci2 = parseInt(xseContainer.getAttribute('data-detail-col'), 10);
                _delSubStep(dri2, dci2, delStep);
            }
            return;
        }
        var xseBtnAdd = t.closest && t.closest('.xse-btn-add');
        if (xseBtnAdd) {
            e.stopPropagation();
            e.preventDefault();
            var addStep = parseInt(xseBtnAdd.getAttribute('data-xse-add'), 10);
            var xseContainer2 = xseBtnAdd.closest('.xs-step-expanded');
            if (xseContainer2 && !isNaN(addStep)) {
                var dri3 = parseInt(xseContainer2.getAttribute('data-detail-row'), 10);
                var dci3 = parseInt(xseContainer2.getAttribute('data-detail-col'), 10);
                _addSubStep(dri3, dci3, addStep);
            }
            return;
        }
        // 展开子表格 - 添加分组按钮（UI 检查 / 接口调用 / 数据检查）：
        //   点击后仅在 DOM 层原地插入"chip 标题 + 空可编辑行"，
        //   同时移除刚点击的按钮；若一行按钮全部被移除，则移除整行容器。
        //   数据层不做修改：用户输入内容后 focusout 时会由 _handleSubTableCellEdit
        //   按新 DOM 结构写回 step.ui_expected / api_expected / db_expected；
        //   若用户不输入直接失焦，DOM 变更不进入数据模型，下次渲染回归按钮样式。
        var xseBtnAddGroup = t.closest && t.closest('.xse-btn-add-group');
        if (xseBtnAddGroup) {
            e.stopPropagation();
            e.preventDefault();
            var _kind = xseBtnAddGroup.getAttribute('data-xse-add-group-kind');
            var _titleByKind = { 'ui': '【UI检查】', 'api': '【接口调用】', 'data': '【数据检查】' };
            var _title = _titleByKind[_kind];
            if (!_title) return;
            var _addRow = xseBtnAddGroup.closest('.xse-add-group-row');
            var _td = xseBtnAddGroup.closest('.xse-td-expected');
            if (!_td || !_addRow) return;
            // 构造新分组 DOM
            var _newGroup = document.createElement('div');
            _newGroup.className = 'xse-group';
            var _sub = document.createElement('div');
            _sub.className = 'xse-sub';
            _sub.setAttribute('contenteditable', 'false');
            _sub.setAttribute('data-kind', _kind);
            _sub.textContent = _title;
            var _line = document.createElement('div');
            _line.className = 'xse-line';
            _newGroup.appendChild(_sub);
            _newGroup.appendChild(_line);
            // 插入到 add-row 之前，保持"已填在上、按钮在下"的视觉顺序
            _td.insertBefore(_newGroup, _addRow);
            // 移除本按钮；如果按钮行清空，整行移除
            xseBtnAddGroup.parentNode.removeChild(xseBtnAddGroup);
            if (!_addRow.querySelector('.xse-btn-add-group')) {
                _addRow.parentNode.removeChild(_addRow);
            }
            // 聚焦到新空行，方便用户直接输入
            try {
                _td.focus();
                var _range = document.createRange();
                _range.selectNodeContents(_line);
                _range.collapse(true);
                var _sel = window.getSelection();
                _sel.removeAllRanges();
                _sel.addRange(_range);
            } catch (_err) { /* 聚焦失败降级为无操作 */ }
            return;
        }
        // 2b) 明细链接（含已展开步骤的结构化块）：必须先于 cell click 处理
        var dlink = t.closest && t.closest('.xs-detail-link');
        if (!dlink) dlink = t.closest && t.closest('.xs-step-expanded');
        if (dlink) {
            e.stopPropagation();
            // 展开模式下子表格内联编辑，不弹出明细弹窗；操作按钮已在 2a 处理
            if (S._stepsExpanded) return;
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
        // 双击列头（非漏斗按钮区域、非角格）→ 自适应列宽（toggle）
        // 与 Excel 体验一致：列头空白处或文字处双击均可触发，不必精确命中右侧 8px 拖手柄
        var thHit = t.closest && t.closest('th.xs-th');
        if (thHit && thHit.hasAttribute('data-col')) {
            // 排除：漏斗按钮（避免与筛选交互冲突）与子列漏斗，与子列宽拖手柄
            var inFilter = t.closest && t.closest('.xs-th-filter');
            var inSubFilter = t.closest && t.closest('.xs-sub-filter');
            var inSubRz = t.closest && t.closest('.xs-sub-resizer');
            // 双击 steps 展开态子表头 → 自适应该子列宽（先于主列 autoFit 拦截）
            var subTh = t.closest && t.closest('.xs-th-sub');
            if (subTh && subTh.hasAttribute('data-sub-idx') && !inSubFilter && !inSubRz) {
                var _subIdx = parseInt(subTh.getAttribute('data-sub-idx'), 10);
                if (!isNaN(_subIdx) && typeof autoFitStepsSubCol === 'function') {
                    e.preventDefault();
                    e.stopPropagation();
                    autoFitStepsSubCol(_subIdx);
                }
                return;
            }
            if (!inFilter && !inSubFilter && !inSubRz && typeof autoFitColumn === 'function') {
                // autoFitColumn 内部以 e.currentTarget 的 data-col 为准；
                // 用列头自身的 .xs-resizer 作为 currentTarget 以拿到 data-col；
                // 若不存在 resizer，则用 th 本身（th 上同样含 data-col）。
                var rzInTh = thHit.querySelector('.xs-resizer') || thHit;
                autoFitColumn(_pseudoEvt(e, rzInTh));
            }
            return;
        }
        // 单元格双击 → 编辑（展开模式子表格内联编辑时不触发外层单元格编辑）
        var inSubTable2 = t.closest && t.closest('.xse-table');
        if (!inSubTable2) {
            var cellEl = t.closest && t.closest('.xs-editable');
            if (cellEl) { onCellDblClick(_pseudoEvt(e, cellEl)); return; }
        }
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
        // 就近收起/展开按钮：阻止冒泡，避免触发列头 mousedown / 列选
        var cbtn2 = t.closest && (t.closest('.xs-th-group-collapse') || t.closest('.xs-th-inline-expand'));
        if (cbtn2) { e.stopPropagation(); return; }
        // steps 子列宽拖动 resizer：优先于主 resizer 处理，避免手柄冲突
        var subRz = t.closest && t.closest('.xs-sub-resizer');
        if (subRz) { startSubColResize(_pseudoEvt(e, subRz)); return; }
        // 列宽拖动 resizer
        var rz = t.closest && t.closest('.xs-resizer');
        if (rz) { startColResize(_pseudoEvt(e, rz)); return; }
        // 漏斗按钮：阻止冒泡，避免触发列头 mousedown
        var fb2 = t.closest && t.closest('.xs-th-filter');
        if (fb2) { e.stopPropagation(); return; }
        // 子列漏斗按钮：同样阻止冒泡，避免触发列头 mousedown/列选
        var subFb2 = t.closest && t.closest('.xs-sub-filter');
        if (subFb2) { e.stopPropagation(); return; }
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
        // 单元格 mousedown：矩形选区拖选（展开模式子表格内不触发外层选区拖选，
        // 但需将主表 active/cellSel 同步到外层 steps 单元格，实现"子表点击 = 外层大格选中"的视觉一致性）
        var inSubTable3 = t.closest && t.closest('.xse-table');
        if (inSubTable3) {
            // 子表内点击：找到外层 steps 大单元格，同步主表选区，
            // 让外层格子呈现 active/xs-cell-selected 样式；但不阻止 contenteditable 的原生编辑体验
            if (e.button === 0) {
                var outerTd = t.closest && t.closest('td.xs-editable');
                if (outerTd) {
                    var _oRi = parseInt(outerTd.getAttribute('data-row'), 10);
                    var _oCi = parseInt(outerTd.getAttribute('data-col'), 10);
                    if (!isNaN(_oRi) && !isNaN(_oCi)) {
                        // 清除旧 active，标记外层 td
                        document.querySelectorAll('.xs-editable.active').forEach(function (n) { n.classList.remove('active'); });
                        outerTd.classList.add('active');
                        S.cell = { r: _oRi, c: _oCi };
                        S.cellSel = { anchor: { r: _oRi, c: _oCi }, focus: { r: _oRi, c: _oCi } };
                        // 与主表单元格 mousedown 同规则：清行选/列选（不带 shift 时）
                        if (!e.shiftKey) {
                            S.sel.clear();
                            S.colSel.clear();
                            S._colSelAnchor = -1;
                            S._rowSelAnchor = -1;
                        }
                        if (typeof updateColSelClasses === 'function') updateColSelClasses();
                        if (typeof updateRowSelClasses === 'function') updateRowSelClasses();
                        if (typeof updateCellSelClasses === 'function') updateCellSelClasses();
                        if (typeof updateSelectionInfo === 'function') updateSelectionInfo();
                        if (typeof updatePushBtn === 'function') updatePushBtn();
                    }
                }
            }
            return;
        }
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

// ==================== 步骤展开工具函数 ====================
// 输出四列分隔格式：序号 | 步骤描述 | 数据 | 预期结果
// 每步骤用【步骤描述】标记起始，【数据】【预期结果】分隔后续内容
function _buildStepCombined(raws) {
    if (!Array.isArray(raws) || raws.length === 0) return '';
    return raws.map(function (step, _idx) {
        if (!step || typeof step !== 'object') return '';
        var lines = [];
        // 序号统一用数组索引 + 1（自然数），不再读取 step.id：
        //   历史上 step.id 可能是业务自定义标识符（如 "step001-1"），
        //   拼进 "步骤step001-1 xxx" 后无法被解析器（要求 \d+）识别，
        //   会把整行当作 desc 内容累积回 operation，形成 round-trip 污染。
        //   固定使用自然数序号后，拼接 / 解析两端语义闭合，从根本上杜绝该类问题。
        var sid = String(_idx + 1);

        // ── 【步骤描述】+ 序号 ──
        var op = (step.operation != null ? String(step.operation) : '').trim();
        lines.push('【步骤描述】');
        lines.push('步骤' + sid + (op ? ' ' + op : ''));

        // ── 数据（data 内容） ──
        var dataItems = [];
        var d = step.data;
        if (Array.isArray(d)) {
            d.forEach(function (item) {
                // 对象元素序列化为 JSON，避免 "[object Object]"（与预期结果列处理一致）
                var s = _stepCellItemToStr(item).trim();
                if (s) dataItems.push(s);
            });
        } else if (d != null && _stepCellItemToStr(d).trim() !== '') {
            _stepCellItemToStr(d).split(/\r?\n/).forEach(function (l) {
                var s = l.trim();
                if (s) dataItems.push(s);
            });
        }
        lines.push('【数据】');
        dataItems.forEach(function (v) { lines.push(v); });

        // ── 预期结果 ──
        var ui = _toExpectedLines(step.ui_expected);
        var api = _toExpectedLines(step.api_expected);
        var db = _toExpectedLines(step.db_expected);
        lines.push('【预期结果】');
        // 只输出非空分组头（配合展开子表格的"+ 添加分组"按钮交互：
        //   空分组不再渲染为撑高的 chip + 空行，改为单行按钮补齐，
        //   因此拼接文本里也不再保留空分组头，避免解析回来时被识别为"已填但空"）。
        //
        // 注意：即使全空，【预期结果】标题仍然保留，作为步骤末尾的锚点，
        //       保证 _buildStepExpandedHtml 的 section 状态机能正常推进。
        if (ui.length > 0) {
            lines.push('【UI检查】');
            ui.forEach(function (v) { lines.push(String(v)); });
        }
        if (api.length > 0) {
            lines.push('【接口调用】');
            api.forEach(function (v) { lines.push(String(v)); });
        }
        if (db.length > 0) {
            lines.push('【数据检查】');
            db.forEach(function (v) { lines.push(String(v)); });
        }

        return lines.join('\n');
    }).filter(function (s) { return s !== ''; }).join('\n');
}

// 将步骤单元格（data / ui_expected / api_expected / db_expected）里的单个元素转为字符串。
// 参照后端 formatDetailCellValue / toStr 的处理：对象/数组元素序列化为 JSON，
// 避免 YAML 中预期值为对象时被 String() 转成 "[object Object]"。
function _stepCellItemToStr(x) {
    if (x == null) return '';
    if (typeof x === 'object') {
        try { return JSON.stringify(x); } catch (_e) { return ''; }
    }
    return String(x);
}

function _toExpectedLines(v) {
    if (v == null) return [];
    if (Array.isArray(v)) {
        return v.map(_stepCellItemToStr).filter(function (s) { return s.trim() !== ''; });
    }
    var s = _stepCellItemToStr(v).trim();
    return s ? [s] : [];
}

// ==================== 子表格步骤增删 ====================
// 在 rawRowGroups 指定索引后插入一个新空步骤，重建合并文本后 patchCell 原地刷新
function _addSubStep(ri, ci, stepIdx) {
    var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
    if (!dt || !dt.rawRowGroups) return;
    if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
    var raws = dt.rawRowGroups[ri];
    if (stepIdx < 0 || stepIdx >= raws.length) return;
    // 不主动写 id 字段：业务自定义的 step.id 完全由 YAML 决定，
    // 新增步骤保持无 id，避免 YAML 落盘出现噪音空字段（id: ''）。
    raws.splice(stepIdx + 1, 0, { operation: '', data: [], ui_expected: [], api_expected: [], db_expected: [] });
    _syncSubSteps(ri, ci, raws);
}

// 复制 rawRowGroups 中指定索引的步骤（深拷贝），插入其后，重建合并文本后 patchCell 原地刷新
function _copySubStep(ri, ci, stepIdx) {
    var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
    if (!dt || !dt.rawRowGroups) return;
    var raws = dt.rawRowGroups[ri];
    if (!Array.isArray(raws) || stepIdx < 0 || stepIdx >= raws.length) return;
    // 深拷贝原步骤对象：保留源 step.id（若存在），符合"深拷贝"语义
    var src = raws[stepIdx];
    var cloned = {
        operation: String(src.operation != null ? src.operation : ''),
        data: Array.isArray(src.data) ? src.data.slice() : [],
        ui_expected: Array.isArray(src.ui_expected) ? src.ui_expected.slice() : [],
        api_expected: Array.isArray(src.api_expected) ? src.api_expected.slice() : [],
        db_expected: Array.isArray(src.db_expected) ? src.db_expected.slice() : []
    };
    // 仅当源 step 存在有效 id 时才拷贝，避免写入空 id
    if (src.id != null && String(src.id).trim() !== '') cloned.id = src.id;
    raws.splice(stepIdx + 1, 0, cloned);
    _syncSubSteps(ri, ci, raws);
}

// 删除 rawRowGroups 中指定索引的步骤，重建合并文本后 patchCell 原地刷新
function _delSubStep(ri, ci, stepIdx) {
    var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
    if (!dt || !dt.rawRowGroups) return;
    var raws = dt.rawRowGroups[ri];
    if (!Array.isArray(raws) || stepIdx < 0 || stepIdx >= raws.length) return;
    raws.splice(stepIdx, 1);
    // 序号不再依赖 step.id（_buildStepCombined 统一使用数组索引 + 1 拼接），
    // 不重新编号，保留剩余步骤用户业务自定义的 step.id 原值。
    _syncSubSteps(ri, ci, raws);
}

// 共享：重建合并文本、同步主表数据、标记修改、保存、原地刷新
function _syncSubSteps(ri, ci, raws) {
    var combined = _buildStepCombined(raws);
    if (typeof pushHistory === 'function') pushHistory();
    if (!S.data.rows[ri]) return;
    S.data.rows[ri][ci] = combined;
    if (S.mods) S.mods.add(ri + ',' + ci);
    if (typeof saveFile === 'function') saveFile();
    if (typeof patchCell === 'function') patchCell(ri, ci);
}

// ==================== 子表格内联编辑 ====================
// 子表格单元格 focusout 时，将编辑内容解析回 rawRowGroups 并同步主表
function _handleSubTableCellEdit(td) {
    var container = td.closest('.xs-step-expanded');
    if (!container) return;
    var ri = parseInt(container.getAttribute('data-detail-row'), 10);
    var ci = parseInt(container.getAttribute('data-detail-col'), 10);
    if (isNaN(ri) || isNaN(ci)) return;

    var stepIdx = parseInt(td.getAttribute('data-xse-step'), 10);
    var section = td.getAttribute('data-xse-section');
    if (isNaN(stepIdx) || !section) return;

    var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
    if (!dt || !dt.rawRowGroups) return;
    if (!dt.rawRowGroups[ri]) dt.rawRowGroups[ri] = [];
    var step = dt.rawRowGroups[ri][stepIdx];
    if (!step) {
        // 不主动写 id 字段：业务自定义的 step.id 完全由 YAML 决定，
        // 兜底新建保持无 id，避免 YAML 落盘出现噪音（例如 id: '3'）。
        step = { operation: '', data: [], ui_expected: [], api_expected: [], db_expected: [] };
        dt.rawRowGroups[ri][stepIdx] = step;
    }

    // 读取旧值（normalize 兜底）
    var oldOp = (step.operation != null ? String(step.operation) : '').trim();
    var oldData = Array.isArray(step.data) ? step.data : [];
    var oldUi = Array.isArray(step.ui_expected) ? step.ui_expected : [];
    var oldApi = Array.isArray(step.api_expected) ? step.api_expected : [];
    var oldDb = Array.isArray(step.db_expected) ? step.db_expected : [];

    if (section === 'desc') {
        var desc = (td.innerText || td.textContent || '').trim();
        step.operation = desc;
    } else if (section === 'data') {
        var lines = [];
        var lineEls = td.querySelectorAll('.xse-line');
        for (var li = 0; li < lineEls.length; li++) {
            var txt = (lineEls[li].innerText || lineEls[li].textContent || '').trim();
            if (txt) lines.push(txt);
        }
        // 兜底：若用户按下 Enter 产生非 .xse-line 的 div，退化为 innerText 切分
        if (lines.length === 0) {
            var raw = (td.innerText || td.textContent || '');
            lines = raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        }
        step.data = lines;
    } else if (section === 'expected') {
        var groups = td.querySelectorAll('.xse-group');
        var ui = [], api = [], db = [];
        for (var gi = 0; gi < groups.length; gi++) {
            var group = groups[gi];
            var sub = group.querySelector('.xse-sub');
            if (!sub) continue;
            var title = (sub.innerText || sub.textContent || '').trim();
            var glines = [];
            var children = group.children;
            for (var ci2 = 0; ci2 < children.length; ci2++) {
                var child = children[ci2];
                if (child.classList && child.classList.contains('xse-sub')) continue;
                if (child.classList && child.classList.contains('xse-line')) {
                    var t = (child.innerText || child.textContent || '').trim();
                    if (t) glines.push(t);
                }
            }
            if (title === '【UI检查】') ui = glines;
            else if (title === '【接口调用】') api = glines;
            else if (title === '【数据检查】') db = glines;
        }
        step.ui_expected = ui;
        step.api_expected = api;
        step.db_expected = db;
        // 清除空数组，确保不写入 YAML（显示层面由 _buildStepCombined 保证三组标题始终渲染）
        if (api.length === 0) delete step.api_expected;
        if (db.length === 0) delete step.db_expected;
        if (ui.length === 0) delete step.ui_expected;
        // 兜底：没有任何 xse-group 时（用户可能删掉了分组结构），退化为按 innerText 切分，默认归入 ui_expected。
        // 但需排除"纯占位态"：td 内只有 .xse-add-group-row（未填分组的按钮容器），
        // 此时 innerText 会包含按钮文字（"+ UI检查"等），若不排除则会被误当作用户输入写回，
        // 造成 step3 从空态被误填充为三行 "+ 分组名" 数据的 bug。
        if (groups.length === 0) {
            var _addRowOnly = td.querySelector('.xse-add-group-row');
            var _hasNonBtnContent = false;
            if (_addRowOnly) {
                // 检查 td 内除按钮行外是否还有实际文本节点/其他子元素
                var _kids = td.childNodes;
                for (var _ki = 0; _ki < _kids.length; _ki++) {
                    var _kid = _kids[_ki];
                    if (_kid === _addRowOnly) continue;
                    if (_kid.nodeType === 3 && (_kid.nodeValue || '').trim()) { _hasNonBtnContent = true; break; }
                    if (_kid.nodeType === 1) { _hasNonBtnContent = true; break; }
                }
            }
            if (!_addRowOnly || _hasNonBtnContent) {
                var raw = (td.innerText || td.textContent || '').trim();
                // 若存在按钮行，需从 raw 中剔除按钮文字
                if (_addRowOnly) {
                    var _btnTexts = _addRowOnly.querySelectorAll('.xse-btn-add-group');
                    for (var _bi = 0; _bi < _btnTexts.length; _bi++) {
                        var _bt = (_btnTexts[_bi].innerText || _btnTexts[_bi].textContent || '').trim();
                        if (_bt) raw = raw.split(_bt).join('');
                    }
                    raw = raw.trim();
                }
                if (raw) {
                    ui = raw.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return !!l; });
                    step.ui_expected = ui;
                }
            }
        }
    }

    // 检查是否有实际变更
    var changed = false;
    var newOp = (step.operation != null ? String(step.operation) : '').trim();
    if (section === 'desc') {
        changed = newOp !== oldOp;
    } else if (section === 'data') {
        changed = JSON.stringify(step.data || []) !== JSON.stringify(oldData);
    } else if (section === 'expected') {
        changed = JSON.stringify(step.ui_expected || []) !== JSON.stringify(oldUi) ||
                  JSON.stringify(step.api_expected || []) !== JSON.stringify(oldApi) ||
                  JSON.stringify(step.db_expected || []) !== JSON.stringify(oldDb);
    }
    if (!changed) return;

    // 重建合并文本并同步主表数据
    var combined = _buildStepCombined(dt.rawRowGroups[ri]);
    if (typeof pushHistory === 'function') pushHistory();
    if (!S.data.rows[ri]) return;
    S.data.rows[ri][ci] = combined;
    if (S.mods) S.mods.add(ri + ',' + ci);
    if (typeof saveFile === 'function') saveFile();
}
