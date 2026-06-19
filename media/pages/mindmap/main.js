// ============================================================================
// 测试大纲 · 思维导图编辑器（webview 前端，markmap-view 渲染版本）
// ----------------------------------------------------------------------------
// 渲染层：基于 markmap-view（SVG + 贝塞尔曲线 + d3-zoom），通过预打包的
// vendor/markmap.bundle.js 注入到 window.markmap。
//
// 与扩展端协议（postMessage，未变更，保持向后兼容）：
//   ▲ 收到（扩展端 → webview）：
//       { type: 'init', fileName, tree, reason }
//       { type: 'parseError', message }
//       { type: 'exportXmindResult', ok, fsPath?, message?, canceled? }
//   ▼ 发送（webview → 扩展端）：
//       { type: 'ready' }
//       { type: 'update', tree }
//       { type: 'exportXmind' }
//       { type: 'openWithText' }
//
// 数据模型转换：
//   扩展端 MindmapNode（业务）：{ id, title, kind, children }
//   markmap IPureNode（渲染）：{ content, payload:{mmId, kind, fold}, children }
//   - mmId 在 payload 中保留，作为节点身份识别（贯穿渲染前后）
//   - fold（payload.fold=1）= 折叠
//
// 编辑能力（与原版对等）：
//   - 单击：选中
//   - 双击 / F2：进入 contentEditable 重命名
//   - Tab：在选中节点下添加子节点
//   - Enter：在选中节点之后添加同级节点
//   - Delete / Backspace：删除（根节点不允许）
//   - Drag & Drop：拖拽改父
//   - 右键菜单：完整动作集合
//   - 折叠按钮（markmap 自带 circle）：展开/折叠
//   - 滚轮缩放、空白拖拽平移：markmap 自带
// ============================================================================

const vscode = acquireVsCodeApi();

// ============ 全局状态 ============
let treeRoot = null;          // 业务节点树（含 id/title/kind/children），权威数据
let selectedId = null;        // 当前选中节点 id
let dragSourceId = null;      // 拖拽源节点 id
let mm = null;                // markmap 实例
let isEditingNode = false;    // 节点正在 contentEditable 状态
let pendingFold = new Map();  // mmId → fold(0/1)，跨 setData 持久化折叠态

// ============ 主题（亮/暗，持久化到 localStorage） ============
const LS_THEME = 'mm.theme';
function safeGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function safeSet(key, v) { try { localStorage.setItem(key, v); } catch (_) {} }
function applyTheme(theme) {
    document.body.dataset.theme = theme;
    safeSet(LS_THEME, theme);
}
function toggleTheme() {
    const next = (document.body.dataset.theme === 'dark') ? 'light' : 'dark';
    applyTheme(next);
    setStatus(`主题：${next === 'dark' ? '暗色' : '亮色'}`);
    // 主题切换后无需重渲染：CSS 变量驱动；只是节点选中色等需要刷新一下
    if (mm && treeRoot) renderMarkmap({ keepView: true });
}

// ============ 节点样式（边框/内边距/圆角，持久化到 localStorage） ============
// 这些值会通过 :root 的 CSS 变量驱动节点 div 的 padding/box-shadow/border-radius，
// 同时在 markmap 重新计算节点尺寸时被 scrollWidth/scrollHeight 测量到，避免重叠。
const LS_NODE_STYLE = 'mm.nodeStyle.v1';
const NODE_STYLE_DEFAULT = {
    border: true,        // 是否显示边框
    borderWidth: 1.5,    // px
    paddingX: 10,        // px
    paddingY: 4,         // px
    radius: 6,           // px
    maxWidth: 600,       // px —— 全局节点最大宽度（长文本到此宽度即换行）
};
// 单节点宽度覆写（按当前文件名分桶持久化；md 文件不存这层语义，只能本地缓存）
const LS_NODE_WIDTHS_PREFIX = 'mm.nodeWidths.';
let currentFileName = '';
let nodeWidthOverrides = {}; // { [mmId]: widthPx }
function nodeWidthsKey() { return LS_NODE_WIDTHS_PREFIX + (currentFileName || '__default__'); }
function loadNodeWidths() {
    try {
        const raw = safeGet(nodeWidthsKey());
        nodeWidthOverrides = raw ? (JSON.parse(raw) || {}) : {};
    } catch (_) { nodeWidthOverrides = {}; }
}
function saveNodeWidths() {
    safeSet(nodeWidthsKey(), JSON.stringify(nodeWidthOverrides || {}));
}
let nodeStyle = loadNodeStyle();
function loadNodeStyle() {
    try {
        const raw = safeGet(LS_NODE_STYLE);
        if (!raw) return { ...NODE_STYLE_DEFAULT };
        const obj = JSON.parse(raw);
        return { ...NODE_STYLE_DEFAULT, ...(obj || {}) };
    } catch (_) { return { ...NODE_STYLE_DEFAULT }; }
}
function saveNodeStyle() { safeSet(LS_NODE_STYLE, JSON.stringify(nodeStyle)); }
/** 把 nodeStyle 写到 :root CSS 变量；如需让 markmap 重新测量布局，传 relayout=true */
function applyNodeStyle(relayout) {
    const root = document.documentElement.style;
    root.setProperty('--mm-node-pad-x', nodeStyle.paddingX + 'px');
    root.setProperty('--mm-node-pad-y', nodeStyle.paddingY + 'px');
    root.setProperty('--mm-node-border-w', nodeStyle.borderWidth + 'px');
    root.setProperty('--mm-node-border-on', nodeStyle.border ? '1' : '0');
    root.setProperty('--mm-node-radius', nodeStyle.radius + 'px');
    root.setProperty('--mm-node-max-width', nodeStyle.maxWidth + 'px');
    if (relayout && mm && treeRoot) {
        // padding/maxWidth 改变会影响节点真实宽高 → 必须重新调用 setData 让 markmap 重新测量
        renderMarkmap({ keepView: true });
    }
}

