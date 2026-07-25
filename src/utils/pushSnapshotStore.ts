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
import { TelemetryService } from './telemetry';
import { stackHead } from '../services/utils';
import { getFailures } from './pushFailureStore';

// ============================================
// 常量
// ============================================

const TS_ID_COLUMN = 'testcase_id';
const TC_NO_COLUMN = 'testCaseNo';

// 样例行的 testcase_id 占位文案（与 fileIdentifier.ts 中 TEMPLATE_EXAMPLE_TS_ID 保持一致）。
// 说明：这些行不参与推送、也不应被 diff 判定为"新增行"，避免叠加绿色 xs-td-push-added 高亮。
//   - 中文长版：`案例唯一标识，不可修改`
//   - 中文短版：`案例唯一标识`
//   - 英文占位：`TESTCASE_ID`（插件自动填充/复制模板时的默认值，大小写不敏感）
const TEMPLATE_EXAMPLE_TS_ID = '案例唯一标识，不可修改';
const TEMPLATE_EXAMPLE_TS_ID_SHORT = '案例唯一标识';
const TESTCASE_ID_PLACEHOLDER = 'TESTCASE_ID';

/**
 * 判定 testcase_id 是否为"占位/样例文本"——凡此类 tsId 都不算用户新增行。
 * 与 fileIdentifier.isSampleTsId 语义对齐，但独立实现避免跨模块循环依赖。
 */
function isPlaceholderTsId(id: string): boolean {
    if (!id) return false;
    const t = id.trim();
    if (!t) return false;
    if (t === TEMPLATE_EXAMPLE_TS_ID || t === TEMPLATE_EXAMPLE_TS_ID_SHORT) return true;
    if (t.toUpperCase() === TESTCASE_ID_PLACEHOLDER) return true;
    return false;
}

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
let cachedMtimeMs = 0;

// ============================================
// 内部方法
// ============================================

/**
 * 读取并缓存快照数据。使用 mtime 校验，文件未变更时直接返回缓存，
 * 避免热路径（diff / save / init）每次读盘。同时统一多实例下读取策略：
 * 若一个窗口先走旧模式直读磁盘、另一个先走 cachedStore 优先，可能读到不一致基线。
 */
function loadStore(): SnapshotStore {
    if (!resolvedFilePath) return {};
    try {
        const stat = fs.statSync(resolvedFilePath);
        if (cachedStore && stat.mtimeMs === cachedMtimeMs) {
            return cachedStore;
        }
        const text = fs.readFileSync(resolvedFilePath, 'utf-8');
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) {
            // 快照文件格式异常（被外部篡改 / 捐坏），需上报便于定位绿色高亮误判类问题
            TelemetryService.sendTelemetryErrorEvent('snapshot.load.invalidFormat', {
                fileType: typeof parsed,
            });
            cachedStore = {};
        } else {
            cachedStore = parsed as SnapshotStore;
        }
        cachedMtimeMs = stat.mtimeMs;
        return cachedStore;
    } catch (err: any) {
        // ENOENT 属于正常初始态（activate 前首次调用），不上报
        if (err && err.code !== 'ENOENT') {
            // 快照读取 / 反序列化异常：上报以便反查 "diff 异常 / 高亮误判" 问题
            TelemetryService.sendTelemetryErrorEvent('snapshot.load.failed', {
                errorMessage: String(err?.message || String(err)).slice(0, 500),
                stackHead: stackHead(err),
            });
        }
        return {};
    }
}

