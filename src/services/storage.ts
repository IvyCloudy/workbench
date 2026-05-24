import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { AppConfig, QueryParams } from '../types';

// ============================================
// 默认值与文件名
// ============================================

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

// ============================================
// 路径
// ============================================

export function getConfigPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, CONFIG_FILE);
}

export function getQueryParamsPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, QUERY_PARAMS_FILE);
}

// ============================================
// 内部 IO 工具
// ============================================

async function readJsonFile<T>(filePath: string, defaults: T): Promise<T> {
    try {
        if (fs.existsSync(filePath)) {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return { ...defaults, ...JSON.parse(content) };
        }
    } catch (error) {
        console.error('[storage] 读取文件失败:', filePath, error);
    }
    return { ...defaults };
}

async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================
// 公共 API
// ============================================

/**
 * 确保存储目录存在
 */
export async function ensureDir(context: vscode.ExtensionContext): Promise<void> {
    const dir = context.globalStoragePath;
    if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
    }
}

/**
 * 读取应用配置
 */
export async function readConfig(context: vscode.ExtensionContext): Promise<AppConfig> {
    return await readJsonFile(getConfigPath(context), DEFAULT_CONFIG);
}

/**
 * 写入应用配置（合并）
 */
export async function writeConfig(
    context: vscode.ExtensionContext,
    partial: Partial<AppConfig>
): Promise<AppConfig> {
    const current = await readConfig(context);
    const updated = { ...current, ...partial };
    await writeJsonFile(getConfigPath(context), updated);
    return updated;
}

/**
 * 读取查询参数
 */
export async function readParams(context: vscode.ExtensionContext): Promise<QueryParams> {
    return await readJsonFile(getQueryParamsPath(context), DEFAULT_QUERY_PARAMS);
}

/**
 * 写入查询参数
 */
export async function writeParams(
    context: vscode.ExtensionContext,
    params: QueryParams
): Promise<void> {
    await writeJsonFile(getQueryParamsPath(context), params);
}