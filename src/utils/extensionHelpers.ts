import * as vscode from 'vscode';
import { FileTypeChecker } from '../providers/UnifiedEditorProvider';
import { stackHead } from '../services/utils';

/** 构造遥测错误上报所需的公共字段 */
export function telemetryErrProps(err: any, extras?: Record<string, string>): Record<string, string> {
    return {
        errorMessage: String(err?.message || String(err)).slice(0, 500),
        stackHead: stackHead(err),
        ...extras,
    };
}

/**
 * 遥测 props 中单个 string 字段的最大长度约束。
 * 腾讯遥测通道通常允许单 prop <= 8KB，这里保守取 8000 字符，
 * 超限时按 `|` 分隔就近截断并追加 `...(+N more)` 后缀，同时通过
 * `<key>Truncated` 布尔字段告知后端"该字段发生过截断"，避免静默丢数据。
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

export function getActiveFileUri(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab) return undefined;

    const input = tab.input;
    if (input instanceof vscode.TabInputText) return input.uri;
    if (input instanceof vscode.TabInputCustom) return input.uri;
    if (input instanceof vscode.TabInputTextDiff) return input.original;
    return undefined;
}

export function isTestCaseFile(uri: vscode.Uri): boolean {
    return FileTypeChecker.isQualifiedFile(uri).qualified;
}

export function updateShowIcon(): void {
    const uri = getActiveFileUri();
    vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!uri && isTestCaseFile(uri));
}
