/* =============================================================================
 * 01-core.js  —— 核心运行时（必须最先加载）
 * -----------------------------------------------------------------------------
 * 本文件提供整个表格编辑器的「公共底座」，其它脚本都依赖这里定义的全局对象与函数：
 *   1. 运行时配置 __CFG（由 BaseEditorProvider 注入 dataType / msgType）
 *   2. 全局状态对象 S：数据、选区、编辑态、剪贴板、撤销栈、列宽行高、
 *      搜索/筛选关键字、列选择等所有跨模块共享的状态都挂在 S 上
 *   3. 日志工具 dbg（仅打印到 webview 控制台，不再 postMessage 转发）
 *   4. 撤销 / 重做：snapshot / restoreSnapshot / pushHistory / undo / redo
 *   5. 入口 init()：建立 vscode 通道、绑定工具栏与全局事件
 *   6. 扩展端消息分发（init 数据下发 / saved / pushDone / pushResult / pushError）
 *   7. 通用工具函数：escapeHtml / formatCellValue / genUuidV4 / showToast
 *
 * 注意：函数声明仅在所在 <script> 内部提升，跨文件不会提升；因此本文件必须最先加载。
 * ========================================================================== */

// 表格编辑器主逻辑
// 运行时配置由 BaseEditorProvider 注入（dataType / msgType）
var __CFG = (typeof window !== 'undefined' && window.__EDITOR_CONFIG__) || { dataType: '', msgType: '' };

// ==================== 日志 ====================
// 仅打到 webview 自身控制台（开发者工具中查看）；不再通过 postMessage 转发给扩展端，
// 避免日志在两侧双倍打印导致截断。
// 默认关闭：避免高频路径（mousemove/选区刷新/虚拟滚动）刷屏并影响性能。
// 调试时在控制台执行 `S._debug = true`（或在 URL 末尾加 `?xsdebug=1`）即可打开。
var __LOG_TAG = '[TC-WEBVIEW][' + (__CFG.dataType || '?') + '#' + Math.random().toString(36).slice(2, 6) + ']';
var __DBG_DEFAULT = false;
try {
    if (typeof window !== 'undefined') {
        if (window.__XS_DEBUG__ === true) __DBG_DEFAULT = true;
        if (window.location && /[?&]xsdebug=1\b/.test(window.location.search || '')) __DBG_DEFAULT = true;
    }
} catch (_) {}
function dbg() {
    // 注：S 在本文件后面才声明（var 提升，但赋值在后），首屏极早期可能 undefined；
    // 此处用全局默认值兜底。
    var on = (typeof S !== 'undefined' && S && typeof S._debug === 'boolean') ? S._debug : __DBG_DEFAULT;
    if (!on) return;
    var args = Array.prototype.slice.call(arguments);
    try {
        var d = new Date();
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        var ms = String(d.getMilliseconds()).padStart(3, '0');
        var ts = '[' + hh + ':' + mm + ':' + ss + '.' + ms + ']';
        console.log.apply(console, [ts + __LOG_TAG].concat(args));
    } catch (_) {}
}

var S = {
    dataType: __CFG.dataType,
    msgType: __CFG.msgType,
    data: { headers: [], rows: [] },
    sel: new Set(),         // 选中的行号集合
    cell: null,             // 当前激活单元格 {r, c}
    clip: null,             // 单元格剪贴板
    rowClip: null,          // 行剪贴板
    mods: new Set(),        // 修改过的单元格 key="r,c"
    colWidths: {},          // 列宽
    rowHeights: {},         // 行高（key=行索引，value=高度像素），仅在内存中保留
    vscode: null,
    editing: false,
    _ctxRow: -1,            // 右键当前行
    _ctxCol: -1,            // 右键当前列
    _docBound: false,
    // 明细弹窗状态
    _detailField: '',       // 当前打开明细的字段名
    _detailRowIdx: -1,      // 当前打开明细的主表行号
    _detailMods: new Set(), // 明细修改集合 key="di,ci"
    _detailEditing: false,
    _detailSel: new Set(),  // 明细选中的子行
    // 查找/替换
    _matches: [],           // [{r, c}]
    _matchIdx: -1,          // 当前命中的 match 索引
    _findKw: '',            // 当前关键字
    // 顶部搜索过滤
    _searchKw: '',          // 搜索关键字
    // 列筛选（Excel 风格）：key=列索引，value=Set<string>（保留显示的值集合；为空集表示全部隐藏）
    _colFilters: {},
    // 当前打开的筛选弹窗内部状态
    _filterUI: null,        // {col, kw, selected:Set<string>}
    // 撤销/重做
    _history: [],           // 过去的快照栈
    _future: [],            // 已撤销可重做的栈
    _HISTORY_LIMIT: 100,
    // 列选择（Excel 风格）
    colSel: new Set(),      // 选中的列索引集合
    _colSelAnchor: -1,      // shift 多选锚点列
    // 单元格矩形选区（Excel 风格）：{anchor:{r,c}, focus:{r,c}}；为 null 表示无矩形选区
    cellSel: null,
    _cellDragging: false,   // 是否处于鼠标拖选中
    // 行选锚点（Shift 区间扩展用）
    _rowSelAnchor: -1,
    // 虚拟滚动（仅当 view 行数 ≥ XS_VIRTUAL_THRESHOLD 时启用）
    _virtualOn: false,      // 当前是否启用虚拟滚动
    _viewRows: [],          // 当前可见的原始行号列表（应用搜索/列筛选后）
    _rowOffsets: [0],       // 累积偏移表，长度 = _viewRows.length + 1
    _vRange: null,          // 当前已渲染的视口区间 [from, to)
    _vScrollRaf: 0,         // requestAnimationFrame id（节流标记）
    // 调试日志开关（默认关闭，避免控制台被高频日志淹没）
    _debug: __DBG_DEFAULT,
    // 推送中标志：避免连点 push 按钮重复发送
    _pushing: false,
    // "仅看已修改行"筛选开关（基于快照差异高亮信息）
    _modifiedOnly: false,
    // 被删除行的快照信息（用于渲染 ghost 行）
    _deletedInfos: [],
    // "仅看新增行"筛选开关
    _addedOnly: false,
    // "仅看已删除行"筛选开关
    _deletedOnly: false,
    // 明细弹窗中修改过的单元格标记（持久化，不受 S.mods.clear() 影响）
    _detailModCellKeys: new Set(),
    // toast 当前隐藏定时器（避免连续 toast 互相截断）
    _toastTimer: null,
    // 表头中文别名映射（仅用于表头展示，不写回原始文件）
    // key = headers 中的英文字段名，value = 中文显示名
    headerLabels: {}
};

