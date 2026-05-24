/**
 * ============================================================================
 *  parsers/index.ts
 *  解析器工厂 + 推送追踪列补全逻辑
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. createParser / detectFileType：根据后缀返回对应解析器实例。
 *    2. ensureTrackingColumns：为表格补全 tsId 列（推送唯一主键）。
 *    3. applyTestCaseNos：推送成功后按 tsId 回写 testCaseNo 列。
 *    4. parseFileToRows：资源管理器右键推送路径使用。
 *  设计要点：
 *    - tsId 只可从本文件生成，避免多处独立实现造成 ID 不一致。
 *    - YAML/JSON 同时将 tsId/testCaseNo 写入 sourceData，以保证 save 重建嵌套结构时不丢字段。
 * ============================================================================
 */
import * as path from 'path';
import { CsvFileParser } from './csv-parser';
import { YamlFileParser } from './yaml-parser';
import { JsonFileParser } from './json-parser';
import type { FileParser, FileParseResult } from './file-parser';
import type { TableData } from '../types';
import { TS_ID_COLUMN, TEST_CASE_NO_COLUMN, genUuid } from '../services/utils';

// 导出类型与具体解析器
export type { FileParser, FileParseResult };
export { CsvFileParser, YamlFileParser, JsonFileParser };

export type FileType = 'csv' | 'yaml' | 'json';

/**
 * 根据文件类型创建对应的解析器
 */
export function createParser(type: FileType): FileParser {
    switch (type) {
        case 'csv': return new CsvFileParser();
        case 'yaml': return new YamlFileParser();
        case 'json': return new JsonFileParser();
        default: throw new Error(`不支持的文件类型: ${type}`);
    }
}

/**
 * 根据文件后缀推断文件类型
 */
export function detectFileType(filePath: string): FileType | null {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.csv') return 'csv';
    if (ext === '.yaml' || ext === '.yml') return 'yaml';
    if (ext === '.json') return 'json';
    return null;
}

/**
 * 确保表格包含 tsId 列：
 *   - 不存在则插入到 headers 最前面，并为每行补 uuid
 *   - 已存在但部分行为空，逐行补 uuid
 *
 * 同时把 tsId 字段回写到 sourceData（YAML/JSON 用于 save 重建嵌套结构时也能保留 tsId）。
 *
 * @returns generated  是否产生了新的 uuid（true 时调用方应立刻 save 让 tsId 持久化）
 */
export function ensureTrackingColumns(
    tableData: TableData,
    sourceData?: any
): { tableData: TableData; generated: boolean } {
    if (!tableData) return { tableData, generated: false };
    if (!Array.isArray(tableData.headers)) tableData.headers = [];
    if (!Array.isArray(tableData.rows)) tableData.rows = [];

    let generated = false;

    let tsIdx = tableData.headers.indexOf(TS_ID_COLUMN);
    if (tsIdx < 0) {
        tableData.headers.unshift(TS_ID_COLUMN);
        tableData.rows.forEach(row => {
            row.unshift(genUuid());
        });
        tsIdx = 0;
        generated = tableData.rows.length > 0;
    } else {
        tableData.rows.forEach(row => {
            if (!row[tsIdx] || String(row[tsIdx]).trim() === '') {
                row[tsIdx] = genUuid();
                generated = true;
            }
        });
    }

    // 同步把 tsId 写回 sourceData（YAML/JSON 保存时会优先用 sourceData 重建嵌套结构）
    if (sourceData) {
        const recs: any[] = Array.isArray(sourceData) ? sourceData : [sourceData];
        for (let i = 0; i < recs.length && i < tableData.rows.length; i++) {
            const rec = recs[i];
            if (rec && typeof rec === 'object') {
                const v = tableData.rows[i][tsIdx];
                if (rec[TS_ID_COLUMN] === undefined || rec[TS_ID_COLUMN] === null || String(rec[TS_ID_COLUMN]).trim() === '') {
                    rec[TS_ID_COLUMN] = v;
                }
            }
        }
    }

    return { tableData, generated };
}

