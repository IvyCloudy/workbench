// ============================================================================
// modules/assets.js
// ----------------------------------------------------------------------------
// 与扩展端交换文件资源：相对路径解析 + 文件选择 + 图片 Lightbox。
// 单独成模块，避免循环依赖（adapter.js 需要 resolveAssets）。
// ============================================================================

import { ctx, vscode, $ } from './ctx.js';

// ------------------------------------------------------------------
// 与扩展端通信：相对路径解析（图片/附件）
// ------------------------------------------------------------------
export function resolveAssets(items) {
    if (!items.length) return Promise.resolve(new Map());
    const requestId = `asset_${++ctx.assetReqSeq}`;
    return new Promise(resolve => {
        ctx.assetWaiters.set(requestId, resolve);
        vscode.postMessage({ type: 'resolveAsset', requestId, items });
        setTimeout(() => {
            if (ctx.assetWaiters.has(requestId)) {
                ctx.assetWaiters.delete(requestId);
                resolve(new Map());
            }
        }, 5000);
    });
}

export function pickFile(kind) {
    const requestId = `pick_${++ctx.pickReqSeq}`;
    return new Promise(resolve => {
        ctx.pickWaiters.set(requestId, resolve);
        vscode.postMessage({ type: 'pickFile', requestId, kind });
    });
}

// 把 webview 端持有的二进制图片（如压缩后的 JPEG dataURL）发到扩展端落盘到 attachments/，
// 避免把 base64 写入 md。成功时返回 { ok:true, rel, name, webUri }，失败返回 { ok:false, message }
export function saveAssetBytes({ kind, base64, name }) {
    const requestId = `savebytes_${++ctx.saveBytesReqSeq}`;
    return new Promise(resolve => {
        ctx.saveBytesWaiters.set(requestId, resolve);
        vscode.postMessage({ type: 'saveAssetBytes', requestId, kind, base64, name });
        // 兜底 10s 超时（写文件通常 < 100ms，10s 已极宽松）
        setTimeout(() => {
            if (ctx.saveBytesWaiters.has(requestId)) {
                ctx.saveBytesWaiters.delete(requestId);
                resolve({ ok: false, message: 'timeout' });
            }
        }, 10000);
    });
}

// ------------------------------------------------------------------
// 图片 Lightbox（节点图片点击放大预览）
// ------------------------------------------------------------------
// 当前 Lightbox 关联的节点（用于"删除图片"按钮）。
// 节点图片通过 lightbox 进入，是删除操作唯一稳定的入口（引擎自带的
// node-img-handle 已被 CSS 全局隐藏，避免误操作）。
let _mmLightboxCurrentNode = null;

export function closeLightbox() {
    const box = $('mmLightbox');
    const img = $('mmLightboxImg');
    if (!box) return;
    box.classList.add('hidden');
    if (img) img.src = '';
    _mmLightboxCurrentNode = null;
}
export function openLightbox(url, title, node) {
    const box = $('mmLightbox');
    const img = $('mmLightboxImg');
    if (!box || !img) return;
    img.src = url || '';
    img.alt = title || '';
    _mmLightboxCurrentNode = node || null;
    // 没有关联节点（理论上不会出现）时隐藏删除按钮，避免空操作
    const delBtn = $('mmLightboxDelete');
    if (delBtn) delBtn.style.display = _mmLightboxCurrentNode ? '' : 'none';
    box.classList.remove('hidden');
    bindLightboxOnce();
}
let __mmLightboxBound = false;
function bindLightboxOnce() {
    if (__mmLightboxBound) return;
    __mmLightboxBound = true;
    const box = $('mmLightbox');
    const closeBtn = $('mmLightboxClose');
    const delBtn = $('mmLightboxDelete');
    if (closeBtn) {
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            closeLightbox();
        });
    }
    if (delBtn) {
        delBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const node = _mmLightboxCurrentNode;
            const mm = ctx.mm;
            if (!node || !mm) { closeLightbox(); return; }
            try {
                // 优先走引擎原生命令清空图片，可以确保进入 history（支持撤销）
                let used = false;
                try {
                    if (typeof mm.execCommand === 'function') {
                        mm.execCommand('SET_NODE_IMAGE', node, { url: '', title: '', width: 0, height: 0 });
                        used = true;
                    }
                } catch (_) {}
                // 兜底：直接 patch nodeData
                if (!used && mm.renderer && typeof mm.renderer.setNodeData === 'function') {
                    mm.renderer.setNodeData(node, {
                        image: '',
                        imageTitle: '',
                        imageSize: null,
                        mmImageRaw: '',
                    });
                    try { node.reRender && node.reRender(); } catch (_) {}
                } else {
                    // execCommand 成功也需要同步清掉我们自己挂的 mmImageRaw，否则下次写回 md 仍带图片
                    try { mm.renderer.setNodeData(node, { mmImageRaw: '' }); } catch (_) {}
                }
            } catch (err) {
                console.warn('[mindmap] delete node image failed', err);
            }
            closeLightbox();
        });
    }
    if (box) {
        // 点击遮罩空白处关闭；点击图片本身不关闭
        box.addEventListener('click', (ev) => {
            if (ev.target === box) closeLightbox();
        });
    }
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && box && !box.classList.contains('hidden')) {
            closeLightbox();
        }
    });
}