// 统一判断「是否有任何弹窗/输入控件正在打开」，供全局快捷键拦截使用。
// 新增弹窗时只需在这里追加判断，避免散落在多个 keydown 处。
function _isAnyModalOpen() {
    try {
        if (typeof isXsPromptOpen === 'function' && isXsPromptOpen()) return true;
        if (typeof isDetailModalOpen === 'function' && isDetailModalOpen()) return true;
        if (typeof isArrayCellEditorOpen === 'function' && isArrayCellEditorOpen()) return true;
    } catch (_) {}
    return false;
}

// 统一判断「焦点是否在原生输入控件 / 可编辑节点内」。
function _isFocusInForm() {
    var ae = document.activeElement;
    return !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
}

// ==================== 撤销/重做 ====================
// 浅克隆数据：每行用 slice 复制；嵌套数组单元格做一次浅 slice。
// 避免 JSON.stringify+parse 在大表上的性能开销与额外内存。
function _cloneRows(rows) {
    if (!Array.isArray(rows)) return [];
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
        var src = rows[i];
        if (!Array.isArray(src)) { out[i] = src; continue; }
        var dst = new Array(src.length);
        for (var j = 0; j < src.length; j++) {
            var v = src[j];
            // 数组列单元格：浅 slice 一份，避免后续编辑直接 mutate 历史快照
            dst[j] = Array.isArray(v) ? v.slice() : v;
        }
        out[i] = dst;
    }
    return out;
}

// 深克隆明细表数据，用于快照保存，避免 undo/redo 后 detailTables 长度与 rows 不一致
function _cloneDetailTables(dts) {
    if (!Array.isArray(dts)) return undefined;
    return dts.map(function (dt) {
        if (!dt) return dt;
        var c = { field: dt.field, fieldDisplay: dt.fieldDisplay };
        if (Array.isArray(dt.headers)) c.headers = dt.headers.slice();
        // rawRowTypes：字符串数组，浅 slice 足够
        if (Array.isArray(dt.rawRowTypes)) c.rawRowTypes = dt.rawRowTypes.slice();
        // rawRowGroups：含嵌套对象/数组，JSON 往返深克隆
        if (Array.isArray(dt.rawRowGroups)) {
            try { c.rawRowGroups = JSON.parse(JSON.stringify(dt.rawRowGroups)); }
            catch (e) { c.rawRowGroups = []; }  // 序列化失败时降级为空
        }
        // rowGroups：二维字符串数组，逐层克隆
        if (Array.isArray(dt.rowGroups)) {
            c.rowGroups = dt.rowGroups.map(function (rg) {
                if (!Array.isArray(rg)) return rg;
                return rg.map(function (r) {
                    if (!Array.isArray(r)) return r;
                    return r.slice();
                });
            });
        }
        return c;
    });
}

function snapshot() {
    try {
        var d = S.data || {};
        var snap = {
            headers: Array.isArray(d.headers) ? d.headers.slice() : [],
            rows: _cloneRows(d.rows),
            mods: Array.from(S.mods),
            addedRowSet: S._addedRowSet ? Array.from(S._addedRowSet) : []
        };
        // 兼容字段：columnTypes 等若存在则一并保留（浅引用够用，前端不修改）
        if (d.columnTypes) snap.columnTypes = d.columnTypes;
        // 深克隆明细表数据，确保 undo/redo 后 detailTables 与 rows 长度一致
        if (d.detailTables) snap.detailTables = _cloneDetailTables(d.detailTables);
        if (d.detailTable) snap.detailTable = _cloneDetailTables([d.detailTable])[0];
        return snap;
    } catch (err) {
        return null;
    }
}

