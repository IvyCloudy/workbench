/**
 * ============================================================================
 *  utils/telemetryProps.ts
 *  删除案例 / 通用埋点的「纯字符串 props 构造器」集合（不依赖 vscode）
 * ----------------------------------------------------------------------------
 *  背景：extensionHelpers 依赖 vscode（getActiveFileUri 等），而部分底层模块
 *        （如 pointCaseDeleter / http）需要保持「单测友好、无 vscode 依赖」，
 *        因此把仅做字符串拼接 / 截断的埋点 props 构造逻辑抽到本纯模块，
 *        由 extensionHelpers 再导出以保持既有 import 路径兼容。
 *
 *  职责：
 *    - telemetryErrProps                错误上报公共字段（errorMessage / stackHead）
 *    - telemetryTsIdListProps           tsId 列表压扁（join → 超长截断 → 计数 → 标记）
 *    - caseDeletionTelemetryProps       案例删除类埋点统一字段构造器（全场景一致命名）
 *    - syncDeletedResultTelemetryProps  同步删除结果事件统一字段构造器
 * ============================================================================
 */
import { stackHead } from '../services/utils';
import type { SyncDeletedResult } from './deletedRowsStore';

/**
 * 构造遥测错误上报所需的公共字段。
 */
export function telemetryErrProps(err: any, extras?: Record<string, string>): Record<string, string> {
    return {
        errorMessage: String(err?.message || String(err)).slice(0, 500),
        stackHead: stackHead(err),
        ...extras,
    };
}

/**
 * 腾讯遥测通道单 prop 长度上限（保守取 8KB），超限时就近截断并追加 `...(+N more)` 后缀，
 * 同时通过 `<key>Truncated` 布尔字段告知后端"该字段发生过截断"，避免静默丢数据。
 */
const TELEMETRY_TSID_LIST_MAX_LEN = 8000;

/**
 * 把"删除成功的 testcase_id 列表"压扁成遥测可上报的 string 字段。
 *
 * 目的：删除完成埋点需要携带具体成功的 testcase_id，便于事后审计与追溯，
 *      但腾讯遥测的 props 只接收 string；同时批量删除单批可达几百条，
 *      直接 join 可能超出单 prop 长度上限，故在此统一做「join → 截断 → 标记」。
 *
 * 用法：
 *   Object.assign(props, telemetryTsIdListProps({
 *       syncedTsIds:            result.synced,
 *       deletedSuccessIds:      result.deletedSuccess,
 *       deletedSourceMissingIds: result.deletedSourceMissing,
 *   }));
 *
 * 输出：
 *   - `<key>`         : 用 `|` 拼接的 tsId 列表，超限则以 `id1|id2|...(+N more)` 截断
 *   - `<key>Count`    : 该列表的真实条数（未截断前的原始长度）
 *   - `<key>Truncated`: 仅当发生截断时才出现，值恒为 `'true'`
 */
export function telemetryTsIdListProps(lists: Record<string, ReadonlyArray<string>>): Record<string, string> {
    const props: Record<string, string> = {};
    for (const [key, ids] of Object.entries(lists)) {
        const arr = Array.isArray(ids) ? ids : [];
        props[`${key}Count`] = String(arr.length);
        if (arr.length === 0) {
            props[key] = '';
            continue;
        }
        const joined = arr.join('|');
        if (joined.length <= TELEMETRY_TSID_LIST_MAX_LEN) {
            props[key] = joined;
            continue;
        }
        // 就近截断：从头累加 id，直到再加下一个就超上限；剩余数量用 `...(+N more)` 标注
        let taken = 0;
        let usedLen = 0;
        const suffixPlaceholder = '|...(+000 more)'; // 预估后缀长度，取 N 上限为 3 位数（≤999）足够
        const budget = TELEMETRY_TSID_LIST_MAX_LEN - suffixPlaceholder.length;
        for (let i = 0; i < arr.length; i++) {
            const seg = (i === 0 ? '' : '|') + arr[i];
            if (usedLen + seg.length > budget) break;
            usedLen += seg.length;
            taken++;
        }
        const head = arr.slice(0, Math.max(taken, 1)).join('|');
        const rest = arr.length - Math.max(taken, 1);
        props[key] = rest > 0 ? `${head}|...(+${rest} more)` : head;
        props[`${key}Truncated`] = 'true';
    }
    return props;
}