// ============ DOM 引用 ============
const $ = (id) => document.getElementById(id);
const canvas = $('mmCanvas');
const svgEl = $('mmSvg');
const fileNameEl = $('mmFileName');
const statusEl = $('mmStatus');
const emptyEl = $('mmEmpty');

// ============ 工具函数 ============
function setStatus(msg) { statusEl.textContent = msg; }

function genId() {
    return 'n_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
}

/** 在业务树中按 id 查找节点。返回 { node, parent, index } 或 null。 */
function findNode(root, id) {
    if (!root) return null;
    if (root.id === id) return { node: root, parent: null, index: -1 };
    const stack = [{ parent: root, list: root.children || [] }];
    while (stack.length) {
        const cur = stack.pop();
        for (let i = 0; i < cur.list.length; i++) {
            const n = cur.list[i];
            if (n.id === id) return { node: n, parent: cur.parent, index: i };
            if (n.children && n.children.length) stack.push({ parent: n, list: n.children });
        }
    }
    return null;
}

/** ancestor 是否是 candidateId 节点的祖先（含自身）—— 防拖到自己后代下 */
function isAncestor(ancestor, candidateId) {
    if (!ancestor) return false;
    if (ancestor.id === candidateId) return true;
    if (!ancestor.children) return false;
    return ancestor.children.some(c => isAncestor(c, candidateId));
}

/** 业务树 → markmap IPureNode（content 是 HTML 字符串，必须转义） */
function toPureNode(node) {
    return {
        content: escapeHtml(node.title || ''),
        payload: {
            mmId: node.id,
            kind: node.kind || 'heading',
            ...(pendingFold.get(node.id) ? { fold: 1 } : {}),
        },
        children: (node.children || []).map(toPureNode),
    };
}
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 把节点树发回扩展端（扩展端会序列化为 md 并 applyEdit） */
function pushUpdate() {
    vscode.postMessage({ type: 'update', tree: treeRoot });
}

function countNodes(n) {
    if (!n) return 0;
    let c = 1;
    (n.children || []).forEach(child => { c += countNodes(child); });
    return c;
}

// ============ markmap 渲染 ============
function ensureMarkmap() {
    if (mm) return mm;
    if (!window.markmap || !window.markmap.Markmap) {
        console.error('[Mindmap] vendor markmap.bundle.js 未加载');
        return null;
    }
    const { Markmap } = window.markmap;
    // ---- 配色方案：按节点深度循环取色（参考 XMind / MindNode 经验） ----
    // 索引 0 是根节点，1 是一级分支……颜色更鲜明、对比度足够
    const PALETTE_LIGHT = [
        '#2563eb', // 根：蓝
        '#0ea5e9', // 一级：天蓝
        '#10b981', // 二级：绿
        '#f59e0b', // 三级：橙
        '#ec4899', // 四级：粉
        '#8b5cf6', // 五级：紫
        '#14b8a6', // 六级：青
        '#ef4444', // 七级：红
    ];
    const PALETTE_DARK = [
        '#60a5fa',
        '#38bdf8',
        '#34d399',
        '#fbbf24',
        '#f472b6',
        '#a78bfa',
        '#2dd4bf',
        '#f87171',
    ];
    const colorOf = (node) => {
        const palette = (document.body.dataset.theme === 'dark') ? PALETTE_DARK : PALETTE_LIGHT;
        const depth = (node && node.state && typeof node.state.depth === 'number') ? node.state.depth : 0;
        return palette[depth % palette.length];
    };

    mm = Markmap.create(svgEl, {
        // 多色配色（按深度），代替默认的 schemeCategory10
        color: colorOf,
        // 节点最大宽度（px）—— 适当放宽避免常见标题被截
        maxWidth: 600,
        // 节点内 padding（沿用 markmap 默认 8，避免破坏其内置布局测量）
        paddingX: 8,
        // 横向/纵向节点间距：用 markmap 默认值（80 / 5）— 之前过大反而把分支拉散重叠
        spacingHorizontal: 80,
        spacingVertical: 5,
        // 初始全部展开（折叠态由 pendingFold 控制）
        initialExpandLevel: -1,
        // 自动适配视口
        autoFit: false,
        // 平移与缩放
        pan: true,
        zoom: true,
        // 折叠时是否递归（false 表示只折叠/展开当前层）
        toggleRecursively: false,
        // 连线粗细按深度递减：根节点出来的线最粗，叶子最细 —— 视觉锚点
        lineWidth: (node) => Math.max(1.5, 4 - (node.state ? node.state.depth : 0) * 0.5),
        duration: 200,
    }, null);

    // 拦截 markmap 默认 click：默认它会切换折叠（针对节点圆点）
    // 我们重写为：单击节点文本 → 选中；点击 circle → 仍走默认折叠
    return mm;
}

