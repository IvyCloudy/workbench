/**
 * ============================================================================
 *  utils/pointCaseDeleter.ts
 *  测试要点 → 关联测试案例 删除公共方法
 * ----------------------------------------------------------------------------
 *  职责：
 *    根据测试要点信息（pointId / pointPath / pointName），复用「查看关联案例」
 *    的匹配引擎（pointCaseLinker），把该要点在其绑定案例文件中命中的所有案例
 *    从磁盘删除，并同步维护 push-snapshot / deletedRowsStore / highlightStore
 *    等追踪存储，避免出现"幽灵行"。
 *
 *  入参说明：
 *    pointFilePath —— 测试要点文件的绝对路径，通用参数，支持 md / xmind
 *      及未来任意受 pointCaseBindingStore 支持的要点文件类型。绑定查询通过
 *      getCaseOfPoint(pointFilePath) 统一完成，方法内部不区分具体扩展名。
 *
 *  语义对齐（与 pointCaseLinker 的合约保持完全一致）：
 *    1. 匹配 type 与 linker 相同（type=1 parent_id+path / type=2 仅 path
 *       / type=3 仅 parent_id）
 *    2. pointName **不参与匹配**（仅承载分组/日志/回显），删除场景的入参
 *       约束为 pointId 与 pointPath 至少一个非空；仅传 pointName 抛错。
 *    3. **pointPath 语义与「查看关联案例」完全一致**：调用方传入的 pointPath
 *       必须是「完整路径」——即由「功能条目前缀 + '/' + pointName」组成的
 *       末段包含 pointName 的全路径。示例：
 *         · md：功能条目「账户中心/登录模块」+ 测试点「二次校验」
 *           → pointPath = "账户中心/登录模块/二次校验"
 *         · xmind：祖先 flag/star 链 → 测试点自身节点名作为末段
 *       deleter 内部**不会**再用 pointName 自动补齐或截断 pointPath；
 *       如需按父级前缀模糊删除，请自行在调用层做扩展，不要靠传"半截路径"。
 *    4. 匹配到 0 条：不写盘、不报错，返回 deletedCount: 0。
 *
 *  设计要点：
 *    - 使用 withFileLock 对案例文件路径加锁，与 writeBackTestCaseNos 共用
 *      同一把锁，避免"推送回写"与"删除"并发覆盖。
 *    - 删除会同步剔除 tableData.rows / sourceData / detailTables.rowGroups
 *      / rawRowGroups / rawRowTypes（按主行索引对齐）。
 *    - 删除后调用 clearLinkerCache() 使 linker 内存缓存失效，避免下次匹配
 *      拿到已删除记录的旧快照。
 *
 *  埋点（TelemetryService）：
 *    · pointCaseDeleter.done   —— 每次调用（无论是否命中）都会上报，字段包含
 *      测试任务维度（testTaskNo/subTestTaskId/artifactId）、要点维度
 *      （pointId/pointName/pointPath）、案例维度（fileExt/deletedCount/
 *      totalRecords/type1/type2/type3）以及 costMs。
 *    · pointCaseDeleter.error  —— 抛异常路径统一上报，包含 errorMessage/
 *      stackHead + taskInfo/point 上下文，便于线上定位。
 *    · taskInfo 由调用方通过入参传入（Q2-a 决策），deleter 不主动查绑定。
 * ============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';

import type { TableData, DetailTableData } from '../types';
import { detectFileType, createParser } from '../parsers';
import {
    normalizePointPath,
    clearLinkerCache,
    type PointItem,
} from './pointCaseLinker';
import { getCaseOfPoint } from './pointCaseBindingStore';
import { savePushSnapshot } from './pushSnapshotStore';
import { markDeletedRows } from './deletedRowsStore';
import { clearHighlight } from './highlightStore';
import { withFileLock } from './asyncLock';
import { createLogger } from './logger';
import { TS_ID_COLUMN } from '../services/utils';
import { TelemetryService } from './telemetry';
import { stackHead } from '../services/utils';

const logger = createLogger('pcDeleter');

// ============================================================================
// 埋点：事件名常量（集中维护，避免拼写发散）
// ============================================================================
const EVT_DONE = 'pointCaseDeleter.done';
const EVT_ERROR = 'pointCaseDeleter.error';

/**
 * 埋点用的错误字段构造（内联版，不引 extensionHelpers 是为了避免 deleter
 * 依赖 vscode 相关模块，保持单测友好）。
 */
