// ============================================================================
// modules/toolbar.js
// ----------------------------------------------------------------------------
// 顶部工具栏 / 右侧浮动工具条 / "更多功能"浮层 + 节点插入入口（emoji/link/image/attachment）。
// 因依赖紧密、又都属于"用户主动触发的入口"，合并到同一模块。
// ============================================================================

import { ctx, vscode, $, setStatus, setLayout, setTheme } from './ctx.js';
import { ICON_GROUPS } from '../icons.js';
import { scheduleSyncToExtension } from './core.js';
import { pickFile } from './assets.js';
import { openLinkPrompt, openImagePrompt, applyAttachmentToNode } from './popups.js';
import { exportXmindUsingOfficial } from './xmind-export.js';
// 注意：openStylePanel / openLayoutPanel 在 style-panel.js 中定义；为避免循环 import，
// 这里在 main.js boot() 时通过 window.__mm 注入。
// 实际使用：bindSideRail 内直接通过 window.__mmOpenStylePanel / __mmOpenLayoutPanel 调用。

// 图标面板当前关联的节点（用于"切换选中后自动重载/关闭面板"）。
// openEmojiPanel / syncEmojiPanelForNode / closeEmojiPanel 共享此状态。
let emojiPanelNode = null;
let emojiPanelRender = null; // 由 openEmojiPanel 内部赋值，供外部刷新时复用

// ------------------------------------------------------------------
// 工具栏交互
// ------------------------------------------------------------------
export function bindToolbar() {
    $('btnAddChild').onclick = () => {
        const mm = ctx.mm;
        if (!mm) return;
        if (!mm.renderer.activeNodeList.length) {
            // 没选中：默认在根下加
            mm.renderer.activeNodeList = [mm.renderer.root];
        }
        mm.execCommand('INSERT_CHILD_NODE');
    };
    $('btnAddSibling').onclick = () => {
        const mm = ctx.mm;
        if (!mm) return;
        if (!mm.renderer.activeNodeList.length) return;
        mm.execCommand('INSERT_NODE');
    };
    $('btnDelete') && ($('btnDelete').onclick = () => {
        const mm = ctx.mm;
        if (!mm) return;
        if (!mm.renderer.activeNodeList.length) return;
        mm.execCommand('REMOVE_NODE');
    });
    $('btnExpandAll').onclick = () => ctx.mm && ctx.mm.execCommand('EXPAND_ALL');
    $('btnCollapseAll').onclick = () => ctx.mm && ctx.mm.execCommand('UNEXPAND_ALL');
    $('btnFit').onclick = () => ctx.mm && ctx.mm.view.fit();
    $('btnExportXmind').onclick = async () => {
        // 方案 D（"官方基础包 + JSZip 后处理"）：
        //   1) 先用 simple-mind-map 自带的 mm.export.xmind 生成"原生 XMind 兼容"基础包，
        //      保证 structureClass / 标题 / 图片 / 超链接 / 笔记 / labels 等都按官方写法落到 zip 中；
        //   2) 在 webview 端直接用 window.JSZip 打开这个 zip，
        //      对照 mm.getData() 增量注入每个 topic 的 style.properties / markers / 附件；
        //   3) 把样式池写到独立 styles.json（XMind ZEN 官方支持），
        //      与布局解耦，既保住配色又保住"逻辑右"等布局；
        //   4) 重新打包后通过 base64 通道发给扩展端写盘——
        //      扩展端走现有 base64 分支即可，不需要 richTree/theme/layout。
        //
        // 兜底：导出后强制 mm.render()，避免画布闪空。
        const finalizeRefresh = () => {
            try {
                const mm = ctx.mm;
                if (!mm) return;
                ctx.suppressNextChange = true;
                if (typeof mm.render === 'function') mm.render();
            } catch (e) {
                console.warn('[mindmap] post-export render failed', e);
            }
        };
        try {
            const mm = ctx.mm;
            if (!mm || typeof mm.getData !== 'function') {
                setStatus('导出失败：思维导图未就绪');
                return;
            }
            setStatus('正在生成 .xmind …');
            // 文件主名：取当前文档（去扩展名），失败回退到"思维导图"
            let baseName = '思维导图';
            try {
                const fn = ctx.currentFileName || '';
                if (fn) baseName = String(fn).replace(/\.[^.]+$/, '') || baseName;
            } catch (_) {}

            const r = await exportXmindUsingOfficial(mm, baseName);
            if (!r || !r.ok) {
                setStatus('导出失败：' + (r && r.message ? r.message : '未知错误'));
                return;
            }
            vscode.postMessage({
                type: 'exportXmind',
                name: baseName,
                base64: r.base64,
            });
        } catch (err) {
            console.error('[mindmap] exportXmind failed', err);
            setStatus('导出失败：' + (err && err.message ? err.message : err));
        } finally {
            finalizeRefresh();
        }
    };
    $('btnOpenText').onclick = () => vscode.postMessage({ type: 'openWithText' });

    // ---- 顶部 hint 图标按钮：点击 / hover 显示快捷键浮层 ----
    bindHintPopover();
    // ---- 文件名点击：复制完整路径到剪贴板 ----
    bindFileNameAction();
    // ---- 全局 Esc 兜底：关闭仍可见的小弹层（hint / lightbox / insertMenu）----
    bindGlobalEscFallback();

    const layoutSelEl = $('mmLayoutSel');
    if (layoutSelEl) {
        layoutSelEl.onchange = (e) => {
            if (!ctx.mm) return;
            const v = e.target.value;
            setLayout(v);
            ctx.mm.setLayout(v);
            setStatus(`布局：${v}`);
        };
    }
    const themeSelEl = $('mmThemeSel');
    if (themeSelEl) {
        themeSelEl.onchange = (e) => {
            if (!ctx.mm) return;
            const v = e.target.value;
            setTheme(v);
            ctx.mm.setTheme(v);
            setStatus(`主题：${v}`);
        };
    }

    // 插入下拉菜单（顶部"插入"按钮已下线，但若 DOM 仍存在则继续绑定）
    const insertBtn = $('btnInsert');
    const insertMenu = $('mmInsertMenu');
    if (insertBtn && insertMenu) {
        insertBtn.onclick = (e) => {
            e.stopPropagation();
            const r = insertBtn.getBoundingClientRect();
            insertMenu.style.left = `${r.left}px`;
            insertMenu.style.top = `${r.bottom + 4}px`;
            insertMenu.classList.toggle('hidden');
        };
        document.addEventListener('click', () => insertMenu.classList.add('hidden'));
        insertMenu.querySelectorAll('.mm-im-item').forEach(btn => {
            btn.onclick = () => {
                insertMenu.classList.add('hidden');
                const act = btn.dataset.act;
                handleInsert(act);
            };
        });
    }

    bindSideRail();
}

