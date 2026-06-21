// ============================================================================
// modules/popups.js
// ----------------------------------------------------------------------------
// 富元素弹窗：
//   - 链接快捷操作浮层（点击节点链接图标显示：Open / Copy / Edit / Delete）
//   - 链接编辑对话框（openLinkPrompt）
//   - 图片插入对话框（openImagePrompt，含 Local / Web / Online）
//   - 应用图片 / 附件到节点（applyImageToNode / applyAttachmentToNode）
// ============================================================================

import { ctx, vscode, $, setStatus } from './ctx.js';
import { htmlToPlain, plainToHtml } from './adapter.js';
import { scheduleSyncToExtension } from './core.js';
import { saveAssetBytes } from './assets.js';

// =====================================================
// 链接快捷操作浮层（点击节点链接图标显示）
// =====================================================
let _mmLinkPopupBound = false;
let _mmLinkPopupCurrent = { node: null, url: '' };

export function showLinkPopup(node, url, anchorRect) {
    const pop = document.getElementById('mmLinkPopup');
    if (!pop || !url) return;
    _mmLinkPopupCurrent = { node, url };
    const urlEl = document.getElementById('mmLinkPopupUrl');
    if (urlEl) {
        // 本地附件路径常被 URL 编码（如空格 → %20），展示时尽量解码，
        // 让用户看到真实路径；外部 http/https 链接保持原样以避免误解。
        let shown = url;
        if (!/^https?:/i.test(url)) {
            try { shown = decodeURIComponent(url); } catch (_) { shown = url; }
        }
        urlEl.textContent = shown;
        urlEl.setAttribute('title', shown);
    }
    bindLinkPopupOnce();

    // 先显示再测量尺寸，便于边界裁剪
    pop.classList.remove('hidden');
    // 暂时移到 (-9999,-9999) 进行尺寸测量，避免出现闪烁
    pop.style.left = '-9999px';
    pop.style.top = '-9999px';

    requestAnimationFrame(() => {
        const popRect = pop.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = 0, top = 0;
        if (anchorRect) {
            // 默认显示在链接图标右上方
            left = anchorRect.left;
            top = (anchorRect.top || 0) - popRect.height - 8;
            if (top < 8) {
                // 上方空间不足 → 显示在下方
                top = (anchorRect.bottom || anchorRect.top || 0) + 8;
            }
        } else {
            left = (vw - popRect.width) / 2;
            top = 80;
        }
        // 横向边界
        if (left + popRect.width > vw - 8) left = vw - popRect.width - 8;
        if (left < 8) left = 8;
        if (top + popRect.height > vh - 8) top = vh - popRect.height - 8;
        if (top < 8) top = 8;
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    });
}

export function hideLinkPopup() {
    const pop = document.getElementById('mmLinkPopup');
    if (pop) pop.classList.add('hidden');
    _mmLinkPopupCurrent = { node: null, url: '' };
}

