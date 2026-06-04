/**
 * ============================================================================
 *  utils/pushSnapshotStore.ts
 *  推送后的文件快照存储，用于后续差异比对高亮
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 推送成功后保存当前文件内容快照（排除 testCaseNo 列）。
 *    2. 每次 diff 时，用当前数据与快照对比（均排除 testCaseNo），返回变化的行索引。
 *    3. 下次推送会覆盖快照（建立新基线）。
 *  设计要点：
 *    - 文件名为 push-snapshots.json，与 highlighted-cells.json 同目录。
 *    - 每行序列化为 \x00 分隔的字符串，按 testcase_id 索引，O(1) 查找比较。
 *    - 排除 testCaseNo 列，确保推送回写 testCaseNo 不误触发高亮。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// 常量
// ============================================

const TS_ID_COLUMN = 'testcase_id';
const TC_NO_COLUMN = 'testCaseNo';

// ============================================
// 类型定义
// ============================================

interface RowSnapshots {
    [tsId: string]: string;   // tsId → serialized row (all columns joined by \x00, testCaseNo excluded)
}

interface SnapshotStore {
    [filePath: string]: RowSnapshots;
}

// ============================================
// 内部状态
// ============================================

let resolvedFilePath: string | null = null;
let cachedStore: SnapshotStore | null = null;

// ============================================
// 内部方法
// ============================================

function loadStore(): SnapshotStore {
    if (!resolvedFilePath) return {};
    try {
        const text = fs.readFileSync(resolvedFilePath, 'utf-8');
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) return {};
        cachedStore = parsed as SnapshotStore;
        return cachedStore;
    } catch {
        return {};
    }
}

async function saveStore(store: SnapshotStore): Promise<void> {
    if (!resolvedFilePath) return;
    await fs.promises.writeFile(resolvedFilePath, JSON.stringify(store, null, 2), 'utf-8');
    cachedStore = store;
}

// ============================================
// 公共接口
// ============================================

/**
 * 初始化快照存储文件。在 activate 阶段调用一次。
 */
export async function ensureSnapshotFile(context: vscode.ExtensionContext): Promise<string> {
    const dir = context.globalStorageUri.fsPath;
    const fp = path.join(dir, 'push-snapshots.json');
    resolvedFilePath = fp;
    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try { await fs.promises.access(fp, fs.constants.F_OK); }
        catch { await fs.promises.writeFile(fp, JSON.stringify({}), 'utf-8'); }
    } catch (err: any) {
        console.error('[SnapshotStore] 初始化失败:', err?.message || err);
    }
    return fp;
}

/**
 * 推送成功后保存文件快照（按 testcase_id 索引，排除 testCaseNo 列）。
 * - 若提供 pushedTsIds，则仅更新已推送行的快照，其他行保持旧基线不变。
 * - 若未提供 pushedTsIds（全量保存），则覆盖该文件的所有快照。
 * @param filePath    文件绝对路径
 * @param tableData   当前文件解析后的 { headers, rows }
 * @param pushedTsIds 本次推送成功的 testcase_id 集合（可选，用于增量更新）
 */
