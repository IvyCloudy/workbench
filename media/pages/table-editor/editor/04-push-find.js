/* =============================================================================
 * 04-push-find.js  —— 推送 / 保存 / 查找替换 / 列筛选
 * -----------------------------------------------------------------------------
 * 围绕「数据流转」与「视图筛选」两类功能：
 *   1. 推送 / 保存：
 *      - pushChanges()：把当前选中行（按筛选与搜索后的显示顺序）打包为
 *        pushTestCase 消息发给扩展端，并附带 rowIndexMap 让结果弹窗能映射回原行号
 *      - saveFile()：把 S.data 通过 'save' 消息持久化到 yaml/json 源文件
 *   2. 查找 / 替换面板：openFindPanel / closeFindPanel / toggleFindPanel /
 *      onSearch（顶部搜索）/ rebuildFindMatches / paintFindHighlight /
 *      markText / clearFindHighlight / stepFind / focusActiveMatch /
 *      updateFindInfo / replaceCurrent / replaceAll
 *   3. 列筛选（Excel 风格漏斗按钮）：
 *      - getRowsPassingOtherFilters：跨列联动计数，避免显示已被自身列筛掉的值
 *      - buildColValueStats / openColFilter / positionColFilter /
 *        syncSelectedToSearch / renderColFilterList / applyColFilter /
 *        closeColFilter
 *      筛选结果存放在 S._colFilters，由 02a-render.js 在 renderTable 中应用。
 * ========================================================================== */