function bindLinkPopupOnce() {
    if (_mmLinkPopupBound) return;
    _mmLinkPopupBound = true;
    const pop = document.getElementById('mmLinkPopup');
    if (!pop) return;

    // 阻止 popup 内部点击冒泡，避免触发外部关闭
    pop.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    pop.addEventListener('click', (e) => { e.stopPropagation(); });

    // Open Link → 调用 VS Code 外部打开
    const openBtn = document.getElementById('mmLinkPopupOpen');
    if (openBtn) {
        openBtn.addEventListener('click', () => {
            const url = _mmLinkPopupCurrent.url;
            if (url) {
                try { vscode.postMessage({ type: 'openExternal', target: url }); } catch (_) {}
            }
            hideLinkPopup();
        });
    }

    // 复制链接
    const copyBtn = document.getElementById('mmLinkPopupCopy');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const url = _mmLinkPopupCurrent.url;
            if (!url) { hideLinkPopup(); return; }
            // 本地附件路径解码后复制，避免用户拿到 %20 形态的路径无法直接用
            let toCopy = url;
            if (!/^https?:/i.test(url)) {
                try { toCopy = decodeURIComponent(url); } catch (_) { toCopy = url; }
            }
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(toCopy);
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = toCopy;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                try { setStatus && setStatus('链接已复制'); } catch (_) {}
            } catch (_) {}
            hideLinkPopup();
        });
    }

    // 编辑链接
    const editBtn = document.getElementById('mmLinkPopupEdit');
    if (editBtn) {
        editBtn.addEventListener('click', () => {
            const node = _mmLinkPopupCurrent.node;
            const url = _mmLinkPopupCurrent.url;
            hideLinkPopup();
            if (node) {
                const d = (node.nodeData && node.nodeData.data) || {};
                const text = d.hyperlinkTitle || htmlToPlain(d.text || '') || '';
                openLinkPrompt(node, { text, url });
            }
        });
    }

    // 删除链接 / 附件（根据节点当前实际存在的字段决定清空哪个）
    const delBtn = document.getElementById('mmLinkPopupDelete');
    if (delBtn) {
        delBtn.addEventListener('click', () => {
            const node = _mmLinkPopupCurrent.node;
            hideLinkPopup();
            if (!node || !ctx.mm) return;
            try {
                const d = (node.nodeData && node.nodeData.data) || {};
                const patch = {};
                if (d.attachmentUrl) {
                    patch.attachmentUrl = '';
                    patch.attachmentName = '';
                    patch.mmAttachmentRaw = '';
                }
                if (d.hyperlink) {
                    patch.hyperlink = '';
                    patch.hyperlinkTitle = '';
                    patch.mmHyperlinkRaw = '';
                }
                ctx.mm.renderer.setNodeData(node, patch);
                if (typeof node.reRender === 'function') node.reRender();
                scheduleSyncToExtension();
            } catch (_) {}
        });
    }

    // 点击外部 / Esc / 滚动 / 窗口尺寸变化 → 关闭
    document.addEventListener('mousedown', (e) => {
        const popEl = document.getElementById('mmLinkPopup');
        if (!popEl || popEl.classList.contains('hidden')) return;
        if (!popEl.contains(e.target)) hideLinkPopup();
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideLinkPopup();
    });
    window.addEventListener('resize', hideLinkPopup);
    window.addEventListener('scroll', hideLinkPopup, true);
}

// 链接对话框
export function openLinkPrompt(node, prefill) {
    const p = $('mmLinkPrompt');
    const tx = $('mmLinkText');
    const ux = $('mmLinkUrl');
    tx.value = (prefill && prefill.text) || '';
    ux.value = (prefill && prefill.url) || '';
    p.classList.remove('hidden');
    $('mmLinkCancel').onclick = () => p.classList.add('hidden');
    $('mmLinkOk').onclick = () => {
        const url = ux.value.trim();
        if (!url) return;
        const text = tx.value.trim() || url;
        // 只更新链接相关字段，避免误覆盖节点原文本（用户的节点文字必须保留）
        ctx.mm.renderer.setNodeData(node, {
            hyperlink: url,
            hyperlinkTitle: text,
            mmHyperlinkRaw: url,
        });
        node.reRender();
        scheduleSyncToExtension();
        p.classList.add('hidden');
    };
}

