/**
 * ============================================================================
 *  utils/xmindExporter.ts
 *  节点树 → .xmind 文件 导出器（XMind ZEN 格式）
 * ----------------------------------------------------------------------------
 *  XMind ZEN 文件格式（与 XMind 8 不同）：
 *    本质上是一个 ZIP，至少包含：
 *      - content.json    : 思维导图主体（数组：根 sheet）
 *      - metadata.json   : 元数据
 *      - manifest.json   : 资源清单
 *  我们只生成最小可用集，足以让 XMind 桌面端 / xmind.app 直接打开。
 *
 *  ZIP 写入：使用 STORE 模式（method=0，无压缩），免去 deflate 第三方依赖。
 *  ZIP STORE 文件体积仅在大量重复文本时才显著膨胀，思维导图 JSON 通常 <100KB，可接受。
 *  实现遵循 PKZIP APPNOTE.TXT，只生成 Local File Header + Central Directory + EOCD。
 * ============================================================================
 */

import type { MindmapNode } from './markdownMindmap';

// ============================================
// CRC32（ZIP 必填）
// ============================================
let _crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
    if (_crcTable) return _crcTable;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[n] = c >>> 0;
    }
    _crcTable = t;
    return t;
}
function crc32(data: Uint8Array): number {
    const table = getCrcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ============================================
// 二进制写工具
// ============================================
class BufWriter {
    private chunks: Uint8Array[] = [];
    private _len = 0;
    get length() { return this._len; }
    push(buf: Uint8Array) { this.chunks.push(buf); this._len += buf.length; }
    pushU16(v: number) { const b = new Uint8Array(2); b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; this.push(b); }
    pushU32(v: number) { const b = new Uint8Array(4); b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; b[2] = (v >>> 16) & 0xff; b[3] = (v >>> 24) & 0xff; this.push(b); }
    pushStr(s: string) { this.push(new TextEncoder().encode(s)); }
    toBuffer(): Uint8Array {
        const out = new Uint8Array(this._len);
        let off = 0;
        for (const c of this.chunks) { out.set(c, off); off += c.length; }
        return out;
    }
}

interface ZipEntry { name: string; data: Uint8Array; }

/**
 * 将多个文件打包为 ZIP（STORE 模式，无压缩）。
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
    const w = new BufWriter();
    interface CdInfo { name: Uint8Array; crc: number; size: number; localOffset: number; }
    const cdInfos: CdInfo[] = [];

    for (const e of entries) {
        const nameBytes = new TextEncoder().encode(e.name);
        const crc = crc32(e.data);
        const size = e.data.length;
        const localOffset = w.length;

        // Local File Header
        w.pushU32(0x04034b50);   // signature
        w.pushU16(20);           // version needed
        w.pushU16(0);            // flags
        w.pushU16(0);            // method = 0 (STORE)
        w.pushU16(0);            // mod time
        w.pushU16(0);            // mod date
        w.pushU32(crc);
        w.pushU32(size);         // compressed size
        w.pushU32(size);         // uncompressed size
        w.pushU16(nameBytes.length);
        w.pushU16(0);            // extra field length
        w.push(nameBytes);
        w.push(e.data);

        cdInfos.push({ name: nameBytes, crc, size, localOffset });
    }

    const cdStart = w.length;
    for (const info of cdInfos) {
        w.pushU32(0x02014b50);   // central dir signature
        w.pushU16(20);           // version made by
        w.pushU16(20);           // version needed
        w.pushU16(0);            // flags
        w.pushU16(0);            // method
        w.pushU16(0);            // mod time
        w.pushU16(0);            // mod date
        w.pushU32(info.crc);
        w.pushU32(info.size);
        w.pushU32(info.size);
        w.pushU16(info.name.length);
        w.pushU16(0);            // extra field length
        w.pushU16(0);            // comment length
        w.pushU16(0);            // disk number start
        w.pushU16(0);            // internal attrs
        w.pushU32(0);            // external attrs
        w.pushU32(info.localOffset);
        w.push(info.name);
    }
    const cdSize = w.length - cdStart;

    // End of Central Directory Record
    w.pushU32(0x06054b50);
    w.pushU16(0);            // disk number
    w.pushU16(0);            // disk where CD starts
    w.pushU16(cdInfos.length);
    w.pushU16(cdInfos.length);
    w.pushU32(cdSize);
    w.pushU32(cdStart);
    w.pushU16(0);            // comment length

    return w.toBuffer();
}

// ============================================
// 节点树 → XMind content.json
// ============================================

interface XMindTopic {
    id: string;
    title: string;
    children?: { attached: XMindTopic[] };
}

function nodeToTopic(node: MindmapNode): XMindTopic {
    const topic: XMindTopic = { id: node.id, title: node.title };
    if (node.children && node.children.length > 0) {
        topic.children = { attached: node.children.map(nodeToTopic) };
    }
    return topic;
}

/**
 * 将节点树构造为 .xmind 文件二进制内容。
 */
export function buildXmindFile(root: MindmapNode, sheetTitle: string = '思维导图'): Uint8Array {
    const rootTopic = nodeToTopic(root);
    const content = [
        {
            id: 'sheet_' + Date.now().toString(36),
            class: 'sheet',
            title: sheetTitle,
            rootTopic,
            topicPositioning: 'fixed',
        },
    ];
    const metadata = {
        creator: { name: 'TestCase Viewer', version: '1.0' },
        layoutEngineVersion: '3',
        activeSheetId: content[0].id,
    };
    const manifest = {
        'file-entries': {
            'content.json': {},
            'metadata.json': {},
        },
    };

    const enc = new TextEncoder();
    const entries: ZipEntry[] = [
        { name: 'content.json', data: enc.encode(JSON.stringify(content)) },
        { name: 'metadata.json', data: enc.encode(JSON.stringify(metadata)) },
        { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) },
    ];

    return buildZip(entries);
}

