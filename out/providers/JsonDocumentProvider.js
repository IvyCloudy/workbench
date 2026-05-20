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
exports.JsonEditorProvider = void 0;
exports.isQualifiedJsonFile = isQualifiedJsonFile;
const fs = __importStar(require("fs"));
const BaseEditorProvider_1 = require("./BaseEditorProvider");
// 检查JSON文件是否满足目录要求
function isQualifiedJsonFile(uri) {
    return (0, BaseEditorProvider_1.isInQualifiedDir)(uri, /\.json$/i);
}
// 解析JSON文件数据（支持复杂嵌套结构）
function parseJsonData(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        if (!Array.isArray(data) || data.length === 0) {
            return { headers: [], rows: [] };
        }
        // 收集所有可能的路径（支持嵌套结构）
        const allPaths = new Set();
        function collectPaths(obj, prefix = '') {
            if (obj === null || obj === undefined)
                return;
            if (Array.isArray(obj)) {
                allPaths.add(prefix || 'value');
            }
            else if (typeof obj === 'object') {
                for (const key of Object.keys(obj)) {
                    const newPrefix = prefix ? `${prefix}.${key}` : key;
                    collectPaths(obj[key], newPrefix);
                }
            }
            else {
                allPaths.add(prefix || 'value');
            }
        }
        for (const item of data) {
            if (typeof item === 'object' && item !== null) {
                collectPaths(item);
            }
        }
        const headers = Array.from(allPaths).sort((a, b) => {
            const aDepth = a.split('.').length;
            const bDepth = b.split('.').length;
            if (aDepth !== bDepth)
                return aDepth - bDepth;
            return a.localeCompare(b);
        });
        function getNestedValue(obj, path) {
            if (!path || path === 'value') {
                if (Array.isArray(obj))
                    return JSON.stringify(obj);
                if (typeof obj === 'object' && obj !== null)
                    return JSON.stringify(obj);
                return String(obj ?? '');
            }
            const keys = path.split('.');
            let val = obj;
            for (const k of keys) {
                if (val === null || val === undefined)
                    return '';
                val = val[k];
            }
            if (val === undefined || val === null)
                return '';
            if (Array.isArray(val))
                return JSON.stringify(val);
            if (typeof val === 'object')
                return JSON.stringify(val);
            return String(val);
        }
        const rows = data.map(item => {
            if (typeof item !== 'object' || item === null) {
                return headers.map(() => '');
            }
            return headers.map(h => getNestedValue(item, h));
        });
        return { headers, rows };
    }
    catch (e) {
        console.error('JSON parse error:', e);
        return { headers: [], rows: [] };
    }
}
// 将扁平数据转换回嵌套结构
function unflattenRow(headers, row) {
    const result = {};
    headers.forEach((path, idx) => {
        const value = row[idx];
        if (path === 'value') {
            try {
                result._value = JSON.parse(value);
            }
            catch {
                result._value = value;
            }
            return;
        }
        const keys = path.split('.');
        let obj = result;
        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (!(k in obj) || typeof obj[k] !== 'object') {
                obj[k] = {};
            }
            obj = obj[k];
        }
        const lastKey = keys[keys.length - 1];
        try {
            obj[lastKey] = JSON.parse(value);
        }
        catch {
            obj[lastKey] = value;
        }
    });
    if (Object.keys(result).length === 1 && '_value' in result) {
        return result._value;
    }
    delete result._value;
    return result;
}
// JSON 自定义编辑器 Provider
class JsonEditorProvider extends BaseEditorProvider_1.BaseEditorProvider {
    constructor() {
        super(...arguments);
        this.pushStrategy = new BaseEditorProvider_1.HttpFetchPushStrategy();
    }
    getTypeName() { return 'JSON'; }
    getDataType() { return 'json'; }
    getOpenCommand() { return 'jsonEditor.openWithFile'; }
    getErrorMessage() {
        return '该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.json';
    }
    isQualifiedFile(uri) {
        return isQualifiedJsonFile(uri);
    }
    parseData(filePath) {
        return parseJsonData(filePath);
    }
    async saveFile(filePath, data) {
        if (!data)
            throw new Error('没有数据可保存');
        const { headers, rows } = data;
        const records = rows.map(row => unflattenRow(headers, row));
        const jsonContent = JSON.stringify(records.length === 1 ? records[0] : records, null, 2);
        await fs.promises.writeFile(filePath, jsonContent, 'utf-8');
    }
}
exports.JsonEditorProvider = JsonEditorProvider;
//# sourceMappingURL=JsonDocumentProvider.js.map