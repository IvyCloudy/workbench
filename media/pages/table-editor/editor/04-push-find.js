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
        return record;
    });
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
    S.vscode.postMessage({ type: 'pushTestCase', data: payload, rowIndexMap: rowIndexMap });
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
    rows.forEach(function (row, ri) {
        headers.forEach(function (_, ci) {
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
            if (wrap) markText(wrap, S._findKw, idx === S._matchIdx);
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
    // 如果单元格内是 detail 链接，跳过 mark（保留链接结构）
    var detailSpan = node.querySelector('.xs-detail-link');
    if (detailSpan) return;
    node.innerHTML = html;
}

function clearFindHighlight() {
    document.querySelectorAll('td.xs-editable.highlight').forEach(function (td) {
        td.classList.remove('highlight', 'highlight-active');
        var wrap = td.querySelector('.xs-cell-wrap');
        if (wrap && !wrap.querySelector('.xs-detail-link')) {
            // 还原为纯文本
            wrap.innerHTML = escapeHtml(wrap.textContent || '');
        }
    });
}

function stepFind(dir) {
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
    if (S._matchIdx < 0 || S._matchIdx >= S._matches.length) {
        showToast('没有可替换项', 'error'); return;
    }
    var rep = document.getElementById('replaceInput');
    var newVal = rep ? rep.value : '';
    var m = S._matches[S._matchIdx];
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
    (S.data.rows || []).forEach(function (row, ri) {
        (S.data.headers || []).forEach(function (_, ci) {
            if (isFrozenCol(ci)) return; // tsId 列跳过
            // 标量数组列跳过全量替换，避免语义窜乱
            if (typeof isArrayCol === 'function' && isArrayCol(ci)) return;
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
