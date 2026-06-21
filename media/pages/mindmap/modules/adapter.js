// ============================================================================
// modules/adapter.js
// ----------------------------------------------------------------------------
// 数据适配层：
//   - MindmapNode（扩展端业务树）↔ simpleMindMap data（渲染层）双向转换
//   - 富元素提取（title 中的 emoji / 链接 / 图片）与回写
//   - HTML ↔ 纯文本（richText 模式下 data.text 是 HTML）
//   - collectNodeStyles：从当前 smm 收集所有节点样式快照（供持久化）
//   - reapplyPendingNodeStyles：渲染结束后把保存的样式补涂回节点
// ============================================================================

import { ctx, NODE_STYLE_KEYS, loadNodeStylesMap, makeChildKey, nodeStylesKey } from './ctx.js';
import { isIconToken } from '../icons.js';
import { resolveAssets } from './assets.js';

/**
 * 解析 MindmapNode.title，分离出富元素：
 *   "🚀 部署"        → { text:"部署", icon:["🚀"] }
 *   "[文档](https://...)"  → { text:"文档", hyperlink:"https://...", hyperlinkTitle:"文档" }
 *   "![](attachments/x.png)"   → { text:"", image:"attachments/x.png" }
 *   "[📎 file.pdf](attachments/file.pdf)" → { text:"📎 file.pdf", hyperlink:"attachments/file.pdf"（被识别为附件） }
 *
 * 不在这里解析 markdown，只做最小提取，让富元素显示出来；其他部分原样作为 text。
 */
const RE_MD_IMG = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const RE_MD_LINK = /^\[([^\]]+)\]\(([^)]+)\)\s*$/;
// 子串：开头的 ![alt](src) ，后面允许有剩余文本
const RE_MD_IMG_LEAD = /^!\[([^\]]*)\]\(([^)]+)\)\s*/;
// 子串：开头的 [text](url) ，后面允许有剩余文本
const RE_MD_LINK_LEAD = /^\[([^\]]+)\]\(([^)]+)\)\s*/;

