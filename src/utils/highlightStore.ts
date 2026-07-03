/**
 * ============================================================================
 *  utils/highlightStore.ts
 *  编辑后单元格变更高亮的持久化存储
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 以 globalStorageUri/highlighted-cells.json 作为持久化文件。
 *    2. 每项以文件绝对路径为 key，记录 { colIdx, rowIndices, cells? }。
 *       colIdx === -1 表示整行任意列变化，前端高亮该行所有单元格。
 *       cells 为 [rowIdx, colIdx][] 扁平数组，用于精确逐格高亮（编辑保存场景）。
 *    3. 文件不存在时自动创建空对象模板。
 *    4. 提供 getHighlight / setHighlight / clearHighlight 接口。
 *  设计要点：
 *    - 使用 globalStorageUri，与 task-bindings.json 同目录，跨工作区共享。
 *    - Webview 编辑保存 / TextEditor 外部修改后检测全列变化并持久化。
 *    - 文件打开时从磁盘加载，确保关闭/重开项目后高亮不丢失。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// 类型定义
// ============================================

export interface HighlightEntry {
    colIdx: number;
    rowIndices: number[];
    cells?: Array<[number, number]>;  // [rowIdx, colIdx][] 精确逐格高亮
}

interface HighlightStore {
    [filePath: string]: HighlightEntry;
}

// ============================================
// 内部状态
// ============================================

let resolvedFilePath: string | null = null;
let cachedStore: HighlightStore | null = null;
let cachedMtimeMs = 0;

// ============================================
// 公共接口
// ============================================

/**
 * 初始化高亮存储文件（必要时创建目录与空对象文件）。
 * 在 activate 阶段调用一次。
 */
export async function ensureHighlightFile(context: vscode.ExtensionContext): Promise<string> {
    const dir = context.globalStorageUri.fsPath;
    const filePath = path.join(dir, 'highlighted-cells.json');
    resolvedFilePath = filePath;

    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
        } catch {
            await fs.promises.writeFile(filePath, JSON.stringify({}, null, 2), 'utf-8');
            console.log('[HighlightStore] 已创建空高亮文件: ' + filePath);
        }
    } catch (err: any) {
        console.error('[HighlightStore] 初始化高亮文件失败:', err?.message || err);
    }
    return filePath;
}

/**
 * 读取并缓存高亮数据。使用 mtime 校验，文件未变更时直接返回缓存。
 */
function loadStore(): HighlightStore {
    if (!resolvedFilePath) return {};
    try {
        const stat = fs.statSync(resolvedFilePath);
        if (cachedStore && stat.mtimeMs === cachedMtimeMs) {
            return cachedStore;
        }
        const text = fs.readFileSync(resolvedFilePath, 'utf-8');
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) {
            console.warn('[HighlightStore] 文件格式异常，返回空');
            cachedStore = {};
        } else {
            cachedStore = parsed as HighlightStore;
        }
        cachedMtimeMs = stat.mtimeMs;
        return cachedStore;
    } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
            console.warn('[HighlightStore] 读取失败:', err?.message || err);
        }
        return {};
    }
}

/**
 * 持久化写入，同时更新缓存。
 */
async function saveStore(store: HighlightStore): Promise<void> {
    if (!resolvedFilePath) return;
    try {
        const text = JSON.stringify(store, null, 2);
        await fs.promises.writeFile(resolvedFilePath, text, 'utf-8');
        cachedStore = store;
        // 刷新 mtime 近似值，避免立即重读时因 stat 仍为旧值而命中旧缓存
        try {
            const stat = fs.statSync(resolvedFilePath);
            cachedMtimeMs = stat.mtimeMs;
        } catch { /* ignore */ }
    } catch (err: any) {
        console.error('[HighlightStore] 保存失败:', err?.message || err);
    }
}

/**
 * 查询指定文件的高亮信息，无记录返回 null。
 */
export function getHighlight(filePath: string): HighlightEntry | null {
    if (!filePath) return null;
    const store = loadStore();
    return store[filePath] || null;
}

/**
 * 记录/更新指定文件的高亮信息（推送成功时调用）。
 * 每次推送完全覆盖该文件的旧记录。
 */
export async function setHighlight(filePath: string, entry: HighlightEntry): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    store[filePath] = entry;
    await saveStore(store);
}

/**
 * 清除指定文件的高亮记录。
 */
export async function clearHighlight(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

/**
 * 删除指定文件的全部高亮记录（文件被删除时调用）。
 */
export async function removeHighlightFile(filePath: string): Promise<void> {
    await clearHighlight(filePath);
}

/**
 * 清理已不存在的文件的孤儿高亮记录。
 */
export async function cleanupOrphanedHighlights(): Promise<void> {
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
