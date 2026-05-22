import * as vscode from 'vscode';
import * as fs from 'fs';
import { BaseEditorProvider, PushViaHttpClient, isInQualifiedDir } from './BaseEditorProvider';
import type { TableData, DetailTableData } from '../types';

// 检查JSON文件是否满足目录要求
export function isQualifiedJsonFile(uri: vscode.Uri): boolean {
    return isInQualifiedDir(uri, /\.json$/i);
}

// 单元格值格式化（与 YAML 解析器一致）
function formatCellValue(value: any): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        if (typeof value[0] !== 'object' || value[0] === null) {
            return value.map(v => String(v ?? '')).join('; ');
        }
        return `[${value.length} 项]`;
    }
    if (typeof value === 'object') return `{${Object.keys(value).length} 字段}`;
    return String(value);
}

// 字段名 → 显示名
function getFieldDisplayName(field: string): string {
    const displayNames: Record<string, string> = {
        steps: '步骤明细', children: '子项明细', items: '条目明细',
        subTasks: '子任务明细', testCases: '测试案例明细', dataSources: '数据源明细',
    };
    return displayNames[field] || field;
}

// 从 JSON 数组数据中提取子表信息
function extractDetailTable(data: any[]): DetailTableData | null {
    if (!Array.isArray(data) || data.length === 0) return null;

    // 找到第一个包含"对象数组"的字段
    let detailKey: string | null = null;
    for (const item of data) {
        if (!item || typeof item !== 'object') continue;
        for (const key of Object.keys(item)) {
            const val = item[key];
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
                detailKey = key;
                break;
            }
        }
        if (detailKey) break;
    }
    if (!detailKey) return null;

    const key = detailKey;

    // 收集子表列头
    const detailHeaders = new Set<string>();
    data.forEach(item => {
        if (item && typeof item === 'object' && item[key]) {
            const subItems = item[key];
            if (Array.isArray(subItems)) {
                subItems.forEach((sub: any) => {
                    if (sub && typeof sub === 'object') {
                        Object.keys(sub).forEach(k => detailHeaders.add(k));
                    }
                });
            }
        }
    });

    const headers = Array.from(detailHeaders);
    const rowGroups: string[][][] = data.map(item => {
        const subData = (item && typeof item === 'object') ? item[key] : null;
        if (!Array.isArray(subData)) return [];
        return subData.map((subItem: any) => {
            return headers.map(h => formatCellValue(
                (subItem && typeof subItem === 'object') ? subItem[h] : undefined
            ));
        });
    });

    // 保存原始类型数据（用于编辑后回写）
    const rawRowGroups: any[][][] = data.map(item => {
        const subData = (item && typeof item === 'object') ? item[key] : null;
        return Array.isArray(subData) ? subData : [];
    });

    return { field: key, fieldDisplay: getFieldDisplayName(key), headers, rowGroups, rawRowGroups };
}

// 异步解析JSON文件数据
async function parseJsonData(filePath: string): Promise<{ tableData: TableData; sourceData: any }> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        const sourceData = Array.isArray(data) ? data : (data && typeof data === 'object') ? [data] : [];

        if (!Array.isArray(data) || data.length === 0) {
            return { tableData: { headers: [], rows: [] }, sourceData };
        }

        // ---------- 提取子表数据 ----------
        const detailTable = extractDetailTable(data);

        const allPaths = new Set<string>();

        function collectPaths(obj: any, prefix: string = '') {
            if (obj === null || obj === undefined) return;
            if (Array.isArray(obj)) {
                allPaths.add(prefix || 'value');
            } else if (typeof obj === 'object') {
                for (const key of Object.keys(obj)) {
                    const newPrefix = prefix ? `${prefix}.${key}` : key;
                    collectPaths(obj[key], newPrefix);
                }
            } else {
                allPaths.add(prefix || 'value');
            }
        }

        for (const item of data) {
            if (typeof item === 'object' && item !== null) {
                collectPaths(item);
            }
        }

        const headers = Array.from(allPaths).sort((a, b) => {
            const aDepth = a.split('.').length;
            const bDepth = b.split('.').length;
            if (aDepth !== bDepth) return aDepth - bDepth;
            return a.localeCompare(b);
        });

        function getNestedValue(obj: any, path: string): string {
            if (!path || path === 'value') {
                if (Array.isArray(obj)) {
                    if (obj.length > 0 && typeof obj[0] === 'object') return `[${obj.length} 项]`;
                    if (obj.length === 0) return '[]';
                    return obj.map(v => String(v ?? '')).join('; ');
                }
                if (typeof obj === 'object' && obj !== null) return `{${Object.keys(obj).length} 字段}`;
                return String(obj ?? '');
            }
            const keys = path.split('.');
            let val: any = obj;
            for (const k of keys) {
                if (val === null || val === undefined) return '';
                val = val[k];
            }
            // 使用 formatCellValue 处理嵌套值
            if (val === undefined || val === null) return '';
            return formatCellValue(val);
        }

        const rows: string[][] = data.map(item => {
            if (typeof item !== 'object' || item === null) {
                return headers.map(() => '');
            }
            return headers.map(h => getNestedValue(item, h));
        });

        return { tableData: { headers, rows, detailTable: detailTable ?? undefined }, sourceData };
    } catch (e: any) {
        const msg = `JSON 解析失败: ${e.message}`;
        console.error(msg, e);
        throw new Error(msg);
    }
}