// ============================================
// 富节点 / 主题 → XMind ZEN 文件（含节点样式与画布背景）
// ============================================

/**
 * webview 端透传过来的"富节点"。
 * 仅包含可序列化的字段——所有 DOM 引用/函数都需要在 webview 端剥离。
 */
export interface XMindRichNode {
    id: string;
    text: string;                  // 节点文本（已去 HTML 标签的纯文本）

    // ----- 节点级样式（来自 simple-mind-map data.* 字段） -----
    fillColor?: string;            // 节点背景
    borderColor?: string;          // 节点边框
    borderWidth?: number;          // 节点边框宽度
    color?: string;                // 文字颜色
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: string | number;  // 'bold' | 400 | 700 ...
    fontStyle?: string;            // 'italic'
    textDecoration?: string;       // 'underline'
    shape?: string;                // 'rectangle' | 'roundedRectangle' | 'circle' | ...

    // ----- 富元素 -----
    image?: string;                // 已转 dataUrl 的图片（webview 端 fetch 成功时）
    imagePath?: string;            // 图片原始路径（mmImageRaw，相对或绝对路径；webview fetch 失败时由扩展端兜底读取）
    imageTitle?: string;
    imageSize?: { width?: number; height?: number };
    hyperlink?: string;            // 原始链接（mmHyperlinkRaw）
    hyperlinkTitle?: string;
    attachmentUrl?: string;        // 原始链接（mmAttachmentRaw）
    note?: string;                 // 备注
    tag?: string[];                // 标签
    icon?: string[];               // 图标 id 列表（XMind 无对应映射，转为标签兜底）

    children?: XMindRichNode[];
}

/**
 * 全局主题：取自 webview 的 window.__mmCurrentThemeStyle + mm.themeConfig。
 */
export interface XMindRichTheme {
    backgroundColor?: string;      // 画布背景
    lineColor?: string;            // 连线色
    lineWidth?: number;
    fontFamily?: string;
}

/**
 * 附件解析器：把 webview 传来的相对/绝对路径转换为可写入 .xmind 的字节流。
 * provider 端注入，便于 exporter 不直接依赖 fs。
 *   返回 null  → 解析失败（exporter 会回退到 href 模式）
 *   返回 bytes → exporter 会写入 resources/ 并以 xap:resources/ 引用
 */
