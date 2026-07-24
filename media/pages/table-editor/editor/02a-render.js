/* =============================================================================
 * 02a-render.js  —— 渲染（虚拟滚动）+ 单元格原地 patch
 * -----------------------------------------------------------------------------
 * 由原 02-render-bind.js 拆分而来，仅保留 renderTable 主入口、骨架/单行/
 * 全量/虚拟渲染各路径，以及单格 patchCell。事件绑定与行/单元格选区分别
 * 见 02b-bind.js / 02c-row-cell-sel.js / 02d-sel-utils.js。
 * 跨文件依赖通过全局作用域共享（S、formatCellValue、escapeHtml、dbg 等）。
 * ========================================================================== */

// ==================== 渲染（虚拟滚动） ====================
// 阈值：行数 >= 此值时启用虚拟滚动（仅渲染视口附近行）
var XS_VIRTUAL_THRESHOLD = 500;
// 估算行高（无自定义行高时使用），与 .xs-td 默认行高保持一致
// 估算行高（虚拟滚动用）：默认值 36，运行时由 _measureEstRowH 根据真实首行 offsetHeight 校正，
// 避免与硬编码 26/32 不符导致虚拟滚动累积偏差。
var XS_ROW_EST_HEIGHT = 36;
// 上下缓冲行数（视口外预渲染数量），减少滚动时的"白屏"感
var XS_VIRTUAL_BUFFER = 10;

// 缓存运行时探测到的 .xs-cell-wrap 单行行高（含字体/lineHeight 影响）。
// 用于把"行高像素"换算为"--xs-clamp 行数"。
// 取首个 .xs-cell-wrap 的 computed lineHeight；若 normal/读不到则用 fontSize*1.4 兜底；
// 整张表全失败时回退 18.2（保留旧值兼容）。
// 缓存键依赖 fontSize+lineHeight 字符串，主题/字号变化时会自动失效。
var _xsLineHCache = { key: '', val: 18.2 };
function _xsLineHeight() {
    try {
        var w = document.querySelector('.xs-cell-wrap');
        if (!w) return _xsLineHCache.val;
        var cs = window.getComputedStyle(w);
        var key = (cs.fontSize || '') + '|' + (cs.lineHeight || '');
        if (key === _xsLineHCache.key && _xsLineHCache.val > 0) return _xsLineHCache.val;
        var lh = parseFloat(cs.lineHeight);
        if (!isFinite(lh) || lh <= 0) {
            var fs = parseFloat(cs.fontSize) || 13;
            lh = fs * 1.4;
        }
        _xsLineHCache.key = key;
        _xsLineHCache.val = lh;
        return lh;
    } catch (_e) { return _xsLineHCache.val; }
}

// 主入口：根据当前数据规模选择渲染策略
function renderTable() {
    var c = document.getElementById('tableContainer');
    if (!c) { dbg('❌ renderTable: tableContainer not found'); return; }
    // 0) _modsTime 懒 GC：当 S.mods 已被整批 clear 时，同步重置时间戳映射避免历史 key 累积
    if (S._modsTime && S.mods && S.mods.size === 0) {
        // 用 typeof 检查快速判断非空对象，避免每次都 Object.keys 遍历
        for (var _mtk in S._modsTime) { delete S._modsTime[_mtk]; break; }
        // 若第一次 for 就 break 说明有键，此处兜底清干净
        S._modsTime = {};
    }
    // 1) 计算 view 行索引列表（应用搜索 + 列筛选）
    S._viewRows = _computeViewRows();
    // 1.1) 兜底：原数据非空但因"列筛选"过滤为 0 行（多见于编辑/清空/填充/删除/撤销
    //      后单元格新值不在旧筛选集合中），此时自动失效列筛选并重算，避免界面空白
    //      （搜索导致 0 命中时不处理，那是用户的预期行为，搜索框自身可见）
    var _rowsLen = (S.data && S.data.rows && S.data.rows.length) || 0;
    var _hasColFilters = S._colFilters && Object.keys(S._colFilters).length > 0;
    var _hasSearch = !!(S._searchKw && String(S._searchKw).trim());
    if (_rowsLen > 0 && S._viewRows.length === 0 && _hasColFilters) {
        dbg('🛟 renderTable bailout: rows=' + _rowsLen + ' viewRows=0 colFilters=' + Object.keys(S._colFilters).length + ' -> clear colFilters');
        S._colFilters = {};
        S._viewRows = _computeViewRows();
        if (typeof showToast === 'function') {
            showToast('数据修改后列筛选不再匹配任何行，已自动清除列筛选', 'warning');
        }
    }
    // 2) 整体外壳（表头 + colgroup + tbody 占位）只构建一次性骨架
    c.innerHTML = _buildSkeletonHtml();
    // 重要：tbody 已被重建（旧 tr 全部丢弃），必须清空上一次渲染留下的可视区间缓存，
    // 否则 _renderVirtualBody 的 "same range" 短路会跳过填充，导致 tbody 始终为空、页面显示为空。
    S._vRange = null;
    // 3) 决定走哪条路径
    var useVirtual = S._viewRows.length >= XS_VIRTUAL_THRESHOLD;
    S._virtualOn = useVirtual;
    if (useVirtual) {
        _computeRowOffsets();        // 计算所有 view 行的偏移表
        _bindVirtualScroll();        // 绑定/复用 scroll 监听
        _renderVirtualBody();        // 首次渲染视口
    } else {
        _renderAllBody();             // 全量渲染
    }
    bindTable();
    updateSelectionInfo();
    updatePushBtn();
    if (typeof updateFailedFilterBtn === 'function') updateFailedFilterBtn();
    if (typeof updateModifiedFilterBtn === 'function') updateModifiedFilterBtn();
    if (typeof updateAddedFilterBtn === 'function') updateAddedFilterBtn();
    if (typeof updateDeletedFilterBtn === 'function') updateDeletedFilterBtn();
    if (typeof updateMarkedFilterBtn === 'function') updateMarkedFilterBtn();
    updateSearchClear();
    if (typeof updateColSelClasses === 'function') updateColSelClasses();
    if (typeof updateCellSelClasses === 'function') updateCellSelClasses();
    if (S._findKw) paintFindHighlight();
    // 滚动位置恢复（持久化或外部 setScrollTop）
    if (S._pendingScrollTop && S._pendingScrollTop > 0) {
        var _top = S._pendingScrollTop;
        S._pendingScrollTop = 0;
        requestAnimationFrame(function () {
            c.scrollTop = _top;
            // 虚拟模式下还要再触发一次按位置渲染
            if (S._virtualOn) _renderVirtualBody();
        });
    }
    persistUiStateDebounced();
}