// ==================== 推送 / 保存 ====================
function pushChanges() {
    // 防重复点击：后端还未返回 pushDone/pushResult/pushError 之前，不允许再次 post
    if (S._pushing) {
        if (typeof showToast === 'function') showToast('推送中，请稍候…', 'info');
        return;
    }
    var picked = (typeof getPushTargetRows === 'function')
        ? getPushTargetRows()
        : (S.sel.size > 0 ? Array.from(S.sel).sort(function (a, b) { return a - b; }) : []);
    if (picked.length === 0) { showToast('请先选择需要推送的行', 'error'); return; }
    var headers = S.data.headers || [];
    var tsCol = headers.indexOf('testcase_id');
    // 收集 testcase_id -> 真实表格行号 (1-based)，用于失败弹窗显示"第 X 行"，避免后端按数组下标导致行号错位
    var rowIndexMap = {};
    // 按 payload 数组下标 -> 表格 1-based 行号 的映射（兜底用）：
    // 当行的 testcase_id 为空（首次推送场景）时，rowIndexMap 不会建键，
    // 此时通过 body[i] 与 pushIndexToRow[i] 的顺序对齐仍可定位失败行号。
    var pushIndexToRow = [];
    var payload = picked.map(function (ri) {
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
    S._lastPushBatchRowIndices = picked.slice();
    // 缓存本批参与推送的 tsId，供 pushResult 回来后做"本批成功 = 本批 - 本批失败"差集计算，
    // 进而仅清除本批中已成功的失败标记，未参与本批的历史失败行保持高亮不变。
    S._lastPushBatchTsIds = new Set();
    if (tsCol >= 0) {
        picked.forEach(function (ri) {
            var t = (S.data.rows[ri] || [])[tsCol];
            if (t !== undefined && t !== null && t !== '') {
                S._lastPushBatchTsIds.add(String(t));
            }
        });
    }
    // 置忙：锁定推送按钮与 UI，正常路径会在 pushDone/pushResult/pushError 清除。
    S._pushing = true;
    if (typeof updatePushBtn === 'function') updatePushBtn();
    // 兑底：若后端 30s 内未回复任何消息，自动解锁，避免按钮永久置灰
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

function saveFile() {
    if (!S.vscode) return;
    var rows = (S.data && S.data.rows && S.data.rows.length) || 0;
    var heads = (S.data && S.data.headers && S.data.headers.length) || 0;
    dbg('💾 saveFile post rows=' + rows + ' cols=' + heads + ' mods=' + (S.mods ? S.mods.size : 0));
    S.vscode.postMessage({ type: 'save', data: S.data });
}

// ==================== 查找 / 搜索 ====================
function openFindPanel() {
    var p = document.getElementById('findPanel');
    if (!p) return;
    if (!p.classList.contains('show')) p.classList.add('show');
    var fi = document.getElementById('findInput');
    var top = document.getElementById('searchInput');
    if (fi && top && top.value && !fi.value) fi.value = top.value;
    // 同步 Aa 按钮的高亮状态
    var caseBtn = document.getElementById('findCaseBtn');
    if (caseBtn) {
        if (S._findCaseSensitive) caseBtn.classList.add('active');
        else caseBtn.classList.remove('active');
    }
    if (fi) {
        fi.focus(); fi.select();
        rebuildFindMatches(fi.value || '');
        updateFindInfo();
        focusActiveMatch();
    }
}

function closeFindPanel() {
    var p = document.getElementById('findPanel');
    if (!p) return;
    if (p.classList.contains('show')) p.classList.remove('show');
    clearFindHighlight();
    S._matches = [];
    S._matchIdx = -1;
    S._findKw = '';
    updateFindInfo();
}

function toggleFindPanel() {
    var p = document.getElementById('findPanel');
    if (!p) return;
    if (p.classList.contains('show')) closeFindPanel();
    else openFindPanel();
}

// 点击表格区域（不包括查找面板本身）时关闭查找面板
function bindCloseFindOnTableClick() {
    if (S._findCloseBound) return;
    S._findCloseBound = true;
    var tbl = document.getElementById('tableContainer');
    if (!tbl) return;
    tbl.addEventListener('mousedown', function (e) {
        var p = document.getElementById('findPanel');
        if (!p || !p.classList.contains('show')) return;
        // 点击发生在面板内部不关闭
        if (p.contains(e.target)) return;
        closeFindPanel();
    });
}

// 查找面板左侧拖拽调整宽度
function bindFindPanelResize() {
    if (S._findResizeBound) return;
    S._findResizeBound = true;
    var handle = document.getElementById('findPanelHandle');
    var panel = document.getElementById('findPanel');
    if (!handle || !panel) return;
    var startX, startWidth, startRight;
    var minW = 340, maxW = window.innerWidth * 0.8;
    function onMove(e) {
        var dx = startX - (e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || startX);
        var newW = Math.max(minW, Math.min(maxW, startWidth + dx));
        panel.style.width = newW + 'px';
        panel.style.minWidth = newW + 'px';
        panel.style.right = startRight + 'px';
    }
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        handle.classList.remove('dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    }
    handle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        startRight = parseInt(getComputedStyle(panel).right, 10) || 0;
        handle.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ew-resize';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('touchstart', function (e) {
        e.preventDefault();
        startX = e.touches[0].clientX;
        startWidth = panel.offsetWidth;
        startRight = parseInt(getComputedStyle(panel).right, 10) || 0;
        handle.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    });
}

// 顶部 searchInput：过滤未命中的行（边输入边过滤，防抖 150ms）
var _searchTimer = null;
function onSearch(e) {
    var val = (e.target.value || '');
    updateSearchClear(val);
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function () {
        S._searchKw = val;
        dbg('🔍 search kw="' + S._searchKw + '"');
        renderTable();
    }, 150);
}

// 显示/隐藏搜索清除按钮
function updateSearchClear(val) {
    var btn = document.getElementById('searchClear');
    var kw = (val !== undefined) ? val : S._searchKw;
    if (btn) btn.style.display = (kw || '').length > 0 ? '' : 'none';
}

// 步骤展开（steps）单元格的查找替换辅助：在展开步骤模式下，steps 合并文本单元格
// 可被搜索与替换。底层数据来自 dt.rawRowGroups 的结构化步骤（operation/data/ui_expected/...），
// 替换后通过 _buildStepCombined 重建主表合并文本并同步，保证与保存路径（reconstructDetail 优先用 rawRowGroups）一致。

// 判断 (ri, ci) 在展开步骤模式下是否为可被查找替换的 steps 合并文本单元格
function _isStepsExpandedFindCell(ri, ci) {
    if (!S._stepsExpanded) return false;
    if (typeof isDetailColumn !== 'function' || !isDetailColumn(ci)) return false;
    var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
    if (!dt || !dt.rawRowGroups) return false;
    var raws = dt.rawRowGroups[ri];
    return Array.isArray(raws) && raws.length > 0;
}

// 按 _buildStepCombined 的拼接顺序展开单个 step 的所有可搜索字符串字段：
//   operation → data[] → ui_expected[] → api_expected[] → db_expected[]
function _stepFieldAccessors(step) {
    var acc = [];
    acc.push({ get: function () { return step.operation; }, set: function (v) { step.operation = v; } });
    ['data', 'ui_expected', 'api_expected', 'db_expected'].forEach(function (arrName) {
        var arr = Array.isArray(step[arrName]) ? step[arrName] : [];
        for (var i = 0; i < arr.length; i++) {
            (function (arr, i) {
                acc.push({ get: function () { return arr[i]; }, set: function (v) { arr[i] = v; } });
            })(arr, i);
        }
    });
    return acc;
}

// 在 rawRowGroups[ri] 中按字段顺序找到第一个含 needle 的字段并替换第一处，返回是否替换成功
function _replaceStepsFirstHit(raws, caseSensitive, needle, newVal) {
    for (var s = 0; s < raws.length; s++) {
        var step = raws[s];
        if (!step || typeof step !== 'object') continue;
        var acc = _stepFieldAccessors(step);
        for (var a = 0; a < acc.length; a++) {
            var val = acc[a].get();
            if (val == null) continue;
            var str = String(val);
            var hay = caseSensitive ? str : str.toLowerCase();
            var hit = hay.indexOf(needle);
            if (hit < 0) continue;
            acc[a].set(str.slice(0, hit) + newVal + str.slice(hit + needle.length));
            return true;
        }
    }
    return false;
}

// 替换 rawRowGroups[ri] 所有字段中的所有命中，返回替换处数
function _replaceStepsAll(raws, caseSensitive, needle, newVal) {
    var count = 0;
    for (var s = 0; s < raws.length; s++) {
        var step = raws[s];
        if (!step || typeof step !== 'object') continue;
        var acc = _stepFieldAccessors(step);
        for (var a = 0; a < acc.length; a++) {
            var val = acc[a].get();
            if (val == null) continue;
            var str = String(val);
            var hay = caseSensitive ? str : str.toLowerCase();
            if (hay.indexOf(needle) < 0) continue;
            var out = '', i = 0;
            while (i < str.length) {
                var h = hay.indexOf(needle, i);
                if (h < 0) { out += str.slice(i); break; }
                out += str.slice(i, h) + newVal;
                i = h + needle.length;
                count++;
            }
            acc[a].set(out);
        }
    }
    return count;
}

// 展开步骤替换后：重建合并文本、写回主表、标记修改、保存、原地刷新单元格
function _syncStepsCellAfterReplace(ri, ci) {
    var dt = (typeof getDetailTableByCol === 'function') ? getDetailTableByCol(ci) : null;
    if (!dt || !dt.rawRowGroups) return;
    if (!S.data.rows[ri]) return;
    var combined = _buildStepCombined(dt.rawRowGroups[ri]);
    S.data.rows[ri][ci] = combined;
    if (S.mods) S.mods.add(ri + ',' + ci);
    if (S._detailModCellKeys) S._detailModCellKeys.add(ri + ',' + ci);
    if (typeof saveFile === 'function') saveFile();
    if (typeof patchCell === 'function') patchCell(ri, ci);
}

// 重新构建命中列表 + 渲染高亮
function rebuildFindMatches(kw) {
    S._findKw = kw || '';
    S._matches = [];
    S._matchIdx = -1;
    clearFindHighlight();
    if (!S._findKw) return;
    var caseSensitive = !!S._findCaseSensitive;
    var needle = caseSensitive ? S._findKw : S._findKw.toLowerCase();
    var rows = (S.data && S.data.rows) || [];
    var headers = (S.data && S.data.headers) || [];
    // 当 toggle 过滤（仅看失败/修改/新增/删除/标记）激活时，find 只搜索可见行
    // 与 02d-sel-utils.js:208/229 的 hasToggleFilter 保持同源，避免 _markedOnly 场景下匹配到隐藏行
    var hasToggle = S._failedOnly || S._modifiedOnly || S._addedOnly || S._deletedOnly || S._markedOnly;
    var visibleRows = null;
    if (hasToggle && S._viewRows && S._viewRows.length >= 0) {
        visibleRows = new Set(S._viewRows);
    }
    rows.forEach(function (row, ri) {
        if (visibleRows && !visibleRows.has(ri)) return;
        headers.forEach(function (_, ci) {
            // detail 列（steps 等）：
            //   - 折叠态下（未展开步骤）主表显示为 [N 项]/链接，搜索无意义，跳过；
            //   - 展开步骤模式下，steps 合并文本单元格可被查找替换：
            //     搜索结构化 rawRowGroups 的各字段，命中即记为一个单元格级匹配。
            if (typeof isDetailColumn === 'function' && isDetailColumn(ci)) {
                if (S._stepsExpanded && _isStepsExpandedFindCell(ri, ci)) {
                    var _dt = getDetailTableByCol(ci);
                    var _raws = _dt.rawRowGroups[ri] || [];
                    var _found = false;
                    for (var _s = 0; _s < _raws.length && !_found; _s++) {
                        var _step = _raws[_s];
                        if (!_step || typeof _step !== 'object') continue;
                        var _acc = _stepFieldAccessors(_step);
                        for (var _a = 0; _a < _acc.length; _a++) {
                            var _val = _acc[_a].get();
                            if (_val == null) continue;
                            var _str = String(_val);
                            var _hay = caseSensitive ? _str : _str.toLowerCase();
                            if (_hay.indexOf(needle) >= 0) { _found = true; break; }
                        }
                    }
                    if (_found) S._matches.push({ r: ri, c: ci, steps: true });
                }
                return; // 其余 detail 列（非展开步骤）仍跳过
            }
            var v = row[ci];
            if (v === null || v === undefined) return;
            // 数组列：以 '; ' 拼接后参与查找（与主表 chip 走同一拼接规则）
            var s = Array.isArray(v) ? formatCellValue(v) : String(v);
            var hay = caseSensitive ? s : s.toLowerCase();
            if (hay.indexOf(needle) >= 0) {
                S._matches.push({ r: ri, c: ci });
            }
        });
    });
    if (S._matches.length > 0) S._matchIdx = 0;
    paintFindHighlight();
}

// 在所有命中单元格添加 highlight 类，并将文本 mark 替换
function paintFindHighlight() {
    if (!S._findKw) return;
    var matchesByCell = {};
    S._matches.forEach(function (m, idx) { matchesByCell[m.r + ',' + m.c] = idx; });
    var tds = document.querySelectorAll('td.xs-editable');
    tds.forEach(function (td) {
        var ri = td.getAttribute('data-row');
        var ci = td.getAttribute('data-col');
        if (ri === null || ci === null) return;
        var key = ri + ',' + ci;
        if (matchesByCell.hasOwnProperty(key)) {
            td.classList.add('highlight');
            var idx = matchesByCell[key];
            if (idx === S._matchIdx) td.classList.add('highlight-active');
            // 在 cell-wrap 文本内做 mark 高亮
            var wrap = td.querySelector('.xs-cell-wrap');
            if (wrap) {
                var _m = S._matches[idx];
                if (_m && _m.steps) {
                    // 展开步骤子表格：对所有命中字段做内部高亮。
                    //   - 步骤描述（xse-td-desc）：纯文本，按行 markText
                    //   - 数据 / 预期结果（xse-td-data / xse-td-expected）：行内有 .xse-line /
                    //     chip 结构，markText 替换 innerHTML 会破坏结构；改用 markTextInStructure
                    //     走 text 节点并包裹 <mark>，保留原结构（chip 标题【UI检查】等跳过不 mark）
                    var _subTable = td.querySelector('.xs-step-expanded');
                    if (_subTable) {
                        var _descTds = _subTable.querySelectorAll('.xse-td-desc');
                        for (var _di = 0; _di < _descTds.length; _di++) {
                            markText(_descTds[_di], S._findKw, idx === S._matchIdx);
                        }
                        var _dataTds = _subTable.querySelectorAll('.xse-td-data');
                        for (var _dti = 0; _dti < _dataTds.length; _dti++) {
                            markTextInStructure(_dataTds[_dti], S._findKw, idx === S._matchIdx);
                        }
                        var _expTds = _subTable.querySelectorAll('.xse-td-expected');
                        for (var _ei = 0; _ei < _expTds.length; _ei++) {
                            markTextInStructure(_expTds[_ei], S._findKw, idx === S._matchIdx);
                        }
                    }
                } else {
                    markText(wrap, S._findKw, idx === S._matchIdx);
                }
            }
        }
    });
}

function markText(node, kw, isActive) {
    if (!kw) return;
    var text = node.textContent || '';
    if (!text) return;
    var caseSensitive = !!S._findCaseSensitive;
    var hay = caseSensitive ? text : text.toLowerCase();
    var needle = caseSensitive ? kw : kw.toLowerCase();
    var html = '';
    var i = 0;
    while (i < text.length) {
        var hit = hay.indexOf(needle, i);
        if (hit < 0) { html += escapeHtml(text.slice(i)); break; }
        html += escapeHtml(text.slice(i, hit));
        var cls = isActive ? 'xs-mk xs-mk-active' : 'xs-mk';
        html += '<mark class="' + cls + '">' + escapeHtml(text.slice(hit, hit + kw.length)) + '</mark>';
        i = hit + kw.length;
    }
    // 如果单元格内是 detail 链接或已展开步骤块，跳过 mark（保留结构）
    var detailSpan = node.querySelector('.xs-detail-link, .xs-step-expanded');
    if (detailSpan) return;
    node.innerHTML = html;
}

// 对含结构的子单元格（xse-td-data / xse-td-expected 的 .xse-line / .xse-group 行内）做高亮：
//   遍历 text 节点，将含 needle 的子串就地拆成「文本 + <mark>」序列，保留 chip / line 结构。
//   跳过：MARK 内部文本（避免递归 mark）、chip 标题（.xse-sub，如【UI检查】，保持分类标签纯净）。
function markTextInStructure(root, kw, isActive) {
    if (!kw || !root) return;
    var caseSensitive = !!S._findCaseSensitive;
    var needle = caseSensitive ? kw : kw.toLowerCase();
    var cls = isActive ? 'xs-mk xs-mk-active' : 'xs-mk';
    // 一次性收集所有待处理 text 节点（在改 DOM 之前快照，避免游标错位）
    var nodes = [];
    try {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                var p = node.parentNode;
                if (!p || p.nodeType !== 1) return NodeFilter.FILTER_REJECT;
                if (p.tagName === 'MARK') return NodeFilter.FILTER_REJECT;
                if (p.classList && p.classList.contains('xse-sub')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        }, false);
        var n;
        while ((n = walker.nextNode())) nodes.push(n);
    } catch (_e) {
        // 极少数 webview 不支持 TreeWalker，回退到无结构保护版本
        _markTextInStructureFallback(root, kw, isActive);
        return;
    }
    for (var i = 0; i < nodes.length; i++) {
        var textNode = nodes[i];
        var text = textNode.textContent;
        var hay = caseSensitive ? text : text.toLowerCase();
        if (hay.indexOf(needle) < 0) continue;
        var parent = textNode.parentNode;
        var refNode = textNode;
        var pos = 0;
        while (pos < text.length) {
            var h = hay.indexOf(needle, pos);
            if (h < 0) {
                if (pos < text.length) parent.insertBefore(document.createTextNode(text.slice(pos)), refNode);
                break;
            }
            if (h > pos) parent.insertBefore(document.createTextNode(text.slice(pos, h)), refNode);
            var mark = document.createElement('mark');
            mark.className = cls;
            mark.textContent = text.slice(h, h + kw.length);
            parent.insertBefore(mark, refNode);
            pos = h + kw.length;
        }
        parent.removeChild(refNode);
    }
}