function restoreSnapshot(snap) {
    if (!snap) return;
    // 兼容旧格式（snap.data 整体）：若提供了顶层 data 则取它，否则按新格式 headers/rows/columnTypes 平铺读取
    var d = snap.data ? snap.data : { headers: snap.headers, rows: snap.rows, columnTypes: snap.columnTypes };
    S.data = d || { headers: [], rows: [] };
    if (!S.data.headers) S.data.headers = [];
    if (!S.data.rows) S.data.rows = [];
    // 从快照恢复明细表数据，确保 undo/redo 后 detailTables 与 rows 长度一致
    if (snap.detailTables) S.data.detailTables = snap.detailTables;
    else if (snap.data && snap.data.detailTables) S.data.detailTables = snap.data.detailTables;
    if (snap.detailTable) S.data.detailTable = snap.detailTable;
    else if (snap.data && snap.data.detailTable) S.data.detailTable = snap.data.detailTable;
    S.mods = new Set(snap.mods || []);
    S.sel.clear();
    // 撤销/重做：可能发生了行列增删，单元格矩形选区索引已失效，直接清除
    S.cellSel = null;
    if (S.colSel) S.colSel.clear();
    S._colSelAnchor = -1;
    S._rowSelAnchor = -1;
    // 推送失败标记会“穿越”撤销点，行被还原后仍带高亮，语义混乱 → 一并清空
    if (S._pushFailedTsIds && S._pushFailedTsIds.size) S._pushFailedTsIds = new Set();
    if (S._pushFailedReasons && S._pushFailedReasons.size) S._pushFailedReasons = new Map();
    if (S._failedOnly) S._failedOnly = false;
    if (S._modifiedOnly) S._modifiedOnly = false;
    S._deletedInfos = [];
    // 撤销/重做时从快照恢复新增行集合，确保 _addedRowSet 与数据状态严格同步。
    // 旧快照不含 addedRowSet 字段时降级为空集合，避免从过期的 _addedInfos 重建错误索引。
    S._addedRowSet = new Set(snap.addedRowSet || []);
    renderTable();
    saveFile();
}

// 在每次将要发生数据修改之前调用，记录当前快照到 history
function pushHistory() {
    var snap = snapshot();
    if (!snap) return;
    S._history.push(snap);
    if (S._history.length > S._HISTORY_LIMIT) S._history.shift();
    // 任何新的修改都会清空 future（标准 undo/redo 语义）
    S._future.length = 0;
}

function clearHistory() {
    S._history.length = 0;
    S._future.length = 0;
}

function undo() {
    if (S.editing || S._detailEditing) return; // 编辑态下交给输入框默认行为
    if (_isAnyModalOpen()) return;              // 任意弹窗打开时不处理
    if (S._history.length === 0) { showToast('没有可撤销的操作', 'error'); return; }
    var current = snapshot();
    var prev = S._history.pop();
    if (current) S._future.push(current);
    restoreSnapshot(prev);
    showToast('已撤销', 'success');
}

function redo() {
    if (S.editing || S._detailEditing) return;
    if (_isAnyModalOpen()) return;
    if (S._future.length === 0) { showToast('没有可重做的操作', 'error'); return; }
    var current = snapshot();
    var next = S._future.pop();
    if (current) S._history.push(current);
    restoreSnapshot(next);
    showToast('已重做', 'success');
}

// ==================== 初始化 ====================
function init() {
    dbg('▶ init', __CFG.dataType);
    S.vscode = acquireVsCodeApi();
    // 从持久化 state 恢复 UI 状态（列宽/行高/筛选/搜索词/滚动位置）
    loadUiState();
    S.vscode.postMessage({ type: 'init' });
    bindToolbar();
    bindDocument();
    bindContainerScroll();
}

// ==================== UI 状态持久化 ====================
// 使用 vscode.getState/setState 保存列宽/行高/筛选/搜索词/滚动位置，
// 关闭 webview 后重新打开能复原。
// 按 dataType 进行命名空间隔离（同一 webview 在不同文件类型间不互相干扰）。
function _stateKey() {
    return 'ui:' + (S.dataType || 'default');
}
function loadUiState() {
    try {
        var raw = S.vscode && S.vscode.getState ? S.vscode.getState() : null;
        if (!raw) return;
        var snap = raw[_stateKey()];
        if (!snap) return;
        if (snap.colWidths && typeof snap.colWidths === 'object') {
            S.colWidths = {};
            for (var k in snap.colWidths) {
                if (snap.colWidths.hasOwnProperty(k)) S.colWidths[k] = snap.colWidths[k];
            }
        }
        if (snap.rowHeights && typeof snap.rowHeights === 'object') {
            S.rowHeights = {};
            for (var k2 in snap.rowHeights) {
                if (snap.rowHeights.hasOwnProperty(k2)) S.rowHeights[k2] = snap.rowHeights[k2];
            }
        }
        if (snap.colFilters && typeof snap.colFilters === 'object') {
            S._colFilters = {};
            for (var fc in snap.colFilters) {
                if (snap.colFilters.hasOwnProperty(fc)) {
                    var arr = snap.colFilters[fc] || [];
                    if (Array.isArray(arr)) S._colFilters[fc] = new Set(arr);
                }
            }
        }
        if (typeof snap.searchKw === 'string') {
            S._searchKw = snap.searchKw;
            // 同步填回输入框：DOM 可能尚未就绪，统一在 DOMContentLoaded / 下一帧写回
            var _writeBack = function () {
                var inp = document.getElementById('searchInput');
                if (inp && S._searchKw) inp.value = S._searchKw;
                if (typeof updateSearchClear === 'function') updateSearchClear();
            };
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', _writeBack, { once: true });
            } else {
                // 已就绪：用 rAF 把回填推到下一帧，确保 init 流程已建好工具栏
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(_writeBack);
                else _writeBack();
            }
        }
        if (typeof snap.scrollTop === 'number' && snap.scrollTop > 0) {
            S._pendingScrollTop = snap.scrollTop;
        }
    } catch (err) { dbg('loadUiState error', err && err.message); }
}

