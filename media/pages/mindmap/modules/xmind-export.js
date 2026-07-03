// ============================================================================
// modules/xmind-export.js
// ----------------------------------------------------------------------------
// 思维导图 → .xmind 文件 导出（"官方基础包 + 后处理"方案）
//
// 关键思路：
//   1. 先用 simple-mind-map 自带的 `mm.export.xmind(name)` 生成一个"官方基础包"
//      —— 这个包的 content.json/content.xml/metadata.json/manifest.json 结构
//      与 XMind 桌面端导出的完全一致，能 100% 被 XMind 信任，布局
//      （structureClass=org.xmind.ui.logic.right）、标题、图片、超链接、笔记、标签
//      都已正确写入。
//   2. 用 window.JSZip（已通过 vendor bundle 暴露到全局）打开这个 zip。
//   3. 读取 content.json，递归遍历 sheet[0].rootTopic 与 mm.getData() 一一对应，
//      为每个 topic **增量注入**：
//        - style.properties：节点级配色 / 字体 / 形状
//        - markers：能映射到 XMind markerId 的图标
//        - 无法映射的图标 → labels
//        - 附件：从 vscode-webview-resource 读字节 → 写入 attachments/ →
//                 topic.href = "xap:attachments/<filename>"
//   4. 收集所有注入的 style.id → 写入独立 styles.json（XMind ZEN 样式池）。
//   5. 同步更新 manifest.json 的 file-entries 与 resources/。
//   6. 重新打包，把字节转 base64 返回，由扩展端写盘。
//
// 为什么这样行得通：
//   - 我们**不写 sheet.theme**，避免主题包覆盖 structureClass；
//   - 我们**只在 style.properties 上做增量**，topic 其它字段沿用官方写法；
//   - 单独的 styles.json 是 XMind ZEN 官方支持的样式池容器，专门承载样式定义而
//     不携带任何布局/主题语义，所以"配色"和"逻辑右布局"互不干扰。
// ============================================================================

// --- 图标 token → XMind ZEN markerId 映射（与扩展端 xmindExporter.ts 同源） ---
function smmIconToXmindMarker(id) {
    if (!id || typeof id !== 'string') return null;
    let m;
    m = /^priority[_-](\d+)$/i.exec(id);
    if (m) {
        const n = Math.max(1, Math.min(9, parseInt(m[1], 10) || 1));
        return 'priority-' + n;
    }
    m = /^progress[_-](.+)$/i.exec(id);
    if (m) {
        const map = {
            '0': 'task-start', '13': 'task-oct', '25': 'task-quarter',
            '38': 'task-oct', '50': 'task-half', '75': 'task-3oct',
            '88': 'task-3oct', '100': 'task-done', 'done': 'task-done',
        };
        return map[m[1].toLowerCase()] || 'task-start';
    }
    m = /^emotion[_-](.+)$/i.exec(id);
    if (m) {
        const map = {
            smile: 'smiley-smile', grin: 'smiley-laugh', laugh: 'smiley-laugh',
            haha: 'smiley-laugh', kiss: 'smiley-smile', love: 'smiley-smile',
            cool: 'smiley-smile', wink: 'smiley-smile', cry: 'smiley-cry',
            angry: 'smiley-angry', sleepy: 'smiley-boring',
            surprised: 'smiley-surprise', nerd: 'smiley-smile',
            sick: 'smiley-cry', devil: 'smiley-angry', shy: 'smiley-smile',
        };
        return map[m[1].toLowerCase()] || null;
    }
    m = /^arrow[_-](.+)$/i.exec(id);
    if (m) {
        const map = {
            up: 'arrow-up', right: 'arrow-right', down: 'arrow-down',
            left: 'arrow-left', leftright: 'arrow-up-right',
            updown: 'arrow-up-right', refresh: 'arrow-refresh',
            sync: 'arrow-refresh',
        };
        return map[m[1].toLowerCase()] || null;
    }
    m = /^flag[_-](.+)$/i.exec(id);
    if (m) {
        const map = {
            red: 'flag-red', orange: 'flag-orange', yellow: 'flag-yellow',
            green: 'flag-green', blue: 'flag-blue', purple: 'flag-purple',
            pink: 'flag-red', gray: 'flag-dark-gray',
        };
        return map[m[1].toLowerCase()] || 'flag-red';
    }
    m = /^star[_-](.+)$/i.exec(id);
    if (m) {
        const map = {
            red: 'star-red', orange: 'star-orange', yellow: 'star-yellow',
            green: 'star-green', blue: 'star-blue', purple: 'star-purple',
            pink: 'star-red', gray: 'star-gray',
        };
        return map[m[1].toLowerCase()] || 'star-red';
    }
    m = /^month[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        return months.indexOf(k) >= 0 ? 'month-' + k : null;
    }
    m = /^week[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const weeks = ['sun','mon','tue','wed','thu','fri','sat'];
        return weeks.indexOf(k) >= 0 ? 'week-' + k : null;
    }
    m = /^symbol[_-](.+)$/i.exec(id);
    if (m) {
        const map = {
            check: 'symbol-right', cross: 'symbol-wrong', note: 'other-note',
            time: 'other-clock', warn: 'symbol-warning', info: 'symbol-info',
            question: 'symbol-question', idea: 'other-light-bulb',
            pie: 'other-pie', gift: 'other-gift', lock: 'other-lock',
            unlock: 'other-key', mail: 'other-email', cloud: 'other-cloud',
            gear: 'other-gear', bulb: 'other-light-bulb', book: 'other-book',
            doc: 'other-note', thumbup: 'other-thumb-up',
            thumbdn: 'other-thumb-down', comment: 'other-comment',
            heart: 'other-heart', leaf: 'other-leaf', user: 'other-people',
            pen: 'other-edit', clip: 'other-clip', flash: 'other-flash',
            wave: 'other-wave',
        };
        return map[m[1].toLowerCase()] || null;
    }
    return null;
}

