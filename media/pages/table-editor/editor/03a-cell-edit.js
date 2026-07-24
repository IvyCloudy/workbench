/* =============================================================================
 * 03a-cell-edit.js  —— 单元格编辑（双击进入编辑 / 提交修改 / 批量写入）
 * -----------------------------------------------------------------------------
 * 由原 03a-cell-edit.js（1667 行）拆分而来，仅保留单元格编辑主流程：
 *   selectCell / onCellDblClick / _calcTextLines / _countWrapLines / startEdit
 *
 * 配套拆分文件（按 BaseEditorProvider editorScriptFiles 顺序加载）：
 *   - 03c-context-menu.js  右键菜单（showContextMenu / hideContextMenu）
 *   - 03d-row-col-ops.js   行/列数据操作（增删/复制粘贴/清空/推送）
 *   - 03e-mark.js          用户标记 + 颜色选择器
 *
 * 跨文件依赖通过全局作用域共享（如 isFrozenCol、updateColSelClasses 来自 03b）。
 * 所有写操作前都会调用 pushHistory() 以支持撤销，结束时 saveFile() + renderTable()。
 * ========================================================================== */

// ==================== 单元格编辑 ====================
function selectCell(e) {
    var td = e.currentTarget;
    document.querySelectorAll('.xs-editable.active').forEach(function (n) { n.classList.remove('active'); });
    td.classList.add('active');
    S.cell = { r: parseInt(td.getAttribute('data-row'), 10), c: parseInt(td.getAttribute('data-col'), 10) };
}

function onCellDblClick(e) {
    var td = e.currentTarget;
    var ri = parseInt(td.getAttribute('data-row'), 10);
    var ci = parseInt(td.getAttribute('data-col'), 10);
    // 样例数据行冻结：整行只读，禁止双击进入任何编辑（含明细弹窗 / 数组编辑器）
    if (isFrozenRow(ri)) {
        e.preventDefault();
        showToast('样例数据行已冻结，不可编辑（testcase_id 为占位值）', 'error');
        return;
    }
    // testcase_id 列冻结：不允许双击进入编辑
    if (isFrozenCol(ci)) {
        e.preventDefault();
        showToast('testcase_id 列为系统列，不允许编辑', 'error');
        return;
    }
    // 明细列：双击也打开弹窗，不进入编辑
    if (hasDetailRowsAtCol(ri, ci)) {
        e.preventDefault();
        e.stopPropagation();
        var headers = (S.data && S.data.headers) || [];
        var field = headers[ci] !== undefined ? headers[ci] : '';
        openDetailModal(ri, field);
        return;
    }
    // 标量数组列：双击 → 多项编辑弹窗，不走 textarea 原地编辑
    if (typeof isArrayCol === 'function' && isArrayCol(ci) && typeof openArrayCellEditor === 'function') {
        e.preventDefault();
        e.stopPropagation();
        openArrayCellEditor(ri, ci);
        return;
    }
    startEdit(e);
}

// 基于列宽 + Canvas 精确计算文本 wrapped 行数
function _calcTextLines(text, td, ci) {
    if (!text) return 1;
    // 按 \n 先拆成段落，每个段落再根据列宽算 wrap 行数
    var paragraphs = text.split('\n');
    // 取列宽：优先自定义列宽，否则用 td 实际宽度（减去 textarea 左右 padding 6*2）
    var colW = (S.colWidths && S.colWidths[ci] && S.colWidths[ci] > 0) ? (S.colWidths[ci] - 12) : (td ? td.offsetWidth - 12 : 200);
    if (colW < 40) colW = 40;
    // 获取字体信息
    var font = td ? getComputedStyle(td).font : '13px sans-serif';
    var totalLines = 0;
    // 用离屏 Canvas 测量文本宽度
    var ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = font;
    for (var p = 0; p < paragraphs.length; p++) {
        var para = paragraphs[p];
        totalLines += _countWrapLines(para, colW, ctx);
    }
    return Math.max(1, Math.min(totalLines, 25));
}

