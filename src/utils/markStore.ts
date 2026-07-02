/**
 * ============================================================================
 *  utils/markStore.ts
 *  用户手动标记高亮的持久化存储
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 以 globalStorageUri/marked-cells.json 作为持久化文件。
 *    2. 每项以文件绝对路径为 key，记录 MarkRect[] 矩形标记区域。
 *       c1 === -1 时表示整行标记（忽略 c 维度）。
 *    3. 文件不存在时自动创建空对象模板。
 *    4. 提供 getMarks / setMarks / clearMarks 接口。
 *  设计要点：
 *    - 标记与推送状态无关，由用户手动管理。
 *    - 文件保存/关闭/重开后标记持久保留。
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// 类型定义
// ============================================

/** 单个标记矩形区域（含颜色） */
export interface MarkRect {
    r1: number;
    c1: number;  // -1 表示整行（忽略列维度）
    r2: number;
    c2: number;
    bgColor?: string;   // 背景色，如 "#e3f2fd"，空/未定义则使用默认色
    fontColor?: string;  // 字体色，如 "#d32f2f"，空/未定义则不改变字体色
    timestamp?: number;  // 标记创建时间 (ms)，用于高亮叠加时的优先级判断（最近操作优先）
}

interface MarkEntry {
    rects: MarkRect[];
}

interface MarkStore {
    [filePath: string]: MarkEntry;
}

// ============================================
// 内部状态
// ============================================

let resolvedFilePath: string | null = null;
let cachedStore: MarkStore | null = null;
let cachedMtimeMs = 0;

// ============================================
// 公共接口
// ============================================

/**
 * 初始化标记存储文件。
 */
export async function ensureMarkFile(context: vscode.ExtensionContext): Promise<string> {
    const dir = context.globalStorageUri.fsPath;
    const filePath = path.join(dir, 'marked-cells.json');
    resolvedFilePath = filePath;

    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
        } catch {
            await fs.promises.writeFile(filePath, JSON.stringify({}, null, 2), 'utf-8');
            console.log('[MarkStore] 已创建空标记文件: ' + filePath);
        }
    } catch (err: any) {
        console.error('[MarkStore] 初始化标记文件失败:', err?.message || err);
    }
    return filePath;
}

// ============================================
// 内部辅助：加载 / 保存
// ============================================

function loadStore(): MarkStore {
    if (!resolvedFilePath) return {};
    try {
        const stat = fs.statSync(resolvedFilePath);
        if (cachedStore && stat.mtimeMs === cachedMtimeMs) {
            return cachedStore;
        }
        const text = fs.readFileSync(resolvedFilePath, 'utf-8');
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) {
            cachedStore = {};
        } else {
            cachedStore = parsed as MarkStore;
        }
        cachedMtimeMs = stat.mtimeMs;
        return cachedStore;
    } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
            console.warn('[MarkStore] 读取失败:', err?.message || err);
        }
        return {};
    }
}

async function saveStore(store: MarkStore): Promise<void> {
    if (!resolvedFilePath) return;
    try {
        const text = JSON.stringify(store, null, 2);
        await fs.promises.writeFile(resolvedFilePath, text, 'utf-8');
        cachedStore = store;
        try {
            const stat = fs.statSync(resolvedFilePath);
            cachedMtimeMs = stat.mtimeMs;
        } catch { /* ignore */ }
    } catch (err: any) {
        console.error('[MarkStore] 保存失败:', err?.message || err);
    }
}

// ============================================
// 查询 / 设置 / 清除
// ============================================

/**
 * 获取指定文件的标记列表，无记录返回 []。
 */
export function getMarks(filePath: string): MarkRect[] {
    if (!filePath) return [];
    const store = loadStore();
    return (store[filePath] && store[filePath].rects) || [];
}

/**
 * 设置（覆盖）指定文件的标记列表。
 */
export async function setMarks(filePath: string, rects: MarkRect[]): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    store[filePath] = { rects };
    await saveStore(store);
}

/**
 * 清除指定文件的所有标记。
 */
export async function clearMarks(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

/**
 * 删除指定文件的全部标记记录（文件被删除时调用）。
 */
export async function removeMarkFile(filePath: string): Promise<void> {
    await clearMarks(filePath);
}

/**
 * 清理已不存在的文件的孤儿标记记录。
 */
export async function cleanupOrphanedMarks(): Promise<void> {
    const store = loadStore();
    let changed = false;
    for (const fp of Object.keys(store)) {
        if (!require('fs').existsSync(fp)) {
            delete store[fp];
            changed = true;
        }
    }
    if (changed) await saveStore(store);
}