// TreeWalker 不可用时的兜底：处理 root 的直接 text 节点
function _markTextInStructureFallback(root, kw, isActive) {
    var caseSensitive = !!S._findCaseSensitive;
    var needle = caseSensitive ? kw : kw.toLowerCase();
    var cls = isActive ? 'xs-mk xs-mk-active' : 'xs-mk';
    var children = Array.prototype.slice.call(root.childNodes);
    for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c.nodeType !== 3) continue;
        var text = c.textContent;
        var hay = caseSensitive ? text : text.toLowerCase();
        if (hay.indexOf(needle) < 0) continue;
        var pos = 0;
        var frag = document.createDocumentFragment();
        while (pos < text.length) {
            var h = hay.indexOf(needle, pos);
            if (h < 0) {
                if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
                break;
            }
            if (h > pos) frag.appendChild(document.createTextNode(text.slice(pos, h)));
            var mk = document.createElement('mark');
            mk.className = cls;
            mk.textContent = text.slice(h, h + kw.length);
            frag.appendChild(mk);
            pos = h + kw.length;
        }
        root.replaceChild(frag, c);
    }
}

// 清除结构化子单元格内的 <mark>：就地拆掉 <mark> 还原为 text 节点，保留 chip / line 结构
function unmarkTextInStructure(root) {
    if (!root) return;
    var marks = root.querySelectorAll('mark.xs-mk, mark.xs-mk-active');
    for (var i = 0; i < marks.length; i++) {
        var mark = marks[i];
        var text = document.createTextNode(mark.textContent);
        mark.parentNode.replaceChild(text, mark);
    }
    if (typeof root.normalize === 'function') root.normalize();
}

