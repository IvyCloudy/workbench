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
exports.loadYamlFromFile = loadYamlFromFile;
exports.loadYamlFromContent = loadYamlFromContent;
exports.sheetToYaml = sheetToYaml;
const YAML = __importStar(require("yaml"));
const fs = __importStar(require("fs"));
// ==================== 常量定义 ====================
const MIN_COL_WIDTH = 70;
const MAX_COL_WIDTH = 300;
const CHAR_WIDTH = 8;
const MAX_ROWS_TO_CHECK = 10;
// ==================== 工具函数 ====================
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
// ==================== 核心函数 ====================
/**
 * 从文件加载 YAML 数据并转换为表格格式
 * @param filePath YAML 文件路径
 * @returns 解析后的 YamlData 对象
 */
function loadYamlFromFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return loadYamlFromContent(content);
    }
    catch (error) {
        console.error('Failed to load YAML:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}
/**
 * 从字符串内容加载 YAML 数据并转换为表格格式
 * @param content YAML 内容字符串
 * @returns 解析后的 YamlData 对象
 */
function loadYamlFromContent(content) {
    try {
        // 移除 BOM 字符
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        // 清理内容：移除开头的注释块，找到第一个实际的YAML内容
        const lines = content.split('\n');
        let cleanContent = '';
        let foundContent = false;
        for (const line of lines) {
            const trimmed = line.trim();
            // 跳过纯注释行，直到找到实际内容
            if (!foundContent && trimmed.startsWith('#')) {
                continue;
            }
            foundContent = true;
            cleanContent += line + '\n';
        }
        if (!cleanContent.trim()) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }
        // 尝试使用 parseAllDocuments 处理多文档YAML
        let parsed = null;
        // 先尝试解析整个文件（可能支持无 --- 分隔的多文档）
        try {
            const docs = YAML.parseAllDocuments(cleanContent);
            // 找到第一个有效的文档（数组或包含数据的对象）
            for (const doc of docs) {
                const value = doc.toJSON();
                // 检查是否是有效的文档（数组或有键的对象）
                if (value !== null && value !== undefined) {
                    if (Array.isArray(value) && value.length > 0) {
                        parsed = value;
                        break;
                    }
                    else if (typeof value === 'object' && Object.keys(value).length > 0) {
                        // 如果是对象，找第一个数组值
                        const keys = Object.keys(value);
                        for (const key of keys) {
                            if (Array.isArray(value[key]) && value[key].length > 0) {
                                parsed = value[key];
                                break;
                            }
                        }
                        // 如果没找到数组，使用整个对象
                        if (!parsed) {
                            parsed = value;
                        }
                        break;
                    }
                }
            }
        }
        catch (e) {
            // 如果 parseAllDocuments 失败，尝试直接解析
            parsed = YAML.parse(cleanContent);
        }
        // 如果还是没有解析结果，尝试处理多行顶呱呱key
        if (!parsed) {
            // 使用正则提取顶呱呱键值对
            const topLevelMatch = cleanContent.match(/^(\w+):\s*\n/m);
            if (topLevelMatch) {
                parsed = YAML.parse(cleanContent);
            }
        }
        if (!parsed) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }
        // 判断解析结果的类型
        let rows = [];
        if (Array.isArray(parsed)) {
            // YAML 是数组格式 [{...}, {...}, ...]
            rows = convertArrayToRows(parsed);
        }
        else if (typeof parsed === 'object' && parsed !== null) {
            // YAML 是对象格式 {key: value} 或包含数组的对象
            const keys = Object.keys(parsed);
            // 查找第一个数组值
            let foundArray = false;
            for (const key of keys) {
                if (Array.isArray(parsed[key]) && parsed[key].length > 0) {
                    rows = convertArrayToRows(parsed[key]);
                    foundArray = true;
                    break;
                }
            }
            if (!foundArray) {
                // 普通对象: { key: value }
                rows = convertObjectToRows(parsed);
            }
        }
        else {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }
        if (rows.length === 0) {
            return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
        }
        // 提取表头
        const headers = rows[0] || [];
        const sheetRows = {};
        // 将表头作为 rows[0]
        sheetRows[0] = { cells: {} };
        headers.forEach((h, colIdx) => {
            sheetRows[0].cells[colIdx] = { text: String(h ?? '') };
        });
        // 转换数据行
        rows.slice(1).forEach((row, rowIdx) => {
            const cells = {};
            row.forEach((cell, colIdx) => {
                cells[colIdx] = { text: formatCellValue(cell) };
            });
            sheetRows[rowIdx + 1] = { cells };
        });
        // 计算列宽
        const cols = {};
        for (let i = 0; i < headers.length; i++) {
            cols[i] = { width: calculateColWidth(rows.slice(1), i) };
        }
        return {
            sheets: [{ name: 'Sheet1', rows: sheetRows, cols }],
            maxCols: headers.length,
            maxLength: rows.length - 1
        };
    }
    catch (error) {
        console.error('Failed to parse YAML content:', error);
        return { sheets: [{ name: 'Sheet1', rows: {} }], maxCols: 0, maxLength: 0 };
    }
}
/**
 * 将单元格值格式化为字符串
 */
function formatCellValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}
/**
 * 将数组对象转换为表格行
 * 输入: [{a: 1, b: 2}, {a: 3, b: 4}]
 * 输出: [['a', 'b'], ['1', '2'], ['3', '4']]
 */
function convertArrayToRows(data) {
    if (!Array.isArray(data) || data.length === 0) {
        return [];
    }
    // 收集所有唯一的键
    const allKeys = new Set();
    data.forEach(item => {
        if (item && typeof item === 'object') {
            Object.keys(item).forEach(key => allKeys.add(key));
        }
    });
    const headers = Array.from(allKeys);
    const rows = [headers];
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
/**
 * 将普通对象转换为表格行
 * 输入: {name: 'test', value: 123}
 * 输出: [['name', 'value'], ['test', '123']]
 */
function convertObjectToRows(data) {
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
/**
 * 将 SheetData 转换为标准 YAML 格式
 */
function sheetToYaml(sheets) {
    const firstSheet = sheets[0];
    if (!firstSheet)
        return '';
    const rowKeys = Object.keys(firstSheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
    if (rowKeys.length === 0)
        return '';
    const headers = rowKeys.length > 0 ? firstSheet.rows[rowKeys[0]]?.cells : {};
    const headerKeys = Object.keys(headers).map(k => parseInt(k)).sort((a, b) => a - b);
    const headerNames = headerKeys.map(ci => headers[ci]?.text || '');
    const records = [];
    rowKeys.slice(1).forEach(ri => {
        const row = firstSheet.rows[ri];
        if (!row)
            return;
        const record = {};
        headerKeys.forEach((ci, idx) => {
            record[headerNames[idx]] = row.cells[ci]?.text || '';
        });
        records.push(record);
    });
    return YAML.stringify(records.length === 1 ? records[0] : records);
}
//# sourceMappingURL=yaml-parser.js.map