// ------------------------------------------------------------------
// 右侧浮动工具条（参考 ProcessOn）
// ------------------------------------------------------------------
// 6 个 rail 按钮触发的面板互斥：一次只允许一个面板显示。
// except 传入本次要保留打开的 act（'theme'|'layout'|'emoji'|'image'|'more'）；
// 'add' 不弹面板，会关闭全部。
function closeRailPanels(except) {
    const map = {
        theme: 'mmStylePanel',
        layout: 'mmLayoutPanel',
        emoji: 'mmEmojiPanel',
        image: 'mmImagePrompt',
        more: 'mmMoreFunctions',
    };
    Object.keys(map).forEach(k => {
        if (k === except) return;
        const el = document.getElementById(map[k]);
        if (el && !el.classList.contains('hidden')) {
            el.classList.add('hidden');
        }
    });
    // 同步更新 rail 按钮的激活态
    try {
        document.querySelectorAll('#mmSideRail .mm-rail-btn').forEach(b => {
            const a = b.dataset.rail;
            if (a && map[a]) {
                b.classList.toggle('is-active', a === except);
            }
        });
    } catch (_) {}
}

function bindSideRail() {
    const rail = $('mmSideRail');
    if (!rail) return;
    rail.querySelectorAll('.mm-rail-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const act = btn.dataset.rail;
            console.log('[mm][rail] click', { act, hasMM: !!ctx.mm });
            // 6 个按钮互斥：除当前要打开的面板外，关闭其它所有 rail 面板
            const PANEL_ACTS = ['theme', 'layout', 'emoji', 'image', 'more'];
            closeRailPanels(PANEL_ACTS.indexOf(act) >= 0 ? act : null);
            // theme/layout：分别打开样式面板（默认 Page Style）和独立 Layout 面板
            if (act === 'theme') {
                try { window.__mmOpenStylePanel && window.__mmOpenStylePanel('page'); } catch (_) {}
                return;
            }
            if (act === 'layout') {
                // 仅打开独立的 Layout 弹窗，不再联动打开 Page Style 面板
                try {
                    const sp = $('mmStylePanel');
                    if (sp) sp.classList.add('hidden');
                } catch (_) {}
                try { window.__mmOpenLayoutPanel && window.__mmOpenLayoutPanel(); } catch (_) {}
                return;
            }
            if (act === 'more') {
                return showMoreFunctions(btn);
            }
            if (act === 'add') {
                if (!ctx.mm) return;
                if (!ctx.mm.renderer.activeNodeList.length) {
                    ctx.mm.renderer.activeNodeList = [ctx.mm.renderer.root];
                }
                ctx.mm.execCommand('INSERT_CHILD_NODE');
                return;
            }
            // emoji / image：与"添加子节点"行为一致——未选节点时自动 fallback 到根节点，
            // 避免用户在 rail 上点了按钮却毫无反馈。
            // link / attachment：保持原有行为（强制要求先选节点）。
            if (act === 'emoji' || act === 'image') {
                if (!ctx.mm) { setStatus('思维导图尚未初始化'); return; }
                let node = getActiveNode();
                if (!node) {
                    ctx.mm.renderer.activeNodeList = [ctx.mm.renderer.root];
                    node = ctx.mm.renderer.root;
                    setStatus('未选中节点，已自动选择根节点');
                }
                handleInsert(act);
                return;
            }
            const node = getActiveNode();
            if (!node) {
                setStatus('请先选中一个节点再操作');
                return;
            }
            if (act === 'link' || act === 'attachment') {
                handleInsert(act);
            }
        });
    });

    // 由 style-panel 模块负责 bindStylePanel；这里通过 window.__mmBindStylePanel 触发。
    try { window.__mmBindStylePanel && window.__mmBindStylePanel(); } catch (_) {}
}