// 图片对话框（新版：Add Pictures，Local / Web / Online 三 Tab）
export function openImagePrompt(node) {
    console.log('[mm][image] openImagePrompt called (v2-preview)', node && node.nodeData && node.nodeData.data && node.nodeData.data.text);
    const p = $('mmImagePrompt');
    const urlInput = $('mmImageUrl');
    const fileInput = $('mmImageFile');
    const drop = $('mmImageDrop');
    const uploadBtn = $('mmImageUploadBtn');
    const previewEl = $('mmImagePreview');
    const previewThumb = $('mmImagePreviewThumb');
    const previewName = $('mmImagePreviewName');
    const previewMeta = $('mmImagePreviewMeta');
    const previewClear = $('mmImagePreviewClear');
    const localOk = $('mmImageLocalOk');
    const localErr = $('mmImageLocalError');
    const webErr = $('mmImageWebError');
    if (!p) { console.warn('[mm][image] #mmImagePrompt 不存在，无法弹窗'); return; }
    if (!urlInput || !fileInput || !drop || !uploadBtn) {
        console.warn('[mm][image] 弹窗子节点缺失', { urlInput: !!urlInput, fileInput: !!fileInput, drop: !!drop, uploadBtn: !!uploadBtn });
    }

    // 重置
    urlInput.value = '';
    if (fileInput) fileInput.value = '';
    drop.classList.remove('dragover');

    // 默认激活 Local 标签
    const tabs = p.querySelectorAll('.mm-img-tab');
    const panels = p.querySelectorAll('.mm-img-panel');
    function activateTab(name) {
        tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        panels.forEach(pn => pn.classList.toggle('hidden', pn.dataset.panel !== name));
    }
    activateTab('local');
    tabs.forEach(t => {
        t.onclick = () => activateTab(t.dataset.tab);
    });

    p.classList.remove('hidden');

    const MAX_BYTES = 2 * 1024 * 1024; // 2MB
    const ACCEPT_TYPES = ['image/png', 'image/jpeg'];
    const COMPRESS_MAX_EDGE = 1920;     // 长边超过这个尺寸会被缩放
    const COMPRESS_MIN_QUALITY = 0.4;   // JPEG 最低画质下限

    // 当前已选中（仅预览，未提交）的文件 + 其 dataURL
    let pendingFile = null;
    let pendingDataUrl = '';
    // 原始大小（用于在预览处显示"已压缩，原 X MB"）
    let pendingOriginalSize = 0;

    function resetPreview() {
        pendingFile = null;
        pendingDataUrl = '';
        pendingOriginalSize = 0;
        if (previewEl) previewEl.classList.add('hidden');
        if (previewThumb) previewThumb.src = '';
        if (previewName) { previewName.textContent = ''; previewName.title = ''; }
        if (previewMeta) previewMeta.textContent = '';
        if (localOk) localOk.disabled = true;
        if (fileInput) fileInput.value = '';
        if (localErr) { localErr.textContent = ''; localErr.classList.add('hidden'); }
        if (webErr) { webErr.textContent = ''; webErr.classList.add('hidden'); }
    }
    resetPreview();

    function close() {
        p.classList.add('hidden');
        resetPreview();
    }

    function showLocalError(msg) {
        if (localErr) {
            localErr.textContent = msg || '';
            localErr.classList.toggle('hidden', !msg);
        }
        if (msg) { try { setStatus && setStatus(msg); } catch (_) {} }
    }
    function showLocalInfo(msg) {
        // 复用 localErr 节点显示提示，但去掉错误样式（这里用 textContent + 移除 hidden 即可）
        if (localErr) {
            localErr.textContent = msg || '';
            localErr.classList.toggle('hidden', !msg);
        }
    }
    function showWebError(msg) {
        if (webErr) {
            webErr.textContent = msg || '';
            webErr.classList.toggle('hidden', !msg);
        }
        if (msg) { try { setStatus && setStatus(msg); } catch (_) {} }
    }

    function validate(file) {
        if (!file) return false;
        if (!ACCEPT_TYPES.includes(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
            showLocalError('仅支持 PNG / JPG 格式');
            return false;
        }
        // 大小不在这里卡，超过 2MB 的图片会在 selectLocalFile 里尝试压缩
        showLocalError('');
        return true;
    }

    function readAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(file);
        });
    }

    function formatSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    // 检测 PNG 是否带透明通道（colorType=4/6 或 tRNS chunk）
    // 失败时保守返回 true，避免错误地把透明 PNG 压成黑底/白底 JPEG
    async function detectPngHasAlpha(file) {
        try {
            const buf = await file.arrayBuffer();
            const view = new DataView(buf);
            // PNG 头 8 字节固定签名 89 50 4E 47 0D 0A 1A 0A，IHDR 从第 8 字节开始
            // IHDR 数据区起始位置：8(签名)+4(length)+4(type)=16，colorType 在 IHDR 数据区偏移 9 处 (= 25)
            if (view.byteLength < 26) return true;
            if (view.getUint32(0) !== 0x89504e47) return false; // 不是 PNG，不在此函数处理
            const colorType = view.getUint8(25);
            // 4 = Grayscale+Alpha, 6 = RGBA → 必然有 Alpha
            if (colorType === 4 || colorType === 6) return true;
            // 其他颜色类型可能通过 tRNS chunk 携带透明信息，扫一下
            let offset = 8;
            while (offset + 8 < view.byteLength) {
                const len = view.getUint32(offset);
                const type = String.fromCharCode(
                    view.getUint8(offset + 4),
                    view.getUint8(offset + 5),
                    view.getUint8(offset + 6),
                    view.getUint8(offset + 7),
                );
                if (type === 'tRNS') return true;
                if (type === 'IDAT' || type === 'IEND') break;
                offset += 8 + len + 4; // length + type + data + crc
            }
            return false;
        } catch (_) {
            return true;
        }
    }

    // 用 canvas 把图片压成 JPEG，循环降低画质直到 ≤ MAX_BYTES
    // 返回 { dataUrl, blob } 或 null（失败/超过下限）
    async function compressImageFile(file) {
        const srcUrl = URL.createObjectURL(file);
        try {
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('decode-failed'));
                im.src = srcUrl;
            });
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (!w || !h) return null;
            // 长边缩放到 COMPRESS_MAX_EDGE
            const longEdge = Math.max(w, h);
            if (longEdge > COMPRESS_MAX_EDGE) {
                const ratio = COMPRESS_MAX_EDGE / longEdge;
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const cctx = canvas.getContext('2d');
            // 因为统一输出 JPEG，先铺一层白底，避免无透明 PNG 角落出现奇怪杂色
            cctx.fillStyle = '#FFFFFF';
            cctx.fillRect(0, 0, w, h);
            cctx.drawImage(img, 0, 0, w, h);

            for (let q = 0.85; q >= COMPRESS_MIN_QUALITY - 1e-6; q -= 0.1) {
                const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
                if (!blob) continue;
                if (blob.size <= MAX_BYTES) {
                    const dataUrl = await new Promise((resolve, reject) => {
                        const fr = new FileReader();
                        fr.onload = () => resolve(String(fr.result || ''));
                        fr.onerror = () => reject(fr.error);
                        fr.readAsDataURL(blob);
                    });
                    return { dataUrl, blob, width: w, height: h, quality: q };
                }
            }
            return null;
        } finally {
            try { URL.revokeObjectURL(srcUrl); } catch (_) {}
        }
    }

    // 选中本地图片 → 仅做预览，不立即插入
    async function selectLocalFile(file) {
        console.log('[mm][image] selectLocalFile invoked', { name: file && file.name, size: file && file.size, type: file && file.type });
        if (!validate(file)) { console.warn('[mm][image] validate failed'); return; }

        const originalSize = file.size;
        const isPng = file.type === 'image/png' || /\.png$/i.test(file.name || '');
        let workingFile = file;
        let workingName = file.name || '';
        let workingType = file.type || (isPng ? 'image/png' : 'image/jpeg');
        let compressed = false;

        // 超过 2MB → 尝试压缩
        if (originalSize > MAX_BYTES) {
            // 透明 PNG 转 JPEG 会丢透明信息 → 直接提示，不压缩
            if (isPng) {
                const hasAlpha = await detectPngHasAlpha(file);
                if (hasAlpha) {
                    showLocalError(`图片大小 ${formatSize(originalSize)} 超过 2MB；含透明通道的 PNG 无法自动压缩，请先在本地压缩或更换图片`);
                    return;
                }
            }
            showLocalInfo('图片较大，正在压缩…');
            try {
                const result = await compressImageFile(file);
                if (!result) {
                    showLocalError(`图片大小 ${formatSize(originalSize)} 超过 2MB，自动压缩后仍超限，请先在本地压缩或更换图片`);
                    return;
                }
                compressed = true;
                workingFile = result.blob;
                workingType = 'image/jpeg';
                // 文件名后缀改成 .jpg（去掉原始扩展名）
                workingName = (file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
                showLocalInfo('');
            } catch (err) {
                console.error('[mm][image] compress failed', err);
                showLocalError('图片压缩失败，请尝试更换图片');
                return;
            }
        }

        try {
            const dataUrl = await readAsDataUrl(workingFile);
            console.log('[mm][image] dataUrl ready, length=', dataUrl.length, 'compressed=', compressed);
            pendingFile = new File([workingFile], workingName, { type: workingType });
            pendingDataUrl = dataUrl;
            pendingOriginalSize = originalSize;
            if (previewThumb) previewThumb.src = dataUrl;
            if (previewName) { previewName.textContent = workingName; previewName.title = workingName; }
            if (previewMeta) {
                const typeLabel = workingType.replace('image/', '').toUpperCase();
                const sizeLabel = formatSize(pendingFile.size);
                previewMeta.textContent = compressed
                    ? `${typeLabel} · ${sizeLabel}（已压缩，原 ${formatSize(originalSize)}）`
                    : `${typeLabel} · ${sizeLabel}`;
            }
            if (previewEl) previewEl.classList.remove('hidden');
            if (localOk) localOk.disabled = false;
        } catch (err) {
            console.error('[mindmap] read file failed', err);
            showLocalError('读取图片失败');
        }
    }

    // 点击拖拽区 / Upload Files 按钮 → 弹出文件选择
    // drop 已改为 <label for="mmImageFile">，浏览器原生处理打开文件选择器，
    // 这里只保留 dragover/drop 和 change 监听，避免 JS programmatic click 在 webview 中不可靠的问题。
    // 同时监听 change 和 input，双保险
    const onFileChange = () => {
        const f = fileInput.files && fileInput.files[0];
        console.log('[mm][image] fileInput change/input fired, has file?', !!f);
        if (f) selectLocalFile(f);
    };
    fileInput.onchange = onFileChange;
    fileInput.oninput = onFileChange;
    drop.ondragover = (e) => {
        e.preventDefault();
        drop.classList.add('dragover');
    };
    drop.ondragleave = () => drop.classList.remove('dragover');
    drop.ondrop = (e) => {
        e.preventDefault();
        drop.classList.remove('dragover');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) selectLocalFile(f);
    };

    // Upload Files 按钮：嵌套在 <label for="mmImageFile"> 内，但 HTML 规范规定
    // <button> 嵌套在 <label> 中时，点击按钮 *不会* 自动激活关联控件，所以这里
    // 必须显式 click() 一次；同时阻止冒泡，避免 label 再触发一次导致打开两次。
    uploadBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 清空一下，保证选择同名文件也能触发 change
        try { fileInput.value = ''; } catch (_) { /* ignore */ }
        fileInput.click();
    };

    // 移除已选预览
    if (previewClear) {
        previewClear.onclick = (e) => {
            e.stopPropagation();
            resetPreview();
        };
    }

    // Local: 点 Insert Image 按钮才真正写入节点
    if (localOk) {
        localOk.onclick = async () => {
            if (!pendingDataUrl || !pendingFile) return;
            // 先把 dataURL 落盘到 attachments/，让 md 只保存相对路径，
            // 避免几百 KB 的 base64 直接写进 markdown 文件。
            const base64 = String(pendingDataUrl).split(',', 2)[1] || '';
            const originalText = localOk.textContent;
            localOk.disabled = true;
            localOk.textContent = 'Saving...';
            let resp = null;
            try {
                resp = await saveAssetBytes({
                    kind: 'image',
                    base64,
                    name: pendingFile.name || 'image.png',
                });
            } catch (err) {
                console.error('[mm][image] saveAssetBytes throw', err);
            }
            localOk.disabled = false;
            localOk.textContent = originalText;
            if (resp && resp.ok && resp.rel && resp.webUri) {
                applyImageToNode(node, {
                    rel: resp.rel,
                    webUri: resp.webUri,
                    name: resp.name || pendingFile.name || '',
                });
                close();
            } else {
                showLocalError('保存图片到本地失败：' + ((resp && resp.message) || '未知错误'));
            }
        };
    }

    // Web Image：提交 URL
    $('mmImageOk').onclick = () => {
        const u = urlInput.value.trim();
        if (!u) { showWebError('请填写图片链接'); return; }
        // 1. 基础校验：file:// 协议在 webview 中无法访问，直接给出提示
        if (/^file:\/\//i.test(u)) {
            showWebError('Webview 无法加载 file:// 本地路径，请使用"Local Image"上传，或粘贴 http/https 网络图片地址');
            return;
        }
        showWebError('');
        // 2. 预加载校验：在主线程探测能否加载，失败则给提示，避免节点显示破图
        const okBtn = $('mmImageOk');
        const originalText = okBtn.textContent;
        okBtn.disabled = true;
        okBtn.textContent = 'Loading...';
        const probe = new Image();
        let done = false;
        const finish = (ok, reason) => {
            if (done) return;
            done = true;
            okBtn.disabled = false;
            okBtn.textContent = originalText;
            if (ok) {
                applyImageToNode(node, { rel: u, webUri: u, name: '' });
                close();
            } else {
                showWebError('图片加载失败：' + (reason || '请检查链接是否可访问（注意跨域 / 防盗链 / 是否需要登录）'));
            }
        };
        probe.onload = () => finish(true);
        probe.onerror = () => finish(false, '无法访问该图片 URL');
        // 兜底 8s 超时
        setTimeout(() => finish(false, '加载超时'), 8000);
        probe.src = u;
    };

    // 关闭按钮
    $('mmImageCancel').onclick = close;
}