// 计算可见行索引列表（按 S.data.rows 原顺序，过滤搜索 / 列筛选未命中的）
function _computeViewRows() {
    var rows = (S.data && S.data.rows) || [];
    var headers = (S.data && S.data.headers) || [];
    var skw = (S._searchKw || '').toLowerCase();
    var hasColFilters = S._colFilters && Object.keys(S._colFilters).length > 0;
    // 仅看推送失败：当 _failedOnly=true 且失败集合非空时启用
    var hasFailedById = !!(S._pushFailedTsIds && S._pushFailedTsIds.size > 0);
    var failedOnly = !!(S._failedOnly && hasFailedById);
    var failedTsCol = failedOnly ? headers.indexOf('testcase_id') : -1;
    if (failedOnly && failedTsCol < 0) {
        // 没有 tsId 列，无法定位失败行，自动失效该筛选
        failedOnly = false;
    }
    // 仅看已修改行：基于 S.mods / _detailModCellKeys（未提交的本地修改）
    var _modRowSet = (typeof _getModifiedRowSet === 'function') ? _getModifiedRowSet() : new Set();
    var modifiedOnly = !!(S._modifiedOnly && _modRowSet && _modRowSet.size > 0);
    // 仅看新增行：基于新增行索引集合
    var addedOnly = !!(S._addedOnly && S._addedRowSet && S._addedRowSet.size > 0);
    // 仅看已删除行：展示 ghost 行，隐藏所有常规行
    var deletedOnly = !!(S._deletedOnly && S._deletedInfos && S._deletedInfos.length > 0);
    // 仅看已标记行：基于用户手动标记（含行标记和单元格标记）
    var markedOnly = !!(S._markedOnly);
    if (deletedOnly) {
        // 仅看已删除行时，常规行全部隐藏，只展示 ghost 区域
        return [];
    }
    if (!skw && !hasColFilters && !failedOnly && !modifiedOnly && !addedOnly && !markedOnly) {
        // 直接整段：避免大数组 push 开销
        var arr = new Array(rows.length);
        for (var i = 0; i < rows.length; i++) arr[i] = i;
        return arr;
    }
    var out = [];
    for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri];
        if (skw) {
            var hit = false;
            for (var k = 0; k < headers.length; k++) {
                var cv = row[k];
                if (cv === null || cv === undefined) continue;
                // 数组单元格走 formatCellValue（'; ' 拼接），避免默认 toString 产生 'a,b' 影响搜索体验
                var cvStr = Array.isArray(cv) ? formatCellValue(cv) : String(cv);
                if (cvStr.toLowerCase().indexOf(skw) >= 0) { hit = true; break; }
            }
            if (!hit) continue;
        }
        if (hasColFilters) {
            var passed = true;
            for (var fc in S._colFilters) {
                if (!S._colFilters.hasOwnProperty(fc)) continue;
                var allow = S._colFilters[fc];
                var fcIdx = parseInt(fc, 10);
                var cellVal = row[fcIdx];
                var cellKey;
                if (cellVal === null || cellVal === undefined || cellVal === '') cellKey = '__BLANK__';
                else if (Array.isArray(cellVal)) cellKey = (cellVal.length === 0 ? '__BLANK__' : formatCellValue(cellVal));
                else cellKey = String(cellVal);
                if (!allow.has(cellKey)) { passed = false; break; }
            }
            if (!passed) continue;
        }
        if (failedOnly) {
            var _tsv = (failedTsCol >= 0) ? row[failedTsCol] : undefined;
            var _isFailedRow = false;
            if (_tsv !== undefined && _tsv !== null && _tsv !== '' && S._pushFailedTsIds.has(String(_tsv))) {
                _isFailedRow = true;
            }
            if (!_isFailedRow) continue;
        }
        if (modifiedOnly) {
            if (!_modRowSet.has(ri)) continue;
        }
        if (addedOnly) {
            if (!S._addedRowSet.has(ri)) continue;
        }
        if (markedOnly) {
            if (!_isRowMarked(ri)) continue;
        }
        out.push(ri);
    }
    return out;
}

// 构建 ghost 行 HTML（快照中有但当前数据中已删除的行，显示在表格底部）
function _buildGhostRowsHtml(headers) {
    var infos = S._deletedInfos;
    if (!infos || infos.length === 0) return '';
    var tsIdIdx = headers.indexOf('testcase_id');
    var tcIdx = headers.indexOf('testCaseNo');
    if (tsIdIdx < 0) return '';
    var totalCols = headers.length + 1; // +1 是复选框列
    var html = '<tr class="xs-ghost-sep"><td colspan="' + totalCols + '">已删除 ' + infos.length + ' 行</td></tr>';
    for (var i = 0; i < infos.length; i++) {
        var info = infos[i];
        var cells = info.cells || [];
        html += '<tr class="xs-ghost-row">';
        html += '<td class="xs-td xs-td-cb xs-ghost-cb">🗑</td>';
        for (var ci = 0; ci < headers.length; ci++) {
            var val = '';
            if (String(headers[ci]) === 'testcase_id') {
                // testcase_id 直接取 info.tsId，避免依赖 cells 中可能过期的值
                val = info.tsId || '';
            } else {
                // cells 长度与 headers 一致（testCaseNo 位置为空字符串），直接用 ci 索引
                val = (ci < cells.length && cells[ci] !== undefined && cells[ci] !== '') ? cells[ci] : '';
            }
            html += '<td class="xs-td xs-td-ghost"><del>' + escapeHtml(val) + '</del></td>';
        }
        html += '</tr>';
    }
    return html;
}

// 构建表格骨架（colgroup + thead + 空 tbody），不含具体 tr
// 展开模式：colgroup 拆 5 子列，thead 仅一行；steps 列的 th 用 colspan=5，
//           内部纵向堆叠"顶部主标题条(步骤/steps + 筛选)"和"底部子表头条(序号|步骤描述|预期结果|数据|操作)"。
//           底部子表头条通过精确像素宽度与 colgroup 子列对齐。

// steps 子列默认宽（序号|步骤描述|预期结果|数据|操作），总和=404
var STEPS_SUB_W_DEFAULT = [32, 132, 128, 72, 60];
var STEPS_SUB_MIN = [24, 60, 60, 40, 56]; // 每列最小宽，防止拖到不可读；操作列需容纳单列排布的 3 个 22px 图标

// 读取 steps 5 子列宽：优先用 S._stepsSubW，否则返回默认值副本。
// 返回值一定是长度 5 的正数数组，供渲染层与拖动逻辑共享。
function _getStepsSubWSafe() {
    var w = S && S._stepsSubW;
    if (Array.isArray(w) && w.length === 5) {
        var ok = true;
        for (var i = 0; i < 5; i++) {
            if (typeof w[i] !== 'number' || w[i] < STEPS_SUB_MIN[i]) { ok = false; break; }
        }
        if (ok) return w.slice();
    }
    return STEPS_SUB_W_DEFAULT.slice();
}

// 计算 steps 主列总宽（5 子列之和），供拖动时同步主表 colWidths[stepsCol]
function _getStepsTotalW() {
    var w = _getStepsSubWSafe();
    return w[0] + w[1] + w[2] + w[3] + w[4];
}

