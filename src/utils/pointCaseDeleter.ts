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
 *  语义对齐（与后端「删除测试案例」结果契约保持一致）：
 *    入参 DeleteCasesByPointInput 直接对应后端返回的单条结果项，字段为
 *    { type, data, path, pcoTotal, pointTotal, caseTotal }。
 *    删除触发与定位规则（详见 DeleteCasesByPointInput 注释）：
 *    1. 仅 type ∈ {1, 3} 触发删除（2=失败 / 4=含CMBT不允许删除 不删）。
 *    2. pcoTotal > 0  → path 为功能条目路径：删除案例文件中 path 包含该 path 的
 *       所有案例（前缀匹配，覆盖其下全部测试点/案例）。
 *    3. pointTotal > 1 → path 为测试点路径：删除案例文件中 path 包含该 path 的
 *       所有案例（前缀匹配）。
 *    4. pcoTotal = 0 且 pointTotal = 1 → path 为单个案例路径：删除案例文件中
 *       path 等于该 path 的案例（精确匹配）。
 *    5. 匹配到 0 条：不写盘、不报错，返回 deletedCount: 0。
 *    6. 删除后案例文件剩余行数为 0（即全部案例被删）：直接删除该案例文件，
 *      并清理其绑定关系（point-case-bindings.json）、推送快照、高亮与
 *      linker 缓存，避免出现"空案例文件 / 幽灵绑定"；结果 caseFileDeleted=true。
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
} from './pointCaseLinker';
import { getCaseOfPoint } from './pointCaseBindingStore';
import { buildSnapshotsForFile, savePushSnapshotPrepared } from './pushSnapshotStore';
import { clearHighlight } from './highlightStore';
import { cleanupCaseFileTraces } from './caseFileCleanup';
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

/**
 * 删除入参（对齐后端「删除测试案例」结果契约）。
 *
 * 后端对一次「通过测试要点删除测试案例」调用返回若干结果项，每项携带：
 *   - type     删除结果类型（1-成功 / 2-失败 data 返回失败原因 /
 *              3-删除失败 data 返回路径不存在 / 4-包含 CMBT 案例不允许删除）
 *   - data     保存/删除结果（type=2/3 时承载失败原因 / 路径不存在说明）
 *   - path     路径（功能条目路径 / 测试点路径 / 单个案例路径，取决于下方规则）
 *   - pcoTotal 功能条目数
 *   - pointTotal 测试要点数
 *   - caseTotal  案例数
 *
 * 前端复用后端判定好的语义，直接按下列规则定位要删除的本地案例：
 *   1. 仅当 type ∈ {1, 3} 时才真正触发删除（2/4 不删）。
 *   2. pcoTotal > 0  → path 是「功能条目路径」，删除案例文件中 path 包含该 path 的
 *      所有案例（前缀匹配，覆盖其下所有测试点/案例）。
 *   3. pointTotal > 1 → path 是「测试点路径」，删除案例文件中 path 包含该 path 的
 *      所有案例（前缀匹配，覆盖该测试点下所有案例）。
 *   4. pcoTotal === 0 且 pointTotal === 1 → path 是「单个案例路径」，删除案例文件中
 *      path 等于该 path 的案例（精确匹配）。
 *
 * 注：path 归一化（反斜杠→斜杠、首/尾斜杠 trim）在匹配时统一处理；
 *     data 字段仅用于日志/回显与埋点，不参与匹配。
 */