export function applyImageToNode(node, info) {
    const mm = ctx.mm;
    const url = info.webUri || info.rel || '';
    console.log('[mm][image] applyImageToNode', { hasMm: !!mm, hasNode: !!node, urlLen: url.length, urlHead: url.slice(0, 60), name: info.name });
    if (!url) { console.warn('[mm][image] 空 URL，跳过'); return; }
    if (!mm || !node) { console.warn('[mm][image] mm 或 node 缺失'); return; }
    const title = info.name || '';
    const width = 240;
    const height = 160;
    let useNative = false;
    try {
        if (mm && typeof mm.execCommand === 'function') {
            // simple-mind-map 原生命令：内部走 setNodeDataRender，会触发完整重绘 + history
            mm.execCommand('SET_NODE_IMAGE', node, { url, title, width, height });
            useNative = true;
            console.log('[mm][image] SET_NODE_IMAGE done');
        }
    } catch (err) {
        console.warn('[mindmap] SET_NODE_IMAGE failed, fallback to setNodeData', err);
    }
    if (!useNative) {
        console.log('[mm][image] fallback setNodeData');
        mm.renderer.setNodeData(node, {
            image: url,
            imageTitle: title,
            imageSize: { width, height },
        });
        try { node.reRender && node.reRender(); } catch (_) {}
    }
    // 同步保留原始路径（用于 md 序列化时拿回相对路径），不触发重绘
    try {
        if (info.rel && info.rel !== url) {
            mm.renderer.setNodeData(node, { mmImageRaw: info.rel });
        } else {
            mm.renderer.setNodeData(node, { mmImageRaw: url });
        }
    } catch (_) {}
    scheduleSyncToExtension();
}