/**
 * 把当前业务树渲染到 markmap。
 * @param {object} opts
 * @param {boolean} opts.keepView 是否保留当前缩放/平移视图；false 则 fit
 */
async function renderMarkmap(opts) {
    if (!treeRoot) {
        if (emptyEl) emptyEl.textContent = '暂无内容';
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    const m = ensureMarkmap();
    if (!m) {
        if (emptyEl) {
            emptyEl.textContent = '思维导图依赖加载失败';
            emptyEl.classList.remove('hidden');
        }
        return;
    }
    const data = toPureNode(treeRoot);
    await m.setData(data);
    if (!opts || !opts.keepView) {
        await m.fit();
    }
    // 渲染后重建节点交互层
    bindNodeInteractions();
    refreshSelection();
    setStatus(`节点数：${countNodes(treeRoot)}`);
}

// ============ SVG 节点交互层 ============
/**
 * markmap 渲染出的 SVG 结构：
 *   <g class="markmap-node" data-path="0.1.2">
 *     <line ... />                                     节点下划线
 *     <circle class="markmap-fold" ... />              折叠按钮（仅有子节点时）
 *     <foreignObject><div class="markmap-foreign">HTML 内容</div></foreignObject>
 *   </g>
 *
 * 我们在 <g.markmap-node> 上挂 click/dblclick/contextmenu，并把 d3 数据上的
 * payload.mmId 当作节点身份识别。
 */
function bindNodeInteractions() {
    const nodes = svgEl.querySelectorAll('g.markmap-node');
    nodes.forEach(g => {
        const datum = g.__data__;
        const mmId = datum && datum.payload && datum.payload.mmId;
        if (!mmId) return;
        g.dataset.mmid = mmId;
        // 把深度写到 dataset 上，供 CSS 按层级染色（根=0/一级=1/二级=2...）
        const depth = (datum && datum.state && typeof datum.state.depth === 'number') ? datum.state.depth : 0;
        g.dataset.depth = String(depth);
        // 单节点宽度覆写：找到内层 div，用 inline style 设置 CSS 变量（仅对该节点生效，外层继承）
        const ovw = nodeWidthOverrides[mmId];
        const innerForWidth = g.querySelector('foreignObject > div > div');
        if (innerForWidth) {
            if (ovw && Number.isFinite(ovw)) {
                innerForWidth.style.setProperty('--mm-node-max-width', ovw + 'px');
                // 外层 div 也要受同样上限限制（CSS 已在 .markmap-foreign > div 用 var）
                const outer = g.querySelector('foreignObject > div');
                if (outer) outer.style.setProperty('--mm-node-max-width', ovw + 'px');
            } else {
                innerForWidth.style.removeProperty('--mm-node-max-width');
                const outer = g.querySelector('foreignObject > div');
                if (outer) outer.style.removeProperty('--mm-node-max-width');
            }
        }
        // 把节点色写到 style.color，让 foreignObject 内 div 的 currentColor 引用到（胶囊边框/根节点背景等）
        const palette = (document.body.dataset.theme === 'dark')
            ? ['#60a5fa', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#2dd4bf', '#f87171']
            : ['#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444'];
        g.style.color = palette[depth % palette.length];

        // 文本区（foreignObject 中的 div）
        const fo = g.querySelector('foreignObject');
        const inner = fo ? fo.firstElementChild : null;
        if (inner) {
            // 单击选中
            inner.onclick = (e) => {
                e.stopPropagation();
                if (isEditingNode) return;
                selectNode(mmId);
                hideContextMenu();
            };
            // 双击编辑
            inner.ondblclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                startEdit(mmId);
            };
            // 右键菜单
            inner.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectNode(mmId);
                showContextMenu(e.clientX, e.clientY, mmId);
            };
            // 拖拽源
            inner.draggable = true;
            inner.ondragstart = (e) => {
                if (isEditingNode) { e.preventDefault(); return; }
                dragSourceId = mmId;
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', mmId); } catch (_) {}
            };
            inner.ondragend = () => {
                dragSourceId = null;
                document.querySelectorAll('g.markmap-node.mm-drop-target')
                    .forEach(el => el.classList.remove('mm-drop-target'));
            };
            inner.ondragover = (e) => {
                if (!dragSourceId || dragSourceId === mmId) return;
                const src = findNode(treeRoot, dragSourceId);
                if (src && isAncestor(src.node, mmId)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                g.classList.add('mm-drop-target');
            };
            inner.ondragleave = () => {
                g.classList.remove('mm-drop-target');
            };
            inner.ondrop = (e) => {
                e.preventDefault();
                g.classList.remove('mm-drop-target');
                if (!dragSourceId || dragSourceId === mmId) return;
                const src = findNode(treeRoot, dragSourceId);
                if (!src || !src.parent) return; // 根节点不能拖
                if (isAncestor(src.node, mmId)) return;
                const tgt = findNode(treeRoot, mmId);
                if (!tgt) return;
                src.parent.children.splice(src.index, 1);
                tgt.node.children = tgt.node.children || [];
                tgt.node.children.push(src.node);
                pendingFold.delete(mmId); // 目标默认展开
                renderMarkmap({ keepView: true });
                pushUpdate();
            };
        }

        // 折叠态变化：监听 markmap 的 circle 点击，把 fold 同步到 pendingFold
        const circle = g.querySelector('circle.markmap-fold');
        if (circle) {
            circle.addEventListener('click', () => {
                // 让 markmap 内部处理后再读 payload.fold
                setTimeout(() => {
                    const fold = (datum.payload && datum.payload.fold) ? 1 : 0;
                    if (fold) pendingFold.set(mmId, 1);
                    else pendingFold.delete(mmId);
                }, 0);
            }, { capture: true });
        }
    });
}

/** 把当前 selectedId 应用到 SVG 节点的 class */
function refreshSelection() {
    svgEl.querySelectorAll('g.markmap-node.mm-selected')
        .forEach(el => el.classList.remove('mm-selected'));
    if (!selectedId) { hideActionsOverlay(); hideResizeHandle(); return; }
    const g = svgEl.querySelector(`g.markmap-node[data-mmid="${cssEscape(selectedId)}"]`);
    if (g) {
        g.classList.add('mm-selected');
        showActionsOverlay(g, selectedId);
        showResizeHandle(g, selectedId);
    } else {
        hideActionsOverlay();
        hideResizeHandle();
    }
}

function cssEscape(s) {
    return String(s).replace(/[^\w-]/g, ch => '\\' + ch);
}

function selectNode(id) {
    selectedId = id;
    refreshSelection();
}

// ============ 节点编辑（contentEditable on foreignObject div） ============
function startEdit(id) {
    selectNode(id);
    const g = svgEl.querySelector(`g.markmap-node[data-mmid="${cssEscape(id)}"]`);
    if (!g) return;
    const fo = g.querySelector('foreignObject');
    if (!fo) return;
    const inner = fo.firstElementChild;
    if (!inner) return;

    // 隐藏悬浮按钮，避免遮挡编辑
    hideActionsOverlay();

    isEditingNode = true;
    inner.setAttribute('contenteditable', 'true');
    // 清空 HTML，仅保留纯文本，避免编辑时的样式干扰
    const r = findNode(treeRoot, id);
    inner.textContent = (r && r.node.title) || '';
    inner.focus();
    const range = document.createRange();
    range.selectNodeContents(inner);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = (commit) => {
        if (!isEditingNode) return;
        isEditingNode = false;
        inner.removeAttribute('contenteditable');
        inner.removeEventListener('blur', onBlur);
        inner.removeEventListener('keydown', onKey);
        const rr = findNode(treeRoot, id);
        if (!rr) return;
        const newText = (inner.textContent || '').replace(/\s+/g, ' ').trim();
        if (commit && newText && newText !== rr.node.title) {
            rr.node.title = newText;
            renderMarkmap({ keepView: true });
            pushUpdate();
        } else {
            // 回滚显示
            renderMarkmap({ keepView: true });
        }
    };
    const onBlur = () => finish(true);
    const onKey = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else { e.stopPropagation(); /* 编辑中阻止全局快捷键 */ }
    };
    inner.addEventListener('blur', onBlur);
    inner.addEventListener('keydown', onKey);
}

