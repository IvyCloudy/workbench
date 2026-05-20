import * as XLSX from 'xlsx';
import * as fs from 'fs';
import type { SheetCell, SheetRow, SheetData, ExcelData } from '../types';

// ==================== 类型导出（保持向后兼容） ====================

export type { SheetCell, SheetRow, SheetData, ExcelData };

// ==================== 常量定义 ====================

const MIN_COL_WIDTH = 70;     // 最小列宽（像素）
const MAX_COL_WIDTH = 300;    // 最大列宽（像素）
const CHAR_WIDTH = 8;         // 单个字符宽度（像素）
const MAX_ROWS_TO_CHECK = 10; // 计算列宽时检查的最大行数
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB 大文件警告阈值

// ==================== 工具函数 ====================

/**
 * 根据单元格内容计算列宽（优化：使用表头和数据计算）
 * @param dataRows 数据行数组
 * @param headerRow 表头行数组
 * @param colIndex 列索引
 * @returns 计算后的列宽（像素）
 */
function calculateColWidth(dataRows: any[][], headerRow: any[], colIndex: number): number {
    // 取表头和数据行的最大长度
    let maxLength = String(headerRow[colIndex] ?? '').length;

    // 只检查前 N 行数据以提高性能
    const rowsToCheck = Math.min(dataRows.length, MAX_ROWS_TO_CHECK);
    for (let i = 0; i < rowsToCheck; i++) {
        const length = String(dataRows[i]?.[colIndex] ?? '').length;
        if (length > maxLength) {
            maxLength = length;
        }
    }

    // 计算宽度并限制范围
    const width = maxLength * CHAR_WIDTH;
    return Math.min(Math.max(width, MIN_COL_WIDTH), MAX_COL_WIDTH);
}

/**
 * 检查文件大小并发出警告
 * @param filePath 文件路径
 * @param size 文件大小（字节）
 */
function checkFileSize(filePath: string, size: number): void {
    if (size > MAX_FILE_SIZE) {
        console.warn(`[csv-parser] 大文件警告: ${filePath} (${(size / 1024 / 1024).toFixed(2)}MB)`);
    }
}

/**
 * 解析 JSON 数据到 SheetData（优化：避免重复 slice）
 * @param jsonData 解析后的二维数组
 * @returns 解析结果
 */
function parseJsonToSheetData(jsonData: any[][]): {
    rows: { [key: number]: SheetRow };
    cols: { [key: string]: { width: number } };
    maxCols: number;
    maxLength: number;
} {
    if (jsonData.length === 0) {
        return { rows: {}, cols: {}, maxCols: 0, maxLength: 0 };
    }

    const headerRow = jsonData[0] || [];
    const dataRows = jsonData.slice(1); // 只创建一次
    const numCols = headerRow.length;
    const numDataRows = dataRows.length;

    const rows: { [key: number]: SheetRow } = {};
    const cols: { [key: string]: { width: number } } = {};

    // 构建表头行
    rows[0] = { cells: {} };
    for (let colIdx = 0; colIdx < numCols; colIdx++) {
        rows[0].cells[colIdx] = { text: String(headerRow[colIdx] ?? '') };
    }

    // 构建数据行
    for (let rowIdx = 0; rowIdx < numDataRows; rowIdx++) {
        const row = dataRows[rowIdx];
        const cells: { [key: number]: SheetCell } = {};
        for (let colIdx = 0; colIdx < numCols; colIdx++) {
            cells[colIdx] = { text: String(row?.[colIdx] ?? '') };
        }
        rows[rowIdx + 1] = { cells };
    }

    // 计算列宽（使用已提取的 dataRows）
    for (let i = 0; i < numCols; i++) {
        cols[i] = { width: calculateColWidth(dataRows, headerRow, i) };
    }

    return { rows, cols, maxCols: numCols, maxLength: numDataRows };
}

// ==================== 核心函数 ====================

/**
 * 从文件加载 CSV 数据
 * @param filePath CSV 文件路径
 * @returns 解析后的 ExcelData 对象
 */