// 对单段文本按给定 pixel 宽度计算折行数
function _countWrapLines(text, maxWidth, ctx) {
    if (!text) return 1;
    if (!ctx) {
        // 无 Canvas 环境时降级：按 40 字符/行
        return Math.max(1, Math.ceil(text.length / 40));
    }
    var lines = 0;
    var start = 0;
    var len = text.length;
    while (start < len) {
        // 二分找当前行能容纳的最长字符数
        var lo = start + 1;
        var hi = len;
        var best = start;
        while (lo <= hi) {
            var mid = Math.floor((lo + hi) / 2);
            var w = ctx.measureText(text.substring(start, mid + 1)).width;
            if (w <= maxWidth) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        start = best + 1;
        lines++;
        // 安全上限
        if (lines > 500) break;
    }
    return Math.max(1, lines);
}

function startEdit(e) {
    if (S.editing) return;
    var td = e.currentTarget;
    var ri = parseInt(td.getAttribute('data-row'), 10);
    var ci = parseInt(td.getAttribute('data-col'), 10);
    // 样例数据行冻结：整行只读，禁止进入编辑
    if (isFrozenRow(ri)) {
        showToast('样例数据行已冻结，不可编辑（testcase_id 为占位值）', 'error');
        return;
    }
    // testcase_id 列冻结：不允许进入编辑
    if (isFrozenCol(ci)) {
        showToast('testcase_id 列为系统列，不允许编辑', 'error');
        return;
    }
    // 防御：行/列下标不合法时直接放弃编辑（如表格已被刷新/删除行列）
    if (isNaN(ri) || isNaN(ci) || !S.data || !Array.isArray(S.data.rows) || !S.data.rows[ri]) {
        return;
    }
    var oldVal = (S.data.rows[ri] && S.data.rows[ri][ci] !== undefined) ? S.data.rows[ri][ci] : '';
    // 用 textarea 取代 input，使行高被拖大时单元格内容也能换行编辑
    var input = document.createElement('textarea');
    input.className = 'xs-cell-input';
    // 文本中的字面量 \n 在 textarea 中转为实际换行，方便多行编辑
    var valStr = (oldVal == null ? '' : String(oldVal)).replace(/\\n/g, '\n');
    input.value = valStr;
    // 基于列宽精确计算所需行数（替代固定字符数估算）
    var lineCount = _calcTextLines(valStr, td, ci);
    // 行高被拖大或内容本身多行时，启用多行编辑模式（Enter 换行，Ctrl/Cmd+Enter 提交）
    var tr = td.parentElement;
    var multiline = !!(tr && tr.classList && tr.classList.contains('xs-tr-resized')) || lineCount > 1;
    // multiline 模式仅设标记和样式类，真正的高度计算放到 appendChild 之后做（依赖真实 line-height）
    var _isFloating = false; // 是否使用 body 浮窗模式（多行编辑专用，彻底脱离 td/tr CSS 干扰）
    if (multiline) {
        input.classList.add('xs-cell-input-multi');
        // ⚠ 历史踩坑：之前尝试用 absolute 定位 + 改 right/bottom=auto 仍被 CSS 多重规则限制
        // （.xs-td textarea.xs-cell-input{height:100%;...} + tr/td 的 overflow/clip 都可能裁切）。
        // 终极方案：**把 textarea 挂到 document.body 上用 fixed 定位**，彻底脱离表格 DOM/CSS 影响，
        // 关闭编辑时（commit）remove 即可，无副作用。
        _isFloating = true;
        var rect = td.getBoundingClientRect();
        // 列宽：优先自定义列宽，否则取 td 实际宽度
        var _w = (S.colWidths && S.colWidths[ci] && S.colWidths[ci] > 0) ? S.colWidths[ci] : rect.width;
        input.style.position = 'fixed';
        input.style.left = rect.left + 'px';
        input.style.top = rect.top + 'px';
        input.style.width = _w + 'px';
        input.style.zIndex = '9999';
        input.style.boxShadow = '0 2px 12px rgba(0,0,0,0.2)';
        input.style.background = 'var(--vscode-input-background, #fff)';
        input.style.color = 'var(--vscode-input-foreground, inherit)';
        input.style.border = '1px solid var(--vscode-focusBorder, #2188ff)';
        input.style.padding = '4px 6px';
        input.style.margin = '0';
        input.style.boxSizing = 'border-box';
        input.style.resize = 'vertical';
        input.style.overflow = 'hidden';
        input.style.lineHeight = '18px';
        input.style.fontFamily = getComputedStyle(td).fontFamily;
        input.style.fontSize = getComputedStyle(td).fontSize;
        input.style.whiteSpace = 'pre-wrap';
        input.style.wordBreak = 'break-word';
        input.style.display = 'block';
    }
    td.innerHTML = '';
    td.classList.add('xs-editing');
    if (_isFloating) {
        // 浮窗模式：textarea 挂到 body，td 内放一个占位（保持 editing 视觉状态）
        document.body.appendChild(input);
    } else {
        td.appendChild(input);
    }

    // ⚠ 必须在 appendChild 之后基于实测 line-height 计算确定高度
    if (multiline) {
        // 实测当前 textarea 的 line-height（fallback 18）
        var _lh = 18;
        try {
            var _cs = getComputedStyle(input);
            var _lhParsed = parseFloat(_cs.lineHeight);
            if (!isNaN(_lhParsed) && _lhParsed > 0) _lh = _lhParsed;
        } catch (_) { /* ignore */ }
        // padding(上下各 4) + border(上下各 1) ≈ 10px 缓冲
        var _fixedH = Math.ceil(lineCount * _lh) + 10;
        var _minH2 = Math.max(td.offsetHeight, _fixedH);
        input.style.height = _minH2 + 'px';
        // 用户继续输入时同步增长高度
        input.addEventListener('input', function () {
            input.style.height = 'auto';
            var h = Math.max(_minH2, input.scrollHeight);
            input.style.height = h + 'px';
        });
        // 浮窗模式：滚动表格/窗口时同步浮窗位置
        if (_isFloating) {
            var _scroller = td.closest('.xs-table-scroller') || td.closest('.xs-table-wrap') || window;
            var _syncPos = function () {
                try {
                    var r = td.getBoundingClientRect();
                    input.style.left = r.left + 'px';
                    input.style.top = r.top + 'px';
                } catch (_) {}
            };
            input._syncPos = _syncPos;
            input._scroller = _scroller;
            try { _scroller.addEventListener('scroll', _syncPos, true); } catch (_) {}
            try { window.addEventListener('resize', _syncPos); } catch (_) {}
        }
    }

    input.focus();
    // 进入编辑即全选（Excel 风格）+ 滚到顶部，避免 select() 把多行 textarea 滚到末尾导致只露最后几行
    try { input.setSelectionRange(0, input.value.length); } catch (_) { input.select(); }
    if (multiline) {
        input.scrollTop = 0;
        // 双保险：下一帧再纠正一次（应对某些主题下 focus 后浏览器二次滚动）
        requestAnimationFrame(function () { try { input.scrollTop = 0; } catch (_) {} });
    }
    S.editing = true;

    // 批量输入：进入编辑时若存在矩形选区且当前 active cell 处于选区内部，
    // 记下选区快照；commit 时若值有变化，把同一值写入整个选区（跳过冻结列）。
    var bulkRect = null;
    try {
        var _rcEdit = (typeof getCellSelRect === 'function') ? getCellSelRect() : null;
        if (_rcEdit && (_rcEdit.r1 !== _rcEdit.r2 || _rcEdit.c1 !== _rcEdit.c2)
            && ri >= _rcEdit.r1 && ri <= _rcEdit.r2 && ci >= _rcEdit.c1 && ci <= _rcEdit.c2) {
            bulkRect = _rcEdit;
        }
    } catch (_e) { }

    function commit(save) {
        if (!S.editing) return;
        S.editing = false;
        // 浮窗模式：先把挂在 body 上的 textarea 移除 + 解绑 scroll/resize 监听，避免泄漏
        if (_isFloating) {
            try {
                if (input._scroller && input._syncPos) {
                    input._scroller.removeEventListener('scroll', input._syncPos, true);
                }
            } catch (_) {}
            try { window.removeEventListener('resize', input._syncPos); } catch (_) {}
            try { if (input.parentNode) input.parentNode.removeChild(input); } catch (_) {}
        }
        // 二次防御：commit 时单元格可能因外部操作（删除行/列、重渲染）已失效
        var row = (S.data && Array.isArray(S.data.rows)) ? S.data.rows[ri] : undefined;
        if (!row || isNaN(ri) || isNaN(ci)) {
            return;
        }
        if (save) {
            // 保留真实换行符（不再转为字面量 \n），由后端 escapeCsvField 负责引号包裹
            var newVal = input.value;
            if (newVal !== oldVal) {
                pushHistory();
                if (bulkRect) {
                    // 批量写入选区所有单元格
                    // 过滤模式下（仅看失败/列筛选）只对可见行写入，避免把值刷到被隐藏的成功行
                    var rows = S.data.rows;
                    var bulkRows = (typeof getSelRectRows === 'function') ? getSelRectRows() : null;
                    if (!bulkRows || bulkRows.length === 0) {
                        bulkRows = [];
                        for (var _bri = bulkRect.r1; _bri <= bulkRect.r2; _bri++) bulkRows.push(_bri);
                    }
                    var changed = 0, skippedTsId = false;
                    for (var _bi = 0; _bi < bulkRows.length; _bi++) {
                        var rr = bulkRows[_bi];
                        var rowR = rows[rr]; if (!rowR) continue;
                        // 样例数据行冻结：批量填充跳过该行
                        if (isFrozenRow(rr)) continue;
                        for (var cc = bulkRect.c1; cc <= bulkRect.c2; cc++) {
                            if (isFrozenCol(cc)) { skippedTsId = true; continue; }
                            var isArrTarget = typeof isArrayCol === 'function' && isArrayCol(cc);
                            var nv;
                            if (isArrTarget) {
                                nv = (newVal === '') ? [] : newVal.split(/;\s*|\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
                            } else {
                                nv = newVal;
                            }
                            var ov = rowR[cc];
                            var oldStr = Array.isArray(ov) ? formatCellValue(ov) : (ov == null ? '' : String(ov));
                            var newStr = Array.isArray(nv) ? formatCellValue(nv) : String(nv);
                            if (oldStr !== newStr) {
                                rowR[cc] = nv;
                                S.mods.add(rr + ',' + cc);
                                changed++;
                            }
                        }
                    }
                    saveFile();
                    // 批量写入后整体重绘以保证所有单元格视图同步
                    td.classList.remove('xs-editing');
                    renderTable();
                    var msg = '已批量填充 ' + changed + ' 个单元格';
                    if (skippedTsId) msg += '（testcase_id 列已跳过）';
                    if (typeof showToast === 'function') showToast(msg, 'success');
                    return;
                }
                row[ci] = newVal;
                S.mods.add(ri + ',' + ci);
                saveFile();
            }
        }
        td.classList.remove('xs-editing');
        patchCell(ri, ci);
    }
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
            // Alt+Enter / Option+Enter：插入换行符（同 Excel 换行操作）
            if (ev.altKey) {
                ev.preventDefault();
                var start = input.selectionStart;
                var end = input.selectionEnd;
                input.value = input.value.slice(0, start) + '\n' + input.value.slice(end);
                input.selectionStart = input.selectionEnd = start + 1;
                return;
            }
            // 多行模式：Ctrl/Cmd+Enter 提交，Enter 换行（保持 textarea 默认行为）
            // 单行模式：Enter 提交（保持原有交互）
            if (multiline) {
                if (ev.ctrlKey || ev.metaKey) {
                    ev.preventDefault();
                    commit(true);
                }
                // 否则不拦截，允许换行
            } else {
                ev.preventDefault();
                commit(true);
            }
        } else if (ev.key === 'Escape') { commit(false); }
    });
}

