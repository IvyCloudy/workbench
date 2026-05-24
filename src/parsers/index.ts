import * as path from 'path';
import { CsvFileParser } from './csv-parser';
import { YamlFileParser } from './yaml-parser';
import { JsonFileParser } from './json-parser';
import type { FileParser, FileParseResult } from './file-parser';

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
 * 解析文件并返回二维数组（推送用）
 */
export async function parseFileToRows(filePath: string): Promise<any[] | null> {
    const type = detectFileType(filePath);
    if (!type) return null;

    const parser = createParser(type);
    const { tableData, sourceData } = await parser.parse(filePath);

    // CSV: 直接由 headers + rows 组装对象
    if (type === 'csv') {
        return tableData.rows.map(row => {
            const record: any = {};
            tableData.headers.forEach((h, i) => { record[h] = row[i] ?? ''; });
            return record;
        });
    }

    // YAML / JSON: 优先用 sourceData（保留嵌套结构）
    if (Array.isArray(sourceData)) return sourceData;
    if (sourceData && typeof sourceData === 'object') return [sourceData];
    return null;
}