// ============================================================================
// More functions 浮层（右侧 rail 上"更多功能"按钮触发）
// ============================================================================
let _mmMfBound = false;

function showMoreFunctions(anchorBtn) {
    const panel = document.getElementById('mmMoreFunctions');
    if (!panel) return;
    bindMoreFunctionsOnce();
    panel.classList.remove('hidden');

    // 先以隐藏位置呈现以测量尺寸
    panel.style.left = '-9999px';
    panel.style.top = '-9999px';
    requestAnimationFrame(() => {
        const rect = panel.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left, top;
        if (anchorBtn && anchorBtn.getBoundingClientRect) {
            const btnRect = anchorBtn.getBoundingClientRect();
            // 显示在按钮左侧（rail 在右侧）
            left = btnRect.left - rect.width - 10;
            top = btnRect.top - 8;
            if (left < 8) {
                // 空间不够则改为按钮右侧
                left = btnRect.right + 10;
            }
        } else {
            left = (vw - rect.width) / 2;
            top = 100;
        }
        if (left + rect.width > vw - 8) left = vw - rect.width - 8;
        if (left < 8) left = 8;
        if (top + rect.height > vh - 8) top = vh - rect.height - 8;
        if (top < 8) top = 8;
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    });
}

function hideMoreFunctions() {
    const panel = document.getElementById('mmMoreFunctions');
    if (panel) panel.classList.add('hidden');
}