var _persistTimer = null;
function persistUiStateDebounced() {
    if (_persistTimer) return;
    // 滚动期间高频触发：用稍宽松的窗口减少 setState 调用次数。
    _persistTimer = setTimeout(function () {
        _persistTimer = null;
        persistUiStateNow();
    }, 600);
}
function persistUiStateNow() {
    try {
        if (!S.vscode || !S.vscode.getState || !S.vscode.setState) return;
        var raw = S.vscode.getState() || {};
        var cont = document.getElementById('tableContainer');
        var cf = {};
        if (S._colFilters) {
            for (var fc in S._colFilters) {
                if (S._colFilters.hasOwnProperty(fc) && S._colFilters[fc] instanceof Set) {
                    cf[fc] = Array.from(S._colFilters[fc]);
                }
            }
        }
        raw[_stateKey()] = {
            colWidths: S.colWidths || {},
            rowHeights: S.rowHeights || {},
            colFilters: cf,
            searchKw: S._searchKw || '',
            scrollTop: cont ? cont.scrollTop : 0
        };
        S.vscode.setState(raw);
    } catch (err) { dbg('persistUiState error', err && err.message); }
}

// 容器滚动时 debounced 写回滚动位置
function bindContainerScroll() {
    var cont = document.getElementById('tableContainer');
    if (!cont || cont._xsScrollBound) return;
    cont._xsScrollBound = true;
    cont.addEventListener('scroll', function () { persistUiStateDebounced(); }, { passive: true });
}

// 注意：这里不监听 window.focus 重新 postMessage('init')。
// 在 retainContextWhenHidden=true 模式下，webview 状态会被保留；
// 若每次 focus 都重新 init，扩展端会回包覆盖当前 S.data，从而丢失未保存的修改、撤销栈、滚动位置，
// 并在 yaml/json 多 tab 之间切换时表现为"页面互相覆盖"。

