/**
 * ============================================================================
 *  services/diffHighlight.ts
 *  编辑器"快照差异 → 高亮/新增标记"公共逻辑
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 定义单个 webview panel 独享的会话状态类型 EditorSession；
 *    2. 提供 applyDiffHighlight：基于 diffPushSnapshot 的比对结果，
 *       统一更新 session.highlightedCells / addedInfos 并同步 highlightStore。
 *  说明：
 *    - 新增优先：新增行只走 addedInfos 绿底，不再展开进 highlightedCells 黄底；
 *    - 已删除行自动追踪 / 幽灵行展示已移除；线上删除仅保留右键删行等显式入口。
 *  抽出动机：
 *    - 与 provider 生命周期无关的纯逻辑，便于日后单元测试；
 *    - init / externalChange / pushSuccess / reload / webview save 五个入口共用同一套逻辑，
 *      避免"新增绿底 / 修改黄底一处显示、另一处不显示"这类割裂问题。
 * ============================================================================
 */
import { setHighlight, clearHighlight } from '../utils/highlightStore';
import { diffPushSnapshot, type AddedRowInfo } from '../utils/pushSnapshotStore';
import { getFailures } from '../utils/pushFailureStore';
import { TS_ID_COLUMN } from './utils';
import type { FileParser, FileType } from '../parsers';

// ============================================
// 会话状态
// ============================================

/** 单个 webview panel 独享的会话状态 */
export interface EditorSession {
    type: FileType;
    parser: FileParser;
    originalSourceData: any;
    /** 已解析的表格数据缓存：用于切换 tab 重新可见时快速 repush，避免重读文件 */
    cachedTableData: any;
    /** 推送成功后回写了 testCaseNo 的单元格信息（下次 pushDataToWebview 消费后清空）；null 表示明确通知前端清空 */
    highlightedCells?: { colIdx: number; rowIndices: number[]; cells?: Array<[number, number]> } | null;
    /** 快照差异检测到的新增行信息（下次 pushDataToWebview 消费后清空） */
    addedInfos?: AddedRowInfo[];
    /** 是否为案例文件（含关键字段 testcase_id）：用于 webview 端按"非案例文件"限制功能（隐藏推送/校验/删除等） */
    isCaseFile?: boolean;
}

// ============================================
// 差异比对 → 同步 session/store 高亮
// ============================================
/**
 * 基于 diffPushSnapshot 的比对结果，统一更新 session.highlightedCells /
 * session.addedInfos，并同步 highlightStore。
 *
 * 供 pushDataToWebview（init/externalChange/pushSuccess/reload）与 webview save
 * 消息处理复用，避免两处逻辑走偏（历史上曾发生「新增行黄底一处显示、另一处不显示」
 * 的割裂问题）。
 *
 * @param filePath              文件绝对路径
 * @param session               当前编辑器会话
 * @param tableData             用于比对的当前表格数据
 * @param log                   会话专属 log 函数（带前缀）
 * @param options.logPrefix     日志前缀，用于区分调用场景（如 "Webview 保存"）；空串表示无前缀
 * @param options.emptyDiffHighlight 无差异时 session.highlightedCells 的取值：
 *                              - 'null'     ：强制清空（save / pushSuccess / reload），
 *                                             pushDataToWebview 会显式下发 null 让前端清除残留高亮；
 *                              - 'undefined'：保留前端已有状态（如 visible 场景），
 *                                             pushDataToWebview 不会带 highlightedCells 字段。
 * @returns diff 统计（供埋点使用）；diffResult 为 null（无快照）时返回 null。
 */