// 解码 md URL 中的 %20 → 空格（仅相对路径，跳过 http/data 类）；用于内部相对路径匹配与显示。
function decodeMdUrl(u) {
    if (!u) return '';
    if (/^(https?:|data:|file:|mailto:|#)/i.test(u)) return u;
    try { return decodeURI(u); } catch (_) { return u; }
}
// 编码 md URL 中的空格为 %20（仅相对路径）；用于写回 md，让 vscode markdown 预览能正确识别。
function encodeMdUrl(u) {
    if (!u) return '';
    if (/^(https?:|data:|file:|mailto:|#)/i.test(u)) return u;
    return String(u).replace(/ /g, '%20');
}
// 行首一连串 emoji（基于 Unicode 拓展类）
const RE_LEAD_EMOJI = /^([\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u200D\uFE0F]+)\s*/u;
// 行首图标 token：:type_name: （如 :priority_1: :flag_red: :sym_check:）
const RE_LEAD_TOKEN = /^((?::[a-z][a-z0-9]*_[a-z0-9]+:\s*)+)/i;

export function extractRichFromTitle(title) {
    let t = String(title || '').trim();
    const out = { text: t, icon: [], hyperlink: '', hyperlinkTitle: '', image: '', imageTitle: '' };

    // 整行图片（向后兼容旧 md：纯图片行）
    const mImgFull = RE_MD_IMG.exec(t);
    if (mImgFull) {
        out.text = '';
        out.imageTitle = mImgFull[1] || '';
        out.image = mImgFull[2];
        return out;
    }
    // 整行链接（向后兼容旧 md：纯链接行）
    const mLinkFull = RE_MD_LINK.exec(t);
    if (mLinkFull) {
        const linkText = mLinkFull[1];
        out.hyperlink = mLinkFull[2];
        out.hyperlinkTitle = linkText;
        // 附件场景（📎 前缀）：节点 text 留空，仅靠原生 attachment 图标展示，避免双重 📎
        if (/^📎\s*/.test(linkText)) {
            out.text = '';
        } else {
            out.text = linkText;
        }
        return out;
    }
    // 行首图标 token（连续多个）
    const mTok = RE_LEAD_TOKEN.exec(t);
    if (mTok && mTok[1]) {
        const tokens = mTok[1].match(/:([a-z][a-z0-9]*_[a-z0-9]+):/gi) || [];
        tokens.forEach(tk => {
            const inner = tk.slice(1, -1);
            if (isIconToken(inner)) out.icon.push(inner);
            else out.icon.push(tk); // 不识别就原样保留为图标占位（防丢）
        });
        t = t.slice(mTok[0].length).replace(/^\s+/, '');
    }
    // 行首 emoji（与 token 可共存）
    const mEmo = RE_LEAD_EMOJI.exec(t);
    if (mEmo && mEmo[1]) {
        out.icon.push(mEmo[1]);
        t = t.slice(mEmo[0].length).replace(/^\s+/, '');
    }
    // 剥离 icon 后再尝试匹配 image —— 先看行首，再退而求其次扫描整段中的第一个 ![](...)，
    // 以兼容"文字在前、图片在后"等任意位置的图片。
    const mImgLead = RE_MD_IMG_LEAD.exec(t);
    if (mImgLead) {
        out.imageTitle = mImgLead[1] || '';
        out.image = decodeMdUrl(mImgLead[2]);
        t = t.slice(mImgLead[0].length).replace(/^\s+/, '');
    } else {
        const mImgAny = /!\[([^\]]*)\]\(([^)]+)\)/.exec(t);
        if (mImgAny) {
            out.imageTitle = mImgAny[1] || '';
            out.image = decodeMdUrl(mImgAny[2]);
            t = (t.slice(0, mImgAny.index) + t.slice(mImgAny.index + mImgAny[0].length))
                .replace(/\s+/g, ' ')
                .trim();
        }
    }
    // 再尝试 link —— 同样兼容非行首位置
    const mLinkLead = RE_MD_LINK_LEAD.exec(t);
    if (mLinkLead) {
        out.hyperlinkTitle = mLinkLead[1];
        out.hyperlink = decodeMdUrl(mLinkLead[2]);
        t = t.slice(mLinkLead[0].length).replace(/^\s+/, '');
    } else {
        // 注意：image 已经被剥离，剩余的 [..](..) 才是 link
        const mLinkAny = /\[([^\]]+)\]\(([^)]+)\)/.exec(t);
        if (mLinkAny) {
            out.hyperlinkTitle = mLinkAny[1];
            out.hyperlink = decodeMdUrl(mLinkAny[2]);
            t = (t.slice(0, mLinkAny.index) + t.slice(mLinkAny.index + mLinkAny[0].length))
                .replace(/\s+/g, ' ')
                .trim();
        }
    }
    out.text = t;
    return out;
}

// ------------------------------------------------------------------
// HTML ↔ 纯文本（richText 模式下，节点 data.text 是 HTML）
// ------------------------------------------------------------------
/**
 * 把引擎生成的 HTML 文本转为纯文本（用于回写 md）。
 * 规则：
 *   - <br> / </p> / </div> 视为换行；
 *   - 其它标签剥除，保留文字；
 *   - 解码 HTML 实体；
 *   - 去掉首尾空白与连续空行。
 */
export function htmlToPlain(html) {
    if (html == null) return '';
    const s = String(html);
    // 没有任何标签直接返回（例如新建节点初始就是纯文本）
    if (s.indexOf('<') < 0) return s;
    // 用一个 div 解析，textContent 自动解码实体
    let normalized = s
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n');
    const div = document.createElement('div');
    div.innerHTML = normalized;
    let text = div.textContent || '';
    // 去掉两端空白；将连续 3 个以上换行压成 2 个
    text = text.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return text;
}

