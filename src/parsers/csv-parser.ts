import * as fs from 'fs';
import type { TableData } from '../types';
import type { FileParser, FileParseResult } from './file-parser';

// ============================================
// CSV 解析器
// ============================================

export class CsvFileParser implements FileParser {
    async parse(filePath: string): Promise<FileParseResult> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const result = this.parseCsvContent(content);
            return {
                tableData: result || { headers: [], rows: [] },
                sourceData: null
            };
        } catch (e: any) {
            throw new Error(`CSV 解析失败: ${e.message}`);
        }
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

    private parseCsvLine(line: string, delimiter: string = ','): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === delimiter && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        result.push(current.trim());
        return result;
    }

    private parseCsvContent(content: string): { headers: string[]; rows: string[][] } | null {
        const lines = content.split('\n').filter(line => line.trim());
        if (lines.length === 0) return null;
        const delimiter = this.detectDelimiter(lines[0]);
        const headers = this.parseCsvLine(lines[0], delimiter);
        const rows = lines.slice(1).map(line => this.parseCsvLine(line, delimiter));
        return { headers, rows };
    }

    private escapeCsvField(value: string, delimiter: string): string {
        value = String(value || '');
        if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
            return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
    }
}