function clearFindHighlight() {
    document.querySelectorAll('td.xs-editable.highlight').forEach(function (td) {
        td.classList.remove('highlight', 'highlight-active');
        var wrap = td.querySelector('.xs-cell-wrap');
        if (!wrap) return;
        // 展开步骤单元格：拆掉子表格内所有 <mark>，保留 .xse-line / chip 结构
        var _stepExp = wrap.querySelector('.xs-step-expanded');
        if (_stepExp) {
            unmarkTextInStructure(_stepExp);
            return;
        }
        if (!wrap.querySelector('.xs-detail-link')) {
            // 还原为纯文本
            wrap.innerHTML = escapeHtml(wrap.textContent || '');
        }
    });
}

// 匹配集一致性校验：面板打开期间若过滤/搜索状态变化，_matches 可能包含
// 已被隐藏或已被暴露的行，导致「下一个/上一个」跳到不可见行或漏跳新可见行。
// 消费端幂等重建，避开在每处 toggle 里嵌入 rebuild 调用（污染切换路径）。
function _ensureFindMatchesConsistent() {
    if (!S._findKw) return;
    // 若过去从未构建过匹配集，无需处理；stepFind 内部有 empty 兜底重建。
    if (!S._matches || S._matches.length === 0) return;
    var hasToggle = S._failedOnly || S._modifiedOnly || S._addedOnly || S._deletedOnly || S._markedOnly;
    // 判定当前可见集与匹配集是否一致：若差集非空则需要重建
    if (hasToggle && S._viewRows && S._viewRows.length >= 0) {
        var vis = new Set(S._viewRows);
        for (var i = 0; i < S._matches.length; i++) {
            if (!vis.has(S._matches[i].r)) { rebuildFindMatches(S._findKw); return; }
        }
    } else if (!hasToggle) {
        // 从过滤态切回全表：可能有新增可见行含关键字，也需重建
        // 仅当 S._matches 长度小于全表可能命中数量时重建（简化判定：只要没有 toggle 就 rebuild 一次）
        // 但如果每次 stepFind 都无脑 rebuild 会浪费；用 sig 缓存判定
        var sig = 'nt|' + (S.data && S.data.rows ? S.data.rows.length : 0) + '|' + (S._findKw || '') + '|' + !!S._findCaseSensitive;
        if (S._matchesLastSig !== sig) { S._matchesLastSig = sig; rebuildFindMatches(S._findKw); return; }
    }
    // 更新已构建匹配集的签名（在 toggle 态下 sig 反映过滤集）
    if (hasToggle) {
        var vsig = 'tg|' + (S._viewRows ? S._viewRows.length : 0) + '|' + (S._findKw || '') + '|' + !!S._findCaseSensitive;
        if (S._matchesLastSig !== vsig) { S._matchesLastSig = vsig; rebuildFindMatches(S._findKw); }
    }
}

function stepFind(dir) {
    _ensureFindMatchesConsistent();
    if (S._matches.length === 0) {
        // 重新尝试构建一次（用户可能在面板中没触发 input）
        var fi = document.getElementById('findInput');
        rebuildFindMatches(fi ? (fi.value || '') : '');
    }
    if (S._matches.length === 0) { showToast('没有找到匹配项', 'error'); return; }
    S._matchIdx = (S._matchIdx + dir + S._matches.length) % S._matches.length;
    clearFindHighlight();
    paintFindHighlight();
    updateFindInfo();
    focusActiveMatch();
}