/**
 * 把纯文本包装为引擎可接受的最小 HTML（注入到 data.text）。
 * 规则：转义 < > & ，按 \n 拆段，每段一个 <p>。
 */
export function plainToHtml(text) {
    // <p> 自带浏览器默认 margin（约 1em），在 SVG <foreignObject> 内会被
    // 引擎按"压扁后的高度"估算，导致文字显示不全。这里通过 inline style
    // 强制 margin:0 / line-height:1.4，并允许换行换断；同时在 style.css 里
    // 也兜底了一份全局规则。
    const STYLE = 'margin:0;padding:0;line-height:1.4;white-space:pre-wrap;word-break:break-word;';
    if (text == null) return `<p style="${STYLE}"></p>`;
    const s = String(text);
    if (!s) return `<p style="${STYLE}"></p>`;
    const escape = (t) => t
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const lines = s.split(/\n/);
    return lines.map(l => `<p style="${STYLE}">${escape(l) || '<br>'}</p>`).join('');
}

/**
 * 反向：把 simpleMindMap 节点的富元素回写到 MindmapNode.title 字符串。
 * 组合规则（保证可逆 & 信息无丢失）：
 *   片段顺序：[icons] [image] [hyperlink-or-text]
 *   - icons：`:token:` 或 emoji 直接输出
 *   - image：`![imageTitle](image)`
 *   - hyperlink：`[hyperlinkTitle](hyperlink)`；若没有 hyperlink，则输出纯 text
 *   - 多段以空格分隔
 *   - 三者都不存在时，回退为 ''
 * 这样保证序列化回 md 时，富元素仍然可被人类阅读 / 再次打开后还能识别。
 */
function buildTitleFromSmm(d) {
    const parts = [];

    // 1) icons（行首图标 token / emoji）
    const icons = Array.isArray(d.icon) ? d.icon : [];
    if (icons.length) {
        const iconStr = icons.map(it => isIconToken(it) ? `:${it}:` : it).join(' ');
        parts.push(iconStr);
    }

    // 2) image（独立片段，不再吞掉后续文字）—— URL 空格转义为 %20，便于 md 预览
    //    注意：data:image/...;base64 形态的内嵌图绝不能写进 md（会让 md 文件巨大臃肿），
    //    这种节点序列化时直接跳过 image 字段，节点文本仍正常输出。
    if (d.image && !/^data:/i.test(d.image)) {
        parts.push(`![${d.imageTitle || ''}](${encodeMdUrl(d.image)})`);
    }

    // 3) 节点文本（永远独立输出，不再被链接/附件吞掉）
    if (d.text != null && String(d.text).length > 0) {
        parts.push(String(d.text));
    }

    // 4) hyperlink（链接）
    if (d.hyperlink) {
        const txt = d.hyperlinkTitle || d.hyperlink;
        parts.push(`[${txt}](${encodeMdUrl(d.hyperlink)})`);
    }

    // 5) attachment（附件，独立片段，📎 前缀，区别于普通链接）
    if (d.attachmentUrl) {
        const name = d.attachmentName || '附件';
        parts.push(`[📎 ${name}](${encodeMdUrl(d.attachmentUrl)})`);
    }

    return parts.join(' ').trim();
}

function walk(node, fn) {
    fn(node);
    (node.children || []).forEach(c => walk(c, fn));
}

/**
 * MindmapNode → simpleMindMap data
 *   异步：因为图片/附件需要把相对路径解析为 webview 可访问 URI
 */