function unflattenRow(headers: string[], row: string[]): any {
    const result: any = {};

    headers.forEach((path, idx) => {
        const value = row[idx];
        if (path === 'value') {
            try {
                result._value = JSON.parse(value);
            } catch {
                result._value = value;
            }
            return;
        }

        const keys = path.split('.');
        let obj = result;
        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (!(k in obj) || typeof obj[k] !== 'object') {
                obj[k] = {};
            }
            obj = obj[k];
        }
        const lastKey = keys[keys.length - 1];
        try {
            obj[lastKey] = JSON.parse(value);
        } catch {
            obj[lastKey] = value;
        }
    });

    if (Object.keys(result).length === 1 && '_value' in result) {
        return result._value;
    }
    delete result._value;
    return result;
}

// JSON 字符串转真实类型（用于回写时还原数组和对象）
function parseCellValue(val: string): any {
    if (!val) return '';
    if (val.startsWith('[') || val.startsWith('{')) {
        try { return JSON.parse(val); } catch { return val; }
    }
    return val;
}

// JSON 自定义编辑器 Provider
export class JsonEditorProvider extends BaseEditorProvider {
    protected pushStrategy = new PushViaHttpClient();
    private originalSourceData: any = null;
    private detailFieldName: string | null = null;

    protected getTypeName(): string { return 'JSON'; }
    protected getDataType(): 'yaml' | 'json' | 'csv' { return 'json'; }
    protected getOpenCommand(): string { return 'jsonEditor.openWithFile'; }
    protected getErrorMessage(): string {
        return '该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.json';
    }

    protected isQualifiedFile(uri: vscode.Uri): boolean {
        return isQualifiedJsonFile(uri);
    }

    protected async parseData(filePath: string): Promise<TableData> {
        const result = await parseJsonData(filePath);
        this.originalSourceData = result.sourceData;
        this.detailFieldName = result.tableData.detailTable?.field || null;
        return result.tableData;
    }

    protected async saveFile(filePath: string, data: TableData): Promise<void> {
        if (!data) throw new Error('没有数据可保存');
        const { headers, rows, detailTable } = data;

        const detailField = detailTable?.field || this.detailFieldName;

        const records: any[] = rows.map((row, rowIdx) => {
            // 有子表数据时，为 detailField 使用重建结果而非 unflattenRow
            if (detailField && this.originalSourceData && detailTable?.rowGroups) {
                const editedRows: string[][] = detailTable.rowGroups[rowIdx] || [];
                if (editedRows.length > 0) {
                    const origDetailData = rowIdx < this.originalSourceData.length
                        ? this.originalSourceData[rowIdx]?.[detailField] : null;
                    const rawRows: any[] = Array.isArray(origDetailData) ? origDetailData : [];
                    const reconstructed: any[] = [];

                    for (let di = 0; di < editedRows.length; di++) {
                        const src: any = (di < rawRows.length && typeof rawRows[di] === 'object')
                            ? { ...rawRows[di] } : {};
                        detailTable.headers.forEach((dh, ci) => {
                            const edited = editedRows[di]?.[ci];
                            if (edited !== undefined) {
                                const origRaw = rawRows[di]?.[dh];
                                if (Array.isArray(origRaw)) {
                                    src[dh] = edited ? edited.split('; ').map((s: string) => s.trim()).filter(Boolean) : [];
                                } else if (origRaw !== undefined && typeof origRaw === 'boolean') {
                                    src[dh] = edited === 'true';
                                } else if (origRaw !== undefined && typeof origRaw === 'number') {
                                    src[dh] = Number(edited) || 0;
                                } else {
                                    src[dh] = parseCellValue(edited);
                                }
                            }
                        });
                        reconstructed.push(src);
                    }

                    // 非 detailField 用 unflattenRow 处理，detailField 用重建结果覆盖
                    const record = unflattenRow(headers, row);
                    record[detailField] = reconstructed;
                    return record;
                }
            }
            return unflattenRow(headers, row);
        });

        // 如果原数据是非数组对象，解包回对象
        if (this.originalSourceData && !Array.isArray(this.originalSourceData) && records.length === 1) {
            const jsonContent = JSON.stringify(records[0], null, 2);
            await fs.promises.writeFile(filePath, jsonContent, 'utf-8');
        } else {
            const jsonContent = JSON.stringify(records.length === 1 ? records[0] : records, null, 2);
            await fs.promises.writeFile(filePath, jsonContent, 'utf-8');
        }
    }
}
