/**
 * 案例路径合法性校验
 * ----------------------------------------------------------------------------
 * 与其它行级字段校验同构：空值由 validators.PATH_EMPTY_VALIDATOR 逐行拦截并高亮；
 * 本模块只负责「非空 path 调用接口判定」，再把结果按行还原成 PushFailureItem。
 * 行数据与行号映射由调用方提供（与 runValidators 同一份），不再自行解析文件。
 *
 * 按需查询：编辑期（incremental）复用上一次的路径结论，只查本次新增 / 改动过的
 * 非空 path（先经 pushDataMapper.normalizePath 标准化，与推送取值口径一致）；
 * 打开 / 格式校验 / 推送前默认全量查线上最新状态。因此路径单元格编辑会
 * 立即重新判定，改其它列不重复打接口，也不会因编辑期覆盖式写盘清掉已有路径红格。
 * 接口异常 / 未回显的路径无法判定，跳过且不缓存（下次仍会重试）。
 */
import { getCurrentTaskInfo } from './commands';
import { normalizePath } from './pushDataMapper';
import { queryTcoPath } from '../services/http';
import type { TcoPathQueryItem } from '../services/http';
import type { PushFailureItem, RowLike } from '../handlers/pushCore.types';
import { classifyFailure } from './pushFailure';
import {
    CASE_PATH_FIELD,
    CASE_PATH_COLUMN_LABEL,
    CASE_PATH_REASON_PREFIX,
    CASE_PATH_COLUMN_ALIASES,
    readCaseTsId,
    readCaseFieldValue,
    isSampleCaseRow,
} from './caseRowFields';

/** 标准化失败（如 `/`、`\`）的本地判定文案，与接口判定三类文案同构 */
const CASE_PATH_INVALID_FORMAT = '路径格式无效，请核对路径';

/**
 * 依据接口返回项判定路径是否合法；返回 null 表示合法。
 * 合法结构：功能条目/{测试点路径}/末级测试要点 —— 案例必须挂在末级测试要点上。
 * 文案只描述路径本身的问题，不写推送动作（同一 reason 也用于打开文件通路的 05g 卡片）。
 */
export function evaluateTcoPath(item: TcoPathQueryItem): string | null {
    if (item.tcoType === 1) return '路径为功能条目，无测试要点，请核对路径';
    if (item.tcoType === 2) {
        if (item.pointTotal > 1) return '路径为非末级测试要点，请核对路径';
        if (item.pointTotal === 0 && item.type === 3) return '路径上的测试要点不存在，请核对路径';
        return null;
    }
    console.warn('[案例路径校验] 接口返回未知 tcoType，按合法放行:', item.tcoPath, item.tcoType);
    return null;
}

/** 路径判定结论缓存：文件路径 → { 任务指纹, 路径 → 非法原因（null 为合法） } */
interface PathVerdictCache {
    taskKey: string;
    verdicts: Map<string, string | null>;
}
const _verdictCache = new Map<string, PathVerdictCache>();
const VERDICT_CACHE_MAX = 200;

/** 写回结论缓存；只保留本次出现的路径，避免长期编辑下无限增长 */
function cacheVerdicts(filePath: string, taskKey: string, verdicts: Map<string, string | null>): void {
    if (_verdictCache.size >= VERDICT_CACHE_MAX) {
        let drop = Math.floor(VERDICT_CACHE_MAX / 2);
        for (const k of _verdictCache.keys()) {
            if (drop-- <= 0) break;
            _verdictCache.delete(k);
        }
    }
    _verdictCache.set(filePath, { taskKey, verdicts });
}

/**
 * 收集路径合法性失败项。
 * @param rows 调用方已解析的行（与 runValidators 同一份）
 * @param resolveRowIndex 与 runValidators 相同的行号映射
 * @param droppedIndex 可选：命中非法路径的行下标并入该集合，供推送期剔除 payload
 * @param opts.incremental 编辑期按需查询：复用已判定路径，只查新增 / 改动过的 path；
 *                         不传（打开 / 格式校验 / 推送前）一律全量查线上最新状态
 */