export async function mindmapNodeToSmm(root) {
    // 第一遍：收集所有需要解析的资源相对路径
    const rels = new Set();
    walk(root, n => {
        const r = extractRichFromTitle(n.title);
        if (r.image && !/^(https?:|data:|file:)/i.test(r.image)) rels.add(r.image);
        if (r.hyperlink && !/^(https?:|data:|file:|mailto:|#)/i.test(r.hyperlink)) rels.add(r.hyperlink);
    });
    const relMap = await resolveAssets([...rels]);

    // 加载本文件保存的节点样式（按 nodePath 查询）
    const stylesMap = loadNodeStylesMap();
    let _matchedCount = 0;
    const _builtPaths = [];

    function build(node, path) {
        _builtPaths.push(path);
        const r = extractRichFromTitle(node.title);
        const d = {
            uid: node.id,
            // richText 模式：text 必须是 HTML
            text: plainToHtml(r.text),
            richText: true,
            expand: true,
            // 用 mmKind 自定义字段记忆节点类型，回流时还原
            mmKind: node.kind,
            // 写入节点身份路径，供后续 collectNodeStyles 回收时使用（保证双向一致）
            mmStylePath: path,
        };
        if (r.icon.length) d.icon = r.icon;
        // 合并持久化的节点样式（不写入 md，仅在 webview 端还原视觉）
        const saved = stylesMap[path];
        if (saved && typeof saved === 'object') {
            for (const k of NODE_STYLE_KEYS) {
                if (saved[k] !== undefined && saved[k] !== '' && saved[k] !== null) {
                    d[k] = saved[k];
                }
            }
            _matchedCount++;
        }

        // 判定：链接的 hyperlinkTitle 若以 📎 开头，则视为附件（区别图标）
        const isAttach = r.hyperlink && /^📎\s*/.test(r.hyperlinkTitle || '');
        if (isAttach) {
            const url = relMap.get(r.hyperlink) || r.hyperlink;
            d.attachmentUrl = url;
            d.attachmentName = String(r.hyperlinkTitle || '').replace(/^📎\s*/, '');
            d.mmAttachmentRaw = r.hyperlink;
        } else if (r.hyperlink) {
            const url = relMap.get(r.hyperlink) || r.hyperlink;
            d.hyperlink = url;
            d.hyperlinkTitle = r.hyperlinkTitle;
            d.mmHyperlinkRaw = r.hyperlink;
        }
        if (r.image) {
            const url = relMap.get(r.image) || r.image;
            d.image = url;
            d.imageTitle = r.imageTitle;
            d.mmImageRaw = r.image;
            // 给定一个默认尺寸，避免巨图撑爆节点
            d.imageSize = { width: 200, height: 150 };
        }
        // 递归子节点：维护同级 plainTitle 序号，生成稳定 nodePath
        const seen = [];
        const children = (node.children || []).map(c => {
            const plain = (extractRichFromTitle(c.title).text) || '';
            const key = makeChildKey(seen, plain);
            seen.push(plain);
            return build(c, path ? (path + '/' + key) : key);
        });
        return { data: d, children };
    }
    const result = build(root, '');
    // 缓存映射，供 mm 渲染结束后补涂样式（光把字段写到 data 上 simple-mind-map
    // 不会自动重绘 SVG；必须再走一次 renderer.setNodeStyles 才能让样式真正生效）
    ctx._pendingNodeStylesMap = stylesMap;
    try {
        const totalKeys = Object.keys(stylesMap).length;
        console.log('[mm] node-styles restored: ' + _matchedCount + '/' + totalKeys + ' from ' + nodeStylesKey());
        if (totalKeys > 0) {
            console.log('[mm] stored keys:', Object.keys(stylesMap));
            const k0 = Object.keys(stylesMap)[0];
            console.log('[mm] stored sample:', k0, '=>', stylesMap[k0]);
        }
        console.log('[mm] built paths:', _builtPaths);
        // 找出不匹配的：哪些 stored key 没出现在 builtPaths
        const builtSet = new Set(_builtPaths);
        const missing = Object.keys(stylesMap).filter(k => !builtSet.has(k));
        if (missing.length) console.warn('[mm] stored keys NOT found in built tree:', missing);
    } catch (_) {}
    return result;
}

// 渲染结束后把保存的节点样式重新涂到节点上。
// 为什么必须做这一步：mindmapNodeToSmm 已经把样式字段写进了 data，但 simple-mind-map
// 的节点 SVG 样式由 renderer 在 render 时按主题/节点 style API 决定，单写 data 字段
// 不会触发节点 shape 重绘。必须再调一次 renderer.setNodeStyles。
export function reapplyPendingNodeStyles() {
    const mm = ctx.mm;
    if (!mm || !ctx._pendingNodeStylesMap) return;
    const map = ctx._pendingNodeStylesMap;
    if (!Object.keys(map).length) return;
    let applied = 0;
    try {
        const root = mm.renderer && mm.renderer.root;
        if (!root) return;
        function walk(node) {
            if (!node) return;
            const d = (node.nodeData && node.nodeData.data) || {};
            const path = d.mmStylePath;
            const styles = (typeof path === 'string') ? map[path] : null;
            if (styles && typeof styles === 'object') {
                const pick = {};
                let has = false;
                for (const k of NODE_STYLE_KEYS) {
                    if (styles[k] !== undefined && styles[k] !== '' && styles[k] !== null) {
                        pick[k] = styles[k];
                        has = true;
                    }
                }
                if (has) {
                    try { mm.renderer.setNodeStyles(node, pick); applied++; } catch (_) {}
                }
            }
            (node.children || []).forEach(walk);
        }
        walk(root);
    } catch (e) { console.warn('[mm] reapplyPendingNodeStyles failed', e); }
    try { console.log('[mm] node-styles re-painted: ' + applied + ' nodes'); } catch (_) {}
    // 用完即清，避免对后续无关 render 反复回涂
    ctx._pendingNodeStylesMap = null;
}

/**
 * simpleMindMap data → MindmapNode（用于 data_change 后回写 md）
 */
export function smmToMindmapNode(smm, parentDepth = -1) {
    const d = smm.data || {};
    const depth = parentDepth + 1;
    // 还原原始 md 链接/图片路径
    // richText 模式下 d.text 是 HTML，写回 md 前先转纯文本
    const plainText = htmlToPlain(d.text || '');
    const dForTitle = {
        text: plainText,
        icon: Array.isArray(d.icon) ? d.icon : [],
        hyperlink: d.mmHyperlinkRaw || d.hyperlink || '',
        hyperlinkTitle: d.hyperlinkTitle || '',
        image: d.mmImageRaw || d.image || '',
        imageTitle: d.imageTitle || '',
        attachmentUrl: d.mmAttachmentRaw || d.attachmentUrl || '',
        attachmentName: d.attachmentName || '',
    };
    const node = {
        id: d.uid || ('n_' + Math.random().toString(36).slice(2)),
        title: buildTitleFromSmm(dForTitle),
        depth,
        // mmKind 在 init 时写入；新建的节点没有，按位置推断
        kind: d.mmKind || (depth === 0 ? 'root' : 'heading'),
        children: (smm.children || []).map(c => smmToMindmapNode(c, depth)),
    };
    return node;
}

// 从当前 mm 中收集所有节点样式快照（key=nodePath, value=样式 dict）
// 身份优先用节点 data.mmStylePath（mindmapNodeToSmm 下发时写入），保证双向路径严格一致
export function collectNodeStyles(smmRoot) {
    const map = {};
    function walkSmm(node, fallbackPath) {
        const d = (node && node.data) || {};
        const path = (typeof d.mmStylePath === 'string') ? d.mmStylePath : fallbackPath;
        const picked = {};
        let hasAny = false;
        for (const k of NODE_STYLE_KEYS) {
            const v = d[k];
            if (v !== undefined && v !== '' && v !== null) {
                picked[k] = v;
                hasAny = true;
            }
        }
        if (hasAny) map[path] = picked;
        const seen = [];
        (node.children || []).forEach(c => {
            const cd = (c && c.data) || {};
            const plain = htmlToPlain(cd.text || '');
            const key = makeChildKey(seen, plain);
            seen.push(plain);
            walkSmm(c, path ? (path + '/' + key) : key);
        });
    }
    walkSmm(smmRoot, '');
    return map;
}
