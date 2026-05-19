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
exports.loadSheets = loadSheets;
exports.readCSV = readCSV;
exports.readXLSX = readXLSX;
const udsv_1 = require("udsv");
const XLSX = __importStar(require("xlsx/dist/xlsx.mini.min.js"));
const MIN_COL_WIDTH = 70;
const MAX_COL_WIDTH = 300;
const CHAR_WIDTH = 8;
const MAX_ROWS_TO_CHECK = 10;
const calculateColWidth = (rows, colIndex) => {
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
};
const convert = wb => {
    const sheets = [];
    let maxLength = 0;
    let maxCols = 26;
    wb.SheetNames.forEach(name => {
        const sheet = { name, rows: [] };
        const ws = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(ws, { raw: false, header: 1 });
        if (maxLength < rows.length)
            maxLength = rows.length;
        // 计算列宽
        const cols = {};
        for (let i = 0; i < rows[0]?.length || 0; i++) {
            const width = calculateColWidth(rows, i);
            cols[i] = { width };
        }
        sheet.cols = cols;
        sheet.rows = rows.reduce((map, row, i) => {
            const cells = row.reduce((colMap, column, j) => {
                colMap[j] = { text: column };
                return colMap;
            }, {});
            map[i] = { cells };
            const colLen = Object.keys(cells).length;
            if (colLen > maxCols) {
                maxCols = colLen;
            }
            return map;
        }, {});
        sheets.push(sheet);
    });
    return { sheets, maxLength, maxCols };
};
function loadSheets(buffer, ext) {
    const ab = new Uint8Array(buffer).buffer;
    const wb = ext.toLowerCase() == ".csv" ? XLSX.read(new TextDecoder("utf-8").decode(ab), { type: "string", raw: true }) : XLSX.read(ab, { type: "array" });
    return convert(wb);
}
function readCSV(buffer) {
    let maxCols = 26;
    const emptySheet = { maxCols, sheets: [{ name: 'Sheet1', rows: [] }] };
    let csvStr = new TextDecoder("utf-8").decode(buffer);
    if (!csvStr)
        return emptySheet;
    try {
        if (!csvStr.includes('\n'))
            csvStr += '\n';
        const schema = (0, udsv_1.inferSchema)(csvStr, { header: () => [] });
        const rows = (0, udsv_1.initParser)(schema).stringArrs(csvStr);
        // 计算列宽
        const cols = {};
        for (let i = 0; i < rows[0]?.length || 0; i++) {
            cols[i] = { width: calculateColWidth(rows, i) };
        }
        const processedRows = rows.map(row => {
            return row.reduce((colMap, column, j) => {
                colMap[String.fromCharCode(65 + j)] = column;
                if (j > maxCols)
                    maxCols = j;
                return colMap;
            }, {});
        });
        return {
            maxCols,
            sheets: [{
                    name: "Sheet1",
                    rows: processedRows,
                    cols
                }]
        };
    }
    catch (error) {
        console.error(error);
        return { maxCols, sheets: [{ name: 'Sheet1', rows: [{ A: error.message }] }] };
    }
}
function readXLSX(buffer) {
    const wb = XLSX.read(buffer, { type: "array" });
    const sheets = [];
    let maxCols = 26;
    wb.SheetNames.forEach(name => {
        const sheet = { name, rows: [] };
        const ws = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(ws, { raw: false, header: 1 });
        // 计算列宽
        const cols = {};
        for (let i = 0; i < rows[0]?.length || 0; i++) {
            cols[i] = { width: calculateColWidth(rows, i) };
        }
        sheet.cols = cols;
        sheet.rows = rows.map((row) => {
            return row.reduce((colMap, column, j) => {
                colMap[String.fromCharCode(65 + j)] = column;
                if (j > maxCols)
                    maxCols = j;
                return colMap;
            }, {});
        });
        sheets.push(sheet);
    });
    return { sheets, maxCols };
}
//# sourceMappingURL=excel_reader.js.map