export interface XMindAttachmentResolver {
    /**
     * @param ref webview 端透传的附件相对/绝对路径（已 URL 解码）
     * @returns 解析后的字节 + 建议文件名；解析失败返回 null
     */
    resolve(ref: string): { bytes: Uint8Array; filename: string } | null;
}

/**
 * simple-mind-map 的 layout → XMind ZEN structureClass。
 * 未在表中的 layout 走 logic.right 兜底。
 */
function layoutToStructureClass(layout: string | undefined): string {
    const m: Record<string, string> = {
        // 逻辑结构图（默认右）
        'logicalStructure': 'org.xmind.ui.logic.right',
        'logicalStructureLeft': 'org.xmind.ui.logic.left',
        // 思维导图（双侧）
        'mindMap': 'org.xmind.ui.map.unbalanced',
        // 组织结构图
        'organizationStructure': 'org.xmind.ui.org-chart.down',
        'catalogOrganization': 'org.xmind.ui.org-chart.up',
        // 目录结构 / 时间轴 / 鱼骨：XMind 无完全等价布局，统一回退到逻辑结构右
        'catalog': 'org.xmind.ui.logic.right',
        'timeline': 'org.xmind.ui.logic.right',
        'timeline2': 'org.xmind.ui.logic.right',
        'fishbone': 'org.xmind.ui.fishbone.rightHeaded',
        'verticalTimeline': 'org.xmind.ui.org-chart.down',
    };
    return m[String(layout || '')] || 'org.xmind.ui.logic.right';
}

/**
 * simple-mind-map 的 icon id → XMind ZEN markerId。
 *
 * 我们 webview 端的 token 命名规则（icons.js）：
 *   priority_<1..16>           - 优先级 1~16
 *   progress_<0|13|25|38|50|75|88|done|100>   - 进度饼图
 *   emotion_<smile|grin|laugh|haha|kiss|love|cool|wink|cry|angry|sleepy|surprised|nerd|sick|devil|shy>
 *   arrow_<up|right|down|left|leftRight|upDown|refresh|sync>
 *   flag_<red|orange|yellow|green|blue|purple|pink|gray>
 *   star_<red|orange|green|blue|purple|pink|gray>
 *   month_<jan..dec>           - 月份
 *   week_<sun..sat>            - 星期
 *   symbol_<check|cross|note|time|warn|info|question|idea|...> - 杂项
 *
 * XMind ZEN markers 官方 ID 体系（取自 marker-sheet.xml）：
 *   priority-1 ... priority-9
 *   task-start | task-oct | task-quarter | task-3oct | task-done
 *   smiley-smile | smiley-laugh | smiley-cry | smiley-surprise | smiley-boring | smiley-angry
 *   arrow-up | arrow-right | arrow-down | arrow-left | arrow-up-right | arrow-down-right | arrow-refresh
 *   flag-red | flag-orange | flag-yellow | flag-green | flag-blue | flag-purple | flag-dark-blue | flag-dark-gray
 *   star-red | star-orange | star-yellow | star-green | star-blue | star-purple | star-dark-blue | star-gray
 *   month-jan ... month-dec
 *   week-sun ... week-sat
 *   symbol-plus | symbol-minus | symbol-question | symbol-info | symbol-warning | symbol-pause | symbol-stop | symbol-wrong | symbol-right
 *   other-bomb | other-clock | other-fire | other-light-bulb | other-lock | other-pin | other-trophy | ...
 *
 * 覆盖率原则：能映射的全部映射；映射不上的（如 emotion 中的 kiss/nerd/sick/devil 等 XMind 没有）
 * 由调用方降级为 labels，保证信息不丢。
 */
