import * as vscode from 'vscode';
import * as fs from 'fs';
import { loadYamlFromFile } from '../services/yaml-parser';
import { BaseEditorProvider, TableData, HttpFetchPushStrategy, isInQualifiedDir } from './BaseEditorProvider';

// 检查YAML文件是否满足目录要求
export function isQualifiedYamlFile(uri: vscode.Uri): boolean {
    return isInQualifiedDir(uri, /\.ya?ml$/i);
}

// 解析YAML文件数据
function parseYamlData(filePath: string): TableData {
    try {
        const data = loadYamlFromFile(filePath);
        const sheet = data.sheets[0];
        if (!sheet) return { headers: [], rows: [] };

        const headers: string[] = [];
        const rows: string[][] = [];

        const row0 = sheet.rows[0];
        if (row0) {
            const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
        }

        const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
        rowKeys.forEach(ri => {
            if (ri === 0 && headers.length > 0) return;
            const row = sheet.rows[ri];
            if (!row) return;
            const rowData: string[] = [];
            const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
            cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
            while (rowData.length < headers.length) rowData.push('');
            rows.push(rowData);
        });

        return { headers, rows };
    } catch (e) {
        console.error('YAML parse error:', e);
        return { headers: [], rows: [] };
    }
}

// YAML 自定义编辑器 Provider
export class YamlEditorProvider extends BaseEditorProvider {
    protected pushStrategy = new HttpFetchPushStrategy();

    protected getTypeName(): string { return 'YAML'; }
    protected getDataType(): 'yaml' | 'json' | 'csv' { return 'yaml'; }
    protected getOpenCommand(): string { return 'yamlEditor.openWithFile'; }
    protected getErrorMessage(): string {
        return '该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.yaml 或 *.yml';
    }

    protected isQualifiedFile(uri: vscode.Uri): boolean {
        return isQualifiedYamlFile(uri);
    }

    protected parseData(filePath: string): TableData {
        return parseYamlData(filePath);
    }

    protected async saveFile(filePath: string, data: TableData): Promise<void> {
        if (!data) throw new Error('没有数据可保存');
        const { headers, rows } = data;

        const yaml = require('yaml');
        const records: any[] = rows.map(row => {
            const record: any = {};
            headers.forEach((h, i) => {
                record[h] = row[i] || '';
            });
            return record;
        });

        const yamlContent = yaml.stringify(records.length === 1 ? records[0] : records);
        await fs.promises.writeFile(filePath, yamlContent, 'utf-8');
    }
}
