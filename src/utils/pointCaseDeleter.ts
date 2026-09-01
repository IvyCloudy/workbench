/**
 * ============================================================================
 *  utils/pointCaseDeleter.ts
 *  测试要点 → 关联测试案例 删除公共方法
 * ----------------------------------------------------------------------------
 *  职责：
 *    根据测试要点信息（pointId / pointPath / pointName），复用「查看关联案例」
 *    的匹配引擎（pointCaseLinker），把该要点在其绑定案例文件中命中的所有案例
 *    从磁盘删除，并同步维护 push-snapshot / highlightStore 等追踪存储，
 *    避免出现"幽灵行"。
 *
 *  线上同步说明（已确认）：通过要点删除案例时，线上案例已由上游先行删除，
 *  删除流程**仅处理本地案例**，不调用任何线上删除接口，也不将删除行标记
 *  为"待同步到线上"（避免 sync 流程误把已删除的线上案例再次发起同步）。
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
const EVT_DONE_AGG = 'pointCaseDeleter.done.aggregate';
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
 * 多要点删除入参：一组要点（pointId / pointPath 至少一个非空）。
 *
 * 语义：多个要点之间存在「并集」关系——凡是命中其中任意一个要点的案例
 * 都会被删除（同一个案例只会删除一次，不会因命中多个要点而被重复剔除）。
 * 用法示例：
 *   · 单次调用传入单个要点：points 长度为 1，完全等价于 deleteCasesByPoint
 *   · 批量场景：points 长度 > 1，一次调用删除多个要点关联的案例
 *
 * 约束：points 中每一项自身仍需满足「pointId 与 pointPath 至少一个非空」，
 * 全部为空或全部仅传 pointName 会抛错。
 */