export async function applyDiffHighlight(
    filePath: string,
    session: EditorSession,
    tableData: any,
    log: (...args: any[]) => void,
    options: { logPrefix: string; emptyDiffHighlight: 'null' | 'undefined' },
): Promise<{ addedRows: number; deletedRows: number; modifiedRows: number; modifiedCells: number } | null> {
    const diffResult = diffPushSnapshot(filePath, tableData);
    if (!diffResult) return null;

    const { changed: changedRowsRaw, addedInfos: addedInfosRaw } = diffResult;
    const prefix = options.logPrefix ? options.logPrefix + ' ' : '';

    // ============================================================
    // 【关键过滤】剔除"推送失败"的行 —— 2026-07-26 修复
    // ------------------------------------------------------------
    // 背景：applyDiffHighlight 原本无脑把 diff 出的所有 changedRows / addedInfos
    //   都写进 session.highlightedCells（推送后更新态 = 金黄色）。
    //   但推送失败的行文件里数据尚未回写 testCaseNo，与快照必然存在差异，
    //   于是它们也被误算成"需要黄底"。
    //
    // 表现：推送失败 → 弹窗关闭 → reload 触发本函数再次运行 →
    //   highlightedCells 里含失败行 → 前端 resolveHighlight 分支 1 打
    //   xs-td-push-updated 且 highlightedTime > rowFailTime → 分支 4 命中
    //   failOverridden → CSS 兜底为淡黄底 "#fffbe6"，覆盖失败淡红底。
    //   用户直观感受是"失败行显示成修改高亮"。
    //
    // 修复：读取 push-failures.json，把命中失败 tsId 的行从 changedRows /
    //   addedInfos 中剔除，这样 highlightedCells 只承载"真正成功推送后又被改动"
    //   的行，失败行独立走 _pushFailedTsIds 的红底路径。
    // ============================================================
    const failuresMap = getFailures(filePath);
    const failedTsIds = new Set<string>(Object.keys(failuresMap || {}));
    const headers: string[] = (tableData && tableData.headers) || [];
    const rows: any[][] = (tableData && tableData.rows) || [];
    const tsIdCol = headers.indexOf(TS_ID_COLUMN);

    let excludedChanged = 0;
    const changedRows = (failedTsIds.size === 0 || tsIdCol < 0)
        ? changedRowsRaw
        : changedRowsRaw.filter(d => {
            const row = rows[d.rowIndex];
            // .trim() 防御：极端情况下文件里 tsId 单元格可能夹带前后空白，
            // 而 pushFailureStore 存的是清洗后的值；不 trim 会导致 has() 永远不命中，
            // 失败行被误判为"更新态"而覆盖成淡黄底 —— 这正是本函数要修的 bug 场景。
            const tsId = Array.isArray(row) && tsIdCol < row.length ? String(row[tsIdCol] || '').trim() : '';
            const excluded = tsId !== '' && failedTsIds.has(tsId);
            if (excluded) excludedChanged++;
            return !excluded;
        });
    // 新增行即使推送失败也保持新增语义：绿色新增与字段级失败红底可以共存，
    // 失败是否消除由 05a / pushFailures 流程负责，不在 diff 阶段剔除 addedInfos。
    const addedInfos = addedInfosRaw;
    if (excludedChanged > 0) {
        log(`🚫 ${prefix}剔除推送失败行不参与修改高亮：`
            + `changedRows -${excludedChanged}, 失败 tsId 数=${failedTsIds.size}`);
    }

    // 新增优先：新增行只走 addedInfos（前端绿底），不进入 highlightedCells 修改高亮；
    // highlightedCells 仅承载真正相对推送基线发生变化的单元格。
    let modifiedCells = 0;

    if (changedRows.length > 0) {
        const rowIndices = Array.from(new Set(changedRows.map(d => d.rowIndex)));
        const flatCells: Array<[number, number]> = [];
        for (const d of changedRows) {
            for (const ci of d.changedCols) flatCells.push([d.rowIndex, ci]);
        }
        modifiedCells = flatCells.length;
        session.highlightedCells = { colIdx: -1, rowIndices, cells: flatCells };
        await setHighlight(filePath, session.highlightedCells);
        log(`🟢 ${prefix}快照差异比对检测到 ${changedRows.length} 行修改，共 ${flatCells.length} 格`);
    } else {
        // 'null'      : 显式发送 null 让前端清空高亮（save / pushSuccess / reload）
        // 'undefined' : 不覆盖前端已有状态（如 visible 场景保留旧高亮）
        session.highlightedCells = options.emptyDiffHighlight === 'null' ? null : undefined;
        await clearHighlight(filePath);
    }

    session.addedInfos = addedInfos;
    if (addedInfos.length > 0) {
        log(`➕ ${prefix}快照差异比对检测到 ${addedInfos.length} 行新增`);
    }

    return {
        addedRows: addedInfos.length,
        // 已删除行自动追踪已移除，埋点字段保留但恒为 0
        deletedRows: 0,
        modifiedRows: changedRows.length,
        modifiedCells,
    };
}
