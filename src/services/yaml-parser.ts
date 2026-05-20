import * as YAML from 'yaml';
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

export interface YamlData {
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

export async function loadYamlFromFile(filePath: string): Promise<YamlData> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return loadYamlFromContent(content);
    } catch (error) {
        console.error('Failed to load YAML:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}

export function loadYamlFromContent(content: string): YamlData {
    try {
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }

        const lines = content.split('\n');
        let cleanContent = '';
        let foundContent = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!foundContent && trimmed.startsWith('#')) {
                continue;
            }
            foundContent = true;
            cleanContent += line + '\n';
        }

        if (!cleanContent.trim()) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }

        let parsed: any = null;

        try {
            const docs = YAML.parseAllDocuments(cleanContent);
            for (const doc of docs) {
                const value = doc.toJSON();
                if (value !== null && value !== undefined) {
                    if (Array.isArray(value) && value.length > 0) {
                        parsed = value;
                        break;
                    } else if (typeof value === 'object' && Object.keys(value).length > 0) {
                        const keys = Object.keys(value);
                        for (const key of keys) {
                            if (Array.isArray(value[key]) && value[key].length > 0) {
                                parsed = value[key];
                                break;
                            }
                        }
                        if (!parsed) {
                            parsed = value;
                        }
                        break;
                    }
                }
            }
        } catch (e) {
            parsed = YAML.parse(cleanContent);
        }

        if (!parsed) {
            const topLevelMatch = cleanContent.match(/^(\w+):\s*\n/m);
            if (topLevelMatch) {
                parsed = YAML.parse(cleanContent);
            }
        }

        if (!parsed) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }

        let rows: any[][] = [];

        if (Array.isArray(parsed)) {
            rows = convertArrayToRows(parsed);
        } else if (typeof parsed === 'object' && parsed !== null) {
            const keys = Object.keys(parsed);
            let foundArray = false;
            for (const key of keys) {
                if (Array.isArray(parsed[key]) && parsed[key].length > 0) {
                    rows = convertArrayToRows(parsed[key]);
                    foundArray = true;
                    break;
                }
            }
            if (!foundArray) {
                rows = convertObjectToRows(parsed);
            }
        } else {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }

        if (rows.length === 0) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }

        const headers = rows[0] || [];
        const sheetRows: { [key: number]: SheetRow } = {};

        sheetRows[0] = { cells: {} };
        headers.forEach((h, colIdx) => {
            sheetRows[0].cells[colIdx] = { text: String(h ?? '') };
        });

        rows.slice(1).forEach((row, rowIdx) => {
            const cells: { [key: number]: SheetCell } = {};
            row.forEach((cell, colIdx) => {
                cells[colIdx] = { text: formatCellValue(cell) };
            });
            sheetRows[rowIdx + 1] = { cells };
        });

        const cols: { [key: string]: { width: number } } = {};
        for (let i = 0; i < headers.length; i++) {
            cols[i] = { width: calculateColWidth(rows.slice(1), i) };
        }

        return {
            sheets: [{ name: 'Sheet1', rows: sheetRows, cols }],
            maxCols: headers.length,
            maxLength: rows.length - 1
        };
    } catch (error) {
        console.error('Failed to parse YAML content:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}

function formatCellValue(value: any): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

function convertArrayToRows(data: any[]): any[][] {
    if (!Array.isArray(data) || data.length === 0) {
        return [];
    }

    const allKeys = new Set<string>();
    data.forEach(item => {
        if (item && typeof item === 'object') {
            Object.keys(item).forEach(key => allKeys.add(key));
        }
    });

    const headers = Array.from(allKeys);
    const rows: any[][] = [headers];

    data.forEach(item => {
        if (item && typeof item === 'object') {
            const row = headers.map(key => {
                const value = item[key];
                return formatCellValue(value);
            });
            rows.push(row);
        }
    });

    return rows;
}

function convertObjectToRows(data: any): any[][] {
    if (!data || typeof data !== 'object') {
        return [];
    }

    const headers = Object.keys(data);
    if (headers.length === 0) {
        return [];
    }

    const values = headers.map(key => formatCellValue(data[key]));
    return [headers, values];
}

export function sheetToYaml(sheets: SheetData[]): string {
    const firstSheet = sheets[0];
    if (!firstSheet) return '';

    const rowKeys = Object.keys(firstSheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
    if (rowKeys.length === 0) return '';

    const headers = rowKeys.length > 0 ? firstSheet.rows[rowKeys[0]]?.cells : {};
    const headerKeys = Object.keys(headers).map(k => parseInt(k)).sort((a, b) => a - b);
    const headerNames = headerKeys.map(ci => headers[ci]?.text || '');

    const records: any[] = [];
    rowKeys.slice(1).forEach(ri => {
        const row = firstSheet.rows[ri];
        if (!row) return;
        const record: any = {};
        headerKeys.forEach((ci, idx) => {
            record[headerNames[idx]] = row.cells[ci]?.text || '';
        });
        records.push(record);
    });

    return YAML.stringify(records.length === 1 ? records[0] : records);
}