function deleterErrProps(err: any, extras?: Record<string, string>): Record<string, string> {
    return {
        errorMessage: String(err?.message || String(err)).slice(0, 500),
        stackHead: stackHead(err),
        ...(extras || {}),
    };
}

// ============================================================================
// 类型
// ============================================================================

/** 删除入参：pointId 与 pointPath 至少一个非空；pointName 仅用于日志/分组 */
export interface DeleteCasesByPointInput {
    /** 测试要点 ID（可空，但不能与 pointPath 同时为空） */
    pointId?: string;
    /**
     * 测试要点 path（可空，但不能与 pointId 同时为空）。
     *
     * **必须是完整路径**：由「功能条目前缀 + '/' + pointName」组成，
     * 末段包含 pointName（与「查看关联案例」链路对 pointPath 的约定完全一致）。
     * deleter 内部不会用 pointName 自动补齐或截断此值。
     */
    pointPath?: string;
    /** 测试要点名称（可空）——仅用于日志/分组，不参与匹配 */
    pointName?: string;
}

/**
 * 测试任务上下文（可选）——仅用于埋点，不参与业务逻辑。
 *
 * 由调用方（例如 handler / provider）在自己的上下文里查得后传入。
 * deleter 内部不主动反查任务绑定，保持模块解耦与单测友好。
 */
export interface DeleteCasesTaskInfo {
    /** 测试任务编号 */
    testTaskNo?: string;
    /** 子任务 ID */
    subTestTaskId?: string;
    /** 产出物 ID（一般 = 案例文件 basename，可缺省，缺省时 deleter 会用 basename 兜底） */
    artifactId?: string;
}

/** 被删除的单条案例摘要 */
export interface DeletedCaseItem {
    /** 案例 testcase_id（主键） */
    testcaseId: string;
    /** 案例名称（案例文件 name 字段的值） */
    caseName: string;
}

/** 删除结果 */
export interface DeleteCasesByPointResult {
    /** 案例文件绝对路径 */
    filePath: string;
    /** 被删除的案例列表（顺序为磁盘中出现顺序） */
    deletedCases: DeletedCaseItem[];
    /** 被删除的行数（== deletedCases.length） */
    deletedCount: number;
    /** 匹配类型分档（诊断用） */
    typeCount: { type1: number; type2: number; type3: number };
    /** 案例文件原总行数 */
    totalRecords: number;
    /** 删除后剩余行数 */
    remainingRecords: number;
    /** 端到端耗时(ms)——不上报埋点，仅返回给调用方 */
    costMs: number;
}

/** 内部字段名（与 pointCaseLinker 默认字段保持一致） */
const CASE_ID_FIELD = 'testcase_id';
const CASE_NAME_FIELD = 'name';
const PARENT_ID_FIELD = 'parent_id';
const PATH_FIELD = 'path';

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 【公共方法】根据测试要点信息删除其关联的所有测试案例。
 *
 * @param pointFilePath  测试要点文件绝对路径（通用参数，支持 md / xmind
 *                       及其他任何受 pointCaseBindingStore 支持的类型），
 *                       用于查绑定得到案例文件
 * @param point          { pointId?, pointPath?, pointName? }；pointId 与
 *                       pointPath 至少一个非空，仅传 pointName 会抛错
 * @param taskInfo       可选，测试任务上下文（testTaskNo / subTestTaskId /
 *                       artifactId），仅用于埋点，不参与匹配逻辑
 *
 * @throws
 *   - 入参非法（pointId 与 pointPath 均为空）
 *   - pointFilePath 未绑定任何案例文件
 *   - 案例文件不存在 / 类型不支持
 *   - 文件解析或保存失败
 */