// 消息处理
window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m) return;
    if (m.type === S.msgType) {
        // 表头中英映射：数据下发时顺带更新（需在 renderTable 之前写入 S，让骨架构造拿到最新映射）
        if (m.headerLabels && typeof m.headerLabels === 'object') {
            S.headerLabels = m.headerLabels;
        }
        var hasUserChanges = (S.mods && S.mods.size > 0) || (S._history && S._history.length > 0);
        var alreadyRendered = !!(S.data && Array.isArray(S.data.headers) && S.data.headers.length > 0);
        var _curRowsLen0 = (S.data && S.data.rows && S.data.rows.length) || 0;
        dbg('📨 recv ' + m.type
            + ' force=' + !!m.force
            + ' reason=' + (m.reason || '')
            + ' external=' + !!m.externalChange
            + ' curRows=' + _curRowsLen0
            + ' mods=' + (S.mods ? S.mods.size : 0)
            + ' history=' + (S._history ? S._history.length : 0)
            + ' editing=' + S.editing);
        // 兜底重发数据场景：当切换 tab 后扩展端主动 repush 时，
        // 如果用户已有未保存修改或撤销栈，则忽略这次推送，避免覆盖用户编辑成果。
        // 例外：当扩展端带 force=true（如外部 TextEditor 修改了文件），强制覆盖以同步最新内容。
        if (hasUserChanges && alreadyRendered && !m.force) {
            dbg('⏭ skip repush (user changes)');
            // saveHighlight 等 reason 带高亮信息时，仍更新 highlightedCells / addedInfos 避免丢失
            if ('highlightedCells' in m) {
                if (m.highlightedCells && m.highlightedCells.colIdx != null && Array.isArray(m.highlightedCells.rowIndices)) {
                    var hl = {
                        colIdx: m.highlightedCells.colIdx,
                        rowSet: new Set(m.highlightedCells.rowIndices),
                        cells: null
                    };
                    if (m.highlightedCells.cells && Array.isArray(m.highlightedCells.cells)) {
                        hl.cells = new Set();
                        for (var ci_hl2 = 0; ci_hl2 < m.highlightedCells.cells.length; ci_hl2++) {
                            var c2 = m.highlightedCells.cells[ci_hl2];
                            hl.cells.add(c2[0] + ':' + c2[1]);
                        }
                    }
                    S._highlightedCells = hl;
                } else {
                    S._highlightedCells = null;
                    // highlightedCells=null 表示后端 diff 无变化（数据已回到快照基线），
                    // 同步清除 detailModCellKeys 避免单元格黄色背景残留
                    if (S._detailModCellKeys && S._detailModCellKeys.size > 0) S._detailModCellKeys.clear();
                }
            }
            // 合并后端下发的新增行信息：先清空再重建，确保 _addedRowSet 与扩展端 diff 结果完全一致，
            // 避免旧索引残留导致非新增行被误标绿（undo / 行列增删后索引错位场景）。
            if ('addedInfos' in m) {
                if (!S._addedRowSet) S._addedRowSet = new Set();
                S._addedRowSet.clear();
                if (m.addedInfos && Array.isArray(m.addedInfos) && m.addedInfos.length > 0) {
                    S._addedInfos = m.addedInfos;
                    for (var _ai = 0; _ai < m.addedInfos.length; _ai++) {
                        S._addedRowSet.add(m.addedInfos[_ai].rowIndex);
                    }
                } else {
                    S._addedInfos = [];
                }
                // 没有新增行数据时自动关闭"仅看新增行"筛选
                if (S._addedRowSet.size === 0) {
                    if (S._addedOnly) S._addedOnly = false;
                }
            }
            // 同步后端下发的已删除行信息（skip-data 路径之前遗漏了 deletedInfos，导致
            // 新增行被删后 ghost row 残留，刷新后才消失）
            if ('deletedInfos' in m) {
                if (m.deletedInfos && Array.isArray(m.deletedInfos) && m.deletedInfos.length > 0) {
                    S._deletedInfos = m.deletedInfos;
                } else {
                    S._deletedInfos = [];
                    if (S._deletedOnly) S._deletedOnly = false;
                }
            }
            renderTable();
            return;
        }
        var _newData = decodePayload(m.data) || { headers: [], rows: [] };
        if (!_newData.headers) _newData.headers = [];
        if (!_newData.rows) _newData.rows = [];
        // 最后防线：force=true 强推但新数据 0 行 + 当前已有数据，疑似 fs 写入中间态被读到，
        // 拒绝覆盖以避免界面突然变空（扩展端 push-find/onDidSaveTextDocument 自反弹场景）。
        var _curRowsLen = (S.data && S.data.rows && S.data.rows.length) || 0;
        if (m.force && _newData.rows.length === 0 && _curRowsLen > 0) {
            dbg('⏭ skip suspicious empty repush newRows=0 curRows=' + _curRowsLen + ' reason=' + (m.reason || ''));
            return;
        }
        // 设计契约：前端编辑实时保存（saved 后 mods 即清空），外部修改保存后切回 webview 自动加载最新文件数据。
        // 因此对 force=true 的外部变更/可见切换，统一直接覆盖前端，不再弹冲突弹窗。
        S.data = _newData;
        dbg('🎨 render rows=' + S.data.rows.length + ' force=' + !!m.force + ' reason=' + (m.reason || ''));
        S.sel.clear();
        S.mods.clear();
        S._detailModCellKeys.clear();
        // 数据重装载：仅当列结构发生变化时才清空列筛选（避免抹掉持久化恢复的筛选）
        var _newHeadSig = (S.data.headers || []).join('\u0001');
        if (S._lastHeadSig !== _newHeadSig) {
            S._colFilters = {};
            S._lastHeadSig = _newHeadSig;
            // 列结构变化：行列宽度/高度的索引已失去意义，旧的推送失败/批次集合也归零，避免穿透到新文件
            S.colWidths = {};
            S.rowHeights = {};
            S._pushFailedTsIds = new Set();
            S._pushFailedReasons = new Map();
            S._lastPushBatchTsIds = new Set();
            S._failedOnly = false;
            S._modifiedOnly = false;
            S._highlightedCells = null;
        }
        // 高亮信息更新（必须在 _lastHeadSig 检查之后，避免首次 init 被列变化分支覆盖）
        // 仅在字段存在时更新：visible/reload 等不带 highlightedCells 时保留已有高亮
        if ('highlightedCells' in m) {
            if (m.highlightedCells && m.highlightedCells.colIdx != null && Array.isArray(m.highlightedCells.rowIndices)) {
                var hl = {
                    colIdx: m.highlightedCells.colIdx,
                    rowSet: new Set(m.highlightedCells.rowIndices),
                    cells: null
                };
                // cells 为 [rowIdx, colIdx][] 扁平数组，用于精确逐格高亮
                if (m.highlightedCells.cells && Array.isArray(m.highlightedCells.cells)) {
                    hl.cells = new Set();
                    for (var ci_hl = 0; ci_hl < m.highlightedCells.cells.length; ci_hl++) {
                        var c = m.highlightedCells.cells[ci_hl];
                        hl.cells.add(c[0] + ':' + c[1]);
                    }
                }
                S._highlightedCells = hl;
            } else {
                S._highlightedCells = null;
            }
        }
        // 推送失败标记：从扩展端持久化文件（push-failures.json）下发，按 testcase_id 关联。
        // 字段存在则覆盖恢复整套失败映射；不存在则保留前端现有内存集合。
        if ('pushFailures' in m) {
            if (m.pushFailures && typeof m.pushFailures === 'object') {
                var pf = m.pushFailures;
                S._pushFailedTsIds = new Set();
                S._pushFailedReasons = new Map();
                for (var _pfk in pf) {
                    if (!Object.prototype.hasOwnProperty.call(pf, _pfk)) continue;
                    var _kStr = String(_pfk);
                    if (!_kStr) continue;
                    S._pushFailedTsIds.add(_kStr);
                    if (pf[_pfk]) S._pushFailedReasons.set(_kStr, String(pf[_pfk]));
                }
            } else {
                S._pushFailedTsIds = new Set();
                S._pushFailedReasons = new Map();
                if (S._failedOnly) S._failedOnly = false;
            }
        }
        // 删除行信息（快照中有但当前数据中已不存在的行）
        if ('deletedInfos' in m) {
            if (m.deletedInfos && Array.isArray(m.deletedInfos) && m.deletedInfos.length > 0) {
                S._deletedInfos = m.deletedInfos;
            } else {
                S._deletedInfos = [];
                // 如果没有已删除行，自动关闭"仅看已删除行"筛选
                if (S._deletedOnly) S._deletedOnly = false;
            }
        }
        // 新增行信息（快照中不存在但当前数据中出现的行）
        // 先清空再重建，确保 _addedRowSet 与扩展端 diff 结果完全一致，避免旧索引残留。
        if ('addedInfos' in m) {
            if (!S._addedRowSet) S._addedRowSet = new Set();
            S._addedRowSet.clear();
            if (m.addedInfos && Array.isArray(m.addedInfos) && m.addedInfos.length > 0) {
                S._addedInfos = m.addedInfos;
                for (var ai = 0; ai < m.addedInfos.length; ai++) {
                    S._addedRowSet.add(m.addedInfos[ai].rowIndex);
                }
            } else {
                S._addedInfos = [];
            }
            // 没有新增行时自动关闭"仅看新增行"筛选
            if (S._addedRowSet.size === 0) {
                if (S._addedOnly) S._addedOnly = false;
            }
        }
        clearHistory();
        renderTable();
        // 用户主动点击 “重置筛选并获取最新数据” 时，给出明确的成功反馈
        if (m.reason === 'reload' && typeof showToast === 'function') {
            showToast('已获取最新数据并重置筛选', 'success');
        }
    } else if (m.type === 'saved') {
        dbg('📨 recv saved curRows=' + ((S.data && S.data.rows && S.data.rows.length) || 0)
            + ' mods=' + (S.mods ? S.mods.size : 0)
            + ' history=' + (S._history ? S._history.length : 0));
        showToast('保存成功', 'success');
        S.mods.clear();
        if (S._detailModCellKeys && S._detailModCellKeys.size > 0) S._detailModCellKeys.clear();
        renderTable();
    } else if (m.type === 'saveError') {
        dbg('📨 recv saveError: ' + (m.message || ''));
        showToast('保存失败: ' + (m.message || ''), 'error');
    } else if (m.type === 'headerLabelsUpdated') {
        // 配置项 / 工作区 .vscode/headerLabels.json 变更后热更新表头别名
        if (m.headerLabels && typeof m.headerLabels === 'object') {
            S.headerLabels = m.headerLabels;
            try { renderTable(); } catch (_) { /* ignore */ }
        }
    } else if (m.type === 'pushDone') {
        // 推送流程结束钩子（隐藏 loading 等）。
        S._pushing = false;
        if (typeof updatePushBtn === 'function') updatePushBtn();
        // 安全网：pushDone 到达时主动清理本批修改高亮。
        // pushResult 中也有相同逻辑，此处作为兜底确保所有推送完成路径都清理。
        // 不置空 _lastPushBatchRowIndices / _lastPushBatchTsIds，留给 pushResult 完整消费。
        var pdRowIndices = S._lastPushBatchRowIndices;
        if ((!pdRowIndices || pdRowIndices.length === 0) && S._lastPushBatchTsIds && S._lastPushBatchTsIds.size > 0) {
            var pdTsCol = (S.data && S.data.headers ? S.data.headers.indexOf('testcase_id') : -1);
            if (pdTsCol >= 0) {
                pdRowIndices = [];
                for (var pdRi = 0; pdRi < (S.data.rows && S.data.rows.length || 0); pdRi++) {
                    var pdTid = (S.data.rows[pdRi] || [])[pdTsCol];
                    if (pdTid !== undefined && pdTid !== null && pdTid !== '' && S._lastPushBatchTsIds.has(String(pdTid))) {
                        pdRowIndices.push(pdRi);
                    }
                }
            }
        }
        if (pdRowIndices && pdRowIndices.length > 0) {
            var pdModsToDelete = [];
            S.mods.forEach(function (key) {
                var commaIdx = key.indexOf(',');
                if (commaIdx > -1 && pdRowIndices.indexOf(parseInt(key.substring(0, commaIdx), 10)) !== -1) {
                    pdModsToDelete.push(key);
                }
            });
            pdModsToDelete.forEach(function (k) { S.mods.delete(k); });
            if (S._detailModCellKeys && S._detailModCellKeys.size > 0) {
                var pdDetailToDelete = [];
                S._detailModCellKeys.forEach(function (key) {
                    var commaIdx = key.indexOf(',');
                    if (commaIdx > -1 && pdRowIndices.indexOf(parseInt(key.substring(0, commaIdx), 10)) !== -1) {
                        pdDetailToDelete.push(key);
                    }
                });
                pdDetailToDelete.forEach(function (k) { S._detailModCellKeys.delete(k); });
            }
            // 清除已推送行的新增高亮（推送后不再是"新"增行）
            if (S._addedRowSet && S._addedRowSet.size > 0) {
                pdRowIndices.forEach(function (ri) { S._addedRowSet.delete(ri); });
            }
            try { renderTable(); } catch (_) {}
        }
    } else if (m.type === 'pushResult') {
        S._pushing = false;
        if (typeof updatePushBtn === 'function') updatePushBtn();
        // 保险：若 _lastPushBatchRowIndices 意外丢失，用 _lastPushBatchTsIds 反推，确保 showPushResultModal 能正确清理
        if ((!S._lastPushBatchRowIndices || S._lastPushBatchRowIndices.length === 0)
            && S._lastPushBatchTsIds && S._lastPushBatchTsIds.size > 0) {
            var _tsColFix = (S.data && S.data.headers ? S.data.headers.indexOf('testcase_id') : -1);
            if (_tsColFix >= 0) {
                var _rebuilt = [];
                for (var _ri = 0; _ri < (S.data.rows && S.data.rows.length || 0); _ri++) {
                    var _tid = (S.data.rows[_ri] || [])[_tsColFix];
                    if (_tid !== undefined && _tid !== null && _tid !== '' && S._lastPushBatchTsIds.has(String(_tid))) {
                        _rebuilt.push(_ri);
                    }
                }
                if (_rebuilt.length > 0) S._lastPushBatchRowIndices = _rebuilt;
            }
        }
        showPushResultModal(m);
    } else if (m.type === 'pushError') {
        S._pushing = false;
        if (typeof updatePushBtn === 'function') updatePushBtn();
        // pushError 同样属于推送完成，清理本批修改高亮
        var peRowIndices = S._lastPushBatchRowIndices;
        // 兜底：行索引丢失时从 _lastPushBatchTsIds 反推
        if ((!peRowIndices || peRowIndices.length === 0) && S._lastPushBatchTsIds && S._lastPushBatchTsIds.size > 0) {
            var peTsCol = (S.data && S.data.headers ? S.data.headers.indexOf('testcase_id') : -1);
            if (peTsCol >= 0) {
                peRowIndices = [];
                for (var peRi = 0; peRi < (S.data.rows && S.data.rows.length || 0); peRi++) {
                    var peTid = (S.data.rows[peRi] || [])[peTsCol];
                    if (peTid !== undefined && peTid !== null && peTid !== '' && S._lastPushBatchTsIds.has(String(peTid))) {
                        peRowIndices.push(peRi);
                    }
                }
            }
        }
        if (peRowIndices && peRowIndices.length > 0) {
            var peModsToDelete = [];
            S.mods.forEach(function (key) {
                var commaIdx = key.indexOf(',');
                if (commaIdx > -1 && peRowIndices.indexOf(parseInt(key.substring(0, commaIdx), 10)) !== -1) {
                    peModsToDelete.push(key);
                }
            });
            peModsToDelete.forEach(function (k) { S.mods.delete(k); });
            if (S._detailModCellKeys && S._detailModCellKeys.size > 0) {
                var peDetailToDelete = [];
                S._detailModCellKeys.forEach(function (key) {
                    var commaIdx = key.indexOf(',');
                    if (commaIdx > -1 && peRowIndices.indexOf(parseInt(key.substring(0, commaIdx), 10)) !== -1) {
                        peDetailToDelete.push(key);
                    }
                });
                peDetailToDelete.forEach(function (k) { S._detailModCellKeys.delete(k); });
            }
            // 清除已推送行的新增高亮
            if (S._addedRowSet && S._addedRowSet.size > 0) {
                peRowIndices.forEach(function (ri) { S._addedRowSet.delete(ri); });
            }
            S._lastPushBatchRowIndices = null;
        }
        S._lastPushBatchTsIds = null;
        try { renderTable(); } catch (_) {}
        showToast('推送失败: ' + (m.message || ''), 'error');
    } else if (m.type === 'showModal') {
        showXsInfoModal(m.modalType || 'info', m.title || '', m.message || '');
    }
});

