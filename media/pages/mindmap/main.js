// ============================================================================
// media/pages/mindmap/main.js
// ----------------------------------------------------------------------------
// 入口模块。原本的 3700+ 行已按功能拆分到 ./modules/* 下：
//   ctx.js          共享状态 + 基础工具 + 持久化键
//   adapter.js      md ↔ smm 双向适配、富元素提取、节点样式收集
//   assets.js       与扩展端通信（资源解析 / 文件选择 / Lightbox）
//   core.js         核心渲染（initOrUpdate / 防抖同步）
//   popups.js       链接/图片/附件弹窗
//   toolbar.js      顶栏、侧边栏、更多功能浮层、节点插入、Emoji
//   style-panel.js  Page Style / Topic Style 面板（含主题/布局/颜色/形状）
//
// 本文件只保留：模块装配 + boot() + 扩展端 message 路由。
// ============================================================================

import { ctx, vscode, $, showFatal, setStatus } from './modules/ctx.js';
import { initOrUpdate } from './modules/core.js';
import { bindToolbar } from './modules/toolbar.js';
import {
    installColorPicker,
    installShapePicker,
    openStylePanel,
    openLayoutPanel,
    bindStylePanel,
} from './modules/style-panel.js';
import { hideLinkPopup } from './modules/popups.js';

// 兼容某些子模块通过 import './icons.js' 的相对路径——这里再 import 一次
// 以触发 icons.js 的副作用（如有）。无副作用时也无害。
import './icons.js';

// 把样式 / 布局面板入口挂到 window 上，供 toolbar.js 中的 bindSideRail()
// 通过 window.__mmOpenStylePanel / __mmOpenLayoutPanel / __mmBindStylePanel 调用。
// 这样既能避免 toolbar.js ↔ style-panel.js 之间的循环 import，又能确保 rail
// 上"主题样式"和"切换布局"按钮能正确触发对应面板。
window.__mmOpenStylePanel = openStylePanel;
window.__mmOpenLayoutPanel = openLayoutPanel;
window.__mmBindStylePanel = bindStylePanel;

// ------------------------------------------------------------------
// 启动
// ------------------------------------------------------------------
let booted = false;
function boot() {
    if (booted) return;
    booted = true;
    try { bindToolbar(); } catch (e) { showFatal('toolbar 初始化失败：' + (e && e.message || e)); }
    try { installColorPicker(); } catch (_) {}
    try { installShapePicker(); } catch (_) {}
    // vendor 是否就位都要发 ready：
    //   - 已就位：initOrUpdate 正常渲染
    //   - 未就位：在 init 处理里会显示 "simple-mind-map 未加载"
    if (!window.simpleMindMap) {
        showFatal('simple-mind-map 资源未加载（vendor bundle 未就位）');
    }
    vscode.postMessage({ type: 'ready' });
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// link 弹窗在滚动/缩放时需要隐藏（避免锚点错位）
window.addEventListener('resize', hideLinkPopup);
window.addEventListener('scroll', hideLinkPopup, true);

// ------------------------------------------------------------------
// 与扩展端的消息交换
// ------------------------------------------------------------------
window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
        case 'init': {
            // 仅首次（mm 尚未创建）才显示 "加载中…" 遮罩；
            // 外部修改 md 触发的 docChange 走 mm.setData() 增量更新，不应再让用户看到加载态闪烁。
            if (!ctx.mm) {
                $('mmEmpty').textContent = '加载中…';
                $('mmEmpty').classList.remove('hidden');
            }
            try {
                ctx.documentMode = msg.mode || 'outline';
                await initOrUpdate(msg.tree, msg.fileName, msg.filePath);
            } catch (err) {
                console.error('[mindmap] init failed', err);
                $('mmEmpty').textContent = '渲染失败：' + (err && err.message ? err.message : err);
                $('mmEmpty').classList.remove('hidden');
            }
            break;
        }
        case 'parseError': {
            $('mmEmpty').textContent = '解析失败：' + (msg.message || '');
            $('mmEmpty').classList.remove('hidden');
            break;
        }
        case 'exportXmindResult': {
            if (msg.canceled) {
                setStatus('已取消导出');
            } else if (msg.ok) {
                setStatus('已导出：' + (msg.fsPath || ''));
            } else {
                setStatus('导出失败：' + (msg.message || ''));
            }
            break;
        }
        case 'resolveAssetResult': {
            const w = ctx.assetWaiters.get(msg.requestId);
            if (w) {
                ctx.assetWaiters.delete(msg.requestId);
                const map = new Map();
                (msg.items || []).forEach(it => map.set(it.rel, it.uri));
                w(map);
            }
            break;
        }
        case 'pickFileResult': {
            const w = ctx.pickWaiters.get(msg.requestId);
            if (w) {
                ctx.pickWaiters.delete(msg.requestId);
                w(msg);
            }
            break;
        }
        case 'saveAssetBytesResult': {
            const w = ctx.saveBytesWaiters.get(msg.requestId);
            if (w) {
                ctx.saveBytesWaiters.delete(msg.requestId);
                w(msg);
            }
            break;
        }
    }
});