/**
 * 推送成功后，按 tsId 把 testCaseNo 回写到 tableData / sourceData。
 *   - 若 testCaseNo 列不存在，则插入到 tsId 列右侧
 *   - 同步把字段写回 sourceData（YAML/JSON save 时会用到）
 *
 * @returns updatedRowIndices  实际被更新的行号集合（按返回顺序），调用方可据此触发保存
 */
export function applyTestCaseNos(
    tableData: TableData,
    sourceData: any,
    mappings: Array<{ tsId: string; testCaseNo: string }>
): number[] {
    if (!tableData || !Array.isArray(mappings) || mappings.length === 0) return [];
    if (!Array.isArray(tableData.headers)) tableData.headers = [];
    if (!Array.isArray(tableData.rows)) tableData.rows = [];

    const tsIdx = tableData.headers.indexOf(TS_ID_COLUMN);
    if (tsIdx < 0) return [];

    let tcIdx = tableData.headers.indexOf(TEST_CASE_NO_COLUMN);
    if (tcIdx < 0) {
        tableData.headers.splice(tsIdx + 1, 0, TEST_CASE_NO_COLUMN);
        tableData.rows.forEach(row => row.splice(tsIdx + 1, 0, ''));
        tcIdx = tsIdx + 1;
    }

    // 建索引：tsId -> rowIdx
    const rowIdxByTsId: Record<string, number> = {};
    tableData.rows.forEach((row, ri) => {
        const key = row[tsIdx];
        if (key !== undefined && key !== null && String(key) !== '') {
            rowIdxByTsId[String(key)] = ri;
        }
    });

    const updated: number[] = [];
    const sourceRecs: any[] = Array.isArray(sourceData) ? sourceData : (sourceData ? [sourceData] : []);

    mappings.forEach(({ tsId, testCaseNo }) => {
        if (!tsId) return;
        const ri = rowIdxByTsId[String(tsId)];
        if (ri === undefined) return;
        if (!tableData.rows[ri]) return;
        tableData.rows[ri][tcIdx] = testCaseNo == null ? '' : String(testCaseNo);
        // 同步原始数据
        const rec = sourceRecs[ri];
        if (rec && typeof rec === 'object') {
            rec[TEST_CASE_NO_COLUMN] = testCaseNo == null ? '' : String(testCaseNo);
        }
        updated.push(ri);
    });

    return updated;
}

/**
 * 解析文件并返回二维数组（推送用）
 */
export async function parseFileToRows(filePath: string): Promise<any[] | null> {
    const type = detectFileType(filePath);
    if (!type) return null;

    const parser = createParser(type);
    const { tableData, sourceData } = await parser.parse(filePath);
    ensureTrackingColumns(tableData, sourceData);

    // CSV: 直接由 headers + rows 组装对象（已包含 tsId 列）
    if (type === 'csv') {
        return tableData.rows.map(row => {
            const record: any = {};
            tableData.headers.forEach((h, i) => { record[h] = row[i] ?? ''; });
            return record;
        });
    }

    // YAML / JSON: 优先用 sourceData（保留嵌套结构），并把 tsId 注入到每条记录上
    const recs: any[] = Array.isArray(sourceData)
        ? sourceData.slice()
        : (sourceData && typeof sourceData === 'object' ? [sourceData] : []);
    if (recs.length === 0) return null;

    const tsIdx = tableData.headers.indexOf(TS_ID_COLUMN);
    return recs.map((rec, i) => {
        const out = (rec && typeof rec === 'object') ? { ...rec } : { value: rec };
        if (tsIdx >= 0 && (!out[TS_ID_COLUMN] || String(out[TS_ID_COLUMN]).trim() === '')) {
            out[TS_ID_COLUMN] = tableData.rows[i] ? tableData.rows[i][tsIdx] : genUuid();
        }
        return out;
    });
}