export async function deleteCasesByPoint(
    pointFilePath: string,
    point: DeleteCasesByPointInput,
    taskInfo?: DeleteCasesTaskInfo,
): Promise<DeleteCasesByPointResult> {
    // 埋点上下文的规范化 —— 全部转为 string，缺省用 ''
    const tInfo: Required<DeleteCasesTaskInfo> = {
        testTaskNo: (taskInfo?.testTaskNo ?? '').toString(),
        subTestTaskId: (taskInfo?.subTestTaskId ?? '').toString(),
        artifactId: (taskInfo?.artifactId ?? '').toString(),
    };

    // ---- 1) 入参校验 ----
    if (!pointFilePath || typeof pointFilePath !== 'string') {
        const err = new Error('deleteCasesByPoint: pointFilePath 不能为空');
        emitErrorTelemetry(err, tInfo, point, '');
        throw err;
    }
    if (!point || typeof point !== 'object') {
        const err = new Error('deleteCasesByPoint: point 参数不能为空');
        emitErrorTelemetry(err, tInfo, point, '');
        throw err;
    }
    const pid = (point.pointId ?? '').toString().trim();
    const ppath = (point.pointPath ?? '').toString().trim();
    if (!pid && !ppath) {
        // 仅传 pointName 也会命中此分支——按需求"仅传 pointName 报错"
        const err = new Error('deleteCasesByPoint: pointId 与 pointPath 至少一个非空');
        emitErrorTelemetry(err, tInfo, point, '');
        throw err;
    }

    // ---- 2) 查绑定 → 案例文件路径 ----
    const casePath = getCaseOfPoint(pointFilePath);
    if (!casePath) {
        const err = new Error(`deleteCasesByPoint: 测试要点未绑定案例文件 (${pointFilePath})`);
        emitErrorTelemetry(err, tInfo, point, '');
        throw err;
    }
    if (!fs.existsSync(casePath)) {
        const err = new Error(`deleteCasesByPoint: 案例文件不存在 (${casePath})`);
        emitErrorTelemetry(err, tInfo, point, casePath);
        throw err;
    }

    // ---- 3) 加锁进入临界区（与 writeBackTestCaseNos 共用同一把锁） ----
    return withFileLock(casePath, async () => {
        try {
            const result = await deleteCasesFromCaseFile(casePath, {
                pointId: pid,
                pointPath: ppath,
                pointName: (point.pointName ?? '').toString(),
            });
            emitDoneTelemetry(result, tInfo, {
                pointId: pid, pointPath: ppath,
                pointName: (point.pointName ?? '').toString(),
            });
            return result;
        } catch (err) {
            emitErrorTelemetry(err, tInfo, point, casePath);
            throw err;
        }
    });
}

// ============================================================================
// 内部实现（可直接被单元测试调用，跳过 pointFilePath 绑定层）
// ============================================================================

/**
 * 【内部】直接对案例文件执行删除。已在锁内，不再加锁。
 * 单元测试可通过 __test_only__ 命名空间访问，避免测试环境依赖 vscode.workspace
 * （跳过要点文件 → 案例文件的绑定查询层，直接以案例文件绝对路径作为入口）。
 */