function focusActiveMatch() {
    if (S._matchIdx < 0 || S._matchIdx >= S._matches.length) return;
    var m = S._matches[S._matchIdx];
    // 虚拟滚动模式下，目标行可能未渲染：先把它滚入视口触发渲染
    if (S._virtualOn && typeof ensureRowVisible === 'function') {
        ensureRowVisible(m.r);
    }
    var td = document.querySelector('td.xs-editable[data-row="' + m.r + '"][data-col="' + m.c + '"]');
    if (td && td.scrollIntoView) td.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function updateFindInfo() {
    var info = document.getElementById('findInfo');
    if (!info) return;
    if (!S._findKw) { info.textContent = ''; return; }
    if (S._matches.length === 0) info.textContent = '无匹配';
    else info.textContent = (S._matchIdx + 1) + ' / ' + S._matches.length;
}

function replaceCurrent() {
    // 与 stepFind 同源校验：防止过滤态切换后 _matches 中含隐藏行导致误改
    _ensureFindMatchesConsistent();
    if (S._matchIdx < 0 || S._matchIdx >= S._matches.length) {
        showToast('没有可替换项', 'error'); return;
    }
    var rep = document.getElementById('replaceInput');
    var newVal = rep ? rep.value : '';
    var m = S._matches[S._matchIdx];
    if (isFrozenRow(m.r)) {
        showToast('样例数据行已冻结，跳过替换', 'error');
        stepFind(1);
        return;
    }
    if (isFrozenCol(m.c)) {
        showToast('testcase_id 列为系统列，跳过替换', 'error');
        stepFind(1);
        return;
    }
    // 数组列不支持查找替换（多项语义与 '; ' 分隔符容易窜乱，跳过）
    if (typeof isArrayCol === 'function' && isArrayCol(m.c)) {
        showToast('标量数组列不支持查找替换，请双击单元格在多项编辑弹窗中修改', 'error');
        stepFind(1);
        return;
    }
    // 明细列（steps 等）：
    //   - 展开步骤模式下，steps 合并文本单元格支持查找替换：直接在 rawRowGroups 上做字段级替换，
    //     再经 _buildStepCombined 同步主表合并文本，保证与保存路径一致。
    //   - 其余 detail 列（未展开步骤 / 其它对象明细）仍禁止：主表仅是链接文本，真实数据在弹窗，
    //     写字符串会与其余结构不一致，提示用户改用弹窗。
    if (typeof isDetailColumn === 'function' && isDetailColumn(m.c)) {
        if (m.steps) {
            var _sdt = getDetailTableByCol(m.c);
            if (_sdt && _sdt.rawRowGroups && _sdt.rawRowGroups[m.r]) {
                pushHistory();
                var _did = _replaceStepsFirstHit(_sdt.rawRowGroups[m.r], caseSensitive, needle, newVal);
                if (!_did) { stepFind(1); return; }
                _syncStepsCellAfterReplace(m.r, m.c);
                // 重新搜索（步骤内可能还有其他命中）
                rebuildFindMatches(S._findKw);
                if (S._matches.length === 0) {
                    showToast('已完成替换', 'success');
                    closeFindPanel();
                    return;
                }
                if (S._matchIdx >= S._matches.length) S._matchIdx = 0;
                clearFindHighlight();
                paintFindHighlight();
                updateFindInfo();
                focusActiveMatch();
                return;
            }
        }
        showToast('明细列不支持查找替换，请通过弹窗编辑', 'error');
        stepFind(1);
        return;
    }
    var oldCell = String(S.data.rows[m.r][m.c] === undefined ? '' : S.data.rows[m.r][m.c]);
    // 仅替换该单元格中第一处匹配（按用户预期：单步替换）
    var caseSensitive = !!S._findCaseSensitive;
    var hay = caseSensitive ? oldCell : oldCell.toLowerCase();
    var needle = caseSensitive ? S._findKw : S._findKw.toLowerCase();
    var hit = hay.indexOf(needle);
    if (hit < 0) { stepFind(1); return; }
    var newCell = oldCell.slice(0, hit) + newVal + oldCell.slice(hit + S._findKw.length);
    pushHistory();
    S.data.rows[m.r][m.c] = newCell;
    S.mods.add(m.r + ',' + m.c);
    saveFile();
    patchCell(m.r, m.c);
    // 重新搜索（单元格内可能还有其他命中）
    rebuildFindMatches(S._findKw);
    if (S._matches.length === 0) {
        // 所有匹配都已替换完，关闭面板
        showToast('已完成替换', 'success');
        closeFindPanel();
        return;
    }
    if (S._matchIdx >= S._matches.length) S._matchIdx = 0;
    clearFindHighlight();
    paintFindHighlight();
    updateFindInfo();
    focusActiveMatch();
}

function replaceAll() {
    if (!S._findKw) { showToast('请输入查找内容', 'error'); return; }
    var rep = document.getElementById('replaceInput');
    var newVal = rep ? rep.value : '';
    var caseSensitive = !!S._findCaseSensitive;
    var needle = caseSensitive ? S._findKw : S._findKw.toLowerCase();
    var count = 0;
    pushHistory();
    var hasToggle = S._failedOnly || S._modifiedOnly || S._addedOnly || S._deletedOnly || S._markedOnly;
    var visibleRows = null;
    if (hasToggle && S._viewRows && S._viewRows.length >= 0) {
        visibleRows = new Set(S._viewRows);
    }
    (S.data.rows || []).forEach(function (row, ri) {
        if (visibleRows && !visibleRows.has(ri)) return;
        // 样例数据行冻结：全量替换跳过该行
        if (isFrozenRow(ri)) return;
        (S.data.headers || []).forEach(function (_, ci) {
            if (isFrozenCol(ci)) return; // tsId 列跳过
            // 标量数组列跳过全量替换，避免语义窜乱
            if (typeof isArrayCol === 'function' && isArrayCol(ci)) return;
            // 明细列：
            //   - 展开步骤模式下，steps 合并文本单元格支持字段级全量替换并同步主表；
            //   - 其余 detail 列跳过（真实数据在弹窗，写字符串会与其余结构不一致）。
            if (typeof isDetailColumn === 'function' && isDetailColumn(ci)) {
                if (S._stepsExpanded && _isStepsExpandedFindCell(ri, ci)) {
                    var _adt = getDetailTableByCol(ci);
                    var _araws = _adt.rawRowGroups[ri] || [];
                    var _c2 = _replaceStepsAll(_araws, caseSensitive, needle, newVal);
                    if (_c2 > 0) {
                        row[ci] = _buildStepCombined(_araws);
                        S.mods.add(ri + ',' + ci);
                        if (S._detailModCellKeys) S._detailModCellKeys.add(ri + ',' + ci);
                        count += _c2;
                    }
                }
                return;
            }
            var v = row[ci];
            if (v === null || v === undefined) return;
            var s = String(v);
            var hay = caseSensitive ? s : s.toLowerCase();
            if (hay.indexOf(needle) < 0) return;
            // 全部替换（根据开关决定是否区分大小写）
            var out = '';
            var i = 0;
            while (i < s.length) {
                var h = hay.indexOf(needle, i);
                if (h < 0) { out += s.slice(i); break; }
                out += s.slice(i, h) + newVal;
                i = h + S._findKw.length;
                count++;
            }
            row[ci] = out;
            S.mods.add(ri + ',' + ci);
        });
    });
    if (count === 0) { showToast('没有找到匹配项', 'error'); return; }
    saveFile();
    renderTable();
    showToast('已替换 ' + count + ' 处', 'success');
    // 替换全部完成后关闭查找面板
    closeFindPanel();
}

// 计算「除指定列外」的其他筛选+顶部搜索通过的行，用于在筛选弹窗中正确给出值的计数。
// 缓存优化：同一个筛选弹窗会多次调用（连续点选项、输入搜索词），
// 结果仅依赖 (S.data, S._searchKw, S._colFilters)，未变时复用。
function _filtersCacheKey() {
    var parts = ['kw=' + (S._searchKw || ''), 'rows=' + ((S.data && S.data.rows && S.data.rows.length) || 0)];
    if (S._colFilters) {
        var keys = Object.keys(S._colFilters).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var set = S._colFilters[k];
            if (!(set instanceof Set)) continue;
            var arr = Array.from(set);
            arr.sort();
            parts.push(k + ':' + arr.join('\u0001'));
        }
    }
    return parts.join('|');
}
function getRowsPassingOtherFilters(excludeCol) {
    var sig = _filtersCacheKey();
    if (!S._otherFiltersCache || S._otherFiltersCache.sig !== sig) {
        S._otherFiltersCache = { sig: sig, byCol: {} };
    }
    var bucket = S._otherFiltersCache.byCol;
    if (bucket['c' + excludeCol]) return bucket['c' + excludeCol];
    var rows = (S.data && S.data.rows) || [];
    var headers = (S.data && S.data.headers) || [];
    var skw = (S._searchKw || '').toLowerCase();
    var out = [];
    rows.forEach(function (row) {
        if (skw) {
            var hit = false;
            for (var k = 0; k < headers.length; k++) {
                var cv = row[k];
                if (cv === null || cv === undefined) continue;
                var cvStr = Array.isArray(cv) ? formatCellValue(cv) : String(cv);
                if (cvStr.toLowerCase().indexOf(skw) >= 0) { hit = true; break; }
            }
            if (!hit) return;
        }
        for (var fc in S._colFilters) {
            if (!S._colFilters.hasOwnProperty(fc)) continue;
            if (parseInt(fc, 10) === excludeCol) continue;
            var allow = S._colFilters[fc];
            var fcIdx = parseInt(fc, 10);
            var cellVal = row[fcIdx];
            var cellKey;
            if (cellVal === null || cellVal === undefined || cellVal === '') cellKey = '__BLANK__';
            else if (Array.isArray(cellVal)) cellKey = (cellVal.length === 0 ? '__BLANK__' : formatCellValue(cellVal));
            else cellKey = String(cellVal);
            if (!allow.has(cellKey)) return;
        }
        out.push(row);
    });
    bucket['c' + excludeCol] = out;
    return out;
}

// 计算指定列在「其他筛选通过的行」上的所有去重值与计数
function buildColValueStats(col) {
    var rows = getRowsPassingOtherFilters(col);
    var map = new Map(); // key -> count
    rows.forEach(function (row) {
        var v = row[col];
        var key;
        if (v === null || v === undefined || v === '') key = '__BLANK__';
        else if (Array.isArray(v)) key = (v.length === 0 ? '__BLANK__' : formatCellValue(v));
        else key = String(v);
        map.set(key, (map.get(key) || 0) + 1);
    });
    // 转成数组并按值字典序排序；空值置底
    var arr = [];
    map.forEach(function (cnt, key) { arr.push({ key: key, count: cnt }); });
    arr.sort(function (a, b) {
        if (a.key === '__BLANK__') return 1;
        if (b.key === '__BLANK__') return -1;
        // 数字优先按数值排序
        var na = parseFloat(a.key), nb = parseFloat(b.key);
        if (!isNaN(na) && !isNaN(nb) && String(na) === a.key && String(nb) === b.key) return na - nb;
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
    });
    return arr;
}