/**
 * 案例删除类埋点的**统一字段构造器**（全场景一致命名）。
 *
 * 目的：让「通过要点删除关联案例 / 编辑器内删除案例行 / 同步已删除行 / 批量删除案例」
 * 等所有案例删除场景的埋点，携带**完全一致**的字段命名，便于跨场景聚合与下钻分析。
 *
 * 输出字段：
 *   - deletedFilePath                 : 被删除案例所在文件的**绝对路径**（未传入则为空串）
 *   - deletedTestcaseIds              : 本次成功删除（线上同步）的 testcase_id，`|` 拼接
 *   - deletedTestcaseIdCount          : 上述列表真实条数
 *   - deletedTestcaseIdsTruncated     : 仅截断时出现，恒为 'true'
 *   - deletedSuccessTestcaseIds       : 其中 type=1（sourceId 真实存在并删除）子集
 *   - deletedSuccessTestcaseIdCount
 *   - deletedSourceMissingTestcaseIds : 其中 type=3（sourceId 不存在仍算成功）子集
 *   - deletedSourceMissingTestcaseIdCount
 *
 * tsId 列表的 join / 截断 / 计数逻辑复用 telemetryTsIdListProps。
 */
export function caseDeletionTelemetryProps(opts: {
    filePath?: string;
    synced?: ReadonlyArray<string>;
    deletedSuccess?: ReadonlyArray<string>;
    deletedSourceMissing?: ReadonlyArray<string>;
}): Record<string, string> {
    const props: Record<string, string> = {};
    if (opts.filePath !== undefined) props.deletedFilePath = opts.filePath;
    Object.assign(props, telemetryTsIdListProps({
        deletedTestcaseIds: opts.synced ?? [],
        deletedSuccessTestcaseIds: opts.deletedSuccess ?? [],
        deletedSourceMissingTestcaseIds: opts.deletedSourceMissing ?? [],
    }));
    return props;
}

/**
 * 同步删除结果事件（editor.deleteRows.synced / syncDeletedRows.complete 等）的
 * **统一埋点字段构造器**。
 *
 * 以往这两个调用点各自内联拼装「4 个计数字段 + caseDeletionTelemetryProps」，
 * 此处收敛为单一入口，保证字段命名在全场景完全一致，且后续新增同步删除类事件
 * 直接复用即可，避免再次出现字段命名漂移。
 */
export function syncDeletedResultTelemetryProps(
    result: SyncDeletedResult,
    filePath?: string,
): Record<string, string> {
    // 说明：synced / success / missing 的 tsId 列表与计数统一由 caseDeletionTelemetryProps
    // 以 `deletedTestcaseIds[Count]` / `deletedSuccessTestcaseIds[Count]` /
    // `deletedSourceMissingTestcaseIds[Count]` 命名输出（与 caseFileDelete.intercept.done 等
    // 全场景一致），故此处不再额外输出裸 `deletedSuccess` / `deletedSourceMissing` 计数，
    // 避免同一事件里两套命名口径并存、下钻分析时混淆（P3）。
    // deletedTestcaseIdCount 已覆盖 synced 总数，`failedRows` 是 caseDeletionTelemetryProps
    // 未覆盖的失败行计数，二者即为本事件所需的全部聚合字段。
    return {
        failedRows: String(result.failed.length),
        ...caseDeletionTelemetryProps({
            filePath,
            synced: result.synced,
            deletedSuccess: result.deletedSuccess,
            deletedSourceMissing: result.deletedSourceMissing,
        }),
    };
}