export function loadCsvFromFile(filePath: string): ExcelData {
    try {
        // 获取文件大小
        const stats = fs.statSync(filePath);
        checkFileSize(filePath, stats.size);

        // 读取文件内容（UTF-8 编码）
        const buffer = fs.readFileSync(filePath);
        let content = buffer.toString('utf-8');

        // 移除 BOM 字符
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }

        // 使用 xlsx 库解析 CSV 字符串
        const workbook = XLSX.read(content, { type: 'string' });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];

        // 将工作表转换为二维数组
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { raw: false, header: 1 }) as any[][];

        // 解析数据
        const { rows, cols, maxCols, maxLength } = parseJsonToSheetData(jsonData);

        return {
            sheets: [{ name: 'Sheet1', rows, cols }],
            maxCols,
            maxLength
        };
    } catch (error) {
        console.error('Failed to load CSV:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}

/**
 * 从字符串内容加载 CSV 数据
 * @param content CSV 内容字符串
 * @returns 解析后的 ExcelData 对象
 */
export function loadCsvFromContent(content: string): ExcelData {
    try {
        // 移除 BOM 字符
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }

        const workbook = XLSX.read(content, { type: 'string', raw: true });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { raw: false, header: 1 }) as any[][];

        // 解析数据
        const { rows, cols, maxCols, maxLength } = parseJsonToSheetData(jsonData);

        return {
            sheets: [{ name: 'Sheet1', rows, cols }],
            maxCols,
            maxLength
        };
    } catch (error) {
        console.error('Failed to parse CSV content:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}

/**
 * 将 SheetData 导出为 CSV 格式字符串
 * @param sheets 工作表数据数组
 * @returns CSV 格式字符串
 */
export function exportToCsv(sheets: SheetData[]): string {
    if (!sheets || sheets.length === 0) return '';

    const firstSheet = sheets[0];
    if (!firstSheet || !firstSheet.rows) return '';

    // 按行索引排序获取所有行
    const rowKeys = Object.keys(firstSheet.rows)
        .map(k => parseInt(k))
        .sort((a, b) => a - b);

    if (rowKeys.length === 0) return '';

    // 找到最大列数
    let maxCol = 0;
    rowKeys.forEach(ri => {
        const row = firstSheet.rows[ri];
        if (row && row.cells) {
            Object.keys(row.cells).forEach(ci => {
                const colIdx = parseInt(ci);
                if (colIdx > maxCol) maxCol = colIdx;
            });
        }
    });

    // 构建二维数组
    const aoa: any[][] = rowKeys.map(ri => {
        const row = firstSheet.rows[ri];
        const rowData: any[] = new Array(maxCol + 1).fill('');
        if (row && row.cells) {
            Object.keys(row.cells).forEach(ci => {
                const colIdx = parseInt(ci);
                rowData[colIdx] = row.cells[colIdx]?.text ?? '';
            });
        }
        return rowData;
    });

    // 使用 XLSX 将二维数组转换为 CSV 字符串
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    return XLSX.utils.sheet_to_csv(worksheet);
}

/**
 * 将 SheetData 转换为标准 CSV 格式（带转义）
 * @param sheets 工作表数据数组
 * @returns CSV 格式字符串
 */
export function sheetToCsv(sheets: SheetData[]): string {
    const firstSheet = sheets[0];
    if (!firstSheet) return '';

    const rowKeys = Object.keys(firstSheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
    const lines: string[] = [];

    rowKeys.forEach(ri => {
        const row = firstSheet.rows[ri];
        if (!row) return;
        const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
        const values = cellKeys.map(ci => {
            const text = row.cells[ci]?.text || '';
            // CSV 转义：包含逗号、引号或换行的字段需要用引号包裹，引号内部引号需要双写
            if (text.includes(',') || text.includes('"') || text.includes('\n')) {
                return '"' + text.replace(/"/g, '""') + '"';
            }
            return text;
        });
        lines.push(values.join(','));
    });

    return lines.join('\n');
}