function smmIconToXmindMarker(id: string): string | null {
    if (!id || typeof id !== 'string') return null;

    // ---- 1) Priority：priority_1 ... priority_16 → XMind 仅 1..9，>=10 截断到 9
    let m: RegExpExecArray | null;
    m = /^priority[_-](\d+)$/i.exec(id);
    if (m) {
        const n = Math.max(1, Math.min(9, parseInt(m[1], 10) || 1));
        return 'priority-' + n;
    }

    // ---- 2) Progress：progress_<percent> → task-<阶段>
    //   0 → task-start    13 → task-oct      25 → task-quarter
    //   38 → task-oct     50 → task-half     75 → task-3oct
    //   88 → task-3oct    100/done → task-done
    m = /^progress[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const pmap: Record<string, string> = {
            '0': 'task-start',
            '13': 'task-oct',
            '25': 'task-quarter',
            '38': 'task-oct',
            '50': 'task-half',
            '75': 'task-3oct',
            '88': 'task-3oct',
            '100': 'task-done',
            'done': 'task-done',
        };
        return pmap[k] || 'task-start';
    }

    // ---- 3) Emotion：emotion_<kind> → smiley-<kind>（XMind 仅有有限几个表情）
    m = /^emotion[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const emap: Record<string, string> = {
            'smile': 'smiley-smile',
            'grin': 'smiley-laugh',
            'laugh': 'smiley-laugh',
            'haha': 'smiley-laugh',
            'kiss': 'smiley-smile',
            'love': 'smiley-smile',
            'cool': 'smiley-smile',
            'wink': 'smiley-smile',
            'cry': 'smiley-cry',
            'angry': 'smiley-angry',
            'sleepy': 'smiley-boring',
            'surprised': 'smiley-surprise',
            'nerd': 'smiley-smile',
            'sick': 'smiley-cry',
            'devil': 'smiley-angry',
            'shy': 'smiley-smile',
        };
        return emap[k] || null;
    }

    // ---- 4) Arrow：arrow_<dir> → arrow-<dir>
    m = /^arrow[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const amap: Record<string, string> = {
            'up': 'arrow-up',
            'right': 'arrow-right',
            'down': 'arrow-down',
            'left': 'arrow-left',
            'leftright': 'arrow-up-right',  // XMind 没有横向双向，用斜向兜底
            'updown': 'arrow-up-right',
            'refresh': 'arrow-refresh',
            'sync': 'arrow-refresh',
        };
        return amap[k] || null;
    }

    // ---- 5) Flag：flag_<color> → flag-<color>
    m = /^flag[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const fmap: Record<string, string> = {
            'red': 'flag-red',
            'orange': 'flag-orange',
            'yellow': 'flag-yellow',
            'green': 'flag-green',
            'blue': 'flag-blue',
            'purple': 'flag-purple',
            'pink': 'flag-red',          // XMind 无 pink，退红
            'gray': 'flag-dark-gray',
        };
        return fmap[k] || 'flag-red';
    }

    // ---- 6) Star：star_<color> → star-<color>
    m = /^star[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const smap: Record<string, string> = {
            'red': 'star-red',
            'orange': 'star-orange',
            'yellow': 'star-yellow',
            'green': 'star-green',
            'blue': 'star-blue',
            'purple': 'star-purple',
            'pink': 'star-red',
            'gray': 'star-gray',
        };
        return smap[k] || 'star-red';
    }

    // ---- 7) Month：month_<jan..dec> → month-<jan..dec>
    m = /^month[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        if (months.indexOf(k) >= 0) return 'month-' + k;
        return null;
    }

    // ---- 8) Week：week_<sun..sat> → week-<sun..sat>
    m = /^week[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const weeks = ['sun','mon','tue','wed','thu','fri','sat'];
        if (weeks.indexOf(k) >= 0) return 'week-' + k;
        return null;
    }

    // ---- 9) Symbol（others 杂项）→ XMind symbol-* / other-*
    m = /^symbol[_-](.+)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const symap: Record<string, string> = {
            'check': 'symbol-right',
            'cross': 'symbol-wrong',
            'note': 'other-note',
            'time': 'other-clock',
            'warn': 'symbol-warning',
            'info': 'symbol-info',
            'question': 'symbol-question',
            'idea': 'other-light-bulb',
            'pie': 'other-pie',
            'gift': 'other-gift',
            'lock': 'other-lock',
            'unlock': 'other-key',
            'mail': 'other-email',
            'cloud': 'other-cloud',
            'gear': 'other-gear',
            'bulb': 'other-light-bulb',
            'book': 'other-book',
            'doc': 'other-note',
            'thumbup': 'other-thumb-up',
            'thumbdn': 'other-thumb-down',
            'comment': 'other-comment',
            'heart': 'other-heart',
            'leaf': 'other-leaf',
            'user': 'other-people',
            'pen': 'other-edit',
            'clip': 'other-clip',
            'flash': 'other-flash',
            'wave': 'other-wave',
        };
        return symap[k] || null;
    }

    // ---- 10) 兼容历史 token：task_done / flag_red 等
    m = /^task[_-](done|oct|quarter|3quar|started|half|0|1oct|2oct|3oct|4oct)$/i.exec(id);
    if (m) {
        const k = m[1].toLowerCase();
        const tmap: Record<string, string> = {
            '0': 'task-start', '1oct': 'task-oct', '2oct': 'task-quarter',
            '3oct': 'task-3oct', '4oct': 'task-done',
            'done': 'task-done', 'oct': 'task-oct', 'quarter': 'task-quarter',
            '3quar': 'task-3oct', 'started': 'task-start', 'half': 'task-half',
        };
        return tmap[k] || 'task-done';
    }
    m = /^people[_-]?(red|green|blue|orange|purple|yellow|pink|gray)$/i.exec(id);
    if (m) return 'people-' + m[1].toLowerCase();

    return null;
}

