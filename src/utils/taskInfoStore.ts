/**
 * ============================================================================
 *  utils/taskInfoStore.ts
 *  测试任务绑定信息持久化（globalStorageUri/task-bindings.json）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 维护 <globalStorageUri>/task-bindings.json 文件的读写。
 *    2. 文件不存在时自动创建空数组模板。
 *    3. 提供 findBindingByPath(filePath) / getAllBoundItems() 给上层查询。
 *  设计要点：
 *    - 使用 globalStorageUri，跨工作区共享同一份绑定（用户全局维护即可）。
 *    - 文件格式为 JSON 数组，每项为 CurrentTask，含 bind 标记 与 taskInfo 字段。
 *    - 绑定后 taskInfo 包含 rootPath + childPath 等完整项目信息。
 *    - 使用内存缓存 + mtime 校验，避免每次访问都做磁盘 IO。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// 类型定义（与 task-bindings.json 数组项对齐）
// ============================================

/** 测试阶段信息 */
export interface TestPhaseItem {
    testPhaseName: string;
    leader: string;
    status: string;
    testPhaseId: number;
    accTestFlag: string;
}

/** 项目信息（绑定后存在的字段） */
export interface Project {
    /** 显示名称，形如 "TT2026040017_测试DEMO" */
    name: string;
    /** 项目根绝对路径（未绑定时为空串） */
    rootPath: string;
    /** 相对子路径，拼接后为子任务文件夹路径（未绑定时为空串） */
    childPath: string;
    paths: string[];
    tags: string[];
    enabled: boolean;
    profile: string;
    /** 测试任务 ID（后端真实值） */
    testTaskId: string;
    /** 测试任务编号（后端真实值） */
    testTaskNo: string;
    /** 测试任务名称 */
    testTaskName: string;
    /** 子测试任务 ID（绑定后存在） */
    subTestTaskId?: string;
    /** 子测试任务名称（绑定后存在） */
    subTestTaskName?: string;
    /** 当前测试阶段 ID（绑定后存在） */
    testPhaseId?: number;
    /** 当前测试阶段名称（绑定后存在） */
    testPhaseName?: string;
    /** 回归标记 */
    gchFlag?: string;
    /** 可选阶段列表（绑定后存在） */
    testPhaseList?: TestPhaseItem[];
}

/** 单个测试任务的绑定记录（对应 task-bindings.json 的单条结构） */
export interface CurrentTask {
    /** 是否已绑定 */
    bind: boolean;
    /** 项目信息（绑定后存在） */
    taskInfo?: Project;
}

// ============================================
// 默认模板
// ============================================

function buildEmptyTemplate(): CurrentTask[] {
    return [];
}

// ============================================
// 内部状态
// ============================================

let cachedItems: CurrentTask[] | null = null;
let cachedMtimeMs = 0;
let resolvedFilePath: string | null = null;

// ============================================
// 公共接口
// ============================================

/**
 * 解析绑定文件的绝对路径（必要时创建 globalStorage 目录与文件）。
 * 在 activate 阶段调用一次，把路径打到日志便于用户找到。
 */
export async function ensureBindingsFile(context: vscode.ExtensionContext): Promise<string> {
    const dir = context.globalStorageUri.fsPath;
    const filePath = path.join(dir, 'task-bindings.json');
    resolvedFilePath = filePath;

    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
        } catch {
            const tpl = buildEmptyTemplate();
            await fs.promises.writeFile(filePath, JSON.stringify(tpl, null, 2), 'utf-8');
            console.log('[TaskBindings] 已创建空数组文件: ' + filePath);
        }
    } catch (err: any) {
        console.error('[TaskBindings] 初始化绑定文件失败:', err?.message || err);
    }

    console.log('[TaskBindings] 配置文件位置: ' + filePath);
    return filePath;
}

/**
 * 获取绑定文件路径（已 ensure 过的情况下直接复用缓存路径）。
 */
export function getBindingsFilePath(context?: vscode.ExtensionContext): string {
    if (resolvedFilePath) return resolvedFilePath;
    if (context) {
        resolvedFilePath = path.join(context.globalStorageUri.fsPath, 'task-bindings.json');
        return resolvedFilePath;
    }
    return '';
}

