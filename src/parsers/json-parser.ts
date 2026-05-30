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
            let rows: any[][];
            const isFlatTopLevel = detailTables.length > 0;
            if (isFlatTopLevel) {
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

            // 仅在「顶层 key 模式」识别标量数组列；路径展开模式因为列名是 a.b.c 形式，
            // 与原始顶层字段不对应，统一保持现状（不做识别，避免误判）。
            let columnTypes: { [field: string]: 'scalar' | 'string[]' | 'number[]' | 'detail' } | undefined;
            if (isFlatTopLevel) {
                columnTypes = this.detectColumnTypes(headers, data, detailTables);
                // 还原标量数组列为真实数组（与 yaml-parser 行为一致），让 webview 走 chip + 多项编辑弹窗。
                for (let ri = 0; ri < rows.length; ri++) {
                    const orig = ri < data.length ? data[ri] : undefined;
                    if (!orig || typeof orig !== 'object') continue;
                    headers.forEach((h, ci) => {
                        const t = columnTypes![h];
                        if (t === 'string[]' || t === 'number[]') {
                            const v = (orig as any)[h];
                            rows[ri][ci] = Array.isArray(v) ? v.slice() : [];
                        }
                    });
                }
            }

            return {
                tableData: {
                    headers,
                    rows,
                    detailTable: detailTables[0],
                    detailTables: detailTables.length > 0 ? detailTables : undefined,
                    columnTypes
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
            // 取该行原始记录，用于标量数组列等的类型还原
            const origRecord: any = (Array.isArray(originalData) && rowIdx < originalData.length)
                ? originalData[rowIdx] : undefined;
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
                    const origVal = origRecord ? origRecord[h] : undefined;
                    // 当前端送回数组（chip 列）或原值是数组/对象/数字/布尔时，走 coerceValue 保真还原；
                    // 否则按字符串路径走 parseCellValue（兼容老逻辑）。
                    if (Array.isArray(row[i]) || Array.isArray(origVal)
                        || (origVal && typeof origVal === 'object')
                        || typeof origVal === 'boolean'
                        || typeof origVal === 'number') {
                        record[h] = this.coerceValue(row[i], origVal);
                    } else {
                        record[h] = this.parseCellValue(row[i]);
                    }
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

    private coerceValue(edited: any, origRaw: any): any {
        // 新链路：前端已传入数组形态（标量数组列 chip 编辑后），按原数组的元素类型样本逐项还原
        if (Array.isArray(edited)) {
            let sample: any = undefined;
            if (Array.isArray(origRaw)) {
                for (const it of origRaw) {
                    if (it !== null && it !== undefined && it !== '') { sample = it; break; }
                }
            }
            return edited.map((it: any) => this.coerceArrayItem(it, sample));
        }
        if (Array.isArray(origRaw)) {
            // 对象数组：优先按 JSON 解析
            if (origRaw.length > 0 && typeof origRaw[0] === 'object' && origRaw[0] !== null) {
                if (!edited) return [];
                try { const v = JSON.parse(edited); if (Array.isArray(v)) return v; } catch { /* fall through */ }
            }
            return edited
                ? String(edited).split('; ').map((s: string) => s.trim()).filter(Boolean)
                : [];
        }
        if (origRaw && typeof origRaw === 'object') {
            if (!edited) return null;
            try { return JSON.parse(edited); } catch { return edited; }
        }
        if (typeof origRaw === 'boolean') {
            return edited === 'true' || edited === true;
        }
        if (typeof origRaw === 'number') {
            if (edited === '' || edited === null || edited === undefined) return null;
            const n = Number(edited);
            return Number.isNaN(n) ? edited : n;
        }
        return this.parseCellValue(edited);
    }

    /** 数组元素按样本类型还原（数字数组保数字、布尔数组保布尔，其它保字符串） */
    private coerceArrayItem(item: any, sample: any): any {
        if (item === null || item === undefined) return item;
        if (typeof sample === 'number') {
            if (typeof item === 'number') return item;
            const s = String(item).trim();
            if (s === '') return null;
            if (!Number.isNaN(Number(s)) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
            return item;
        }
        if (typeof sample === 'boolean') {
            if (typeof item === 'boolean') return item;
            const t = String(item).trim().toLowerCase();
            if (t === 'true') return true;
            if (t === 'false') return false;
            return item;
        }
        return typeof item === 'string' ? item : String(item);
    }

    /**
     * 列类型识别（与 yaml-parser 保持一致的保守策略）：
     *   - 明细列（detailTables 中已有同名 field）→ 'detail'
     *   - 非明细列：扫描每行同名字段；
     *       * 全标量 → 'scalar'
     *       * 全为标量数组（至少一行非空数组），元素同质字符串/数字 → 'string[]' / 'number[]'
     *       * 任一行出现对象 / 混合形态 → 'scalar'（保守降级）
     */
    private detectColumnTypes(
        headers: string[],
        sourceData: any,
        detailTables?: DetailTableData[]
    ): { [field: string]: 'scalar' | 'string[]' | 'number[]' | 'detail' } {
        const out: { [field: string]: 'scalar' | 'string[]' | 'number[]' | 'detail' } = {};
        const detailFields = new Set<string>();
        (detailTables || []).forEach(t => { if (t && t.field) detailFields.add(t.field); });
        const rows: any[] = Array.isArray(sourceData) ? sourceData : [];
        headers.forEach(h => {
            if (detailFields.has(h)) { out[h] = 'detail'; return; }
            if (rows.length === 0) { out[h] = 'scalar'; return; }
            let allArrays = true;
            let anyArray = false;
            let elemKind: 'string' | 'number' | 'mixed' | 'unknown' = 'unknown';
            for (const r of rows) {
                if (!r || typeof r !== 'object') { allArrays = false; break; }
                const v = (r as any)[h];
                if (v === undefined || v === null) continue;
                if (!Array.isArray(v)) { allArrays = false; break; }
                anyArray = true;
                for (const item of v) {
                    if (item === null || item === undefined) continue;
                    if (typeof item === 'object') { elemKind = 'mixed'; break; }
                    if (typeof item === 'string') {
                        if (elemKind === 'unknown') elemKind = 'string';
                        else if (elemKind !== 'string') elemKind = 'mixed';
                    } else if (typeof item === 'number') {
                        if (elemKind === 'unknown') elemKind = 'number';
                        else if (elemKind !== 'number') elemKind = 'mixed';
                    } else {
                        elemKind = 'mixed';
                    }
                }
                if (elemKind === 'mixed') break;
            }
            if (allArrays && anyArray && elemKind === 'string') out[h] = 'string[]';
            else if (allArrays && anyArray && elemKind === 'number') out[h] = 'number[]';
            else out[h] = 'scalar';
        });
        return out;
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