// ============ 节点宽度调整把手（选中节点右下角） ============
let resizeHandleEl = null;
let resizeMaskEl = null;
let isResizingNode = false; // 拖拽中标记：renderMarkmap 后的 refreshSelection 不重建把手
function hideResizeHandle() {
    if (resizeHandleEl) { resizeHandleEl.remove(); resizeHandleEl = null; }
    if (resizeMaskEl) { resizeMaskEl.remove(); resizeMaskEl = null; }
}
function showResizeHandle(g, id) {
    // 拖拽中：重新走 renderMarkmap 后，不重建把手 DOM（避免中断拖拽上下文）；
    // 仅重定位现有把手，跟随节点新位置。
    if (isResizingNode && resizeHandleEl) {
        const fo2 = g.querySelector('foreignObject');
        if (fo2) {
            const r2 = fo2.getBoundingClientRect();
            const c2 = canvas.getBoundingClientRect();
            resizeHandleEl.style.left = (r2.right - c2.left - 7) + 'px';
            resizeHandleEl.style.top  = (r2.bottom - c2.top  - 7) + 'px';
        }
        return;
    }
    hideResizeHandle();
    if (isEditingNode) return;
    const fo = g.querySelector('foreignObject');
    if (!fo) return;
    const foRect = fo.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const handle = document.createElement('div');
    handle.className = 'mm-resize-handle';
    handle.title = '拖拽调整该节点宽度（双击重置）';
    handle.textContent = '↔';
    // 放在节点框右下角
    handle.style.left = (foRect.right - canvasRect.left - 7) + 'px';
    handle.style.top  = (foRect.bottom - canvasRect.top  - 7) + 'px';
    canvas.appendChild(handle);
    resizeHandleEl = handle;

    // 双击重置该节点宽度
    handle.addEventListener('dblclick', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (nodeWidthOverrides[id] !== undefined) {
            delete nodeWidthOverrides[id];
            saveNodeWidths();
            renderMarkmap({ keepView: true });
            setStatus('已重置该节点宽度');
        }
    // 拖拽
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        isResizingNode = true;
        const startX = e.clientX;
        // 当前生效的 max-width：覆写值优先，否则全局
        const currentW = (nodeWidthOverrides[id] && Number.isFinite(nodeWidthOverrides[id]))
            ? nodeWidthOverrides[id] : nodeStyle.maxWidth;
        // d3-zoom 当前缩放因子：用 mm.state.scale；兜底用 svg 的 CTM
        let scale = 1;
        try {
            if (mm && mm.state && typeof mm.state.scale === 'number') scale = mm.state.scale || 1;
            else {
                const m = svgEl.querySelector('g.markmap');
                if (m && m.transform && m.transform.baseVal && m.transform.baseVal.consolidate) {
                    const c = m.transform.baseVal.consolidate();
                    if (c && c.matrix) scale = c.matrix.a || 1;
                }
            }
        } catch (_) { scale = 1; }
        if (!scale || !Number.isFinite(scale)) scale = 1;

        // 加蒙层避免触发其它节点 hover/拖父子
        const mask = document.createElement('div');
        mask.className = 'mm-resize-mask';
        canvas.appendChild(mask);
        resizeMaskEl = mask;
        handle.classList.add('dragging');

        let lastApplied = currentW;
        let rafId = 0;
        const onMove = (ev) => {
            const dxScreen = ev.clientX - startX;
            const dxUser = dxScreen / scale;
            let w = Math.round(currentW + dxUser);
            if (w < 120) w = 120;
            if (w > 1600) w = 1600;
            if (w === lastApplied) return;
            lastApplied = w;
            nodeWidthOverrides[id] = w;
            // 用 rAF 节流：拖拽过程中频繁 setData 可能掉帧
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                renderMarkmap({ keepView: true });
                setStatus(`节点宽度：${w}px（拖动调整中）`);
            });
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            isResizingNode = false;
            handle.classList.remove('dragging');
            if (resizeMaskEl) { resizeMaskEl.remove(); resizeMaskEl = null; }
            saveNodeWidths();
            // 收尾再渲一次确保最终态
            renderMarkmap({ keepView: true });
            setStatus(`节点宽度：${lastApplied}px`);
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
    });
}

