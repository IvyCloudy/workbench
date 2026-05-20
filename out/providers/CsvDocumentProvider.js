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
exports.CsvDocumentContentProvider = exports.CsvEditorProvider = void 0;
exports.isQualifiedCsvFile = isQualifiedCsvFile;
const fs = __importStar(require("fs"));
const BaseEditorProvider_1 = require("./BaseEditorProvider");
// ============================================
// CSV 解析工具
// ============================================
function detectDelimiter(line) {
    const delimiters = [',', ';', '\t', '|'];
    const counts = delimiters.map(d => ({ delim: d, count: (line.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length }));
    const best = counts.filter(c => c.count >= 2).sort((a, b) => b.count - a.count)[0];
    return best ? best.delim : ',';
}
function parseCsvLine(line, delimiter = ',') {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        }
        else if (ch === delimiter && !inQuotes) {
            result.push(current.trim());
            current = '';
        }
        else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}
function parseCsvContent(content) {
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length === 0)
        return null;
    const delimiter = detectDelimiter(lines[0]);
    const headers = parseCsvLine(lines[0], delimiter);
    const rows = lines.slice(1).map(line => parseCsvLine(line, delimiter));
    return { headers, rows };
}
function escapeCsvField(value, delimiter) {
    value = String(value || '');
    if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}
// 检查CSV文件是否满足目录要求
function isQualifiedCsvFile(uri) {
    return (0, BaseEditorProvider_1.isInQualifiedDir)(uri, /\.csv$/i);
}
// 解析CSV文件
function parseCsvData(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const result = parseCsvContent(content);
        return result || { headers: [], rows: [] };
    }
    catch (e) {
        console.error('CSV parse error:', e);
        return { headers: [], rows: [] };
    }
}
// ============================================
// CSV 自定义编辑器 Provider（编辑模式）
// ============================================
class CsvEditorProvider extends BaseEditorProvider_1.BaseEditorProvider {
    constructor() {
        super(...arguments);
        this.pushStrategy = new BaseEditorProvider_1.HttpFetchPushStrategy();
    }
    getTypeName() { return 'CSV'; }
    getDataType() { return 'csv'; }
    getOpenCommand() { return 'csvEditor.openWithFile'; }
    getErrorMessage() {
        return '该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.csv';
    }
    isQualifiedFile(uri) {
        return isQualifiedCsvFile(uri);
    }
    parseData(filePath) {
        return parseCsvData(filePath);
    }
    async saveFile(filePath, data) {
        const { headers, rows } = data;
        const delimiter = detectDelimiter(headers.join(','));
        const lines = [];
        lines.push(headers.map(v => escapeCsvField(v, delimiter)).join(delimiter));
        rows.forEach(row => {
            lines.push(row.map(v => escapeCsvField(v, delimiter)).join(delimiter));
        });
        await fs.promises.writeFile(filePath, lines.join('\n'), 'utf-8');
    }
}
exports.CsvEditorProvider = CsvEditorProvider;
// ============================================
// CSV 预览模式 Provider（继承基类）
// ============================================
class CsvDocumentContentProvider extends BaseEditorProvider_1.BaseDocumentContentProvider {
    getFilePath(uri) {
        return uri.fsPath.replace(/^csv-preview:/, '');
    }
    getPreviewScheme() {
        return 'csv-preview';
    }
    parseData(filePath) {
        return parseCsvData(filePath);
    }
}
exports.CsvDocumentContentProvider = CsvDocumentContentProvider;
//# sourceMappingURL=CsvDocumentProvider.js.map