async function deleteCasesFromCaseFile(
    casePath: string,
    point: Required<DeleteCasesByPointInput>,
): Promise<DeleteCasesByPointResult> {
    const t0 = Date.now();

    // ---- 3.1) 解析文件 ----
    const fileType = detectFileType(casePath);
    if (!fileType) {
        throw new Error(`deleteCasesByPoint: 不支持的文件类型 (${casePath})`);
    }
    const parser = createParser(fileType);
    const parsed = await parser.parse(casePath);
    const tableData = parsed.tableData;
    const sourceData = parsed.sourceData;

    const headers = tableData?.headers || [];
    const rows = tableData?.rows || [];
    const totalRecords = rows.length;

    // ---- 3.2) 在 tableData 上就地匹配（不依赖 linker 缓存，避免拿旧快照） ----
    //   语义与 pointCaseLinker.matchCore 完全对齐：
    //     type=1 parent_id 命中 且 path 归一化相等
    //     type=2 仅 path 归一化相等（parent_id 未命中）
    //     type=3 仅 parent_id 命中
    const tsIdIdx = headers.indexOf(TS_ID_COLUMN);
    const caseIdIdx = tsIdIdx >= 0 ? tsIdIdx : headers.indexOf(CASE_ID_FIELD);
    const nameIdx = headers.indexOf(CASE_NAME_FIELD);
    const parentIdIdx = headers.indexOf(PARENT_ID_FIELD);
    const pathIdx = headers.indexOf(PATH_FIELD);

    const nTargetPath = normalizePointPath(point.pointPath);
    const targetPid = point.pointId;

    /** 要删除的主行下标集合（有序） */
    const deletedRowIdxSet = new Set<number>();
    /** 被删除案例的摘要（顺序为磁盘中出现顺序） */
    const deletedCases: DeletedCaseItem[] = [];
    const typeCount = { type1: 0, type2: 0, type3: 0 };

    for (let i = 0; i < rows.length; i++) {
        // 优先从 sourceData 取原始字段（能命中嵌套结构里的 parent_id/path），
        // 若无 sourceData（csv 场景）再从 rows 按列下标取
        const rec = getRecordFromRow(sourceData, rows[i], i, headers, {
            parentIdIdx, pathIdx, caseIdIdx, nameIdx,
        });

        const matchType = matchType_(rec, targetPid, nTargetPath);
        if (matchType == null) continue;

        deletedRowIdxSet.add(i);
        const tid = readField(rec, CASE_ID_FIELD, rows[i], caseIdIdx);
        const cname = readField(rec, CASE_NAME_FIELD, rows[i], nameIdx);
        deletedCases.push({
            testcaseId: String(tid ?? '').trim(),
            caseName: String(cname ?? '').trim(),
        });
        if (matchType === 1) typeCount.type1++;
        else if (matchType === 2) typeCount.type2++;
        else typeCount.type3++;
    }

    // ---- 3.3) 命中 0 条：直接返回，不写盘不刷 snapshot ----
    if (deletedRowIdxSet.size === 0) {
        return {
            filePath: casePath,
            deletedCases: [],
            deletedCount: 0,
            typeCount,
            totalRecords,
            remainingRecords: totalRecords,
            costMs: Date.now() - t0,
        };
    }

    // ---- 3.4) 按主行索引同步剔除 rows / sourceData / detailTables ----
    applyRemoveByIndices(tableData, sourceData, deletedRowIdxSet);

    // ---- 3.5) 落盘 ----
    await parser.save(casePath, tableData, sourceData);

    // ---- 3.6) 同步追踪存储 ----
    //   ① push-snapshot 全量刷新（等价于用户认可当前磁盘为新基线）
    try {
        await savePushSnapshot(casePath, tableData);
    } catch (err: any) {
        logger.warn('savePushSnapshot 失败（不影响删除主流程）', err?.message);
    }

    //   ② deletedRowsStore：把删除行记为「待同步到线上」
    //      简化策略：把所有有 tsId 的删除行都记入（markDeletedRows 幂等，
    //      不存在于线上的行由后续 sync 流程自然筛除）
    try {
        const ids = deletedCases.map(c => c.testcaseId).filter(Boolean);
        if (ids.length > 0) await markDeletedRows(casePath, ids);
    } catch (err: any) {
        logger.warn('markDeletedRows 失败（不影响删除主流程）', err?.message);
    }

    //   ③ 清高亮：删除行的高亮索引已失效，简单起见清整个文件的高亮
    //      （与 clearHighlight 语义一致：高亮是"最近一次编辑/推送"的临时态）
    try {
        await clearHighlight(casePath);
    } catch (err: any) {
        logger.warn('clearHighlight 失败（不影响删除主流程）', err?.message);
    }

    //   ④ 失效 linker 缓存（下次匹配拿磁盘最新记录）
    try {
        clearLinkerCache();
    } catch { /* ignore */ }

    logger.info('deleteCasesByPoint done', {
        casePath: path.basename(casePath),
        pointId: point.pointId,
        pointPath: point.pointPath,
        deletedCount: deletedCases.length,
        typeCount,
    });

    return {
        filePath: casePath,
        deletedCases,
        deletedCount: deletedCases.length,
        typeCount,
        totalRecords,
        remainingRecords: totalRecords - deletedCases.length,
        costMs: Date.now() - t0,
    };
}

// ============================================================================
// 匹配语义（与 pointCaseLinker.matchCore 对齐的简化版：单点 + 单文件）
// ============================================================================

/**
 * 判断单条 record 是否命中给定点，返回匹配 type；未命中返回 null。
 *
 * 单点单文件场景无需 pointCaseLinker 的多点索引；直接按 rec 里的
 * parent_id / path 与 targetPid / targetPath 逐一比较：
 *   - 若 targetPid 提供：先尝试原值命中，再尝试尾号 -N 剥离 fallback
 *   - 命中 pid 后若 targetPath 提供且与 recPath 归一化相等 → type=1
 *     否则 → type=3
 *   - 若 targetPid 未命中但 targetPath 与 recPath 归一化相等 → type=2
 */