// ============ 悬浮操作按钮浮层 ============
let actionsOverlay = null;
function hideActionsOverlay() {
    if (actionsOverlay) {
        actionsOverlay.remove();
        actionsOverlay = null;
    }
}
function showActionsOverlay(g, id) {
    hideActionsOverlay();
    const r = findNode(treeRoot, id);
    if (!r) return;
    const isRoot = !r.parent;
    const fo = g.querySelector('foreignObject');
    if (!fo) return;
    // 用 getBoundingClientRect 自然带上当前 d3-zoom 的 transform，无需手算
    const foRect = fo.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    const overlay = document.createElement('div');
    overlay.className = 'mm-actions-overlay';
    const mkAct = (label, title, handler, danger) => {
        const b = document.createElement('button');
        b.className = 'mm-act' + (danger ? ' danger' : '');
        b.textContent = label;
        b.title = title;
        b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        b.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
        return b;
    };
    overlay.appendChild(mkAct('+', '添加子节点 (Tab)', () => addChild(id)));
    if (!isRoot) overlay.appendChild(mkAct('↳', '添加同级 (Enter)', () => addSibling(id)));
    overlay.appendChild(mkAct('✎', '重命名 (F2)', () => startEdit(id)));
    if (!isRoot) overlay.appendChild(mkAct('✕', '删除 (Del)', () => deleteNode(id), true));

    canvas.appendChild(overlay);
    // 位置：节点右上方
    const overlayRect = overlay.getBoundingClientRect();
    let left = foRect.right - canvasRect.left + 6;
    let top  = foRect.top   - canvasRect.top  - overlayRect.height - 4;
    // 若上方溢出（节点贴近顶部），改放节点下方
    if (top < 4) top = foRect.bottom - canvasRect.top + 4;
    // 若右侧溢出，改放节点上方靠右对齐
    if (left + overlayRect.width > canvasRect.width - 4) {
        left = foRect.right - canvasRect.left - overlayRect.width;
    }
    overlay.style.left = Math.max(4, left) + 'px';
    overlay.style.top  = Math.max(4, top)  + 'px';
    actionsOverlay = overlay;
}