// ---- XMind ZEN content.json 内部类型 ----
interface XmTopicStyleProps {
    [k: string]: string | number | boolean;
}
interface XmTopicStyle {
    id?: string;
    properties?: XmTopicStyleProps;
}
interface XmMarker {
    markerId: string;
}
interface XmTopic {
    id: string;
    title: string;
    style?: XmTopicStyle;
    image?: { src: string; width?: number; height?: number };
    href?: string;                 // 超链接
    notes?: { plain?: { content: string } };
    labels?: string[];
    markers?: XmMarker[];          // XMind ZEN 图标
    structureClass?: string;       // 节点级布局（XMind 用根节点上的 structureClass 决定整图布局）
    children?: { attached: XmTopic[] };
}

/**
 * 把 webview 收集的节点样式翻译成 XMind ZEN 的 style.properties。
 * XMind ZEN 的 properties 字段使用 CSS-like 名称：
 *   svg:fill, line-pattern, line-class, fo:color, fo:font-size, fo:font-weight, ...
 * 我们只输出"非空"字段，避免覆盖 XMind 自身默认值。
 */
function nodeStyleToXmindProps(n: XMindRichNode): XmTopicStyleProps | undefined {
    const p: XmTopicStyleProps = {};

    if (n.fillColor && n.fillColor !== 'transparent') {
        p['svg:fill'] = n.fillColor;
    }
    if (n.borderColor) {
        p['border-line-color'] = n.borderColor;
    }
    if (typeof n.borderWidth === 'number' && n.borderWidth > 0) {
        p['border-line-width'] = String(n.borderWidth) + 'pt';
    }
    if (n.color) {
        p['fo:color'] = n.color;
    }
    if (n.fontFamily) {
        p['fo:font-family'] = n.fontFamily;
    }
    if (typeof n.fontSize === 'number' && n.fontSize > 0) {
        p['fo:font-size'] = String(n.fontSize) + 'pt';
    }
    if (n.fontWeight && n.fontWeight !== 'normal' && n.fontWeight !== 400) {
        p['fo:font-weight'] = String(n.fontWeight);
    }
    if (n.fontStyle && n.fontStyle !== 'normal') {
        p['fo:font-style'] = n.fontStyle;
    }
    if (n.textDecoration && n.textDecoration !== 'none') {
        p['fo:text-decoration'] = n.textDecoration;
    }
    // 形状映射：simple-mind-map 的 shape 名 → XMind shape-class
    if (n.shape) {
        const m: Record<string, string> = {
            'rectangle': 'org.xmind.topicShape.rectangle',
            'roundedRectangle': 'org.xmind.topicShape.roundedRect',
            'ellipse': 'org.xmind.topicShape.ellipse',
            'circle': 'org.xmind.topicShape.ellipse',
            'diamond': 'org.xmind.topicShape.diamond',
        };
        const x = m[n.shape];
        if (x) p['shape-class'] = x;
    }

    return Object.keys(p).length > 0 ? p : undefined;
}

