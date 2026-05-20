import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { AppConfig, QueryParams } from '../types';

// ============================================
// 配置文件
// ============================================

const CONFIG_FILE = 'app-config.json';
const QUERY_PARAMS_FILE = 'query-params.json';

// ============================================
// 默认配置
// ============================================

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

// ============================================
// 路径获取
// ============================================

export function getConfigPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, CONFIG_FILE);
}

export function getQueryParamsPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, QUERY_PARAMS_FILE);
}

// ============================================
// 配置文件操作
// ============================================

export function readConfig(context: vscode.ExtensionContext): AppConfig {
    const filePath = getConfigPath(context);
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
        }
    } catch (e) {
        console.error('[storage] readConfig error:', e);
    }
    return { ...DEFAULT_CONFIG };
}

export function writeConfig(context: vscode.ExtensionContext, partial: Partial<AppConfig>): AppConfig {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const current = readConfig(context);
    const updated = { ...current, ...partial };
    fs.writeFileSync(getConfigPath(context), JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
}

// ============================================
// 查询参数操作
// ============================================

export function readParams(context: vscode.ExtensionContext): QueryParams {
    const filePath = getQueryParamsPath(context);
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return { ...DEFAULT_QUERY_PARAMS, ...JSON.parse(content) };
        }
    } catch (e) {
        console.error('[storage] readParams error:', e);
    }
    return { ...DEFAULT_QUERY_PARAMS };
}

export function writeParams(context: vscode.ExtensionContext, params: QueryParams): void {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(getQueryParamsPath(context), JSON.stringify(params, null, 2), 'utf-8');
}

// ============================================
// 确保目录存在
// ============================================

export function ensureDir(context: vscode.ExtensionContext): void {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