// ============ 节点操作 ============
function addChild(parentId) {
    const r = findNode(treeRoot, parentId);
    if (!r) return;
    const newNode = { id: genId(), title: '新节点', kind: 'heading', children: [] };
    r.node.children = r.node.children || [];
    r.node.children.push(newNode);
    pendingFold.delete(parentId);
    renderMarkmap({ keepView: true });
    selectNode(newNode.id);
    startEdit(newNode.id);
    pushUpdate();
}
function addSibling(targetId) {
    const r = findNode(treeRoot, targetId);
    if (!r || !r.parent) { addChild(targetId); return; }
    const newNode = { id: genId(), title: '新节点', kind: r.node.kind || 'heading', children: [] };
    r.parent.children.splice(r.index + 1, 0, newNode);
    renderMarkmap({ keepView: true });
    selectNode(newNode.id);
    startEdit(newNode.id);
    pushUpdate();
}
function deleteNode(id) {
    const r = findNode(treeRoot, id);
    if (!r) return;
    if (!r.parent) { setStatus('根节点不能删除'); return; }
    r.parent.children.splice(r.index, 1);
    pendingFold.delete(id);
    // 同步清理被删除子树的宽度覆写
    const collectIds = (n, out) => { out.add(n.id); (n.children || []).forEach(c => collectIds(c, out)); };
    const removed = new Set();
    collectIds(r.node, removed);
    let widthChanged = false;
    for (const k of Object.keys(nodeWidthOverrides)) {
        if (removed.has(k)) { delete nodeWidthOverrides[k]; widthChanged = true; }
    }
    if (widthChanged) saveNodeWidths();
    selectedId = r.parent.id;
    renderMarkmap({ keepView: true });
    pushUpdate();
}
/** 重置某节点的宽度覆写，回到全局默认 */
function resetNodeWidth(id) {
    if (nodeWidthOverrides[id] !== undefined) {
        delete nodeWidthOverrides[id];
        saveNodeWidths();
        renderMarkmap({ keepView: true });
        setStatus('已重置该节点宽度');
    } else {
        setStatus('该节点未单独设置宽度');
    }
}

// ============ 工具栏按钮 ============
$('btnAddRoot').addEventListener('click', () => { if (selectedId) addChild(selectedId); });
$('btnAddSibling').addEventListener('click', () => { if (selectedId) addSibling(selectedId); });
$('btnDelete').addEventListener('click', () => { if (selectedId) deleteNode(selectedId); });
$('btnExpandAll').addEventListener('click', () => {
    pendingFold.clear();
    renderMarkmap({ keepView: false });
});
$('btnCollapseAll').addEventListener('click', () => {
    pendingFold.clear();
    const collect = (n) => {
        if (n.children && n.children.length) {
            pendingFold.set(n.id, 1);
            n.children.forEach(collect);
        }
    };
    if (treeRoot) (treeRoot.children || []).forEach(collect);
    renderMarkmap({ keepView: false });
});
$('btnFit').addEventListener('click', () => { if (mm) mm.fit(); });
$('btnTheme').addEventListener('click', toggleTheme);

