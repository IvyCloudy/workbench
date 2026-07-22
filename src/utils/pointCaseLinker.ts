/**
 * ============================================================================
 *  utils/pointCaseLinker.ts
 *  测试要点 ↔ 测试案例 关联匹配公共方法
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 根据 pointList 与案例文件里的 parent_id / path 建立"点 → 案例"分组
 *    2. 输出主索引 byPoint（供上层直接消费）+ 反向索引 byCase（O(1) 反查）
 *    3. 匹配 type 分档：
 *         type=1  parent_id 命中 且 归一化 path 相等  （最强）
 *         type=2  仅 parent_id 命中                  （path 不等或缺失）
 *         type=3  仅 path 归一化命中                 （parent_id 不匹配/缺失）
 *
 *  设计要点：
 *    - 用 Map 建索引，主循环 O(P + C × k)，避免嵌套遍历
 *    - parent_id 支持数组 / 逗号分号分隔字符串 / 尾号 -N 剥离（fallback 语义）
 *    - 内存 LRU + mtime 缓存已解析 records，热调用近乎零成本
 *    - 提供批量入口 linkPointsToCasesBatch，一次建索引 N 次匹配 + 并发解析
 *    - 埋点最小化：仅在多命中、重复 pointId、孤儿记录等异常场景打点
 * ============================================================================
 */
import * as path from 'path';
import * as fs from 'fs';
import { parseFileToRows } from '../parsers';
import { TelemetryService } from './telemetry';
import { createLogger } from './logger';

const logger = createLogger('pcLinker');

// ============================================================================
// 类型
// ============================================================================

export interface PointItem {
    pointId: string;
    pointName: string;
    pointPath: string;
}

export interface CaseItem {
    /** 使用 testcase_id 作为 node_id，全局唯一 */
    testcase_id: string;
    caseName: string;
    /** 案例记录中的 path 字段（功能条目/测试要点路径，如 账户中心/登录模块） */
    casePath: string;
    /** 【前置条件】/【步骤描述】/【预期结果】拼接文本，每行用 <p></p> 包裹 */
    caseDetail: string;
    /** 匹配类型：1 parent_id+path、2 仅 parent_id、3 仅 path */
    type: 1 | 2 | 3;
}

export interface LinkOptions {
    /** 案例记录中"父点 ID"字段名，默认 parent_id */
    parentIdField?: string;
    /** 案例记录中"点路径"字段名，默认 path */
    pathField?: string;
    /** 案例记录中"testcase_id / node_id"字段名，默认 testcase_id */
    caseIdField?: string;
    /** 案例记录中"案例名"字段名，默认 name */
    caseNameField?: string;
    /**
     * 案例记录中"前置条件 / 预期结果"字段名：
     *   preconditionFields / expectedFields 会按顺序尝试取值并拼接
     */
    preconditionFields?: string[];
    expectedFields?: string[];
    /** 是否剥离 parent_id 末尾 "-数字"（默认 true） */
    stripParentIdTailIndex?: boolean;
    /** 是否启用 mtime + LRU 缓存已解析 records（默认 true） */
    enableCache?: boolean;
    /** 是否打埋点（默认 true） */
    telemetry?: boolean;
}

export interface LinkResult {
    /** key = `${pointId}_${pointName}` */
    byPoint: Record<string, CaseItem[]>;
    /** key = testcase_id，value 含 pointKey + type，方便 O(1) 反查 */
    byCase: Record<string, { pointKey: string; type: 1 | 2 | 3 }>;
    stats: {
        totalRecords: number;
        matchedRecords: number;
        orphanRecords: number;
        matchedByType: { type1: number; type2: number; type3: number };
        duplicatePointIds: string[];
        multiHitCases: string[];
        strippedParentIds: number;
    };
}

// ============================================================================
// 默认字段
// ============================================================================
const DEFAULT_PRECOND_FIELDS = ['preconditions', 'preCondition', 'pre_condition'];
const DEFAULT_EXPECTED_FIELDS = ['expected', 'expectedResult', 'ui_expected', 'api_expected', 'db_expected'];

// ============================================================================
// 缓存（模块级 LRU + mtime 失效）
// ============================================================================
interface CacheEntry {
    mtimeMs: number;
    size: number;
    records: any[];
    /** 最近使用时间戳 */
    lru: number;
}
const CACHE_MAX = 64;
const fileCache = new Map<string, CacheEntry>();