// --- 节点级 simple-mind-map data → XMind ZEN style.properties ---
function smmDataToStyleProps(d) {
    const p = {};
    if (d.fillColor && d.fillColor !== 'transparent') p['svg:fill'] = d.fillColor;
    if (d.borderColor) p['border-line-color'] = d.borderColor;
    if (typeof d.borderWidth === 'number' && d.borderWidth > 0) {
        p['border-line-width'] = String(d.borderWidth) + 'pt';
    }
    if (d.color) p['fo:color'] = d.color;
    if (d.fontFamily) p['fo:font-family'] = d.fontFamily;
    if (typeof d.fontSize === 'number' && d.fontSize > 0) {
        p['fo:font-size'] = String(d.fontSize) + 'pt';
    }
    if (d.fontWeight && d.fontWeight !== 'normal' && d.fontWeight !== 400) {
        p['fo:font-weight'] = String(d.fontWeight);
    }
    if (d.fontStyle && d.fontStyle !== 'normal') p['fo:font-style'] = d.fontStyle;
    if (d.textDecoration && d.textDecoration !== 'none') {
        p['fo:text-decoration'] = d.textDecoration;
    }
    if (d.shape) {
        const m = {
            rectangle: 'org.xmind.topicShape.rectangle',
            roundedRectangle: 'org.xmind.topicShape.roundedRect',
            ellipse: 'org.xmind.topicShape.ellipse',
            circle: 'org.xmind.topicShape.ellipse',
            diamond: 'org.xmind.topicShape.diamond',
        };
        const x = m[d.shape];
        if (x) p['shape-class'] = x;
    }
    return Object.keys(p).length > 0 ? p : null;
}

// --- 把 dataUrl 字符串转 ArrayBuffer ---
function dataUrlToArrayBuffer(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('invalid dataUrl');
    const b64 = dataUrl.slice(comma + 1);
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const arr = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return buf;
}