function bindMoreFunctionsOnce() {
    if (_mmMfBound) return;
    _mmMfBound = true;
    const panel = document.getElementById('mmMoreFunctions');
    if (!panel) return;

    // 按平台填充快捷键提示：Mac 用 ⌘/⌥/⇧，Windows/Linux 用 Ctrl/Alt/Shift
    try {
        const ua = (navigator.userAgent || '').toLowerCase();
        const plat = (navigator.platform || '').toLowerCase();
        const isMac = /mac|iphone|ipad|ipod/.test(plat) || /mac os x/.test(ua);
        panel.querySelectorAll('.mm-mf-key').forEach(el => {
            const txt = isMac ? (el.dataset.keyMac || '') : (el.dataset.keyWin || '');
            if (txt) el.textContent = txt;
        });
    } catch (_) {}

    // 阻止内部点击冒泡，避免外部关闭逻辑误触
    panel.addEventListener('mousedown', (e) => { e.stopPropagation(); });

    // 关闭按钮
    const closeBtn = document.getElementById('mmMfClose');
    if (closeBtn) closeBtn.addEventListener('click', hideMoreFunctions);

    // 列表项点击
    panel.querySelectorAll('.mm-mf-item').forEach(item => {
        item.addEventListener('click', () => {
            if (item.classList.contains('is-disabled')) {
                try { setStatus && setStatus('该功能敬请期待'); } catch (_) {}
                return;
            }
            const act = item.dataset.mf;
            hideMoreFunctions();
            const node = getActiveNode();
            if (!node) { setStatus('请先选中一个节点再操作'); return; }
            if (act === 'link') handleInsert('link');
            else if (act === 'attachment') handleInsert('attachment');
        });
    });

    // 点击外部 / Esc / 滚动 / resize 关闭
    document.addEventListener('mousedown', (e) => {
        const p = document.getElementById('mmMoreFunctions');
        if (!p || p.classList.contains('hidden')) return;
        // 点到 rail 的 more 按钮本身：忽略（避免立即关闭后再次打开的死循环）
        const moreBtn = document.querySelector('#mmSideRail .mm-rail-btn[data-rail="more"]');
        if (moreBtn && moreBtn.contains(e.target)) return;
        if (!p.contains(e.target)) hideMoreFunctions();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideMoreFunctions();
    });
    window.addEventListener('resize', hideMoreFunctions);
    window.addEventListener('resize', () => {
        try { window.__mmPositionLayoutPanel && window.__mmPositionLayoutPanel(); } catch (_) {}
    });
}

// ------------------------------------------------------------------
// 富元素插入
// ------------------------------------------------------------------
export function getActiveNode() {
    const mm = ctx.mm;
    if (!mm) return null;
    const list = mm.renderer.activeNodeList;
    return list && list.length ? list[0] : null;
}

async function handleInsert(act) {
    const node = getActiveNode();
    console.log('[mm][insert] handleInsert', { act, hasNode: !!node });
    if (!node) {
        setStatus('请先选中一个节点再插入');
        return;
    }
    if (act === 'emoji') {
        openEmojiPanel(node);
    } else if (act === 'link') {
        openLinkPrompt(node);
    } else if (act === 'image') {
        openImagePrompt(node);
    } else if (act === 'attachment') {
        const r = await pickFile('attachment');
        if (r && r.ok) {
            applyAttachmentToNode(node, r);
        }
    }
}