function _buildSkeletonHtml() {
    var headers = (S.data && S.data.headers) || [];
    var stepsCol = headers.indexOf('steps');
    var hasSteps = (stepsCol >= 0) && isYamlFile();
    var expanded = !!(S._stepsExpanded && hasSteps);
    // steps 子列宽：优先用 S._stepsSubW（拖动后持久化），后退到默认。
    // 默认列宽：[序号 32, 步骤描述 132, 预期结果 128, 数据 72, 操作 40]，总和 404
    var stepsSubW = expanded ? _getStepsSubWSafe() : []; // 序号|步骤描述|预期结果|数据|操作
    var html = '<table class="xs-table"><colgroup>';
    html += '<col style="width:50px">';
    for (var i = 0; i < headers.length; i++) {
        if (expanded && i === stepsCol) {
            for (var si = 0; si < stepsSubW.length; si++) {
                var sw = stepsSubW[si];
                if (sw === '') { html += '<col>'; }
                else if (typeof sw === 'number') { html += '<col style="width:' + sw + 'px">'; }
                else { html += '<col style="width:' + sw + '">'; }
            }
        } else {
            var w = S.colWidths[i] || 160;
            html += '<col style="width:' + w + 'px">';
        }
    }
    html += '</colgroup><thead>';
    // 单行表头：非 steps 列常规 th；steps 列 th 用 colspan=5，内部两层堆叠。
    html += '<tr>';
    html += '<th class="xs-th xs-th-cb xs-th-rownum" title="点击全选整表">#</th>';
    var labels = (S && S.headerLabels) || {};
    for (var j = 0; j < headers.length; j++) {
        var hdr = headers[j];
        var hasFilter = !!(S._colFilters && S._colFilters[j]);
        var filterCls = hasFilter ? ' active' : '';
        var filterTitle = hasFilter ? '已应用筛选 (点击修改)' : '筛选';
        var colSelCls = S.colSel.has(j) ? ' xs-col-selected' : '';
        var frozenCls = (String(hdr) === 'testcase_id') ? ' xs-th-frozen' : '';
        var cnLabel = labels[String(hdr)];
        var hasCn = !!(cnLabel && typeof cnLabel === 'string');
        var titleLabel = hasCn ? (cnLabel + ' (' + String(hdr) + ')') : String(hdr);
        var cnHtml = hasCn
            ? '<span class="xs-th-cn" title="' + escapeHtml(cnLabel) + '">' + escapeHtml(cnLabel) + '</span>'
            : '';
        var keyCls = hasCn ? 'xs-th-text' : 'xs-th-text xs-th-text-only';
        var isStepsGroup = (expanded && j === stepsCol);
        var colSpanAttr = isStepsGroup ? ' colspan="5"' : '';
        // steps 展开时：主 th 加 xs-th-group 类，内部结构 = 顶部主标题条(.xs-th-top) + 底部子表头条(.xs-th-sub-row)
        // 顶部条保留筛选漏斗；底部条用固定像素宽度对齐 colgroup 子列，与内层表格 tbody 完全对齐。
        // 非 steps 列保持原有单层结构，避免对既有布局产生任何影响。
        var stepsGroupCls = isStepsGroup ? ' xs-th-group' : '';
        var topOpen = isStepsGroup ? '<div class="xs-th-top">' : '';
        var topClose = isStepsGroup ? '</div>' : '';
        // 顶部条右上角就近收起按钮（仅步骤展开态提供）：位于步骤/steps 主表头内，方便用户就近点击退出展开模式
        // 实现依赖顶部工具栏的 #expandStepsBtn.click()，避免重复实现切换逻辑
        var collapseBtnHtml = isStepsGroup
            ? '<span class="xs-th-group-collapse" data-collapse-steps="1" title="收起步骤">'
                + '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">'
                +   '<path fill="currentColor" d="M3 7.2l3-3 3 3-.7.7L6 5.6 3.7 7.9z"/>'
                + '</svg>'
              + '</span>'
            : '';
        // 未展开态下的 steps 列：内嵌"就近展开"按钮（向下箭头），与展开态的"就近收起"按钮
        // 形成一对镜像交互 —— 用户无需回到顶部工具栏就能就地展开/收起。
        // 依然复用 #expandStepsBtn.click() 复用切换逻辑；用 xs-th-inline-expand 类作为 flex 内联项，
        // 排在筛选漏斗右侧，天然对齐、不与列宽 resizer 冲突。
        var inlineExpandBtnHtml = (!isStepsGroup && hasSteps && j === stepsCol)
            ? '<span class="xs-th-inline-expand" data-collapse-steps="1" title="展开步骤">'
                + '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">'
                +   '<path fill="currentColor" d="M3 4.8l3 3 3-3-.7-.7L6 6.4 3.7 4.1z"/>'
                + '</svg>'
              + '</span>'
            : '';
        var subHeaderHtml = '';
        if (isStepsGroup) {
            // 子表头前 4 列右侧内嵌拖手柄：data-sub-idx="0..3"，拖动时修改 S._stepsSubW[i] 与 [i+1]。
            // 最后一列（操作）不需内嵌拖手柄，避免拖到主表外。
            var _w = stepsSubW;
            // 子表头条总宽 = 5 子列之和，写入 inline width，保证与内层子表 xse-table 的 colgroup 总宽完全一致。
            // 不再依赖 flex 与外层 th border-box 的隐式撑开（两者压缩比不一致会导致表头/数据错位）。
            var _subRowTotalW = _getStepsTotalW();
            // 子列筛选漏斗：只对 描述(1) / 预期(2) / 数据(3) 提供；序号(0) / 操作(4) 无筛选。
            // 生成漏斗 HTML 的辅助：subIdx 传当前子列索引；hasFilter 从 S._stepsSubFilters 读取
            function _subFilterBtn(idx) {
                var sf = S._stepsSubFilters || {};
                var active = (sf[idx] instanceof Set && sf[idx].size > 0);
                var cls = 'xs-sub-filter' + (active ? ' active' : '');
                var t = active ? '已应用筛选 (点击修改)' : '筛选此子列';
                return '<span class="' + cls + '" data-sub-filter-idx="' + idx + '" title="' + t + '">'
                    +   '<svg class="xs-funnel-icon" viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">'
                    +     '<path fill="currentColor" d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 .8 1.6L10 8.5V13a1 1 0 0 1-1.45.9l-2-1A1 1 0 0 1 6 12V8.5L2.2 3.6A1 1 0 0 1 2 3z"/>'
                    +   '</svg>'
                    + '</span>';
            }
            subHeaderHtml = ''
                + '<div class="xs-th-sub-row" style="width:' + _subRowTotalW + 'px">'
                +   '<span class="xs-th-sub xs-th-sub-id" data-sub-idx="0" style="width:' + _w[0] + 'px">序号'
                +     '<span class="xs-sub-resizer" data-sub-idx="0" title="拖动调整子列宽"></span>'
                +   '</span>'
                +   '<span class="xs-th-sub xs-th-sub-desc" data-sub-idx="1" style="width:' + _w[1] + 'px">'
                +     '<span class="xs-th-sub-text">步骤描述</span>'
                +     _subFilterBtn(1)
                +     '<span class="xs-sub-resizer" data-sub-idx="1" title="拖动调整子列宽"></span>'
                +   '</span>'
                +   '<span class="xs-th-sub xs-th-sub-expected" data-sub-idx="2" style="width:' + _w[2] + 'px">'
                +     '<span class="xs-th-sub-text">预期结果</span>'
                +     _subFilterBtn(2)
                +     '<span class="xs-sub-resizer" data-sub-idx="2" title="拖动调整子列宽"></span>'
                +   '</span>'
                +   '<span class="xs-th-sub xs-th-sub-data" data-sub-idx="3" style="width:' + _w[3] + 'px">'
                +     '<span class="xs-th-sub-text">数据</span>'
                +     _subFilterBtn(3)
                +     '<span class="xs-sub-resizer" data-sub-idx="3" title="拖动调整子列宽"></span>'
                +   '</span>'
                +   '<span class="xs-th-sub xs-th-sub-op" data-sub-idx="4" style="width:' + _w[4] + 'px">操作</span>'
                + '</div>';
        }
        html += '<th class="xs-th' + colSelCls + frozenCls + stepsGroupCls + '" data-col="' + j + '" title="' + escapeHtml(titleLabel) + '"' + colSpanAttr + '>'
            + topOpen
            +   '<div class="xs-th-inner">'
            +     '<div class="xs-th-labels">'
            +       cnHtml
            +       '<span class="' + keyCls + '">' + escapeHtml(String(hdr)) + '</span>'
            +     '</div>'
            +     '<span class="xs-th-filter' + filterCls + '" data-filter-col="' + j + '" title="' + filterTitle + '">'
            +       '<svg class="xs-funnel-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">'
            +         '<path fill="currentColor" d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 .8 1.6L10 8.5V13a1 1 0 0 1-1.45.9l-2-1A1 1 0 0 1 6 12V8.5L2.2 3.6A1 1 0 0 1 2 3z"/>'
            +       '</svg>'
            +     '</span>'
            +     inlineExpandBtnHtml
            +   '</div>'
            + collapseBtnHtml
            + topClose
            + subHeaderHtml
            + (isStepsGroup ? '' : '<div class="xs-resizer" data-col="' + j + '" title="拖动调整列宽；双击自适应"></div>')
            + '</th>';
    }
    html += '</tr>';
    html += '</thead><tbody id="xsTbody"></tbody></table>';
    // 展开模式添加标记 class，允许表格超出容器宽度（避免列被挤压）
    if (expanded) {
        html = html.replace('<table class="xs-table">', '<table class="xs-table xs-steps-expanded">');
    }
    return html;
}

// 渲染一个标量数组单元格的 chip HTML。
// 默认在可视宽度内不换行（超出被截断）；行高被拉大后 CSS 会换行全部显示。
function _buildArrayChipsHtml(arr) {
    var list = Array.isArray(arr) ? arr : [];
    if (list.length === 0) return ''; // 空数组单元格不渲染任何内容（需求 A：留空）
    var html = '<div class="xs-cell-chips">';
    for (var i = 0; i < list.length; i++) {
        var raw = list[i];
        var text = (raw === null || raw === undefined) ? '' : String(raw);
        var clsExtra = text === '' ? ' is-empty' : '';
        var titleAttr = text ? ' title="' + escapeHtml(text) + '"' : '';
        html += '<span class="xs-chip' + clsExtra + '"' + titleAttr + '>' + escapeHtml(text || '空') + '</span>';
    }
    html += '</div>';
    return html;
}

