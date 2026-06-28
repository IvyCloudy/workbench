/* =============================================================================
 * 03e-mark.js  —— 用户标记（高亮）+ 颜色选择器
 * -----------------------------------------------------------------------------
 * 由原 03a-cell-edit.js 拆分而来：
 *   1. 标记/取消标记：collectMarkRects / countMarkedInRects /
 *                     markSelected / unmarkSelected / applyMarkWithColors
 *   2. 颜色选择器：showMarkColorPicker / hideMarkColorPicker /
 *                   _onDocClickHidePicker
 *
 * 标记数据存储于 S.userMarks，并通过 saveHighlight 消息持久化到扩展端 UI 状态文件。
 * ========================================================================== */

// ==================== 用户标记 / 取消标记 ====================

// 收集当前选区对应的 MarkRect 列表
// 关键：在搜索 / 列筛选 / 仅看失败 等过滤模式下，必须把矩形按"实际可见行"
// 拆分逐行下发，避免把被隐藏的行号一起标记上（取消筛选后会暴露成连续行标记）。
function collectMarkRects() {
    var rects = [];
    // 优先行选（整行标记，c1=-1）。S.sel 已由 02c 保证只含可见行，无需再过滤。
    if (S.sel && S.sel.size > 0) {
        S.sel.forEach(function (r) {
            rects.push({ r1: r, c1: -1, r2: r, c2: -1 });
        });
    } else if (typeof getCellSelRect === 'function') {
        // 单元格矩形选区：用 getSelRectRows() 拿到"过滤后可见的行号列表"，
        // 再按行号逐条下发，确保被隐藏的行号不会被标记。
        var rc = getCellSelRect();
        if (rc) {
            var visibleRows = (typeof getSelRectRows === 'function')
                ? getSelRectRows()
                : null;
            if (!visibleRows || visibleRows.length === 0) {
                // 兜底：getSelRectRows 不可用或没有可见行 → 退化为原矩形（极端兼容）
                rects.push({ r1: rc.r1, c1: rc.c1, r2: rc.r2, c2: rc.c2 });
            } else {
                visibleRows.forEach(function (r) {
                    rects.push({ r1: r, c1: rc.c1, r2: r, c2: rc.c2 });
                });
            }
        } else if (S._ctxRow >= 0 && S._ctxCol >= 0) {
            // 右键点单个单元格
            rects.push({ r1: S._ctxRow, c1: S._ctxCol, r2: S._ctxRow, c2: S._ctxCol });
        }
    } else if (S._ctxRow >= 0 && S._ctxCol >= 0) {
        rects.push({ r1: S._ctxRow, c1: S._ctxCol, r2: S._ctxRow, c2: S._ctxCol });
    }
    return rects;
}

// 统计当前选区内已被标记的单元格数量（通过 isUserMarked 逐格查询）
function countMarkedInRects(rects) {
    if (typeof isUserMarked !== 'function') return 0;
    var count = 0;
    rects.forEach(function (rc) {
        var c1 = rc.c1 === -1 ? 0 : rc.c1;
        var c2 = rc.c1 === -1 ? (S.data.headers ? S.data.headers.length - 1 : 0) : rc.c2;
        for (var r = rc.r1; r <= rc.r2; r++) {
            for (var c = c1; c <= c2; c++) {
                if (isUserMarked(r, c)) count++;
            }
        }
    });
    return count;
}

// 标记选中区域（弹出颜色选择器）
var _markPendingRects = null;
function markSelected() {
    var rects = collectMarkRects();
    if (rects.length === 0) return;
    _markPendingRects = rects;
    showMarkColorPicker();
}