// 图标面板：渲染彩色 SVG 徽章，点击后写入 / 取消 token 到节点 data.icon[]
function openEmojiPanel(node) {
    const panel = $('mmEmojiPanel');
    const body = $('mmEmojiBody');
    const search = $('mmEmojiSearch');
    if (!panel || !body) return;

    // 切换目标节点 —— 后续所有操作都基于模块状态 emojiPanelNode
    emojiPanelNode = node || null;

    // 取当前节点已有图标集合，用于在面板里高亮 + 支持"再次点击移除"
    function currentIconSet() {
        const n = emojiPanelNode;
        const d = n && n.nodeData && n.nodeData.data;
        const arr = d && Array.isArray(d.icon) ? d.icon : [];
        return new Set(arr);
    }

    function makeCell(item, type) {
        const token = `${type}_${item.name}`;
        const b = document.createElement('button');
        b.className = 'mm-emoji-cell';
        b.title = token;
        b.dataset.token = token;
        b.innerHTML = item.icon; // SVG 字符串
        if (currentIconSet().has(token)) b.classList.add('is-on');
        b.onclick = () => {
            const target = emojiPanelNode;
            if (!target) return;
            const removed = applyIconToNode(target, token);
            // 同步面板上同 token 单元格的选中状态，保持面板打开以便连续多选 / 取消
            body.querySelectorAll(`.mm-emoji-cell[data-token="${token}"]`).forEach(el => {
                el.classList.toggle('is-on', !removed);
            });
        };
        return b;
    }

    function filterList(list, kw) {
        if (!kw) return list;
        return list.filter(it => it.name.toLowerCase().includes(kw));
    }

    function render(filterKw) {
        const kw = (filterKw || '').trim().toLowerCase();
        body.innerHTML = '';
        let total = 0;

        ICON_GROUPS.forEach(g => {
            const groupMatchByName = !kw
                || g.name.toLowerCase().includes(kw)
                || (g.type || '').toLowerCase().includes(kw)
                || (g.keywords || '').toLowerCase().includes(kw);

            // 子分组（Date · Month/Week）
            if (g.sub) {
                const subBlocks = g.sub.map(s => ({
                    name: s.name,
                    type: s.type,
                    list: groupMatchByName ? s.list : filterList(s.list, kw),
                })).filter(b => b.list.length);
                if (!subBlocks.length) return;

                const groupEl = document.createElement('div');
                groupEl.className = 'mm-emoji-group';
                const t = document.createElement('div');
                t.className = 'mm-emoji-group-title';
                t.textContent = g.name;
                groupEl.appendChild(t);
                subBlocks.forEach(sb => {
                    const st = document.createElement('div');
                    st.className = 'mm-emoji-group-sub';
                    st.textContent = sb.name;
                    groupEl.appendChild(st);
                    const grid = document.createElement('div');
                    grid.className = 'mm-emoji-grid';
                    sb.list.forEach(it => grid.appendChild(makeCell(it, sb.type)));
                    groupEl.appendChild(grid);
                    total += sb.list.length;
                });
                body.appendChild(groupEl);
                return;
            }

            const items = groupMatchByName ? g.list : filterList(g.list, kw);
            if (!items.length) return;

            const groupEl = document.createElement('div');
            groupEl.className = 'mm-emoji-group';
            const t = document.createElement('div');
            t.className = 'mm-emoji-group-title';
            t.textContent = g.name;
            groupEl.appendChild(t);
            const grid = document.createElement('div');
            grid.className = 'mm-emoji-grid';
            items.forEach(it => grid.appendChild(makeCell(it, g.type)));
            groupEl.appendChild(grid);
            body.appendChild(groupEl);
            total += items.length;
        });

        if (!total) {
            const empty = document.createElement('div');
            empty.className = 'mm-emoji-empty';
            empty.textContent = '没有匹配的图标';
            body.appendChild(empty);
        }
    }

    render('');
    emojiPanelRender = render; // 暴露给外部，便于切换节点时复用
    if (search) search.value = '';
    panel.classList.remove('hidden');
    $('mmEmojiClose').onclick = () => {
        panel.classList.add('hidden');
        emojiPanelNode = null;
        emojiPanelRender = null;
    };
    // 底部：一键清除当前节点的全部图标
    const clearBtn = $('mmEmojiClear');
    if (clearBtn) {
        clearBtn.onclick = () => {
            const target = emojiPanelNode;
            if (!target) return;
            clearIconsOfNode(target);
            // 面板内所有单元格取消选中高亮
            body.querySelectorAll('.mm-emoji-cell.is-on').forEach(el => el.classList.remove('is-on'));
        };
    }
    if (search) search.oninput = () => render(search.value);
}

// 节点已有图标数量
function nodeIconCount(node) {
    const d = node && node.nodeData && node.nodeData.data;
    return d && Array.isArray(d.icon) ? d.icon.length : 0;
}

/**
 * 联动：根据"当前选中节点"刷新图标面板。
 * - 面板已打开 + 新节点有图标 → 切换目标节点并重新渲染高亮（不弹出新面板）；
 * - 面板已打开 + 新节点没有图标 → 自动关闭（避免在"无图标的节点"上误改其他节点的图标）；
 * - 面板未打开 → 不做任何事（不会因为选中节点而自动弹出，保持用户主动触发的语义）。
 */