// 构造单行 tr 的 HTML（被全量与虚拟两条路径共用）
function _buildRowHtml(ri, tsIdColIdx) {
    var headers = (S.data && S.data.headers) || [];
    var stepsCol = headers.indexOf('steps');
    var hasSteps = (stepsCol >= 0) && isYamlFile();
    var expanded = !!(S._stepsExpanded && hasSteps);
    var row = S.data.rows[ri] || [];
    var selCls = S.sel.has(ri) ? ' selected' : '';
    var rh = S.rowHeights[ri];
    var resizedCls = (rh && rh > 0) ? ' xs-tr-resized' : '';
    var rowStyle = (rh && rh > 0) ? ' style="height:' + rh + 'px"' : '';
    // 多行省略号：按当前行高换算可显示行数，写入 CSS 变量 --xs-clamp
    // 行高 - td 上下 padding/border(14px) = wrap 可视高，除以单行高(font-size 13px*line-height 1.4≈18.2px)
    //
    // 例外：若该行被标记为"完全展开"（双击/拖动 _expandRowToFitContent 设置），
    //       行高已按真实内容算好，此时不能再用 floor(rowH/lineH) 反推 clamp ——
    //       简单除法+floor 总会少算 1 行左右，触发 ellipsis 截断；
    //       所以这种情况下不输出 --xs-clamp，让 CSS 默认 99 行接管，文本完整显示。
    //
    // 兜底：S.rowHeights 有自定义高度但 _rowExpanded 未登记的场景（如老快照、
    //   外部代码直接写入 rowHeights 等）会出现"行高变高但内容仍被截断"的不一致。
    //   这里在渲染期顺手补登记，让两个状态位最终一致。
    if (rh && rh > 0) {
        if (!S._rowExpanded) S._rowExpanded = new Set();
        if (!S._rowExpanded.has(ri)) S._rowExpanded.add(ri);
    }
    var clampVar = '';
    var isFullyExpanded = !!(S._rowExpanded && S._rowExpanded.has(ri));
    var _clampLines = _computeClampLines(rh, isFullyExpanded);
    if (_clampLines) {
        clampVar = '--xs-clamp:' + _clampLines + ';';
    }
    var failCls = '';
    var failReason = '';
    var rowFailTime = 0;  // 该行的推送失败时间戳；若不在失败集合中则为 0
    if (S._pushFailedTsIds && S._pushFailedTsIds.size > 0 && tsIdColIdx >= 0) {
        var rowTsId = row[tsIdColIdx];
        if (rowTsId !== undefined && rowTsId !== null && rowTsId !== '' && S._pushFailedTsIds.has(String(rowTsId))) {
            failCls = ' xs-tr-push-failed';
            if (S._pushFailedReasons) {
                var _r = S._pushFailedReasons.get(String(rowTsId));
                if (_r) failReason = String(_r);
            }
            if (S._pushFailedTime) {
                var _ft = S._pushFailedTime.get(String(rowTsId));
                if (typeof _ft === 'number') rowFailTime = _ft;
            }
            // 兜底：只要已确认在失败集合中，就一定要有一个非 0 时间。
            //   否则 rowFailTime==0 会导致后续失败红底竞争永远不胜出 → 红底丢失。
            //   历史快照遗漏 time 的情况（旧版本升级 / 数据损坏）会命中。
            if (rowFailTime === 0) rowFailTime = 1;
        }
    }
    // 行号格 title：失败行显示「原始行号: N | 推送失败：<原因>」，便于鼠标悬停查看失败原因。
    var rowNumTitle = '原始行号: ' + (ri + 1);
    if (failReason) rowNumTitle += ' | 推送失败：' + failReason;
    // 渲染为普通行；不再提供整行 HTML5 拖动排序能力（与矩形拖选、行横扫存在交互冲突）。
    // 先遍历一次构造所有单元格 inner HTML，检测是否含真实换行符 \n
    var cells = [];
    var hasBr = false;
    // 样例数据行冻结：整行只读（testcase_id 命中占位值），用于渲染冻结视觉 + 后续编辑拦截
    var rowFrozen = isFrozenRow(ri);
    for (var ci = 0; ci < headers.length; ci++) {
        var v = row[ci];
        var _modKey = ri + ',' + ci;
        var _hasMod = (S.mods.has(_modKey) || (S._detailModCellKeys && S._detailModCellKeys.has(_modKey)));
        // 懒补修改时间戳：有 mod 但无时间戳时补一个（兼容历史代码路径 / undo 恢复）
        if (_hasMod && S._modsTime && S._modsTime[_modKey] == null) {
            S._modsTime[_modKey] = Date.now();
        }
        var modCls = _hasMod ? ' modified' : '';
        var _modTime = _hasMod ? ((S._modsTime && S._modsTime[_modKey]) || 0) : 0;
        // 按时间顺序选择高亮：最新操作的类型优先显示
        // bestTime 和 bestClass/bestStyle 记录当前生效的高亮
        var bestTime = 0;
        var bestClass = '';
        var bestInlineStyle = '';
        var bestMkInfo = null; // {bgColor, fontColor}

        // 1) 推送变更高亮（行级橙 + 单元格级黄）：作为一组同时间戳的整体参与竞争
        //    同一次推送内，单元格级（黄）优先于行级（橙），保留"内层套外层"语义
        //    但若该 cell 的修改时间晚于推送时间（推送后又改了），则放弃 pushUpdCls，
        //    让 modified 黄底独立显示，直观提示"改动已产生但尚未再次推送"
        var pushUpdCls = '';
        if (S._highlightedCells) {
            if (S._highlightedCells.cells && S._highlightedCells.cells.has(ri + ':' + ci)) {
                pushUpdCls = ' xs-td-push-updated'; // 单元格级：黄色
            } else if (S._highlightedCells.rowSet && S._highlightedCells.rowSet.has(ri)
                && (S._highlightedCells.colIdx === -1 || S._highlightedCells.colIdx === ci)) {
                pushUpdCls = ' xs-td-push-updated-row'; // 行级：橙色
            }
        }
        if (pushUpdCls) {
            var t = S._highlightedTime || 0;
            // 修改时间胜出：跳过 pushUpdCls，保留 modCls 独立生效
            if (_modTime > t) {
                pushUpdCls = '';
            } else if (t >= bestTime) {
                bestTime = t; bestClass = pushUpdCls; bestMkInfo = null;
            }
        }
        // 2) 新增行高亮
        if (S._addedRowSet && S._addedRowSet.has(ri)) {
            var t = S._addedRowTime || 0;
            if (t >= bestTime) { bestTime = t; bestClass = ' xs-td-push-added'; modCls = ''; bestMkInfo = null; }
        }
        // 3) 用户手动标记高亮
        if (typeof isUserMarked === 'function') {
            var mkInfo = isUserMarked(ri, ci);
            if (mkInfo) {
                var t = mkInfo.timestamp || 0;
                if (t >= bestTime) { bestTime = t; bestClass = ' xs-td-user-marked'; bestMkInfo = mkInfo; modCls = (bestClass === ' xs-td-push-added') ? '' : modCls; }
            }
        }
        // 5) 推送失败高亮：作为单元格级"红底"候选项参与时间竞争
        //    - 若失败时间 >= 其他高亮时间：失败色覆盖（清除 user-marked 内联色，加 xs-td-push-failed）
        //    - 否则：标记为 xs-td-overrides-fail，让 CSS 保留原高亮色（避免被 tr.xs-tr-push-failed 红底吞掉）
        //    - 若修改时间晚于失败时间，保留 modCls 并追加 xs-td-overrides-fail，让 CSS 释放 modified 黄底
        var failOverridden = false;
        if (rowFailTime > 0) {
            if (rowFailTime >= bestTime) {
                // 失败胜出临时斠标：但若本 cell 的 mod 时间更晚（失败后又改了），则保留 modified 叠加
                if (_modTime > rowFailTime) {
                    // 保留 modCls 不变，仅把失败当作“被覆盖”标记
                    failOverridden = true;
                } else {
                    bestTime = rowFailTime;
                    bestClass = ' xs-td-push-failed';
                    bestMkInfo = null;          // 清除可能已挂上的用户标记色，让失败红底完全生效
                    modCls = '';
                }
            } else {
                failOverridden = true;       // 其他高亮时间更新 → 让其覆盖失败色
            }
        }

        var hiliCls = bestClass + (failOverridden ? ' xs-td-overrides-fail' : '');
        var mkStyle = '';
        if (bestMkInfo) {
            var st = '';
            // 加 !important 确保在失败行场景下也能盖过 CSS 规则中的 !important 默认色
            if (bestMkInfo.bgColor) st += 'background:' + bestMkInfo.bgColor + ' !important;';
            if (bestMkInfo.fontColor) st += 'color:' + bestMkInfo.fontColor + ' !important;';
            if (st) mkStyle = ' style="' + st + '"';
        }
        var colSelCls2 = S.colSel.has(ci) ? ' xs-col-selected' : '';
        var frozenCls2 = (String(headers[ci]) === 'testcase_id' || rowFrozen) ? ' xs-td-frozen' : '';
        // 单元格内部 HTML 与相关 cls/title 由 _buildCellInner 统一产出，与 patchCell 复用。
        var _ci = _buildCellInner(ri, ci, v);
        var inner = _ci.inner;
        var isDetail = _ci.isDetail;
        var arrCellCls = _ci.arrCellCls;
        var titleAttr = _ci.titleAttr;
        if (inner.indexOf('\n') >= 0) hasBr = true;
        cells.push({ inner: inner, modCls: modCls, colSelCls2: colSelCls2, frozenCls2: frozenCls2, hiliCls: hiliCls, isDetail: isDetail, arrCellCls: arrCellCls, titleAttr: titleAttr, mkStyle: mkStyle });
    }
    // 内容中的换行符 \n 由 CSS white-space 控制：
    //   - 单行模式（nowrap）下 \n 被视为空格，不会撑高
    //   - 多行模式（pre-wrap）下 \n 产生真实换行
    // 故此处无需任何额外内联样式补丁。
    var multilineClamp = clampVar;
    // 检测是否含有展开的步骤子表格（该行高度已被 sub-table 撑开，其他列应自适应换行）
    var expandedStepsCls = '';
    for (var _ec2 = 0; _ec2 < cells.length; _ec2++) {
        if (cells[_ec2].inner && cells[_ec2].inner.indexOf('xs-step-expanded') >= 0) {
            expandedStepsCls = ' xs-tr-expanded-steps';
            break;
        }
    }
    var html = '<tr data-row="' + ri + '" class="' + (selCls + resizedCls + failCls + expandedStepsCls + (rowFrozen ? ' xs-tr-frozen' : '')).trim() + '"' + rowStyle + '>'
        + '<td class="xs-td xs-td-cb xs-td-rownum" data-row="' + ri + '" title="' + escapeHtml(rowNumTitle) + '">'
        +   '<span class="xs-rownum">' + (ri + 1) + '</span>'
        +   '<div class="xs-row-resizer" data-row="' + ri + '" title="拖动调整行高；双击自适应内容"></div>'
        + '</td>';
    for (var ci2 = 0; ci2 < cells.length; ci2++) {
        var c = cells[ci2];
        var wrapStyleAttr = multilineClamp ? ' style="' + multilineClamp + '"' : '';
        var spanAttr = (expanded && ci2 === stepsCol) ? ' colspan="5"' : '';
        html += '<td class="xs-td xs-editable' + c.modCls + c.colSelCls2 + c.frozenCls2 + c.hiliCls + (c.isDetail ? ' xs-detail-cell' : '') + c.arrCellCls + '" data-row="' + ri + '" data-col="' + ci2 + '"' + spanAttr + c.titleAttr + c.mkStyle + '>'
            + '<div class="xs-cell-wrap"' + wrapStyleAttr + '>' + c.inner + '</div></td>';
    }
    html += '</tr>';
    return html;
}

