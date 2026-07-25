/**
 * ============================================================================
 *  utils/pushFailureStore.ts
 *  推送失败标记的持久化存储
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 以 globalStorageUri/push-failures.json 作为持久化文件。
 *    2. 每项以文件绝对路径为 key，记录 { [tsId: string]: reason }。
 *       仅按 testcase_id（行稳定唯一标识）维护失败映射，不依赖行号。
 *    3. 文件不存在时自动创建空对象模板。
 *    4. 提供 getFailures / mergeFailures / clearFailures 接口。
 *  设计要点：
 *    - 使用 globalStorageUri，与 highlighted-cells.json 同目录，跨工作区共享。
 *    - 推送返回时增量合并：本批参与的 tsId 全部清掉旧标记，再写入本次失败 tsId+reason。
 *    - 文件打开时从磁盘加载，关闭/重开/重启 vscode 后失败高亮不丢失。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TS_ID_COLUMN } from '../services/utils';
import type { PushFailCategory, PushInterfaceField } from './pushFailureCategory';

// ============================================
// 类型定义
// ============================================

/** 单条失败记录：reason 为失败原因原文，timestamp 为失败时间戳（ms），category/field 为分类与字段维度 */
export interface PushFailureItem {
    reason: string;
    timestamp: number;
    /** 失败分类码（统计/埋点维度），历史数据缺失时为 undefined */
    category?: PushFailCategory;
    /** 命中的接口字段码（聚焦维度），历史数据缺失时为 undefined */
    field?: PushInterfaceField;
}

export interface PushFailureEntry {
    [tsId: string]: PushFailureItem; // tsId -> { reason, timestamp }
}

interface PushFailureStoreData {
    [filePath: string]: PushFailureEntry;
}

// ============================================
// 内部状态
// ============================================

let resolvedFilePath: string | null = null;
let cachedStore: PushFailureStoreData | null = null;
let cachedMtimeMs = 0;

/**
 * 旧格式兼容：早期版本 entry value 为纯字符串 reason，
 * 新版升级为 { reason, timestamp } 对象。读取时统一规范化，
 * 旧格式 timestamp 视为 0（最旧），渲染时不会"晚于"任何用户标记。
 */
function normalizeEntry(raw: any): PushFailureEntry {
    const out: PushFailureEntry = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of Object.keys(raw)) {
        const v = raw[k];
        if (v == null) continue;
        if (typeof v === 'string') {
            out[k] = { reason: v, timestamp: 0 };
        } else if (typeof v === 'object') {
            const reason = (v.reason != null) ? String(v.reason) : '';
            const ts = (typeof v.timestamp === 'number' && isFinite(v.timestamp)) ? v.timestamp : 0;
            const cat = typeof v.category === 'string' ? (v.category as PushFailCategory) : undefined;
            const fld = typeof v.field === 'string' ? (v.field as PushInterfaceField) : undefined;
            out[k] = { reason, timestamp: ts, category: cat, field: fld };
        }
    }
    return out;
}

// ============================================
// 公共接口
// ============================================

/**
 * 初始化失败存储文件（必要时创建目录与空对象文件）。
 * 在 activate 阶段调用一次。
 */
export async function ensurePushFailureFile(context: vscode.ExtensionContext): Promise<string> {
    const dir = context.globalStorageUri.fsPath;
    const filePath = path.join(dir, 'push-failures.json');
    resolvedFilePath = filePath;

    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
        } catch {
            await fs.promises.writeFile(filePath, JSON.stringify({}, null, 2), 'utf-8');
            console.log('[PushFailureStore] 已创建空失败文件: ' + filePath);
        }
    } catch (err: any) {
        console.error('[PushFailureStore] 初始化失败文件失败:', err?.message || err);
    }
    return filePath;
}

/**
 * 读取并缓存失败数据。使用 mtime 校验，文件未变更时直接返回缓存。
 */
function loadStore(): PushFailureStoreData {
    if (!resolvedFilePath) return {};
    try {
        const stat = fs.statSync(resolvedFilePath);
        if (cachedStore && stat.mtimeMs === cachedMtimeMs) {
            return cachedStore;
        }
        const text = fs.readFileSync(resolvedFilePath, 'utf-8');
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) {
            console.warn('[PushFailureStore] 文件格式异常，返回空');
            cachedStore = {};
        } else {
            // 兼容旧格式：每个文件下的 entry 内若 value 仍是字符串，统一升级为对象
            const normalized: PushFailureStoreData = {};
            for (const fp of Object.keys(parsed as any)) {
                normalized[fp] = normalizeEntry((parsed as any)[fp]);
            }
            cachedStore = normalized;
        }
        cachedMtimeMs = stat.mtimeMs;
        return cachedStore;
    } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
            console.warn('[PushFailureStore] 读取失败:', err?.message || err);
        }
        return {};
    }
}

/**
 * 持久化写入，同时更新缓存。
 */
async function saveStore(store: PushFailureStoreData): Promise<void> {
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
        console.error('[PushFailureStore] 保存失败:', err?.message || err);
    }
}

