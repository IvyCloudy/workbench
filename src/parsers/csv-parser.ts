/**
 * ============================================================================
 *  parsers/csv-parser.ts
 *  CSV 解析器实现
 * ----------------------------------------------------------------------------
 *  职责：CSV 文件读取、分隔符推推、带引号字段解析、反向编码与转义。
 *  sourceData 返回 null：CSV 没有嵌套结构，无需保留原始对象。
 *  设计点：detectDelimiter 会从 , ; \t | 中选出出现次数 >=2 且最多的分隔符。
 * ============================================================================
 */
import * as fs from 'fs';
import type { TableData } from '../types';
import type { FileParser, FileParseResult } from './file-parser';

// ============================================
// CSV 解析器
// ============================================

export class CsvFileParser implements FileParser {
    async parse(filePath: string): Promise<FileParseResult> {
        try {
            const buffer = await fs.promises.readFile(filePath);
            let content = this.decodeBuffer(buffer);
            const result = this.parseCsvContent(content);
            return {
                tableData: result || { headers: [], rows: [] },
                sourceData: null
            };
        } catch (e: any) {
            throw new Error(`CSV 解析失败: ${e.message}`);
        }
    }

    /**
     * 多编码兼容解码器：覆盖常见中文 CSV 编码格式
     *
     * 决策优先级：
     *   1. BOM 检测：EF BB BF → UTF-8 / FF FE → UTF-16 LE / FE FF → UTF-16 BE
     *   2. 无 BOM 时先尝试 UTF-8，检测替换字符 � 占比 > 5% 则认为解码失败
     *   3. 回退到 GBK（国内最常见的 CSV 编码）
     *   4. 最终去除字符串前导 BOM 字符 (\uFEFF)
     */
    private decodeBuffer(buffer: Buffer): string {
        const stripBom = (str: string): string => {
            if (str.charCodeAt(0) === 0xFEFF) { return str.slice(1); }
            return str;
        };

        // ── 1. BOM 检测：根据前两个/三个字节直接确定编码 ──
        if (buffer.length >= 2) {
            const b0 = buffer[0];
            const b1 = buffer[1];
            if (b0 === 0xFF && b1 === 0xFE) {
                // UTF-16 LE
                return stripBom(buffer.toString('utf16le'));
            }
            if (b0 === 0xFE && b1 === 0xFF) {
                // UTF-16 BE
                return stripBom(buffer.swap16().toString('utf16le'));
            }
            if (buffer.length >= 3 && b0 === 0xEF && b1 === 0xBB && buffer[2] === 0xBF) {
                // UTF-8 BOM
                return buffer.toString('utf-8').replace(/^\uFEFF/, '');
            }
        }

        // ── 2. 无 BOM：UTF-8 优先，质量检测 ──
        const utf8 = buffer.toString('utf-8');
        const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
        const totalChars = utf8.length || 1;
        if (replacementCount / totalChars < 0.05) {
            return utf8; // UTF-8 解码质量合格
        }

        // ── 3. UTF-8 质量差 → 回退到 GBK ──
        try {
            const iconv = require('iconv-lite');
            const gbk = iconv.decode(buffer, 'gbk');
            // 验证 GBK 解码质量
            const gbkReplacement = (gbk.match(/\uFFFD/g) || []).length;
            if (gbkReplacement / totalChars < 0.5) {
                return gbk;
            }
        } catch { /* iconv-lite 不可用时兜底 */ }

        // ── 4. 所有方案均失败，返回 UTF-8 兜底 ──
        return utf8;
    }

    async save(filePath: string, data: TableData): Promise<void> {
        const { headers, rows } = data;
        const delimiter = this.detectDelimiter(headers.join(','));

        const lines: string[] = [];
        lines.push(headers.map(v => this.escapeCsvField(v, delimiter)).join(delimiter));
        rows.forEach(row => {
            lines.push(row.map(v => this.escapeCsvField(v, delimiter)).join(delimiter));
        });

        await fs.promises.writeFile(filePath, lines.join('\n'), 'utf-8');
    }

    // ============================================
    // 私有方法
    // ============================================

    private detectDelimiter(line: string): string {
        const delimiters = [',', ';', '\t', '|'];
        const counts = delimiters.map(d => ({
            delim: d,
            count: (line.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length
        }));
        const best = counts.filter(c => c.count >= 2).sort((a, b) => b.count - a.count)[0];
        return best ? best.delim : ',';
    }

    /**
     * 解析 CSV 内容（RFC 4180 兼容）：
     *   - 逐字符遍历，追踪引号状态
     *   - 引号内 "" → 转义为一个 "
     *   - 引号内换行符 → 保留为字段值的一部分（多行字段）
     *   - 引号外换行符 → 行分隔符
     *   - 先用第一行检测分隔符，再全文解析
     */
    private parseCsvContent(content: string): { headers: string[]; rows: string[][] } | null {
        // 统一换行符：\r\n 或 \r → \n
        const normalized = content.replace(/\r\n?/g, '\n');
        if (normalized.trim().length === 0) return null;

        // 取第一行（到首个 \n 为止）检测分隔符；注意第一行不会含嵌入换行
        const firstNewline = normalized.indexOf('\n');
        const firstLine = firstNewline >= 0 ? normalized.substring(0, firstNewline) : normalized;
        const delimiter = this.detectDelimiter(firstLine);

        const allRows = this.parseCsvRows(normalized, delimiter);
        if (allRows.length === 0) return null;

        const headers = allRows[0];
        const rows = allRows.slice(1);
        return { headers, rows };
    }

    /**
     * 将 CSV 内容按分隔符拆分为二维数组，正确处理引号多行字段
     */
    private parseCsvRows(content: string, delimiter: string): string[][] {
        const rows: string[][] = [];
        let row: string[] = [];
        let field = '';
        let inQuotes = false;

        for (let i = 0; i < content.length; i++) {
            const ch = content[i];
            const nextCh = i + 1 < content.length ? content[i + 1] : '';

            if (inQuotes) {
                if (ch === '"') {
                    if (nextCh === '"') {
                        // 转义引号："" → "
                        field += '"';
                        i++;
                    } else {
                        // 引号字段结束
                        inQuotes = false;
                    }
                } else {
                    // 引号内所有字符（包括换行）都保留
                    field += ch;
                }
            } else {
                if (ch === '"' && field.trim() === '') {
                    // 字段头部的引号 → 进入引号模式（去除前导空白后的引号开头）
                    inQuotes = true;
                } else if (ch === delimiter) {
                    row.push(field.trim());
                    field = '';
                } else if (ch === '\n') {
                    row.push(field.trim());
                    field = '';
                    rows.push(row);
                    row = [];
                } else {
                    field += ch;
                }
            }
        }

        // 收尾：最后一个字段和最后一行
        row.push(field.trim());
        rows.push(row);

        // 过滤全空行（所有字段均为空串）
        return rows.filter(r => r.length > 0 && r.some(f => f !== ''));
    }

    private escapeCsvField(value: string, delimiter: string): string {
        value = String(value || '');
        if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
            return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
    }
}