// 根据行高计算 --xs-clamp 行数。
// 在 _buildRowHtml / patchCell 两处重复使用：
//   - 未设自定义行高 (rh<=0) 返回 ""
//   - 已完全展开 (isFullyExpanded) 返回 ""（CSS 默认 99 行接管，文本完整显示）
//   - 其它情况返回可显示行数字符串（供拼接 "--xs-clamp:N;"）
function _computeClampLines(rh, isFullyExpanded) {
    if (!(rh && rh > 0) || isFullyExpanded) return '';
    var wrapH = rh - 14; // td padding+border = 14px
    var lines = Math.max(1, Math.floor(wrapH / _xsLineHeight()));
    return String(lines);
}

// 构造单元格内部 HTML 片段。为 _buildRowHtml / patchCell 共用。
// 返回：{ inner, isDetail, isArrCol, arrCellCls, titleAttr, rawText }
function _buildCellInner(ri, ci, v) {
    var rawText = formatCellValue(v);
    var isDetail = (typeof hasDetailRowsAtCol === 'function') && hasDetailRowsAtCol(ri, ci);
    // 即使是空单元格，只要该列是 detail 列，也提供可点击入口（[空] 链接 → 打开弹窗初始化数据）
    var isEmptyDetail = false;
    if (!isDetail && (typeof isDetailColumn === 'function') && isDetailColumn(ci) && (rawText === '' || v == null || v === undefined)) {
        isDetail = true;
        isEmptyDetail = true;
    }
    var isArrCol = (typeof isArrayCol === 'function') && isArrayCol(ci);
    // tooltip：展开模式 steps 子表格已内联展示，无需原生 tooltip 显示原始文本
    var titleAttr = '';
    if (rawText && !(isDetail && S._stepsExpanded && (rawText.indexOf('【步骤描述】') === 0 || rawText.indexOf('【预期结果】') >= 0))) {
        titleAttr = ' title="' + escapeHtml(rawText.replace(/\\n/g, '\n')) + '"';
    }
    var inner;
    var arrCellCls = '';
    if (isDetail) {
        // 展开模式且内容为 steps 合并文本 → 四列内联子表格；否则显示为链接
        if (S._stepsExpanded && rawText && (rawText.indexOf('【步骤描述】') === 0 || rawText.indexOf('【预期结果】') >= 0)) {
            inner = '<div class="xs-step-expanded" data-detail-row="' + ri + '" data-detail-col="' + ci + '">' + _buildStepExpandedHtml(rawText) + '</div>';
        } else {
            var detailLinkCls = isEmptyDetail ? 'xs-detail-link xs-detail-empty' : 'xs-detail-link';
            var detailDisplay = isEmptyDetail ? '[空]' : rawText;
            inner = '<span class="' + detailLinkCls + '" data-detail-row="' + ri + '" data-detail-col="' + ci + '">' + escapeHtml(detailDisplay) + '</span>';
        }
    } else if (isArrCol) {
        var arr = Array.isArray(v) ? v : [];
        inner = _buildArrayChipsHtml(arr);
        arrCellCls = ' xs-arr-cell';
    } else {
        // 把字面 "\n"（两字符）统一成真实换行符；保留真实换行符 \n（U+000A）。
        // 由 CSS 控制呈现：
        //   - 默认 .xs-cell-wrap 为 white-space:nowrap → \n 被视为空格，单元格保持单行不被撑高
        //   - .xs-tr-resized .xs-cell-wrap 为 white-space:pre-wrap → \n 产生真实换行
        // 这样无需占位 span，行为最简单稳健。
        inner = escapeHtml(rawText).replace(/\\n/g, '\n');
    }
    return { inner: inner, isDetail: isDetail, isArrCol: isArrCol, arrCellCls: arrCellCls, titleAttr: titleAttr, rawText: rawText };
}

