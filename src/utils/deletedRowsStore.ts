/**
 * ============================================================================
 *  utils/deletedRowsStore.ts
 *  已删除行同步追踪存储
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 持久化记录"待同步"的已删除行（testcase_id 列表），按文件分组。
 *    2. 同步成功后将指定行从 push-snapshots 中清除，并清理追踪记录。
 *    3. 提供查询、同步、清理等接口，供后续扩展接入线上删除 API。
 *
 *  与 pushSnapshotStore 的关系：
 *    - pushSnapshotStore 的 diffPushSnapshot 根据"快照有/当前数据无"检测删除行。
 *    - deletedRowsStore 是上层追踪层，管理"哪些已删除行需要同步到线上"。
 *    - savePushSnapshot 增量模式下不再自动清除已删除行快照，由本 store 的 sync 方法显式触发清除。
 *
 *  存储格式（JSON 文件）：
 *    {
 *      "/path/to/file.csv": {
 *        "tsId1": 1717500000000,
 *        "tsId2": 1717500000001
 *      }
 *    }
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getDeletedSnapshotIds, clearDeletedSnapshots, type DeletedRowInfo } from './pushSnapshotStore';
import { deleteTestCase } from '../services/http';
import { resolveTaskInfoOrNull } from '../handlers/pushCore.stages';
import { TelemetryService } from './telemetry';

// ============================================
// 类型定义
// ============================================

/** 文件 → { testcase_id → 删除时间戳 } */
type DeletedRowsStore = Record<string, Record<string, number>>;

/** 单条已删除行记录 */
export interface DeletedRowRecord {
    /** testcase_id */
    tsId: string;
    /** 文件绝对路径 */
    filePath: string;
    /** 删除时的时间戳 (ms) */
    deletedAt: number;
}

/** 同步结果 */
export interface SyncDeletedResult {
    /**
     * 同步成功的 tsId 列表（本地视为删除成功，会清除追踪记录与快照）。
     * 包含 type=1（线上删除成功）与 type=3（sourceId 不存在，仍算删除成功）两类。
     */
    synced: string[];
    /** 同步失败的 tsId 列表（含原因），仅对应接口返回 type=2 */
    failed: Array<{ tsId: string; reason: string }>;
    /**
     * 删除成功-汇总分档（新增，用于结果汇总时区分两种"成功"来源）：
     *   - deletedSuccess      type=1 线上删除成功（sourceId 真实存在并已删除）
     *   - deletedSourceMissing type=3 sourceId 不存在，但按需求仍视为删除成功
     *                          （本地标记删除 / 清理，仅汇总口径上区分于 type=1）
     * 二者并集 === synced；failed 仅对应 type=2。
     */
    deletedSuccess: string[];
    deletedSourceMissing: string[];
}

// ============================================
// 内部状态
// ============================================

let resolvedFilePath: string | null = null;
let cachedContext: vscode.ExtensionContext | null = null;
let cachedStore: DeletedRowsStore | null = null;
let cachedMtimeMs = 0;

// ============================================
// 内部方法
// ============================================

/**
 * 读取并缓存删除行追踪数据。使用 mtime 校验，文件未变更时直接返回缓存。
 * 与 markStore / highlightStore / pushFailureStore 保持一致的加载策略，
 * 避免跨插件实例场景下缓存过期覆盖磁盘最新数据。
 */
function loadStore(): DeletedRowsStore {
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
            cachedStore = parsed as DeletedRowsStore;
        }
        cachedMtimeMs = stat.mtimeMs;
        return cachedStore;
    } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
            console.warn('[DeletedRowsStore] 读取失败:', err?.message || err);
        }
        return {};
    }
}

/**
 * 持久化写入，同时更新缓存与 mtime。
 * 与其他 store 对齐：全 try/catch 包裹，避免向上传播 I/O 异常，
 * 且写失败时不污染 cachedStore（保持与磁盘一致）。
 */
async function saveStore(store: DeletedRowsStore): Promise<void> {
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
        console.error('[DeletedRowsStore] 保存失败:', err?.message || err);
    }
}

// ============================================
// 公共接口
// ============================================

/**
 * 初始化删除行存储文件。在 activate 阶段调用一次。
 */
export async function ensureDeletedRowsFile(context: vscode.ExtensionContext): Promise<string> {
    const dir = context.globalStorageUri.fsPath;
    const fp = path.join(dir, 'deleted-rows.json');
    resolvedFilePath = fp;
    cachedContext = context;
    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try { await fs.promises.access(fp, fs.constants.F_OK); }
        catch { await fs.promises.writeFile(fp, JSON.stringify({}), 'utf-8'); }
    } catch (err: any) {
        console.error('[DeletedRowsStore] 初始化失败:', err?.message || err);
    }
    return fp;
}