export async function collectPathFailuresForFile(
    filePath: string,
    rows: RowLike[],
    resolveRowIndex: (i: number) => number = i => i + 1,
    droppedIndex?: Set<number>,
    opts?: { incremental?: boolean },
): Promise<PushFailureItem[]> {
    // 未绑定任务 → 无法查询，跳过（与「字段完全缺省则跳过」同口径）
    const currentTask = await getCurrentTaskInfo(filePath);
    if (!currentTask.bind) {
        _verdictCache.delete(filePath);
        return [];
    }
    const testTaskNo = currentTask.taskInfo?.testTaskNo || '';
    const subTestTaskId = currentTask.taskInfo?.subTestTaskId || '';
    if (!testTaskNo) {
        _verdictCache.delete(filePath);
        return [];
    }
    // 换绑测试任务后旧结论整体失效
    const taskKey = `${testTaskNo}|${subTestTaskId}`;

    // 与 runValidators 同口径：跳过样例行；空路径交给 PATH_EMPTY_VALIDATOR。
    // 非空 path 先经推送映射层 normalizePath 标准化（去开头 /、补结尾 /、\ → /），
    // 与真正推送时 testCasePath 的取值口径一致，避免同一路径不同写法漏判或重复查询。
    // 标准化失败（如仅含分隔符）本地即可判定无效，直接产出失败项并剔除该行，
    // 不等到推送映射阶段才报错。
    const refs: Array<{ index: number; path: string; tsId: string }> = [];
    const invalidRefs: Array<{ index: number; tsId: string }> = [];
    (rows || []).forEach((row, i) => {
        if (!row || typeof row !== 'object' || isSampleCaseRow(row)) return;
        const rawPath = readCaseFieldValue(row, CASE_PATH_COLUMN_ALIASES);
        if (!rawPath) return;
        let path: string;
        try {
            path = normalizePath(rawPath);
        } catch (_) {
            invalidRefs.push({ index: i, tsId: readCaseTsId(row) });
            return;
        }
        if (!path) return;
        refs.push({ index: i, path, tsId: readCaseTsId(row) });
    });
    const paths = [...new Set(refs.map(r => r.path))];
    if (paths.length === 0) {
        // 没有可查接口的非空路径，缓存已无意义；但仍要返回本地标准化失败的失败项
        _verdictCache.delete(filePath);
        return invalidRefs.map(ref => buildPathFailure(ref, CASE_PATH_INVALID_FORMAT, resolveRowIndex, droppedIndex));
    }

    // 按需：编辑期只查「还没有结论」的路径（即单元格改出来的新值），其余复用结论；
    // 全量通路忽略缓存，每次都查线上最新状态。
    const cached = opts?.incremental ? _verdictCache.get(filePath) : undefined;
    const prev = cached?.taskKey === taskKey ? cached.verdicts : undefined;
    const toQuery = prev ? paths.filter(p => !prev.has(p)) : paths;
    const verdicts = new Map<string, string | null>();
    if (prev) {
        for (const p of paths) {
            if (prev.has(p)) verdicts.set(p, prev.get(p)!);
        }
    }

    if (toQuery.length > 0) {
        try {
            const items: TcoPathQueryItem[] = await queryTcoPath(
                { testTaskNo, subTestTaskId },
                toQuery,
            );
            for (const it of items || []) {
                // 回显路径同样标准化后再匹配：后端可能带前导 / 或缺结尾 /
                let echoed: string;
                try {
                    echoed = normalizePath(it.tcoPath);
                } catch (_) {
                    continue;
                }
                if (!toQuery.includes(echoed)) continue;
                verdicts.set(echoed, evaluateTcoPath(it));
            }
        } catch (e: any) {
            console.warn('[案例路径校验] 接口异常，跳过路径判定:', filePath, e?.message || e);
        }
        // 未回显 / 异常的路径不写结论，下次校验仍会重试
    }
    cacheVerdicts(filePath, taskKey, verdicts);

    // 本地标准化失败的失败项 + 接口判定非法的失败项，统一走同一构造口径，按行号排序
    const failures: Array<{ ref: { index: number; tsId: string }; message: string }> =
        invalidRefs.map(ref => ({ ref, message: CASE_PATH_INVALID_FORMAT }));
    for (const ref of refs) {
        const message = verdicts.get(ref.path);
        if (!message) continue; // 合法 / 无法判定，不产出提示
        failures.push({ ref, message });
    }
    failures.sort((a, b) => a.ref.index - b.ref.index);
    return failures.map(({ ref, message }) =>
        buildPathFailure(ref, message, resolveRowIndex, droppedIndex));
}

/** 构造一条路径非法失败项，并把命中行并入 droppedIndex（推送期剔除 payload） */
function buildPathFailure(
    ref: { index: number; tsId: string },
    message: string,
    resolveRowIndex: (i: number) => number,
    droppedIndex?: Set<number>,
): PushFailureItem {
    droppedIndex?.add(ref.index);
    const reason = `${CASE_PATH_REASON_PREFIX}：${message}`;
    return {
        tsId: ref.tsId,
        reason,
        rowIndex: resolveRowIndex(ref.index),
        category: classifyFailure({ reason, validatorKind: 'pathInvalid' }),
        field: CASE_PATH_FIELD,
        columnName: CASE_PATH_COLUMN_LABEL,
        severity: 'error',
    } as PushFailureItem;
}
