"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCsvFromFile = loadCsvFromFile;
exports.loadCsvFromContent = loadCsvFromContent;
exports.exportToCsv = exportToCsv;
exports.sheetToCsv = sheetToCsv;
const XLSX = __importStar(require("xlsx"));
const fs = __importStar(require("fs"));
const MIN_COL_WIDTH = 70;
const MAX_COL_WIDTH = 300;
const CHAR_WIDTH = 8;
const MAX_ROWS_TO_CHECK = 10;
function calculateColWidth(rows, colIndex) {
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
function loadCsvFromFile(filePath) {
    try {
        // 读取文件 buffer，直接使用 UTF-8 编码
        const buffer = fs.readFileSync(filePath);
        const content = buffer.toString('utf-8');
        console.log('[csv-parser] 文件内容样例:', content.substring(0, 200));
        // 使用xlsx解析CSV字符串内容
        const workbook = XLSX.read(content, { type: 'string' });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { raw: false, header: 1 });
        console.log('[csv-parser] xlsx解析后第一行:', JSON.stringify(jsonData[0]).substring(0, 200));
        if (jsonData.length === 0) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }
        const headers = jsonData[0] || [];
        const rows = {};
        // 将表头作为 rows[0]，数据从 rows[1] 开始
        // 这样与 parseCsvData 的预期一致
        rows[0] = { cells: {} };
        headers.forEach((h, colIdx) => {
            rows[0].cells[colIdx] = { text: String(h ?? '') };
        });
        jsonData.slice(1).forEach((row, rowIdx) => {
            const cells = {};
            row.forEach((cell, colIdx) => {
                cells[colIdx] = { text: String(cell ?? '') };
            });
            rows[rowIdx + 1] = { cells }; // 数据行从索引1开始
        });
        // 计算列宽
        const cols = {};
        for (let i = 0; i < headers.length; i++) {
            cols[i] = { width: calculateColWidth(jsonData.slice(1), i) };
        }
        const maxCols = headers.length;
        return {
            sheets: [{ name: 'Sheet1', rows, cols }],
            maxCols,
            maxLength: jsonData.length - 1
        };
    }
    catch (error) {
        console.error('Failed to load CSV:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}
function loadCsvFromContent(content) {
    try {
        const workbook = XLSX.read(content, { type: 'string', raw: true });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { raw: false, header: 1 });
        if (jsonData.length === 0) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }
        const rows = {};
        // 将表头作为 rows[0]
        rows[0] = { cells: {} };
        (jsonData[0] || []).forEach((h, colIdx) => {
            rows[0].cells[colIdx] = { text: String(h ?? '') };
        });
        jsonData.slice(1).forEach((row, rowIdx) => {
            const cells = {};
            row.forEach((cell, colIdx) => {
                cells[colIdx] = { text: String(cell ?? '') };
            });
            rows[rowIdx + 1] = { cells };
        });
        // 计算列宽
        const cols = {};
        for (let i = 0; i < (jsonData[0]?.length || 0); i++) {
            cols[i] = { width: calculateColWidth(jsonData.slice(1), i) };
        }
        return {
            sheets: [{ name: 'Sheet1', rows, cols }],
            maxCols: jsonData[0]?.length || 0,
            maxLength: jsonData.length - 1
        };
    }
    catch (error) {
        console.error('Failed to parse CSV content:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}
function exportToCsv(sheets) {
    const aoa = [];
    const firstSheet = sheets[0];
    if (!firstSheet)
        return '';
    // 获取所有行数据
    const rowKeys = Object.keys(firstSheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
    rowKeys.forEach(ri => {
        const row = firstSheet.rows[ri];
        if (!row)
            return;
        const rowData = [];
        const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
        cellKeys.forEach(ci => {
            rowData[ci] = row.cells[ci]?.text || '';
        });
        aoa.push(rowData);
    });
    return XLSX.utils.aoa_to_sheet(aoa).A1?.v || '';
}
function sheetToCsv(sheets) {
    const firstSheet = sheets[0];
    if (!firstSheet)
        return '';
    const rowKeys = Object.keys(firstSheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
    const lines = [];
    rowKeys.forEach(ri => {
        const row = firstSheet.rows[ri];
        if (!row)
            return;
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
//# sourceMappingURL=csv-parser.js.map