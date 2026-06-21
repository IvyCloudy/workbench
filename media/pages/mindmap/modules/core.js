// ============================================================================
// modules/core.js
// ----------------------------------------------------------------------------
// 渲染核心：simpleMindMap 实例的初始化 / 更新；与扩展端的数据同步（防抖回写）。
// ============================================================================

import { ctx, vscode, $, setStatus, getLayout, getTheme } from './ctx.js';
import { SMM_ICON_LIST } from '../icons.js';
import {
    mindmapNodeToSmm, smmToMindmapNode,
    reapplyPendingNodeStyles, collectNodeStyles,
} from './adapter.js';
import { openLightbox } from './assets.js';
import { showLinkPopup } from './popups.js';
import { saveNodeStylesMap } from './ctx.js';
import { syncEmojiPanelForNode, closeEmojiPanel } from './toolbar.js';

// ------------------------------------------------------------------
// 渲染：初始化 / 重建
// ------------------------------------------------------------------
export async function initOrUpdate(tree, fileName, filePath) {
    ctx.currentFileName = fileName || '';
    if (typeof filePath === 'string') ctx.currentFilePath = filePath;
    const fnEl = $('mmFileName');
    if (fnEl) {
        fnEl.textContent = ctx.currentFileName;
        // hover 时显示完整 fsPath（如果扩展端没传则退回文件名）
        const tip = ctx.currentFilePath || ctx.currentFileName;
        if (tip) fnEl.setAttribute('title', tip);
    }

    const smmData = await mindmapNodeToSmm(tree);

    if (!ctx.mm) {
        const Ctor = (window.simpleMindMap && window.simpleMindMap.default) || window.simpleMindMap;
        if (!Ctor) {
            $('mmEmpty').textContent = 'simple-mind-map 未加载，请重启编辑器';
            return;
        }
        const layout = getLayout();
        const theme = getTheme();
        const $sel = $('mmLayoutSel'); if ($sel) $sel.value = layout;
        const $tsel = $('mmThemeSel'); if ($tsel) $tsel.value = theme;

        const mm = new Ctor({
            el: $('mmContainer'),
            data: smmData,
            layout,
            theme,
            fit: true,
            mousewheelAction: 'zoom',
            mouseScaleCenterUseMousePosition: true,
            enableFreeDrag: false,
            initRootNodePosition: ['center', 'center'],
            // 自定义链接跳转：阻止默认 a target=_blank（webview 中会被拦截），改走 VS Code 外部打开
            customHyperlinkJump: (url, node) => {
                try {
                    const d = (node && node.nodeData && node.nodeData.data) || {};
                    const raw = d.mmHyperlinkRaw || url;
                    // 优先尝试用 popup 让用户选 Open / Copy / Edit / Delete
                    let anchor = null;
                    try {
                        const el = node && node._hyperlinkData && node._hyperlinkData.node && node._hyperlinkData.node.node;
                        if (el && el.getBoundingClientRect) anchor = el.getBoundingClientRect();
                    } catch (_) {}
                    showLinkPopup(node, raw, anchor);
                } catch (_) {
                    try { vscode.postMessage({ type: 'openExternal', target: url }); } catch (_) {}
                }
            },
            // 注册自定义彩色 SVG 图标库（与 ProcessOn 风格一致）
            iconList: SMM_ICON_LIST,
            // 开启富文本：仅用于激活引擎内置的【横向拖动改宽度】手柄
            // （引擎要求 richText:true 时 customTextWidth 才会生效）。
            // 副作用：data.text 变成 HTML，需要在出入口做 HTML↔纯文本互转，
            // 见 htmlToPlain / plainToHtml。
            richText: true,
            enableDragModifyNodeWidth: true,
            minNodeTextModifyWidth: 60,
            maxNodeTextModifyWidth: 1200,
        });
        ctx.mm = mm;
        // 暴露到 window，供独立模块（如节点 resize 手柄）使用
        try { window.mm = mm; } catch (_) {}

        // 节点数据变化 → 防抖回写 md
        mm.on('data_change', () => {
            if (ctx.suppressNextChange) {
                ctx.suppressNextChange = false;
                return;
            }
            scheduleSyncToExtension();
        });

        // 拖宽手柄结束后：强制让被拖动节点重新测量富文本高度，避免内容较多时下半截被裁切。
        // 引擎在 m5() 里只调用了 mindMap.render()，但 richText 节点的 _textData 缓存可能未失效，
        // 节点 shape 高度按旧的 textContentHeight 计算 → 文字溢出。
        // 通过 renderer.setNodeData 写入 resetRichText 标志位，引擎会在下一次 reRender 时
        // 走完整的富文本测量分支，重算 width/height。
        mm.on('dragModifyNodeWidthEnd', (node) => {
            if (!node) return;
            try {
                ctx.suppressNextChange = true; // 仅尺寸刷新，不需要回写 md
                mm.renderer.setNodeData(node, { resetRichText: true, needUpdate: true });
                mm.render();
            } catch (_) {}
        });

        // 节点选中状态（仅状态栏提示，便于排查）
        mm.on('node_active', (_node, list) => {
            if (list && list.length) {
                setStatus(`已选中 ${list.length} 个节点`);
            } else {
                setStatus('就绪');
            }
            // 图标面板联动：
            //  - 单选有图标的节点 → 切到该节点并重新渲染高亮，便于直接删除；
            //  - 单选无图标 / 多选 / 取消选中 → 自动关闭面板，避免误操作到旧节点。
            try {
                if (list && list.length === 1) {
                    syncEmojiPanelForNode(list[0]);
                } else {
                    closeEmojiPanel();
                }
            } catch (_) {}
        });

        // 节点点击：附件 / 链接图标的兜底（主要路径由 customHyperlinkJump 与 node_attachmentClick 处理）
        mm.on('node_click', (node, e) => {
            const d = node && node.nodeData && node.nodeData.data;
            if (!d) return;
            const target = e && e.target;
            if (!target) return;
            // 兼容旧的 DOM 探测（部分版本 simple-mind-map 节点链接图标用 .smm-hyperlink-box）
            const isLink = target.closest && target.closest('.smm-hyperlink-box, [class*="hyperlink"]');
            if (isLink && (d.mmHyperlinkRaw || d.hyperlink)) {
                try { e.preventDefault && e.preventDefault(); } catch (_) {}
                try { e.stopPropagation && e.stopPropagation(); } catch (_) {}
                let anchorRect = null;
                try {
                    const linkEl = target.closest('.smm-hyperlink-box') || target;
                    if (linkEl && linkEl.getBoundingClientRect) {
                        anchorRect = linkEl.getBoundingClientRect();
                    }
                } catch (_) {}
                if (!anchorRect && e && (e.clientX || e.clientY)) {
                    anchorRect = { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 };
                }
                showLinkPopup(node, d.mmHyperlinkRaw || d.hyperlink, anchorRect);
            }
        });

        // 附件图标点击：simple-mind-map 通过 node_attachmentClick 事件抛出
        mm.on('node_attachmentClick', (node, e, btnEl) => {
            try { e && e.preventDefault && e.preventDefault(); } catch (_) {}
            try { e && e.stopPropagation && e.stopPropagation(); } catch (_) {}
            const d = (node && node.nodeData && node.nodeData.data) || {};
            const url = d.mmAttachmentRaw || d.attachmentUrl;
            if (!url) return;
            let anchorRect = null;
            try {
                const el = btnEl && btnEl.node;
                if (el && el.getBoundingClientRect) anchorRect = el.getBoundingClientRect();
            } catch (_) {}
            if (!anchorRect && e && (e.clientX || e.clientY)) {
                anchorRect = { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 };
            }
            showLinkPopup(node, url, anchorRect);
        });

        // 节点图片点击：simple-mind-map 通过 node_img_click 事件抛出
        // 走自定义 Lightbox 放大预览。必须阻止事件冒泡，否则会冒泡到 node_click，
        // 引擎随即切换节点激活态 / 重绘，导致 lightbox 才显示就被外层 click 重新触发隐藏，
        // 表现为"原窗口闪一下"。
        mm.on('node_img_click', (node, _imgEl, e) => {
            try { e && e.preventDefault && e.preventDefault(); } catch (_) {}
            try { e && e.stopPropagation && e.stopPropagation(); } catch (_) {}
            try { e && e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch (_) {}
            const d = (node && node.nodeData && node.nodeData.data) || {};
            // 优先用引擎渲染时使用的 webview URI（d.image），失败再降级 raw 相对路径
            const url = d.image || d.mmImageRaw || '';
            if (!url) return;
            openLightbox(url, d.imageTitle || '', node);
        });

        $('mmEmpty').classList.add('hidden');

        // 诊断：监听 svg <image> 元素加载失败，避免"破图"无声出现
        try {
            if (!window.__mmImgDiagBound) {
                window.__mmImgDiagBound = true;
                const container = $('mmContainer');
                if (container) {
                    const onErr = (ev) => {
                        const el = ev && ev.target;
                        if (!el) return;
                        const tag = (el.tagName || '').toLowerCase();
                        if (tag !== 'image' && tag !== 'img') return;
                        const href = el.getAttribute && (el.getAttribute('href') || el.getAttribute('xlink:href') || el.getAttribute('src'));
                        const short = href ? (href.length > 80 ? href.slice(0, 80) + '…' : href) : '(空)';
                        console.warn('[mindmap] 节点图片加载失败：', short, el);
                        try { setStatus && setStatus('节点图片加载失败，请检查链接（' + short + '）'); } catch (_) {}
                    };
                    // 捕获阶段才能拿到 svg image 的 error
                    container.addEventListener('error', onErr, true);
                }
            }
        } catch (_) {}

        // mm 初始化完成后，应用"上次选择的主题"（即记忆功能）；
        // 若 LS 中无值则会落到默认值（Dynamic Contrast + d1，对应图中绿框第一个）。
        // simple-mind-map 是异步渲染，必须等首次 node_tree_render_end 触发后 renderer.root
        // 才存在，applyThemePack 内部对节点的着色才能生效；否则 simple-mind-map 自带主题
        // 后到的渲染结果会把我们的颜色覆盖（呈现为绿色 classic4 主题）。
        try {
            let _memThemeApplied = false;
            const onceFn = () => {
                if (_memThemeApplied) return;
                _memThemeApplied = true;
                try { if (mm && typeof mm.off === 'function') mm.off('node_tree_render_end', onceFn); } catch (_) {}
                try { window.__mmApplyMemorizedTheme && window.__mmApplyMemorizedTheme(); } catch (_) {}
                // 主题应用后再补涂一次保存的节点样式，确保覆盖主题色
                try { reapplyPendingNodeStyles(); } catch (_) {}
            };
            mm.on('node_tree_render_end', onceFn);
        } catch (_) {}
    } else {
        const mm = ctx.mm;
        ctx.suppressNextChange = true;
        mm.setData(smmData);
        try { mm.view.fit(); } catch (_) {}
        // setData 是同步重建数据但 render 是异步的；挂一次性钩子等渲染完再补涂
        try {
            const onceReapply = () => {
                try { if (mm && typeof mm.off === 'function') mm.off('node_tree_render_end', onceReapply); } catch (_) {}
                try { reapplyPendingNodeStyles(); } catch (_) {}
            };
            mm.on('node_tree_render_end', onceReapply);
        } catch (_) {}
    }

    // 兜底：无论首次初始化还是后续更新（docChange 外部修改 md 实时同步），
    // 都必须隐藏"加载中…"遮罩，否则用户会看到一直停在加载态。
    try { $('mmEmpty').classList.add('hidden'); } catch (_) {}
}

// data_change 回写 md（200ms 防抖）
export function scheduleSyncToExtension() {
    if (ctx.pendingUpdateTimer) clearTimeout(ctx.pendingUpdateTimer);
    ctx.pendingUpdateTimer = setTimeout(syncToExtension, 200);
}
function syncToExtension() {
    ctx.pendingUpdateTimer = null;
    if (!ctx.mm) return;
    try {
        const data = ctx.mm.getData();
        // 1) 节点样式快照 → localStorage（不进 md，仅 webview 端还原）
        try { saveNodeStylesMap(collectNodeStyles(data)); } catch (_) {}
        // 2) 结构/文本 → md
        const tree = smmToMindmapNode(data, -1);
        vscode.postMessage({ type: 'update', tree });
    } catch (err) {
        console.error('[mindmap] syncToExtension failed', err);
    }
}