/**
 * 读取并缓存绑定文件内容。出错时返回空数组，不抛异常。
 * 使用 mtime 比对，文件未变更时直接返回缓存。
 * 自动检测旧版 TaskBindingItem 格式并迁移为 CurrentTask。
 */
function loadBindings(filePath: string): CurrentTask[] {
    if (!filePath) return [];
    try {
        const stat = fs.statSync(filePath);
        if (cachedItems && stat.mtimeMs === cachedMtimeMs) {
            return cachedItems;
        }
        const text = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            console.warn('[TaskBindings] 文件不是数组，返回空');
            cachedItems = [];
        } else if (parsed.length > 0 && 'rootPath' in parsed[0]) {
            // 旧版 TaskBindingItem（平铺字段）→ 内存中转为 CurrentTask，磁盘文件不变
            cachedItems = parsed.map((item: any) => ({
                bind: !!(item.rootPath && item.childPath),
                taskInfo: {
                    name: item.name || '',
                    rootPath: item.rootPath || '',
                    childPath: item.childPath || '',
                    paths: item.paths || [],
                    tags: item.tags || [],
                    enabled: item.enabled ?? true,
                    profile: item.profile || '',
                    testTaskId: item.testTaskId || '',
                    testTaskNo: item.testTaskNo || '',
                    testTaskName: item.testTaskName || '',
                    subTestTaskId: item.subTestTaskId,
                    subTestTaskName: item.subTestTaskName,
                    testPhaseId: item.testPhaseId,
                    testPhaseName: item.testPhaseName,
                    gchFlag: item.gchFlag,
                    testPhaseList: item.testPhaseList,
                },
            }));
            console.log('[TaskBindings] 已读取旧版绑定格式（内存转换）');
        } else {
            cachedItems = parsed as CurrentTask[];
        }
        cachedMtimeMs = stat.mtimeMs;
        return cachedItems;
    } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
            console.warn('[TaskBindings] 读取/解析失败:', err?.message || err);
        }
        return [];
    }
}

/**
 * 根据文件路径查找匹配的绑定项。
 * 遍历所有绑定项，若 filePath 位于 rootPath/childPath 目录内则匹配。
 * 未找到返回 null。
 */
export function findBindingByPath(
    filePath: string
): CurrentTask | null {
    if (!filePath) return null;
    const bindingsPath = getBindingsFilePath();
    const items = loadBindings(bindingsPath);
    const normalized = filePath.replace(/\\/g, '/');
    for (const item of items) {
        if (!item.bind || !item.taskInfo) continue;
        if (!item.taskInfo.rootPath || !item.taskInfo.childPath) continue;
        const folderPath = path.join(item.taskInfo.rootPath, item.taskInfo.childPath).replace(/\\/g, '/');
        if (normalized.startsWith(folderPath + '/')) {
            return item;
        }
    }
    return null;
}

/**
 * 返回所有已绑定（bind === true）的绑定项。
 * 供 FileDecorationProvider / TreeView 使用。
 */
export function getAllBoundItems(context?: vscode.ExtensionContext): CurrentTask[] {
    const filePath = getBindingsFilePath(context);
    const items = loadBindings(filePath);
    return items.filter(it => it.bind);
}

/**
 * 返回所有已绑定项的完整文件夹路径集合（用于装饰器路径匹配）。
 */
export function getAllBoundFolderPaths(context?: vscode.ExtensionContext): string[] {
    return getAllBoundItems(context).map(item =>
        path.join(item.taskInfo!.rootPath, item.taskInfo!.childPath).replace(/\\/g, '/')
    );
}

/**
 * 根据文件夹绝对路径查找绑定项。
 */
export function findBindingByFolderPath(
    context: vscode.ExtensionContext,
    folderPath: string
): CurrentTask | null {
    if (!folderPath) return null;
    const normalized = folderPath.replace(/\\/g, '/');
    const items = getAllBoundItems(context);
    for (const item of items) {
        if (!item.taskInfo) continue;
        const itemPath = path.join(item.taskInfo.rootPath, item.taskInfo.childPath).replace(/\\/g, '/');
        if (normalized === itemPath || normalized.startsWith(itemPath + '/')) {
            return item;
        }
    }
    return null;
}
