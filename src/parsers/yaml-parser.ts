/**
 * ============================================================================
 *  parsers/yaml-parser.ts
 *  YAML 解析器实现
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 将 YAML 文件读取为 sheets 二维结构，提供主表 + 多明细表能力。
 *    2. 保留 sourceData 以便 save 时重建原始嵌套结构（例如保留「那些不在表格列里」的字段）。
 *    3. 提供 getDetailFieldDisplay 给 JsonFileParser 复用。
 *  设计要点：
 *    - 主表只展开顶层标量字段；嵌套对象 / 对象数组 会被划为明细表。
 *    - 嵌套超过一层的明细会被序列化为 JSON 字符串展示/编辑。
 * ============================================================================
 */
import * as fs from 'fs';
import * as YAML from 'yaml';
import type { TableData, DetailTableData, SheetData, SheetRow } from '../types';
import type { FileParser, FileParseResult } from './file-parser';

// ============================================
// 内部 YAML 数据结构
// ============================================

interface YamlData {
    sheets: SheetData[];
    sourceData: any;
    detailTable?: DetailTableData;
    detailTables?: DetailTableData[];
}

// ============================================
// YAML 解析器
// ============================================

export class YamlFileParser implements FileParser {
    async parse(filePath: string): Promise<FileParseResult> {
        const data = await this.loadYamlFromFile(filePath);
        const sheet = data.sheets[0];
        if (!sheet) return { tableData: { headers: [], rows: [] }, sourceData: null };

        const headers: string[] = [];
        const rows: string[][] = [];

        const row0 = sheet.rows[0];
        if (row0) {
            const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
        }

        const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
        rowKeys.forEach(ri => {
            if (ri === 0 && headers.length > 0) return;
            const row = sheet.rows[ri];
            if (!row) return;
            const rowData: string[] = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
            while (rowData.length < headers.length) rowData.push('');
            rows.push(rowData);
        });

        let sourceData: any = data.sourceData;
        if (!Array.isArray(sourceData) && typeof sourceData === 'object' && sourceData !== null) {
            sourceData = [sourceData];
        }

        return {
            tableData: {
                headers,
                rows,
                detailTable: data.detailTable,
                detailTables: data.detailTables
            },
            sourceData
        };
    }

    async save(filePath: string, data: TableData, originalData?: any): Promise<void> {
        if (!data) throw new Error('没有数据可保存');
        const { headers, rows, detailTable, detailTables } = data;

        // 收集所有明细字段（兼容 detailTable 单字段写法）
        const tablesByField = new Map<string, DetailTableData>();
        if (Array.isArray(detailTables)) {
            detailTables.forEach(t => { if (t && t.field) tablesByField.set(t.field, t); });
        }
        if (detailTable && detailTable.field && !tablesByField.has(detailTable.field)) {
            tablesByField.set(detailTable.field, detailTable);
        }

        const records: any[] = rows.map((row, rowIdx) => {
            const record: any = {};
            headers.forEach((h, i) => {
                const dt = tablesByField.get(h);
                if (dt && originalData && dt.rowGroups) {
                    record[h] = this.reconstructDetail(rowIdx, dt, originalData, row, i);
                } else {
                    record[h] = this.parseCellValue(row[i]);
                }
            });
            return record;
        });

        const yamlContent = YAML.stringify(records.length === 1 ? records[0] : records);
        await fs.promises.writeFile(filePath, yamlContent, 'utf-8');
    }

    // ============================================
    // 加载 YAML
    // ============================================

    private async loadYamlFromFile(filePath: string): Promise<YamlData> {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return this.loadYamlFromContent(content);
    }