export interface DeleteCasesByPointInput {
    /** 删除结果类型：1-成功 / 2-失败 / 3-路径不存在 / 4-含CMBT不允许删除 */
    type?: number;
    /** 保存/删除结果描述（type=2/3 时承载失败原因；不参与匹配） */
    data?: string;
    /** 路径：功能条目路径 / 测试点路径 / 单个案例路径（视 pcoTotal/pointTotal 而定） */
    path?: string;
    /** 功能条目数 */
    pcoTotal?: number;
    /** 测试要点数 */
    pointTotal?: number;
    /** 案例数 */
    caseTotal?: number;
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
    /** 案例文件是否因本次删除被整体清空并删除（remainingRecords===0 时为真） */
    caseFileDeleted: boolean;
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
    /** 案例文件是否因本次删除被整体清空并删除 */
    caseFileDeleted: boolean;
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
 * 【公共方法·单点】根据单个后端删除结果项删除其关联的测试案例。
 *
 * 等价于 deleteCasesByPoints(pointFilePath, { points: [point] })，保留老的
 * 调用方签名不变（向后兼容）。
 *
 * @param pointFilePath  测试要点文件绝对路径（通用参数，支持 md / xmind
 *                       及其他任何受 pointCaseBindingStore 支持的类型），
 *                       用于查绑定得到案例文件
 * @param point          DeleteCasesByPointInput（对齐后端结果项）：
 *                       { type, data?, path, pcoTotal?, pointTotal?, caseTotal? }；
 *                       仅 type ∈ {1, 3} 触发删除；按 pcoTotal / pointTotal / path
 *                       决定「前缀匹配」或「精确匹配」删除（详见类型注释）
 * @param taskInfo       可选，测试任务上下文（testTaskNo / subTestTaskId /
 *                       artifactId），仅用于埋点，不参与匹配逻辑
 *
 * @throws
 *   - 入参非法（type 不是 1/3/4，或触发删除的 type 却缺少 path）
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
 * 【公共方法·多点】根据多个后端删除结果项，一次性删除其关联的测试案例。
 *
 * 多个结果项之间是「并集」语义：命中其中任意一个结果项的案例都会被删除；
 * 同一个案例即使同时命中多个结果项，也只会被剔除一次（不会重复删除）。
 * 入参每项均为 DeleteCasesByPointInput（对齐后端结果项），规则同上。
 *
 * @param pointFilePath  测试要点文件绝对路径（同 deleteCasesByPoint）
 * @param input          { points: DeleteCasesByPointInput[] }；points 至少 1 项，
 *                       每项 type 须为 1/3/4 之一（2/4 不触发删除，1/3 须带 path）
 * @param taskInfo       可选，测试任务上下文，仅用于埋点
 *
 * @throws
 *   - points 为空数组 / 非数组 → 抛错
 *   - 任一要点 type 非法（非 1/3/4），或触发删除的 type 却缺少 path → 抛错
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

