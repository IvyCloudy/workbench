/**
 * 案例路径合法性校验
 * ----------------------------------------------------------------------------
 * 与其它行级字段校验同构：空值由 validators.PATH_EMPTY_VALIDATOR 逐行拦截并高亮；
 * 本模块只负责「非空 path 调用接口判定」，再把结果按行还原成 PushFailureItem。
 * 行数据与行号映射由调用方提供（与 runValidators 同一份），不再自行解析文件。
 *
 * 按需查询：编辑期（incremental）复用上一次的路径结论，只查本次新增 / 改动过的
 * 非空 path；打开 / 格式校验 / 推送前默认全量查线上最新状态。因此路径单元格编辑会
 * 立即重新判定，改其它列不重复打接口，也不会因编辑期覆盖式写盘清掉已有路径红格。
 * 接口异常 / 未回显的路径无法判定，跳过且不缓存（下次仍会重试）。
 */
import { findBindingByPath } from './taskInfoStore';
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
    const binding = findBindingByPath(filePath);
    const taskInfo = binding?.taskInfo;
    if (!taskInfo?.testTaskNo) {
        _verdictCache.delete(filePath);
        return [];
    }
    // 换绑测试任务后旧结论整体失效
    const taskKey = `${taskInfo.testTaskNo}|${taskInfo.subTestTaskId || ''}`;

    // 与 runValidators 同口径：跳过样例行；空路径交给 PATH_EMPTY_VALIDATOR
    const refs: Array<{ index: number; path: string; tsId: string }> = [];
    (rows || []).forEach((row, i) => {
        if (!row || typeof row !== 'object' || isSampleCaseRow(row)) return;
        const path = readCaseFieldValue(row, CASE_PATH_COLUMN_ALIASES);
        if (!path) return;
        refs.push({ index: i, path, tsId: readCaseTsId(row) });
    });
    const paths = [...new Set(refs.map(r => r.path))];
    if (paths.length === 0) {
        _verdictCache.delete(filePath);
        return [];
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
                { testTaskNo: taskInfo.testTaskNo, subTestTaskId: taskInfo.subTestTaskId || '' },
                toQuery,
            );
            for (const it of items || []) {
                if (!toQuery.includes(it.tcoPath)) continue;
                verdicts.set(it.tcoPath, evaluateTcoPath(it));
            }
        } catch (e: any) {
            console.warn('[案例路径校验] 接口异常，跳过路径判定:', filePath, e?.message || e);
        }
        // 未回显 / 异常的路径不写结论，下次校验仍会重试
    }
    cacheVerdicts(filePath, taskKey, verdicts);

    const out: PushFailureItem[] = [];
    for (const ref of refs) {
        const message = verdicts.get(ref.path);
        if (!message) continue; // 合法 / 无法判定，不产出提示
        droppedIndex?.add(ref.index);
        const reason = `${CASE_PATH_REASON_PREFIX}：${message}`;
        out.push({
            tsId: ref.tsId,
            reason,
            rowIndex: resolveRowIndex(ref.index),
            category: classifyFailure({ reason, validatorKind: 'pathInvalid' }),
            field: CASE_PATH_FIELD,
            columnName: CASE_PATH_COLUMN_LABEL,
            severity: 'error',
        } as PushFailureItem);
    }
    return out;
}
