/**
 * ============================================================================
 *  parsers/file-parser.ts
 *  解析器接口定义
 * ----------------------------------------------------------------------------
 *  职责：描述任一文件解析器必须提供的能力：
 *    - parse：读文件 → (tableData, sourceData)
 *    - save ：将表格与原始结构合并后落盘
 *  说明：sourceData 存在的意义在于保留 YAML/JSON 嵌套结构，save 时以其为模板重建。
 * ============================================================================
 */
import type { TableData } from '../types';

// ============================================
// 文件解析器接口
// ============================================

export interface FileParseResult {
    tableData: TableData;
    /** 原始数据，保存时用于重建嵌套结构（YAML/JSON 子表） */
    sourceData: any;
}

export interface FileParser {
    parse(filePath: string): Promise<FileParseResult>;
    save(filePath: string, data: TableData, originalData?: any): Promise<void>;
}