export function syncEmojiPanelForNode(node) {
    const panel = $('mmEmojiPanel');
    if (!panel || panel.classList.contains('hidden')) return; // 面板没开 → 不打扰
    if (!node) {
        closeEmojiPanel();
        return;
    }
    if (nodeIconCount(node) <= 0) {
        // 新选中的节点没有图标 —— 按需求关闭面板
        closeEmojiPanel();
        return;
    }
    // 有图标：把面板的目标切到新节点并重渲染（保留搜索关键字）
    emojiPanelNode = node;
    if (typeof emojiPanelRender === 'function') {
        const search = $('mmEmojiSearch');
        emojiPanelRender(search ? search.value : '');
    }
}

export function closeEmojiPanel() {
    const panel = $('mmEmojiPanel');
    if (panel) panel.classList.add('hidden');
    emojiPanelNode = null;
    emojiPanelRender = null;
}

function applyIconToNode(node, emoji) {
    const mm = ctx.mm;
    const d = node.nodeData.data;
    const icons = Array.isArray(d.icon) ? [...d.icon] : [];
    const idx = icons.indexOf(emoji);
    let removed = false;
    if (idx >= 0) {
        // 再次点击同一图标 → 移除
        icons.splice(idx, 1);
        removed = true;
    } else {
        icons.push(emoji);
    }
    mm.renderer.setNodeData(node, { icon: icons });
    node.reRender();
    scheduleSyncToExtension();
    return removed;
}

// 清除节点上的全部图标
function clearIconsOfNode(node) {
    if (!node || !node.nodeData) return;
    const mm = ctx.mm;
    mm.renderer.setNodeData(node, { icon: [] });
    node.reRender();
    scheduleSyncToExtension();
}

// ============================================================================
// 顶部 hint 浮层 / 文件名复制 / 全局 Esc 兜底
// ----------------------------------------------------------------------------
// 把这三个小功能集中在 toolbar.js，避免散落到 main.js 影响 boot 路径的可读性。
// ============================================================================
function bindHintPopover() {
    const btn = $('mmHintBtn');
    const pop = $('mmHintPopover');
    if (!btn || !pop) return;

    let isOpen = false;
    const open = () => {
        if (isOpen) return;
        // 定位到按钮正下方
        const r = btn.getBoundingClientRect();
        pop.style.top = (r.bottom + 4) + 'px';
        pop.style.left = r.left + 'px';
        pop.classList.remove('hidden');
        isOpen = true;
    };
    const close = () => {
        if (!isOpen) return;
        pop.classList.add('hidden');
        isOpen = false;
    };

    // hover 显示 / 离开延迟关闭，避免鼠标移到 pop 上途中误关
    let hoverTimer = null;
    btn.addEventListener('mouseenter', () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; } open(); });
    btn.addEventListener('mouseleave', () => { hoverTimer = setTimeout(close, 180); });
    pop.addEventListener('mouseenter', () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; } });
    pop.addEventListener('mouseleave', () => { hoverTimer = setTimeout(close, 180); });

    // 点击切换（移动端 / 键盘可达）
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        isOpen ? close() : open();
    });
    // 点击外部关闭
    document.addEventListener('mousedown', (e) => {
        if (!isOpen) return;
        if (btn.contains(e.target) || pop.contains(e.target)) return;
        close();
    });
}

function bindFileNameAction() {
    const el = $('mmFileName');
    if (!el) return;
    const doCopy = async () => {
        const text = ctx.currentFilePath || ctx.currentFileName;
        if (!text) return;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            setStatus('已复制：' + text);
        } catch (_) { setStatus('复制失败'); }
    };
    el.addEventListener('click', doCopy);
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            doCopy();
        }
    });
}

// 全局 Esc 兜底：每个浮层都可单独监听 Esc，此处只补打两个之前没绑的（hint / insertMenu）
function bindGlobalEscFallback() {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        try {
            const pop = $('mmHintPopover');
            if (pop && !pop.classList.contains('hidden')) pop.classList.add('hidden');
        } catch (_) {}
        try {
            const im = $('mmInsertMenu');
            if (im && !im.classList.contains('hidden')) im.classList.add('hidden');
        } catch (_) {}
    });
}
