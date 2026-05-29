/**
 * ============================================================================
 *  parsers/json-parser.ts
 *  JSON 解析器实现
 * ----------------------------------------------------------------------------
 *  职责：
 *    - 以「顶层数组」为默认集合语义，展平为表格主表 + N 个明细表。
 *    - 存在明细字段时，主表只展开顶层标量列，避免与明细列冲突。
 *  说明：复用 yaml-parser 的 getDetailFieldDisplay，以统一明细表标题呈现风格。
 * ============================================================================
 */
import * as fs from 'fs';
import type { TableData, DetailTableData } from '../types';
import type { FileParser, FileParseResult } from './file-parser';
import { getDetailFieldDisplay } from './yaml-parser';

// ============================================
// JSON 解析器
// ============================================

export class JsonFileParser implements FileParser {
    async parse(filePath: string): Promise<FileParseResult> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);

            const sourceData = Array.isArray(data) ? data : (data && typeof data === 'object') ? [data] : [];

            if (!Array.isArray(data) || data.length === 0) {
                return { tableData: { headers: [], rows: [] }, sourceData };
            }

            const detailTables = this.extractDetailTables(data);
            // 使用"主表设计"：如果存在明细字段，主表使用顶层 key 作为列，避免路径展开与明细列冲突。
            // 否则保留原有路径展开逻辑。
            let headers: string[];
            let rows: string[][];
            if (detailTables.length > 0) {
                headers = this.collectTopLevelKeys(data);
                rows = data.map(item => {
                    if (typeof item !== 'object' || item === null) return headers.map(() => '');
                    return headers.map(h => this.formatCellValue((item as any)[h]));
                });
            } else {
                headers = this.collectAllPaths(data);
                rows = data.map(item => {
                    if (typeof item !== 'object' || item === null) {
                        return headers.map(() => '');
                    }
                    return headers.map(h => this.getNestedValue(item, h));
                });
            }

            return {
                tableData: {
                    headers,
                    rows,
                    detailTable: detailTables[0],
                    detailTables: detailTables.length > 0 ? detailTables : undefined
                },
                sourceData
            };
        } catch (e: any) {
            throw new Error(`JSON 解析失败: ${e.message}`);
        }
    }

    async save(filePath: string, data: TableData, originalData?: any): Promise<void> {
        if (!data) throw new Error('没有数据可保存');
        const { headers, rows, detailTable, detailTables } = data;

        const tablesByField = new Map<string, DetailTableData>();
        if (Array.isArray(detailTables)) {
            detailTables.forEach(t => { if (t && t.field) tablesByField.set(t.field, t); });
        }
        if (detailTable && detailTable.field && !tablesByField.has(detailTable.field)) {
            tablesByField.set(detailTable.field, detailTable);
        }

        const useFlatTopLevel = tablesByField.size > 0;

        const records: any[] = rows.map((row, rowIdx) => {
            if (useFlatTopLevel) {
                // 顶层 key 模式：逐列处理，detail 列走 reconstructDetail，其余列尝试 JSON.parse 还原
                const record: any = {};
                headers.forEach((h, i) => {
                    const dt = tablesByField.get(h);
                    if (dt && originalData && dt.rowGroups) {
                        const editedRows: string[][] = dt.rowGroups[rowIdx] || [];
                        const rawType = (dt.rawRowTypes && dt.rawRowTypes[rowIdx]) || 'none';
                        if (editedRows.length > 0 || rawType === 'object') {
                            record[h] = this.reconstructDetail(rowIdx, dt, originalData);
                            return;
                        }
                    }
                    record[h] = this.parseCellValue(row[i]);
                });
                return record;
            }
            // 路径展开模式（保留原逻辑）
            if (detailTable && detailTable.field && originalData && detailTable.rowGroups) {
                const editedRows: string[][] = detailTable.rowGroups[rowIdx] || [];
                if (editedRows.length > 0) {
                    const reconstructed = this.reconstructDetail(rowIdx, detailTable, originalData);
                    const record = this.unflattenRow(headers, row);
                    record[detailTable.field] = reconstructed;
                    return record;
                }
            }
            return this.unflattenRow(headers, row);
        });

        const isObjectSource = originalData && !Array.isArray(originalData) && records.length === 1;
        const out = isObjectSource
            ? records[0]
            : (records.length === 1 ? records[0] : records);

        await fs.promises.writeFile(filePath, JSON.stringify(out, null, 2), 'utf-8');
    }

    // ============================================
    // 子表数据提取
    // ============================================

    private extractDetailTables(data: any[]): DetailTableData[] {
        if (!Array.isArray(data) || data.length === 0) return [];

        // 收集所有顶层嵌套字段（对象或非空对象数组）
        const fieldKeys: string[] = [];
        const seen = new Set<string>();
        data.forEach(item => {
            if (!item || typeof item !== 'object') return;
            for (const key of Object.keys(item)) {
                const val = (item as any)[key];
                const isObjArr = Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null;
                const isObj = val && typeof val === 'object' && !Array.isArray(val);
                if ((isObjArr || isObj) && !seen.has(key)) {
                    seen.add(key);
                    fieldKeys.push(key);
                }
            }
        });

        const tables: DetailTableData[] = [];
        fieldKeys.forEach(key => {
            const t = this.buildDetailTable(data, key);
            if (t) tables.push(t);
        });
        return tables;
    }

    private buildDetailTable(data: any[], key: string): DetailTableData | null {
        const detailHeaderSet = new Set<string>();
        data.forEach(item => {
            const val = item?.[key];
            if (Array.isArray(val)) {
                val.forEach((sub: any) => {
                    if (sub && typeof sub === 'object') {
                        Object.keys(sub).forEach(k => detailHeaderSet.add(k));
                    }
                });
            } else if (val && typeof val === 'object') {
                Object.keys(val).forEach(k => detailHeaderSet.add(k));
            }
        });
        if (detailHeaderSet.size === 0) return null;

        const detailHeaders = Array.from(detailHeaderSet);
        const rowGroups: string[][][] = [];
        const rawRowGroups: any[][][] = [];
        const rawRowTypes: ('array' | 'object' | 'none')[] = [];

        data.forEach(item => {
            const val = item?.[key];
            if (Array.isArray(val)) {
                rowGroups.push(val.map((sub: any) =>
                    detailHeaders.map(h => this.formatDetailCellValue(sub && typeof sub === 'object' ? sub[h] : undefined))
                ));
                rawRowGroups.push(val.slice());
                rawRowTypes.push('array');
            } else if (val && typeof val === 'object') {
                rowGroups.push([
                    detailHeaders.map(h => this.formatDetailCellValue((val as any)[h]))
                ]);
                rawRowGroups.push([{ ...val }]);
                rawRowTypes.push('object');
            } else {
                rowGroups.push([]);
                rawRowGroups.push([]);
                rawRowTypes.push('none');
            }
        });

        return {
            field: key,
            fieldDisplay: getDetailFieldDisplay(key),
            headers: detailHeaders,
            rowGroups,
            rawRowGroups,
            rawRowTypes
        };
    }

    /**
     * 重建 detail 字段为对应原始类型：
     * - 数组：返回 any[]
     * - 嵌套对象：返回单个对象
     */
    private reconstructDetail(rowIdx: number, detailTable: DetailTableData, originalData: any[]): any {
        const editedRows: string[][] = detailTable.rowGroups[rowIdx] || [];
        const rawType = detailTable.rawRowTypes ? detailTable.rawRowTypes[rowIdx] : undefined;
        const origDetailData = rowIdx < originalData.length
            ? originalData[rowIdx]?.[detailTable.field] : undefined;

        const isObjectType = rawType === 'object'
            || (rawType === undefined && origDetailData && typeof origDetailData === 'object' && !Array.isArray(origDetailData));

        if (isObjectType) {
            const editedFirst = editedRows[0] || [];
            const origObj: any = (origDetailData && typeof origDetailData === 'object' && !Array.isArray(origDetailData))
                ? { ...origDetailData } : {};
            detailTable.headers.forEach((dh, ci) => {
                const edited = editedFirst[ci];
                if (edited === undefined) return;
                const origRaw = (origDetailData && typeof origDetailData === 'object' && !Array.isArray(origDetailData))
                    ? (origDetailData as any)[dh] : undefined;
                origObj[dh] = this.coerceValue(edited, origRaw);
            });
            return origObj;
        }

        // rawRows 来自原始解析数据，但复制/新增行可能超出其长度
        // 对于这些行，从 rawRowGroups（深拷贝的原始结构）补充类型信息
        let rawRows: any[] = Array.isArray(origDetailData) ? [...origDetailData] : [];
        {
            const rawExtra = detailTable.rawRowGroups?.[rowIdx] || [];
            for (let ei = rawRows.length; ei < rawExtra.length && ei < editedRows.length; ei++) {
                rawRows.push(rawExtra[ei]);
            }
        }
        const reconstructed: any[] = [];
        for (let di = 0; di < editedRows.length; di++) {
            const src: any = (di < rawRows.length && typeof rawRows[di] === 'object')
                ? { ...rawRows[di] } : {};
            detailTable.headers.forEach((dh, ci) => {
                const edited = editedRows[di]?.[ci];
                if (edited === undefined) return;
                const origRaw = rawRows[di]?.[dh];
                src[dh] = this.coerceValue(edited, origRaw);
            });
            reconstructed.push(src);
        }
        return reconstructed;
    }

    private coerceValue(edited: string, origRaw: any): any {
        if (Array.isArray(origRaw)) {
            // 对象数组：优先按 JSON 解析
            if (origRaw.length > 0 && typeof origRaw[0] === 'object' && origRaw[0] !== null) {
                if (!edited) return [];
                try { const v = JSON.parse(edited); if (Array.isArray(v)) return v; } catch { /* fall through */ }
            }
            return edited
                ? edited.split('; ').map((s: string) => s.trim()).filter(Boolean)
                : [];
        }
        if (origRaw && typeof origRaw === 'object') {
            if (!edited) return null;
            try { return JSON.parse(edited); } catch { return edited; }
        }
        if (typeof origRaw === 'boolean') {
            return edited === 'true';
        }
        if (typeof origRaw === 'number') {
            if (edited === '' || edited === null || edited === undefined) return null;
            const n = Number(edited);
            return Number.isNaN(n) ? edited : n;
        }
        return this.parseCellValue(edited);
    }

    // ============================================
    // 路径辅助
    // ============================================

    private collectTopLevelKeys(data: any[]): string[] {
        const keys: string[] = [];
        const seen = new Set<string>();
        data.forEach(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return;
            Object.keys(item).forEach(k => {
                if (!seen.has(k)) { seen.add(k); keys.push(k); }
            });
        });
        return keys;
    }

    private collectAllPaths(data: any[]): string[] {
        const allPaths = new Set<string>();
        const collect = (obj: any, prefix: string = '') => {
            if (obj === null || obj === undefined) return;
            if (Array.isArray(obj)) {
                allPaths.add(prefix || 'value');
            } else if (typeof obj === 'object') {
                for (const key of Object.keys(obj)) {
                    const newPrefix = prefix ? `${prefix}.${key}` : key;
                    collect(obj[key], newPrefix);
                }
            } else {
                allPaths.add(prefix || 'value');
            }
        };
        for (const item of data) {
            if (typeof item === 'object' && item !== null) collect(item);
        }
        return Array.from(allPaths).sort((a, b) => {
            const aDepth = a.split('.').length;
            const bDepth = b.split('.').length;
            if (aDepth !== bDepth) return aDepth - bDepth;
            return a.localeCompare(b);
        });
    }

    private getNestedValue(obj: any, path: string): string {
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
        return this.formatCellValue(val);
    }

    private unflattenRow(headers: string[], row: string[]): any {
        const result: any = {};
        headers.forEach((p, idx) => {
            const value = row[idx];
            if (p === 'value') {
                try { result._value = JSON.parse(value); } catch { result._value = value; }
                return;
            }
            const keys = p.split('.');
            let obj = result;
            for (let i = 0; i < keys.length - 1; i++) {
                const k = keys[i];
                if (!(k in obj) || typeof obj[k] !== 'object') obj[k] = {};
                obj = obj[k];
            }
            const lastKey = keys[keys.length - 1];
            try { obj[lastKey] = JSON.parse(value); } catch { obj[lastKey] = value; }
        });
        if (Object.keys(result).length === 1 && '_value' in result) return result._value;
        delete result._value;
        return result;
    }

    private formatCellValue(value: any): string {
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

    /**
     * 明细子表单元格格式化：仅支持一层展开，嵌套结构序列化为 JSON 字符串。
     */
    private formatDetailCellValue(value: any): string {
        if (value === null || value === undefined) return '';
        if (Array.isArray(value)) {
            if (value.length === 0) return '[]';
            if (typeof value[0] !== 'object' || value[0] === null) {
                return value.map(v => String(v ?? '')).join('; ');
            }
            try { return JSON.stringify(value); } catch { return '[' + value.length + ' 项]'; }
        }
        if (typeof value === 'object') {
            try { return JSON.stringify(value); } catch { return '{' + Object.keys(value).length + ' 字段}'; }
        }
        return String(value);
    }

    private parseCellValue(val: string): any {
        if (!val) return '';
        if (val.startsWith('[') || val.startsWith('{')) {
            try { return JSON.parse(val); } catch { return val; }
        }
        return val;
    }
}