function cacheGet(fp: string, mtimeMs: number, size: number): any[] | null {
    const hit = fileCache.get(fp);
    if (!hit) return null;
    if (hit.mtimeMs !== mtimeMs || hit.size !== size) {
        fileCache.delete(fp);
        return null;
    }
    hit.lru = Date.now();
    return hit.records;
}

function cachePut(fp: string, mtimeMs: number, size: number, records: any[]) {
    if (fileCache.size >= CACHE_MAX) {
        // 淘汰最久未使用
        let oldestKey: string | null = null;
        let oldestLru = Infinity;
        for (const [k, v] of fileCache) {
            if (v.lru < oldestLru) { oldestLru = v.lru; oldestKey = k; }
        }
        if (oldestKey) fileCache.delete(oldestKey);
    }
    fileCache.set(fp, { mtimeMs, size, records, lru: Date.now() });
}

/** 单元测试 / 手动清理入口 */
export function clearLinkerCache(): void {
    fileCache.clear();
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * path 归一化：
 *   - 去除首尾空白
 *   - 统一分隔符：\\, ／, · 均转为 /
 *   - 折叠连续空白
 *   - 去除首尾斜杠、连续斜杠
 */
export function normalizePointPath(p: any): string {
    if (p == null) return '';
    const s = String(p).trim();
    if (!s) return '';
    return s
        .replace(/[\\／·]+/g, '/')      // 统一分隔符
        .replace(/\s+/g, ' ')            // 折叠空白
        .replace(/\s*\/\s*/g, '/')       // 去掉斜杠两侧空白
        .replace(/\/+/g, '/')            // 连续斜杠合并
        .replace(/^\/|\/$/g, '')         // 去掉首尾斜杠
        .trim();
}

/**
 * 归一化 parent_id 到 string[]：
 *   - 支持 数组 / 逗号分号分隔字符串
 *   - 空串自动过滤
 *   - trim 处理
 */
export function normalizeParentIds(v: any): string[] {
    if (v == null) return [];
    if (Array.isArray(v)) {
        return v
            .map(x => (x == null ? '' : String(x).trim()))
            .filter(Boolean);
    }
    return String(v)
        .split(/[,;，；]/)
        .map(s => s.trim())
        .filter(Boolean);
}

/** 剥离末尾 "-数字"（如 LGN-001-1 → LGN-001）。仅在原值查不到时用作 fallback。 */
export function stripSubIndex(pid: string): string {
    return pid.replace(/-\d+$/, '');
}

/** 把可能是数组/标量的值规整为「非空字符串数组」。 */
function toStringArray(v: any): string[] {
    if (v == null) return [];
    if (Array.isArray(v)) {
        return v.map(x => (x == null ? '' : String(x).trim())).filter(Boolean);
    }
    // 字符串：按行拆分，兼容「已转换的多行文本」（如中文 CSV 的预期结果列）
    return String(v)
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
}

/** 按字段列表取「第一个有值」字段的全部值（数组形式，前置条件用）。 */
function collectFirstNonEmptyArray(rec: any, fields: string[]): string[] {
    for (const f of fields) {
        const arr = toStringArray(rec?.[f]);
        if (arr.length > 0) return arr;
    }
    return [];
}

/** 用 <p></p> 包裹单行文本。 */
function wrapLine(s: string): string {
    return `<p>${s}</p>`;
}

/**
 * 组装 caseDetail，整体结构（每一行均用 <p></p> 包裹）：
 *   【前置条件】
 *   <前置内容 1> / <前置内容 2> ...
 *   【步骤描述】
 *   步骤1:<operation>
 *   步骤2:<operation>
 *   【预期结果】
 *   步骤1:
 *   【UI检查】
 *   <ui_expected 1>
 *   <ui_expected 2>
 *   【接口调用】
 *   <api_expected...>
 *   【数据检查】
 *   <db_expected...>
 *   步骤2:
 *   ...
 *
 * 退化场景：案例无 steps（如中文 CSV 模板）时，【预期结果】沿用 expFields 取值。
 *   - 中文 CSV 的「预期结果」列已是转换好的成品文本（含【UI检查】等标签），
 *     直接原样按行输出（每行 <p> 包裹），不再按 ui_expected/api_expected/db_expected 拆分。
 */
function buildCaseDetail(
    rec: any,
    preFields: string[],
    expFields: string[],
): string {
    const lines: string[] = [];

    // ---- 前置条件（始终输出标题，内容为空时补一个空行）----
    const preArr = collectFirstNonEmptyArray(rec, preFields);
    lines.push('【前置条件】');
    if (preArr.length > 0) {
        for (const p of preArr) lines.push(p);
    } else {
        lines.push('');
    }

    const steps = Array.isArray(rec?.steps) ? rec.steps : [];
    if (steps.length > 0) {
        // ---- 步骤描述 ----
        lines.push('【步骤描述】');
        steps.forEach((st: any, idx: number) => {
            const no = st?.id ?? idx + 1;
            const op = String(st?.operation ?? '').trim();
            lines.push(`步骤${no}:${op}`);
        });

        // ---- 预期结果 ----
        const expLines: string[] = [];
        steps.forEach((st: any, idx: number) => {
            const no = st?.id ?? idx + 1;
            const ui = toStringArray(st?.ui_expected);
            const api = toStringArray(st?.api_expected);
            const db = toStringArray(st?.db_expected);
            if (ui.length === 0 && api.length === 0 && db.length === 0) return;
            expLines.push(`步骤${no}:`);
            // 【xx检查】单独一行，检查内容另起一行
            if (ui.length > 0) { expLines.push('【UI检查】'); expLines.push(...ui); }
            if (api.length > 0) { expLines.push('【接口调用】'); expLines.push(...api); }
            if (db.length > 0) { expLines.push('【数据检查】'); expLines.push(...db); }
        });
        if (expLines.length > 0) {
            lines.push('【预期结果】');
            lines.push(...expLines);
        }
    } else {
        // 退化：无 steps，沿用 expFields 合并作为预期结果
        const expParts: string[] = [];
        for (const f of expFields) expParts.push(...toStringArray(rec?.[f]));
        if (expParts.length > 0) {
            lines.push('【预期结果】');
            lines.push(...expParts);
        }
    }

    return lines.map(wrapLine).join('');
}

// ============================================================================
// 单文件入口
// ============================================================================

/**
 * 单文件解析 + 匹配。
 *
 * 性能：O(P + C × k)，P=pointList 大小，C=文件记录数，k=每记录 parent_id 数量（一般 1）
 *
 * @param filePath   案例文件绝对路径（.yaml / .json / .csv）
 * @param pointList  从测试要点 md 提取出来的点列表（可来自多个 md 的合并）
 * @param options    见 LinkOptions
 */
export async function linkPointsToCases(
    filePath: string,
    pointList: PointItem[],
    options: LinkOptions = {},
): Promise<LinkResult> {
    if (!filePath) {
        throw new Error('linkPointsToCases: filePath 不能为空');
    }
    const empty: LinkResult = {
        byPoint: {},
        byCase: {},
        stats: {
            totalRecords: 0,
            matchedRecords: 0,
            orphanRecords: 0,
            matchedByType: { type1: 0, type2: 0, type3: 0 },
            duplicatePointIds: [],
            multiHitCases: [],
            strippedParentIds: 0,
        },
    };
    if (!Array.isArray(pointList) || pointList.length === 0) {
        return empty;
    }

    const opts: Required<LinkOptions> = {
        parentIdField: options.parentIdField ?? 'parent_id',
        pathField: options.pathField ?? 'path',
        caseIdField: options.caseIdField ?? 'testcase_id',
        caseNameField: options.caseNameField ?? 'name',
        preconditionFields: options.preconditionFields ?? DEFAULT_PRECOND_FIELDS,
        expectedFields: options.expectedFields ?? DEFAULT_EXPECTED_FIELDS,
        stripParentIdTailIndex: options.stripParentIdTailIndex ?? true,
        enableCache: options.enableCache ?? true,
        telemetry: options.telemetry ?? true,
    };

    // 1) 建索引（一次遍历 pointList）
    const { byId, byPath, duplicatePointIds } = buildIndex(pointList);

    // 2) 读取 records（走缓存）
    const records = await loadRecords(filePath, opts.enableCache);

    // 3) 匹配（一次遍历 records）
    const result = matchCore(records, byId, byPath, opts);
    result.stats.duplicatePointIds = duplicatePointIds;

    // 4) 埋点
    if (opts.telemetry) {
        emitTelemetry(filePath, result, pointList.length);
    }
    logger.debug('link done', {
        filePath: path.basename(filePath),
        P: pointList.length,
        C: records.length,
        stats: result.stats,
    });

    return result;
}

// ============================================================================
// 批量入口（一对多 / 多对多场景）
// ============================================================================

/**
 * 批量匹配多个案例文件。索引只构建一次；文件解析按 concurrency 并发。
 *
 * @param filePaths     案例文件路径数组
 * @param pointList     合并后的点列表
 * @param options       可指定 concurrency（默认 4）
 * @returns             { filePath: LinkResult } 映射
 */
export async function linkPointsToCasesBatch(
    filePaths: string[],
    pointList: PointItem[],
    options: LinkOptions & { concurrency?: number } = {},
): Promise<Record<string, LinkResult>> {
    const out: Record<string, LinkResult> = {};
    if (!Array.isArray(filePaths) || filePaths.length === 0) return out;
    if (!Array.isArray(pointList) || pointList.length === 0) {
        for (const fp of filePaths) {
            out[fp] = {
                byPoint: {},
                byCase: {},
                stats: {
                    totalRecords: 0,
                    matchedRecords: 0,
                    orphanRecords: 0,
                    matchedByType: { type1: 0, type2: 0, type3: 0 },
                    duplicatePointIds: [],
                    multiHitCases: [],
                    strippedParentIds: 0,
                },
            };
        }
        return out;
    }

    const opts: Required<LinkOptions> = {
        parentIdField: options.parentIdField ?? 'parent_id',
        pathField: options.pathField ?? 'path',
        caseIdField: options.caseIdField ?? 'testcase_id',
        caseNameField: options.caseNameField ?? 'name',
        preconditionFields: options.preconditionFields ?? DEFAULT_PRECOND_FIELDS,
        expectedFields: options.expectedFields ?? DEFAULT_EXPECTED_FIELDS,
        stripParentIdTailIndex: options.stripParentIdTailIndex ?? true,
        enableCache: options.enableCache ?? true,
        telemetry: options.telemetry ?? true,
    };
    const concurrency = Math.max(1, options.concurrency ?? 4);

    // 索引只构建一次
    const { byId, byPath, duplicatePointIds } = buildIndex(pointList);

    // 并发解析 + 匹配
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const runOne = async () => {
        while (cursor < filePaths.length) {
            const idx = cursor++;
            const fp = filePaths[idx];
            try {
                const records = await loadRecords(fp, opts.enableCache);
                const result = matchCore(records, byId, byPath, opts);
                result.stats.duplicatePointIds = duplicatePointIds;
                out[fp] = result;
                if (opts.telemetry) {
                    emitTelemetry(fp, result, pointList.length);
                }
            } catch (err: any) {
                logger.error('linkPointsToCasesBatch item failed', fp, err?.message);
                out[fp] = {
                    byPoint: {},
                    byCase: {},
                    stats: {
                        totalRecords: 0,
                        matchedRecords: 0,
                        orphanRecords: 0,
                        matchedByType: { type1: 0, type2: 0, type3: 0 },
                        duplicatePointIds,
                        multiHitCases: [],
                        strippedParentIds: 0,
                    },
                };
                if (opts.telemetry) {
                    try {
                        TelemetryService.sendTelemetryErrorEvent('pointCaseLinker.fileError', {
                            fileExt: path.extname(fp).toLowerCase(),
                            errorMessage: String(err?.message || err).slice(0, 200),
                        });
                    } catch { /* ignore */ }
                }
            }
        }
    };
    for (let i = 0; i < Math.min(concurrency, filePaths.length); i++) {
        workers.push(runOne());
    }
    await Promise.all(workers);
    return out;
}

// ============================================================================
// 内部：索引构建
// ============================================================================

interface PointIndex {
    /** pointId → 归属的 points（重复 pointId 会都保留 → 合并多归属）*/
    byId: Map<string, PointItem[]>;
    /** 归一化 pointPath → 归属的 points */
    byPath: Map<string, PointItem[]>;
    /** 出现重复的 pointId 列表（用于 stats） */
    duplicatePointIds: string[];
}

function buildIndex(pointList: PointItem[]): PointIndex {
    const byId = new Map<string, PointItem[]>();
    const byPath = new Map<string, PointItem[]>();
    const dupSet = new Set<string>();
    const seenIds = new Set<string>();

    for (const p of pointList) {
        if (!p || !p.pointId) continue;
        const id = String(p.pointId).trim();
        if (!id) continue;

        if (seenIds.has(id)) dupSet.add(id);
        seenIds.add(id);

        const arr = byId.get(id);
        if (arr) arr.push(p); else byId.set(id, [p]);

        const nPath = normalizePointPath(p.pointPath);
        if (nPath) {
            const arr2 = byPath.get(nPath);
            if (arr2) arr2.push(p); else byPath.set(nPath, [p]);
        }
    }

    return {
        byId,
        byPath,
        duplicatePointIds: Array.from(dupSet),
    };
}

// ============================================================================
// 内部：records 加载（带缓存）
// ============================================================================

async function loadRecords(filePath: string, enableCache: boolean): Promise<any[]> {
    if (enableCache) {
        try {
            const st = fs.statSync(filePath);
            const hit = cacheGet(filePath, st.mtimeMs, st.size);
            if (hit) return hit;
            const records = (await parseFileToRows(filePath)) || [];
            cachePut(filePath, st.mtimeMs, st.size, records);
            return records;
        } catch (err) {
            // stat 失败等 → 走无缓存回退
            logger.warn('loadRecords stat failed, fallback no-cache', filePath, err);
        }
    }
    return (await parseFileToRows(filePath)) || [];
}

// ============================================================================
// 内部：匹配核心
// ============================================================================

function matchCore(
    records: any[],
    byId: Map<string, PointItem[]>,
    byPath: Map<string, PointItem[]>,
    opts: Required<LinkOptions>,
): LinkResult {
    const byPoint: Record<string, CaseItem[]> = {};
    const byCase: Record<string, { pointKey: string; type: 1 | 2 | 3 }> = {};
    // 同 (pointKey, testcase_id) 去重
    const seen = new Map<string, Set<string>>();
    const multiHitSet = new Set<string>();
    let matchedRecords = 0;
    let orphanRecords = 0;
    let strippedParentIds = 0;
    let type1 = 0, type2 = 0, type3 = 0;

    for (const rec of records) {
        if (!rec || typeof rec !== 'object') continue;

        const rawTid = rec[opts.caseIdField];
        const testcaseId = rawTid == null ? '' : String(rawTid).trim();

        const rawPath = rec[opts.pathField];
        const nPath = normalizePointPath(rawPath);

        // 收集本条 record 的所有 parent_id 归一化候选
        const rawPids = normalizeParentIds(rec[opts.parentIdField]);

        // 收集命中的 (point, type)，同 point 取最强 type
        const hits = new Map<PointItem, 1 | 2 | 3>();

        // 1) 通过 parent_id 命中
        //    优先用原值，命中不到再尝试剥离末尾 "-数字"（避免 LGN-001 被误剥成 LGN）
        for (const raw of rawPids) {
            let pid = raw;
            let points = byId.get(pid);
            if (!points && opts.stripParentIdTailIndex) {
                const stripped = stripSubIndex(raw);
                if (stripped && stripped !== raw) {
                    const cand = byId.get(stripped);
                    if (cand) {
                        points = cand;
                        pid = stripped;
                        strippedParentIds++;
                    }
                }
            }
            if (!points) continue;
            for (const p of points) {
                const nPP = normalizePointPath(p.pointPath);
                const t: 1 | 2 = nPath && nPP && nPath === nPP ? 1 : 2;
                const cur = hits.get(p);
                if (cur === undefined || t < cur) hits.set(p, t);
            }
            // 消除 unused warning
            void pid;
        }

        // 2) 通过 path 命中：仅当 parent_id 未命中任何 point 时作为最后兜底，type=3
        //    - 若 parent_id 已命中，则 path 仅参与"跨 pointId 歧义"检测（multiHit），不再进入归属候选
        //      （避免同 pointPath 下多个不同要点被引入，造成 type=3 抢夺）
        // 用于 multiHit 检测的独立集合：只统计"跨 pointId 的真·候选歧义"
        const pathHitPids = new Set<string>();
        if (nPath) {
            const points = byPath.get(nPath);
            if (points) {
                if (hits.size === 0) {
                    // parent_id 完全没命中 → path 兜底进入 hits
                    for (const p of points) hits.set(p, 3);
                } else {
                    // parent_id 已命中 → path 仅用于 multiHit 检测
                    for (const p of points) pathHitPids.add(p.pointId);
                }
            }
        }

        if (hits.size === 0) {
            orphanRecords++;
            continue;
        }

        // Q14 前提：同一 case 只归到一个 point。多命中 → 取最强 type 的第一个 + 告警
        let pickedPoint: PointItem | null = null;
        let pickedType: 1 | 2 | 3 = 3;
        for (const [p, t] of hits) {
            if (!pickedPoint || t < pickedType) {
                pickedPoint = p;
                pickedType = t;
            }
        }
        if (!pickedPoint) {
            orphanRecords++;
            continue;
        }
        // multiHit 判定：
        //   1) 若 hits（parent_id 归属候选）内部就有 >1 个不同 pointId → parent_id 数组指向多个不同点，脏
        //   2) 若 pathHitPids 非空，且与 hits 的 pointId 集合完全不相交（case 的 path 指向了跟 parent_id 完全不同的模块）→ 脏
        //   反之，pathHitPids 中包含 hits 的 pointId（仅是同 pointPath 下有其他兄弟点）→ 不算 multiHit
        if (testcaseId) {
            const hitPids = new Set<string>();
            for (const p of hits.keys()) hitPids.add(p.pointId);
            const case1 = hitPids.size > 1;
            let case2 = false;
            if (pathHitPids.size > 0) {
                let intersect = false;
                for (const pid of pathHitPids) {
                    if (hitPids.has(pid)) { intersect = true; break; }
                }
                case2 = !intersect;
            }
            if (case1 || case2) multiHitSet.add(testcaseId);
        }

        const pointKey = `${pickedPoint.pointId}_${pickedPoint.pointName}`;
        // 同 point 内 testcase_id 去重（Q8）
        if (testcaseId) {
            let set = seen.get(pointKey);
            if (!set) { set = new Set(); seen.set(pointKey, set); }
            if (set.has(testcaseId)) continue;
            set.add(testcaseId);
        }

        const caseItem: CaseItem = {
            testcase_id: testcaseId,
            caseName: String(rec[opts.caseNameField] ?? '').trim(),
            // casePath 落库同样走 normalizePointPath，保证与匹配（nPath）及 md 侧 pointPath
            // 同构：案例 path 用 \、／、·、首尾/、连续// 等写法都被归一化为「/ 分隔、无首尾斜杠」，
            // 既让 type=1/type=3 命中，也避免展示层出现「\ 对 /」的不一致。
            casePath: nPath,
            caseDetail: buildCaseDetail(rec, opts.preconditionFields, opts.expectedFields),
            type: pickedType,
        };

        (byPoint[pointKey] ??= []).push(caseItem);
        if (testcaseId) {
            byCase[testcaseId] = { pointKey, type: pickedType };
        }
        matchedRecords++;
        if (pickedType === 1) type1++;
        else if (pickedType === 2) type2++;
        else type3++;
    }

    return {
        byPoint,
        byCase,
        stats: {
            totalRecords: records.length,
            matchedRecords,
            orphanRecords,
            matchedByType: { type1, type2, type3 },
            duplicatePointIds: [],
            multiHitCases: Array.from(multiHitSet),
            strippedParentIds,
        },
    };
}

// ============================================================================
// 内部：埋点
// ============================================================================

function emitTelemetry(filePath: string, result: LinkResult, pointCount: number): void {
    try {
        TelemetryService.sendTelemetryEvent('pointCaseLinker.done', {
            fileExt: path.extname(filePath).toLowerCase(),
            pointCount: String(pointCount),
            totalRecords: String(result.stats.totalRecords),
            matchedRecords: String(result.stats.matchedRecords),
            orphanRecords: String(result.stats.orphanRecords),
            type1: String(result.stats.matchedByType.type1),
            type2: String(result.stats.matchedByType.type2),
            type3: String(result.stats.matchedByType.type3),
            strippedParentIds: String(result.stats.strippedParentIds),
        });
        if (result.stats.duplicatePointIds.length > 0) {
            TelemetryService.sendTelemetryErrorEvent('pointCaseLinker.duplicatePointId', {
                fileExt: path.extname(filePath).toLowerCase(),
                dupCount: String(result.stats.duplicatePointIds.length),
            });
        }
        if (result.stats.multiHitCases.length > 0) {
            TelemetryService.sendTelemetryErrorEvent('pointCaseLinker.multiHitCase', {
                fileExt: path.extname(filePath).toLowerCase(),
                caseCount: String(result.stats.multiHitCases.length),
            });
        }
    } catch { /* ignore */ }
}