export function applyAttachmentToNode(node, info) {
    const mm = ctx.mm;
    // 使用 simple-mind-map 原生的 attachmentUrl / attachmentName 字段。
    // 该字段渲染出独立的 📎 图标，且不会影响节点 text，因此原文本会被完整保留。
    if (!mm || !node) return;
    try {
        // 优先用引擎命令，保证图标/数据同步刷新
        if (mm.execCommand) {
            mm.execCommand('SET_NODE_ATTACHMENT', node, info.webUri || info.rel || '', info.name || '');
        } else {
            mm.renderer.setNodeDataRender(node, {
                attachmentUrl: info.webUri || info.rel || '',
                attachmentName: info.name || '',
            });
        }
        // 同步保留原始相对路径，用于回写 md
        const patch = { mmAttachmentRaw: info.rel || info.webUri || '' };
        // 兼容旧数据：若节点 text 本身是「📎 xxx」开头（来自老版本把附件塞进 text 的实现），
        // 清掉这段 emoji 前缀，避免与原生 attachment 图标重复显示。
        try {
            const curPlain = htmlToPlain((node.nodeData && node.nodeData.data && node.nodeData.data.text) || '');
            if (/^📎\s*\S/.test(curPlain) || /^📎\s*$/.test(curPlain)) {
                const rest = curPlain.replace(/^📎\s*/, '').trim();
                patch.text = plainToHtml(rest);
                patch.richText = true;
            }
        } catch (_) {}
        mm.renderer.setNodeData(node, patch);
    } catch (_) {}
    scheduleSyncToExtension();
}