// ============ 样式调节面板 ============
const stylePanel = $('mmStylePanel');
const cfgBorder = $('mmCfgBorder');
const cfgBorderW = $('mmCfgBorderWidth');
const cfgPadX = $('mmCfgPaddingX');
const cfgPadY = $('mmCfgPaddingY');
const cfgRadius = $('mmCfgRadius');
const cfgMaxWidth = $('mmCfgMaxWidth');
/** 把当前 nodeStyle 同步到面板控件 */
function syncStylePanelUI() {
    cfgBorder.checked = !!nodeStyle.border;
    cfgBorderW.value = String(nodeStyle.borderWidth);
    cfgPadX.value = String(nodeStyle.paddingX);
    cfgPadY.value = String(nodeStyle.paddingY);
    cfgRadius.value = String(nodeStyle.radius);
    cfgMaxWidth.value = String(nodeStyle.maxWidth);
    $('mmCfgBorderWidthVal').textContent = nodeStyle.borderWidth + 'px';
    $('mmCfgPaddingXVal').textContent = nodeStyle.paddingX + 'px';
    $('mmCfgPaddingYVal').textContent = nodeStyle.paddingY + 'px';
    $('mmCfgRadiusVal').textContent = nodeStyle.radius + 'px';
    $('mmCfgMaxWidthVal').textContent = nodeStyle.maxWidth + 'px';
    cfgBorderW.disabled = !nodeStyle.border;
}
$('btnStyle').addEventListener('click', () => {
    stylePanel.classList.toggle('hidden');
    if (!stylePanel.classList.contains('hidden')) syncStylePanelUI();
});
$('mmCfgClose').addEventListener('click', () => stylePanel.classList.add('hidden'));
$('mmCfgReset').addEventListener('click', () => {
    nodeStyle = { ...NODE_STYLE_DEFAULT };
    saveNodeStyle();
    syncStylePanelUI();
    applyNodeStyle(true);
    setStatus('已恢复默认节点样式');
});
// 边框开关：仅控制显隐，不改变节点尺寸 → 不需要 relayout
cfgBorder.addEventListener('change', () => {
    nodeStyle.border = cfgBorder.checked;
    cfgBorderW.disabled = !nodeStyle.border;
    saveNodeStyle();
    applyNodeStyle(false);
});
// 边框粗细：box-shadow inset 不占空间 → 不需要 relayout
cfgBorderW.addEventListener('input', () => {
    nodeStyle.borderWidth = parseFloat(cfgBorderW.value);
    $('mmCfgBorderWidthVal').textContent = nodeStyle.borderWidth + 'px';
    saveNodeStyle();
    applyNodeStyle(false);
});
// padding：会改变节点宽高 → 必须 relayout
cfgPadX.addEventListener('input', () => {
    nodeStyle.paddingX = parseInt(cfgPadX.value, 10);
    $('mmCfgPaddingXVal').textContent = nodeStyle.paddingX + 'px';
    saveNodeStyle();
    applyNodeStyle(true);
});
cfgPadY.addEventListener('input', () => {
    nodeStyle.paddingY = parseInt(cfgPadY.value, 10);
    $('mmCfgPaddingYVal').textContent = nodeStyle.paddingY + 'px';
    saveNodeStyle();
    applyNodeStyle(true);
});
// 圆角：不影响尺寸
cfgRadius.addEventListener('input', () => {
    nodeStyle.radius = parseInt(cfgRadius.value, 10);
    $('mmCfgRadiusVal').textContent = nodeStyle.radius + 'px';
    saveNodeStyle();
    applyNodeStyle(false);
});
// 全局最大宽度：决定换行点 → 必须 relayout
cfgMaxWidth.addEventListener('input', () => {
    nodeStyle.maxWidth = parseInt(cfgMaxWidth.value, 10);
    $('mmCfgMaxWidthVal').textContent = nodeStyle.maxWidth + 'px';
    saveNodeStyle();
    applyNodeStyle(true);
});
$('btnExportXmind').addEventListener('click', () => {
    vscode.postMessage({ type: 'exportXmind' });
});
$('btnOpenText').addEventListener('click', () => {
    vscode.postMessage({ type: 'openWithText' });
});

// 初始化主题与节点样式
applyTheme(safeGet(LS_THEME) || 'light');
applyNodeStyle(false);   // 首次加载：写入 CSS 变量；不 relayout（此时 mm 尚未渲染）

// ============ 全局键盘 ============
document.addEventListener('keydown', (e) => {
    if (isEditingNode) return; // 编辑态由 onKey 接管
    if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (mm) mm.fit();
        return;
    }
    if (!selectedId) return;
    if (e.key === 'Tab') { e.preventDefault(); addChild(selectedId); }
    else if (e.key === 'Enter') { e.preventDefault(); addSibling(selectedId); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteNode(selectedId); }
    else if (e.key === 'F2') { e.preventDefault(); startEdit(selectedId); }
});

// 点击空白：取消选中、关闭菜单
canvas.addEventListener('mousedown', (e) => {
    if (e.target === canvas || e.target === svgEl || e.target === emptyEl) {
        selectedId = null;
        refreshSelection();
        hideContextMenu();
    }
});
window.addEventListener('scroll', () => hideContextMenu(), true);
window.addEventListener('resize', () => {
    hideContextMenu();
    if (selectedId) refreshSelection(); // 重新定位浮层
});