/**
 * 富节点 → XMind topic。
 *
 * 注意：
 *  - image：webview 透传 data:URL，会拆出到 resources/ 并用 xap:resources/ 引用。
 *  - icon：能映射成 XMind markers 的优先用 markers；否则降级为 labels。
 *  - attachmentUrl：通过 resolver 读出本地文件 → 写入 resources/，topic.href
 *    使用 xap:resources/<filename> 形式，让 XMind 当成内嵌附件处理（而非外链）。
 */
function richToTopic(
    n: XMindRichNode,
    resources: Map<string, Uint8Array>,
    attachmentResolver?: XMindAttachmentResolver,
    structureClass?: string,
    isRoot: boolean = false,
): XmTopic {
    const topic: XmTopic = {
        id: n.id,
        title: n.text || '',
    };

    // **关键**：与 simple-mind-map 官方 transformToXmind 对齐 —— 仅在**根节点**上写 structureClass，
    // 子节点上不写。实测 XMind 看到子节点带 structureClass 时，会回退到默认布局（mindMap unbalanced
    // 双向）。这就是之前"逻辑结构图右"被拆成两侧的真正原因。
    if (isRoot && structureClass) topic.structureClass = structureClass;

    const props = nodeStyleToXmindProps(n);
    if (props) topic.style = { id: 's_' + n.id, properties: props };

    if (n.image || n.imagePath) {
        // 优先用 webview 端已成功转好的 dataUrl
        let imgBytes: Uint8Array | null = null;
        let ext = 'png';
        if (n.image) {
            const meta = extractDataUrl(n.image);
            if (meta) {
                imgBytes = meta.bytes;
                ext = meta.ext;
            }
        }
        // dataUrl 失败时，尝试通过 resolver 从原始路径读取（webview 端 fetch 失败时的兜底）
        if (!imgBytes && n.imagePath && attachmentResolver) {
            const resolved = attachmentResolver.resolve(n.imagePath);
            if (resolved && resolved.bytes && resolved.bytes.length > 0) {
                imgBytes = resolved.bytes;
                const dot = resolved.filename.lastIndexOf('.');
                if (dot >= 0) {
                    const e = resolved.filename.slice(dot + 1).toLowerCase();
                    if (e === 'jpeg') ext = 'jpg';
                    else if (e) ext = e;
                }
            }
        }
        if (imgBytes) {
            const name = 'image_' + n.id + '.' + ext;
            resources.set('resources/' + name, imgBytes);
            topic.image = {
                src: 'xap:resources/' + name,
                width: n.imageSize?.width,
                height: n.imageSize?.height,
            };
        }
        // 非 dataUrl 且 resolver 也读不到的原始 URI 在 .xmind 中无法加载（文件不会包含该文件），
        // 为避免 XMind 上变为"破图占位"进而干扰布局，直接丢弃 image 字段。
    }

    // hyperlink 与 attachmentUrl 二选一；附件优先用 attachments/ 子目录 + xap:attachments/ 协议
    // （XMind ZEN 区分：xap:resources/ 是资源库，附件需走 attachments/ 子目录）
    if (n.hyperlink) {
        topic.href = n.hyperlink;
    } else if (n.attachmentUrl) {
        const resolved = attachmentResolver ? attachmentResolver.resolve(n.attachmentUrl) : null;
        if (resolved && resolved.bytes && resolved.bytes.length > 0) {
            const safe = resolved.filename.replace(/[\\/:*?"<>|]/g, '_');
            const name = 'att_' + n.id + '_' + safe;
            resources.set('attachments/' + name, resolved.bytes);
            // XMind ZEN 内嵌附件协议
            topic.href = 'xap:attachments/' + name;
        } else {
            // 解析失败（文件不存在）→ 仍用原路径作为兜底，但加 notes 说明便于排查
            topic.href = n.attachmentUrl;
            if (!n.note) {
                topic.notes = { plain: { content: '[附件原路径] ' + n.attachmentUrl } };
            }
        }
    }

    if (n.note && !topic.notes) {
        topic.notes = { plain: { content: n.note } };
    }

    // 图标 → markers / labels 拆分
    const labels: string[] = [];
    const markers: XmMarker[] = [];
    if (n.tag && n.tag.length) labels.push(...n.tag);
    if (n.icon && n.icon.length) {
        for (const id of n.icon) {
            const mk = smmIconToXmindMarker(id);
            if (mk) markers.push({ markerId: mk });
            else labels.push(id); // 无法映射的图标降级为标签
        }
    }
    if (labels.length) topic.labels = labels;
    if (markers.length) topic.markers = markers;

    if (n.children && n.children.length > 0) {
        topic.children = {
            attached: n.children.map(c => richToTopic(c, resources, attachmentResolver, structureClass, false)),
        };
    }
    return topic;
}

/**
 * 解析 data:image/xxx;base64,XXXX → { ext, bytes }
 */
function extractDataUrl(url: string): { ext: string; bytes: Uint8Array } | null {
    const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/i.exec(url);
    if (!m) return null;
    let ext = m[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (ext === 'svg+xml') ext = 'svg';
    try {
        const bin = Buffer.from(m[2], 'base64');
        return { ext, bytes: new Uint8Array(bin) };
    } catch (_) {
        return null;
    }
}

/**
 * 构建 .xmind 文件（带主题/节点样式版本）。
 *
 * @param richRoot   webview 收集的富节点树（包含每节点的 style、富元素）
 * @param theme      全局主题（背景色 / 连线色 / 字体）
 * @param sheetTitle sheet 标签名
 * @param layout     simple-mind-map 当前布局名，用于映射 structureClass
 * @param attachmentResolver  附件路径 → 文件字节解析器（provider 注入；可缺省）
 */
/**
 * 收集 topic 树中所有 style，去重后构建 styles.json 的样式池。
 *
 * XMind ZEN 样式系统的事实标准（v3 layoutEngine）：
 *   - 节点引用样式：topic.style = { id: 's_xxx', properties: {...} }
 *   - 但 properties **只有在样式池能找到 id 时**才会被 XMind 应用，否则被忽略
 *   - 主题包（sheet.theme）会把 id 注入到样式池，但同时它会带 map.structureClass 等
 *     **布局指令**，从而覆盖根节点的 structureClass —— 这是我们必须避免的
 *   - 独立的 styles.json 是 XMind ZEN 官方支持的样式池容器（与主题包平级），
 *     只承载样式定义，不携带布局/主题语义，因此能解耦"配色"与"布局"
 *
 * 输出 styles.json 结构：
 * {
 *   "styles": {
 *     "s_xxx": { "id": "s_xxx", "type": "topic", "properties": { ... } },
 *     ...
 *   }
 * }
 */
interface XmStyleEntry {
    id: string;
    type: 'topic';
    properties: XmTopicStyleProps;
}
function collectStyles(topic: XmTopic, out: Map<string, XmStyleEntry>): void {
    if (topic.style && topic.style.id && topic.style.properties) {
        if (!out.has(topic.style.id)) {
            out.set(topic.style.id, {
                id: topic.style.id,
                type: 'topic',
                properties: topic.style.properties,
            });
        }
    }
    if (topic.children && topic.children.attached) {
        for (const c of topic.children.attached) collectStyles(c, out);
    }
}

export function buildXmindFileRich(
    richRoot: XMindRichNode,
    theme: XMindRichTheme,
    sheetTitle: string = '思维导图',
    layout?: string,
    attachmentResolver?: XMindAttachmentResolver,
): Uint8Array {
    const resources = new Map<string, Uint8Array>();
    const structureClass = layoutToStructureClass(layout);
    // 仅在根节点上写 structureClass（与 simple-mind-map 官方对齐，避免子节点重复写导致 XMind 回退默认布局）
    const rootTopic = richToTopic(richRoot, resources, attachmentResolver, structureClass, true);
    // 根节点上额外打上 class: 'topic'——simple-mind-map 官方导出器在 isRoot 时也这么写，
    // 载体文件有这个标记后 XMind 才会严格按 structureClass 走布局。
    (rootTopic as any).class = 'topic';

    // 收集节点样式池：去重后写入独立 styles.json（方案 C）。
    // 与 sheet.theme 解耦——既能让 XMind 应用配色，又不会触发布局覆盖。
    const styleMap = new Map<string, XmStyleEntry>();
    collectStyles(rootTopic, styleMap);
    const stylesPayload: { styles: Record<string, XmStyleEntry> } = { styles: {} };
    for (const [id, entry] of styleMap) stylesPayload.styles[id] = entry;

    const sheetId = 'sheet_' + Date.now().toString(36);
    const sheet: any = {
        id: sheetId,
        class: 'sheet',
        title: sheetTitle,
        rootTopic,
        // 注意：不写 topicPositioning: 'fixed' —— 该字段意味着"使用 topic.position 坐标定位"，
        // 但我们并未为每个 topic 提供 position，于是 XMind / 预览器会把节点堆到 (0,0) 附近
        // 造成布局错乱。改为不写该字段，让 XMind 按 structureClass 走自动布局。
        coreVersion: '2.100.0',
        extensions: [],
    };
    // 不在 sheet 上挂 theme 字段：实测一旦出现 theme，XMind 会优先按主题包内默认值
    // （mindMap unbalanced，双向布局）解析整图，覆盖 rootTopic.structureClass。
    // 节点配色 / 字体 / 形状改由独立的 styles.json 承载（XMind ZEN 官方支持的样式池容器）。

    const content = [sheet];
    // metadata 与simple-mind-map对齐，添加 XMind 识别所需的完整字段
    const metadata = {
        modifier: '',
        dataStructureVersion: '2',
        creator: { name: 'mind-map' },
        layoutEngineVersion: '3',
        activeSheetId: sheetId,
    };

    // manifest 必须列出所有非 metadata/content 的资源
    const fileEntries: Record<string, unknown> = {
        'content.json': {},
        'content.xml': {},
        'metadata.json': {},
        'styles.json': {},
        'Thumbnails/thumbnail.png': {},
    };
    for (const key of resources.keys()) fileEntries[key] = {};
    const manifest = { 'file-entries': fileEntries };

    const enc = new TextEncoder();
    // 关键修复：XMind 在打开 .xmind 文件时，会优先用 content.json 判断结构，
    // 但当 content.xml 也存在时，XMind 会以 content.xml 中的 structure-class 为"权威值"
    // 校验 content.json 的布局信号是否一致 —— 不一致时回退默认（mindMap unbalanced 双向）。
    // 因此 content.xml 必须真实写出与 content.json 同样的根节点与 structure-class。
    const rootTitle = escapeXmlText(String(richRoot.text || sheetTitle));
    const contentXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
        '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" ' +
        'xmlns:fo="http://www.w3.org/1999/XSL/Format" ' +
        'xmlns:svg="http://www.w3.org/2000/svg" ' +
        'xmlns:xhtml="http://www.w3.org/1999/xhtml" ' +
        'xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">' +
        `<sheet id="${sheetId}_xml">` +
        `<topic id="${(rootTopic.id || sheetId) + '_xml'}" structure-class="${structureClass}">` +
        `<title>${rootTitle}</title>` +
        `</topic>` +
        `<title>${escapeXmlText(sheetTitle)}</title>` +
        `</sheet>` +
        '</xmap-content>';

    const entries: ZipEntry[] = [
        { name: 'content.json', data: enc.encode(JSON.stringify(content)) },
        { name: 'content.xml', data: enc.encode(contentXml) },
        { name: 'metadata.json', data: enc.encode(JSON.stringify(metadata)) },
        { name: 'styles.json', data: enc.encode(JSON.stringify(stylesPayload)) },
        { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) },
    ];
    for (const [name, bytes] of resources) {
        entries.push({ name, data: bytes });
    }

    return buildZip(entries);
}

/**
 * XML 文本节点转义。仅在生成 content.xml 时使用。
 */
function escapeXmlText(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}