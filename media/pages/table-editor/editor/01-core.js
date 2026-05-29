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
var __LOG_TAG = '[TC-WEBVIEW][' + (__CFG.dataType || '?') + '#' + Math.random().toString(36).slice(2, 6) + ']';
function dbg() {
    var args = Array.prototype.slice.call(arguments);
    try { console.log.apply(console, [__LOG_TAG].concat(args)); } catch (_) {}
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
    _colSelAnchor: -1       // shift 多选锚点列
};

// ==================== 撤销/重做 ====================
function snapshot() {
    try {
        return {
            data: JSON.parse(JSON.stringify(S.data || {})),
            mods: Array.from(S.mods)
        };
    } catch (err) {
        return null;
    }
}

function restoreSnapshot(snap) {
    if (!snap) return;
    S.data = snap.data || { headers: [], rows: [] };
    if (!S.data.headers) S.data.headers = [];
    if (!S.data.rows) S.data.rows = [];
    S.mods = new Set(snap.mods || []);
    S.sel.clear();
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
    if (isDetailModalOpen()) return;            // 明细弹窗中不处理
    if (S._history.length === 0) { showToast('没有可撤销的操作', 'error'); return; }
    var current = snapshot();
    var prev = S._history.pop();
    if (current) S._future.push(current);
    restoreSnapshot(prev);
    showToast('已撤销', 'success');
}

function redo() {
    if (S.editing || S._detailEditing) return;
    if (isDetailModalOpen()) return;
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
    S.vscode.postMessage({ type: 'init' });
    bindToolbar();
    bindDocument();
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
        var hasUserChanges = (S.mods && S.mods.size > 0) || (S._history && S._history.length > 0);
        var alreadyRendered = !!(S.data && Array.isArray(S.data.headers) && S.data.headers.length > 0);
        // 兜底重发数据场景：当切换 tab 后扩展端主动 repush 时，
        // 如果用户已有未保存修改或撤销栈，则忽略这次推送，避免覆盖用户编辑成果。
        // 例外：当扩展端带 force=true（如外部 TextEditor 修改了文件），强制覆盖以同步最新内容。
        if (hasUserChanges && alreadyRendered && !m.force) {
            dbg('⏭ skip repush (user changes)');
            renderTable();
            return;
        }
        S.data = decodePayload(m.data) || { headers: [], rows: [] };
        if (!S.data.headers) S.data.headers = [];
        if (!S.data.rows) S.data.rows = [];
        dbg('🎨 render rows=' + S.data.rows.length + ' force=' + !!m.force + ' reason=' + (m.reason || ''));
        S.sel.clear();
        S.mods.clear();
        // 数据重装载：清空列筛选（列数/值可能差异较大）
        S._colFilters = {};
        clearHistory();
        renderTable();
    } else if (m.type === 'saved') {
        showToast('保存成功', 'success');
        S.mods.clear();
        renderTable();
    } else if (m.type === 'saveError') {
        showToast('保存失败: ' + (m.message || ''), 'error');
    } else if (m.type === 'pushDone') {
        // 推送流程结束钩子（隐藏 loading 等）；具体结果由 pushResult 消息驱动弹窗。
    } else if (m.type === 'pushResult') {
        showPushResultModal(m);
    } else if (m.type === 'pushError') {
        showToast('推送失败: ' + (m.message || ''), 'error');
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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatCellValue(v) { return v === null || v === undefined ? '' : String(v); }
// 生成 RFC4122 v4 UUID（与扩展端 utils.genUuid 实现一致）
function genUuidV4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        var v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
function showToast(msg, type) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'xs-toast ' + (type || '');
    t.style.display = 'block';
    setTimeout(function () { t.style.display = 'none'; }, 2000);
}
