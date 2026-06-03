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
 *    - 文件格式为 JSON 数组，每项含 rootPath + childPath 组合成完整路径。
 *    - 未绑定时 rootPath / childPath 为空串，绑定后 append 子任务/阶段信息。
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

/** 单个测试任务的绑定记录（对应 tt.json 的单条结构） */
export interface TaskBindingItem {
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
    /** 可选阶段列表（绑定后存在，替代旧 phaseBindings） */
    testPhaseList?: TestPhaseItem[];
}

// ============================================
// 默认模板
// ============================================

function buildEmptyTemplate(): TaskBindingItem[] {
    return [];
}

// ============================================
// 内部状态
// ============================================

let cachedItems: TaskBindingItem[] | null = null;
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
 */
function loadBindings(filePath: string): TaskBindingItem[] {
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
        } else {
            cachedItems = parsed as TaskBindingItem[];
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
): TaskBindingItem | null {
    if (!filePath) return null;
    const bindingsPath = getBindingsFilePath();
    const items = loadBindings(bindingsPath);
    const normalized = filePath.replace(/\\/g, '/');
    for (const item of items) {
        if (!item.rootPath || !item.childPath) continue;
        const folderPath = path.join(item.rootPath, item.childPath).replace(/\\/g, '/');
        if (normalized.startsWith(folderPath + '/')) {
            return item;
        }
    }
    return null;
}

/**
 * 返回所有已绑定（rootPath 和 childPath 均非空）的绑定项。
 * 供 FileDecorationProvider / TreeView 使用。
 */
export function getAllBoundItems(context?: vscode.ExtensionContext): TaskBindingItem[] {
    const filePath = getBindingsFilePath(context);
    const items = loadBindings(filePath);
    return items.filter(it => it.rootPath && it.childPath);
}

/**
 * 返回所有已绑定项的完整文件夹路径集合（用于装饰器路径匹配）。
 */
export function getAllBoundFolderPaths(context?: vscode.ExtensionContext): string[] {
    return getAllBoundItems(context).map(item =>
        path.join(item.rootPath, item.childPath).replace(/\\/g, '/')
    );
}

/**
 * 根据文件夹绝对路径查找绑定项。
 */
export function findBindingByFolderPath(
    context: vscode.ExtensionContext,
    folderPath: string
): TaskBindingItem | null {
    if (!folderPath) return null;
    const normalized = folderPath.replace(/\\/g, '/');
    const items = getAllBoundItems(context);
    for (const item of items) {
        const itemPath = path.join(item.rootPath, item.childPath).replace(/\\/g, '/');
        if (normalized === itemPath || normalized.startsWith(itemPath + '/')) {
            return item;
        }
    }
    return null;
}
