import * as vscode from 'vscode';
import * as fs from 'fs';
import { BaseEditorProvider, PushViaHttpClient, isInQualifiedDir } from './BaseEditorProvider';
import type { TableData } from '../types';

// 检查JSON文件是否满足目录要求
export function isQualifiedJsonFile(uri: vscode.Uri): boolean {
    return isInQualifiedDir(uri, /\.json$/i);
}

// 异步解析JSON文件数据
async function parseJsonData(filePath: string): Promise<TableData> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        if (!Array.isArray(data) || data.length === 0) {
            return { headers: [], rows: [] };
        }

        const allPaths = new Set<string>();

        function collectPaths(obj: any, prefix: string = '') {
            if (obj === null || obj === undefined) return;
            if (Array.isArray(obj)) {
                allPaths.add(prefix || 'value');
            } else if (typeof obj === 'object') {
                for (const key of Object.keys(obj)) {
                    const newPrefix = prefix ? `${prefix}.${key}` : key;
                    collectPaths(obj[key], newPrefix);
                }
            } else {
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
            if (aDepth !== bDepth) return aDepth - bDepth;
            return a.localeCompare(b);
        });

        function getNestedValue(obj: any, path: string): string {
            if (!path || path === 'value') {
                if (Array.isArray(obj)) return JSON.stringify(obj);
                if (typeof obj === 'object' && obj !== null) return JSON.stringify(obj);
                return String(obj ?? '');
            }
            const keys = path.split('.');
            let val: any = obj;
            for (const k of keys) {
                if (val === null || val === undefined) return '';
                val = val[k];
            }
            if (val === undefined || val === null) return '';
            if (Array.isArray(val)) return JSON.stringify(val);
            if (typeof val === 'object') return JSON.stringify(val);
            return String(val);
        }

        const rows: string[][] = data.map(item => {
            if (typeof item !== 'object' || item === null) {
                return headers.map(() => '');
            }
            return headers.map(h => getNestedValue(item, h));
        });

        return { headers, rows };
    } catch (e: any) {
        const msg = `JSON 解析失败: ${e.message}`;
        console.error(msg, e);
        throw new Error(msg);
    }
}

function unflattenRow(headers: string[], row: string[]): any {
    const result: any = {};

    headers.forEach((path, idx) => {
        const value = row[idx];
        if (path === 'value') {
            try {
                result._value = JSON.parse(value);
            } catch {
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
        } catch {
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
export class JsonEditorProvider extends BaseEditorProvider {
    protected pushStrategy = new PushViaHttpClient();

    protected getTypeName(): string { return 'JSON'; }
    protected getDataType(): 'yaml' | 'json' | 'csv' { return 'json'; }
    protected getOpenCommand(): string { return 'jsonEditor.openWithFile'; }
    protected getErrorMessage(): string {
        return '该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.json';
    }

    protected isQualifiedFile(uri: vscode.Uri): boolean {
        return isQualifiedJsonFile(uri);
    }

    protected async parseData(filePath: string): Promise<TableData> {
        return await parseJsonData(filePath);
    }

    protected async saveFile(filePath: string, data: TableData): Promise<void> {
        if (!data) throw new Error('没有数据可保存');
        const { headers, rows } = data;

        const records: any[] = rows.map(row => unflattenRow(headers, row));

        const jsonContent = JSON.stringify(records.length === 1 ? records[0] : records, null, 2);
        await fs.promises.writeFile(filePath, jsonContent, 'utf-8');
    }
}