// 打开列筛选弹窗
function openColFilter(col, anchorEl) {
    var sf = document.getElementById('sortFilter');
    if (!sf) return;
    var stats = buildColValueStats(col);
    var existing = S._colFilters[col]; // Set<string> | undefined
    // 默认勾选：已有筛选则取既有集合；否则全选
    var selected = new Set();
    if (existing) {
        existing.forEach(function (v) { selected.add(v); });
    } else {
        stats.forEach(function (s) { selected.add(s.key); });
    }
    S._filterUI = { col: col, kw: '', selected: selected, stats: stats };
    // 构建弹窗骨架
    sf.innerHTML = ''
        + '<div class="xs-sf-search">'
        +   '<input type="text" id="sfSearch" placeholder="搜索值...">'
        +   '<span class="xs-sf-clear" id="sfSearchClear" title="清除">✕</span>'
        +   '<span class="xs-sf-reset" id="sfSearchReset" title="重置：恢复全选所有项">⟳</span>'
        + '</div>'
        + '<div class="xs-sf-list" id="sfList"></div>'
        + '<div class="xs-sf-footer">'
        +   '<button class="xs-sf-clear-btn" id="sfClearFilter">清除筛选</button>'
        +   '<div class="xs-sf-actions">'
        +     '<button class="xs-btn" id="sfCancel">取消</button>'
        +     '<button class="xs-btn xs-btn-p" id="sfApply">确定</button>'
        +   '</div>'
        + '</div>';
    sf.classList.add('show');
    // 定位到漏斗下方
    positionColFilter(sf, anchorEl);
    // 绑定事件
    var input = document.getElementById('sfSearch');
    var clear = document.getElementById('sfSearchClear');
    if (input) {
        input.addEventListener('input', function () {
            var kw = (input.value || '');
            S._filterUI.kw = kw;
            if (clear) clear.classList.toggle('show', !!kw);
            // 搜索即"自动选中命中项"：将 selected 重置为搜索命中项；
            // 清空搜索时恢复为全选所有原始值。这样点"确定"即按搜索结果过滤。
            syncSelectedToSearch();
            renderColFilterList();
        });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); applyColFilter(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); closeColFilter(); }
            ev.stopPropagation();
        });
        // 复用公共粘贴兜底（webview 沙箱下原生 Ctrl/Cmd+V 偶发失效）
        if (typeof attachPasteFallback === 'function') attachPasteFallback(input);
        // 阻止 mousedown 冒泡导致弹窗被全局 click 关闭逻辑误判
        input.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    }
    if (clear) {
        clear.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (input) { input.value = ''; input.focus(); }
            S._filterUI.kw = '';
            clear.classList.remove('show');
            // 清空搜索 → 恢复为全选所有原始值
            syncSelectedToSearch();
            renderColFilterList();
        });
    }
    var cancelBtn = document.getElementById('sfCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function (ev) { ev.stopPropagation(); closeColFilter(); });
    var resetBtn = document.getElementById('sfSearchReset');
    if (resetBtn) {
        resetBtn.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
        resetBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            // 清空搜索 + 恢复全选所有原始值
            if (input) { input.value = ''; }
            S._filterUI.kw = '';
            if (clear) clear.classList.remove('show');
            var stats = (S._filterUI && S._filterUI.stats) || [];
            S._filterUI.selected = new Set();
            stats.forEach(function (s) { S._filterUI.selected.add(s.key); });
            renderColFilterList();
            if (input) input.focus();
        });
    }
    var applyBtn = document.getElementById('sfApply');
    if (applyBtn) applyBtn.addEventListener('click', function (ev) { ev.stopPropagation(); applyColFilter(); });
    var clearFilterBtn = document.getElementById('sfClearFilter');
    if (clearFilterBtn) clearFilterBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        // 移除该列的筛选条件
        if (S._colFilters[col]) {
            delete S._colFilters[col];
            renderTable();
        }
        closeColFilter();
    });
    // 阻止弹窗内 mousedown 冒泡
    sf.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    renderColFilterList();
    if (input) setTimeout(function () { input.focus(); }, 0);
}

function positionColFilter(sf, anchorEl) {
    var rect;
    if (anchorEl && anchorEl.getBoundingClientRect) rect = anchorEl.getBoundingClientRect();
    else rect = { left: 100, bottom: 80, top: 80, right: 200 };
    var width = sf.offsetWidth || 260;
    var height = sf.offsetHeight || 360;
    var left = rect.left;
    var top = rect.bottom + 4;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 4) left = 4;
    if (top + height > window.innerHeight - 8) top = Math.max(4, rect.top - height - 4);
    sf.style.left = left + 'px';
    sf.style.top = top + 'px';
}

// 根据当前搜索关键字，重新计算「选中集合」：
// - 关键字非空：仅选中名字命中关键字的项（这样点击确定就是用搜索结果过滤）
// - 关键字为空：恢复为全选所有原始值
function syncSelectedToSearch() {
    var ui = S._filterUI;
    if (!ui) return;
    var kw = (ui.kw || '').toLowerCase();
    var stats = ui.stats || [];
    ui.selected = new Set();
    if (!kw) {
        stats.forEach(function (s) { ui.selected.add(s.key); });
        return;
    }
    stats.forEach(function (s) {
        var label = s.key === '__BLANK__' ? '(空白)' : s.key;
        if (label.toLowerCase().indexOf(kw) >= 0) {
            ui.selected.add(s.key);
        }
    });
}

// 渲染候选值列表（带搜索过滤、复选框、计数）
function renderColFilterList() {
    var ui = S._filterUI;
    if (!ui) return;
    var listEl = document.getElementById('sfList');
    if (!listEl) return;
    var kw = (ui.kw || '').toLowerCase();
    var stats = ui.stats || [];
    var filtered = stats.filter(function (s) {
        if (!kw) return true;
        var label = s.key === '__BLANK__' ? '(空白)' : s.key;
        return label.toLowerCase().indexOf(kw) >= 0;
    });
    // 全选/反选状态：基于"过滤后可见的项"
    var allChecked = filtered.length > 0 && filtered.every(function (s) { return ui.selected.has(s.key); });
    var someChecked = filtered.some(function (s) { return ui.selected.has(s.key); });
    var html = '';
    // 顶部全选
    html += '<label class="xs-sf-item" data-role="all">'
        +     '<input type="checkbox" id="sfAll"' + (allChecked ? ' checked' : '') + '>'
        +     '<span class="xs-sf-label"><strong>(全选' + (kw ? ' 搜索结果' : '') + ')</strong></span>'
        +     '<span class="xs-sf-count">' + filtered.length + '</span>'
        +   '</label>';
    html += '<div class="xs-sf-divider"></div>';
    if (filtered.length === 0) {
        html += '<div class="xs-sf-empty">无匹配项</div>';
    } else {
        filtered.forEach(function (s) {
            var label = s.key === '__BLANK__' ? '(空白)' : s.key;
            var blankCls = s.key === '__BLANK__' ? ' xs-sf-blank' : '';
            var checked = ui.selected.has(s.key) ? ' checked' : '';
            html += '<label class="xs-sf-item' + blankCls + '" data-key="' + escapeHtml(s.key) + '">'
                +     '<input type="checkbox"' + checked + '>'
                +     '<span class="xs-sf-label" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>'
                +     '<span class="xs-sf-count">' + s.count + '</span>'
                +   '</label>';
        });
    }
    listEl.innerHTML = html;
    // 事件绑定
    var allCb = document.getElementById('sfAll');
    if (allCb) {
        allCb.addEventListener('change', function () {
            if (allCb.checked) {
                filtered.forEach(function (s) { ui.selected.add(s.key); });
            } else {
                filtered.forEach(function (s) { ui.selected.delete(s.key); });
            }
            renderColFilterList();
        });
    }
    // 设置 indeterminate 半选状态
    if (allCb && !allChecked && someChecked) allCb.indeterminate = true;
    listEl.querySelectorAll('.xs-sf-item[data-key]').forEach(function (item) {
        var key = item.getAttribute('data-key');
        var cb = item.querySelector('input[type=checkbox]');
        if (!cb) return;
        cb.addEventListener('change', function () {
            if (cb.checked) ui.selected.add(key);
            else ui.selected.delete(key);
            renderColFilterList();
        });
    });
}