// --- ArrayBuffer/Uint8Array → base64 字符串 ---
function uint8ToBase64(bytes) {
    let bin = '';
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

// --- 安全的文件名（用于 resources/attachments 内）---
function safeFilename(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_');
}

// --- 通过 fetch 读取 vscode-webview-resource / http(s) / data: 的字节 ---
async function fetchBytes(url) {
    if (!url) return null;
    try {
        const resp = await fetch(url);
        if (!resp || !resp.ok) return null;
        const buf = await resp.arrayBuffer();
        return new Uint8Array(buf);
    } catch (_) {
        return null;
    }
}

// --- 主导出函数 ---
// mm        : simple-mind-map 实例（必须已就绪）
// sheetName : 用作 sheet title / 文件主名（不带扩展）
// 返回：{ ok: true, base64 } 或 { ok: false, message }
export async function exportXmindUsingOfficial(mm, sheetName) {
    if (!mm) return { ok: false, message: '思维导图未就绪' };
    // simple-mind-map 的导出走 mm.doExport.export(type, autoDownload, name)
    // 其中 autoDownload 必须传 false，否则会自动触发文件下载（落到浏览器下载目录）。
    const doExport = mm.doExport;
    if (!doExport || typeof doExport.xmind !== 'function') {
        return { ok: false, message: 'simple-mind-map ExportXMind 插件未就位' };
    }
    if (!window.JSZip) {
        return { ok: false, message: 'JSZip 未挂载到 window，请重新构建 vendor bundle' };
    }

    // 1) 用官方导出器生成基础包（这是 XMind 信任的"原生"结构）
    //    直接调用 doExport.xmind(name) → 返回 dataUrl 字符串，且不会触发自动下载。
    let baseDataUrl;
    try {
        baseDataUrl = await doExport.xmind(sheetName);
    } catch (err) {
        return { ok: false, message: '官方导出失败：' + (err && err.message || err) };
    }
    if (!baseDataUrl || typeof baseDataUrl !== 'string') {
        return { ok: false, message: '官方导出返回值异常' };
    }

    // 2) dataUrl → ArrayBuffer → JSZip 打开
    let buf;
    try {
        buf = dataUrlToArrayBuffer(baseDataUrl);
    } catch (err) {
        return { ok: false, message: 'dataUrl 解码失败：' + (err && err.message || err) };
    }

    const JSZip = window.JSZip;
    let zip;
    try {
        zip = await JSZip.loadAsync(buf);
    } catch (err) {
        return { ok: false, message: 'JSZip 打开失败：' + (err && err.message || err) };
    }

    // 3) 读 content.json + manifest.json
    let content;
    try {
        const cjson = zip.file('content.json');
        if (!cjson) return { ok: false, message: '基础包内未找到 content.json' };
        const text = await cjson.async('string');
        content = JSON.parse(text);
    } catch (err) {
        return { ok: false, message: 'content.json 解析失败：' + (err && err.message || err) };
    }

    let manifest = { 'file-entries': {} };
    try {
        const mjson = zip.file('manifest.json');
        if (mjson) {
            const t = await mjson.async('string');
            manifest = JSON.parse(t) || manifest;
            if (!manifest['file-entries']) manifest['file-entries'] = {};
        }
    } catch (_) { /* 解析失败兜底为空 */ }

    // 4) 收集 mm 数据：递归对齐 smm 节点 ↔ topic
    const smm = mm.getData();
    if (!Array.isArray(content) || !content.length) {
        return { ok: false, message: 'content.json 结构异常（非数组）' };
    }
    const sheet = content[0];
    if (!sheet || !sheet.rootTopic) {
        return { ok: false, message: 'content.json 缺少 rootTopic' };
    }

    // 用于样式池
    const stylePool = {}; // id -> { id, type:'topic', properties }
    let styleSeq = 0;

    // 附件 / 图片 任务队列（异步收集字节后塞入 zip）
    const pendingTasks = [];

    // 递归注入。topic 与 smmNode 应当一一对应；
    // 但为了健壮性，如果 children 数量不匹配，按下标兜底。
    const walk = (topic, smmNode) => {
        if (!topic || !smmNode || !smmNode.data) return;
        const d = smmNode.data;

        // ---- (a) style.properties ----
        const props = smmDataToStyleProps(d);
        if (props) {
            const styleId = topic.style && topic.style.id
                ? topic.style.id
                : ('s_' + (++styleSeq) + '_' + (d.uid || topic.id || 'x'));
            topic.style = { id: styleId, properties: props };
            stylePool[styleId] = { id: styleId, type: 'topic', properties: props };
        }

        // ---- (b) icon → markers + labels（基础包不会写 markers/labels；官方只写 labels=tag）----
        const labels = Array.isArray(topic.labels) ? topic.labels.slice() : [];
        const markers = Array.isArray(topic.markers) ? topic.markers.slice() : [];
        if (Array.isArray(d.icon) && d.icon.length) {
            for (const id of d.icon) {
                const mk = smmIconToXmindMarker(id);
                if (mk) {
                    if (!markers.find(x => x.markerId === mk)) markers.push({ markerId: mk });
                } else {
                    if (labels.indexOf(id) < 0) labels.push(id);
                }
            }
        }
        if (markers.length) topic.markers = markers;
        else delete topic.markers;
        if (labels.length) topic.labels = labels;

        // ---- (c) 附件 ----
        // smm 节点上的附件原始 URL 通常存在 d.mmAttachmentRaw / d.attachmentUrl。
        // **优先级**：官方导出器若已写 topic.href（来自 hyperlink），且节点没有附件，则保留；
        //             若节点同时有 hyperlink 与 attachment，附件优先（信息量更大）。
        // 另外：官方导出器把 topic.href 直接置为 d.hyperlink，对 webview URI（vscode-webview-resource://）
        // 在 XMind 中是不可读的。这里若 d.mmHyperlinkRaw 是干净的 http(s)/file/mailto/#，
        // 用它覆盖更友好。
        if (!d.mmAttachmentRaw && !d.attachmentUrl
            && topic.href
            && d.mmHyperlinkRaw
            && /^(https?:|file:|mailto:|#)/i.test(String(d.mmHyperlinkRaw))) {
            topic.href = String(d.mmHyperlinkRaw);
        }
        const attachRef = d.mmAttachmentRaw || d.attachmentUrl;
        if (attachRef) {
            // 异步读字节
            pendingTasks.push((async () => {
                try {
                    let url = attachRef;
                    // 如果是相对路径（不含协议），假定它是 md 同目录下文件——
                    // 但 webview 端只能通过已构造好的 webview URI 访问。
                    // 我们这里直接 fetch 原始 URL；webview 端的 smm 节点通常用的就是 webview URI，
                    // 不需要再做相对/绝对转换。
                    if (typeof url !== 'string') return;
                    const bytes = await fetchBytes(url);
                    if (!bytes || !bytes.length) {
                        // 读取失败 → 保留外链
                        topic.href = attachRef;
                        return;
                    }
                    const filename = safeFilename(
                        decodeURIComponentSafe(extractFilename(attachRef))
                    );
                    const inZipName = 'att_' + (d.uid || topic.id || (styleSeq++).toString()) + '_' + filename;
                    zip.file('attachments/' + inZipName, bytes);
                    manifest['file-entries']['attachments/' + inZipName] = {};
                    topic.href = 'xap:attachments/' + inZipName;
                } catch (e) {
                    console.warn('[xmind-export] attachment fetch failed', e);
                    topic.href = attachRef;
                }
            })());
        }

        // ---- (d) 递归子节点 ----
        const topicChildren = topic.children && Array.isArray(topic.children.attached)
            ? topic.children.attached
            : [];
        const smmChildren = Array.isArray(smmNode.children) ? smmNode.children : [];
        const n = Math.min(topicChildren.length, smmChildren.length);
        for (let i = 0; i < n; i++) walk(topicChildren[i], smmChildren[i]);
    };

    walk(sheet.rootTopic, smm);

    // 5) 等待附件任务完成
    if (pendingTasks.length > 0) {
        try {
            await Promise.all(pendingTasks);
        } catch (e) {
            console.warn('[xmind-export] some attachments failed', e);
        }
    }

    // 6) 写回 content.json
    zip.file('content.json', JSON.stringify(content));

    // 7) 写 styles.json（XMind ZEN 样式池）
    if (Object.keys(stylePool).length > 0) {
        zip.file('styles.json', JSON.stringify({ styles: stylePool }));
        manifest['file-entries']['styles.json'] = {};
    }

    // 8) 更新 manifest.json
    zip.file('manifest.json', JSON.stringify(manifest));

    // 9) 打包成 ArrayBuffer，转 base64
    let outBuf;
    try {
        outBuf = await zip.generateAsync({ type: 'arraybuffer' });
    } catch (err) {
        return { ok: false, message: 'JSZip 打包失败：' + (err && err.message || err) };
    }
    const base64 = uint8ToBase64(new Uint8Array(outBuf));
    return { ok: true, base64 };
}

// --- 辅助：从 URL 中粗暴抽取文件名 ---
function extractFilename(url) {
    if (!url || typeof url !== 'string') return 'file.bin';
    // 去 query/hash
    let u = url.split('#')[0].split('?')[0];
    // 取最后一段
    const slash = u.lastIndexOf('/');
    if (slash >= 0) u = u.slice(slash + 1);
    return u || 'file.bin';
}

function decodeURIComponentSafe(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
}