// 将已展开的步骤合并文本解析为四列表格：序号 | 步骤描述 | 数据 | 预期结果
function _buildStepExpandedHtml(text) {
    if (!text) return '';
    var lines = text.replace(/\\n/g, '\n').split(/\r?\n/);
    var steps = [];
    var cur = null;
    var section = null; // 'desc' | 'data' | 'expected'

    for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!t) continue;

        // 新步骤起始
        if (/^【步骤描述】$/.test(t)) {
            if (cur) steps.push(cur);
            cur = { id: '', desc: '', data: [], expected: [] };
            section = 'desc';
            continue;
        }
        if (!cur) continue;

        // 区块切换
        if (/^【数据】$/.test(t)) { section = 'data'; continue; }
        if (/^【预期结果】$/.test(t)) { section = 'expected'; continue; }

        // 步骤标题行：步骤N [操作内容]
        //   拼接侧固定使用自然数序号（见 _buildStepCombined），
        //   所以此处只匹配纯数字，避免把 desc 里的"步骤xxx"正文误识别。
        //   guard：仅在 section='desc' 且 cur.id/cur.desc 均为空时吸收，
        //   防止多行 desc 中首行以"步骤N"开头的正文覆盖已解析结果。
        var m = t.match(/^步骤(\d+)(?:\s+(.*))?$/);
        if (m && section === 'desc' && cur.id === '' && cur.desc === '') {
            cur.id = m[1];
            cur.desc = (m[2] || '').trim();
            continue;
        }

        // 内容收集
        if (section === 'desc') {
            cur.desc += (cur.desc ? '\n' : '') + t;
        } else if (section === 'data') {
            cur.data.push(t);
        } else if (section === 'expected') {
            cur.expected.push(t);
        }
    }
    if (cur) steps.push(cur);
    if (steps.length === 0) return '';

    // 自愈：剥离 desc 中历史累积的"步骤<任意 id>"冗余前缀
    //   历史 bug：拼接侧曾把 step.id 直接嵌入"步骤<id>"，当 id 为非纯数字时
    //   （如 step001-1）无法被旧解析器识别，focusout 会把整行当作 desc 存回
    //   operation，下轮拼接再叠加，形成累积污染。
    //   拼接侧已改用自然数序号从根本上杜绝，但历史文件仍可能存在多次累积的脏 desc，
    //   这里以宽松匹配（步骤 + 任意非空白 token + 空白/行尾）循环剥离，
    //   保证渲染稳定；下次编辑保存后即写回干净数据。
    var _cleanRE = /^步骤\S+(?:\s+|$)/;
    for (var _cs = 0; _cs < steps.length; _cs++) {
        var _cst = steps[_cs];
        if (!_cst) continue;
        var _guard = 0;
        while (_cleanRE.test(_cst.desc) && _guard++ < 32) {
            _cst.desc = _cst.desc.replace(_cleanRE, '');
        }
    }
    // 关键点：`data-xse-step` 必须使用**原始索引**（在完整 steps 数组中的位置），
    // 否则编辑时 `steps-editor.js` 的 splice 会串行到错误的步骤上，导致数据丢失。
    // 因此我们保留 `origIdx`，用它绑定 data-xse-step / data-xse-copy 等，
    // 显示用的序号 `step.id` 保持解析出来的原值不变。
    var visibleSteps = [];
    for (var _si = 0; _si < steps.length; _si++) {
        var _step = steps[_si];
        _step.origIdx = _si;
        if (typeof stepPassesSubFilters !== 'function' || stepPassesSubFilters(_step)) {
            visibleSteps.push(_step);
        }
    }

    // 子标题 chip 分色：data-kind 属性驱动 CSS 颜色（UI=蓝、接口=紫、数据=绿）
    function _subKind(title) {
        if (title === '【接口调用】') return 'api';
        if (title === '【数据检查】') return 'data';
        return 'ui';
    }
    // colgroup 与主表 steps 子列完全一致（从 S._stepsSubW 读取运行时宽度）
    var _sw = _getStepsSubWSafe();
    var _totalW = _sw[0] + _sw[1] + _sw[2] + _sw[3] + _sw[4];
    // 内层表格宽度直接锁定为 colgroup 总和，避免 width:100% 导致的等比缩放（与主表头子表头条归一，确保严格对齐）
    var html = '<table class="xse-table" style="width:' + _totalW + 'px">';
    html += '<colgroup>'
        + '<col style="width:' + _sw[0] + 'px">'
        + '<col style="width:' + _sw[1] + 'px">'
        + '<col style="width:' + _sw[2] + 'px">'
        + '<col style="width:' + _sw[3] + 'px">'
        + '<col style="width:' + _sw[4] + 'px">'
        + '</colgroup>';
    html += '<tbody>';

    // 全部被过滤：显示占位提示，避免空表格视觉断裂
    if (visibleSteps.length === 0) {
        html += '<tr><td class="xse-td-empty" colspan="5">（当前子列筛选下，该单元格所有步骤均被隐藏）</td></tr>';
        html += '</tbody></table>';
        return html;
    }

    for (var s = 0; s < visibleSteps.length; s++) {
        var step = visibleSteps[s];
        var _origIdx = step.origIdx;
        html += '<tr>';
        // 序号（不可编辑）：小圆点风格，与列头序号位置一致
        html += '<td class="xse-td-id"><span class="xse-idx-dot">' + escapeHtml(step.id || '-') + '</span></td>';
        // 步骤描述（可编辑）：data-xse-step 使用原始索引，保证编辑映射到源文本正确位置
        html += '<td class="xse-td-desc" contenteditable="true" data-xse-step="' + _origIdx + '" data-xse-section="desc">' + escapeHtml(step.desc || '') + '</td>';
        // 预期结果（可编辑）
        // 交互优化（方案 A + 分组标题优化）：
        //   1) 全空 → 仅显示一行"+ 添加分组"按钮组（UI/接口/数据），占 1 行而非原来的 6 行
        //   2) 半填 → 只渲染有内容的分组（chip + 内容行），未填分组以合并的"+ 分组名"按钮补齐
        //   3) 全填 → 保持三个 chip + 内容行原有布局
        // 数据层无破坏：_handleSubTableCellEdit 依据 DOM 中存在的 .xse-group + .xse-sub 识别分组，
        // 未渲染的分组会自然回写为空数组（并被清理为 delete step.xxx_expected），符合"未填"语义。
        html += '<td class="xse-td-expected" contenteditable="true" data-xse-step="' + _origIdx + '" data-xse-section="expected">';
        // 解析 step.expected 到三个具名分组
        var _groupMap = { 'ui': null, 'api': null, 'data': null };
        var _titleMap = { 'ui': '【UI检查】', 'api': '【接口调用】', 'data': '【数据检查】' };
        var _kindByTitle = function (t) {
            if (t === '【接口调用】') return 'api';
            if (t === '【数据检查】') return 'data';
            if (t === '【UI检查】') return 'ui';
            return null;
        };
        var _curKind = null;
        var _looseLines = [];
        for (var _ei = 0; _ei < step.expected.length; _ei++) {
            var _el = step.expected[_ei];
            var _k = null;
            if (/^【(UI检查|接口调用|数据检查)】$/.test(_el)) {
                _k = _kindByTitle(_el);
            }
            if (_k) {
                _curKind = _k;
                if (!_groupMap[_curKind]) _groupMap[_curKind] = [];
            } else if (_curKind) {
                _groupMap[_curKind].push(_el);
            } else {
                _looseLines.push(_el);
            }
        }
        // 兜底：无任何分组标题但有内容行 → 归入 ui
        if (_looseLines.length > 0 && !_groupMap.ui) _groupMap.ui = _looseLines;
        else if (_looseLines.length > 0) _groupMap.ui = _looseLines.concat(_groupMap.ui);

        var _order = ['ui', 'api', 'data'];
        var _filledKinds = [];
        var _missingKinds = [];
        for (var _oi = 0; _oi < _order.length; _oi++) {
            var _kk = _order[_oi];
            if (_groupMap[_kk] !== null && _groupMap[_kk] !== undefined) _filledKinds.push(_kk);
            else _missingKinds.push(_kk);
        }
        // 渲染已填分组（chip + 内容行）
        for (var _fi = 0; _fi < _filledKinds.length; _fi++) {
            var _fk = _filledKinds[_fi];
            var _flines = _groupMap[_fk] || [];
            html += '<div class="xse-group">';
            html += '<div class="xse-sub" contenteditable="false" data-kind="' + _fk + '">' + escapeHtml(_titleMap[_fk]) + '</div>';
            if (_flines.length > 0) {
                for (var _li = 0; _li < _flines.length; _li++) {
                    html += '<div class="xse-line">' + escapeHtml(_flines[_li]) + '</div>';
                }
            } else {
                // 用户主动添加了分组但内容为空：仍保留一条可编辑行
                html += '<div class="xse-line"></div>';
            }
            html += '</div>';
        }
        // 渲染未填分组：合并到一行"+ 分组名"按钮
        if (_missingKinds.length > 0) {
            html += '<div class="xse-add-group-row" contenteditable="false">';
            for (var _mi = 0; _mi < _missingKinds.length; _mi++) {
                var _mk = _missingKinds[_mi];
                html += '<button type="button" class="xse-btn-add-group" contenteditable="false"'
                    + ' data-xse-add-group-step="' + _origIdx + '"'
                    + ' data-xse-add-group-kind="' + _mk + '"'
                    + ' data-kind="' + _mk + '"'
                    + ' title="添加' + escapeHtml(_titleMap[_mk]) + '">+ ' + escapeHtml(_titleMap[_mk].replace(/[【】]/g, '')) + '</button>';
            }
            html += '</div>';
        }
        html += '</td>';
        // 数据（可编辑）
        html += '<td class="xse-td-data" contenteditable="true" data-xse-step="' + _origIdx + '" data-xse-section="data">';
        if (step.data.length) {
            for (var di = 0; di < step.data.length; di++) {
                html += '<div class="xse-line">' + escapeHtml(step.data[di]) + '</div>';
            }
        } else {
            html += '<div class="xse-line"></div>';
        }
        html += '</td>';
        // 操作（复制 / 向下插入 / 删除步骤）
        html += '<td class="xse-td-op">';
        html += '<div class="xse-row-actions">';
        html += '<button class="xse-btn-copy" data-xse-copy="' + _origIdx + '" contenteditable="false" title="复制">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>';
        html += '<button class="xse-btn-add" data-xse-add="' + _origIdx + '" contenteditable="false" title="向下插入">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></button>';
        html += '<button class="xse-btn-del" data-xse-del="' + _origIdx + '" contenteditable="false" title="删除">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>';
        html += '</div>';
        html += '</td>';
        html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
}