export async function savePushSnapshot(
    filePath: string,
    tableData: { headers: string[]; rows: any[][] },
    pushedTsIds?: Set<string>,
): Promise<void> {
    if (!filePath || !tableData) return;
    const store = loadStore();
    const headers = tableData.headers || [];
    const rows = tableData.rows || [];
    const tsIdIdx = headers.indexOf(TS_ID_COLUMN);
    if (tsIdIdx < 0) return;

    // 如果指定了推送行集合，则以旧快照为基准，只更新已推送行的快照
    // 未推送行保持旧基线，后续即便用户改回原值也能正确清空高亮
    const oldSnapshots = store[filePath] || {};
    const snapshots: RowSnapshots = pushedTsIds ? { ...oldSnapshots } : {};

    for (const row of rows) {
        const id = row[tsIdIdx] != null ? String(row[tsIdIdx]) : '';
        if (!id) continue;
        // 增量模式：只更新已推送的行，未推送行 skip（保留旧快照）
        if (pushedTsIds && !pushedTsIds.has(id)) continue;
        // 标准化行数据：以 headers 长度为准，防止 CSV 解析时尾随空字段导致长度不一致
        const cells = headers.map((_, i) => {
            const v = i < row.length ? row[i] : undefined;
            return v == null ? '' : String(v);
        });
        snapshots[id] = cells.join('\x00');
    }

    // 增量模式下，已删除行的快照保留不清理，等待显式同步后再清除
    // （参见 clearDeletedSnapshots / deletedRowsStore）

    store[filePath] = snapshots;
    await saveStore(store);
    const updatedCount = Object.keys(snapshots).length;
    console.log(`[SnapshotStore] 已保存推送快照: ${filePath} (${updatedCount} 行${pushedTsIds ? `，本次更新 ${pushedTsIds.size} 行` : ''})`);
}

/** 单行变更详情 */
export interface RowDiff {
    rowIndex: number;
    changedCols: number[];   // 该行中发生变化的列索引
}

/** 被删除行的快照信息（用于前端渲染 ghost 行） */
export interface DeletedRowInfo {
    tsId: string;
    cells: string[];         // 快照中的原始列值（排除 testCaseNo）
}

/** 新增行信息（快照中不存在但当前数据中出现的行） */
export interface AddedRowInfo {
    rowIndex: number;
    tsId: string;
}

/** diffPushSnapshot 的返回结果 */
export interface DiffResult {
    changed: RowDiff[];
    deletedInfos: DeletedRowInfo[];
    addedInfos: AddedRowInfo[];
}

/**
 * 用当前数据与推送快照做差异比对（均排除 testCaseNo 列）。
 * 同时检测快照中有但当前数据中已不存在的行（删除）。
 * 返回变更详情 + 删除列表；无快照或快照为空时返回 null。
 * @param filePath   文件绝对路径
 * @param tableData  当前文件解析后的 { headers, rows }
 * @returns 差异结果，或 null（无快照）
 */
export function diffPushSnapshot(
    filePath: string,
    tableData: { headers: string[]; rows: any[][] },
): DiffResult | null {
    if (!filePath || !tableData) return null;
    const store = cachedStore || loadStore();
    const snapshots = store[filePath];
    if (!snapshots || Object.keys(snapshots).length === 0) return null;

    const headers = tableData.headers || [];
    const rows = tableData.rows || [];
    const tsIdIdx = headers.indexOf(TS_ID_COLUMN);
    const tcIdx = headers.indexOf(TC_NO_COLUMN);
    if (tsIdIdx < 0) return null;

    const changed: RowDiff[] = [];
    const addedInfos: AddedRowInfo[] = [];
    const currIdSet = new Set<string>();
    rows.forEach((row, ri) => {
        const id = row[tsIdIdx] != null ? String(row[tsIdIdx]) : '';
        if (id) currIdSet.add(id);
        // 检测新增行：当前数据中有但快照中不存在的行
        if (id && !(id in snapshots)) {
            addedInfos.push({ rowIndex: ri, tsId: id });
            return;
        }
        if (!id) return;
        // 标准化行数据：以 headers 长度为准，与 savePushSnapshot 一致
        const cells = headers.map((_, i) => {
            if (i === tcIdx) return '';           // 排除 testCaseNo
            const v = i < row.length ? row[i] : undefined;
            return v == null ? '' : String(v);
        });
        const newSerialized = cells.join('\x00');
        // 标准化旧快照至 headers 长度，兼容旧格式（可能行尾有多余空字段）
        const oldCells = snapshots[id].split('\x00');
        // 兼容旧快照：旧快照可能保存了原始的 testCaseNo 值，标准化为 '' 以匹配当前排除逻辑
        if (tcIdx >= 0 && tcIdx < oldCells.length) {
            oldCells[tcIdx] = '';
        }
        const oldNormalized = oldCells.slice(0, headers.length).join('\x00');
        if (oldNormalized !== newSerialized) {
            // 逐列比对，只比对 cells 范围内的列，testCaseNo 列已在上面统一标准化为 ''，不会误判
            const changedCols: number[] = [];
            for (let ci = 0; ci < cells.length; ci++) {
                if (ci === tcIdx) continue;   // 双重保险：testCaseNo 列不参与差异标记
                const oldVal = ci < oldCells.length ? oldCells[ci] : '';
                if (oldVal !== cells[ci]) {
                    changedCols.push(ci);
                }
            }
            if (changedCols.length > 0) {
                changed.push({ rowIndex: ri, changedCols });
            }
        }
    });

    // 检测快照中有但当前数据中已不存在的行（删除）
    // 只有 testCaseNo 非空（即推送过的行）删除才记录到已删除行
    const deletedInfos: DeletedRowInfo[] = [];
    const snapshotIds = Object.keys(snapshots);
    for (const id of snapshotIds) {
        if (!currIdSet.has(id)) {
            const oldCells = snapshots[id].split('\x00');
            // 检查快照中 testCaseNo 列的值，为空说明未推送过，不记录
            const tcNo = tcIdx >= 0 && tcIdx < oldCells.length ? oldCells[tcIdx] : '';
            if (!tcNo) continue;
            deletedInfos.push({
                tsId: id,
                cells: oldCells,
            });
        }
    }

    return { changed, deletedInfos, addedInfos };
}

