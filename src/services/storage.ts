import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { AppConfig, QueryParams } from '../types';

const CONFIG_FILE = 'app-config.json';
const QUERY_PARAMS_FILE = 'query-params.json';

const DEFAULT_CONFIG: AppConfig = {
    apiUrl: 'http://127.0.0.1:8081',
    authToken: '',
    userId: '',
    userName: '',
    sm2PublicKey: ''
};

const DEFAULT_QUERY_PARAMS: QueryParams = {
    testTaskNo: '',
    subTestTaskName: '',
    testPhaseName: ''
};

export function getConfigPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, CONFIG_FILE);
}

export function getQueryParamsPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, QUERY_PARAMS_FILE);
}

async function readJsonFile<T>(filePath: string, defaults: T): Promise<T> {
    try {
        if (fs.existsSync(filePath)) {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return { ...defaults, ...JSON.parse(content) };
        }
    } catch (e) {
        console.error('[storage] readFile error:', filePath, e);
    }
    return { ...defaults };
}

export async function readConfig(context: vscode.ExtensionContext): Promise<AppConfig> {
    return await readJsonFile(getConfigPath(context), DEFAULT_CONFIG);
}

export async function writeConfig(context: vscode.ExtensionContext, partial: Partial<AppConfig>): Promise<AppConfig> {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
    }
    const current = await readConfig(context);
    const updated = { ...current, ...partial };
    await fs.promises.writeFile(getConfigPath(context), JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
}

export async function readParams(context: vscode.ExtensionContext): Promise<QueryParams> {
    return await readJsonFile(getQueryParamsPath(context), DEFAULT_QUERY_PARAMS);
}

export async function writeParams(context: vscode.ExtensionContext, params: QueryParams): Promise<void> {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(getQueryParamsPath(context), JSON.stringify(params, null, 2), 'utf-8');
}

export async function ensureDir(context: vscode.ExtensionContext): Promise<void> {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
    }
}
