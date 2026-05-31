/**
 * ============================================================================
 *  services/storage.ts
 *  扩展全局存储读写
 * ----------------------------------------------------------------------------
 *  职责：
 *    - 在 context.globalStoragePath 下管理两份 JSON：
 *        app-config.json    : apiUrl / token / SM2 公钥等运行时配置
 *        query-params.json  : 上次查询所用的 testTaskNo / subTestTaskName / testPhaseName
 *  设计要点：
 *    - 读取时使用 spread 合并 DEFAULTS，新增字段时无需迁移
 *    - 写入失败不抛出，仅 console.error；不阻塞业务
 * ============================================================================
 */
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
    sm2PublicKey: '',
    telemetryUrl: '',
    telemetryToken: ''
};

const DEFAULT_QUERY_PARAMS: QueryParams = {
    testTaskNo: '',
    subTestTaskName: '',
    testPhaseName: ''
};

// ============================================
// 路径（内部）
// ============================================

function getConfigPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStoragePath, CONFIG_FILE);
}

function getQueryParamsPath(context: vscode.ExtensionContext): string {
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
 * 读取应用配置
 */
export async function readConfig(context: vscode.ExtensionContext): Promise<AppConfig> {
    return await readJsonFile(getConfigPath(context), DEFAULT_CONFIG);
}

/**
 * 全量写入应用配置（覆盖式）。
 * 失败仅记录日志，不向上抛出，避免阻塞业务主流程。
 */
export async function writeConfig(
    context: vscode.ExtensionContext,
    config: AppConfig
): Promise<void> {
    try {
        await writeJsonFile(getConfigPath(context), config);
    } catch (error) {
        console.error('[storage] 写入配置失败:', error);
    }
}

/**
 * 增量更新应用配置：仅覆盖传入的字段，其他字段保持不变。
 * 适用于登录成功后由后端下发 telemetryToken / telemetryUrl 等场景。
 */
export async function patchConfig(
    context: vscode.ExtensionContext,
    patch: Partial<AppConfig>
): Promise<AppConfig> {
    const current = await readConfig(context);
    const next: AppConfig = { ...current, ...patch };
    await writeConfig(context, next);
    return next;
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