/**
 * 标记一批 testcase_id 为"待同步"的已删除行。
 * 通常由 diffPushSnapshot 检测到删除后调用，或用户在编辑器中显式删除后调用。
 * @param filePath 文件绝对路径
 * @param tsIds    要标记为待同步的 testcase_id 列表
 */
export async function markDeletedRows(filePath: string, tsIds: string[]): Promise<void> {
    if (!filePath || !tsIds || tsIds.length === 0) return;
    const store = loadStore();
    if (!store[filePath]) store[filePath] = {};
    const now = Date.now();
    for (const id of tsIds) {
        // 仅首次标记时记录时间戳，后续保持原始时间
        if (!store[filePath][id]) {
            store[filePath][id] = now;
        }
    }
    await saveStore(store);
    console.log(`[DeletedRowsStore] 标记待同步删除行: ${filePath} (${tsIds.length} 行)`);
}

/**
 * 获取指定文件中所有待同步的已删除行记录。
 * @param filePath 文件绝对路径
 * @returns 已删除行记录列表
 */
export function getPendingDeletedRows(filePath: string): DeletedRowRecord[] {
    if (!filePath) return [];
    // 统一走 loadStore()（内部已做 mtime 缓存校验），避免缓存过期读到旧数据
    const store = loadStore();
    const fileRecords = store[filePath];
    if (!fileRecords) return [];
    return Object.entries(fileRecords).map(([tsId, deletedAt]) => ({
        tsId,
        filePath,
        deletedAt,
    }));
}

/**
 * 从 push-snapshot 中获取当前实际的已删除行列表，并确保它们被追踪。
 * 返回待同步的删除行信息，用于前端展示。
 * @param filePath   文件绝对路径
 * @param tableData  当前文件解析后的 { headers, rows }
 * @returns 待同步的已删除行列表（来自快照对比）
 */
export function refreshAndGetDeletedRows(
    filePath: string,
    tableData: { headers: string[]; rows: any[][] },
): DeletedRowInfo[] {
    const deletedFromSnapshot = getDeletedSnapshotIds(filePath, tableData);
    if (deletedFromSnapshot.length > 0) {
        // 自动将快照中的删除行同步到追踪记录
        const tsIds = deletedFromSnapshot.map(d => d.tsId);
        markDeletedRows(filePath, tsIds).catch(err =>
            console.error('[DeletedRowsStore] 自动标记失败:', err)
        );
    }
    return deletedFromSnapshot;
}

/**
 * 同步指定的已删除行到线上（占位实现，后续扩展）。
 *
 * 流程：
 *   1. 调用线上删除 API（待实现）
 *   2. 移除追踪记录
 *   3. 从 push-snapshot 中清除对应的快照条目
 *
 * @param filePath 文件绝对路径
 * @param tsIds    要同步的 testcase_id 列表，为空则同步全部待处理行
 * @returns 同步结果
 */