// 推送结果统一由扩展端通过独立 webview 弹窗展示，前端不再处理 pushSuccess。

function decodePayload(payload) {
    if (!payload) return {};
    if (!Array.isArray(payload) && typeof payload === 'object') return payload;
    try {
        var bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
        return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch (err) {
        console.error('[editor] 解析数据失败:', err);
        return {};
    }
}


// ==================== 工具函数 ====================
function escapeHtml(str) {
    var s = String(str);
    // 一次正则 表查表，与多次 replace 路径业务等价但性能略优
    return s.replace(/[&<>"]/g, function (ch) {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
        }
        return ch;
    });
}
function formatCellValue(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) {
        // 标量数组列的单元格：主表不再需要拼接成字符串（由 chip 渲染负责），
        // 但查找/搜索/拷贝单元格等路径仍会调用 formatCellValue，统一以 "; " 拼接。
        if (v.length === 0) return '';
        return v.map(function (x) {
            if (x === null || x === undefined) return '';
            // 对象数组：每个元素序列化为 JSON，避免出现 [object Object]
            if (typeof x === 'object') {
                try { return JSON.stringify(x); } catch (_e) { return ''; }
            }
            return String(x);
        }).join('; ');
    }
    // 普通对象：序列化为 JSON 字符串（避免 String({}) → [object Object]）
    if (typeof v === 'object') {
        try { return JSON.stringify(v); } catch (_e) { return ''; }
    }
    return String(v);
}
// 深拷贝单元格值：对象/对象数组使用 JSON 深拷贝，避免引用共享导致复制后编辑互相污染
function _deepCloneCellValue(v) {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) {
        // 含对象元素的数组（对象数组）走 JSON 深拷贝；纯标量数组走 slice 即可
        var hasObj = false;
        for (var i = 0; i < v.length; i++) {
            if (v[i] && typeof v[i] === 'object') { hasObj = true; break; }
        }
        if (hasObj) {
            try { return JSON.parse(JSON.stringify(v)); } catch (_e) { return v.slice(); }
        }
        return v.slice();
    }
    if (typeof v === 'object') {
        try { return JSON.parse(JSON.stringify(v)); } catch (_e) { return v; }
    }
    return v;
}
// 判断某列是否为标量数组列（string[] / number[]）
function isArrayCol(ci) {
    if (!S.data || !S.data.columnTypes) return false;
    var headers = S.data.headers || [];
    var name = headers[ci];
    if (name === undefined) return false;
    var t = S.data.columnTypes[name];
    return t === 'string[]' || t === 'number[]';
}
function getArrayColKind(ci) {
    if (!S.data || !S.data.columnTypes) return null;
    var headers = S.data.headers || [];
    var name = headers[ci];
    if (name === undefined) return null;
    var t = S.data.columnTypes[name];
    return (t === 'string[]' || t === 'number[]') ? t : null;
}
// 生成 MA + hex 格式 UUID（与扩展端 utils.genUuid 实现一致）
function genUuidV4() {
    var arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    var hex = '';
    for (var i = 0; i < arr.length; i++) {
        hex += (arr[i] < 16 ? '0' : '') + arr[i].toString(16);
    }
    return 'MA' + hex;
}
function showToast(msg, type) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'xs-toast ' + (type || '');
    t.style.display = 'block';
    // 同时只有一个隐藏定时器，避免上一条 toast 的定时器把后一条提前关掉。
    if (S._toastTimer) { try { clearTimeout(S._toastTimer); } catch (_) {} }
    S._toastTimer = setTimeout(function () {
        S._toastTimer = null;
        t.style.display = 'none';
    }, 2000);
}