// 取消标记选中区域（cell-by-cell 减法，支持选区与已存储矩形不完全重合的场景）
function unmarkSelected() {
    var rects = collectMarkRects();
    if (rects.length === 0) return;
    if (!S.vscode) return;

    var headersLen = (S.data.headers && S.data.headers.length) || 0;
    var existing = (S._userMarks && S._userMarks.rects) || [];

    if (existing.length === 0) {
        showToast('当前无标记', 'info');
        return;
    }

    // 展开选区矩形为 cell key 集合
    var selSet = {};
    rects.forEach(function (rc) {
        var c1 = rc.c1 === -1 ? 0 : rc.c1;
        var c2 = rc.c1 === -1 ? headersLen - 1 : rc.c2;
        for (var r = rc.r1; r <= rc.r2; r++) {
            for (var c = c1; c <= c2 && c < headersLen; c++) {
                selSet[r + ':' + c] = true;
            }
        }
    });

    // 逐个已存储矩形：保留未落在选区内的单元格
    var newRects = [];
    var removedCount = 0;
    existing.forEach(function (er) {
        var bg = er.bgColor || null;
        var fg = er.fontColor || null;
        var erC1 = er.c1 === -1 ? 0 : er.c1;
        var erC2 = er.c1 === -1 ? headersLen - 1 : er.c2;

        // 收集不被选区覆盖的单元格
        var cells = [];
        for (var r = er.r1; r <= er.r2; r++) {
            for (var c = erC1; c <= erC2 && c < headersLen; c++) {
                if (selSet[r + ':' + c]) {
                    removedCount++;
                } else {
                    cells.push([r, c]);
                }
            }
        }

        // 按行聚合成"水平连续段"矩形
        cells.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        for (var i = 0; i < cells.length;) {
            var r0 = cells[i][0], c0 = cells[i][1];
            var cEnd = c0;
            var j = i + 1;
            while (j < cells.length && cells[j][0] === r0 && cells[j][1] === cEnd + 1) {
                cEnd = cells[j][1];
                j++;
            }
            newRects.push({ r1: r0, c1: c0, r2: r0, c2: cEnd, bgColor: bg, fontColor: fg, timestamp: er.timestamp });
            i = j;
        }
    });

    if (removedCount === 0) {
        showToast('选区内无标记', 'info');
        return;
    }

    // 取消标记动作纳入 undo 栈：必须在改动发生前压入当前快照（含旧的 _userMarks.rects）
    if (typeof pushHistory === 'function') pushHistory();

    // 更新本地状态 + 重绘
    S._userMarks.rects = newRects;
    S._userMarks.cellMap = null;
    S._userMarks.rowMap = null;
    S._userMarks.rowSet = null;
    S._userMarks.cellTime = null;
    S._userMarks.rowTime = null;

    // 将完整结果发回扩展端持久化
    S.vscode.postMessage({ type: 'setMarkRects', rects: newRects });
    showToast('已取消标记 ' + removedCount + ' 个单元格', 'success');
    renderTable();
}

// 应用标记（带颜色）
function applyMarkWithColors(bgColor, fontColor) {
    if (!_markPendingRects || _markPendingRects.length === 0) return;
    if (!S.vscode) return;
    // 标记动作纳入 undo 栈：必须在改动发生前压入当前快照（含旧的 _userMarks.rects）
    if (typeof pushHistory === 'function') pushHistory();
    S.vscode.postMessage({ type: 'mark', rects: _markPendingRects, bgColor: bgColor, fontColor: fontColor });
    _markPendingRects = null;
    showToast('已标记', 'success');
}

// ==================== 颜色选择器 ====================
var _markPaletteBgColors = [
    ['#ffffff','#e3f2fd','#fff3e0','#e8f5e9','#fce4ec','#f3e5f5','#e0f7fa','#fffde7','#efebe9','#eceff1'],
    ['#bbdefb','#ffe0b2','#c8e6c9','#f8bbd0','#e1bee7','#80deea','#fff9c4','#d7ccc8','#cfd8dc','#b0bec5'],
    ['#90caf9','#ffcc80','#a5d6a7','#f48fb1','#ce93d8','#4dd0e1','#fff176','#bcaaa4','#90a4ae','#78909c'],
    ['#64b5f6','#ffb74d','#81c784','#f06292','#ba68c8','#00bcd4','#ffee58','#a1887f','#78909c','#546e7a'],
    ['#42a5f5','#ffa726','#66bb6a','#ec407a','#ab47bc','#00acc1','#fdd835','#8d6e63','#607d8b','#455a64'],
    ['#ffcdd2','#f44336','#e91e63','#9c27b0','#673ab7','#3f51b5','#2196f3','#00bcd4','#4caf50','#ff9800']
];

var _markPaletteFontColors = [
    ['#000000','#d32f2f','#c62828','#6a1b9a','#283593','#1565c0','#00695c','#2e7d32','#e65100','#4e342e'],
    ['#424242','#f44336','#e91e63','#9c27b0','#3f51b5','#2196f3','#0097a7','#4caf50','#ff9800','#795548'],
    ['#757575','#ffffff','#fff3e0','#e8f5e9','#e3f2fd','#f3e5f5','#fce4ec','#e0f2f1','#fffde7','#efebe9']
];

