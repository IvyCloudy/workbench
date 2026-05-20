import * as XLSX from 'xlsx';
import * as fs from 'fs';
import type { SheetCell, SheetRow, SheetData, ExcelData } from '../types';

export type { SheetCell, SheetRow, SheetData, ExcelData };

const MIN_COL_WIDTH = 70;
const MAX_COL_WIDTH = 300;
const CHAR_WIDTH = 8;
const MAX_ROWS_TO_CHECK = 10;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function calculateColWidth(dataRows: any[][], headerRow: any[], colIndex: number): number {
    let maxLength = String(headerRow[colIndex] ?? '').length;
    const rowsToCheck = Math.min(dataRows.length, MAX_ROWS_TO_CHECK);
    for (let i = 0; i < rowsToCheck; i++) {
        const length = String(dataRows[i]?.[colIndex] ?? '').length;
        if (length > maxLength) {
            maxLength = length;
        }
    }
    const width = maxLength * CHAR_WIDTH;
    return Math.min(Math.max(width, MIN_COL_WIDTH), MAX_COL_WIDTH);
}

function checkFileSize(filePath: string, size: number): void {
    if (size > MAX_FILE_SIZE) {
        console.warn(`[csv-parser] 大文件警告: ${filePath} (${(size / 1024 / 1024).toFixed(2)}MB)`);
    }
}

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
    const dataRows = jsonData.slice(1);
    const numCols = headerRow.length;
    const numDataRows = dataRows.length;

    const rows: { [key: number]: SheetRow } = {};
    const cols: { [key: string]: { width: number } } = {};

    rows[0] = { cells: {} };
    for (let colIdx = 0; colIdx < numCols; colIdx++) {
        rows[0].cells[colIdx] = { text: String(headerRow[colIdx] ?? '') };
    }

    for (let rowIdx = 0; rowIdx < numDataRows; rowIdx++) {
        const row = dataRows[rowIdx];
        const cells: { [key: number]: SheetCell } = {};
        for (let colIdx = 0; colIdx < numCols; colIdx++) {
            cells[colIdx] = { text: String(row?.[colIdx] ?? '') };
        }
        rows[rowIdx + 1] = { cells };
    }

    for (let i = 0; i < numCols; i++) {
        cols[i] = { width: calculateColWidth(dataRows, headerRow, i) };
    }

    return { rows, cols, maxCols: numCols, maxLength: numDataRows };
}

export async function loadCsvFromFile(filePath: string): Promise<ExcelData> {
    try {
        const stats = await fs.promises.stat(filePath);
        checkFileSize(filePath, stats.size);

        const buffer = await fs.promises.readFile(filePath);
        let content = buffer.toString('utf-8');

        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }

        const workbook = XLSX.read(content, { type: 'string' });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { raw: false, header: 1 }) as any[][];
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

export function loadCsvFromContent(content: string): ExcelData {
    try {
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }

        const workbook = XLSX.read(content, { type: 'string', raw: true });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { raw: false, header: 1 }) as any[][];
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

export function exportToCsv(sheets: SheetData[]): string {
    if (!sheets || sheets.length === 0) return '';

    const firstSheet = sheets[0];
    if (!firstSheet || !firstSheet.rows) return '';

    const rowKeys = Object.keys(firstSheet.rows)
        .map(k => parseInt(k))
        .sort((a, b) => a - b);

    if (rowKeys.length === 0) return '';

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

    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    return XLSX.utils.sheet_to_csv(worksheet);
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
            if (text.includes(',') || text.includes('"') || text.includes('\n')) {
                return '"' + text.replace(/"/g, '""') + '"';
            }
            return text;
        });
        lines.push(values.join(','));
    });

    return lines.join('\n');
}