export async function syncDeletedRows(
    filePath: string,
    tsIds?: string[],
): Promise<SyncDeletedResult> {
    if (!filePath) return { synced: [], failed: [], deletedSuccess: [], deletedSourceMissing: [] };

    // 确定要同步的行
    let targetIds: string[];
    if (tsIds && tsIds.length > 0) {
        targetIds = tsIds;
    } else {
        const pending = getPendingDeletedRows(filePath);
        targetIds = pending.map(r => r.tsId);
    }
    if (targetIds.length === 0) {
        return { synced: [], failed: [], deletedSuccess: [], deletedSourceMissing: [] };
    }

    const synced: string[] = [];
    /** type=1：线上删除成功（sourceId 真实存在并已删除） */
    const deletedSuccess: string[] = [];
    /** type=3：sourceId 不存在，但仍视为删除成功（本地清理） */
    const deletedSourceMissing: string[] = [];
    const failed: Array<{ tsId: string; reason: string }> = [];

    // ---- 调用线上删除接口（POST /test-task/delete-testcase） ----
    //   入参：testTaskNo / subTestTaskId / sourceIds（即待删除案例的 testcase_id 列表）
    //   出参：body[] 中每项含 sourceId 与 type，type 取值：
    //     '1' 成功（sourceId 真实存在并已删除）
    //     '2' 失败（放入 failed，不清除本地追踪，可重试）
    //     '3' sourceId 不存在 —— 按需求仍视为"删除成功"，本地同样清理，
    //         但汇总时通过 deletedSourceMissing 与 type=1 的 deletedSuccess 区分
    try {
        if (!cachedContext) {
            throw new Error('已删除行存储尚未初始化（请确认扩展已激活）');
        }
        const taskInfo = await resolveTaskInfoOrNull(filePath);
        if (taskInfo.status !== 'ok') {
            throw new Error(
                taskInfo.status === 'unbound'
                    ? '当前文件未绑定测试任务，无法同步删除'
                    : (taskInfo.errorMessage || '获取测试任务信息失败'),
            );
        }

        const resp = await deleteTestCase(
            cachedContext,
            { testTaskNo: taskInfo.taskInfo.testTaskNo, subTestTaskId: taskInfo.taskInfo.subTestTaskId },
            targetIds,
        );

        if (resp.returnCode !== 'SUC0000') {
            throw new Error(resp.errorMsg || `删除接口返回 ${resp.returnCode}`);
        }

        // 依据 body 逐条 type 判定成功/失败；sourceId 对应 testcase_id
        //   - type='2' 失败的失败原因使用接口返回的 data 字段（更贴合后端实际语义）
        const resultBody: Array<{ sourceId?: string; type?: string; data?: any }> = Array.isArray(resp.body) ? resp.body : [];
        const typeBySourceId = new Map<string, string>();
        const dataBySourceId = new Map<string, any>();
        for (const item of resultBody) {
            const sid = String(item?.sourceId ?? '').trim();
            if (!sid) continue;
            typeBySourceId.set(sid, String(item?.type ?? ''));
            if (item?.data != null) dataBySourceId.set(sid, item.data);
        }

        for (const id of targetIds) {
            const t = typeBySourceId.get(id);
            if (t === '1') {
                // 线上删除成功：清理本地追踪与快照
                synced.push(id);
                deletedSuccess.push(id);
            } else if (t === '3') {
                // sourceId 不存在：按需求仍视为删除成功，本地同样清理，
                // 但汇总分档到 deletedSourceMissing，便于区分"线上本就没有这条"的情况
                synced.push(id);
                deletedSourceMissing.push(id);
            } else if (t === '2') {
                // 失败原因取接口返回的 data（兜底文案仅在接口未给 data 时使用）
                const failData = dataBySourceId.get(id);
                const reason = failData != null ? String(failData) : '线上删除失败';
                failed.push({ tsId: id, reason });
            } else {
                // 接口未返回该 sourceId 的结果，按失败保守处理
                failed.push({ tsId: id, reason: '线上删除结果缺失（接口未返回该 sourceId）' });
            }
        }
    } catch (err: any) {
        console.error('[DeletedRowsStore] 同步删除失败:', err?.message || err);
        TelemetryService.sendTelemetryErrorEvent('deletedRowsStore.syncFailed', {
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            filePath: path.basename(filePath),
            totalRows: String(targetIds.length),
        });
        // 整体失败时，所有待同步行标记为失败（保持待同步状态，下次可重试）
        failed.push(...targetIds.map(id => ({
            tsId: id,
            reason: `同步异常: ${err?.message || String(err)}`,
        })));
    }

    // 同步成功的：从追踪记录和快照中清除
    if (synced.length > 0) {
        // 清除 push-snapshot 中的条目
        await clearDeletedSnapshots(filePath, synced);
        // 清除追踪记录
        const store = loadStore();
        if (store[filePath]) {
            for (const id of synced) {
                delete store[filePath][id];
            }
            if (Object.keys(store[filePath]).length === 0) {
                delete store[filePath];
            }
            await saveStore(store);
        }
        console.log(`[DeletedRowsStore] 已同步并清除 ${synced.length} 行: ${filePath}`);
    }

    return { synced, failed, deletedSuccess, deletedSourceMissing };
}

/**
 * 清除指定文件的所有删除行追踪记录（不清除 push-snapshot）。
 */
/**
 * 删除指定文件的全部删除行追踪记录（文件被删除时调用）。
 */
export async function removeDeletedRowsFile(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

/**
 * 清理已不存在的文件的孤儿删除行追踪记录。
 * 使用异步 fs.promises.access 替代同步 existsSync，避免大量文件时阻塞事件循环。
 */
export async function cleanupOrphanedDeletedRows(): Promise<void> {
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

export async function clearDeletedRowsTracking(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}
