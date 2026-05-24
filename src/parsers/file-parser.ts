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