// 全量渲染（小表格）：把所有 view 行一次写入 tbody
function _renderAllBody() {
    var tbody = document.getElementById('xsTbody');
    if (!tbody) return;
    var headers = (S.data && S.data.headers) || [];
    var tsIdColIdx = headers.indexOf('testcase_id');
    var view = S._viewRows || [];
    var parts = new Array(view.length);
    for (var i = 0; i < view.length; i++) parts[i] = _buildRowHtml(view[i], tsIdColIdx);
    tbody.innerHTML = parts.join('') + _buildGhostRowsHtml(headers);
}

// 根据当前 DOM 中第一个未自定义高度的行测量真实默认行高，动态校正 XS_ROW_EST_HEIGHT。
// 避免主题/字体/padding 变化后还用硬编码 36 导致虚拟滚动高度累积偏差。
function _measureEstRowH() {
    try {
        var rows = document.querySelectorAll('tbody tr[data-row]');
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (r.classList.contains('xs-tr-resized')) continue;
            if (r.style && r.style.height) continue;
            var h = r.offsetHeight || 0;
            if (h > 0) { XS_ROW_EST_HEIGHT = h; return h; }
        }
    } catch (_e) { /* ignore */ }
    return XS_ROW_EST_HEIGHT;
}

// 计算每个 view 行的累积偏移表 _rowOffsets[i] = 第 i 行的 top 像素
// 长度 = view.length + 1，最后一项即总高度。
function _computeRowOffsets() {
    // 每次重算偏移前顺手校正一下估算高，只有负担一次 querySelector。
    _measureEstRowH();
    var view = S._viewRows || [];
    var offs = new Array(view.length + 1);
    var acc = 0;
    for (var i = 0; i < view.length; i++) {
        offs[i] = acc;
        var ri = view[i];
        var rh = S.rowHeights[ri];
        acc += (rh && rh > 0) ? rh : XS_ROW_EST_HEIGHT;
    }
    offs[view.length] = acc;
    S._rowOffsets = offs;
}

// 二分查找：scrollTop 处于哪个 view 行内
function _findRowIdxByOffset(top) {
    var offs = S._rowOffsets || [0];
    var lo = 0, hi = offs.length - 2;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (offs[mid] <= top && top < offs[mid + 1]) return mid;
        if (offs[mid] > top) hi = mid - 1; else lo = mid + 1;
    }
    return Math.max(0, Math.min(offs.length - 2, lo));
}

// 根据当前 scrollTop / 容器高度 / buffer 计算需渲染的 view 行区间 [from, to)
function _calcVisibleRange() {
    var c = document.getElementById('tableContainer');
    var view = S._viewRows || [];
    if (!c || view.length === 0) return [0, 0];
    var top = c.scrollTop;
    var bottom = top + c.clientHeight;
    var first = _findRowIdxByOffset(top);
    // 找 last：从 first 起累加直到超出 bottom
    var last = first;
    var offs = S._rowOffsets;
    while (last < view.length && offs[last] < bottom) last++;
    var from = Math.max(0, first - XS_VIRTUAL_BUFFER);
    var to = Math.min(view.length, last + XS_VIRTUAL_BUFFER);
    return [from, to];
}

// 虚拟渲染：tbody 内为 [topSpacer, ...真实 trs..., bottomSpacer]
function _renderVirtualBody() {
    var tbody = document.getElementById('xsTbody');
    if (!tbody) { dbg('❌ _renderVirtualBody: xsTbody not found'); return; }
    var view = S._viewRows || [];
    var offs = S._rowOffsets || [0];
    var headers = (S.data && S.data.headers) || [];
    var totalCols = 1 + headers.length; // 复选框列 + 数据列
    if (view.length === 0) {
        tbody.innerHTML = '';
        S._vRange = [0, 0];
        return;
    }
    var range = _calcVisibleRange();
    var from = range[0], to = range[1];
    // 命中相同区间则跳过（滚动微动不重渲）
    if (S._vRange && S._vRange[0] === from && S._vRange[1] === to) return;
    S._vRange = [from, to];

    var topH = offs[from] || 0;
    var bottomH = (offs[view.length] || 0) - (offs[to] || 0);
    var tsIdColIdx = headers.indexOf('testcase_id');
    var parts = [];
    // 顶部 spacer（用一行 td colspan 撑高）
    parts.push('<tr class="xs-vspacer" aria-hidden="true" style="height:' + topH + 'px"><td colspan="' + totalCols + '" style="padding:0;border:0"></td></tr>');
    for (var i = from; i < to; i++) parts.push(_buildRowHtml(view[i], tsIdColIdx));
    parts.push('<tr class="xs-vspacer" aria-hidden="true" style="height:' + bottomH + 'px"><td colspan="' + totalCols + '" style="padding:0;border:0"></td></tr>');
    tbody.innerHTML = parts.join('') + _buildGhostRowsHtml(headers);
    // 重渲后恢复查找高亮（仅对当前可见行有效）
    if (S._findKw) paintFindHighlight();
    if (typeof updateColSelClasses === 'function') updateColSelClasses();
    if (typeof updateCellSelClasses === 'function') updateCellSelClasses();
}

// 绑定容器 scroll → 节流（rAF）→ 虚拟重渲
// 注：滚动位置持久化由 01-core.js 的 bindContainerScroll() 单独绑定，避免重复注册。
function _bindVirtualScroll() {
    var c = document.getElementById('tableContainer');
    if (!c || c._xsVScrollBound) return;
    c._xsVScrollBound = true;
    c.addEventListener('scroll', function () {
        if (!S._virtualOn) return;
        if (S._vScrollRaf) return;
        S._vScrollRaf = requestAnimationFrame(function () {
            S._vScrollRaf = 0;
            _renderVirtualBody();
        });
    }, { passive: true });

    // 兜底：webview 失焦或鼠标离开整个视口时，主动清理可能残留的拖动 handler
    // 防止 mouseup 在 VSCode 主进程被吞导致的「僵尸 onMove」长时间存活
    if (!window._xsCellDragGuardBound) {
        window._xsCellDragGuardBound = true;
        var cleanup = function (reason) {
            if (S._cellDragOnMove || S._cellDragOnUp) {
                if (typeof dbg === 'function') dbg('🧹 cleanup cell-drag handler by ' + reason);
                if (S._cellDragOnMove) document.removeEventListener('mousemove', S._cellDragOnMove, true);
                if (S._cellDragOnUp) document.removeEventListener('mouseup', S._cellDragOnUp, true);
                S._cellDragOnMove = null;
                S._cellDragOnUp = null;
                S._cellDragging = false;
            }
        };
        window.addEventListener('blur', function () { cleanup('window-blur'); });
        document.addEventListener('mouseleave', function () { cleanup('document-mouseleave'); });
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) cleanup('visibility-hidden');
        });
    }
}

// 给定 view 内行索引（不是原始 ri），让它进入视口（用于 focusActiveMatch 等场景）
function ensureRowVisibleByViewIdx(viewIdx) {
    var c = document.getElementById('tableContainer');
    if (!c || !S._virtualOn) return;
    var offs = S._rowOffsets || [0];
    if (viewIdx < 0 || viewIdx >= offs.length - 1) return;
    var top = offs[viewIdx];
    var rowH = offs[viewIdx + 1] - top;
    if (top < c.scrollTop) {
        c.scrollTop = Math.max(0, top - 20);
    } else if (top + rowH > c.scrollTop + c.clientHeight) {
        c.scrollTop = top + rowH - c.clientHeight + 20;
    }
    _renderVirtualBody();
}

