import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const STORE_FILE = 'query-params.json';

export interface QueryParams {
    testTaskNo: string;
    subTestTaskName: string;
    testPhaseName: string;
}

export function getStorePath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, STORE_FILE);
}

export function readParams(context: vscode.ExtensionContext): QueryParams {
    const filePath = getStorePath(context);
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return { testTaskNo: '', subTestTaskName: '', testPhaseName: '' };
    }
}

export function writeParams(context: vscode.ExtensionContext, params: QueryParams): void {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(getStorePath(context), JSON.stringify(params, null, 2), 'utf-8');
}