function matchType_(
    rec: any,
    targetPid: string,
    nTargetPath: string,
): 1 | 2 | 3 | null {
    if (!rec || typeof rec !== 'object') return null;

    const nRecPath = normalizePointPath(rec[PATH_FIELD]);
    const recPids = normalizeParentIds_(rec[PARENT_ID_FIELD]);

    // 1) parent_id 命中路径
    let pidHit = false;
    if (targetPid) {
        for (const raw of recPids) {
            if (raw === targetPid) { pidHit = true; break; }
            // fallback：剥离末尾 -N
            const stripped = raw.replace(/-\d+$/, '');
            if (stripped && stripped === targetPid) { pidHit = true; break; }
        }
    }

    if (pidHit) {
        if (nTargetPath && nRecPath && nTargetPath === nRecPath) return 1;
        return 3;
    }

    // 2) 仅 path 兜底命中
    if (nTargetPath && nRecPath && nTargetPath === nRecPath) return 2;

    return null;
}

/** normalizeParentIds 的本地简版（与 pointCaseLinker.normalizeParentIds 语义等价） */
function normalizeParentIds_(v: any): string[] {
    if (v == null) return [];
    if (Array.isArray(v)) {
        return v.map(x => (x == null ? '' : String(x).trim())).filter(Boolean);
    }
    return String(v).split(/[,;，；]/).map(s => s.trim()).filter(Boolean);
}

// ============================================================================
// 数据剔除
// ============================================================================

/**
 * 从 record 或 row 中取字段值：
 *   - sourceData 存在 → 用 rec[field]（能拿到嵌套原始类型）
 *   - 否则从 rows[idx][colIdx] 取
 */
function readField(rec: any, field: string, row: any[], colIdx: number): any {
    if (rec && typeof rec === 'object' && rec[field] !== undefined) {
        return rec[field];
    }
    if (colIdx >= 0 && Array.isArray(row)) return row[colIdx];
    return '';
}

/**
 * 从 sourceData / rows 组合出用于匹配的 record 视图。
 *   - YAML/JSON：sourceData 是数组，直接取 sourceData[i]
 *   - CSV：sourceData 通常为 null / 非数组，用 rows[i] 按 headers 组装
 */
function getRecordFromRow(
    sourceData: any,
    row: any[],
    idx: number,
    headers: string[],
    idxHint: { parentIdIdx: number; pathIdx: number; caseIdIdx: number; nameIdx: number },
): any {
    if (Array.isArray(sourceData) && sourceData[idx] && typeof sourceData[idx] === 'object') {
        return sourceData[idx];
    }
    // 回退：按 headers 建立字段视图
    const rec: any = {};
    for (let c = 0; c < headers.length; c++) {
        rec[headers[c]] = row?.[c];
    }
    // idxHint 仅在 headers 命中不到常规字段名时的双保险（一般用不到）
    void idxHint;
    return rec;
}

/**
 * 按主行索引集合，同步从 tableData / sourceData / detailTables 剔除。
 * 从后往前删，避免下标漂移。
 */
function applyRemoveByIndices(
    tableData: TableData,
    sourceData: any,
    removeIdxSet: Set<number>,
): void {
    if (!tableData || !Array.isArray(tableData.rows) || removeIdxSet.size === 0) return;

    // 排序（降序），保证从后往前删
    const idxSorted = Array.from(removeIdxSet).sort((a, b) => b - a);

    for (const i of idxSorted) {
        // 1) 主表 rows
        if (i >= 0 && i < tableData.rows.length) tableData.rows.splice(i, 1);
        // 2) sourceData（数组场景）
        if (Array.isArray(sourceData) && i >= 0 && i < sourceData.length) {
            sourceData.splice(i, 1);
        }
        // 3) 所有明细表：rowGroups / rawRowGroups / rawRowTypes 按主行索引对齐
        const dts: DetailTableData[] = [];
        if (tableData.detailTable) dts.push(tableData.detailTable);
        if (Array.isArray(tableData.detailTables)) dts.push(...tableData.detailTables);
        for (const dt of dts) {
            if (!dt) continue;
            if (Array.isArray(dt.rowGroups) && i < dt.rowGroups.length) dt.rowGroups.splice(i, 1);
            if (Array.isArray(dt.rawRowGroups) && i < dt.rawRowGroups.length) dt.rawRowGroups.splice(i, 1);
            if (Array.isArray(dt.rawRowTypes) && i < dt.rawRowTypes.length) dt.rawRowTypes.splice(i, 1);
        }
    }
}

