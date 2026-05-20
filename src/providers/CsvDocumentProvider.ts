import * as vscode from 'vscode';
import * as fs from 'fs';
import { BaseEditorProvider, PushViaHttpClient, isInQualifiedDir } from './BaseEditorProvider';
import type { TableData } from '../types';

// ============================================
// CSV 解析工具（纯函数，无副作用）
// ============================================

function detectDelimiter(line: string): string {
    const delimiters = [',', ';', '\t', '|'];
    const counts = delimiters.map(d => ({ delim: d, count: (line.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length }));
    const best = counts.filter(c => c.count >= 2).sort((a, b) => b.count - a.count)[0];
    return best ? best.delim : ',';
}

function parseCsvLine(line: string, delimiter: string = ','): string[] {
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

function parseCsvContent(content: string): { headers: string[], rows: string[][] } | null {
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length === 0) return null;
    const delimiter = detectDelimiter(lines[0]);
    const headers = parseCsvLine(lines[0], delimiter);
    const rows = lines.slice(1).map(line => parseCsvLine(line, delimiter));
    return { headers, rows };
}

function escapeCsvField(value: string, delimiter: string): string {
    value = String(value || '');
    if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}

// 检查CSV文件是否满足目录要求
export function isQualifiedCsvFile(uri: vscode.Uri): boolean {
    return isInQualifiedDir(uri, /\.csv$/i);
}

// 异步读取并解析CSV文件
async function parseCsvData(filePath: string): Promise<TableData> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const result = parseCsvContent(content);
        return result || { headers: [], rows: [] };
    } catch (e: any) {
        const msg = `CSV 解析失败: ${e.message}`;
        console.error(msg, e);
        throw new Error(msg);
    }
}

// 同步读取并解析CSV文件（用于旧版预览模式）
function parseCsvDataSync(filePath: string): TableData {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const result = parseCsvContent(content);
        return result || { headers: [], rows: [] };
    } catch (e) {
        console.error('CSV parse error:', e);
        return { headers: [], rows: [] };
    }
}

// ============================================
// CSV 自定义编辑器 Provider
// ============================================

export class CsvEditorProvider extends BaseEditorProvider {
    protected pushStrategy = new PushViaHttpClient();

    protected getTypeName(): string { return 'CSV'; }
    protected getDataType(): 'yaml' | 'json' | 'csv' { return 'csv'; }
    protected getOpenCommand(): string { return 'csvEditor.openWithFile'; }
    protected getErrorMessage(): string {
        return '该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.csv';
    }

    protected isQualifiedFile(uri: vscode.Uri): boolean {
        return isQualifiedCsvFile(uri);
    }

    protected async parseData(filePath: string): Promise<TableData> {
        return await parseCsvData(filePath);
    }

    protected async saveFile(filePath: string, data: TableData): Promise<void> {
        const { headers, rows } = data;
        const delimiter = detectDelimiter(headers.join(','));

        const lines: string[] = [];
        lines.push(headers.map(v => escapeCsvField(v, delimiter)).join(delimiter));
        rows.forEach(row => {
            lines.push(row.map(v => escapeCsvField(v, delimiter)).join(delimiter));
        });

        await fs.promises.writeFile(filePath, lines.join('\n'), 'utf-8');
    }
}