// ============ 右键上下文菜单 ============
let contextMenuEl = null;
function hideContextMenu() {
    if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
}
function showContextMenu(x, y, nodeId) {
    hideContextMenu();
    const r = findNode(treeRoot, nodeId);
    if (!r) return;
    const isRoot = !r.parent;
    const items = [
        { label: '添加子节点', shortcut: 'Tab', action: () => addChild(nodeId) },
        { label: '添加同级节点', shortcut: 'Enter', disabled: isRoot, action: () => addSibling(nodeId) },
        { label: '重命名', shortcut: 'F2', action: () => startEdit(nodeId) },
        { sep: true },
        { label: '重置节点宽度', disabled: nodeWidthOverrides[nodeId] === undefined, action: () => resetNodeWidth(nodeId) },
        { sep: true },
        { label: '删除节点', shortcut: 'Del', disabled: isRoot, danger: true, action: () => deleteNode(nodeId) },
        { sep: true },
        { label: '全部展开', action: () => { pendingFold.clear(); renderMarkmap({ keepView: false }); } },
        { label: '全部折叠', action: () => {
            pendingFold.clear();
            const collect = (n) => {
                if (n.children && n.children.length) {
                    pendingFold.set(n.id, 1); n.children.forEach(collect);
                }
            };
            if (treeRoot) (treeRoot.children || []).forEach(collect);
            renderMarkmap({ keepView: false });
        } },
        { label: '适应视口', shortcut: '⌘0', action: () => { if (mm) mm.fit(); } },
    ];
    const menu = document.createElement('div');
    menu.className = 'mm-context-menu';
    items.forEach(it => {
        if (it.sep) {
            const s = document.createElement('div'); s.className = 'mm-cm-sep';
            menu.appendChild(s); return;
        }
        const row = document.createElement('div');
        row.className = 'mm-cm-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '');
        const lab = document.createElement('span'); lab.textContent = it.label;
        row.appendChild(lab);
        if (it.shortcut) {
            const sc = document.createElement('span');
            sc.className = 'mm-cm-shortcut'; sc.textContent = it.shortcut;
            row.appendChild(sc);
        }
        if (!it.disabled) {
            row.addEventListener('click', (e) => { e.stopPropagation(); hideContextMenu(); it.action(); });
        }
        menu.appendChild(row);
    });
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let nx = x, ny = y;
    if (x + rect.width > vw - 4) nx = vw - rect.width - 4;
    if (y + rect.height > vh - 4) ny = vh - rect.height - 4;
    menu.style.left = nx + 'px';
    menu.style.top = ny + 'px';
    contextMenuEl = menu;
    setTimeout(() => { document.addEventListener('mousedown', onceClose, true); }, 0);
}
function onceClose(e) {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) {
        hideContextMenu();
        document.removeEventListener('mousedown', onceClose, true);
    }
}

// ============ 处理扩展端消息 ============
window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
        case 'init': {
            treeRoot = msg.tree;
            // 兜底：兼容服务端可能未携带 id 的情况
            const ensureId = (n) => { if (!n.id) n.id = genId(); (n.children || []).forEach(ensureId); };
            if (treeRoot) ensureId(treeRoot);
            if (msg.fileName) {
                fileNameEl.textContent = msg.fileName;
                // 切换文件 → 重新加载该文件的单节点宽度覆写
                if (currentFileName !== msg.fileName) {
                    currentFileName = msg.fileName;
                    loadNodeWidths();
                }
            }
            // 外部修改时清理已不存在的折叠态
            const existIds = new Set();
            const walk = (n) => { existIds.add(n.id); (n.children || []).forEach(walk); };
            if (treeRoot) walk(treeRoot);
            for (const k of Array.from(pendingFold.keys())) {
                if (!existIds.has(k)) pendingFold.delete(k);
            }
            // 选中根节点便于直接 Tab 加子节点
            if (!selectedId || !existIds.has(selectedId)) {
                selectedId = treeRoot ? treeRoot.id : null;
            }
            renderMarkmap({ keepView: msg.reason === 'docChange' });
            setStatus(msg.reason === 'ready' ? '已加载' : '已同步外部修改');
            break;
        }
        case 'parseError': {
            if (emptyEl) {
                emptyEl.textContent = `解析 Markdown 失败：${msg.message || ''}`;
                emptyEl.classList.remove('hidden');
            }
            setStatus('解析失败');
            break;
        }
        case 'exportXmindResult': {
            if (msg.ok) setStatus(`已导出：${msg.fsPath}`);
            else if (msg.canceled) setStatus('已取消导出');
            else setStatus(`导出失败：${msg.message || ''}`);
            break;
        }
    }
});

// ============ 启动 ============
vscode.postMessage({ type: 'ready' });
console.log('[Mindmap] webview 启动（markmap-view 渲染）');