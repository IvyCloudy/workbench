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
    /**
     * 表格主体对应的原始行数组（来自 findArrayData(value)），行号与 webview rows[ri] 对齐。
     * 用于列类型推断与数组列原值还原；sourceData 顶层可能是包裹对象时两者不一致。
     */
    rowsSource?: any[];
    /**
     * 原始 YAML 文件顶层形态：
     *   - true  → 顶层是数组 (例如 `- testcase_id: ...`)
     *   - false → 顶层是单条对象 (例如 `testcase_id: ...`)
     * save 时按该标记决定是否包数组，避免文件被默默改写格式。
     */
    topLevelIsArray?: boolean;
    detailTable?: DetailTableData;
    detailTables?: DetailTableData[];
}

// 在 TableData 上挂载顶层形态标记（save 时读取）。声明合并，避免污染 types/index.ts。
declare module '../types' {
    interface TableData {
        /** YAML 顶层形态：true=数组、false=单对象。仅 yaml-parser 自用。 */
        __yamlTopLevelIsArray?: boolean;
    }
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
        const rows: any[][] = [];

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
            const rowData: any[] = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text ?? '');
            while (rowData.length < headers.length) rowData.push('');
            rows.push(rowData);
        });

        let sourceData: any = data.sourceData;
        if (!Array.isArray(sourceData) && typeof sourceData === 'object' && sourceData !== null) {
            sourceData = [sourceData];
        }

        // 主表主体的原始行数组（与 webview rows[ri] 严格对齐）；顶层是包裹对象时与 sourceData 不同
        const rowsSource: any[] = Array.isArray(data.rowsSource) ? data.rowsSource : sourceData;

        // 计算每列类型（保守策略：只有该列每一行都是同质的标量数组才标 string[]/number[]）
        // 同时把这些列的单元格从字符串还原为真实数组，让 webview 走 chip + 多项编辑弹窗。
        const columnTypes = this.detectColumnTypes(headers, rowsSource, data.detailTables);
        for (let ri = 0; ri < rows.length; ri++) {
            const orig = ri < rowsSource.length ? rowsSource[ri] : undefined;
            if (!orig || typeof orig !== 'object') continue;
            headers.forEach((h, ci) => {
                const t = columnTypes[h];
                if (t === 'string[]' || t === 'number[]') {
                    const v = orig[h];
                    rows[ri][ci] = Array.isArray(v) ? v.slice() : [];
                }
            });
        }

        return {
            tableData: {
                headers,
                rows,
                detailTable: data.detailTable,
                detailTables: data.detailTables,
                columnTypes,
                // 透传顶层形态标记，save 时读取以保留原文件结构
                __yamlTopLevelIsArray: data.topLevelIsArray
            },
            sourceData
        };
    }

    /**
     * 列类型识别（保守策略）：
     *   - 明细列（detailTables 中已有同名 field）→ 'detail'
     *   - 非明细列：扫描 sourceData 每行同名字段；
     *       * 全为 string / number / boolean / null / undefined / ''  → 'scalar'
     *       * 全为标量数组（其中至少有一行非 null/undefined 数组），且元素同质：
     *           - 全字符串（含空字符串、null/undefined 视为同质允许）→ 'string[]'
     *           - 全数字 → 'number[]'
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
            let allArrays = true;            // 是否每一行该字段都是数组（null/undefined 视为缺失，单独处理）
            let anyArray = false;            // 是否至少出现过一次非空数组（避免全是 null 误判）
            let elemKind: 'string' | 'number' | 'mixed' | 'unknown' = 'unknown';
            for (const r of rows) {
                if (!r || typeof r !== 'object') { allArrays = false; break; }
                const v = (r as any)[h];
                if (v === undefined || v === null) {
                    // 缺失值不破坏判定，但需有至少一行是真实数组才会最终判定为数组列
                    continue;
                }
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

        // 行身份解析：用 testcase_id（稳定主键）把当前 row 与 originalData 中的真实记录对齐，
        // 避免"右键插入行/排序/中间删除"导致的 originalData[rowIdx] 索引错位
        // —— 若不做此对齐，新插入行会回退到相邻原始行的对象/对象数组数据，造成"刷新后被相邻行覆盖"。
        const tsIdColIdx = headers.indexOf('testcase_id');
        const origByTsId = new Map<string, any>();
        if (Array.isArray(originalData) && tsIdColIdx >= 0) {
            for (const rec of originalData) {
                if (rec && typeof rec === 'object') {
                    const tid = (rec as any)['testcase_id'];
                    if (tid !== undefined && tid !== null && tid !== '') {
                        origByTsId.set(String(tid), rec);
                    }
                }
            }
        }

        const records: any[] = rows.map((row, rowIdx) => {
            const record: any = {};
            // 优先按 testcase_id 在 originalData 中查找真实匹配的源记录；
            // 找不到（新插入行）→ origRecord 为 undefined，让明细字段回退到"空对象/空数组"而不是错位行的旧数据。
            const tsIdVal = (tsIdColIdx >= 0) ? row[tsIdColIdx] : undefined;
            let origRecord: any = undefined;
            if (tsIdVal !== undefined && tsIdVal !== null && tsIdVal !== '' && origByTsId.size > 0) {
                origRecord = origByTsId.get(String(tsIdVal));
            }
            // 兜底：testcase_id 列不存在或没找到匹配 → 仍按 rowIdx 取（保留对老文件的兼容性，
            // 但仅在 origByTsId 完全不可用时使用，避免错位风险）
            if (!origRecord && origByTsId.size === 0
                && Array.isArray(originalData) && rowIdx < originalData.length) {
                origRecord = originalData[rowIdx];
            }
            headers.forEach((h, i) => {
                const dt = tablesByField.get(h);
                if (dt && dt.rowGroups) {
                    // 取真实匹配源记录上的明细字段值；未匹配到则传 undefined，
                    // reconstructDetail 内部会按 rawRowTypes 回退到空对象/空数组。
                    const origDetailData = origRecord ? origRecord[h] : undefined;
                    record[h] = this.reconstructDetail(rowIdx, dt, origDetailData, row, i);
                } else {
                    const origVal = origRecord ? origRecord[h] : undefined;
                    record[h] = this.coerceValue(row[i], origVal);
                }
            });
            return record;
        });

        // 顶层形态决定输出包装方式：
        //   - 原文件顶层是数组（含 "- testcase_id: ..." 这种单元素数组）→ 输出仍包装为数组
        //   - 原文件顶层是单对象 → 输出单对象
        //   - 历史/未知（无标记）→ 维持旧行为：单条则输出对象，多条则输出数组
        const topLevelIsArray = (data as any).__yamlTopLevelIsArray;
        let toWrite: any;
        if (topLevelIsArray === true) {
            toWrite = records;
        } else if (topLevelIsArray === false) {
            toWrite = records.length === 1 ? records[0] : records;
        } else {
            toWrite = records.length === 1 ? records[0] : records;
        }

        // 多行字符串（含 \n）自动用块标量 |- 输出，避免 \n 字面量替换破坏 SQL/期望结果可读性。
        const yamlContent = YAML.stringify(toWrite, {
            lineWidth: 0,
            defaultStringType: 'PLAIN',
            defaultKeyType: 'PLAIN',
            blockQuote: 'literal'
        } as any);
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
        let topLevelIsArray: boolean | undefined = undefined;
        try {
            const docs = YAML.parseAllDocuments(cleanContent);
            for (const doc of docs) {
                const value = doc.toJSON();
                if (value !== null && value !== undefined) {
                    sourceData = value;
                    if (topLevelIsArray === undefined) {
                        topLevelIsArray = Array.isArray(value);
                    }
                    parsed = this.findArrayData(value);
                    if (parsed) break;
                }
            }
        } catch {
            sourceData = YAML.parse(cleanContent);
            if (topLevelIsArray === undefined) {
                topLevelIsArray = Array.isArray(sourceData);
            }
            parsed = this.findArrayData(sourceData);
        }

        if (!parsed) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], sourceData, topLevelIsArray };
        }

        const sheet = this.toSheet(parsed);
        const detailTables = this.extractDetailTables(parsed);

        return {
            sheets: [sheet],
            sourceData,
            rowsSource: parsed,
            topLevelIsArray,
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
            // 仅当顶层对象"看起来像纯容器"（所有字段都是对象数组，没有任何标量字段）
            // 时，才尝试在嵌套字段里寻找记录数组；否则一律将顶层对象视为单条记录 [data]。
            //
            // 这样可以同时兼容：
            //   - 顶层为对象数组：     - testcase_id: ...      → 直接命中外层数组分支
            //   - 顶层为单条记录对象： testcase_id: ...        → 走 [data] 分支（关键修复点）
            //   - 包裹容器：           { records: [{...}, ...] }→ 走嵌套对象数组分支
            //
            // 修复 bug：当顶层是单条记录对象（含 preconditions/steps 等嵌套数组字段）时，
            // 旧实现会误把第一个非空嵌套数组（如 preconditions: ["CES"] / steps: [{...}]）
            // 当成主表数据，导致 headers 解析为空、保存时整条记录被丢光，仅留 testcase_id。
            const keys = Object.keys(data);
            let hasScalarOrPlainObject = false;
            const arrayCandidates: any[][] = [];
            for (const key of keys) {
                const v = data[key];
                if (Array.isArray(v)) {
                    if (v.length > 0) arrayCandidates.push(v);
                } else {
                    // 任意非数组字段（标量、null、嵌套对象等）→ 顶层不是纯容器
                    hasScalarOrPlainObject = true;
                    break;
                }
            }
            if (!hasScalarOrPlainObject) {
                // 纯容器：选择第一个"元素都是对象"的数组作为主表
                for (const arr of arrayCandidates) {
                    const allObjectRecords = arr.every(item =>
                        item !== null && typeof item === 'object' && !Array.isArray(item)
                    );
                    if (allObjectRecords) return arr;
                }
            }
            if (keys.length > 0) return [data];
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
        origDetailData: any,
        row: string[],
        i: number
    ): any {
        const editedRows: string[][] = detailTable.rowGroups[rowIdx] || [];
        const rawRowsFromFront: any[] = (detailTable.rawRowGroups && detailTable.rawRowGroups[rowIdx]) || [];
        const rawType = detailTable.rawRowTypes ? detailTable.rawRowTypes[rowIdx] : undefined;

        const isObjectType = rawType === 'object'
            || (rawType === undefined && origDetailData && typeof origDetailData === 'object' && !Array.isArray(origDetailData));

        // 无明细且前端也没有 raw：
        //   1) 已有 origDetailData（按 testcase_id 真实匹配到原始记录）→ 沿用原值
        //   2) 否则按 rawType 回退到空对象/空数组/parseCellValue —— 关键：插入新行时
        //      origDetailData 为 undefined，避免错位继承相邻行数据
        if (editedRows.length === 0 && rawRowsFromFront.length === 0) {
            if (origDetailData !== undefined) return origDetailData;
            if (rawType === 'object') return {};
            if (rawType === 'array') return [];
            return this.parseCellValue(row[i]);
        }

        // ---------- 优先信任前端 rawRowGroups（v2 弹窗写入的真实结构）----------
        // v2 弹窗每次编辑都直接写到 detailTable.rawRowGroups[rowIdx][di][field]，
        // 因此只要前端送来了 raw，我们就以它为权威，不再依赖 editedRows 字符串拆解。
        if (rawRowsFromFront.length > 0) {
            // 嵌套对象类型：取第一条作为对象返回
            if (isObjectType) {
                const r0 = rawRowsFromFront[0];
                if (r0 && typeof r0 === 'object' && !Array.isArray(r0)) return { ...r0 };
                return r0 ?? {};
            }
            // 对象数组类型：每条 step 浅拷贝一份，避免外部引用
            return rawRowsFromFront.map(r => (r && typeof r === 'object') ? { ...r } : r);
        }

        // ---------- 兼容旧链路：仅有 editedRows（字符串二维结构）----------
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

        // 对象数组：按子行重建数组（旧链路）
        let rawRows: any[] = Array.isArray(origDetailData) ? [...origDetailData] : [];
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
     * 把编辑后的值（字符串 or 数组）按原始字段类型尽量还原回原类型。
     * - 当 edited 已经是 array（前端弹窗每项独立编辑后的真实数组），按元素样本类型还原元素，避免数字被引号化。
     * - 当 edited 是字符串，沿用原有兼容逻辑（旧表格场景）。
     */
    private coerceValue(edited: any, origRaw: any): any {
        // 新链路：前端已传入数组形态，按原数组的元素类型样本逐项还原
        if (Array.isArray(edited)) {
            // 取一个非空样本判定元素类型
            let sample: any = undefined;
            if (Array.isArray(origRaw)) {
                for (const it of origRaw) {
                    if (it !== null && it !== undefined && it !== '') { sample = it; break; }
                }
            }
            return edited.map((it: any) => this.coerceArrayItem(it, sample));
        }
        if (Array.isArray(origRaw)) {
            // 对象数组：优先按 JSON 解析（明细子表会序列化为 JSON 字符串）
            if (origRaw.length > 0 && typeof origRaw[0] === 'object' && origRaw[0] !== null) {
                if (!edited) return [];
                try { const v = JSON.parse(edited); if (Array.isArray(v)) return v; } catch { /* fall through */ }
            }
            // 标量数组（兼容老链路）：'; ' 分隔；空项保留
            if (edited === '' || edited === null || edited === undefined) return [];
            return String(edited).split('; ').map((s: string) => s);
        }
        if (origRaw && typeof origRaw === 'object') {
            // 嵌套对象：优先按 JSON 解析
            if (!edited) return null;
            try { return JSON.parse(edited); } catch { return edited; }
        }
        if (typeof origRaw === 'boolean') {
            return edited === 'true' || edited === true;
        }
        if (typeof origRaw === 'number') {
            // 保持空字符串为 null，避免被误转 0
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
     * - 注意：弹窗会优先消费 rawRowGroups（保留原始数组形态）来实现「每项独立编辑」，
     *   该方法仅作降级展示；保存路径不依赖此处生成的字符串。
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
