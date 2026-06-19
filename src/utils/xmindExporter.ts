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