    private loadYamlFromContent(content: string): YamlData {
        if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
        const cleanContent = this.cleanYamlContent(content);
        if (!cleanContent.trim()) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], sourceData: null };
        }

        let parsed: any = null;
        let sourceData: any = null;
        try {
            const docs = YAML.parseAllDocuments(cleanContent);
            for (const doc of docs) {
                const value = doc.toJSON();
                if (value !== null && value !== undefined) {
                    sourceData = value;
                    parsed = this.findArrayData(value);
                    if (parsed) break;
                }
            }
        } catch {
            sourceData = YAML.parse(cleanContent);
            parsed = this.findArrayData(sourceData);
        }

        if (!parsed) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], sourceData };
        }

        const sheet = this.toSheet(parsed);
        const detailTables = this.extractDetailTables(parsed);

        return {
            sheets: [sheet],
            sourceData,
            detailTable: detailTables[0],
            detailTables: detailTables.length > 0 ? detailTables : undefined
        };
    }

    private cleanYamlContent(content: string): string {
        const lines = content.split('\n');
        let result = '';
        let foundContent = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!foundContent && trimmed.startsWith('#')) continue;
            foundContent = true;
            result += line + '\n';
        }
        return result;
    }

    private findArrayData(data: any): any[] | null {
        if (Array.isArray(data) && data.length > 0) return data;
        if (typeof data === 'object' && data !== null) {
            for (const key of Object.keys(data)) {
                if (Array.isArray(data[key]) && data[key].length > 0) return data[key];
            }
            if (Object.keys(data).length > 0) return [data];
        }
        return null;
    }

    private toSheet(yamlData: any[]): SheetData {
        const allKeys = new Set<string>();
        yamlData.forEach(item => {
            if (item && typeof item === 'object') {
                Object.keys(item).forEach(k => allKeys.add(k));
            }
        });
        const headers = Array.from(allKeys);

        const rows: { [key: number]: SheetRow } = { 0: { cells: {} } };
        headers.forEach((h, ci) => {
            rows[0].cells[ci] = { text: h };
        });
        yamlData.forEach((item, ri) => {
            if (item && typeof item === 'object') {
                const cells: any = {};
                headers.forEach((h, ci) => {
                    cells[ci] = { text: this.formatCellValue(item[h]) };
                });
                rows[ri + 1] = { cells };
            }
        });
        return { name: 'Sheet1', rows };
    }

    // ============================================
    // 子表数据提取
    // ============================================

    /**
     * 提取所有顶层嵌套对象/对象数组字段为明细表。
     * 仅支持一层展开：子表的单元格若仍为嵌套结构，formatDetailCellValue 会序列化为 JSON 字符串。
     */
    private extractDetailTables(data: any[]): DetailTableData[] {
        if (!Array.isArray(data) || data.length === 0) return [];

        // 收集每个顶层字段在各行中的形态（数组 / 对象 / 其它）
        const fieldShapes = new Map<string, { hasArray: boolean; hasObject: boolean }>();
        data.forEach(item => {
            if (!item || typeof item !== 'object') return;
            for (const key of Object.keys(item)) {
                const val = (item as any)[key];
                if (Array.isArray(val)) {
                    if (val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
                        const s = fieldShapes.get(key) || { hasArray: false, hasObject: false };
                        s.hasArray = true;
                        fieldShapes.set(key, s);
                    }
                } else if (val && typeof val === 'object') {
                    const s = fieldShapes.get(key) || { hasArray: false, hasObject: false };
                    s.hasObject = true;
                    fieldShapes.set(key, s);
                }
            }
        });

        const tables: DetailTableData[] = [];
        fieldShapes.forEach((_shape, key) => {
            const t = this.buildDetailTable(data, key);
            if (t) tables.push(t);
        });
        return tables;
    }

    private buildDetailTable(data: any[], key: string): DetailTableData | null {
        // 收集 headers（数组元素 key 并集 / 嵌套对象 key 并集）
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
        const rawRowGroups: any[][] = [];
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
            rawRowGroups: rawRowGroups as any[][][],
            rawRowTypes
        };
    }

    // ============================================
    // 子表保存重建
    // ============================================

    private reconstructDetail(
        rowIdx: number,
        detailTable: DetailTableData,
        originalData: any[],
        row: string[],
        i: number
    ): any {
        const editedRows: string[][] = detailTable.rowGroups[rowIdx] || [];
        const rawType = detailTable.rawRowTypes ? detailTable.rawRowTypes[rowIdx] : undefined;
        const origDetailData = rowIdx < originalData.length
            ? originalData[rowIdx]?.[detailTable.field] : undefined;

        // 无明细时，回退到主表单元格值的解析
        if (editedRows.length === 0) {
            return origDetailData !== undefined ? origDetailData : this.parseCellValue(row[i]);
        }

        const isObjectType = rawType === 'object'
            || (rawType === undefined && origDetailData && typeof origDetailData === 'object' && !Array.isArray(origDetailData));

        // 嵌套对象：用第一条子行重建一个对象返回
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

        // 对象数组：按子行重建数组
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

    /**
     * 把编辑后的字符串值，按原始字段类型尽量还原回原类型
     */
    private coerceValue(edited: string, origRaw: any): any {
        if (Array.isArray(origRaw)) {
            // 对象数组：优先按 JSON 解析（明细子表会序列化为 JSON 字符串）
            if (origRaw.length > 0 && typeof origRaw[0] === 'object' && origRaw[0] !== null) {
                if (!edited) return [];
                try { const v = JSON.parse(edited); if (Array.isArray(v)) return v; } catch { /* fall through */ }
            }
            // 标量数组：'; ' 分隔
            return edited
                ? edited.split('; ').map((s: string) => s.trim()).filter(Boolean)
                : [];
        }
        if (origRaw && typeof origRaw === 'object') {
            // 嵌套对象：优先按 JSON 解析
            if (!edited) return null;
            try { return JSON.parse(edited); } catch { return edited; }
        }
        if (typeof origRaw === 'boolean') {
            return edited === 'true';
        }
        if (typeof origRaw === 'number') {
            // 保持空字符串为 null，避免被误转 0
            if (edited === '' || edited === null || edited === undefined) return null;
            const n = Number(edited);
            return Number.isNaN(n) ? edited : n;
        }
        return this.parseCellValue(edited);
    }

    // ============================================
    // 格式化辅助
    // ============================================

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
     * 明细子表单元格格式化：
     * - 仅支持一层展开，子表中再次出现的嵌套对象/对象数组会序列化为 JSON 字符串展示与编辑。
     * - 标量数组（字符串/数字/布尔）用 '; ' 连接展示，与 formatCellValue 行为保持一致。
     */
    private formatDetailCellValue(value: any): string {
        if (value === null || value === undefined) return '';
        if (Array.isArray(value)) {
            if (value.length === 0) return '[]';
            if (typeof value[0] !== 'object' || value[0] === null) {
                return value.map(v => String(v ?? '')).join('; ');
            }
            // 对象数组：直接 JSON 字符串化，不再展开
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

// ============================================
// 公共辅助
// ============================================

export function getDetailFieldDisplay(field: string): string {
    const displayNames: Record<string, string> = {
        steps: '步骤明细',
        children: '子项明细',
        items: '条目明细',
        subTasks: '子任务明细',
        testCases: '测试案例明细',
        dataSources: '数据源明细',
    };
    return displayNames[field] || field;
}
