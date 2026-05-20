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
exports.YamlEditorProvider = void 0;
exports.isQualifiedYamlFile = isQualifiedYamlFile;
const fs = __importStar(require("fs"));
const yaml_parser_1 = require("../services/yaml-parser");
const BaseEditorProvider_1 = require("./BaseEditorProvider");
// 检查YAML文件是否满足目录要求
function isQualifiedYamlFile(uri) {
    return (0, BaseEditorProvider_1.isInQualifiedDir)(uri, /\.ya?ml$/i);
}
// 解析YAML文件数据
function parseYamlData(filePath) {
    try {
        const data = (0, yaml_parser_1.loadYamlFromFile)(filePath);
        const sheet = data.sheets[0];
        if (!sheet)
            return { headers: [], rows: [] };
        const headers = [];
        const rows = [];
        const row0 = sheet.rows[0];
        if (row0) {
            const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
        }
        const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
        rowKeys.forEach(ri => {
            if (ri === 0 && headers.length > 0)
                return;
            const row = sheet.rows[ri];
            if (!row)
                return;
            const rowData = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
            while (rowData.length < headers.length)
                rowData.push('');
            rows.push(rowData);
        });
        return { headers, rows };
    }
    catch (e) {
        console.error('YAML parse error:', e);
        return { headers: [], rows: [] };
    }
}
// YAML 自定义编辑器 Provider
class YamlEditorProvider extends BaseEditorProvider_1.BaseEditorProvider {
    constructor() {
        super(...arguments);
        this.pushStrategy = new BaseEditorProvider_1.HttpFetchPushStrategy();
    }
    getTypeName() { return 'YAML'; }
    getDataType() { return 'yaml'; }
    getOpenCommand() { return 'yamlEditor.openWithFile'; }
    getErrorMessage() {
        return '该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.yaml 或 *.yml';
    }
    isQualifiedFile(uri) {
        return isQualifiedYamlFile(uri);
    }
    parseData(filePath) {
        return parseYamlData(filePath);
    }
    async saveFile(filePath, data) {
        if (!data)
            throw new Error('没有数据可保存');
        const { headers, rows } = data;
        const yaml = require('yaml');
        const records = rows.map(row => {
            const record = {};
            headers.forEach((h, i) => {
                record[h] = row[i] || '';
            });
            return record;
        });
        const yamlContent = yaml.stringify(records.length === 1 ? records[0] : records);
        await fs.promises.writeFile(filePath, yamlContent, 'utf-8');
    }
}
exports.YamlEditorProvider = YamlEditorProvider;
//# sourceMappingURL=YamlDocumentProvider.js.map