// ============================================================================
// 埋点封装
// ============================================================================

/**
 * 上报 pointCaseDeleter.done —— 无论是否命中都上报（命中 0 条也上报），
 * 用于观测"发起删除"的整体使用量、命中率与性能。
 *
 * 字段清单：
 *   ┌── 测试任务维度
 *   │   testTaskNo         调用方传入的测试任务编号（缺省 ''）
 *   │   subTestTaskId      调用方传入的子任务 ID（缺省 ''）
 *   │   artifactId         调用方传入的产出物 ID；缺省时以案例文件 basename 兜底
 *   ├── 要点维度
 *   │   pointId            入参 pointId（原文，可空）
 *   │   pointName          入参 pointName（原文，可空）
 *   │   pointPath          入参 pointPath（**原文**，未归一化，可空）
 *   ├── 案例维度
 *   │   fileExt            案例文件扩展名（.yaml / .json / .csv）
 *   │   deletedCount       实际被删除案例数（核心业务指标）
 *   │   totalRecords       案例文件原总行数
 *   │   remainingRecords   删除后剩余行数
 *   │   type1/type2/type3  分档命中数（匹配置信度分析）
 *   └── 性能
 *       costMs             端到端耗时（毫秒）
 */
function emitDoneTelemetry(
    result: DeleteCasesByPointResult,
    tInfo: Required<DeleteCasesTaskInfo>,
    p: { pointId: string; pointPath: string; pointName: string },
): void {
    try {
        TelemetryService.sendTelemetryEvent(EVT_DONE, {
            // 测试任务维度
            testTaskNo: tInfo.testTaskNo,
            subTestTaskId: tInfo.subTestTaskId,
            artifactId: tInfo.artifactId || path.basename(result.filePath),
            // 要点维度
            pointId: p.pointId,
            pointName: p.pointName,
            pointPath: p.pointPath,          // 原文（未归一化）
            // 案例维度
            fileExt: path.extname(result.filePath).toLowerCase(),
            deletedCount: String(result.deletedCount),
            totalRecords: String(result.totalRecords),
            remainingRecords: String(result.remainingRecords),
            type1: String(result.typeCount.type1),
            type2: String(result.typeCount.type2),
            type3: String(result.typeCount.type3),
            // 性能
            costMs: String(result.costMs),
        });
    } catch {
        // 埋点绝不阻断业务
    }
}

/**
 * 上报 pointCaseDeleter.error —— 覆盖所有抛异常路径：
 * 入参非法 / 未绑定 / 案例文件不存在 / 解析失败 / 保存失败。
 *
 * 字段：telemetryErrProps + 上下文（testTaskNo/subTestTaskId/artifactId +
 * pointId/pointName/pointPath + fileExt/artifactId 兜底）。
 */
function emitErrorTelemetry(
    err: any,
    tInfo: Required<DeleteCasesTaskInfo>,
    point: DeleteCasesByPointInput | any,
    casePath: string,
): void {
    try {
        const artifactIdFinal = tInfo.artifactId || (casePath ? path.basename(casePath) : '');
        const fileExt = casePath ? path.extname(casePath).toLowerCase() : '';
        TelemetryService.sendTelemetryErrorEvent(EVT_ERROR, deleterErrProps(err, {
            testTaskNo: tInfo.testTaskNo,
            subTestTaskId: tInfo.subTestTaskId,
            artifactId: artifactIdFinal,
            pointId: (point?.pointId ?? '').toString(),
            pointName: (point?.pointName ?? '').toString(),
            pointPath: (point?.pointPath ?? '').toString(),
            fileExt,
        }));
    } catch {
        // 埋点绝不阻断业务
    }
}

// ============================================================================
// 单测专用出口（不作为公共 API 的一部分，请勿在业务代码中调用）
// ============================================================================
export const __test_only__ = {
    deleteCasesFromCaseFile,
    matchType_,
    applyRemoveByIndices,
    emitDoneTelemetry,
    emitErrorTelemetry,
};
