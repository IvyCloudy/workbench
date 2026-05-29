/**
 * ============================================================================
 *  utils/taskInfoStore.ts
 *  测试任务绑定信息持久化（globalStorageUri/task-bindings.json）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 维护 <globalStorageUri>/task-bindings.json 文件的读写。
 *    2. 文件不存在时自动创建空模板，并在 console.log 中输出绝对路径。
 *    3. 提供 lookupBinding(workspaceRelKey) 给上层查询。
 *  设计要点：
 *    - 使用 globalStorageUri，跨工作区共享同一份绑定（用户全局维护即可）。
 *    - 文件解析失败时返回空 bindings，避免影响主功能。
 *    - 使用内存缓存 + mtime 校验，避免每次访问都做磁盘 IO；同时也允许用户
 *      手动改文件后被自动感知。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// 类型定义
// ============================================

/** 单个测试任务的绑定记录 */
export interface TaskBindingEntry {
    /** 测试任务编号（后端真实值），如 TT_2024_xxxx */
    testTaskNo: string;
    /** 测试任务名称（顶层项目名），如 "测试任务系统" */
    testTaskName: string;
    /** 子测试任务 ID（后端真实值） */
    subTestTaskId: number;
    /** 子测试任务名称（与目录名 _ 后部分一致） */
    subTestTaskName: string;
    /** 阶段绑定：testPhaseName -> { phaseId } */
    phaseBindings?: Record<string, { phaseId: number }>;
}

/** task-bindings.json 文件结构 */
interface TaskBindingsFile {
    _readme?: string;
    version: number;
    /**
     * key 形如 "<项目目录名>/测试任务/<TTxxx_子任务名>"，相对路径
     * 例如 "C001_测试/测试任务/TT001_测试任务1"
     */
    bindings: Record<string, TaskBindingEntry>;
}

// ============================================
// 默认模板
// ============================================

const README_TEXT =
    'task-bindings.json 用于维护测试任务的真实后端信息。' +
    'key 形如 "<项目目录名>/测试任务/<TTxxx_子任务名>"，相对路径；' +
    'testTaskNo 为后端真实测试任务编号；' +
    'phaseBindings 维护 testPhaseName -> phaseId 映射。';

function buildEmptyTemplate(): TaskBindingsFile {
    return {
        _readme: README_TEXT,
        version: 1,
        bindings: {
            // 示例（请按需替换并删除本示例）
            // "C001_测试/测试任务/TT001_测试任务1": {
            //     "testTaskNo": "TT_2024_0001",
            //     "testTaskName": "测试任务系统",
            //     "subTestTaskId": 378789,
            //     "subTestTaskName": "测试任务1",
            //     "phaseBindings": {
            //         "ST阶段": { "phaseId": 89988 }
            //     }
            // }
        },
    };
}

// ============================================
// 内部状态
// ============================================

let cachedFile: TaskBindingsFile | null = null;
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
            console.log('[TaskBindings] 已创建空模板文件: ' + filePath);
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
 * 读取并缓存绑定文件内容。出错时返回空 bindings，不抛异常。
 * 使用 mtime 比对，文件未变更时直接返回缓存。
 */
function loadBindings(filePath: string): TaskBindingsFile {
    if (!filePath) return { version: 1, bindings: {} };
    try {
        const stat = fs.statSync(filePath);
        if (cachedFile && stat.mtimeMs === cachedMtimeMs) {
            return cachedFile;
        }
        const text = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(text) as TaskBindingsFile;
        if (!parsed || typeof parsed !== 'object' || !parsed.bindings) {
            console.warn('[TaskBindings] 文件内容不合法，使用空 bindings');
            cachedFile = { version: 1, bindings: {} };
        } else {
            cachedFile = parsed;
        }
        cachedMtimeMs = stat.mtimeMs;
        return cachedFile;
    } catch (err: any) {
        // 文件不存在时返回空（ensureBindingsFile 会负责创建）
        if (err && err.code !== 'ENOENT') {
            console.warn('[TaskBindings] 读取/解析失败:', err?.message || err);
        }
        return { version: 1, bindings: {} };
    }
}

/**
 * 根据 key（如 "C001_测试/测试任务/TT001_测试任务1"）查找绑定。
 * 未找到返回 null。
 */
export function lookupBinding(
    context: vscode.ExtensionContext,
    key: string
): TaskBindingEntry | null {
    if (!key) return null;
    const filePath = getBindingsFilePath(context);
    const file = loadBindings(filePath);
    const entry = file.bindings[key];
    return entry || null;
}
