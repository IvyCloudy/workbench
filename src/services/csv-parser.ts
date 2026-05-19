import * as XLSX from 'xlsx';
import * as fs from 'fs';

// ==================== 类型定义 ====================

/** 单元格数据 */
export interface SheetCell {
    text: string;      // 单元格文本内容
    style?: number;    // 单元格样式索引（可选）
}

/** 表格行 */
export interface SheetRow {
    cells: { [key: number]: SheetCell };  // 列索引到单元格的映射
}

/** 表格数据 */
export interface SheetData {
    name: string;                          // 工作表名称
    rows: { [key: number]: SheetRow };     // 行索引到行数据的映射
    cols?: { [key: string]: { width: number } };  // 列宽信息
}

/** Excel/CSV 完整数据 */
export interface ExcelData {
    sheets: SheetData[];   // 所有工作表
    maxCols: number;       // 最大列数
    maxLength: number;     // 最大行数
}

// ==================== 常量定义 ====================

const MIN_COL_WIDTH = 70;     // 最小列宽（像素）
const MAX_COL_WIDTH = 300;    // 最大列宽（像素）
const CHAR_WIDTH = 8;         // 单个字符宽度（像素）
const MAX_ROWS_TO_CHECK = 10; // 计算列宽时检查的最大行数

// ==================== 工具函数 ====================

/**
 * 根据单元格内容计算列宽
 * @param rows 数据行
 * @param colIndex 列索引
 * @returns 计算后的列宽（像素）
 */
function calculateColWidth(rows: any[][], colIndex: number): number {
    let maxLength = 0;
    // 只检查前 N 行以提高性能
    for (let i = 0; i < Math.min(rows.length, MAX_ROWS_TO_CHECK); i++) {
        const cell = rows[i][colIndex];
        if (cell) {
            const length = String(cell).length;
            if (length > maxLength) {
                maxLength = length;
            }
        }
    }
    // 计算宽度并限制范围
    const width = maxLength * CHAR_WIDTH;
    return Math.min(Math.max(width, MIN_COL_WIDTH), MAX_COL_WIDTH);
}

// ==================== 核心函数 ====================

/**
 * 从文件加载 CSV 数据
 * @param filePath CSV 文件路径
 * @returns 解析后的 ExcelData 对象
 */
export function loadCsvFromFile(filePath: string): ExcelData {
    try {
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
        // 将工作表转换为二维数组，header: 1 表示第一行作为表头
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { raw: false, header: 1 }) as any[][];

        if (jsonData.length === 0) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }

        // 提取表头
        const headers = jsonData[0] || [];
        const rows: { [key: number]: SheetRow } = {};

        // 将表头作为 rows[0]，数据从 rows[1] 开始
        rows[0] = { cells: {} };
        headers.forEach((h, colIdx) => {
            rows[0].cells[colIdx] = { text: String(h ?? '') };
        });

        // 转换数据行
        jsonData.slice(1).forEach((row, rowIdx) => {
            const cells: { [key: number]: SheetCell } = {};
            row.forEach((cell, colIdx) => {
                cells[colIdx] = { text: String(cell ?? '') };
            });
            rows[rowIdx + 1] = { cells };
        });

        // 计算每列宽度
        const cols: { [key: string]: { width: number } } = {};
        for (let i = 0; i < headers.length; i++) {
            cols[i] = { width: calculateColWidth(jsonData.slice(1), i) };
        }

        return {
            sheets: [{ name: 'Sheet1', rows, cols }],
            maxCols: headers.length,
            maxLength: jsonData.length - 1
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

        if (jsonData.length === 0) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }

        const rows: { [key: number]: SheetRow } = {};

        // 将表头作为 rows[0]
        rows[0] = { cells: {} };
        (jsonData[0] || []).forEach((h, colIdx) => {
            rows[0].cells[colIdx] = { text: String(h ?? '') };
        });

        // 转换数据行
        jsonData.slice(1).forEach((row, rowIdx) => {
            const cells: { [key: number]: SheetCell } = {};
            row.forEach((cell, colIdx) => {
                cells[colIdx] = { text: String(cell ?? '') };
            });
            rows[rowIdx + 1] = { cells };
        });

        // 计算列宽
        const cols: { [key: string]: { width: number } } = {};
        for (let i = 0; i < (jsonData[0]?.length || 0); i++) {
            cols[i] = { width: calculateColWidth(jsonData.slice(1), i) };
        }

        return {
            sheets: [{ name: 'Sheet1', rows, cols }],
            maxCols: jsonData[0]?.length || 0,
            maxLength: jsonData.length - 1
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
    const aoa: any[][] = [];
    const firstSheet = sheets[0];
    if (!firstSheet) return '';

    // 按行索引排序获取所有行
    const rowKeys = Object.keys(firstSheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);

    rowKeys.forEach(ri => {
        const row = firstSheet.rows[ri];
        if (!row) return;
        const rowData: any[] = [];
        const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
        cellKeys.forEach(ci => {
            rowData[ci] = row.cells[ci]?.text || '';
        });
        aoa.push(rowData);
    });

    // 将二维数组转换为工作表，再获取 A1 单元格的值
    return XLSX.utils.aoa_to_sheet(aoa).A1?.v as string || '';
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