export interface DeleteCasesByPointsInput {
    /** 要点列表（至少 1 项，每项约束同 DeleteCasesByPointInput） */
    points: DeleteCasesByPointInput[];
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

/** 多要点删除的聚合结果（每个要点一项 DeleteCasesByPointResult） */
export interface DeleteCasesByPointsResult {
    /** 案例文件绝对路径 */
    filePath: string;
    /** 逐要点的删除明细（顺序与入参 points 一致） */
    perPoint: DeleteCasesByPointResult[];
    /** 被删除的案例列表（去重后的并集，顺序为磁盘中出现顺序） */
    deletedCases: DeletedCaseItem[];
    /** 实际被删除的案例去重计数（== deletedCases.length） */
    deletedCount: number;
    /** 匹配类型分档汇总（所有要点合并） */
    typeCount: { type1: number; type2: number; type3: number };
    /** 案例文件原总行数 */
    totalRecords: number;
    /** 删除后剩余行数 */
    remainingRecords: number;
    /** 端到端耗时(ms)——仅返回给调用方 */
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
 * 【公共方法·单点】根据单个测试要点信息删除其关联的所有测试案例。
 *
 * 等价于 deleteCasesByPoints(pointFilePath, { points: [point] })，保留老的
 * 调用方签名不变（向后兼容）。
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
    const agg = await deleteCasesByPoints(pointFilePath, { points: [point] }, taskInfo);
    return agg.perPoint[0];
}

/**
 * 【公共方法·多点】根据多个测试要点信息，一次性删除其关联的所有测试案例。
 *
 * 多个要点之间是「并集」语义：命中其中任意要点的案例都会被删除；同一个案例
 * 即使同时命中多个要点，也只会被剔除一次（不会重复删除）。
 *
 * @param pointFilePath  测试要点文件绝对路径（同 deleteCasesByPoint）
 * @param input          { points: DeleteCasesByPointInput[] }；points 至少 1 项，
 *                       每项自身仍需满足「pointId 与 pointPath 至少一个非空」
 * @param taskInfo       可选，测试任务上下文，仅用于埋点
 *
 * @throws
 *   - points 为空数组 / 非数组 → 抛错
 *   - 任一要点 pointId 与 pointPath 同时为空 → 抛错
 *   - pointFilePath 未绑定任何案例文件
 *   - 案例文件不存在 / 类型不支持
 *   - 文件解析或保存失败
 */
export async function deleteCasesByPoints(
    pointFilePath: string,
    input: DeleteCasesByPointsInput,
    taskInfo?: DeleteCasesTaskInfo,
): Promise<DeleteCasesByPointsResult> {
    // 埋点上下文的规范化 —— 全部转为 string，缺省用 ''
    const tInfo: Required<DeleteCasesTaskInfo> = {
        testTaskNo: (taskInfo?.testTaskNo ?? '').toString(),
        subTestTaskId: (taskInfo?.subTestTaskId ?? '').toString(),
        artifactId: (taskInfo?.artifactId ?? '').toString(),
    };

    // ---- 1) 入参校验 ----
    if (!pointFilePath || typeof pointFilePath !== 'string') {
        const err = new Error('deleteCasesByPoints: pointFilePath 不能为空');
        emitErrorTelemetry(err, tInfo, { points: input?.points }, '');
        throw err;
    }
    if (!input || !Array.isArray(input.points) || input.points.length === 0) {
        const err = new Error('deleteCasesByPoints: points 不能为空数组');
        emitErrorTelemetry(err, tInfo, { points: input?.points }, '');
        throw err;
    }

    // 规范化并校验每个要点
    const points: Required<DeleteCasesByPointInput>[] = [];
    for (const raw of input.points) {
        if (!raw || typeof raw !== 'object') {
            const err = new Error('deleteCasesByPoints: 单个 point 参数不能为空');
            emitErrorTelemetry(err, tInfo, { points: input.points }, '');
            throw err;
        }
        const pid = (raw.pointId ?? '').toString().trim();
        const ppath = (raw.pointPath ?? '').toString().trim();
        if (!pid && !ppath) {
            const err = new Error('deleteCasesByPoints: 单个 point 的 pointId 与 pointPath 至少一个非空');
            emitErrorTelemetry(err, tInfo, { points: input.points }, '');
            throw err;
        }
        points.push({
            pointId: pid,
            pointPath: ppath,
            pointName: (raw.pointName ?? '').toString(),
        });
    }

    // ---- 2) 查绑定 → 案例文件路径 ----
    const casePath = getCaseOfPoint(pointFilePath);
    if (!casePath) {
        const err = new Error(`deleteCasesByPoints: 测试要点未绑定案例文件 (${pointFilePath})`);
        emitErrorTelemetry(err, tInfo, { points: input.points }, '');
        throw err;
    }
    if (!fs.existsSync(casePath)) {
        const err = new Error(`deleteCasesByPoints: 案例文件不存在 (${casePath})`);
        emitErrorTelemetry(err, tInfo, { points: input.points }, casePath);
        throw err;
    }

    // ---- 3) 加锁进入临界区（与 writeBackTestCaseNos 共用同一把锁） ----
    return withFileLock(casePath, async () => {
        try {
            const result = await deleteCasesFromCaseFileMulti(casePath, points);
            // 回填真实耗时到逐要点明细（内部为 0，仅用于埋点展示）
            for (const pp of result.perPoint) pp.costMs = result.costMs;
            // ① 逐要点各上报一条 done（明细口径：deletedCount 为单要点命中数）
            for (let i = 0; i < points.length; i++) {
                emitDoneTelemetry(result.perPoint[i], tInfo, points[i]);
            }
            // ② 额外上报一条聚合 done（全局口径：去重 deletedCount + 真实 costMs）
            emitAggregateDoneTelemetry(result, tInfo, points);
            return result;
        } catch (err) {
            emitErrorTelemetry(err, tInfo, { points: input.points }, casePath);
            throw err;
        }
    });
}

// ============================================================================
// 内部实现（可直接被单元测试调用，跳过 pointFilePath 绑定层）
// ============================================================================

/**
 * 【内部】单点便捷入口（向后兼容 __test_only__ 单点测试）。
 * 委托给 deleteCasesFromCaseFileMulti，语义完全一致。
 */
async function deleteCasesFromCaseFile(
    casePath: string,
    point: Required<DeleteCasesByPointInput>,
): Promise<DeleteCasesByPointResult> {
    const agg = await deleteCasesFromCaseFileMulti(casePath, [point]);
    return agg.perPoint[0];
}

/**
 * 【内部】直接对案例文件执行删除（多要点并集）。已在锁内，不再加锁。
 * 单元测试可通过 __test_only__ 命名空间访问，避免测试环境依赖 vscode.workspace
 * （跳过要点文件 → 案例文件的绑定查询层，直接以案例文件绝对路径作为入口）。
 *
 * 多要点语义：逐行扫描案例，命中 points 中任意一个要点即标记删除；
 * 同一行即使命中多个要点也只在 deletedRowIdxSet 中记录一次（Set 去重），
 * 因此不会产生重复删除。
 */
async function deleteCasesFromCaseFileMulti(
    casePath: string,
    points: Required<DeleteCasesByPointInput>[],
): Promise<DeleteCasesByPointsResult> {
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

    /** 要删除的主行下标集合（有序、去重） */
    const deletedRowIdxSet = new Set<number>();
    /** 每个要点命中的行下标集合（用于逐要点明细，避免重复计入 deletedCases） */
    const perPointRowIdx: Set<number>[] = points.map(() => new Set<number>());
    /** 被删除案例的摘要（顺序为磁盘中出现顺序） */
    const deletedCases: DeletedCaseItem[] = [];
    const typeCount = { type1: 0, type2: 0, type3: 0 };
    /** 逐要点匹配的 type 分档 */
    const perPointTypeCount = points.map(() => ({ type1: 0, type2: 0, type3: 0 }));

    for (let i = 0; i < rows.length; i++) {
        // 优先从 sourceData 取原始字段（能命中嵌套结构里的 parent_id/path），
        // 若无 sourceData（csv 场景）再从 rows 按列下标取
        const rec = getRecordFromRow(sourceData, rows[i], i, headers, {
            parentIdIdx, pathIdx, caseIdIdx, nameIdx,
        });

        // 逐要点判断，命中任意一个即标记删除；同一行只计入首次命中的要点明细
        for (let p = 0; p < points.length; p++) {
            const pt = points[p];
            const matchType = matchType_(
                rec, pt.pointId, normalizePointPath(pt.pointPath),
            );
            if (matchType == null) continue;

            deletedRowIdxSet.add(i);
            perPointRowIdx[p].add(i);
            if (matchType === 1) { typeCount.type1++; perPointTypeCount[p].type1++; }
            else if (matchType === 2) { typeCount.type2++; perPointTypeCount[p].type2++; }
            else { typeCount.type3++; perPointTypeCount[p].type3++; }
        }
    }

    // 构造逐要点结果（仅首次命中要点带走该案例，避免重复计入 deletedCases）
    const perPoint: DeleteCasesByPointResult[] = points.map((pt, p) => {
        const cases: DeletedCaseItem[] = [];
        for (const idx of perPointRowIdx[p]) {
            const rec = getRecordFromRow(sourceData, rows[idx], idx, headers, {
                parentIdIdx, pathIdx, caseIdIdx, nameIdx,
            });
            const tid = readField(rec, CASE_ID_FIELD, rows[idx], caseIdIdx);
            const cname = readField(rec, CASE_NAME_FIELD, rows[idx], nameIdx);
            cases.push({
                testcaseId: String(tid ?? '').trim(),
                caseName: String(cname ?? '').trim(),
            });
        }
        return {
            filePath: casePath,
            deletedCases: cases,
            deletedCount: cases.length,
            typeCount: perPointTypeCount[p],
            totalRecords,
            remainingRecords: totalRecords - cases.length,
            costMs: 0,
        };
    });

    // 去重后的被删除案例摘要（顺序为磁盘中出现顺序）
    for (const idx of Array.from(deletedRowIdxSet).sort((a, b) => a - b)) {
        const rec = getRecordFromRow(sourceData, rows[idx], idx, headers, {
            parentIdIdx, pathIdx, caseIdIdx, nameIdx,
        });
        const tid = readField(rec, CASE_ID_FIELD, rows[idx], caseIdIdx);
        const cname = readField(rec, CASE_NAME_FIELD, rows[idx], nameIdx);
        deletedCases.push({
            testcaseId: String(tid ?? '').trim(),
            caseName: String(cname ?? '').trim(),
        });
    }

    // ---- 3.3) 命中 0 条：直接返回，不写盘不刷 snapshot ----
    if (deletedRowIdxSet.size === 0) {
        return {
            filePath: casePath,
            perPoint,
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

    //   ② 清高亮：删除行的高亮索引已失效，简单起见清整个文件的高亮
    //      （与 clearHighlight 语义一致：高亮是"最近一次编辑/推送"的临时态）
    try {
        await clearHighlight(casePath);
    } catch (err: any) {
        logger.warn('clearHighlight 失败（不影响删除主流程）', err?.message);
    }

    //   ③ 失效 linker 缓存（下次匹配拿磁盘最新记录）
    try {
        clearLinkerCache();
    } catch { /* ignore */ }

    logger.info('deleteCasesByPoints done', {
        casePath: path.basename(casePath),
        pointCount: points.length,
        deletedCount: deletedCases.length,
        typeCount,
    });

    return {
        filePath: casePath,
        perPoint,
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
 * 上报 pointCaseDeleter.done.aggregate —— 仅多要点（deleteCasesByPoints）场景。
 *
 * 与逐要点 done 的区别：
 *   - pointId / pointName / pointPath 三个字段合并为「多值拼接」字符串
 *     （以 '|' 分隔，便于在埋点平台按要点数拆分统计）
 *   - deletedCount / remainingRecords / type1..3 均为**全局去重**口径
 *     （与逐要点 done 的「单要点命中数」口径不同，避免重叠命中被重复计数）
 *   - 额外新增 pointCount 字段：本次传入的要点个数
 *   - costMs 为真实端到端耗时（逐要点 done 的 costMs 为回填值，此处为权威耗时）
 */
function emitAggregateDoneTelemetry(
    result: DeleteCasesByPointsResult,
    tInfo: Required<DeleteCasesTaskInfo>,
    points: Required<DeleteCasesByPointInput>[],
): void {
    try {
        const joinField = (sel: (p: Required<DeleteCasesByPointInput>) => string) =>
            points.map(sel).join('|');
        TelemetryService.sendTelemetryEvent(EVT_DONE_AGG, {
            // 测试任务维度
            testTaskNo: tInfo.testTaskNo,
            subTestTaskId: tInfo.subTestTaskId,
            artifactId: tInfo.artifactId || path.basename(result.filePath),
            // 多要点维度（拼接）
            pointCount: String(points.length),
            pointId: joinField(p => p.pointId),
            pointName: joinField(p => p.pointName),
            pointPath: joinField(p => p.pointPath),
            // 案例维度（全局去重口径）
            fileExt: path.extname(result.filePath).toLowerCase(),
            deletedCount: String(result.deletedCount),
            totalRecords: String(result.totalRecords),
            remainingRecords: String(result.remainingRecords),
            type1: String(result.typeCount.type1),
            type2: String(result.typeCount.type2),
            type3: String(result.typeCount.type3),
            // 性能（真实耗时）
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

/**
 * 上报 pointCaseDeleter.done.aggregate —— 仅多要点（deleteCasesByPoints）场景。
 *
 * 与逐要点 done 的区别：
 *   - pointId / pointName / pointPath 三个字段合并为「多值拼接」字符串
 *     （以 '|' 分隔，便于在埋点平台按要点数拆分统计）
 *   - deletedCount / remainingRecords / type1..3 均为**全局去重**口径
 *     （与逐要点 done 的「单要点命中数」口径不同，避免重叠命中被重复计数）
 *   - 额外新增 pointCount 字段：本次传入的要点个数
 *   - costMs 为真实端到端耗时（逐要点 done 的 costMs 为回填值，此处为权威耗时）
 */

// ============================================================================
// 单测专用出口（不作为公共 API 的一部分，请勿在业务代码中调用）
// ============================================================================
export const __test_only__ = {
    deleteCasesFromCaseFile,
    deleteCasesFromCaseFileMulti,
    matchType_,
    applyRemoveByIndices,
    emitDoneTelemetry,
    emitErrorTelemetry,
};