    // 规范化并校验每个结果项（对齐后端契约）
    const points: Required<DeleteCasesByPointInput>[] = [];
    for (const raw of input.points) {
        if (!raw || typeof raw !== 'object') {
            const err = new Error('deleteCasesByPoints: 单个 point 参数不能为空');
            emitErrorTelemetry(err, tInfo, { points: input.points }, '');
            throw err;
        }
        const type = Number(raw.type);
        if (![1, 2, 3, 4].includes(type)) {
            const err = new Error(`deleteCasesByPoints: 单个 point 的 type 必须为 1/2/3/4（收到 ${type}）`);
            emitErrorTelemetry(err, tInfo, { points: input.points }, '');
            throw err;
        }
        // 仅 type∈{1,3} 触发删除，且必须带非空 path
        const ppath = (raw.path ?? '').toString().trim();
        if ((type === 1 || type === 3) && !ppath) {
            const err = new Error(`deleteCasesByPoints: type=${type} 必须携带非空 path 才能定位待删案例`);
            emitErrorTelemetry(err, tInfo, { points: input.points }, '');
            throw err;
        }
        points.push({
            type,
            data: (raw.data ?? '').toString(),
            path: ppath,
            pcoTotal: Number(raw.pcoTotal) || 0,
            pointTotal: Number(raw.pointTotal) || 0,
            caseTotal: Number(raw.caseTotal) || 0,
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
            for (const pp of result.perPoint) {
                pp.costMs = result.costMs;
                // caseFileDeleted 是文件级语义，回填到逐要点明细便于单点 API 直接读取
                pp.caseFileDeleted = result.caseFileDeleted;
            }
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
    // caseFileDeleted 是文件级语义，回填进单要点明细便于内部单点入口直接读取
    const r = agg.perPoint[0];
    r.caseFileDeleted = agg.caseFileDeleted;
    r.costMs = agg.costMs;
    return r;
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
    //   新契约（对齐后端删除结果项）：
    //     · 仅 type ∈ {1, 3} 触发删除；type=2/4 不删（type3 记录到 typeCount.type3）
    //     · pcoTotal > 0      → path 是功能条目路径，删除「path 包含 path」的所有案例（前缀）
    //     · pointTotal > 1    → path 是测试点路径，删除「path 包含 path」的所有案例（前缀）
    //     · pcoTotal=0 且 pointTotal=1 → path 是单个案例路径，删除「path 等于 path」的案例（精确）
    //   typeCount 分档（保持埋点字段名兼容）：
    //     type1 = 精确匹配删除（单案例），type2 = 前缀匹配删除（功能条目/测试点），
    //     type3 = 未触发删除（type=2/4）
    const tsIdIdx = headers.indexOf(TS_ID_COLUMN);
    const caseIdIdx = tsIdIdx >= 0 ? tsIdIdx : headers.indexOf(CASE_ID_FIELD);
    const nameIdx = headers.indexOf(CASE_NAME_FIELD);
    const parentIdIdx = headers.indexOf(PARENT_ID_FIELD);
    const pathIdx = headers.indexOf(PATH_FIELD);

    // 预先解析每个要点：是否触发删除 + 匹配模式（exact / prefix）+ 归一化目标路径
    const plan = points.map(pt => {
        const trigger = (pt.type === 1 || pt.type === 3);
        const prefix = trigger && ((pt.pcoTotal > 0) || (pt.pointTotal > 1));
        return {
            trigger,
            mode: prefix ? ('prefix' as const) : ('exact' as const),
            target: normalizePointPath(pt.path),
        };
    });

    /** 要删除的主行下标集合（有序、去重） */
    const deletedRowIdxSet = new Set<number>();
    /** 每个要点命中的行下标集合（用于逐要点明细，避免重复计入 deletedCases） */
    const perPointRowIdx: Set<number>[] = points.map(() => new Set<number>());
    /** 被删除案例的摘要（顺序为磁盘中出现顺序） */
    const deletedCases: DeletedCaseItem[] = [];
    const typeCount = { type1: 0, type2: 0, type3: 0 };
    /** 逐要点匹配的 type 分档 */
    const perPointTypeCount = points.map(() => ({ type1: 0, type2: 0, type3: 0 }));

    // type=2/4 不触发删除：每个此类结果项计 1 次到 type3（不按行重复计数）
    for (let p = 0; p < points.length; p++) {
        if (!plan[p].trigger) {
            typeCount.type3++;
            perPointTypeCount[p].type3++;
        }
    }

    for (let i = 0; i < rows.length; i++) {
        // 优先从 sourceData 取原始字段（能命中嵌套结构里的 parent_id/path），
        // 若无 sourceData（csv 场景）再从 rows 按列下标取
        const rec = getRecordFromRow(sourceData, rows[i], i, headers, {
            parentIdIdx, pathIdx, caseIdIdx, nameIdx,
        });
        const recPath = normalizePointPath(rec?.[PATH_FIELD]);

        // 逐要点判断，命中任意一个即标记删除；同一行只计入首次命中的要点明细
        for (let p = 0; p < points.length; p++) {
            const pl = plan[p];
            if (!pl.trigger) continue;
            const hit = pl.mode === 'prefix'
                ? (pl.target !== '' && recPath.startsWith(pl.target))
                : (recPath === pl.target);
            if (!hit) continue;

            deletedRowIdxSet.add(i);
            perPointRowIdx[p].add(i);
            if (pl.mode === 'exact') { typeCount.type1++; perPointTypeCount[p].type1++; }
            else { typeCount.type2++; perPointTypeCount[p].type2++; }
        }
    }

    // 构造逐要点结果（仅首次命中要点带走该案例，避免重复计入 deletedCases）
    const perPoint: DeleteCasesByPointResult[] = points.map((_pt, p) => {
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
            caseFileDeleted: false,
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
            caseFileDeleted: false,
            costMs: Date.now() - t0,
        };
    }

    // ---- 3.4) 按主行索引同步剔除 rows / sourceData / detailTables ----
    applyRemoveByIndices(tableData, sourceData, deletedRowIdxSet);

    const remainingRecords = totalRecords - deletedCases.length;

    // ---- 3.5) 若删除后案例文件已空（remainingRecords===0），则整体删除该文件 ----
    //   并清理其绑定关系 + 所有相关追踪存储，避免出现"幽灵案例文件/绑定"。
    if (remainingRecords === 0) {
        let fileDeleted = false;
        try {
            await fs.promises.unlink(casePath);
            fileDeleted = true;
        } catch (err: any) {
            // 文件已不存在 / 无权限等：记录但不阻断（继续清理绑定与缓存）
            logger.warn('删除空的案例文件失败（不影响绑定清理）', err?.message);
        }

        // 统一清理该文件的全部追踪态存储 + 绑定关系（与文件系统删除路径共用同一逻辑）
        try {
            await cleanupCaseFileTraces(casePath);
        } catch (err: any) {
            logger.warn('cleanupCaseFileTraces 失败（不影响主流程）', err?.message);
        }

        // 失效 linker 缓存（下次匹配拿磁盘最新记录）
        try { clearLinkerCache(); } catch { /* ignore */ }

        logger.info('deleteCasesByPoints: 案例文件已清空并删除', {
            casePath: path.basename(casePath),
            pointCount: points.length,
            deletedCount: deletedCases.length,
            fileDeleted,
        });

        return {
            filePath: casePath,
            perPoint,
            deletedCases,
            deletedCount: deletedCases.length,
            typeCount,
            totalRecords,
            remainingRecords: 0,
            caseFileDeleted: fileDeleted,
            costMs: Date.now() - t0,
        };
    }

    // ---- 3.5) 落盘（案例文件 + 推送快照一次性写入，避免重复读盘） ----
    //   删除后 tableData 即为新基线，直接用它一次性构建快照并落盘，
    //   跳过 savePushSnapshot 内部的 loadStore 全量读盘（删除场景已持有内存态）。
    let snapshotMap: Record<string, string> = {};
    try {
        snapshotMap = buildSnapshotsForFile(casePath, tableData, {}, undefined);
    } catch (err: any) {
        logger.warn('buildSnapshotsForFile 失败（不影响删除主流程）', err?.message);
    }

    // 案例文件落盘
    await parser.save(casePath, tableData, sourceData);

    // 推送快照落盘（已含内存态，仅一次 writeFile，不再回读整个快照文件）
    try {
        await savePushSnapshotPrepared(casePath, snapshotMap);
    } catch (err: any) {
        logger.warn('savePushSnapshot 失败（不影响删除主流程）', err?.message);
    }

    // ---- 3.6) 同步追踪存储 ----
    //   ① 清高亮：删除行的高亮索引已失效，简单起见清整个文件的高亮
    //      （与 clearHighlight 语义一致：高亮是"最近一次编辑/推送"的临时态）
    try {
        await clearHighlight(casePath);
    } catch (err: any) {
        logger.warn('clearHighlight 失败（不影响删除主流程）', err?.message);
    }

    //   ② 失效 linker 缓存（下次匹配拿磁盘最新记录）
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
        remainingRecords,
        caseFileDeleted: false,
        costMs: Date.now() - t0,
    };
}

// ============================================================================
// 匹配语义（对齐后端删除结果项契约）
// ============================================================================

/**
 * 单条案例是否命中给定「删除结果项」的 path 规则。
 *
 * @param recPath    案例记录的 path（已归一化，见 matchType_ 调用方）
 * @param targetPath 入参 path（已归一化）
 * @param mode       'exact' 精确匹配（pcoTotal=0 且 pointTotal=1）
 *                    'prefix' 前缀匹配（pcoTotal>0 或 pointTotal>1）
 * @returns true 表示应删除该案例
 *
 * 归一化：反斜杠→斜杠、首尾斜杠 trim、连续斜杠折叠，由调用方先 normalizePointPath。
 */
function pathHit_(recPath: string, targetPath: string, mode: 'exact' | 'prefix'): boolean {
    if (!targetPath) return false;
    if (mode === 'exact') return recPath === targetPath;
    // prefix：案例 path 以目标 path 开头（后面紧跟 '/' 或等于自身，避免 "a" 误命中 "abc"）
    return recPath === targetPath || recPath.startsWith(targetPath + '/');
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
    p: Required<DeleteCasesByPointInput>,
): void {
    try {
        TelemetryService.sendTelemetryEvent(EVT_DONE, {
            // 测试任务维度
            testTaskNo: tInfo.testTaskNo,
            subTestTaskId: tInfo.subTestTaskId,
            artifactId: tInfo.artifactId || path.basename(result.filePath),
            // 结果项维度（对齐后端删除契约）
            type: String(p.type),
            data: p.data,
            pointPath: p.path,               // 原文（未归一化）
            pcoTotal: String(p.pcoTotal),
            pointTotal: String(p.pointTotal),
            caseTotal: String(p.caseTotal),
            // 案例维度
            fileExt: path.extname(result.filePath).toLowerCase(),
            deletedCount: String(result.deletedCount),
            totalRecords: String(result.totalRecords),
            remainingRecords: String(result.remainingRecords),
            caseFileDeleted: String(result.caseFileDeleted ? 1 : 0),
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
            type: joinField(p => String(p.type)),
            pointPath: joinField(p => p.path),
            pcoTotal: joinField(p => String(p.pcoTotal)),
            pointTotal: joinField(p => String(p.pointTotal)),
            caseTotal: joinField(p => String(p.caseTotal)),
            // 案例维度（全局去重口径）
            fileExt: path.extname(result.filePath).toLowerCase(),
            deletedCount: String(result.deletedCount),
            totalRecords: String(result.totalRecords),
            remainingRecords: String(result.remainingRecords),
            caseFileDeleted: String(result.caseFileDeleted ? 1 : 0),
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
    pathHit_,
    applyRemoveByIndices,
    emitDoneTelemetry,
    emitErrorTelemetry,
};