/**
 * 查询指定文件的失败映射（tsId → { reason, timestamp }）。无记录返回空对象。
 */
export function getFailures(filePath: string): PushFailureEntry {
    if (!filePath) return {};
    const store = loadStore();
    const entry = store[filePath];
    return entry && typeof entry === 'object' ? entry : {};
}

/**
 * 合并写入：先清除"本批参与的 tsId"的旧失败标记，再写入本次失败 tsId→{reason,timestamp}。
 *   - batchTsIds：本次推送参与的所有 tsId（用于差集，让本批中已成功的 tsId 清掉旧失败标记）
 *   - failures：本次失败的 tsId→reason 映射（reason 为字符串，时间戳由本函数统一打 Date.now()）
 *   - successTsIds：扩展端额外回传的明确成功 tsId（兜底，可为空）
 *
 * 未参与本批的历史失败标记保持不变。
 */
/**
 * 删除指定文件的全部推送失败记录（文件被删除时调用）。
 */
export async function removeFailureFile(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

/**
 * 清理已不存在的文件的孤儿推送失败记录。
 * 使用异步 fs.promises.access 替代同步 existsSync，避免大量文件时阻塞事件循环。
 */
export async function cleanupOrphanedFailures(): Promise<void> {
    const store = loadStore();
    let changed = false;
    for (const fp of Object.keys(store)) {
        try {
            await fs.promises.access(fp, fs.constants.F_OK);
        } catch {
            delete store[fp];
            changed = true;
        }
    }
    if (changed) await saveStore(store);
}

export async function mergeFailures(
    filePath: string,
    batchTsIds: string[],
    failures: { [tsId: string]: string | { reason: string; category?: PushFailCategory; field?: PushInterfaceField } },
    successTsIds?: string[]
): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    const entry: PushFailureEntry = { ...(store[filePath] || {}) };

    // 1) 本批参与 tsId：先清旧标记
    if (Array.isArray(batchTsIds)) {
        for (const t of batchTsIds) {
            if (t !== undefined && t !== null && t !== '') {
                delete entry[String(t)];
            }
        }
    }
    // 2) 扩展端明确成功的 tsId：兜底清除
    if (Array.isArray(successTsIds)) {
        for (const t of successTsIds) {
            if (t !== undefined && t !== null && t !== '') {
                delete entry[String(t)];
            }
        }
    }
    // 3) 写入本次失败：统一打当前时间戳，便于前端按"高亮时间"决定优先级
    const now = Date.now();
    if (failures && typeof failures === 'object') {
        for (const k of Object.keys(failures)) {
            const raw = failures[k];
            if (k && raw !== undefined && raw !== null) {
                const reason = typeof raw === 'string' ? String(raw) : String(raw.reason || '');
                const category = typeof raw === 'string' ? undefined : (raw.category as PushFailCategory | undefined);
                const field = typeof raw === 'string' ? undefined : (raw.field as PushInterfaceField | undefined);
                entry[k] = { reason, timestamp: now, category, field };
            }
        }
    }

    if (Object.keys(entry).length === 0) {
        // 整个文件无失败标记，移除该 key 保持文件精简
        if (store[filePath]) {
            delete store[filePath];
            await saveStore(store);
        }
        return;
    }
    store[filePath] = entry;
    await saveStore(store);
}

/**
 * 便捷方法：从推送数据行和失败列表构造 mergeFailures 所需参数并持久化。
 * 消除 pushHandler / BaseEditorProvider 中完全重复的 batchTsIds/failuresMap/successTsIds 整理逻辑。
 *
 * @param filePath        文件路径
 * @param rows            参与推送的行数据数组
 * @param failures        失败项列表（来自 parsePushResponse）
 * @param successMappings 成功项列表（来自 parsePushResponse）
 */
export async function persistPushFailures(
    filePath: string,
    rows: any[],
    failures: Array<{ tsId: string; reason: string; category?: PushFailCategory; field?: PushInterfaceField }>,
    successMappings: Array<{ tsId: string; testCaseNo: string }>,
): Promise<void> {
    const batchTsIds: string[] = [];
    for (const rec of rows) {
        const id = rec && (rec as any)[TS_ID_COLUMN] != null ? String((rec as any)[TS_ID_COLUMN]) : '';
        if (id) batchTsIds.push(id);
    }
    const failuresMap: { [tsId: string]: { reason: string; category?: PushFailCategory; field?: PushInterfaceField } } = {};
    failures.forEach(f => {
        if (f && f.tsId !== undefined && f.tsId !== null && f.tsId !== '') {
            failuresMap[String(f.tsId)] = {
                reason: String(f.reason || ''),
                category: f.category,
                field: f.field,
            };
        }
    });
    const successTsIds: string[] = successMappings
        .map(s => s && s.tsId)
        .filter((t: any) => t !== undefined && t !== null && t !== '')
        .map((t: any) => String(t));
    await mergeFailures(filePath, batchTsIds, failuresMap, successTsIds);
}

/**
 * 清除指定文件的所有失败记录（如行整批撤销/文件重建场景）。
 */
export async function clearFailures(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}