// ==================== 通用信息模态框（由扩展端 showModal 驱动） ====================
var XS_INFO_ICON = { success: '✓', error: '✕', warning: '!', info: 'i' };
var XS_INFO_COLOR = { success: '#28a745', error: '#dc3545', warning: '#f0a020', info: '#0078d4' };
var XS_INFO_BG = {
    success: 'linear-gradient(180deg,#e6f4ea,#f3faf5)',
    error:   'linear-gradient(180deg,#fdecea,#fdf3f3)',
    warning: 'linear-gradient(180deg,#fef3e0,#fff8ec)',
    info:    'linear-gradient(180deg,#e8f0fe,#f3f8ff)'
};
function bindXsInfoModal() {
    if (S._xsInfoBound) return;
    S._xsInfoBound = true;
    var modal = document.getElementById('xsInfoModal');
    var close = document.getElementById('xsInfoClose');
    var ok = document.getElementById('xsInfoOkBtn');
    if (close) close.addEventListener('click', closeXsInfoModal);
    if (ok) ok.addEventListener('click', closeXsInfoModal);
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closeXsInfoModal(); });
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
            var m = document.getElementById('xsInfoModal');
            if (m && m.classList.contains('show')) {
                ev.preventDefault();
                closeXsInfoModal();
            }
        }
    });
}
function showXsInfoModal(modalType, title, message) {
    bindXsInfoModal();
    var header = document.getElementById('xsInfoHeader');
    var iconEl = document.getElementById('xsInfoIcon');
    var titleEl = document.getElementById('xsInfoTitle');
    var bodyEl = document.getElementById('xsInfoBody');
    var footer = document.getElementById('xsInfoFooter');
    var extraBtns = document.getElementById('xsInfoExtraBtns');
    var type = modalType || 'info';
    var color = XS_INFO_COLOR[type] || XS_INFO_COLOR.info;
    if (header) header.style.background = XS_INFO_BG[type] || XS_INFO_BG.info;
    if (iconEl) { iconEl.textContent = XS_INFO_ICON[type] || 'i'; iconEl.style.background = color; }
    if (titleEl) titleEl.textContent = title || '提示';
    if (bodyEl) bodyEl.innerHTML = escapeHtml(message || '');
    if (extraBtns) extraBtns.innerHTML = '';
    if (footer) footer.style.display = '';
    // 隐藏 footer 里的 ok 按钮旁边不需要的额外元素
    var okBtn = document.getElementById('xsInfoOkBtn');
    if (okBtn) { okBtn.style.display = ''; okBtn.style.background = color; okBtn.style.borderColor = color; }
    var modal = document.getElementById('xsInfoModal');
    if (modal) modal.classList.add('show');
}
function closeXsInfoModal() {
    var modal = document.getElementById('xsInfoModal');
    if (modal) modal.classList.remove('show');
}

