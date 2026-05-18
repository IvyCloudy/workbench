import * as XLSX from 'xlsx';
import * as fs from 'fs';

export interface SheetCell {
    text: string;
    style?: number;
}

export interface SheetRow {
    cells: { [key: number]: SheetCell };
}

export interface SheetData {
    name: string;
    rows: { [key: number]: SheetRow };
    cols?: { [key: string]: { width: number } };
}

export interface ExcelData {
    sheets: SheetData[];
    maxCols: number;
    maxLength: number;
}

const MIN_COL_WIDTH = 70;
const MAX_COL_WIDTH = 300;
const CHAR_WIDTH = 8;
const MAX_ROWS_TO_CHECK = 10;

function calculateColWidth(rows: any[][], colIndex: number): number {
    let maxLength = 0;
    for (let i = 0; i < Math.min(rows.length, MAX_ROWS_TO_CHECK); i++) {
        const cell = rows[i][colIndex];
        if (cell) {
            const length = String(cell).length;
            if (length > maxLength) {
                maxLength = length;
            }
        }
    }
    const width = maxLength * CHAR_WIDTH;
    return Math.min(Math.max(width, MIN_COL_WIDTH), MAX_COL_WIDTH);
}

export function loadCsvFromFile(filePath: string): ExcelData {
    try {
        // 读取文件 buffer
        const buffer = fs.readFileSync(filePath);
        
        // 先尝试 UTF-8
        let content = buffer.toString('utf-8');
        
        // 检测编码：如果文本中包含控制字符但不是真正的控制字符，说明可能是乱码
        // GBK中文被UTF-8解析后会包含Â、Ã等字符
        const likelyGarbled = /[ÃÂ][ÃÂ¼½¾]/.test(content);
        
        if (likelyGarbled) {
            // 尝试 GBK
            const iconv = require('iconv-lite');
            const gbkContent = iconv.decode(buffer, 'gbk');
            // 检查 GBK 解码后是否更合理（包含正常中文字符）
            if (/[\u4e00-\u9fa5]/.test(gbkContent)) {
                content = gbkContent;
            }
        }
        
        // 使用xlsx解析CSV字符串内容
        const workbook = XLSX.read(content, { type: 'string' });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { raw: false, header: 1 }) as any[][];

        if (jsonData.length === 0) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }

        const headers = jsonData[0] || [];
        const rows: { [key: number]: SheetRow } = {};

        // 将表头作为 rows[0]，数据从 rows[1] 开始
        // 这样与 parseCsvData 的预期一致
        rows[0] = { cells: {} };
        headers.forEach((h, colIdx) => {
            rows[0].cells[colIdx] = { text: String(h ?? '') };
        });

        jsonData.slice(1).forEach((row, rowIdx) => {
            const cells: { [key: number]: SheetCell } = {};
            row.forEach((cell, colIdx) => {
                cells[colIdx] = { text: String(cell ?? '') };
            });
            rows[rowIdx + 1] = { cells };  // 数据行从索引1开始
        });

        // 计算列宽
        const cols: { [key: string]: { width: number } } = {};
        for (let i = 0; i < headers.length; i++) {
            cols[i] = { width: calculateColWidth(jsonData.slice(1), i) };
        }

        const maxCols = headers.length;

        return {
            sheets: [{ name: 'Sheet1', rows, cols }],
            maxCols,
            maxLength: jsonData.length - 1
        };
    } catch (error) {
        console.error('Failed to load CSV:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}

export function loadCsvFromContent(content: string): ExcelData {
    try {
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

export function exportToCsv(sheets: SheetData[]): string {
    const aoa: any[][] = [];
    const firstSheet = sheets[0];
    if (!firstSheet) return '';

    // 获取所有行数据
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

    return XLSX.utils.aoa_to_sheet(aoa).A1?.v as string || '';
}

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
            // CSV转义
            if (text.includes(',') || text.includes('"') || text.includes('\n')) {
                return '"' + text.replace(/"/g, '""') + '"';
            }
            return text;
        });
        lines.push(values.join(','));
    });

    return lines.join('\n');
}
