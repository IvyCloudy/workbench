// ============================================================================
// modules/ctx.js
// ----------------------------------------------------------------------------
// 拆分后各模块共享的全局状态对象 + 极少量基础工具。
//
// 设计原则：
//   - 不再用顶层 let 变量做共享（无法跨模块），统一塞到 ctx 对象里；
//     使用方读写 ctx.mm / ctx.currentFileName 即可。
//   - 仅放"几乎所有模块都会用到"的工具：$ / showFatal / setStatus / safeGet / safeSet
//     以及窗口级错误兜底（在 boot 之前就要装好）。
//   - vscode 句柄也由本模块持有并导出，避免重复 acquireVsCodeApi 抛错。
// ============================================================================

export const vscode = acquireVsCodeApi();

// ------------------------------------------------------------------
// 共享状态
// ------------------------------------------------------------------
export const ctx = {
    mm: null,                  // simpleMindMap 实例
    currentFileName: '',
    currentFilePath: '',       // 完整 fsPath，仅用于顶部文件名 tooltip 展示与拷贝
    suppressNextChange: false, // 由 init 触发的 setData 不应回写
    // 最近一次从 mindmapNodeToSmm 读出的节点样式映射，供 node_tree_render_end 钩子补涂
    _pendingNodeStylesMap: null,
    pendingUpdateTimer: null,  // data_change 防抖
    assetReqSeq: 0,
    assetWaiters: new Map(),   // requestId → Promise
    pickReqSeq: 0,
    pickWaiters: new Map(),
    saveBytesReqSeq: 0,
    saveBytesWaiters: new Map(), // requestId → resolver
};

// ------------------------------------------------------------------
// 基础工具
// ------------------------------------------------------------------
export function $(id) { return document.getElementById(id); }

// 全局错误兜底：webview 中没有 DevTools 时也能在页面上看到错误
export function showFatal(msg) {
    try {
        const el = $('mmEmpty');
        if (el) {
            el.textContent = String(msg || 'unknown error');
            el.classList.remove('hidden');
        }
    } catch (_) {}
}

window.addEventListener('error', (e) => {
    const m = (e && e.error && e.error.stack) || (e && e.message) || 'unknown error';
    console.error('[mindmap] window.error:', m);
    showFatal('脚本错误：' + m);
});
window.addEventListener('unhandledrejection', (e) => {
    const m = (e && e.reason && (e.reason.stack || e.reason.message)) || 'unhandledrejection';
    console.error('[mindmap] unhandledrejection:', m);
    showFatal('Promise 异常：' + m);
});

export function setStatus(text) { const el = $('mmStatus'); if (el) el.textContent = text; }
export function safeGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
export function safeSet(key, v) { try { localStorage.setItem(key, v); } catch (_) {} }

// ------------------------------------------------------------------
// 主题/布局（持久化）
// ------------------------------------------------------------------
export const LS_THEME = 'mm.theme.v2';
export const LS_LAYOUT = 'mm.layout.v2';
// 调色板（PALETTE_PRESETS.v）和变体（variants[].id）持久化
// 用于"每次打开样式面板时保持上次选择的主题"
export const LS_PACK = 'mm.pack.v1';
export const LS_VARIANT = 'mm.variant.v1';
export const DEFAULT_THEME = 'classic4';
export const DEFAULT_LAYOUT = 'logicalStructure';
// 默认调色板 = Dynamic Contrast；默认变体 = d1（白底 + 黑色 Central + 橙红分支，即绿框第一个）
export const DEFAULT_PACK = 'dynamic';
export const DEFAULT_VARIANT = 'd1';

export function getTheme() { return safeGet(LS_THEME) || DEFAULT_THEME; }
export function setTheme(v) { safeSet(LS_THEME, v); }
export function getLayout() { return safeGet(LS_LAYOUT) || DEFAULT_LAYOUT; }
export function setLayout(v) { safeSet(LS_LAYOUT, v); }
export function getPackId() { return safeGet(LS_PACK) || DEFAULT_PACK; }
export function setPackId(v) { if (v) safeSet(LS_PACK, v); }
export function getVariantId() { return safeGet(LS_VARIANT) || DEFAULT_VARIANT; }
export function setVariantId(v) { if (v) safeSet(LS_VARIANT, v); }

// ------------------------------------------------------------------
// 节点样式持久化（按文件 + 节点路径存到 localStorage，不污染 md）
// ------------------------------------------------------------------
// key 形式：mm.nodeStyles.v1::<文件路径>  → { "<nodePath>": { fontSize, color, ... } }
// nodePath：根 = ""，子节点 = 父path + "/" + <同级中第几个出现-纯文本title>
export const LS_NODE_STYLES_PREFIX = 'mm.nodeStyles.v1::';
// 需要持久化的节点样式字段白名单（与 resetNodeStyle 保持一致 + shape/customTextWidth）
export const NODE_STYLE_KEYS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration',
    'color', 'textAlign',
    'fillColor', 'borderColor', 'borderWidth', 'borderDashed',
    'textAutoWrapWidth', 'shape', 'customTextWidth',
];

export function nodeStylesKey() {
    // 没有文件名时退化为 default，避免 key 为空
    return LS_NODE_STYLES_PREFIX + (ctx.currentFileName || '__default__');
}
export function loadNodeStylesMap() {
    try {
        const raw = safeGet(nodeStylesKey());
        if (!raw) return {};
        const obj = JSON.parse(raw);
        return (obj && typeof obj === 'object') ? obj : {};
    } catch (_) { return {}; }
}
export function saveNodeStylesMap(map) {
    try { safeSet(nodeStylesKey(), JSON.stringify(map || {})); } catch (_) {}
}
// 计算节点身份路径：父路径 + "/" + <同级中第几个出现-纯文本title>
// 在 mindmapNodeToSmm（从 md 进来）和 collectNodeStyles（从 smm 出去）中复用
export function makeChildKey(siblingsBefore, plainTitle) {
    // 用同级中相同 plainTitle 出现的序号去重；保证节点身份在重启间一致
    let count = 0;
    for (const t of siblingsBefore) if (t === plainTitle) count++;
    return count + '-' + (plainTitle || '');
}