function applyColFilter() {
    var ui = S._filterUI;
    if (!ui) { closeColFilter(); return; }
    var col = ui.col;
    var stats = ui.stats || [];
    var totalKeys = stats.length;
    var sel = ui.selected;
    if (sel.size === 0) {
        showToast('至少需要选中一项', 'error');
        return;
    }
    if (sel.size === totalKeys) {
        // 全选 = 等同无筛选
        if (S._colFilters[col]) delete S._colFilters[col];
    } else {
        // 仅保留 stats 中存在的 key（防止陈旧 key 误留）
        var keep = new Set();
        stats.forEach(function (s) { if (sel.has(s.key)) keep.add(s.key); });
        S._colFilters[col] = keep;
    }
    closeColFilter();
    renderTable();
}

function closeColFilter() {
    var sf = document.getElementById('sortFilter');
    if (sf) {
        sf.classList.remove('show');
        sf.innerHTML = '';
    }
    S._filterUI = null;
}

// ==================== steps 子列筛选（方案 B：折叠不匹配的子步骤） ====================
//
// 与主表列筛选 `_colFilters` 的关系：
//   - 主表列筛选决定「哪些整行显示」，作用于 rows
//   - steps 子筛选决定「已显示行的 steps 单元格里，哪些子步骤显示」，作用于 sub-steps
//   - 两者相互正交，同时生效
// 数据源：`S._stepsSubFilters = { subIdx: Set<string> }`，subIdx ∈ {1,2,3}
//   - 1 = 步骤描述（对应 step.desc）
//   - 2 = 预期结果（对应 step.expected[] 拼接后的完整字符串）
//   - 3 = 数据（对应 step.data[] 拼接后的完整字符串）
// 与 buildColValueStats 保持相同的空值键（'__BLANK__'）和格式化风格，让弹窗 UI 完全复用。

// 把 steps 文本解析成 { id, desc, expected: [], data: [] } 数组。
// 与 _buildStepExpandedHtml 的解析逻辑同源，但独立于渲染层，避免相互 require。
function _parseStepsText(text) {
    if (!text) return [];
    var lines = String(text).replace(/\\n/g, '\n').split(/\r?\n/);
    var steps = [];
    var cur = null;
    var section = null;
    for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!t) continue;
        if (/^【步骤描述】$/.test(t)) {
            if (cur) steps.push(cur);
            cur = { id: '', desc: '', data: [], expected: [] };
            section = 'desc';
            continue;
        }
        if (!cur) continue;
        if (/^【数据】$/.test(t)) { section = 'data'; continue; }
        if (/^【预期结果】$/.test(t)) { section = 'expected'; continue; }
        // 步骤标题行：拼接侧固定使用自然数序号，此处只匹配纯数字，
        // guard 防多行 desc 首行以"步骤N"开头的正文被误覆盖，与渲染层完全同源。
        var m = t.match(/^步骤(\d+)(?:\s+(.*))?$/);
        if (m && section === 'desc' && cur.id === '' && cur.desc === '') {
            cur.id = m[1];
            cur.desc = (m[2] || '').trim();
            continue;
        }
        if (section === 'desc') cur.desc += (cur.desc ? '\n' : '') + t;
        else if (section === 'data') cur.data.push(t);
        else if (section === 'expected') cur.expected.push(t);
    }
    if (cur) steps.push(cur);
    // 与 _buildStepExpandedHtml 保持自愈同源：剥离 desc 中历史累积的
    //"步骤<任意 id>"冗余前缀，让子列筛选统计等下游逻辑读取到干净的字段值。
    var _cleanRE = /^步骤\S+(?:\s+|$)/;
    for (var _cs = 0; _cs < steps.length; _cs++) {
        var _cst = steps[_cs];
        if (!_cst) continue;
        var _guard = 0;
        while (_cleanRE.test(_cst.desc) && _guard++ < 32) {
            _cst.desc = _cst.desc.replace(_cleanRE, '');
        }
    }
    return steps;
}

// 从子步骤对象里取出用于筛选的"字段字符串"。
// subIdx=1 描述 / 2 预期 / 3 数据。空值返回 '__BLANK__'，与 buildColValueStats 对齐。
function _stepFieldKey(step, subIdx) {
    var raw;
    if (subIdx === 1) raw = (step.desc || '').trim();
    else if (subIdx === 2) raw = (step.expected || []).join('\n').trim();
    else if (subIdx === 3) raw = (step.data || []).join('\n').trim();
    else raw = '';
    return raw === '' ? '__BLANK__' : raw;
}

// 判断一个子步骤在当前 _stepsSubFilters 下是否显示（对所有已启用的 subIdx 做 AND）。
// 未启用（Set 不存在或 size=0）的子列跳过，等价于该维度不过滤。
function stepPassesSubFilters(step) {
    var f = S._stepsSubFilters || {};
    for (var subIdx = 1; subIdx <= 3; subIdx++) {
        var set = f[subIdx];
        if (!(set instanceof Set) || set.size === 0) continue;
        var key = _stepFieldKey(step, subIdx);
        if (!set.has(key)) return false;
    }
    return true;
}