/**
 * 清除指定文件的推送快照。
 */
export async function clearPushSnapshot(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

/**
 * 获取指定文件中快照有但当前数据已无的 testcase_id 列表（已删除行）。
 * 用于查询待同步的删除行记录。
 * @param filePath   文件绝对路径
 * @param tableData  当前文件解析后的 { headers, rows }
 * @returns 已删除行的 DeletedRowInfo 列表，无删除返回空数组
 */
export function getDeletedSnapshotIds(
    filePath: string,
    tableData: { headers: string[]; rows: any[][] },
): DeletedRowInfo[] {
    if (!filePath || !tableData) return [];
    const store = cachedStore || loadStore();
    const snapshots = store[filePath];
    if (!snapshots || Object.keys(snapshots).length === 0) return [];

    const headers = tableData.headers || [];
    const rows = tableData.rows || [];
    const tsIdIdx = headers.indexOf(TS_ID_COLUMN);
    if (tsIdIdx < 0) return [];

    const currIdSet = new Set(rows.map(r => r[tsIdIdx] != null ? String(r[tsIdIdx]) : '').filter(Boolean));
    const deleted: DeletedRowInfo[] = [];
    for (const id of Object.keys(snapshots)) {
        if (!currIdSet.has(id)) {
            deleted.push({ tsId: id, cells: snapshots[id].split('\x00') });
        }
    }
    return deleted;
}

/**
 * 从快照中显式清除指定的已删除行（同步成功后调用）。
 * @param filePath 文件绝对路径
 * @param tsIds    要清除的 testcase_id 列表
 */
export async function clearDeletedSnapshots(filePath: string, tsIds: string[]): Promise<void> {
    if (!filePath || !tsIds || tsIds.length === 0) return;
    const store = loadStore();
    const snapshots = store[filePath];
    if (!snapshots) return;

    const removed: string[] = [];
    for (const id of tsIds) {
        if (id in snapshots) {
            delete snapshots[id];
            removed.push(id);
        }
    }
    if (removed.length === 0) return;

    if (Object.keys(snapshots).length === 0) {
        delete store[filePath];
    } else {
        store[filePath] = snapshots;
    }
    await saveStore(store);
    console.log(`[SnapshotStore] 已清除 ${removed.length} 行已删除快照: ${filePath}`);
}