async function saveStore(store: SnapshotStore): Promise<void> {
    if (!resolvedFilePath) return;
    try {
        await fs.promises.writeFile(resolvedFilePath, JSON.stringify(store, null, 2), 'utf-8');
        cachedStore = store;
        // 写完后同步刷新 mtime，避免紧接着的 loadStore 误判为"未变更"从而命中旧缓存
        try {
            const stat = fs.statSync(resolvedFilePath);
            cachedMtimeMs = stat.mtimeMs;
        } catch { /* ignore */ }
    } catch (err: any) {
        // 快照写入异常：磁盘 / 权限 / globalStorage 不可写。后续 diff 将不准确。
        TelemetryService.sendTelemetryErrorEvent('snapshot.save.failed', {
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
        TelemetryService.sendTelemetryErrorEvent('snapshot.init.failed', {
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
 *
 * ⚠️ pushedTsIds 增量模式已被弃用（当前无调用方使用，保留仅用于向后兼容 / 未来场景）：
 *   历史 bug —— 右键推送曾走增量模式仅覆盖成功行 tsId 的快照，导致
 *   「用户先编辑了失败行 → 触发推送 → 失败行的旧快照残留」，弹窗关闭后
 *   diff 拿"旧快照 vs 新磁盘"命中"1 行修改"，出现假阳性黄色高亮。
 *   现两条推送路径均改为全量刷新（等价于"用户认可当前磁盘状态为新基线"），
 *   失败行的红色高亮由 pushFailures 独立管理。
 *
 * @param filePath    文件绝对路径
 * @param tableData   当前文件解析后的 { headers, rows, detailTables? }
 * @param pushedTsIds 本次推送成功的 testcase_id 集合（@deprecated 详见上文）
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

    // 收集所有 detail 字段对应的主表列下标：主表签名中这些列一律置空，
    // 因为它们只承载展示态文本（'[N 项]' / 展开步骤合并文本），会随「展开/收起步骤」按钮切换而变化，
    // 属于纯 UI 状态，不代表实际数据变化；数据变化由 buildRowDetailSignature 独立捕获。
    const detailColIdxSetForSave = new Set<number>();
    if (Array.isArray(tableData.detailTables)) {
        for (const dt of tableData.detailTables) {
            if (dt && dt.field) {
                const ci = headers.indexOf(dt.field);
                if (ci >= 0) detailColIdxSetForSave.add(ci);
            }
        }
    }

    rows.forEach((row, rowIdx) => {
        const id = row[tsIdIdx] != null ? String(row[tsIdIdx]) : '';
        if (!id) return;
        // 样例/占位行（'案例唯一标识[，不可修改]' / 'TESTCASE_ID'）不参与推送，
        // 也就不应写入推送快照——否则后续 diff 会把用户修改样例文本判为「变化」触发黄色高亮，
        // 与「样例行仅显示样例灰底、不参与任何差异高亮」的产品语义相悖。
        if (isPlaceholderTsId(id)) return;
        // 增量模式：只更新已推送的行，未推送行 skip（保留旧快照）
        if (pushedTsIds && !pushedTsIds.has(id)) return;
        // 标准化行数据：以 headers 长度为准，防止 CSV 解析时尾随空字段导致长度不一致
        // detail 字段列一律置空，避免展开态展示文本进入基线
        const cells = headers.map((_, i) => {
            if (detailColIdxSetForSave.has(i)) return '';
            const v = i < row.length ? row[i] : undefined;
            return v == null ? '' : String(v);
        });
        // 附加明细表数据签名，确保嵌套对象/数组内部修改也能被 diff 检测
        const detailSig = buildRowDetailSignature(tableData, rowIdx);
        snapshots[id] = cells.join('\x00') + (detailSig ? DETAIL_SEP + detailSig : '');
    });

    // 兜底清理：历史遗留脏数据可能已把样例行的 tsId 写入快照。
    // 每次保存都顺手把这类残留剔除，避免长期存在导致 diff 一直误报。
    for (const key of Object.keys(snapshots)) {
        if (isPlaceholderTsId(key)) delete snapshots[key];
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
    // 统一走 loadStore()（内部已做 mtime 缓存校验），避免 cachedStore 直取导致
    // 多实例下读到其他窗口已写入前的旧缓存（隐患 γ）
    const store = loadStore();
    const snapshots = store[filePath];
    if (!snapshots || Object.keys(snapshots).length === 0) return null;

    const headers = tableData.headers || [];
    const rows = tableData.rows || [];
    const tsIdIdx = headers.indexOf(TS_ID_COLUMN);
    const tcIdx = headers.indexOf(TC_NO_COLUMN);
    if (tsIdIdx < 0) return null;

    // 加载当前文件的失败 tsId 集合。用于阻断"推送失败的新增行"再次被判定为新增行——
    // 否则前端会同时叠加红色（xs-tr-push-failed）与绿色（xs-td-push-added）高亮。
    const failuresMap = getFailures(filePath) || {};
    const hasFailedRecord = (id: string) => !!(id && Object.prototype.hasOwnProperty.call(failuresMap, id));

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
        // 样例/占位行不参与任何差异高亮：
        //   - 不作为 addedInfos（即使快照中不存在，也不算「新增行」）；
        //   - 不作为 changedRows（即使用户改了样例文本，也不显示黄色单元格高亮）；
        //   - 也不参与后续的删除判定（因为样例行永远不会被写入快照，见 savePushSnapshot）。
        // 与 fileIdentifier.isSampleTsId 的产品语义一致：样例行只显示样例灰底，其他高亮全部让位。
        //
        // 【例外】占位行 TESTCASE_ID 若已作为推送失败记录（hasFailedRecord），说明用户已
        // 尝试推送该行但被扩展端以「占位值」为由拒绝。此时该行在前端呈现为失败红底，
        // 用户修改内容后期待与真实 tsId 失败行一致的「改单元格黄 + 整行橙 + 失败红叠加」
        // 视觉反馈。若这里一刀切 return，会导致 session.highlightedCells 完全丢失，
        // 前端只剩淡红底，与真实失败行行为不一致（详见 019f9a03 诊断结论）。
        // 故仅对「不是失败行」的占位行 skip；已进入 failures 的占位行走完整 diff 流程。
        if (id && isPlaceholderTsId(id) && !hasFailedRecord(id)) return;
        // 检测新增行：当前数据中有但快照中不存在的行。
        // 防御 1：已有 testCaseNo 说明已被后端确认并推送过，即使快照中找不到（如快照损坏
        // 或 tsId 被意外重新生成），也不应被标为新增行，避免已推送案例被误标绿。
        // 防御 2：占位/样例行（testcase_id 为 '案例唯一标识[，不可修改]' 或 'TESTCASE_ID'）
        // 从语义上就不是"用户新增"的行，而是模板/占位数据，同样不应被标为新增行——
        // 否则会与 pushFailureStore 的红色失败标记叠加，造成红+绿双色高亮。
        // 防御 3：该 tsId 已存在推送失败记录（说明它是"已尝试推送但失败"，不是"未推送过的新增"），
        // 让红色失败标记独占，避免绿色新增高亮清不掉。用户手动修改数据后（触发去失败标记的
        // 用户流程），该行会重新参与新增判定。
        if (id && !(id in snapshots) && !tcNo && !isPlaceholderTsId(id) && !hasFailedRecord(id)) {
            addedInfos.push({ rowIndex: ri, tsId: id });
            return;
        }
        if (!id) return;

        // ---- 说明：失败行也参与 changedRows 判定 ----
        // 早期曾在此处加过一刀切「if (hasFailedRecord(id)) return;」以避免弹窗关闭后
        // 视觉错乱，但这与前端 02a-render.js 的时间戳竞争机制矛盾：
        //   - _highlightedTime（save 后打点）一般 >= rowFailTime（推送时打点），
        //     前端会以黄色（xs-td-push-updated）覆盖红底，符合"用户新的编辑意图应有反馈"；
        //   - 若时间反过来（推送晚于修改），前端会保留 xs-td-overrides-fail 让红底继续生效。
        // 因此不在扩展端 diff 阶段剔除失败行，让前端按时间戳自主竞争，避免"失败行改后
        // 无黄色高亮"的死角。

        // 1) 构建当前数据的主表单元格序列化
        //    - testCaseNo 列：排除（后端生成的编号不参与 diff）
        //    - detail 字段列：排除，避免「展开/收起步骤」按钮切换主表展示文本后误判为数据变化
        //      （真实明细变化由 detailSig 独立捕获，见步骤 4）
        const cells = headers.map((_, i) => {
            if (i === tcIdx) return '';
            if (detailColIdxByField.has(headers[i])) return '';
            const v = i < row.length ? row[i] : undefined;
            return v == null ? '' : String(v);
        });

        // 2) 解析旧快照
        // 防御：行有 testCaseNo（已推送过，不会被前面判定为新增）但快照中查不到 id 的极端情况
        // （快照损坏 / tsId 被重新生成等），跳过 diff 避免 oldRaw=undefined 触发 indexOf 崩溃。
        //
        // 【占位失败行例外】：TESTCASE_ID 从不写入 push 快照（savePushSnapshot 里 skip），
        // 但若它已进入 push failures（已尝试推送被拒），我们希望用户后续修改仍能得到
        // 「改单元格黄 + 整行橙 + 失败红叠加」的一致视觉反馈。此时使用「空快照基线」参与 diff：
        // 主表旧值一律空、明细旧签名为空，让当前非空 cell 全部被标为 changedCols。
        // 逻辑上等价于「首次推送前的空基线」，diff 结果自然纳入 changedRows 与 flatCells。
        const isPlaceholderFailedRow = id && isPlaceholderTsId(id) && hasFailedRecord(id);
        const oldRaw = snapshots[id];
        if (oldRaw == null && !isPlaceholderFailedRow) return;
        const _oldRawEffective = oldRaw != null ? oldRaw : '';
        const hasOldDetail = _oldRawEffective.indexOf(DETAIL_SEP) >= 0
            // 占位失败行使用空基线，但若当前行有 detailTables 则强制启用 detail 签名比对，
            // 让明细变化也能被检测为 changed（否则明细列改动被"仅比对主表"漏掉）。
            || (isPlaceholderFailedRow && !!detailTables && detailTables.length > 0);
        const oldMainPart = _oldRawEffective.indexOf(DETAIL_SEP) >= 0
            ? _oldRawEffective.split(DETAIL_SEP)[0]
            : _oldRawEffective;
        const oldDetailPart = _oldRawEffective.indexOf(DETAIL_SEP) >= 0
            ? _oldRawEffective.slice(oldMainPart.length + 1)
            : '';

        const oldCells = oldMainPart.split('\x00');
        // 兼容旧快照：旧快照可能保存了原始的 testCaseNo 值，标准化为 '' 以匹配当前排除逻辑
        if (tcIdx >= 0 && tcIdx < oldCells.length) {
            oldCells[tcIdx] = '';
        }
        // 兼容老基线：老版本快照的 detail 列写入了 '[N 项]' 展示文本，diff 时同样置空对齐
        for (let ci = 0; ci < oldCells.length && ci < headers.length; ci++) {
            if (detailColIdxByField.has(headers[ci])) oldCells[ci] = '';
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
                if (detailColIdxByField.has(headers[ci])) continue;
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
        // 防御历史脏快照：若快照里遗留样例行 tsId，也不判为「删除」，避免误绘幽灵行
        if (isPlaceholderTsId(id)) continue;
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
 * 删除指定文件的全部推送快照记录（文件被删除或主动清高亮时调用）。
 *
 * 历史上曾存在 clearPushSnapshot 同名重复函数（与本函数完全等价），已删除以避免多入口分岐。
 * 当前调用方：
 *   - workspaceListeners 监听到文件删除事件
 *   - clearHighlightHandler 用户主动清除高亮
 */
export async function removeSnapshotFile(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

/**
 * 清理已不存在的文件的孤儿推送快照记录。
 * 使用异步 fs.promises.access 替代同步 existsSync，避免大量文件时阻塞事件循环。
 */
export async function cleanupOrphanedSnapshots(): Promise<void> {
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
    // 统一走 loadStore()（内部已做 mtime 缓存校验）
    const store = loadStore();
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