// 计算某个 subIdx 在「所有通过主表筛选的行」的子步骤上，去重后的候选值与计数。
// 参考 buildColValueStats：使用 __BLANK__ 空值键，按字典序排序、空值置底。
// 注意：为避免弹窗里"看到的候选值"和"真实筛选后的分布"错位——
//   本次统计**仅忽略当前 subIdx 自身的筛选**，其他 subIdx 的筛选依然生效（与 buildColValueStats 的
//   getRowsPassingOtherFilters 语义等价，都遵循 Excel "候选值取决于其他筛选" 的直觉）
function _buildStepsSubValueStats(subIdx) {
    var headers = (S.data && S.data.headers) || [];
    var stepsCol = headers.indexOf('steps');
    if (stepsCol < 0) return [];
    // _viewRows 存的是原始行号数组（Array<number>），而非行数据本身；
    // 真实行内容需通过 S.data.rows[rowIdx] 二次取值。若无 _viewRows（首帧或未筛选），退化为遍历全表。
    var allRows = (S.data && S.data.rows) || [];
    var rowIdxs;
    if (Array.isArray(S._viewRows) && S._viewRows.length > 0) {
        rowIdxs = S._viewRows;
    } else {
        rowIdxs = [];
        for (var _fi = 0; _fi < allRows.length; _fi++) rowIdxs.push(_fi);
    }
    // 暂时隐藏当前 subIdx 的筛选，让候选值反映"未加此维度筛选前"的分布
    var savedSet = (S._stepsSubFilters && S._stepsSubFilters[subIdx]) || null;
    if (savedSet) { delete S._stepsSubFilters[subIdx]; }
    var map = new Map();
    try {
        for (var i = 0; i < rowIdxs.length; i++) {
            var row = allRows[rowIdxs[i]];
            if (!row) continue;
            var cellText = row[stepsCol];
            if (cellText === null || cellText === undefined) continue;
            var steps = _parseStepsText(String(cellText));
            for (var si = 0; si < steps.length; si++) {
                var step = steps[si];
                // 其他 subIdx 的筛选依旧影响候选值分布（对齐主表 getRowsPassingOtherFilters 语义）
                if (!stepPassesSubFilters(step)) continue;
                var key = _stepFieldKey(step, subIdx);
                map.set(key, (map.get(key) || 0) + 1);
            }
        }
    } finally {
        if (savedSet) S._stepsSubFilters[subIdx] = savedSet;
    }
    var arr = [];
    map.forEach(function (cnt, key) { arr.push({ key: key, count: cnt }); });
    // 排序规则（方案 B）：
    //   1) 空值 __BLANK__ 永远置底（与主表列筛选保持一致的视觉习惯）
    //   2) 按 count 倒序（高频命中优先，符合 Excel/表格类筛选器的"按频次"直觉）
    //   3) count 相同时用 tiebreak：纯数字键按数值升序，其余按字典序升序
    //   ——避免相同频次的项在两次打开弹窗时顺序抖动，也保留局部可预期性
    arr.sort(function (a, b) {
        if (a.key === '__BLANK__') return 1;
        if (b.key === '__BLANK__') return -1;
        if (a.count !== b.count) return b.count - a.count; // 频次倒序
        var na = parseFloat(a.key), nb = parseFloat(b.key);
        if (!isNaN(na) && !isNaN(nb) && String(na) === a.key && String(nb) === b.key) return na - nb;
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
    });
    return arr;
}

// 打开 steps 子列筛选弹窗。UI 骨架、事件绑定与 openColFilter 保持一致（用户操作无感），
// 只是数据源换成 `S._stepsSubFilters[subIdx]` + `_buildStepsSubValueStats`。
// 抽出成独立函数而非重构 openColFilter，是为了不干扰主列筛选路径的稳定性。
function openStepsSubFilter(subIdx, anchorEl) {
    var sf = document.getElementById('sortFilter');
    if (!sf) return;
    if (subIdx !== 1 && subIdx !== 2 && subIdx !== 3) return;
    var stats = _buildStepsSubValueStats(subIdx);
    var existing = (S._stepsSubFilters && S._stepsSubFilters[subIdx]) || null;
    var selected = new Set();
    if (existing instanceof Set) existing.forEach(function (v) { selected.add(v); });
    else stats.forEach(function (s) { selected.add(s.key); });
    // 复用 _filterUI 结构（供 renderColFilterList / syncSelectedToSearch 共用），
    // 但用 mode='subStep' 区分应用路径
    S._filterUI = { mode: 'subStep', subIdx: subIdx, kw: '', selected: selected, stats: stats };
    sf.innerHTML = ''
        + '<div class="xs-sf-search">'
        +   '<input type="text" id="sfSearch" placeholder="搜索值...">'
        +   '<span class="xs-sf-clear" id="sfSearchClear" title="清除">✕</span>'
        +   '<span class="xs-sf-reset" id="sfSearchReset" title="重置：恢复全选所有项">⟳</span>'
        + '</div>'
        + '<div class="xs-sf-list" id="sfList"></div>'
        + '<div class="xs-sf-footer">'
        +   '<button class="xs-sf-clear-btn" id="sfClearFilter">清除筛选</button>'
        +   '<div class="xs-sf-actions">'
        +     '<button class="xs-btn" id="sfCancel">取消</button>'
        +     '<button class="xs-btn xs-btn-p" id="sfApply">确定</button>'
        +   '</div>'
        + '</div>';
    sf.classList.add('show');
    positionColFilter(sf, anchorEl);
    var input = document.getElementById('sfSearch');
    var clear = document.getElementById('sfSearchClear');
    if (input) {
        input.addEventListener('input', function () {
            var kw = (input.value || '');
            S._filterUI.kw = kw;
            if (clear) clear.classList.toggle('show', !!kw);
            syncSelectedToSearch();
            renderColFilterList();
        });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); applyStepsSubFilter(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); closeColFilter(); }
            ev.stopPropagation();
        });
        // 复用公共粘贴兜底（webview 沙箱下原生 Ctrl/Cmd+V 偶发失效）
        if (typeof attachPasteFallback === 'function') attachPasteFallback(input);
        // 阻止 mousedown 冒泡导致弹窗被全局 click 关闭逻辑误判
        input.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    }
    if (clear) {
        clear.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (input) { input.value = ''; input.focus(); }
            S._filterUI.kw = '';
            clear.classList.remove('show');
            syncSelectedToSearch();
            renderColFilterList();
        });
    }
    var cancelBtn = document.getElementById('sfCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function (ev) { ev.stopPropagation(); closeColFilter(); });
    var resetBtn = document.getElementById('sfSearchReset');
    if (resetBtn) {
        resetBtn.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
        resetBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (input) { input.value = ''; }
            S._filterUI.kw = '';
            if (clear) clear.classList.remove('show');
            var _st = (S._filterUI && S._filterUI.stats) || [];
            S._filterUI.selected = new Set();
            _st.forEach(function (s) { S._filterUI.selected.add(s.key); });
            renderColFilterList();
            if (input) input.focus();
        });
    }
    var applyBtn = document.getElementById('sfApply');
    if (applyBtn) applyBtn.addEventListener('click', function (ev) { ev.stopPropagation(); applyStepsSubFilter(); });
    var clearFilterBtn = document.getElementById('sfClearFilter');
    if (clearFilterBtn) clearFilterBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (S._stepsSubFilters && S._stepsSubFilters[subIdx]) {
            delete S._stepsSubFilters[subIdx];
            if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
            renderTable();
        }
        closeColFilter();
    });
    sf.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    renderColFilterList();
    if (input) setTimeout(function () { input.focus(); }, 0);
}

function applyStepsSubFilter() {
    var ui = S._filterUI;
    if (!ui || ui.mode !== 'subStep') { closeColFilter(); return; }
    var subIdx = ui.subIdx;
    var stats = ui.stats || [];
    var totalKeys = stats.length;
    var sel = ui.selected;
    if (sel.size === 0) {
        showToast('至少需要选中一项', 'error');
        return;
    }
    if (!S._stepsSubFilters) S._stepsSubFilters = {};
    if (sel.size === totalKeys) {
        // 全选 = 无筛选
        if (S._stepsSubFilters[subIdx]) delete S._stepsSubFilters[subIdx];
    } else {
        var keep = new Set();
        stats.forEach(function (s) { if (sel.has(s.key)) keep.add(s.key); });
        S._stepsSubFilters[subIdx] = keep;
    }
    if (typeof persistUiStateDebounced === 'function') persistUiStateDebounced();
    closeColFilter();
    renderTable();
}