var _markCurBg = '#e3f2fd';
var _markCurFont = '';

function showMarkColorPicker() {
    hideMarkColorPicker();
    var panel = document.createElement('div');
    panel.id = 'markColorPicker';
    panel.className = 'xs-mark-picker';
    // 背景色区
    var bgHtml = '<div class="xs-mp-title">背景色</div><div class="xs-mp-row">';
    _markPaletteBgColors.forEach(function (row) {
        row.forEach(function (c) {
            var sel = (c === _markCurBg ? ' xs-mp-sel' : '');
            bgHtml += '<span class="xs-mp-swatch' + sel + '" style="background:' + c + '" data-bg="' + c + '" title="' + c + '"></span>';
        });
        bgHtml += '</div><div class="xs-mp-row">';
    });
    bgHtml += '</div>';
    // 分隔
    bgHtml += '<div class="xs-div"></div>';
    // 字体色区
    var fgHtml = '<div class="xs-mp-title">字体色</div><div class="xs-mp-row">';
    _markPaletteFontColors.forEach(function (row) {
        row.forEach(function (c) {
            var sel = (c === _markCurFont ? ' xs-mp-sel' : '');
            var borderCol = (c === '#ffffff' ? 'border:1px solid #ccc;' : '');
            fgHtml += '<span class="xs-mp-swatch' + sel + '" style="background:' + c + ';' + borderCol + '" data-fg="' + c + '" title="' + c + '"></span>';
        });
        fgHtml += '</div><div class="xs-mp-row">';
    });
    fgHtml += '</div>';
    // 预览 & 操作按钮
    var previewHtml = '<div class="xs-mp-footer"><span class="xs-mp-preview" id="mpPreview" style="background:' + (_markCurBg || '#fff') + ';color:' + (_markCurFont || '#000') + '">Aa</span>';
    previewHtml += '<button id="mpApply" class="xs-mp-btn">标记</button>';
    previewHtml += '<button id="mpCancel" class="xs-mp-btn xs-mp-btn-cancel">取消</button></div>';
    panel.innerHTML = bgHtml + fgHtml + previewHtml;
    document.body.appendChild(panel);
    // 居中定位
    var w = panel.offsetWidth, h = panel.offsetHeight;
    panel.style.left = Math.max(8, (window.innerWidth - w) / 2) + 'px';
    panel.style.top = Math.max(48, (window.innerHeight - h) / 2) + 'px';
    // 事件绑定
    panel.addEventListener('click', function (e) {
        var t = e.target;
        if (t.classList.contains('xs-mp-swatch')) {
            var bg = t.getAttribute('data-bg');
            var fg = t.getAttribute('data-fg');
            if (bg !== null) _markCurBg = (_markCurBg === bg ? '' : bg);
            if (fg !== null) _markCurFont = (_markCurFont === fg ? '' : fg);
            // 更新所有 swatch 选中态
            panel.querySelectorAll('.xs-mp-swatch[data-bg]').forEach(function (s) {
                s.classList.toggle('xs-mp-sel', s.getAttribute('data-bg') === _markCurBg);
            });
            panel.querySelectorAll('.xs-mp-swatch[data-fg]').forEach(function (s) {
                s.classList.toggle('xs-mp-sel', s.getAttribute('data-fg') === _markCurFont);
            });
            var pv = document.getElementById('mpPreview');
            if (pv) { pv.style.background = (_markCurBg || '#fff'); pv.style.color = (_markCurFont || '#000'); }
        }
        if (t.id === 'mpApply') {
            hideMarkColorPicker();
            applyMarkWithColors(_markCurBg || null, _markCurFont || null);
        }
        if (t.id === 'mpCancel') { hideMarkColorPicker(); _markPendingRects = null; }
    });
    // 点击外部关闭
    setTimeout(function () {
        document.addEventListener('click', _onDocClickHidePicker);
    }, 10);
}

function hideMarkColorPicker() {
    var panel = document.getElementById('markColorPicker');
    if (panel) panel.remove();
    document.removeEventListener('click', _onDocClickHidePicker);
}

function _onDocClickHidePicker(e) {
    var panel = document.getElementById('markColorPicker');
    if (panel && !panel.contains(e.target)) { hideMarkColorPicker(); _markPendingRects = null; }
}
