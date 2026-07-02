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
 *    - 对于嵌套对象/对象数组列（detail列），同时序列化 detailTables.rawRowGroups
 *      的真实数据，确保修改嵌套内容（非仅数量变化）时也能正确检测差异。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DetailTableData } from '../types';
import { sendTelemetryErrorEvent } from './telemetry';
import { stackHead } from '../services/utils';

// ============================================
// 常量
// ============================================

const TS_ID_COLUMN = 'testcase_id';
const TC_NO_COLUMN = 'testCaseNo';

// 样例行的 testcase_id 占位文案（与 fileIdentifier.ts 中 TEMPLATE_EXAMPLE_TS_ID 保持一致）。
// 样例行是创建测试案例文件时的模板示例行，仅用于明确表格结构，
// 不应参与推送，也不应被 diff 误判为"新增行"而高亮为绿色。
const TEMPLATE_EXAMPLE_TS_ID = '案例唯一标识，不可修改';

// 快照格式版本标记：\x01 分隔主表单元格序列化 与 明细数据签名。
// 旧格式快照不含 \x01，diffPushSnapshot 可据此做向后兼容处理。
const DETAIL_SEP = '\x01';   // 主表 / 明细分隔符
const ITEM_SEP = '\x02';     // 多个明细字段之间的分隔符

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
        if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) {
            // 快照文件格式异常（被外部篡改 / 捯坏），需上报便于定位绿色高亮误判类问题
            sendTelemetryErrorEvent('snapshot.load.invalidFormat', {
                fileType: typeof parsed,
            });
            return {};
        }
        cachedStore = parsed as SnapshotStore;
        return cachedStore;
    } catch (err: any) {
        // 快照读取 / 反序列化异常：上报以便反查 "diff 异常 / 高亮误判" 问题
            sendTelemetryErrorEvent('snapshot.load.failed', {
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
        return {};
    }
}

async function saveStore(store: SnapshotStore): Promise<void> {
    if (!resolvedFilePath) return;
    try {
        await fs.promises.writeFile(resolvedFilePath, JSON.stringify(store, null, 2), 'utf-8');
        cachedStore = store;
    } catch (err: any) {
        // 快照写入异常：磁盘 / 权限 / globalStorage 不可写。后续 diff 将不准确。
        sendTelemetryErrorEvent('snapshot.save.failed', {
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
        // 内存缓存仍保持新值，避免在同一会话内反复失败
        cachedStore = store;
    }
}

// ============================================
// 明细数据签名
// ============================================

/**
 * 为指定行的明细表数据生成签名，用于纳入快照比对。
 * 仅序列化 rawRowGroups（前端 v2 弹窗写入的真实结构），不依赖 rowGroups（字符串展示用）。
 *
 * @param tableData  当前表格数据（含 detailTables）
 * @param rowIdx     行索引
 * @returns 明细签名串（可能为空字符串）
 */
function buildRowDetailSignature(
    tableData: { headers: string[]; rows: any[][]; detailTables?: DetailTableData[] },
    rowIdx: number,
): string {
    const detailTables = tableData.detailTables;
    if (!detailTables || !Array.isArray(detailTables) || detailTables.length === 0) return '';
    const parts: string[] = [];
    for (const dt of detailTables) {
        if (!dt || !dt.field) continue;
        const raw = dt.rawRowGroups && dt.rawRowGroups[rowIdx];
        if (!raw || raw.length === 0) continue;
        // 使用 JSON.stringify 保留完整结构信息；对象数组 / 嵌套对象均可区分
        try {
            parts.push(dt.field + '=' + JSON.stringify(raw));
        } catch { /* 序列化失败则跳过该字段，不阻塞整体流程 */ }
    }
    return parts.join(ITEM_SEP);
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
        sendTelemetryErrorEvent('snapshot.init.failed', {
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
    }
    return fp;
}

/**
 * 推送成功后保存文件快照（按 testcase_id 索引，排除 testCaseNo 列）。
 * - 若提供 pushedTsIds，则仅更新已推送行的快照，其他行保持旧基线不变。
 * - 若未提供 pushedTsIds（全量保存），则覆盖该文件的所有快照。
 * - 明细表数据（detailTables.rawRowGroups）也纳入快照，确保嵌套对象/数组内容变化可被 diff 检测。
 * @param filePath    文件绝对路径
 * @param tableData   当前文件解析后的 { headers, rows, detailTables? }
 * @param pushedTsIds 本次推送成功的 testcase_id 集合（可选，用于增量更新）
 */
export async function savePushSnapshot(
    filePath: string,
    tableData: { headers: string[]; rows: any[][]; detailTables?: DetailTableData[] },
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

    rows.forEach((row, rowIdx) => {
        const id = row[tsIdIdx] != null ? String(row[tsIdIdx]) : '';
        if (!id) return;
        // 增量模式：只更新已推送的行，未推送行 skip（保留旧快照）
        if (pushedTsIds && !pushedTsIds.has(id)) return;
        // 标准化行数据：以 headers 长度为准，防止 CSV 解析时尾随空字段导致长度不一致
        const cells = headers.map((_, i) => {
            const v = i < row.length ? row[i] : undefined;
            return v == null ? '' : String(v);
        });
        // 附加明细表数据签名，确保嵌套对象/数组内部修改也能被 diff 检测
        const detailSig = buildRowDetailSignature(tableData, rowIdx);
        snapshots[id] = cells.join('\x00') + (detailSig ? DETAIL_SEP + detailSig : '');
    });

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
 *
 * 关于明细表（detailTables）的差异检测：
 * - 新格式快照包含 \x01 分隔的明细签名，可直接比对主表 + 明细两部分。
 * - 旧格式快照（无 \x01）只比对主表单元格串；明细内容变化不会触发误报，
 *   但下一次推送后将自动升级为新格式。
 * @param filePath   文件绝对路径
 * @param tableData  当前文件解析后的 { headers, rows, detailTables? }
 * @returns 差异结果，或 null（无快照）
 */
export function diffPushSnapshot(
    filePath: string,
    tableData: { headers: string[]; rows: any[][]; detailTables?: DetailTableData[] },
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

    // 构建 detail field → colIdx 快速索引
    const detailColIdxByField = new Map<string, number>();
    const detailTables = tableData.detailTables;
    if (detailTables && Array.isArray(detailTables)) {
        for (const dt of detailTables) {
            if (dt && dt.field) {
                const ci = headers.indexOf(dt.field);
                if (ci >= 0) detailColIdxByField.set(dt.field, ci);
            }
        }
    }

    const changed: RowDiff[] = [];
    const addedInfos: AddedRowInfo[] = [];
    const currIdSet = new Set<string>();
    rows.forEach((row, ri) => {
        const id = row[tsIdIdx] != null ? String(row[tsIdIdx]) : '';
        const tcNo = tcIdx >= 0 && row[tcIdx] != null ? String(row[tcIdx]) : '';
        if (id) currIdSet.add(id);
        // 检测新增行：当前数据中有但快照中不存在的行。
        // 防御 1：已有 testCaseNo 说明已被后端确认并推送过，即使快照中找不到（如快照损坏
        // 或 tsId 被意外重新生成），也不应被标为新增行，避免已推送案例被误标绿。
        // 防御 2：样例行（testcase_id 为占位文案）从语义上就不是"用户新增"的行，而是文件创建时的
        // 模板示例，同样不应被标为新增行（它也不会参与推送，快照中不会有其记录）。
        if (id && !(id in snapshots) && !tcNo && id.trim() !== TEMPLATE_EXAMPLE_TS_ID) {
            addedInfos.push({ rowIndex: ri, tsId: id });
            return;
        }
        if (!id) return;

        // 1) 构建当前数据的主表单元格序列化
        const cells = headers.map((_, i) => {
            if (i === tcIdx) return '';           // 排除 testCaseNo
            const v = i < row.length ? row[i] : undefined;
            return v == null ? '' : String(v);
        });

        // 2) 解析旧快照
        // 防御：行有 testCaseNo（已推送过，不会被前面判定为新增）但快照中查不到 id 的极端情况
        // （快照损坏 / tsId 被重新生成等），跳过 diff 避免 oldRaw=undefined 触发 indexOf 崩溃。
        const oldRaw = snapshots[id];
        if (oldRaw == null) return;
        const hasOldDetail = oldRaw.indexOf(DETAIL_SEP) >= 0;
        const oldMainPart = hasOldDetail ? oldRaw.split(DETAIL_SEP)[0] : oldRaw;
        const oldDetailPart = hasOldDetail ? oldRaw.slice(oldMainPart.length + 1) : '';

        const oldCells = oldMainPart.split('\x00');
        // 兼容旧快照：旧快照可能保存了原始的 testCaseNo 值，标准化为 '' 以匹配当前排除逻辑
        if (tcIdx >= 0 && tcIdx < oldCells.length) {
            oldCells[tcIdx] = '';
        }
        const oldMainNormalized = oldCells.slice(0, headers.length).join('\x00');

        // 3) 对比主表单元格
        const newMainSerialized = cells.join('\x00');
        let mainChanged = false;
        const changedCols: number[] = [];

        if (oldMainNormalized !== newMainSerialized) {
            mainChanged = true;
            for (let ci = 0; ci < cells.length; ci++) {
                if (ci === tcIdx) continue;
                const oldVal = ci < oldCells.length ? oldCells[ci] : '';
                if (oldVal !== cells[ci]) {
                    changedCols.push(ci);
                }
            }
        }

        // 4) 对比明细数据（仅当旧快照也包含明细签名时才比对，保证向后兼容）
        // 逐字段独立比对：将新旧明细签名按 \\x02 拆分为 field=sig 映射，
        // 仅标记实际变化的明细列，避免所有嵌套对象列被误标记。
        if (hasOldDetail && detailTables && detailTables.length > 0) {
            const newDetailSig = buildRowDetailSignature(tableData, ri);
            // 按 \\x02 逐字段拆分新旧签名
            const parseFieldSigs = (raw: string): Map<string, string> => {
                const m = new Map<string, string>();
                if (!raw) return m;
                const items = raw.split(ITEM_SEP);
                for (const item of items) {
                    const eqIdx = item.indexOf('=');
                    if (eqIdx > 0) m.set(item.slice(0, eqIdx), item.slice(eqIdx + 1));
                }
                return m;
            };
            const oldFieldSigs = parseFieldSigs(oldDetailPart);
            const newFieldSigs = parseFieldSigs(newDetailSig);

            for (const dt of detailTables) {
                if (!dt || !dt.field) continue;
                const ci = detailColIdxByField.get(dt.field);
                if (ci === undefined || ci === tcIdx) continue;
                const oldSig = oldFieldSigs.get(dt.field) || '';
                const newSig = newFieldSigs.get(dt.field) || '';
                if (oldSig !== newSig) {
                    if (changedCols.indexOf(ci) < 0) {
                        changedCols.push(ci);
                    }
                }
            }
            // 明细列变化时也认为该行有变化（即使主表显示摘要未变）
            if (!mainChanged && changedCols.length > 0) {
                mainChanged = true;
            }
        }

        if (mainChanged && changedCols.length > 0) {
            changed.push({ rowIndex: ri, changedCols });
        }
    });

    // 检测快照中有但当前数据中已不存在的行（删除）
    // 只有 testCaseNo 非空（即推送过的行）删除才记录到已删除行
    const deletedInfos: DeletedRowInfo[] = [];
    const snapshotIds = Object.keys(snapshots);
    for (const id of snapshotIds) {
        if (!currIdSet.has(id)) {
            // 新旧格式兼容：先剥离明细签名再取主表单元格，避免末项混入 \x01 后缀
            const raw = snapshots[id];
            const mainPart = raw.indexOf(DETAIL_SEP) >= 0 ? raw.split(DETAIL_SEP)[0] : raw;
            const oldCells = mainPart.split('\x00');
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
/**
 * 删除指定文件的全部推送快照记录（文件被删除时调用）。
 */
export async function removeSnapshotFile(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

export async function clearPushSnapshot(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

/**
 * 清理已不存在的文件的孤儿推送快照记录。
 */
export async function cleanupOrphanedSnapshots(): Promise<void> {
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
            // 新旧格式兼容：先剥离明细签名再取主表单元格
            const raw = snapshots[id];
            const mainPart = raw.indexOf(DETAIL_SEP) >= 0 ? raw.split(DETAIL_SEP)[0] : raw;
            deleted.push({ tsId: id, cells: mainPart.split('\x00') });
        }
    }
    return deleted;
}

/**
 * 升级旧格式快照（无明细签名）为包含明细签名的新格式。
 * 仅追加明细签名部分，不修改主表单元格基线，保持"与推送基线的差异"语义不变。
 *
 * 使用场景：
 *  - webview 保存后：当前数据已包含 detailTables，可将明细基线注入快照。
 *  - init / 外部变更刷新后：检测到差异的同时注入明细基线，使后续刷新能正确比对。
 *
 * @param filePath    文件绝对路径
 * @param tableData   当前表格数据（含 detailTables.rawRowGroups）
 * @param tsIds       要升级的 testcase_id 集合（仅升级这些行，避免大范围修改）
 */
export async function upgradeSnapshotDetail(
    filePath: string,
    tableData: { headers: string[]; rows: any[][]; detailTables?: DetailTableData[] },
    tsIds: Set<string>,
): Promise<void> {
    if (!filePath || !tableData || !tsIds || tsIds.size === 0) return;
    const detailTables = tableData.detailTables;
    if (!detailTables || !Array.isArray(detailTables) || detailTables.length === 0) return;
    const store = loadStore();
    const snapshots = store[filePath];
    if (!snapshots || Object.keys(snapshots).length === 0) return;
    const headers = tableData.headers || [];
    const rows = tableData.rows || [];
    const tsIdIdx = headers.indexOf(TS_ID_COLUMN);
    if (tsIdIdx < 0) return;

    let updated = 0;
    rows.forEach((row, rowIdx) => {
        const id = row[tsIdIdx] != null ? String(row[tsIdIdx]) : '';
        if (!id || !tsIds.has(id)) return;
        const entry = snapshots[id];
        if (!entry) return;
        // 仅升级不含 DETAIL_SEP 的旧格式行
        if (entry.indexOf(DETAIL_SEP) >= 0) return;
        const newSig = buildRowDetailSignature(tableData, rowIdx);
        if (!newSig) return;
        snapshots[id] = entry + DETAIL_SEP + newSig;
        updated++;
    });

    if (updated > 0) {
        store[filePath] = snapshots;
        await saveStore(store);
        console.log(`[SnapshotStore] 已注入明细签名: ${filePath} (${updated} 行)`);
    }
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