// 给定原始行号 ri，先定位到 viewRows 索引再调用上面的滚动
function ensureRowVisible(ri) {
    var view = S._viewRows || [];
    var idx = view.indexOf(ri);
    if (idx < 0) return;
    ensureRowVisibleByViewIdx(idx);
}

// ==================== 单元格原地 patch ====================
// 仅刷新某个 (r,c) 对应的 <td>，避免 renderTable 全表重绘。
// 用于单格写操作：pasteCell / clearCell / replaceCurrent / 编辑提交 等场景。
function patchCell(ri, ci) {
    if (typeof ri !== 'number' || typeof ci !== 'number' || ri < 0 || ci < 0) return;
    var td = document.querySelector('td.xs-editable[data-row="' + ri + '"][data-col="' + ci + '"]');
    if (!td) return; // 行可能因筛选未渲染
    var headers = (S.data && S.data.headers) || [];
    var row = (S.data && S.data.rows && S.data.rows[ri]) || [];
    var v = row[ci];
    // 与 _buildRowHtml 同源：单元格 HTML / 类名 / tooltip 均由 _buildCellInner 统一产出。
    var _ci = _buildCellInner(ri, ci, v);
    var inner = _ci.inner;
    var isDetail = _ci.isDetail;
    var isArrCol = _ci.isArrCol;
    var rawText = _ci.rawText;
    // 保留拖动行高对应的 --xs-clamp 变量（行高已持久化时不能丢失多行省略号配置）
    // 例外：若该行已被标记为"完全展开"，跳过 --xs-clamp，避免反推行数偏少导致截断。
    var rh2 = S.rowHeights[ri];
    var clampVar2 = '';
    var isFullyExpanded2 = !!(S._rowExpanded && S._rowExpanded.has(ri));
    var _clampLines2 = _computeClampLines(rh2, isFullyExpanded2);
    if (_clampLines2) {
        clampVar2 = ' style="--xs-clamp:' + _clampLines2 + ';"';
    }
    // 内容中的换行符 \n 由 CSS white-space 控制（nowrap 单行 / pre-wrap 多行），
    // 无需任何额外内联样式兜底。
    td.innerHTML = '<div class="xs-cell-wrap"' + clampVar2 + '>' + inner + '</div>';
    // class 同步：懒补修改时间戳，用于下面的失败-修改时间竞争
    var _mKey2 = ri + ',' + ci;
    var _hasMod2 = S.mods.has(_mKey2);
    if (_hasMod2 && S._modsTime && S._modsTime[_mKey2] == null) {
        S._modsTime[_mKey2] = Date.now();
    }
    var _modTime2 = _hasMod2 ? ((S._modsTime && S._modsTime[_mKey2]) || 0) : 0;
    if (_hasMod2) td.classList.add('modified'); else td.classList.remove('modified');
    if (isDetail) td.classList.add('xs-detail-cell'); else td.classList.remove('xs-detail-cell');
    if (isArrCol) td.classList.add('xs-arr-cell'); else td.classList.remove('xs-arr-cell');
    var frozen = (String(headers[ci]) === 'testcase_id');
    if (frozen) td.classList.add('xs-td-frozen'); else td.classList.remove('xs-td-frozen');
    // 按时间顺序选择高亮：最新操作的类型优先显示（与 _buildRowHtml 一致）
    var _bestTime = 0;
    var _bestClass = '';
    var _bestMkInfo = null;

    // 1) 推送变更高亮（行级橙 + 单元格级黄）：作为一组同时间戳的整体参与竞争
    //    同一次推送内，单元格级（黄）优先于行级（橙）
    var _pushUpdCls = '';
    if (S._highlightedCells) {
        if (S._highlightedCells.cells && S._highlightedCells.cells.has(ri + ':' + ci)) {
            _pushUpdCls = 'xs-td-push-updated';
        } else if (S._highlightedCells.rowSet && S._highlightedCells.rowSet.has(ri)
            && (S._highlightedCells.colIdx === -1 || S._highlightedCells.colIdx === ci)) {
            _pushUpdCls = 'xs-td-push-updated-row';
        }
    }
    if (_pushUpdCls) {
        var _t1 = S._highlightedTime || 0;
        // 修改时间胜出：跳过 pushUpdCls，保留 modified 独立生效
        if (_modTime2 > _t1) {
            _pushUpdCls = '';
        } else if (_t1 >= _bestTime) {
            _bestTime = _t1; _bestClass = _pushUpdCls; _bestMkInfo = null;
        }
    }
    // 2) 新增行高亮
    if (S._addedRowSet && S._addedRowSet.has(ri)) {
        var _t3 = S._addedRowTime || 0;
        if (_t3 >= _bestTime) {
            _bestTime = _t3;
            _bestClass = 'xs-td-push-added';
            _bestMkInfo = null;
            // 新增行胜出时与 _buildRowHtml 对齐：清除 modified 类（避免绿底上叠加黄底）
            td.classList.remove('modified');
        }
    }
    // 3) 用户手动标记高亮
    var _mkInfo = (typeof isUserMarked === 'function') ? isUserMarked(ri, ci) : null;
    if (_mkInfo) {
        var _t4 = _mkInfo.timestamp || 0;
        if (_t4 >= _bestTime) { _bestTime = _t4; _bestClass = 'xs-td-user-marked'; _bestMkInfo = _mkInfo; }
    }
    // 5) 推送失败高亮（行级失败时间）：作为另一候选项参与时间竞争
    var _rowFailTime = 0;
    if (S._pushFailedTsIds && S._pushFailedTsIds.size > 0) {
        var _tsIdColIdx2 = (S.data && S.data.headers) ? S.data.headers.indexOf('testcase_id') : -1;
        if (_tsIdColIdx2 >= 0) {
            var _tid = (S.data.rows[ri] || [])[_tsIdColIdx2];
            if (_tid !== undefined && _tid !== null && _tid !== '' && S._pushFailedTsIds.has(String(_tid))) {
                if (S._pushFailedTime) {
                    var _ftv = S._pushFailedTime.get(String(_tid));
                    if (typeof _ftv === 'number') _rowFailTime = _ftv;
                }
                // 兜底：与 _buildRowHtml 对齐，命中失败集合但缺失时间时给非 0 值
                if (_rowFailTime === 0) _rowFailTime = 1;
            }
        }
    }
    var _failOverridden = false;
    if (_rowFailTime > 0) {
        if (_rowFailTime >= _bestTime) {
            // 失败胜出临界：但若本 cell 的 mod 时间更晚（失败后又改了），则保留 modified 叠加
            if (_modTime2 > _rowFailTime) {
                _failOverridden = true;      // 保留 modified 类，让 CSS 应用叠加色
            } else {
                _bestTime = _rowFailTime;
                _bestClass = 'xs-td-push-failed';
                _bestMkInfo = null;
                td.classList.remove('modified');  // 失败完全胜出时清 modified
            }
        } else {
            _failOverridden = true;
        }
    }

    // 清除所有高亮 class
    td.classList.remove('xs-td-push-updated', 'xs-td-push-updated-row', 'xs-td-push-added', 'xs-td-user-marked', 'xs-td-push-failed', 'xs-td-overrides-fail');
    if (_bestClass) td.classList.add(_bestClass);
    if (_failOverridden) td.classList.add('xs-td-overrides-fail');
    // 应用标记颜色（仅当标记是最新操作时）
    if (_bestMkInfo) {
        if (_bestMkInfo.bgColor) td.style.setProperty('background', _bestMkInfo.bgColor, 'important');
        else td.style.setProperty('background', '', 'important');
        if (_bestMkInfo.fontColor) td.style.setProperty('color', _bestMkInfo.fontColor, 'important');
        else td.style.setProperty('color', '', 'important');
    } else {
        td.style.setProperty('background', '', 'important');
        td.style.setProperty('color', '', 'important');
    }
    // tooltip 同步：与 _buildRowHtml 一致，字面 "\n" 转换为真实换行符，
    // 使原生 tooltip 中的换行呈现与单元格展开后一致。
    if (rawText) td.setAttribute('title', rawText.replace(/\\n/g, '\n')); else td.removeAttribute('title');
    // 注：detail-link click 已在 #tableContainer 上委托，无需在此重新绑定
}
